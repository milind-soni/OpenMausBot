import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { acpCompactSession, type AcpCompactDeps } from "./session-compact.ts";
import type { AcpSession } from "./turn-state.ts";

const SESSION = "native-session-1";
const RESULT = { stopReason: "end_turn", usage: { inputTokens: 900, outputTokens: 50 } };

/** A live session whose agent answers `/compact` by `answer`, which may report updates around its reply. */
function setup(answer: (link: { heard: (update: object) => void; reply: (result: unknown) => void }) => void, overrides: Partial<AcpSession> = {}) {
  const child = Object.assign(new EventEmitter(), { exitCode: null });
  const acp: { onUpdate: ((params: any) => void) | null; request: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn> } = {
    onUpdate: null,
    send: vi.fn(),
    request: vi.fn((_method: string, _params: unknown, _timeout: unknown, receive?: (result: unknown) => void) => new Promise((resolve) => {
      answer({
        heard: (update) => acp.onUpdate?.({ sessionId: SESSION, update }),
        reply: (result) => { receive?.(result); resolve(result); },
      });
    })),
  };
  const session = { child, acp, sessionId: SESSION, current: null, dead: false, closing: false, idleTimer: null,
    compactCommand: "compact", commands: new Set(["compact"]), commandsSession: SESSION, lastModel: "fixture-model", ...overrides } as unknown as AcpSession;
  const sessions = new Map([["thread", session]]);
  const active: AcpCompactDeps["active"] = new Map();
  const deps: AcpCompactDeps = {
    driverKind: "fixtureAgent", instanceId: "fixture", sessions, active, turnId: () => "turn", refusal: () => null,
    closeSession: vi.fn((threadId: string) => { sessions.delete(threadId); }), endUncancelled: vi.fn(async () => true), holdIdle: vi.fn(), armIdle: vi.fn(),
  };
  return { session, acp, deps, active, sessions };
}

describe("an ACP agent's own compaction of a live session", () => {
  it("counts the usage report that comes between /compact and its answer", async () => {
    const { deps, acp } = setup(({ heard, reply }) => { heard({ sessionUpdate: "usage_update", used: 950 }); reply(RESULT); });
    expect(await acpCompactSession(deps)("thread", { session: SESSION })).toEqual({ ok: true, usage: { input: 900, output: 50, cachedInput: 0 }, model: "fixture-model" });
    expect(acp.request.mock.calls[0][1]).toEqual({ sessionId: SESSION, prompt: [{ type: "text", text: "/compact" }] });
  });

  it("does not count a usage report that comes after the answer", async () => {
    const { deps, sessions } = setup(({ heard, reply }) => { reply(RESULT); heard({ sessionUpdate: "usage_update", used: 950 }); });
    expect(await acpCompactSession(deps)("thread", { session: SESSION })).toMatchObject({ ok: false, reason: "the agent reported no compaction", usage: { input: 900 } });
    expect(sessions.has("thread")).toBe(false);
  });

  it("does not count a usage report that came before /compact was sent", async () => {
    let early: (() => void) | undefined;
    const { deps, session } = setup(({ reply }) => reply(RESULT));
    deps.promptOutcome = async () => { early?.(); return async () => undefined; };
    early = () => session.acp.onUpdate?.({ sessionId: SESSION, update: { sessionUpdate: "usage_update", used: 950 } });
    expect(await acpCompactSession(deps)("thread", { session: SESSION })).toMatchObject({ ok: false, reason: "the agent reported no compaction" });
  });

  it("returns on Stop while the pre-send check is still reading, sending neither /compact nor a cancel", async () => {
    const { deps, acp, active } = setup(({ reply }) => reply(RESULT));
    deps.promptOutcome = () => new Promise(() => {});
    const stop = new AbortController();
    const compacting = acpCompactSession(deps)("thread", { session: SESSION, signal: stop.signal });
    await vi.waitFor(() => expect(active.has("thread")).toBe(true));
    stop.abort();
    expect(await compacting).toEqual({ ok: false, reason: "stopped" });
    expect(active.has("thread")).toBe(false);
    expect(acp.request).not.toHaveBeenCalled();
    expect(acp.send).not.toHaveBeenCalled();
    expect(deps.armIdle).toHaveBeenCalledWith("thread");
  });

  it("does not send /compact when the instance changed while the pre-send check read", async () => {
    const { deps, acp } = setup(({ reply }) => reply(RESULT));
    expect(await acpCompactSession(deps)("thread", { session: SESSION, selectionNow: () => ({ instanceId: "another", model: null }) }))
      .toMatchObject({ ok: false, reason: "the conversation moved on before the compaction was sent" });
    expect(acp.request).not.toHaveBeenCalled();
  });

  it("does not trust a command list advertised for another session of the same process", async () => {
    const { deps, acp } = setup(({ reply }) => reply(RESULT), { commandsSession: "native-session-0" });
    expect(await acpCompactSession(deps)("thread", { session: SESSION })).toMatchObject({ ok: false, reason: "the session does not offer /compact" });
    expect(acp.request).not.toHaveBeenCalled();
  });

  it("leaves a session alone whose launch named no command", async () => {
    const { deps, acp } = setup(({ reply }) => reply(RESULT), { compactCommand: undefined });
    expect(await acpCompactSession(deps)("thread", { session: SESSION })).toMatchObject({ ok: false, reason: "this runtime has no in-place compaction" });
    expect(acp.request).not.toHaveBeenCalled();
  });

  it("says so when the agent ignored the cancel and could not be stopped", async () => {
    const { deps } = setup(() => {});
    deps.endUncancelled = vi.fn(async () => false);
    vi.useFakeTimers();
    try {
      const stop = new AbortController();
      const compacting = acpCompactSession(deps)("thread", { session: SESSION, signal: stop.signal });
      await vi.advanceTimersByTimeAsync(0);
      stop.abort();
      await vi.advanceTimersByTimeAsync(6_000);
      expect(await compacting).toEqual({ ok: false, reason: "the agent could not be stopped" });
    } finally {
      vi.useRealTimers();
    }
  });
});
