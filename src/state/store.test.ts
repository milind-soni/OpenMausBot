import { describe, expect, it, vi } from "vitest";

import {
  configStatusFromFrame,
  initialState,
  openNotificationTarget,
  reducer,
  type Bot,
  type Message,
} from "./store";

describe("notification routing", () => {
  const bots = [{ id: "bot-1", threadId: "main-thread", tasks: [{ threadId: "detached-thread" }] }] as never;
  const groups = [{ id: "room-1", threadId: "room-thread" }] as never;

  it("selects the bot and switches to the notification's exact task", () => {
    const dispatch = vi.fn();

    openNotificationTarget(dispatch, { botId: "bot-1", threadId: "detached-thread" }, { bots, groups });

    expect(dispatch.mock.calls.map(([action]) => action)).toEqual([
      { type: "select", id: "bot-1" },
      { type: "switchTask", botId: "bot-1", threadId: "detached-thread" },
    ]);
  });

  it("opens the room when the thread is a group's — never a bot task switch that would 404", () => {
    // room approval/question notifications carry the asker bot with the
    // GROUP's thread id; the exact destination is the room itself
    const dispatch = vi.fn();

    openNotificationTarget(dispatch, { botId: "bot-1", threadId: "room-thread" }, { bots, groups });

    expect(dispatch.mock.calls.map(([action]) => action)).toEqual([{ type: "select", id: "room-1" }]);
  });

  it("lands on a plain bot select for a thread it cannot place, not an error", () => {
    const dispatch = vi.fn();

    openNotificationTarget(dispatch, { botId: "bot-1", threadId: "deleted-task-thread" }, { bots, groups });

    expect(dispatch.mock.calls.map(([action]) => action)).toEqual([{ type: "select", id: "bot-1" }]);
  });
});

describe("config status frames", () => {
  it("keeps the room turn timeout with the existing config fields", () => {
    expect(
      configStatusFromFrame({
        xai: { configured: true },
        composio: { configured: true, mode: "managed" },
        box: { configured: false },
        vps: { configured: true, sshAlias: "homelab" },
        rooms: { turnTimeoutMinutes: 20 },
        localVm: { mode: "per-bot", maxInstances: 3 },
        opencodeGo: { configured: true },
        tts: { configured: true, ready: true, voice: "Ada" },
        profile: { name: "Ian", email: "ian@example.test" },
      }),
    ).toEqual({
      xai: { configured: true },
      composio: { configured: true, mode: "managed" },
      box: { configured: false },
      vps: { configured: true, sshAlias: "homelab" },
      rooms: { turnTimeoutMinutes: 20 },
      localVm: { mode: "per-bot", maxInstances: 3 },
      opencodeGo: { configured: true },
      tts: { configured: true, ready: true, voice: "Ada" },
      profile: { name: "Ian", email: "ian@example.test" },
    });
  });
});

describe("cross-client bot creation", () => {
  it("adds an announced bot before its greeting frames arrive", () => {
    const announced = {
      id: "phone-bot",
      threadId: "phone-thread",
      name: "Scout",
      title: "",
      description: "",
      notifications: true,
      color: "green",
      unread: false,
      modelSelection: { instanceId: "codex", model: "default" },
    } satisfies Omit<Bot, "messages">;

    const added = reducer(initialState, { type: "botPatched", bot: announced });

    expect(added.bots).toEqual([{ ...announced, messages: [] }]);

    const greeting = {
      id: "greeting",
      role: "bot",
      kind: "text",
      text: "Hey — I'm Scout. Nice to meet you.",
      at: 2,
    } satisfies Message;
    const greeted = reducer(added, {
      type: "messageAdded",
      threadId: announced.threadId,
      message: greeting,
    });

    expect(greeted.bots[0]?.messages).toEqual([greeting]);
  });
});

