import { describe, expect, it, vi } from "vitest";

import type { IdleCompactResult } from "../contracts.ts";
import type { HandedState } from "../delta-context.ts";
import type { Message } from "../store.ts";
import { WARM_SUMMARY_IDLE_MS, WARM_SUMMARY_RETRY_MS, WARM_SUMMARY_SOON_MS } from "../warm-summary.ts";
import { addServerLinePacks } from "../server-lines.ts";
import { createWarmSummaryHost, keptAfterSummary, PRESENCE_HOLD_MS, summaryInstructions, type WarmSummaryHostDeps } from "./warm-summary-host.ts";

let at = 0;
const line = (role: "user" | "bot", text: string, extra: Partial<Message> = {}): Message =>
  ({ id: `m${++at}`, at, role, kind: "text", text, ...extra }) as Message;
const activity = (name: string): Message => ({ id: `m${++at}`, at, role: "bot", kind: "activity", tool: { name, ok: true } }) as Message;
const card = (title: string, subtitle: string, state: Record<string, unknown> = {}): Message =>
  ({ id: `m${++at}`, at, role: "bot", kind: "options", card: { title, subtitle, options: ["Yes", "No"], requestType: "question", ...state } }) as unknown as Message;

describe("what a summary keeps", () => {
  it("keeps the person's last two messages and everything since word for word, and hands the session the rest", () => {
    const messages = [line("user", "first ask"), line("bot", "first answer"), activity("Bash"), line("user", "second ask"),
      line("bot", "second answer"), line("user", "third ask, port 9001 not 9000"), line("bot", "third answer")];
    const { state, exchanges } = keptAfterSummary(messages, "fork-1", { session: "old", config: "cfg", ids: ["x"] });
    expect(state).toEqual({ session: "fork-1", config: "cfg", through: messages[1]!.id, ids: [] });
    expect(exchanges).toBe(2);
  });

  it("keeps a short conversation whole", () => {
    const messages = [line("user", "only ask"), line("bot", "a long tool-heavy answer")];
    const { state, exchanges } = keptAfterSummary(messages, "fork-2", undefined);
    expect(state).toEqual({ session: "fork-2", ids: [] });
    expect(exchanges).toBe(1);
  });

  it("asks the summary to keep open questions, and only open ones", () => {
    const messages = [card("Which port?", "9000 or 9001"), card("Deploy now?", "", { answered: "Yes" }),
      card("Old question", "", { expired: true }), card("Stopped", "", { stopped: true }), line("user", "hi")];
    const instructions = summaryInstructions(messages);
    expect(instructions).toContain("every question still waiting for an answer");
    expect(instructions).toContain('Questions waiting for the person: "Which port?: 9000 or 9001".');
    expect(instructions).not.toContain("Deploy now?");
    expect(instructions).not.toContain("Old question");
    expect(instructions).not.toContain("Stopped");
    expect(summaryInstructions([line("user", "hi")])).not.toContain("Questions waiting");
  });
});

