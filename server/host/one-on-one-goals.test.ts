// A one-on-one goal's step against fake deps. The chat looks free, yet startTurn keeps refusing the
// turn as busy: the step retries, and once the retries have filled the wait cap the run ends blocked,
// as a busy wait does, instead of spinning forever. A lost race followed by a busy chat shares that one
// cap. A single lost race still retries, and the goal finishes on the done marker.
import { afterEach, describe, expect, it, vi } from "vitest";

import type { HostTurnResult } from "../coordinator.ts";
import { GROUP_GOAL_CONTROL_CLOSE, GROUP_GOAL_CONTROL_OPEN, GROUP_GOAL_MAX_TURNS, GROUP_GOAL_WAIT_MAX_MS, type GoalRunEnd } from "../group-goal-run.ts";
import type { BotRecord, Message, TaskRecord } from "../store.ts";
import type { LiveGoalRun } from "./goal-cards.ts";
import { createGoalTurns, type GoalLeadTurn } from "./goal-turns.ts";
import { createOneOnOneGoals } from "./one-on-one-goals.ts";

// A one-second cap: the real half hour is thousands of retries, each a timer round of its own.
vi.mock("../group-goal-run.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../group-goal-run.ts")>()),
  GROUP_GOAL_WAIT_MAX_MS: 1_000,
}));

const DONE = `${GROUP_GOAL_CONTROL_OPEN}{"status":"completed","detail":"Done."}${GROUP_GOAL_CONTROL_CLOSE}`;
const refused = (code: string) => Object.assign(new Error("this thread is already working"), { code });

/** A goal in a chat whose startTurn is scripted; the real goal-turns hold the lead, so a reply can be filled in. */
function goalChat(startTurn: (call: number, lead: GoalLeadTurn, settle: (outcome: HostTurnResult) => void) => Promise<unknown>, canStart: () => boolean = () => true) {
  const run: LiveGoalRun = {
    runId: "r",
    cardMessageId: "card",
    goal: "Fix the build",
    coordinatorBotId: "b",
    coordinatorName: "Solo",
    turnCount: 0,
    maxTurns: GROUP_GOAL_MAX_TURNS,
    startedAt: 0,
    finished: false,
  };
  const finished: Array<{ status: GoalRunEnd; detail: string }> = [];
  const ends: Array<string | undefined> = [];
  const turns = createGoalTurns({ retireProviderTurn() {} });
  let lead!: GoalLeadTurn;
  let starts = 0;
  let botChanged: ((change: { type: "bot"; botId: string }) => void) | undefined;
  createOneOnOneGoals({
    store: {
      bot: () => ({ id: "b", name: "Solo" } as BotRecord),
      taskByThread: () => ({} as TaskRecord),
      appendMessage: () => ({ id: "m1" } as Message),
      onChange: (listener) => { botChanged = listener as typeof botChanged; return () => {}; },
      titleTaskFromFirstMessage: () => null,
    },
    cards: {
      start: () => run,
      progress: () => {},
      // As the real cards do, keep the first end; the run's own cleanup reports a second one.
      finish: (_threadId, _run, status, detail) => {
        if (run.finished) return;
        run.finished = true;
        finished.push({ status, detail });
      },
    },
    turns: {
      ...turns,
      begin: (threadId) => (lead = turns.begin(threadId)),
      end: (threadId, turn, outcome) => {
        ends.push(outcome);
        turns.end(threadId, turn, outcome);
      },
    },
    canStart,
    isUnattended: () => false,
    startTurn: (_botId, _text, opts) => startTurn(++starts, lead, opts.onSettled),
  }).start("b", "t", "Fix the build");
  // The store's change event for the bot, as the real store fires it when the bot's turn ends.
  return { run, finished, ends, starts: () => starts, botChanged: () => botChanged?.({ type: "bot", botId: "b" }) };
}

describe("a one-on-one goal whose turn keeps losing its slot", () => {
  afterEach(() => vi.useRealTimers());

  it.each(["thread_busy", "thread_limit"])("ends blocked once the %s retries fill the wait cap, instead of retrying forever", async (code) => {
    vi.useFakeTimers();
    const chat = goalChat(() => Promise.reject(refused(code)));
    await vi.advanceTimersByTimeAsync(GROUP_GOAL_WAIT_MAX_MS + 1_000);
    expect(chat.finished).toEqual([
      { status: "blocked", detail: expect.stringMatching(/^Solo stayed busy for \d+ minutes? — send the goal again when they are free\.$/) },
    ]);
    expect(chat.run.turnCount).toBe(0);
    const starts = chat.starts();
    expect(starts).toBeGreaterThan(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(chat.starts()).toBe(starts);
    expect(new Set(chat.ends)).toEqual(new Set(["busy"]));
  });

  it("shares one wait cap between a lost slot and the busy wait after it", async () => {
    vi.useFakeTimers();
    let busy = false;
    const chat = goalChat(() => { busy = true; return Promise.reject(refused("thread_busy")); }, () => !busy);
    // Without one shared cap the busy wait would start its own full cap after the lost slot.
    await vi.advanceTimersByTimeAsync(GROUP_GOAL_WAIT_MAX_MS - 1);
    expect(chat.finished).toEqual([]);
    await vi.advanceTimersByTimeAsync(101);
    expect(chat.finished).toEqual([{ status: "blocked", detail: expect.stringMatching(/^Solo stayed busy/) }]);
    expect(chat.starts()).toBe(1);
    expect(chat.run.turnCount).toBe(0);
  });

  it("starts the turn when the chat frees up just before the shared cap runs out", async () => {
    vi.useFakeTimers();
    let busy = false;
    const chat = goalChat(async (call, lead, settle) => {
      if (call === 1) { busy = true; throw refused("thread_busy"); }
      lead.assistantItems.push(DONE);
      settle({ ok: true, text: "" });
    }, () => !busy);
    await vi.advanceTimersByTimeAsync(GROUP_GOAL_WAIT_MAX_MS - 300);
    busy = false;
    chat.botChanged();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(chat.starts()).toBe(2);
    expect(chat.run.turnCount).toBe(1);
    expect(chat.finished).toEqual([{ status: "completed", detail: "Done." }]);
  });

  it("retries one lost race and finishes on the done marker", async () => {
    vi.useFakeTimers();
    const chat = goalChat(async (call, lead, settle) => {
      if (call === 1) throw refused("thread_busy");
      lead.assistantItems.push(DONE);
      settle({ ok: true, text: "" });
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(chat.starts()).toBe(2);
    expect(chat.run.turnCount).toBe(1);
    expect(chat.finished).toEqual([{ status: "completed", detail: "Done." }]);
  });
});
