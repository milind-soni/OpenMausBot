// The sign-in trace and the sign-in sessions around it: an abandoned flow stops keeping the home awake at its cap, a flow
// the server's stop cut short is recorded as interrupted and the sign-in screen hears so, what is kept stays small and holds
// no secret, and a desktop (no trace) writes nothing and behaves as before.
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderAuthenticationStart, ProviderAuthenticationStatus } from "./contracts.ts";
import { ProviderAuthSessions } from "./provider-auth-sessions.ts";
import { createSignInTrace, signInMethodOf, SIGN_IN_TRACE_FILE } from "./sign-in-trace.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const FLOW = "flow-7f3a9c1e-secret", CODE = "PASTED-CODE-1234567", LINK = "https://claude.com/cai/oauth/authorize?code=true&state=secret-state";
const START = 1_800_000_000_000, MINUTE = 60_000;

/** An engine's sign-in surface whose answers the test sets: it never ends a flow by itself. */
function engine(instanceId = "claude-ada-work", driverKind = "claudeAgent", start: Partial<ProviderAuthenticationStart> = {}) {
  let status: ProviderAuthenticationStatus = { phase: "waiting", flowId: FLOW, authorizationUrl: LINK, expiresAt: null };
  return {
    instanceId, driverKind,
    startAuthentication: vi.fn(async (): Promise<ProviderAuthenticationStart> => ({ phase: "waiting", flowId: FLOW, authorizationUrl: LINK, expiresAt: null, ...start })),
    getAuthentication: vi.fn(async () => status),
    completeAuthentication: vi.fn(async () => {}),
    cancelAuthentication: vi.fn(async () => {}),
    set: (next: Partial<ProviderAuthenticationStatus>) => { status = { ...status, ...next }; },
  };
}

