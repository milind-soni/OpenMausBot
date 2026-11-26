import { describe, expect, it, vi } from "vitest";

import type { EngineCompactResult, IdleCompactResult } from "../contracts.ts";
import type { HandedState } from "../delta-context.ts";
import type { Message } from "../store.ts";
import { createJobSlots } from "../job-slots.ts";
import { WARM_SUMMARY_GIVE_UP_MS, WARM_SUMMARY_IDLE_MS, WARM_SUMMARY_NOW_MS, WARM_SUMMARY_RETRY_MS, WARM_SUMMARY_SOON_MS } from "../warm-summary.ts";
import { addServerLinePacks } from "../server-lines.ts";
import { autoCompactWindow } from "../drivers/claude.ts";
import { COMPACTION_STARTED_LINE, createWarmSummaryHost, keptAfterSummary, PRESENCE_HOLD_MS, summaryInstructions, type EngineCompactCheck, type WarmSummaryHostDeps } from "./warm-summary-host.ts";

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
function setup(overrides: Partial<WarmSummaryHostDeps> = {}, options: { tokens?: number; native?: boolean; room?: boolean; onCompact?: () => void; inPlace?: (threadId: string, input: { botId?: string; session: string; model?: string | null; selectionNow?: () => { instanceId: string; model: string | null } | undefined; signal?: AbortSignal }) => Promise<EngineCompactResult> } = {}) {
  let now = 5_000_000;
  const timers: Array<{ at: number; fn: () => void; cancelled: boolean }> = [];
  const messages: Message[] = [line("user", "build the page"), line("bot", "built it"), line("user", "make the title bold"),
    line("bot", "done, it is bold now"), line("user", "and the subtitle?"), line("bot", "the subtitle is bold too")];
  const task = { threadId: "t1", resumeCursors: { claude: "live-session" } as Record<string, unknown>, lastInstanceId: "claude", lastContextModel: "claude:m" as string | undefined,
    usage: { input: 10, output: 5, turns: 1, costUsd: null, context: { tokens: 270_000, window: 272_000 } as { tokens: number; window: number } | undefined },
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
    patchTask: (_botId: string, _threadId: string, patch: Record<string, unknown>) => Object.assign(task, patch),
  };
  const compactCalls: Array<{ threadId: string; instructions: string; session?: string }> = [];
  let compactResult: IdleCompactResult = { ok: true, session: "fork-session", sessionBefore: "live-session", input: 4, cacheRead: 150_000, cacheWrite: 40, output: 2_400, costUsd: 0.2, model: "claude-opus-5-5" };
  const holds: Array<{ threadId: string; until: number | null }> = [];
  const adapter = {
    ...(options.inPlace ? { compactSession: vi.fn(options.inPlace) } : {}),
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
  const bookEngineCompact = vi.fn();
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
    bookEngineCompact,
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
  return { host, task, messages, appended, compactCalls, holds, book, bookEngineCompact, adapter, fold, advance, finishTurn,
    setCompactResult: (result: IdleCompactResult) => { compactResult = result; }, now: () => now };
}

describe("warm summaries for a Claude conversation", () => {
  it("does not give an awaited summary's extra capacity to a queued background job", async () => {
    const slots = createJobSlots(1);
    let finishBackground!: () => void;
    const background = slots.run(() => new Promise<void>((resolve) => { finishBackground = resolve; }));
    let finishSummary!: (result: IdleCompactResult) => void;
    const summary = new Promise<IdleCompactResult>((resolve) => { finishSummary = resolve; });
    let summaryStarted!: () => void;
    const started = new Promise<void>((resolve) => { summaryStarted = resolve; });
    const f = setup({ slots, instance: () => ({ adapter: { cacheKeepWarm: {
      hold: () => true, compact: () => { summaryStarted(); return summary; },
    } } }) }, { tokens: 170_000 });
    const next = vi.fn(async () => undefined);
    let queued: Promise<void> | undefined;
    let turn: Promise<string> | undefined;
    try {
      f.finishTurn();
      await f.advance(WARM_SUMMARY_SOON_MS);
      queued = slots.run(next);
      turn = f.host.beforeTurn("t1");
      await started;
      expect(slots.running).toBe(2);
      finishSummary({ ok: true, session: "fork-session", sessionBefore: "live-session", input: 4, cacheRead: 150_000, cacheWrite: 40, output: 2_400, costUsd: 0.2, model: "claude-opus-5-5" });
      expect(await turn).toBe("waited");
      expect(f.task.resumeCursors.claude).toBe("fork-session");
      expect(next).not.toHaveBeenCalled();
      expect(slots.running).toBe(1);
      expect(slots.waiting).toBe(1);
      finishBackground();
      await Promise.all([background, queued]);
      expect(next).toHaveBeenCalledOnce();
    } finally {
      finishBackground();
      finishSummary({ ok: false, reason: "test finished" });
      f.host.dispose();
      await Promise.all([background, queued, turn]);
    }
  });

  it("skips a summary that waited for a free slot until its cache went cold, and writes one that waited less", async () => {
    let finish!: () => void;
    const slots = createJobSlots(1);
    const other = slots.run(() => new Promise<void>((resolve) => { finish = resolve; }));
    const cold = setup({ slots });
    cold.finishTurn();
    await cold.advance(WARM_SUMMARY_IDLE_MS);
    expect(slots.waiting).toBe(1);
    await cold.advance(WARM_SUMMARY_GIVE_UP_MS);
    finish();
    await other;
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
    expect(cold.compactCalls).toEqual([]);
    expect(cold.host.state("t1")?.last?.outcome).toMatch(/^failed: the prompt cache has gone cold \(after waiting for a free slot\)/);

    const warm = setup({ slots });
    const again = slots.run(() => new Promise<void>((resolve) => { finish = resolve; }));
    warm.finishTurn();
    await warm.advance(WARM_SUMMARY_IDLE_MS);
    await warm.advance(60_000);
    finish();
    await again;
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
    expect(warm.compactCalls).toHaveLength(1);
  });

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

  it("does nothing below 100k tokens, and starts at once close to the engine's own compaction point", async () => {
    const small = setup({}, { tokens: 60_000 });
    small.finishTurn();
    await small.advance(WARM_SUMMARY_IDLE_MS * 3);
    expect(small.compactCalls).toEqual([]);
    const near = setup({}, { tokens: 165_000 });
    near.finishTurn();
    await near.advance(WARM_SUMMARY_NOW_MS);
    expect(near.compactCalls).toHaveLength(1);
  });

  it("starts no summary ahead for Claude Opus 5.5 (1M) at 170k, whose own point is near 1M, and does for a 200k session at 165k", async () => {
    const compactAt = (model: string) => () => Number(autoCompactWindow({}, model));
    expect(compactAt("claude-opus-5-5[1m]")()).toBe(1_000_000);
    const wide = setup({ nativeCompactAt: compactAt("claude-opus-5-5[1m]") }, { tokens: 170_000 });
    wide.finishTurn();
    await wide.advance(WARM_SUMMARY_SOON_MS);
    expect(wide.compactCalls).toEqual([]);
    const usual = setup({ nativeCompactAt: compactAt("claude-opus-5-5") }, { tokens: 165_000 });
    usual.finishTurn();
    await usual.advance(WARM_SUMMARY_NOW_MS);
    expect(usual.compactCalls).toHaveLength(1);
  });

  it("places both points below where the engine compacts at a lower setting too", async () => {
    const low = setup({ nativeCompactAt: () => 100_000 }, { tokens: 60_500 });
    low.finishTurn();
    await low.advance(WARM_SUMMARY_NOW_MS);
    expect(low.compactCalls).toHaveLength(1);
    const lower = setup({ nativeCompactAt: () => 100_000 }, { tokens: 52_000 });
    lower.finishTurn();
    await lower.advance(WARM_SUMMARY_NOW_MS);
    expect(lower.compactCalls).toEqual([]);
    await lower.advance(WARM_SUMMARY_SOON_MS);
    expect(lower.compactCalls).toHaveLength(1);
  });

  it("writes the summary ahead from 27k below the engine's own point, after the pause of a quick reply, and minutes later below that", async () => {
    const below = setup({}, { tokens: 139_000 });
    below.finishTurn();
    await below.advance(WARM_SUMMARY_IDLE_MS - 1);
    expect(below.compactCalls).toEqual([]);
    await below.advance(1);
    expect(below.compactCalls).toHaveLength(1);
    const ahead = setup({}, { tokens: 141_465 });
    ahead.finishTurn();
    await ahead.advance(WARM_SUMMARY_SOON_MS - 1);
    expect(ahead.compactCalls).toEqual([]);
    await ahead.advance(1);
    expect(ahead.compactCalls).toHaveLength(1);
  });

  it("shows the engine's own compaction line to a person whose turn waits for the summary, then the summary's line", async () => {
    let finish = (_result: IdleCompactResult): void => undefined;
    const compact = vi.fn(() => new Promise<IdleCompactResult>((resolve) => { finish = resolve; }));
    const s = setup({ instance: () => ({ adapter: { cacheKeepWarm: { compact, hold: () => true } } }) }, { tokens: 165_000 });
    s.finishTurn();
    await s.advance(WARM_SUMMARY_NOW_MS);
    expect(compact).toHaveBeenCalledTimes(1);
    expect(s.appended).toEqual([]);
    const waiting = s.host.beforeTurn("t1");
    await s.advance(0);
    expect(s.appended.map((m) => m.tool?.name)).toEqual([COMPACTION_STARTED_LINE]);
    finish({ ok: true, session: "fork-session", sessionBefore: "live-session", input: 4, cacheRead: 160_000, cacheWrite: 40, output: 2_400, costUsd: 0.2, model: "claude-opus-5-5" });
    expect(await waiting).toBe("waited");
    expect(s.appended.map((m) => m.kind)).toEqual(["activity", "activity"]);
    expect(s.appended[1]!.tool?.name).toMatch(/summarized this conversation while it was idle/);
    expect(s.task.resumeCursors.claude).toBe("fork-session");
  });

  it("lets a waiting turn go on, on its own session, when the summary fails", async () => {
    let finish = (_result: IdleCompactResult): void => undefined;
    const compact = vi.fn(() => new Promise<IdleCompactResult>((resolve) => { finish = resolve; }));
    const s = setup({ instance: () => ({ adapter: { cacheKeepWarm: { compact, hold: () => true } } }) }, { tokens: 165_000 });
    s.finishTurn();
    await s.advance(WARM_SUMMARY_NOW_MS);
    const waiting = s.host.beforeTurn("t1");
    await s.advance(0);
    finish({ ok: false, reason: "the summary failed: API error" });
    expect(await waiting).toBe("waited");
    expect(s.task.resumeCursors.claude).toBe("live-session");
    expect(s.appended.map((m) => m.tool?.name)).toEqual([COMPACTION_STARTED_LINE]);
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

describe("Compact now", () => {
  const target = { threadId: "t1", botId: "b1", instanceId: "claude" };
  const check = (overrides: Partial<EngineCompactCheck> = {}): EngineCompactCheck => ({ model: "m", compactAtSet: false, resumes: () => true, selectionNow: () => ({ instanceId: "claude", model: "m" }), current: () => true, ...overrides });
  const ok = (usage: { input: number; output: number; cachedInput: number } | null = null): EngineCompactResult => ({ ok: true, usage, model: null });

  it("compacts in place: the cursor and the delivery ledger stay, the session and its engine are remembered, and one engine row is written", async () => {
    const f = setup({}, { inPlace: async () => ok({ input: 90, output: 10, cachedInput: 30 }) });
    const ledger = f.task.handedMessages.claude;
    const signal = new AbortController().signal;
    await expect(f.host.compactNow(target, signal, check())).resolves.toBe("done");
    expect(f.adapter.compactSession).toHaveBeenCalledWith("t1", { botId: "b1", session: "live-session", model: "m", selectionNow: expect.any(Function), signal });
    expect(f.adapter.compactSession!.mock.calls[0]![1].selectionNow!()).toEqual({ instanceId: "claude", model: "m" });
    expect(f.task.resumeCursors.claude).toBe("live-session");
    expect(f.task.handedMessages.claude).toBe(ledger);
    expect(f.task.lastContextModel).toBeUndefined();
    expect(f.task.usage).toEqual({ input: 10, output: 5, turns: 1, costUsd: null, context: undefined });
    expect(f.appended).toEqual([{ role: "bot", kind: "compaction", engineCompaction: true }]);
    expect(f.bookEngineCompact).toHaveBeenCalledWith(target, { ok: true, usage: { input: 90, output: 10, cachedInput: 30 }, model: "m" });
    expect(f.compactCalls).toEqual([]);
    expect(f.book).not.toHaveBeenCalled();
  });

  it("leaves the conversation to the fold when the person set where it folds, for an engine that compacts in place", async () => {
    const f = setup({}, { inPlace: async () => ok() });
    await expect(f.host.compactNow(target, new AbortController().signal, check({ compactAtSet: true }))).resolves.toBe("skipped");
    expect(f.adapter.compactSession).not.toHaveBeenCalled();
    const claude = setup();
    await expect(claude.host.compactNow(target, new AbortController().signal, check({ compactAtSet: true }))).resolves.toBe("done");
    expect(claude.compactCalls).toHaveLength(1);
  });

  it("hands the usage the engine did not report on as no usage, for the caller to book as unreported", async () => {
    const f = setup({}, { inPlace: async () => ok(null) });
    await expect(f.host.compactNow(target, new AbortController().signal, check())).resolves.toBe("done");
    expect(f.bookEngineCompact).toHaveBeenCalledWith(target, expect.objectContaining({ usage: null }));
  });

  it("leaves the conversation as it was, and folds, when the engine did nothing", async () => {
    const f = setup({}, { inPlace: async () => ({ ok: false, reason: "no kept process" }) });
    await expect(f.host.compactNow(target, new AbortController().signal, check())).resolves.toBe("skipped");
    expect(f.appended).toEqual([]);
    expect(f.bookEngineCompact).not.toHaveBeenCalled();
    expect(f.task.lastContextModel).toBe("claude:m");
    expect(f.task.usage.context).toEqual({ tokens: 270_000, window: 272_000 });
  });

  it("never asks the engine when the next turn would not carry on this session", async () => {
    const f = setup({}, { inPlace: async () => ok() });
    await expect(f.host.compactNow(target, new AbortController().signal, check({ resumes: () => false }))).resolves.toBe("skipped");
    expect(f.adapter.compactSession).not.toHaveBeenCalled();
    const claude = setup();
    await expect(claude.host.compactNow(target, new AbortController().signal, check({ resumes: () => false }))).resolves.toBe("skipped");
    expect(claude.compactCalls).toEqual([]);
    expect(claude.book).not.toHaveBeenCalled();
  });

  it("asks the decision about the session the conversation holds", async () => {
    const asked: string[] = [];
    const f = setup({}, { inPlace: async () => ok() });
    await f.host.compactNow(target, new AbortController().signal, check({ resumes: (session) => { asked.push(session); return true; } }));
    expect(asked).toEqual(["live-session", "live-session"]);
  });

  it.each([
    ["the cursor moved", (f: ReturnType<typeof setup>) => async () => { f.task.resumeCursors.claude = "another"; return ok({ input: 5, output: 1, cachedInput: 0 }); }, check()],
    ["the turn lost the conversation", () => async () => ok({ input: 5, output: 1, cachedInput: 0 }), check({ current: () => false })],
    ["the next turn no longer carries on", () => async () => ok({ input: 5, output: 1, cachedInput: 0 }), check({ resumes: (() => { let calls = 0; return () => ++calls === 1; })() })],
  ])("is stale when the engine compacted but %s: usage is booked, nothing else is written", async (_why, inPlace, checked) => {
    const holder: { f?: ReturnType<typeof setup> } = {};
    const f = setup({}, { inPlace: () => inPlace(holder.f!)() });
    holder.f = f;
    await expect(f.host.compactNow(target, new AbortController().signal, checked)).resolves.toBe("stale");
    expect(f.bookEngineCompact).toHaveBeenCalledTimes(1);
    expect(f.appended).toEqual([]);
    expect(f.task.lastContextModel).toBe("claude:m");
    expect(f.task.usage.context).toEqual({ tokens: 270_000, window: 272_000 });
    expect(f.fold).not.toHaveBeenCalled();
  });

  it.each([
    ["model", { instanceId: "claude", model: "another::model" }],
    ["engine instance, with a model of the same name", { instanceId: "another", model: "m" }],
    ["selection, gone", undefined],
  ])("is stale when the %s the next turn would run on changed while the engine compacted, whatever the session decision says", async (_what, now) => {
    const f = setup({}, { inPlace: async () => ok({ input: 5, output: 1, cachedInput: 0 }) });
    await expect(f.host.compactNow(target, new AbortController().signal, check({ selectionNow: () => now }))).resolves.toBe("stale");
    expect(f.bookEngineCompact).toHaveBeenCalledTimes(1);
    expect(f.appended).toEqual([]);
    expect(f.task.lastContextModel).toBe("claude:m");
    expect(f.task.usage.context).toEqual({ tokens: 270_000, window: 272_000 });
    expect(f.fold).not.toHaveBeenCalled();
  });

  it("is stale when it was stopped while the engine compacted", async () => {
    const stop = new AbortController();
    const f = setup({}, { inPlace: async () => { stop.abort(); return ok(); } });
    await expect(f.host.compactNow(target, stop.signal, check())).resolves.toBe("stale");
    expect(f.appended).toEqual([]);
  });

  it("still runs Claude Code's compaction on a fork for an engine without an in-place one, and moves its ledger to the fork", async () => {
    const f = setup();
    await expect(f.host.compactNow(target, new AbortController().signal, check())).resolves.toBe("done");
    expect(f.compactCalls).toHaveLength(1);
    expect(f.task.resumeCursors.claude).toBe("fork-session");
    expect(f.task.handedMessages.claude).toMatchObject({ session: "fork-session" });
    expect(f.book).toHaveBeenCalledTimes(1);
    expect(f.task.lastContextModel).toBe("claude:m");
    expect(f.task.usage.context).toEqual({ tokens: 270_000, window: 272_000 });
    const same = setup();
    same.setCompactResult({ ok: true, session: "live-session", sessionBefore: "live-session", input: 1, cacheRead: 1, cacheWrite: 1, output: 1, costUsd: null, model: null });
    await expect(same.host.compactNow(target, new AbortController().signal, check())).resolves.toBe("done");
    expect(same.task.handedMessages.claude).toMatchObject({ session: "live-session", ids: [] });
    const failed = setup();
    failed.setCompactResult({ ok: false, reason: "busy" });
    await expect(failed.host.compactNow(target, new AbortController().signal, check())).resolves.toBe("skipped");
  });

  it("falls back for an engine with no session of its own", async () => {
    const f = setup({}, { native: false });
    f.task.resumeCursors = {};
    await expect(f.host.compactNow(target, new AbortController().signal, check())).resolves.toBe("skipped");
  });

  it("leaves the idle plan of an engine that only compacts in place on OpenMausBot's own fold", async () => {
    const f = setup({}, { native: false, inPlace: async () => ok() });
    f.finishTurn();
    await f.advance(WARM_SUMMARY_IDLE_MS);
    expect(f.fold).toHaveBeenCalledWith(target, expect.any(AbortSignal));
    expect(f.adapter.compactSession).not.toHaveBeenCalled();
  });
});
