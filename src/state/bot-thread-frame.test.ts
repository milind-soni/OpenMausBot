import { describe, expect, it } from "vitest";

import { unreadBeyondFrame, wholeBotFrame } from "./bot-thread-frame";
import { initialState, reducer, type Bot, type BotAnnouncement } from "./store";

const bot: Bot = {
  id: "bot", threadId: "first", name: "Maus", title: "", description: "", notifications: true, color: "green", unread: false,
  modelSelection: { instanceId: "claude", model: "m" }, approvalMode: "ask", alwaysAllow: [], messages: [],
  tasks: [
    { threadId: "first", title: "First", createdAt: 1, activity: "idle", busy: false, unread: false, modelSelection: { instanceId: "claude", model: "m" } },
    { threadId: "second", title: "Second", createdAt: 2, activity: "idle", busy: false, unread: false, modelSelection: { instanceId: "claude", model: "m" } },
    { threadId: "third", title: "Third", createdAt: 3, activity: "idle", busy: false, unread: true, modelSelection: { instanceId: "claude", model: "m" } },
  ],
};
const { messages: _messages, ...settings } = bot;
const frame = (tasks: BotAnnouncement["tasks"], patch: Partial<BotAnnouncement> = {}): BotAnnouncement => ({ ...settings, ...patch, tasks });
const start = () => ({ ...initialState, bots: [bot], selectedId: "other" });

describe("a bot frame that carries only the changed thread", () => {
  it("replaces that thread and keeps every other one, in order", () => {
    const working = { ...bot.tasks![1]!, busy: true, activity: "working" as const, turnStartedAt: 9 };
    const next = reducer(start(), { type: "botPatched", bot: frame([working], { busy: false }), tasksPartial: true });
    expect(next.bots[0]!.tasks!.map((task) => task.threadId)).toEqual(["first", "second", "third"]);
    expect(next.bots[0]!.tasks![1]).toMatchObject({ busy: true, activity: "working", turnStartedAt: 9 });
    expect(next.bots[0]!.tasks![0]).toEqual(bot.tasks![0]);
    expect(next.bots[0]!.tasks![2]).toEqual(bot.tasks![2]);
  });

  it("applies frames for two threads sent back to back, neither undoing the other", () => {
    const first = { ...bot.tasks![0]!, busy: true }, second = { ...bot.tasks![1]!, unread: true };
    let state = reducer(start(), { type: "botPatched", bot: frame([first]), tasksPartial: true });
    state = reducer(state, { type: "botPatched", bot: frame([second], { unread: true }), tasksPartial: true });
    expect(state.bots[0]!.tasks![0]!.busy).toBe(true);
    expect(state.bots[0]!.tasks![1]!.unread).toBe(true);
    expect(state.bots[0]!.unread).toBe(true);
  });

  it("takes the bot's own fields from the frame", () => {
    const next = reducer(start(), { type: "botPatched", bot: frame([], { name: "Renamed", busy: true }), tasksPartial: true });
    expect(next.bots[0]).toMatchObject({ name: "Renamed", busy: true });
    expect(next.bots[0]!.tasks).toHaveLength(3);
  });

  it("is the same as the whole frame it stands for", () => {
    const changed = { ...bot.tasks![2]!, unread: false, title: "Third, renamed" };
    const whole = reducer(start(), { type: "botPatched", bot: frame([bot.tasks![0]!, bot.tasks![1]!, changed]) });
    const partial = reducer(start(), { type: "botPatched", bot: frame([changed]), tasksPartial: true });
    expect(partial.bots).toEqual(whole.bots);
  });

  it("waits for the whole bot when the frame is about one this client does not have", () => {
    const state = { ...initialState, bots: [], selectedId: "" };
    expect(reducer(state, { type: "botPatched", bot: frame([bot.tasks![0]!]), tasksPartial: true })).toBe(state);
  });

  it("without the mark, a frame's threads are the bot's whole list, as before", () => {
    const next = reducer(start(), { type: "botPatched", bot: frame([bot.tasks![0]!]) });
    expect(next.bots[0]!.tasks!.map((task) => task.threadId)).toEqual(["first"]);
  });

  it("adds a carried thread it has not seen after the ones it has", () => {
    const fresh = { ...bot.tasks![0]!, threadId: "fourth", title: "Fourth" };
    expect(wholeBotFrame(bot, frame([fresh])).tasks!.map((task) => task.threadId)).toEqual(["first", "second", "third", "fourth"]);
  });

  it("keeps the bot unread while a thread the frame did not carry is unread", () => {
    const read = { ...bot.tasks![1]!, unread: false };
    expect(unreadBeyondFrame(bot, frame([read]))).toBe(true);
    expect(unreadBeyondFrame({ tasks: bot.tasks!.slice(0, 2) }, frame([read]))).toBe(false);
    expect(unreadBeyondFrame(bot, frame([{ ...bot.tasks![2]!, unread: false }]))).toBe(false);
  });
});