describe("the sign-in trace", () => {
  let dir: string, clock: number, lines: string[];
  const trace = (wokeFromSleep = false) => createSignInTrace({ dataDir: dir, now: () => clock, log: (line) => lines.push(line), wokeFromSleep: () => wokeFromSleep });
  const file = () => readFileSync(join(dir, SIGN_IN_TRACE_FILE), "utf8");

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omb-sign-in-trace-"));
    clock = START;
    lines = [];
  });
  afterEach(async () => { await removeTempDir(dir); });

  it("lets an abandoned flow stop keeping the home awake at the 15-minute cap, though the engine names no expiry and never ends it", async () => {
    const signIns = trace();
    const sessions = new ProviderAuthSessions({ trace: signIns, now: () => clock });
    await sessions.start(engine(), "session-1");
    expect(sessions.active).toBe(true);
    clock += 15 * MINUTE - 1;
    expect(sessions.active).toBe(true);
    clock += 1;
    expect(sessions.active).toBe(false);
    await vi.waitFor(() => expect(signIns.summary().engines[0]?.last?.outcome).toBe("expired"));
    expect(signIns.summary()).toMatchObject({ attempts: 1, open: 0 });
    expect(lines.at(-1)).toBe("sign-in: claudeAgent paste-code expired after 15m 00s");
  });

  it("never lets an engine's read throw out of the power probe: a flow it can't read counts as expired", async () => {
    const signIns = trace();
    const sessions = new ProviderAuthSessions({ trace: signIns, now: () => clock });
    const instance = engine();
    await sessions.start(instance, "session-1");
    instance.getAuthentication.mockImplementation((() => { throw new Error("broken engine"); }) as never);
    clock += 15 * MINUTE;
    expect(() => sessions.active).not.toThrow();
    expect(sessions.active).toBe(false);
    await vi.waitFor(() => expect(signIns.summary().engines[0]?.last?.outcome).toBe("expired"));
  });

  it("keeps a newer attempt as the engine's last when an older one's expiry is recorded after it began", async () => {
    const signIns = trace();
    const sessions = new ProviderAuthSessions({ trace: signIns, now: () => clock });
    const first = engine();
    await sessions.start(first, "session-1");
    let answer: (status: ProviderAuthenticationStatus) => void = () => {};
    first.getAuthentication.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    clock += 15 * MINUTE;
    expect(sessions.active).toBe(false);
    await vi.waitFor(() => expect(first.getAuthentication).toHaveBeenCalled());
    // The person signs in again before the engine answers how the first one ended.
    await sessions.start(engine(first.instanceId, "claudeAgent", { flowId: "flow-second" }), "session-1");
    answer({ phase: "expired", flowId: FLOW, authorizationUrl: null, expiresAt: null, reason: "expired" });
    await vi.waitFor(() => expect(signIns.summary().recent.map((event) => event.outcome)).toEqual(["started", "started", "expired"]));
    expect(signIns.summary()).toMatchObject({ attempts: 2, open: 1, engines: [{ kind: "claudeAgent", attempts: 2, last: { outcome: "started" } }] });
  });

  it("records a flow that was open when the server stopped as interrupted on the next start, and the sign-in screen hears it", async () => {
    const before = new ProviderAuthSessions({ trace: trace(), now: () => clock });
    const instance = engine();
    await before.start(instance, "session-1");
    expect(JSON.parse(file()).open).toHaveLength(1);
    // While it is open, the file recognises the flow by a hash only: never the flow, the instance or the session.
    for (const hidden of [FLOW, instance.instanceId, "session-1", LINK]) expect(file()).not.toContain(hidden);

    // The machine is stopped to sleep and boots again: a new process, the same data folder.
    clock += 4 * MINUTE + 5_000;
    lines = [];
    const signIns = trace(true);
    signIns.recover();
    expect(lines).toEqual(["sign-in: claudeAgent paste-code interrupted after 4m 05s (the server was stopped to sleep)"]);
    expect(signIns.summary()).toMatchObject({ attempts: 1, open: 0, engines: [{ kind: "claudeAgent", attempts: 1, completed: 0, last: { outcome: "interrupted", at: clock } }] });
    signIns.recover();
    expect(lines).toHaveLength(1);

    const after = new ProviderAuthSessions({ trace: signIns, now: () => clock });
    // The screen's poll: a finished status that says why. The browser's session id is not kept, so any session asking
    // about that flow hears it, and nothing more.
    // No message: the screen words the reason in the person's own language.
    expect(await after.status(instance.instanceId, "session-1", FLOW)).toEqual({ phase: "failed", flowId: FLOW, authorizationUrl: null, expiresAt: null, reason: "interrupted" });
    // The paste-code screen finds out when it sends the code.
    await expect(after.complete(instance.instanceId, "session-1", FLOW, CODE)).rejects.toMatchObject({ status: 404, reason: "interrupted" });
    await expect(after.cancel(instance.instanceId, "session-1", FLOW)).resolves.toBeUndefined();
    // Any other flow is just gone, as before.
    await expect(after.status(instance.instanceId, "session-1", "another-flow")).rejects.toMatchObject({ status: 404 });
    await expect(after.status(instance.instanceId, "session-1", "another-flow")).rejects.not.toHaveProperty("reason");
    expect(instance.completeAuthentication).not.toHaveBeenCalled();

    // A new sign-in on the same engine is its own attempt, and its flow is never mistaken for the old one.
    await after.start(engine(instance.instanceId, "claudeAgent", { flowId: "flow-new" }), "session-1");
    expect(await after.status(instance.instanceId, "session-1", "flow-new")).toMatchObject({ phase: "waiting" });
    expect(signIns.summary()).toMatchObject({ attempts: 2, open: 1 });
  });

  it("leaves an attempt the shutdown tears down open, so the next boot calls it interrupted, not cancelled", async () => {
    const signIns = trace();
    const sessions = new ProviderAuthSessions({ trace: signIns, now: () => clock });
    const instance = engine();
    await sessions.start(instance, "session-1");
    signIns.stopping();
    sessions.clearInstance(instance.instanceId);
    expect(JSON.parse(file()).open).toHaveLength(1);
    expect(lines).toEqual(["sign-in: claudeAgent paste-code started"]);
    const next = trace();
    next.recover();
    expect(next.summary().engines[0].last?.outcome).toBe("interrupted");
    expect(next.interrupted(instance.instanceId, FLOW)).toBe(true);
  });

  it("a restart, not a sleep, says so; a boot with nothing open writes nothing", () => {
    writeFileSync(join(dir, SIGN_IN_TRACE_FILE), JSON.stringify({ v: 1, open: [{ id: "a", kind: "codex", method: "device-code", at: START - 30_000 }], recent: [], engines: {} }));
    trace(false).recover();
    expect(lines).toEqual(["sign-in: codex device-code interrupted after 30s (the server restarted)"]);
    const empty = mkdtempSync(join(tmpdir(), "omb-sign-in-trace-empty-"));
    try {
      createSignInTrace({ dataDir: empty, log: (line) => lines.push(line) }).recover();
      expect(readdirSync(empty)).toEqual([]);
    } finally { void removeTempDir(empty); }
  });

  it("keeps a small, bounded summary and never a code, a link, a flow, a session or an instance's name", async () => {
    const signIns = trace();
    const sessions = new ProviderAuthSessions({ trace: signIns, now: () => clock });
    for (let index = 0; index < 30; index++) {
      const instance = engine(`personal-name-${index}`, `engine${index % 25}`);
      await sessions.start(instance, `session-secret-${index}`);
      instance.completeAuthentication.mockRejectedValueOnce(Object.assign(new Error(`bad code ${CODE}`), { reason: "wrong_code" }));
      await expect(sessions.complete(instance.instanceId, `session-secret-${index}`, FLOW, CODE)).rejects.toThrow();
      await sessions.cancel(instance.instanceId, `session-secret-${index}`, FLOW);
      clock += MINUTE;
    }
    const summary = signIns.summary();
    // engine0 to engine19 are counted (the first twenty kinds), engine0 to engine4 twice.
    expect(summary.attempts).toBe(20 + 5);
    expect(summary.engines).toHaveLength(20);
    expect(summary.recent).toHaveLength(10);
    expect(summary.recent.at(-1)).toMatchObject({ kind: "engine4", method: "paste-code", outcome: "cancelled" });
    expect(JSON.stringify(summary).length).toBeLessThan(4_096);
    for (const text of [file(), lines.join("\n"), JSON.stringify(summary)]) {
      for (const secret of [FLOW, CODE, "secret-state", "claude.com", "session-secret", "personal-name"]) expect(text).not.toContain(secret);
    }
  });

  it("reads a file that is not its own as empty, and drops anything in it that is not a code", () => {
    writeFileSync(join(dir, SIGN_IN_TRACE_FILE), "not json");
    expect(trace().summary()).toEqual({ attempts: 0, open: 0, engines: [], recent: [] });
    writeFileSync(join(dir, SIGN_IN_TRACE_FILE), JSON.stringify({ v: 1, open: [], recent: [
      { kind: "has spaces ada@example.test", method: "pasted the token", outcome: "completed", at: 5 },
      { kind: "codex", method: "device-code", outcome: "token=secret", at: 6 },
    ], engines: { "codex": { attempts: -3, completed: "lots", last: { outcome: "secret", at: 1 } }, "bad kind!": { attempts: 1 } } }));
    expect(trace().summary()).toEqual({ attempts: 0, open: 0, engines: [{ kind: "codex", attempts: 0, completed: 0, last: null }],
      recent: [{ kind: "unknown", method: "other", outcome: "completed", at: 5 }] });
  });

  it("names each method as the provider card does", () => {
    expect(signInMethodOf({ getAuthentication: () => {}, completeAuthentication: () => {} })).toBe("paste-code");
    expect(signInMethodOf({ getAuthentication: () => {} })).toBe("device-code");
    expect(signInMethodOf({})).toBe("callback-url");
    expect(signInMethodOf({ authenticationMethod: "browser-pkce", getAuthentication: () => {} })).toBe("browser-pkce");
    expect(signInMethodOf({ authenticationMethod: "callback-url", getAuthentication: () => {}, completeAuthentication: () => {} })).toBe("callback-url");
  });
});

