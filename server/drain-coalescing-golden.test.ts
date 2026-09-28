// Golden freeze of M2's drain-coalescing rule (the L2 ordering/batching
// layer in admission.ts): a sender's CONTIGUOUS burst inside a short window
// is one drained item; senders never merge; provenance kind is part of the
// sender identity; rooms drain one coalesced item per turn. A failing row
// means the drain batching changed; pair any intentional change with an
// update here so the diff says so out loud.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DRAIN_COALESCE_MAX_ITEMS, DRAIN_COALESCE_WINDOW_MS } from "./admission.ts";
import {
  _queuedCount,
  drainSteeredMessages,
  queueSteeredMessage,
  type SteerStore,
} from "./steer-queue.ts";
import {
  type ChannelQueueItem,
  _queuedChannelCount,
  drainChannelMessages,
  headChannelGroup,
  holdChannelQueue,
  queueChannelMessage,
  settleHeldChannelQueueHead,
} from "./channel-queue.ts";
import type { BotRecord, Message } from "./store.ts";

function fakeBot(id: string, threadId: string, busy: boolean): BotRecord {
  return {
    id,
    threadId,
    name: id,
    title: "",
    description: "",
    notifications: false,
    color: "green",
    unread: false,
    modelSelection: { instanceId: "fake", model: "fake-model" },
    resumeCursors: {},
    busy,
    createdAt: 0,
  };
}

function fakeStore(bots: BotRecord[]): SteerStore & { messages: Message[] } {
  const messages: Message[] = [];
  let nextId = 0;
  return {
    messages,
    bot: (id) => bots.find((b) => b.id === id) ?? null,
    appendMessage: (threadId, message) => {
      const full: Message = { id: `m${(nextId += 1)}-${threadId}`, at: Date.now(), ...message };
      messages.push(full);
      return full;
    },
    patchMessage: (_threadId, messageId, patch) => {
      const at = messages.findIndex((m) => m.id === messageId);
      if (at === -1) return null;
      messages[at] = { ...messages[at], ...patch };
      return messages[at];
    },
  };
}

