import { describe, expect, it, vi } from "vitest";

import { CHAT_NOTICE } from "../../chat-notices.ts";
import { classifyError } from "../retry.ts";
import { runtimeErrorText } from "../runtime-notice-error.ts";
import { startupFailureRecoverable } from "./startup-recovery.ts";
import { acpRpcError } from "./rpc-error.ts";
import { BUSY_RETRY_PAUSE_MS, busyStartFailure, sessionNewRetried, type BusyStartDeps } from "./busy-start.ts";
import { acpRuntimeFailure } from "./failure-words.ts";
import { classifyOpenCodeError } from "./opencode-go.ts";

/** OpenCode's own refusal on the starved Cloud, as acpRpcError words it. */
const refusal = () => acpRpcError({ code: -32603, message: "Internal error", data: { details: "Internal service failure", errorName: "ServiceUnavailableError" } }, "session/new");

function deps(over: Partial<BusyStartDeps> = {}) {
  const paused: number[] = [];
  const made: BusyStartDeps = { pressure: () => null, cloud: () => true, pause: async (ms) => { paused.push(ms); }, ...over };
  return { deps: made, paused };
}

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
    const { deps: d, paused } = deps({ pressure: () => "memory stall 10%" });
    const send = vi.fn().mockRejectedValueOnce(refusal()).mockResolvedValueOnce({ sessionId: "s1" });
    await sessionNewRetried(send, () => true, d);
    expect(paused).toEqual([BUSY_RETRY_PAUSE_MS]);
  });

  it("still refused on a pressed Cloud: one plain line, keeping what the turn's own handling reads", async () => {
    const { deps: d } = deps({ pressure: () => "memory stall 10%" });
    const failed = await sessionNewRetried(() => Promise.reject(refusal()), () => true, d).catch((error) => error);
    expect(failed.message).toBe(CHAT_NOTICE["chat.notice.cloudBusyStart"]);
    expect(runtimeErrorText(failed)).toMatchObject({ key: "chat.notice.cloudBusyStart" });
    expect(failed).toMatchObject({ code: -32603, acpSessionFailure: true });
    // Not a provider outage: no backup AI is started on a machine with no room for one, read as core.ts reads it.
    expect(classifyError({ text: failed.message }).transient).toBe(false);
    const code = classifyOpenCodeError(failed);
    expect(code).toBeUndefined();
    expect(startupFailureRecoverable(failed, failed.message, code, { approvalUnconfirmed: false, promptSent: false, promptUnreachedModel: false })).toBe(false);
    // What the failed task's error row shows.
    expect(acpRuntimeFailure(failed, "OpenCode")).toMatchObject({ message: CHAT_NOTICE["chat.notice.cloudBusyStart"], text: { key: "chat.notice.cloudBusyStart" } });
  });

  it("a Cloud pressed for CPU says it ran out of CPU", async () => {
    for (const why of ["cpu stall 80%", "cpu throttled 60%", "cpu steal 40%", "event loop delayed 11s"]) {
      const failed = await sessionNewRetried(() => Promise.reject(refusal()), () => true, deps({ pressure: () => why }).deps).catch((error) => error);
      expect(failed.message).toBe(CHAT_NOTICE["chat.notice.cloudOutOfCpu"]);
      expect(runtimeErrorText(failed)).toMatchObject({ key: "chat.notice.cloudOutOfCpu" });
    }
  });

  it("a Cloud pressed when the start began counts, though calm when it failed", async () => {
    const readings = ["memory stall 12%", null, null, null];
    const failed = await sessionNewRetried(() => Promise.reject(refusal()), () => true, deps({ pressure: () => readings.shift() ?? null }).deps).catch((error) => error);
    expect(failed.message).toBe(CHAT_NOTICE["chat.notice.cloudBusyStart"]);
  });

  it("keeps the engine's words off a Cloud, on a quick refusal, and for a refusal that is not transient", async () => {
    const quick = await sessionNewRetried(() => Promise.reject(refusal()), () => true, deps().deps).catch((error) => error);
    expect(quick.message).toMatch(/ServiceUnavailableError/);
    const desktop = await sessionNewRetried(() => Promise.reject(refusal()), () => true, deps({ pressure: () => "memory stall 10%", cloud: () => false }).deps).catch((error) => error);
    expect(desktop.message).toMatch(/ServiceUnavailableError/);
    const key = new Error("Internal error: Invalid API key. (session/new, APIError)");
    expect(busyStartFailure(key, "memory stall 10%", deps().deps)).toBe(key);
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