/** A host over an in-memory conversation with a Claude-like engine. */
function setup(overrides: Partial<WarmSummaryHostDeps> = {}, options: { tokens?: number; native?: boolean; room?: boolean; onCompact?: () => void } = {}) {
  let now = 5_000_000;
  const timers: Array<{ at: number; fn: () => void; cancelled: boolean }> = [];
  const messages: Message[] = [line("user", "build the page"), line("bot", "built it"), line("user", "make the title bold"),
    line("bot", "done, it is bold now"), line("user", "and the subtitle?"), line("bot", "the subtitle is bold too")];
  const task = { threadId: "t1", resumeCursors: { claude: "live-session" } as Record<string, unknown>, lastInstanceId: "claude",
    handedMessages: { claude: { session: "live-session", config: "cfg", ids: [] } } as Record<string, HandedState> };
  const appended: Message[] = [];
  const store = {
    taskByThread: (botId: string, threadId: string) => (botId === "b1" && threadId === "t1" ? task : undefined),
    botByThread: (threadId: string) => (threadId === "t1" ? { id: "b1" } : undefined),
    groupByThread: () => (options.room ? { id: "room" } : undefined),
    activePath: () => messages,
    appendMessage: (_threadId: string, message: Partial<Message>) => { appended.push(message as Message); return message; },
    setResumeCursor: (_botId: string, instanceId: string, cursor: unknown) => { task.resumeCursors[instanceId] = cursor; },
    setHandedMessages: (_botId: string, _threadId: string, instanceId: string, state: HandedState) => { task.handedMessages[instanceId] = state; },
  };
  const compactCalls: Array<{ threadId: string; instructions: string; session?: string }> = [];
  let compactResult: IdleCompactResult = { ok: true, session: "fork-session", sessionBefore: "live-session", input: 4, cacheRead: 150_000, cacheWrite: 40, output: 2_400, costUsd: 0.2, model: "claude-opus-5-5" };
  const holds: Array<{ threadId: string; until: number | null }> = [];
  const adapter = {
    cacheKeepWarm: {
      ...(options.native === false ? {} : { compact: vi.fn(async (threadId: string, input: { instructions: string; session?: string }) => {
        compactCalls.push({ threadId, ...input });
        options.onCompact?.();
        return compactResult;
      }) }),
      hold: (threadId: string, until: number | null) => { holds.push({ threadId, until }); return true; },
    },
  };
  const book = vi.fn();
  const fold = vi.fn(async () => true);
  const deps: WarmSummaryHostDeps = {
    store: store as unknown as WarmSummaryHostDeps["store"],
    instance: (id) => (id === "claude" ? { adapter } : undefined),
    enabled: () => true,
    nativeCompactAt: () => 200_000,
    busy: () => false,
    memoryShort: () => false,
    queued: () => false,
    coordinator: { activeDirect: () => false, awaitingTeammateThreads: () => new Set() },
    waits: () => ({ all: () => [] }),
    routines: () => ({ listRoutines: () => [], listRuns: () => [] }),
    fold,
    book,
    keepWarmUntil: () => undefined,
    now: () => now,
    after: (ms, fn) => {
      const timer = { at: now + ms, fn, cancelled: false };
      timers.push(timer);
      return { cancel: () => { timer.cancelled = true; } };
    },
    ...overrides,
  };
  const host = createWarmSummaryHost(deps);
  const advance = async (ms: number) => {
    const until = now + ms;
    for (;;) {
      const next = timers.filter((t) => !t.cancelled && t.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      now = next.at;
      next.cancelled = true;
      next.fn();
      for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
    }
    now = until;
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
  };
  const finishTurn = () => host.turnCompleted({ threadId: "t1", botId: "b1", instanceId: "claude" }, { ok: true, contextTokens: options.tokens ?? 150_000 });
  return { host, task, messages, appended, compactCalls, holds, book, fold, advance, finishTurn,
    setCompactResult: (result: IdleCompactResult) => { compactResult = result; }, now: () => now };
}

describe("warm summaries for a Claude conversation", () => {
  it("moves the conversation to the summarized fork and carries the last two exchanges on word for word", async () => {
    const f = setup();
    f.finishTurn();
    await f.advance(WARM_SUMMARY_IDLE_MS);
    expect(f.compactCalls).toEqual([{ threadId: "t1", session: "live-session", instructions: expect.stringContaining("every question still waiting"), signal: expect.any(AbortSignal) }]);
    expect(f.task.resumeCursors.claude).toBe("fork-session");
    expect(f.task.handedMessages.claude).toEqual({ session: "fork-session", config: "cfg", through: f.messages[1]!.id, ids: [] });
    expect(f.appended).toEqual([expect.objectContaining({ kind: "activity", tool: { name: "summarized this conversation while it was idle; the latest messages carry on word for word", ok: true } })]);
    expect(f.book).toHaveBeenCalledWith({ threadId: "t1", botId: "b1", instanceId: "claude" }, expect.objectContaining({ ok: true, cacheRead: 150_000 }));
  });

  it("writes its line in the language of the conversation's person", async () => {
    // A stand-in pack: the real translations are checked with the locale tests.
    addServerLinePacks({ de: { "server.warmSummary.summarized": "in einer Pause zusammengefasst" } });
    const f = setup({ language: (threadId) => (threadId === "t1" ? "de" : undefined) });
    f.finishTurn();
    await f.advance(WARM_SUMMARY_IDLE_MS);
    expect(f.appended).toEqual([expect.objectContaining({ tool: { name: "in einer Pause zusammengefasst", ok: true } })]);
  });

  it("leaves a conversation that moved to another session meanwhile alone", async () => {
    const f = setup();
    f.finishTurn();
    f.task.resumeCursors.claude = "another-session";
    await f.advance(WARM_SUMMARY_IDLE_MS);
    // The driver is told which session the conversation is on; a fork of any other is never applied.
    expect(f.compactCalls).toEqual([expect.objectContaining({ session: "another-session" })]);
    expect(f.task.resumeCursors.claude).toBe("another-session");
    expect(f.appended).toEqual([]);
  });

  it("drops a summary that finished after a turn began, so that turn's history is never lost", async () => {
    let busy = false;
    // The person's turn is being set up while the fork writes the summary.
    const f = setup({ busy: () => busy }, { onCompact: () => { busy = true; } });
    f.finishTurn();
    await f.advance(WARM_SUMMARY_IDLE_MS);
    expect(f.compactCalls).toHaveLength(1);
    expect(f.task.resumeCursors.claude).toBe("live-session");
    expect(f.appended).toEqual([]);
  });

  it("does nothing below 100k tokens, and starts at once from 80% of the engine's own compaction point", async () => {
    const small = setup({}, { tokens: 60_000 });
    small.finishTurn();
    await small.advance(WARM_SUMMARY_IDLE_MS * 3);
    expect(small.compactCalls).toEqual([]);
    const near = setup({}, { tokens: 165_000 });
    near.finishTurn();
    await near.advance(WARM_SUMMARY_SOON_MS);
    expect(near.compactCalls).toHaveLength(1);
  });

  it("never summarizes a room, or with automatic compaction off", async () => {
    const room = setup({}, { room: true });
    room.finishTurn();
    await room.advance(WARM_SUMMARY_IDLE_MS * 3);
    expect(room.compactCalls).toEqual([]);
    const off = setup({ enabled: () => false });
    off.finishTurn();
    await off.advance(WARM_SUMMARY_IDLE_MS * 3);
    expect(off.compactCalls).toEqual([]);
  });

  it.each([
    ["a queued message", { queued: () => true }],
    ["a teammate working on this conversation's request", { coordinator: { activeDirect: () => true, awaitingTeammateThreads: () => new Set<string>() } }],
    ["a teammate whose answer this conversation awaits", { coordinator: { activeDirect: () => false, awaitingTeammateThreads: () => new Set(["t1"]) } }],
    ["a wait that fired and will carry on here", { waits: () => ({ all: () => [{ id: "w", botId: "b1", threadId: "t1", label: "", condition: {} as never, followUp: "check CI", createdAt: 0, expiresAt: 0, nextCheckAt: 0, errors: 0, ending: { status: "fired" as const, text: "" } }] }) }],
  ] as Array<[string, Partial<WarmSummaryHostDeps>]>)("skips while work is due: %s", async (_name, overrides) => {
    const f = setup(overrides);
    f.finishTurn();
    await f.advance(WARM_SUMMARY_IDLE_MS * 10);
    expect(f.compactCalls).toEqual([]);
  });

  it("waits for a routine due soon, a busy bot or short memory, then summarizes", async () => {
    let due = true;
    const routine = { id: "r", botId: "b1", enabled: true, nextRunAt: 0 } as never;
    const f = setup({ routines: () => ({ listRoutines: () => (due ? [{ ...(routine as object), nextRunAt: f.now() + 60_000 }] : []) as never, listRuns: () => [] }) });
    f.finishTurn();
    await f.advance(WARM_SUMMARY_IDLE_MS);
    expect(f.compactCalls).toEqual([]);
    due = false;
    await f.advance(WARM_SUMMARY_RETRY_MS);
    expect(f.compactCalls).toHaveLength(1);
  });

  it("uses OpenMausBot's own fold for an engine without its own compaction", async () => {
    const f = setup({}, { native: false });
    f.finishTurn();
    await f.advance(WARM_SUMMARY_IDLE_MS);
    expect(f.fold).toHaveBeenCalledWith({ threadId: "t1", botId: "b1", instanceId: "claude" }, expect.any(AbortSignal));
  });

  it("keeps the conversation's process alive while the person has it open, and starts a summary the next turn needs", async () => {
    const f = setup({ keepWarmUntil: () => 5_000_000 + 3 * 60 * 60_000 }, { tokens: 170_000 });
    f.finishTurn();
    f.host.sawThread("t1");
    await f.advance(0);
    expect(f.compactCalls).toHaveLength(1);
    expect(f.holds).toEqual([{ threadId: "t1", until: 5_000_000 + 3 * 60 * 60_000 }]);
    const g = setup();
    g.host.sawThread("t1");
    expect(g.holds).toEqual([{ threadId: "t1", until: g.now() + PRESENCE_HOLD_MS }]);
  });
});
