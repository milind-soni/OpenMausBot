import { describe, expect, it, vi } from "vitest";

import { classifyError } from "../retry.ts";
import { runtimeErrorText } from "../runtime-notice-error.ts";
import { startupFailureRecoverable } from "./startup-recovery.ts";
import { acpRpcError } from "./rpc-error.ts";
import { BUSY_RETRY_PAUSE_MS, busyStartFailure, sessionNewRetried, SLOW_FIRST_ANSWER_MS, startFailureClass, type BusyStartDeps } from "./busy-start.ts";
import { takeStartFailure } from "../../engine-start-failures.ts";
import { acpRuntimeFailure } from "./failure-words.ts";
import { classifyOpenCodeError } from "./opencode-go.ts";

/** OpenCode's own refusal on the starved Cloud, as acpRpcError words it. */
const refusal = () => acpRpcError({ code: -32603, message: "Internal error", data: { details: "Internal service failure", errorName: "ServiceUnavailableError" } }, "session/new");
/** A provider outage: transient, and a backup AI may carry the turn. */
const outage = () => acpRpcError({ code: -32603, message: "503 upstream overloaded" }, "session/new");
const MEMORY = "memory stall 10%";
const recoverable = (error: Error) => startupFailureRecoverable(error, error.message, classifyOpenCodeError(error), { approvalUnconfirmed: false, promptSent: false, promptUnreachedModel: false });

function deps(over: Partial<BusyStartDeps> = {}) {
  let at = 0;
  const paused: number[] = [];
  const made: BusyStartDeps = { pressure: () => null, cloud: () => true, pause: async (ms) => { paused.push(ms); }, now: () => at, ...over };
  return { deps: made, paused, later: (ms: number) => { at += ms; } };
}
const failOf = (send: () => Promise<unknown>, d: BusyStartDeps) => sessionNewRetried(send, () => true, d).catch((error: Error) => error) as Promise<Error>;

