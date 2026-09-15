// The board's dispatch policy, tested directly now that it is a module
// instead of a closure inside a 15,000-line file: who may take a task, what
// a decline costs (nothing), and what happens when the turn never starts.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const DATA = mkdtempSync(join(tmpdir(), "omb-dispatch-bot-"));
vi.mock("./config.ts", () => ({ DATA_DIR: DATA }));

const board = await import("./task-board.ts");
const { createBotDispatch, boardTaskPrompt } = await import("./task-dispatch-bot.ts");
const { createDispatcher } = await import("./task-dispatcher.ts");
const { createTaskTurnWatch } = await import("./task-turn-watch.ts");

interface TestBot {
  id: string;
  name: string;
  busy?: boolean;
  hidden?: boolean;
  approvalMode?: string;
}

function harness(overrides: Partial<Record<string, unknown>> = {}, bots: TestBot[] = [{ id: "bot-1", name: "Scout" }]) {
  const started: Array<{ botId: string; prompt: string; threadId: string }> = [];
  const audited: Array<{ threadId: string; botId: string; title: string }> = [];
  const logged: string[] = [];
  const calls = {
    started,
    audited,
    logged,
    watch: vi.fn(),
    unwatch: vi.fn(),
    failWatch: vi.fn(),
    onDispatchError: null as ((message: string) => void) | null,
  };
  const dispatch = createBotDispatch<TestBot>({
    boardEnabled: () => true,
    bot: (botId) => bots.find((bot) => bot.id === botId) ?? null,
    approvalMode: (bot) => bot.approvalMode ?? "auto",
    createRunThread: (bot) => ({ threadId: `thread-for-${bot.id}` }),
    startTurn: async (bot, prompt, opts) => {
      calls.onDispatchError = opts.onDispatchError;
      started.push({ botId: bot.id, prompt, threadId: opts.threadId });
    },
    watch: calls.watch,
    unwatch: calls.unwatch,
    failWatch: calls.failWatch,
    audit: (entry) => audited.push(entry),
    redact: (text) => text.replace(/sk-[A-Za-z0-9]+/g, "[redacted]"),
    log: (message) => logged.push(message),
    ...overrides,
  });
  return { dispatch, calls };
}