describe("pending queued chip", () => {
  const bot = {
    id: "b1",
    threadId: "t1",
    name: "Ada",
    title: "",
    description: "",
    notifications: false,
    color: "green",
    unread: false,
    modelSelection: { instanceId: "acp", model: "fake" },
  } satisfies Omit<Bot, "messages">;

  it("records queue-fallback text and drops it when that user line lands", () => {
    const withBot = reducer(initialState, { type: "botPatched", bot });
    const queued = reducer(withBot, {
      type: "pendingQueued",
      threadId: "t1",
      queueId: "q1",
      text: "later",
    });
    expect(queued.pendingQueued).toEqual({ t1: [{ queueId: "q1", text: "later" }] });
    const landed = reducer(queued, {
      type: "consumePendingQueued",
      threadId: "t1",
      queueId: "q1",
    });
    expect(landed.pendingQueued).toEqual({});
  });

  it("keeps a Shift+Enter multiline message as one entry", () => {
    const withBot = reducer(initialState, { type: "botPatched", bot });
    const queued = reducer(withBot, {
      type: "pendingQueued",
      threadId: "t1",
      queueId: "q-ml",
      text: "line one\nline two",
    });
    expect(queued.pendingQueued).toEqual({ t1: [{ queueId: "q-ml", text: "line one\nline two" }] });
    const landed = reducer(queued, {
      type: "consumePendingQueued",
      threadId: "t1",
      queueId: "q-ml",
    });
    expect(landed.pendingQueued).toEqual({});
  });

  it("leaves the chip on the old thread after a task switch", () => {
    const withBot = reducer(initialState, { type: "botPatched", bot });
    const queued = reducer(withBot, {
      type: "pendingQueued",
      threadId: "t1",
      queueId: "q-stay",
      text: "stay here",
    });
    const switched = reducer(queued, {
      type: "botPatched",
      bot: { ...bot, threadId: "t2", messages: [] },
    });
    expect(switched.pendingQueued).toEqual({ t1: [{ queueId: "q-stay", text: "stay here" }] });
    expect(switched.pendingQueued[switched.bots[0]!.threadId]).toBeUndefined();
    const drained = reducer(switched, {
      type: "consumePendingQueued",
      threadId: "t1",
      queueId: "q-stay",
    });
    expect(drained.pendingQueued).toEqual({});
  });

  it("consumes only the matching queue id when two pending lines share text", () => {
    const withBot = reducer(initialState, { type: "botPatched", bot });
    const first = reducer(withBot, {
      type: "pendingQueued",
      threadId: "t1",
      queueId: "qa",
      text: "same",
    });
    const both = reducer(first, {
      type: "pendingQueued",
      threadId: "t1",
      queueId: "qb",
      text: "same",
    });
    expect(both.pendingQueued).toEqual({
      t1: [
        { queueId: "qa", text: "same" },
        { queueId: "qb", text: "same" },
      ],
    });
    const afterOther = reducer(both, {
      type: "consumePendingQueued",
      threadId: "t1",
      queueId: "qa",
    });
    expect(afterOther.pendingQueued).toEqual({ t1: [{ queueId: "qb", text: "same" }] });
  });

  it("does not add a chip when the drain frame arrives before the POST continuation", () => {
    const withBot = reducer(initialState, { type: "botPatched", bot });
    const drained = reducer(withBot, {
      type: "consumePendingQueued",
      threadId: "t1",
      queueId: "q1",
    });
    expect(drained.pendingQueued).toEqual({});
    const late = reducer(drained, {
      type: "pendingQueued",
      threadId: "t1",
      queueId: "q1",
      text: "later",
    });
    expect(late.pendingQueued).toEqual({});
    expect(late.consumedQueueIds).toEqual({});
  });

  it("bounds unmatched queue tombstones from other clients", () => {
    const withBot = reducer(initialState, { type: "botPatched", bot });
    let state = withBot;
    for (let index = 0; index < 100; index += 1) {
      state = reducer(state, {
        type: "consumePendingQueued",
        threadId: "t1",
        queueId: `foreign-${index}`,
      });
    }

    expect(Object.keys(state.consumedQueueIds)).toHaveLength(64);
    expect(state.consumedQueueIds["foreign-0"]).toBeUndefined();
    expect(state.consumedQueueIds["foreign-99"]).toBe(true);

    const late = reducer(state, {
      type: "pendingQueued",
      threadId: "t1",
      queueId: "foreign-99",
      text: "already drained",
    });
    expect(late.pendingQueued).toEqual({});
    expect(late.consumedQueueIds["foreign-99"]).toBeUndefined();
  });
});