describe("session/new on a busy Cloud", () => {
  it("the refusal reads as the customer saw it, and is transient", () => {
    expect(refusal().message).toBe("Internal error: Internal service failure (session/new, ServiceUnavailableError)");
    expect(classifyError({ text: refusal().message }).transient).toBe(true);
  });

  it("is asked once more while its process lives, and a second answer is the session", async () => {
    const { deps: d, paused } = deps();
    const send = vi.fn().mockRejectedValueOnce(refusal()).mockResolvedValueOnce({ sessionId: "s1" });
    await expect(sessionNewRetried(send, () => true, d)).resolves.toEqual({ sessionId: "s1" });
    expect(send).toHaveBeenCalledTimes(2);
    expect(paused).toEqual([]);
  });

  it("waits a bounded pause first while the machine is pressed", async () => {
    const { deps: d, paused } = deps({ pressure: () => MEMORY });
    const send = vi.fn().mockRejectedValueOnce(refusal()).mockResolvedValueOnce({ sessionId: "s1" });
    await sessionNewRetried(send, () => true, d);
    expect(paused).toEqual([BUSY_RETRY_PAUSE_MS]);
  });

  it("the engine's own refusal on a pressed Cloud: the plain line in the task, handled exactly as before otherwise", async () => {
    const failed = await failOf(() => Promise.reject(refusal()), deps({ pressure: () => MEMORY }).deps);
    expect(runtimeErrorText(failed)).toMatchObject({ key: "chat.notice.cloudBusyStart" });
    expect(acpRuntimeFailure(failed, "OpenCode")).toMatchObject({ text: { key: "chat.notice.cloudBusyStart" } });
    // The same message, code and data: retried, classified and handed to a backup AI exactly as the raw refusal is.
    expect(failed.message).toBe(refusal().message);
    expect(failed).toMatchObject({ code: -32603, acpSessionFailure: true, data: { errorName: "ServiceUnavailableError" } });
    expect(recoverable(failed)).toBe(recoverable(refusal()));
    expect(recoverable(failed)).toBe(true);
  });

  it("a Cloud pressed for CPU says it ran out of CPU", async () => {
    for (const why of ["cpu stall 80%", "cpu throttled 60%", "cpu steal 40%", "event loop delayed 11s"]) {
      const failed = await failOf(() => Promise.reject(refusal()), deps({ pressure: () => why }).deps);
      expect(runtimeErrorText(failed)).toMatchObject({ key: "chat.notice.cloudOutOfCpu" });
    }
  });

  it("a Cloud pressed when the start began counts, though calm when it failed", async () => {
    const readings = [MEMORY, null, null, null];
    const failed = await failOf(() => Promise.reject(refusal()), deps({ pressure: () => readings.shift() ?? null }).deps);
    expect(runtimeErrorText(failed)).toMatchObject({ key: "chat.notice.cloudBusyStart" });
  });

  it("a provider outage keeps its own words and stays recoverable, unless its first answer was slow on a pressed Cloud", async () => {
    const quick = await failOf(() => Promise.reject(outage()), deps({ pressure: () => MEMORY }).deps);
    expect(runtimeErrorText(quick)).toBeUndefined();
    expect(recoverable(quick)).toBe(true);
    const { deps: d, later } = deps({ pressure: () => MEMORY });
    const slow = await failOf(() => { later(SLOW_FIRST_ANSWER_MS); return Promise.reject(outage()); }, d);
    expect(runtimeErrorText(slow)).toMatchObject({ key: "chat.notice.cloudBusyStart" });
    expect(recoverable(slow)).toBe(true);
  });

  it("keeps the engine's words on a calm Cloud, off a Cloud, and for a refusal that is not transient", async () => {
    expect(runtimeErrorText(await failOf(() => Promise.reject(refusal()), deps().deps))).toBeUndefined();
    expect(runtimeErrorText(await failOf(() => Promise.reject(refusal()), deps({ pressure: () => MEMORY, cloud: () => false }).deps))).toBeUndefined();
    const key = new Error("Internal error: Invalid API key. (session/new, APIError)");
    expect(busyStartFailure(key, MEMORY, true, deps().deps)).toBe(key);
  });

  it("is not asked again when its process ended, for a timeout, or for a sign-in", async () => {
    for (const [error, alive] of [
      [refusal(), false],
      [new Error("ACP request timed out: session/new"), true],
      [Object.assign(refusal(), { acpSignInRequired: true }), true],
    ] as const) {
      const send = vi.fn(() => Promise.reject(error));
      await sessionNewRetried(send, () => alive, deps().deps).catch(() => {});
      expect(send).toHaveBeenCalledTimes(1);
    }
  });
});

describe("why a start failed, for the health report", () => {
  it("notes the thread's start failure as too busy or the engine's own refusal; a sign-in or a request problem is not noted", async () => {
    const pressed = deps({ pressure: () => "cpu pressure 80%" });
    await sessionNewRetried(() => Promise.reject(refusal()), () => true, pressed.deps, "busy-thread").catch(() => {});
    expect(takeStartFailure("busy-thread", 0)).toBe("overloaded");
    // Taken once: a later failed row on the thread is filed by its words.
    expect(takeStartFailure("busy-thread", 0)).toBeNull();
    await sessionNewRetried(() => Promise.reject(outage()), () => true, deps().deps, "outage-thread").catch(() => {});
    expect(takeStartFailure("outage-thread", 0)).toBe("provider");
    const signIn = Object.assign(new Error("Authentication required"), { acpSignInRequired: true });
    expect(startFailureClass(signIn)).toBeNull();
    expect(startFailureClass(new Error("400 invalid request"))).toBeNull();
    // A later start on the thread refused for sign-in takes the earlier note back: its row keeps its auth code.
    await sessionNewRetried(() => Promise.reject(outage()), () => true, deps().deps, "backup-thread").catch(() => {});
    await sessionNewRetried(() => Promise.reject(signIn), () => true, deps().deps, "backup-thread").catch(() => {});
    expect(takeStartFailure("backup-thread", 0)).toBeNull();
    // Without a thread nothing is noted (and nothing else changes).
    await sessionNewRetried(() => Promise.reject(outage()), () => true, deps().deps).catch(() => {});
    expect(takeStartFailure("outage-thread", 0)).toBeNull();
  });
});