describe("board dispatch policy", () => {
  beforeEach(() => board.openBoard(join(DATA, `b-${Math.random()}.db`)));

  it("refuses, synchronously and without touching the task, every case the wiring cannot start", () => {
    const bots: TestBot[] = [
      { id: "free", name: "Free" },
      { id: "busy", name: "Busy", busy: true },
      { id: "hidden", name: "Hidden", hidden: true },
      { id: "asks", name: "Asks", approvalMode: "ask" },
    ];
    const { dispatch } = harness({}, bots);
    const task = (assigneeBotId?: string) => board.createTask({ title: "t", assigneeBotId });

    expect(dispatch.canDispatch(task("free"))).toBe(true);
    expect(dispatch.canDispatch(task(undefined))).toBe(false);
    expect(dispatch.canDispatch(task("no-such-bot"))).toBe(false);
    expect(dispatch.canDispatch(task("busy"))).toBe(false);
    expect(dispatch.canDispatch(task("hidden"))).toBe(false);
    expect(dispatch.canDispatch(task("asks"))).toBe(false);
  });

  it("says no while the board flag is off, whatever the assignee looks like", () => {
    const { dispatch } = harness({ boardEnabled: () => false });
    expect(dispatch.canDispatch(board.createTask({ title: "t", assigneeBotId: "bot-1" }))).toBe(false);
  });

  it("starts the turn, arms the watch before it, and audits the decision", async () => {
    const { dispatch, calls } = harness();
    const task = board.createTask({ title: "write the changelog", body: "see PR #1", assigneeBotId: "bot-1" });

    const started = await dispatch.dispatch(task);

    expect(started).toEqual({ threadId: "thread-for-bot-1" });
    expect(calls.watch).toHaveBeenCalledWith(task.id, "thread-for-bot-1", "bot-1");
    expect(calls.started[0].prompt).toBe(boardTaskPrompt(task));
    expect(calls.started[0].prompt).toContain("see PR #1");
    expect(calls.audited).toEqual([
      { threadId: "thread-for-bot-1", botId: "bot-1", botName: "Scout", title: "write the changelog" },
    ]);
  });

  it("settles the task through the watch when the dispatch fails without a completion event", async () => {
    const { dispatch, calls } = harness();
    const task = board.createTask({ title: "doomed", assigneeBotId: "bot-1" });
    await dispatch.dispatch(task);

    // startTurn resolves once setup succeeds; the turn can still fail inside
    // the un-awaited IIFE afterwards, and that path emits no turn.completed.
    calls.onDispatchError?.("provider rejected the key sk-liveSECRET123");

    expect(calls.failWatch).toHaveBeenCalledWith("thread-for-bot-1", "provider rejected the key [redacted]");
  });

  it("disarms the watch and reports nothing started when startTurn throws", async () => {
    const { dispatch, calls } = harness({
      startTurn: async () => {
        throw new Error("this bot is already working — token sk-liveSECRET123");
      },
    });
    const task = board.createTask({ title: "unstartable", assigneeBotId: "bot-1" });

    expect(await dispatch.dispatch(task)).toBeNull();
    expect(calls.unwatch).toHaveBeenCalledWith(task.id);
    expect(calls.audited).toEqual([]);
    expect(calls.logged[0]).toContain("[redacted]");
    expect(calls.logged[0]).not.toContain("sk-liveSECRET123");
  });

  it("declines without starting anything when no thread can be created", async () => {
    const { dispatch, calls } = harness({ createRunThread: () => null });
    const task = board.createTask({ title: "no thread", assigneeBotId: "bot-1" });
    expect(await dispatch.dispatch(task)).toBeNull();
    expect(calls.watch).not.toHaveBeenCalled();
  });

  it("end to end: an unassigned task survives every tick, and an assigned one runs once", async () => {
    // The whole point of finding 1, through the real tick and the real
    // board: the four ticks (~two minutes) that used to take an unassigned
    // task all the way to "blocked" must leave it exactly where it was,
    // while the dispatchable task beside it runs exactly once.
    const { dispatch, calls } = harness();
    const parked = board.createTask({ title: "left for a human" });
    const live = board.createTask({ title: "for the bot", assigneeBotId: "bot-1" });
    const watch = createTaskTurnWatch({ staleAfterMs: 180_000 });
    const dispatcher = createDispatcher({
      canDispatch: dispatch.canDispatch,
      dispatch: dispatch.dispatch,
      maxRunning: 5,
    });

    for (let i = 0; i < 4; i++) await dispatcher.tick();

    const parkedAfter = board.getTask(parked.id);
    expect(parkedAfter?.status).toBe("ready");
    expect(parkedAfter?.attempts).toBe(0);
    const liveAfter = board.getTask(live.id);
    expect(liveAfter?.status).toBe("running");
    expect(liveAfter?.attempts).toBe(1);
    expect(calls.started).toHaveLength(1);
    watch.stopAll();
  });
});

describe("money caps in the dispatch policy (Phase 2 part 1)", () => {
  beforeEach(() => board.openBoard(join(DATA, `cap-${Math.random()}.db`)));

  it("never dispatches a task at its cap, and costs it no attempt", async () => {
    const { dispatch, calls } = harness();
    const task = board.createTask({ title: "capped", assigneeBotId: "bot-1", budgetUsd: 0.01 });
    board.setStatus(task.id, "ready");
    board.claimTask(task.id);
    board.bookSpend(task.id, 0.02);
    const paused = board.getTask(task.id)!;
    expect(paused.status).toBe("blocked");
    expect(dispatch.canDispatch(paused)).toBe(false);
    expect(await dispatch.dispatch(paused)).toBeNull();
    expect(calls.started).toHaveLength(0);
  });

  it("gives a task filed without a cap the unattended default before its first turn", async () => {
    const { dispatch, calls } = harness({ defaultBudgetUsd: () => 0.5 });
    const task = board.createTask({ title: "uncapped", assigneeBotId: "bot-1" });
    board.setStatus(task.id, "ready");
    const claimed = board.claimTask(task.id)!;
    expect(await dispatch.dispatch(claimed)).toEqual({ threadId: "thread-for-bot-1" });
    expect(board.getTask(task.id)?.budgetUsd).toBe(0.5);
    expect(calls.started).toHaveLength(1);
    // an explicit cap is kept, and no default means no cap
    const explicit = board.createTask({ title: "explicit", assigneeBotId: "bot-1", budgetUsd: 0.2 });
    board.setStatus(explicit.id, "ready");
    await dispatch.dispatch(board.claimTask(explicit.id)!);
    expect(board.getTask(explicit.id)?.budgetUsd).toBe(0.2);
  });
});
