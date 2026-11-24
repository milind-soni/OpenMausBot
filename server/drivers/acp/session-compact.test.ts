import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

vi.mock("../prompt-split.ts", () => ({ deletePromptSplitReceipt: vi.fn() }));

import { deletePromptSplitReceipt } from "../prompt-split.ts";
import { acpCompactSession, type AcpCompactDeps } from "./session-compact.ts";
import type { AcpSession } from "./turn-state.ts";

const SESSION = "native-session-1";
const RESULT = { stopReason: "end_turn", usage: { inputTokens: 900, outputTokens: 50 } };

function setup(answer: (link: { heard: (update: object) => void; reply: (result: unknown) => void }) => void, overrides: Partial<AcpSession> = {}) {
  const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null });
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
    closeSession: vi.fn((threadId: string) => { sessions.delete(threadId); }), endUncancelled: vi.fn(async () => true), armIdle: vi.fn(),
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

  it("returns on Stop while the pre-send check is still reading, sending neither /compact nor a cancel and keeping the receipt", async () => {
    const { deps, acp, active } = setup(({ reply }) => reply(RESULT));
    deps.promptOutcome = () => new Promise(() => {});
    vi.mocked(deletePromptSplitReceipt).mockClear();
    const stop = new AbortController();
    const compacting = acpCompactSession(deps)("thread", { session: SESSION, signal: stop.signal });
    await vi.waitFor(() => expect(active.has("thread")).toBe(true));
    stop.abort();
    expect(await compacting).toEqual({ ok: false, reason: "stopped" });
    expect(active.has("thread")).toBe(false);
    expect(acp.request).not.toHaveBeenCalled();
    expect(acp.send).not.toHaveBeenCalled();
    expect(deps.armIdle).toHaveBeenCalledWith("thread");
    expect(deletePromptSplitReceipt).not.toHaveBeenCalled();
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

  it("takes a compaction the agent finished as Stop reached it as done", async () => {
    let answer: (() => void) | undefined;
    const { deps } = setup(({ heard, reply }) => { answer = () => { heard({ sessionUpdate: "usage_update", used: 950 }); reply(RESULT); }; });
    const stop = new AbortController();
    const compacting = acpCompactSession(deps)("thread", { session: SESSION, signal: stop.signal });
    await vi.waitFor(() => expect(answer).toBeDefined());
    stop.abort();
    answer!();
    expect(await compacting).toMatchObject({ ok: true, usage: { input: 900, output: 50 } });
  });

  it("lets a Stop's interrupt return only once the session is given back", async () => {
    let answer: ((result: unknown) => void) | undefined;
    const { deps, active } = setup(({ reply }) => { answer = reply; });
    const compacting = acpCompactSession(deps)("thread", { session: SESSION });
    await vi.waitFor(() => expect(answer).toBeDefined());
    const interrupted = Promise.resolve(active.get("thread")!.interrupt());
    let returned = false;
    void interrupted.then(() => { returned = true; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(returned).toBe(false);
    answer!({ stopReason: "cancelled" });
    await interrupted;
    expect(active.has("thread")).toBe(false);
    expect(await compacting).toEqual({ ok: false, reason: "stopped" });
  });

  it("marks the session changed when the agent replied and then failed", async () => {
    const { deps, session } = setup(({ heard }) => {
      heard({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Nothing to compact" } });
      session.child.emit("error", new Error("pipe closed"));
    });
    expect(await acpCompactSession(deps)("thread", { session: SESSION })).toMatchObject({ ok: false, sessionChanged: true });
  });

  it("keeps the usage of an answer that came after its timeout", async () => {
    let answer: ((result: unknown) => void) | undefined;
    const { deps, acp } = setup(({ reply }) => { answer = reply; });
    vi.useFakeTimers();
    try {
      const compacting = acpCompactSession(deps)("thread", { session: SESSION });
      await vi.advanceTimersByTimeAsync(300_000);
      expect(acp.send).toHaveBeenCalledWith(expect.objectContaining({ method: "session/cancel" }));
      answer!(RESULT);
      expect(await compacting).toMatchObject({ ok: false, reason: "timed out", usage: { input: 900, output: 50 } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops waiting for the cancel once the agent exits", async () => {
    const { deps, session, acp } = setup(() => {});
    vi.useFakeTimers();
    try {
      const stop = new AbortController();
      const compacting = acpCompactSession(deps)("thread", { session: SESSION, signal: stop.signal });
      await vi.advanceTimersByTimeAsync(0);
      stop.abort();
      await vi.advanceTimersByTimeAsync(0);
      expect(acp.send).toHaveBeenCalled();
      session.child.emit("exit", null, "SIGKILL");
      let result: unknown;
      void compacting.then((value) => { result = value; });
      await vi.advanceTimersByTimeAsync(0);
      expect(result).toMatchObject({ ok: false, reason: "stopped" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives the thread back when the agent's pipes close during the compaction", async () => {
    const { deps, session, active } = setup(() => { session.child.emit("close", null, "SIGKILL"); });
    expect(await acpCompactSession(deps)("thread", { session: SESSION })).toMatchObject({ ok: false, reason: "the agent exited during compaction" });
    expect(active.has("thread")).toBe(false);
  });

  it("does not let a stuck failure check hold a Stop that comes after the answer", async () => {
    const { deps, active } = setup(({ heard, reply }) => { heard({ sessionUpdate: "usage_update", used: 950 }); reply(RESULT); });
    deps.promptOutcome = async () => () => new Promise(() => {});
    const stop = new AbortController();
    const compacting = acpCompactSession(deps)("thread", { session: SESSION, signal: stop.signal });
    await vi.waitFor(() => expect(active.has("thread")).toBe(true));
    await new Promise((resolve) => setImmediate(resolve));
    stop.abort();
    expect(await compacting).toMatchObject({ ok: false, reason: "stopped", usage: { input: 900, output: 50 } });
    expect(active.has("thread")).toBe(false);
  });

  it("forgets the prompt-split receipt of a session it keeps after a Stop cut the failure check short", async () => {
    const { deps, active, sessions } = setup(({ heard, reply }) => { heard({ sessionUpdate: "usage_update", used: 950 }); reply(RESULT); });
    deps.promptOutcome = async () => () => new Promise(() => {});
    vi.mocked(deletePromptSplitReceipt).mockClear();
    const stop = new AbortController();
    const compacting = acpCompactSession(deps)("thread", { session: SESSION, signal: stop.signal });
    await vi.waitFor(() => expect(active.has("thread")).toBe(true));
    await new Promise((resolve) => setImmediate(resolve));
    stop.abort();
    expect(await compacting).toMatchObject({ ok: false, reason: "stopped" });
    expect(sessions.has("thread")).toBe(true);
    expect(deletePromptSplitReceipt).toHaveBeenCalledWith("fixtureAgent", JSON.stringify(["thread", SESSION]));
  });

  it("forgets the prompt-split receipt when the agent exits during the failure check after answering /compact", async () => {
    const { deps, session } = setup(({ heard, reply }) => { heard({ sessionUpdate: "usage_update", used: 950 }); reply(RESULT); });
    deps.promptOutcome = async () => () => { setImmediate(() => session.child.emit("exit", 1, null)); return new Promise(() => {}); };
    vi.mocked(deletePromptSplitReceipt).mockClear();
    expect(await acpCompactSession(deps)("thread", { session: SESSION })).toMatchObject({ ok: false, reason: "the agent exited during compaction" });
    expect(deletePromptSplitReceipt).toHaveBeenCalledWith("fixtureAgent", JSON.stringify(["thread", SESSION]));
  });

  it("keeps a reply's usage and lets no turn carry the session on when Stop cuts the failure check short", async () => {
    const { deps, active, sessions } = setup(({ heard, reply }) => {
      heard({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Nothing to compact" } });
      reply(RESULT);
    });
    deps.promptOutcome = async () => () => new Promise(() => {});
    const stop = new AbortController();
    const compacting = acpCompactSession(deps)("thread", { session: SESSION, signal: stop.signal });
    await vi.waitFor(() => expect(active.has("thread")).toBe(true));
    await new Promise((resolve) => setImmediate(resolve));
    stop.abort();
    expect(await compacting).toMatchObject({ ok: false, reason: "stopped", usage: { input: 900, output: 50 }, sessionChanged: true });
    expect(sessions.has("thread")).toBe(false);
  });

  it("ends a failure check that starts after the deadline passed", async () => {
    let answer: ((result: unknown) => void) | undefined;
    const { deps, acp } = setup(({ heard, reply }) => { answer = (result) => { heard({ sessionUpdate: "usage_update", used: 950 }); reply(result); }; });
    deps.promptOutcome = async () => () => new Promise(() => {});
    vi.useFakeTimers();
    try {
      const stop = new AbortController();
      const compacting = acpCompactSession(deps)("thread", { session: SESSION, signal: stop.signal });
      await vi.advanceTimersByTimeAsync(298_000);
      stop.abort();
      await vi.advanceTimersByTimeAsync(0);
      expect(acp.send).toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(3_000);
      answer!(RESULT);
      let result: unknown;
      void compacting.then((value) => { result = value; });
      await vi.advanceTimersByTimeAsync(0);
      expect(result).toMatchObject({ ok: false, reason: "timed out", usage: { input: 900 } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds the failure check that follows an answer a Stop had already asked to cancel", async () => {
    let answer: ((result: unknown) => void) | undefined;
    const { deps, active } = setup(({ heard, reply }) => { answer = (result) => { heard({ sessionUpdate: "usage_update", used: 950 }); reply(result); }; });
    deps.promptOutcome = async () => () => new Promise(() => {});
    vi.useFakeTimers();
    try {
      const stop = new AbortController();
      const compacting = acpCompactSession(deps)("thread", { session: SESSION, signal: stop.signal });
      await vi.advanceTimersByTimeAsync(0);
      stop.abort();
      await vi.advanceTimersByTimeAsync(0);
      answer!(RESULT);
      let result: unknown;
      void compacting.then((value) => { result = value; });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(result).toMatchObject({ ok: false, reason: "stopped", usage: { input: 900 } });
      expect(active.has("thread")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still reports a compaction the check accepts within the grace after a Stop", async () => {
    let answer: ((result: unknown) => void) | undefined;
    const { deps } = setup(({ heard, reply }) => { answer = (result) => { heard({ sessionUpdate: "usage_update", used: 950 }); reply(result); }; });
    deps.promptOutcome = async () => async () => undefined;
    const stop = new AbortController();
    const compacting = acpCompactSession(deps)("thread", { session: SESSION, signal: stop.signal });
    await vi.waitFor(() => expect(answer).toBeDefined());
    stop.abort();
    answer!(RESULT);
    expect(await compacting).toMatchObject({ ok: true, usage: { input: 900 } });
  });

  it("does not send /compact to a process a signal ended", async () => {
    const { deps, session, acp } = setup(() => {});
    (session.child as unknown as { signalCode: string }).signalCode = "SIGKILL";
    expect(await acpCompactSession(deps)("thread", { session: SESSION })).toMatchObject({ ok: false, reason: "no live session holds this conversation" });
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