describe("a desktop's sign-in sessions (no trace)", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "omb-sign-in-desktop-")); });
  afterEach(async () => { await removeTempDir(dir); });

  it("write nothing, log nothing, and count a sign-in as under way exactly as before", async () => {
    const log = vi.spyOn(console, "log");
    let clock = START;
    const sessions = new ProviderAuthSessions({ now: () => clock });
    const instance = engine();
    await sessions.start(instance, "session-1");
    expect(sessions.active).toBe(true);
    instance.completeAuthentication.mockRejectedValueOnce(Object.assign(new Error("not a code"), { reason: "wrong_code" }));
    await expect(sessions.complete(instance.instanceId, "session-1", FLOW, "short")).rejects.toThrow();
    expect(sessions.active).toBe(true);
    clock += 15 * MINUTE;
    expect(sessions.active).toBe(false);
    await sessions.start(instance, "session-1");
    await sessions.cancel(instance.instanceId, "session-1", FLOW);
    expect(sessions.active).toBe(false);
    // Without a trace, a resumed flow is never re-read before its start, as before.
    await sessions.start(instance, "session-1");
    await sessions.start(instance, "session-1");
    expect(instance.getAuthentication).not.toHaveBeenCalled();
    expect(readdirSync(dir)).toEqual([]);
    expect(log.mock.calls.flat().some((line) => String(line).startsWith("sign-in:"))).toBe(false);
    log.mockRestore();
  });
});