describe("drain coalescing golden (M2)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-24T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("1:1 joins one sender's contiguous burst into a single follow-up turn", () => {
    const bot = fakeBot("gd-burst", "gd-thread-burst", false);
    const store = fakeStore([bot]);
    const first = queueSteeredMessage(bot.id, bot.threadId, "part one");
    vi.advanceTimersByTime(30_000);
    const second = queueSteeredMessage(bot.id, bot.threadId, "part two");
    vi.advanceTimersByTime(45_000);
    const third = queueSteeredMessage(bot.id, bot.threadId, "part three");
    const run = vi.fn();

    drainSteeredMessages(store, run);
    expect(run).toHaveBeenCalledTimes(1);
    // one turn, blank-line joined, every line under its own queueId
    expect(run.mock.calls[0][2]).toBe("part one\n\npart two\n\npart three");
    expect(store.messages.map((m) => m.queueId)).toEqual([first.id, second.id, third.id]);
    expect(_queuedCount(bot.threadId)).toBe(0);
  });

  it("1:1 splits one sender's items when the gap outgrows the window", () => {
    const bot = fakeBot("gd-window", "gd-thread-window", false);
    const store = fakeStore([bot]);
    queueSteeredMessage(bot.id, bot.threadId, "earlier thought");
    vi.advanceTimersByTime(DRAIN_COALESCE_WINDOW_MS + 1);
    queueSteeredMessage(bot.id, bot.threadId, "later thought");
    const run = vi.fn();

    drainSteeredMessages(store, run);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][2]).toBe("earlier thought");
    expect(_queuedCount(bot.threadId)).toBe(1);

    drainSteeredMessages(store, run);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1][2]).toBe("later thought");
    expect(store.messages.map((m) => m.text)).toEqual(["earlier thought", "later thought"]);
    expect(_queuedCount(bot.threadId)).toBe(0);
  });

  it("1:1 stops merging hours-apart texts into one prompt", () => {
    const bot = fakeBot("gd-hours", "gd-thread-hours", false);
    const store = fakeStore([bot]);
    queueSteeredMessage(bot.id, bot.threadId, "this morning");
    vi.advanceTimersByTime(3 * 60 * 60 * 1000);
    queueSteeredMessage(bot.id, bot.threadId, "this afternoon");
    const run = vi.fn();

    drainSteeredMessages(store, run);
    expect(run.mock.calls[0][2]).toBe("this morning");
    drainSteeredMessages(store, run);
    expect(run.mock.calls[1][2]).toBe("this afternoon");
    // two turns, never the joined prompt of the pre-M2 drain
    expect(run.mock.calls.map((call) => call[2])).toEqual(["this morning", "this afternoon"]);
  });

  it("1:1 never coalesces across senders, and keeps FIFO across groups", () => {
    const bot = fakeBot("gd-senders", "gd-thread-senders", false);
    const store = fakeStore([bot]);
    queueSteeredMessage(bot.id, bot.threadId, "owner first");
    queueSteeredMessage(bot.id, bot.threadId, "priya's note", { sender: { name: "Priya", id: "p_priya" } });
    queueSteeredMessage(bot.id, bot.threadId, "owner second");
    const run = vi.fn();

    drainSteeredMessages(store, run);
    drainSteeredMessages(store, run);
    drainSteeredMessages(store, run);
    expect(run).toHaveBeenCalledTimes(3);
    expect(run.mock.calls.map((call) => call[2])).toEqual(["owner first", "priya's note", "owner second"]);
    // each turn is booked to the line that started it
    expect(run.mock.calls[1][6].sender).toEqual({ name: "Priya", id: "p_priya" });
    expect(run.mock.calls[0][6].sender).toBeUndefined();
    expect(_queuedCount(bot.threadId)).toBe(0);
  });

  it("1:1 person texts never merge with peerAsk or unattended-carrying items", () => {
    const bot = fakeBot("gd-provenance", "gd-thread-provenance", false);
    const store = fakeStore([bot]);
    queueSteeredMessage(bot.id, bot.threadId, "a person's words");
    const peerAsk = { botId: "gd-planner", name: "Planner" };
    queueSteeredMessage(bot.id, bot.threadId, "the planner's own job", { peerAsk, unattended: true, reason: "capacity" });
    const run = vi.fn();

    drainSteeredMessages(store, run);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][2]).toBe("a person's words");
    expect(run.mock.calls[0][5]).toBe(false); // the person's turn stays attended

    drainSteeredMessages(store, run);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1][2]).toBe("the planner's own job");
    expect(run.mock.calls[1][5]).toBe(true); // unattended provenance rides its own turn
    expect(run.mock.calls[1][6].peerAsk).toEqual(peerAsk);
    expect(_queuedCount(bot.threadId)).toBe(0);
  });

  it("rooms drain one sender's contiguous burst as one coalesced item per turn", () => {
    for (let i = 1; i <= 5; i += 1) {
      queueChannelMessage("gd-group-burst", "gd-room-burst", `burst ${i}`);
      vi.advanceTimersByTime(10_000);
    }
    const run = vi.fn();
    drainChannelMessages(() => false, run);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0].items.map((item: { text: string }) => item.text))
      .toEqual(["burst 1", "burst 2", "burst 3", "burst 4", "burst 5"]);
    expect(_queuedChannelCount("gd-room-burst")).toBe(0);
  });

  it("rooms split a sender's burst on window expiry and never merge senders", () => {
    const group = "gd-group-mixed";
    const thread = "gd-room-mixed";
    queueChannelMessage(group, thread, "owner opens");
    queueChannelMessage(group, thread, "priya chimes in", { sender: { name: "Priya", id: "p_priya" } });
    vi.advanceTimersByTime(DRAIN_COALESCE_WINDOW_MS + 1);
    queueChannelMessage(group, thread, "owner resumes after a pause");
    const run = vi.fn();

    drainChannelMessages(() => false, run);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0].items.map((item: { text: string }) => item.text)).toEqual(["owner opens"]);

    drainChannelMessages(() => false, run);
    expect(run.mock.calls[1][0].items.map((item: { text: string }) => item.text)).toEqual(["priya chimes in"]);

    drainChannelMessages(() => false, run);
    expect(run.mock.calls[2][0].items.map((item: { text: string }) => item.text)).toEqual(["owner resumes after a pause"]);
    expect(_queuedChannelCount(thread)).toBe(0);
  });

  it("rooms never merge an API send or a goal send into anyone's burst", () => {
    const group = "gd-group-kinds";
    const thread = "gd-room-kinds";
    queueChannelMessage(group, thread, "typed words");
    queueChannelMessage(group, thread, "programmatic words", { via: "api" });
    queueChannelMessage(group, thread, "a goal", { mode: "goal" });
    const run = vi.fn();

    for (let drains = 0; drains < 3; drains += 1) drainChannelMessages(() => false, run);
    expect(run).toHaveBeenCalledTimes(3);
    expect(run.mock.calls.map((call) => call[0].items.map((item: { text: string }) => item.text)))
      .toEqual([["typed words"], ["programmatic words"], ["a goal"]]);
    expect(_queuedChannelCount(thread)).toBe(0);
  });

  it("a regressed queuedAt never joins the head group", () => {
    const item = (id: string, text: string, queuedAt: number): ChannelQueueItem => ({ id, text, mode: "chat", queuedAt });
    // clock skew or a rewritten row: an earlier timestamp after a later one
    // is not "within the window", so the run stops at the first item
    expect(headChannelGroup([
      item("q-earlier", "typed first", 1_000),
      item("q-regressed", "clock went backwards", 500),
      item("q-next", "typed next", 1_100),
    ]).map((entry) => entry.id)).toEqual(["q-earlier"]);
    // the same items in honest order still coalesce inside the window
    expect(headChannelGroup([
      item("q-earlier", "typed first", 1_000),
      item("q-next", "typed next", 1_100),
    ]).map((entry) => entry.id)).toEqual(["q-earlier", "q-next"]);
  });

  it("rooms cap a head group at the room-context window, leaving the remainder queued", () => {
    const group = "gd-group-cap";
    const thread = "gd-room-cap";
    for (let i = 1; i <= DRAIN_COALESCE_MAX_ITEMS + 2; i += 1) {
      queueChannelMessage(group, thread, `burst ${i}`);
      vi.advanceTimersByTime(1_000);
    }
    const run = vi.fn();
    drainChannelMessages(() => false, run);
    expect(run).toHaveBeenCalledTimes(1);
    // the turn sees the transcript through the context window, so the group
    // never outgrows it: exactly the first window's worth drains now
    expect(run.mock.calls[0][0].items.map((item: { text: string }) => item.text))
      .toEqual(Array.from({ length: DRAIN_COALESCE_MAX_ITEMS }, (_, i) => `burst ${i + 1}`));
    expect(_queuedChannelCount(thread)).toBe(2);

    // the excess keeps its FIFO place and drains as the next turn
    drainChannelMessages(() => false, run);
    expect(run.mock.calls[1][0].items.map((item: { text: string }) => item.text))
      .toEqual([`burst ${DRAIN_COALESCE_MAX_ITEMS + 1}`, `burst ${DRAIN_COALESCE_MAX_ITEMS + 2}`]);
    expect(_queuedChannelCount(thread)).toBe(0);
  });

  it("a room's manual head-steer folds and settles the whole head group as one", () => {
    const group = "gd-group-steer";
    const thread = "gd-room-steer";
    const headOne = queueChannelMessage(group, thread, "head one");
    const headTwo = queueChannelMessage(group, thread, "head two");
    const other = queueChannelMessage(group, thread, "someone else", { sender: { name: "Priya", id: "p_priya" } });

    const held = holdChannelQueue(group, thread, headOne.id)!;
    expect(headChannelGroup(held.items).map((item) => item.id)).toEqual([headOne.id, headTwo.id]);
    // steering the head settles its whole coalesced group; the next sender's
    // item still waits its own turn
    settleHeldChannelQueueHead(held);
    expect(_queuedChannelCount(thread)).toBe(1);
    const run = vi.fn();
    drainChannelMessages(() => false, run);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0].items.map((item: { id: string }) => item.id)).toEqual([other.id]);
  });
});
