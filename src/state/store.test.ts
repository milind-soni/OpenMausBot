import { describe, expect, it, vi } from "vitest";

import {
  configStatusFromFrame,
  initialState,
  loadSnapshotBoundary,
  openNotificationTarget,
  persistBotUpdate,
  reducer,
  requestConfirmedBotDeletion,
  visibleNotificationThread,
  type Bot,
  type BotAnnouncement,
  type Group,
  type Message,
} from "./store";
import { openLiveEvents, type LiveEventSourceLike, type LiveEventsPlatform } from "../lib/live-events";
import type { RoutineRun } from "../lib/routines";

describe("trusted approval-mode persistence", () => {
  const announcement = (approvalMode: Bot["approvalMode"] = "ask") => ({
    id: "bot-1",
    threadId: "thread-1",
    name: "Maus",
    title: "Helper",
    description: "",
    notifications: true,
    color: "green" as const,
    unread: false,
    modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
    approvalMode,
  });

  it("commits ordinary edits before granting Full through the private bridge", async () => {
    const order: string[] = [];
    const request = vi.fn(async (_path: string, _init?: RequestInit) => {
      order.push("http");
      return { bot: announcement("ask") };
    });
    const setMode = vi.fn(async () => {
      order.push("private");
      return announcement("full");
    });

    await expect(persistBotUpdate(
      "bot-1",
      { approvalMode: "full", confirmFullAccess: true, title: "Ops" },
      new AbortController().signal,
      request,
      { setMode },
    )).resolves.toMatchObject({ approvalMode: "full" });

    expect(order).toEqual(["http", "private"]);
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toEqual({ title: "Ops" });
    expect(setMode).toHaveBeenCalledWith("bot-1", "full", { acknowledgeLocalAuto: false });
  });

  it("never sends a Full confirmation over HTTP after a rapid switch back to Ask", async () => {
    const request = vi.fn(async (_path: string, _init?: RequestInit) => ({ bot: announcement("ask") }));
    await persistBotUpdate(
      "bot-1",
      { approvalMode: "ask", confirmFullAccess: true },
      new AbortController().signal,
      request,
    );
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toEqual({ approvalMode: "ask" });
  });

  it("fails closed when trusted modes have no packaged desktop bridge", async () => {
    const request = vi.fn(async (_path: string, _init?: RequestInit) => ({ bot: announcement("ask") }));
    await expect(persistBotUpdate(
      "bot-1",
      { approvalMode: "custom" },
      new AbortController().signal,
      request,
      undefined,
    )).rejects.toThrow("packaged desktop app");
    expect(request).not.toHaveBeenCalled();
  });

  it("uses the private bridge to leave Custom instead of the bot-callable HTTP API", async () => {
    const request = vi.fn(async (_path: string, _init?: RequestInit) => ({ bot: announcement("custom") }));
    const setMode = vi.fn(async () => announcement("ask"));

    await expect(persistBotUpdate(
      "bot-1",
      { approvalMode: "ask" },
      new AbortController().signal,
      request,
      { setMode },
      announcement("custom"),
    )).resolves.toMatchObject({ approvalMode: "ask" });

    expect(request).not.toHaveBeenCalled();
    expect(setMode).toHaveBeenCalledWith("bot-1", "ask", { acknowledgeLocalAuto: false });
  });

  it("revokes a trusted mode that completes after its save was cancelled", async () => {
    let finishFull!: (bot: BotAnnouncement) => void;
    const lateFull = new Promise<BotAnnouncement>((resolve) => {
      finishFull = resolve;
    });
    const calls: string[] = [];
    const setMode = vi.fn(async (_botId: string, mode: "ask" | "auto" | "full" | "custom") => {
      calls.push(mode);
      return mode === "full" ? lateFull : announcement(mode);
    });
    const controller = new AbortController();
    const pending = persistBotUpdate(
      "bot-1",
      { approvalMode: "full", confirmFullAccess: true },
      controller.signal,
      vi.fn(),
      { setMode },
      announcement("ask"),
    );
    await Promise.resolve();

    controller.abort();
    finishFull(announcement("full"));

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toEqual(["full", "ask"]);
  });

  it("revokes a late Custom-to-Full grant when a newer save supersedes it", async () => {
    let finishFull!: (bot: BotAnnouncement) => void;
    const lateFull = new Promise<BotAnnouncement>((resolve) => {
      finishFull = resolve;
    });
    const calls: string[] = [];
    const setMode = vi.fn(async (_botId: string, mode: "ask" | "auto" | "full" | "custom") => {
      calls.push(mode);
      return mode === "full" ? lateFull : announcement(mode);
    });
    const controller = new AbortController();
    const pending = persistBotUpdate(
      "bot-1",
      { approvalMode: "full", confirmFullAccess: true },
      controller.signal,
      vi.fn(),
      { setMode },
      announcement("custom"),
    );
    await Promise.resolve();

    controller.abort();
    finishFull(announcement("full"));

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toEqual(["full", "ask"]);
  });

  it("leaves Custom before persisting a coalesced non-Codex model switch", async () => {
    const order: string[] = [];
    const request = vi.fn(async (_path: string, _init?: RequestInit) => {
      order.push("http");
      return {
        bot: {
          ...announcement("ask"),
          modelSelection: { instanceId: "gemini", model: "gemini-3.1-pro" },
        },
      };
    });
    const setMode = vi.fn(async () => {
      order.push("private");
      return announcement("ask");
    });

    await expect(persistBotUpdate(
      "bot-1",
      {
        approvalMode: "ask",
        modelSelection: { instanceId: "gemini", model: "gemini-3.1-pro" },
      },
      new AbortController().signal,
      request,
      { setMode },
      announcement("custom"),
    )).resolves.toMatchObject({
      approvalMode: "ask",
      modelSelection: { instanceId: "gemini", model: "gemini-3.1-pro" },
    });

    expect(order).toEqual(["private", "http"]);
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toEqual({
      modelSelection: { instanceId: "gemini", model: "gemini-3.1-pro" },
    });
    expect(setMode).toHaveBeenCalledWith("bot-1", "ask", { acknowledgeLocalAuto: false });
  });

  it("keeps local-computer consent on an ordinary PATCH coalesced with a private mode", async () => {
    const request = vi.fn(async (_path: string, _init?: RequestInit) => ({
      bot: { ...announcement("auto"), computer: "local" as const },
    }));
    const setMode = vi.fn(async () => announcement("full"));

    await persistBotUpdate(
      "bot-1",
      {
        computer: "local",
        acknowledgeLocalAuto: true,
        approvalMode: "full",
        confirmFullAccess: true,
      },
      new AbortController().signal,
      request,
      { setMode },
      announcement("auto"),
    );

    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toEqual({
      computer: "local",
      acknowledgeLocalAuto: true,
    });
    expect(setMode).toHaveBeenCalledWith("bot-1", "full", { acknowledgeLocalAuto: true });
  });
});

describe("server-authoritative bot deletion", () => {
  const bot = {
    id: "bot-delete",
    threadId: "thread-delete",
    name: "Keeper",
    messages: [],
  } as never as Bot;

  const stateWithQueuedWork = () => reducer(
    reducer(initialState, { type: "botAdded", bot }),
    { type: "pendingQueued", threadId: bot.threadId, queueId: "queued-1", text: "keep this" },
  );

  it.each([409, 503])("keeps the bot, selection, and queued work when DELETE is rejected with %s", async (status) => {
    let state = stateWithQueuedWork();
    const cancel = vi.fn();

    await expect(requestConfirmedBotDeletion(
      bot.id,
      async () => { throw new Error(`${status} computer cleanup required`); },
      (botId) => {
        cancel(botId);
        state = reducer(state, { type: "deleteBot", botId });
      },
    )).rejects.toThrow(String(status));

    expect(cancel).not.toHaveBeenCalled();
    expect(state.selectedId).toBe(bot.id);
    expect(state.bots.map((candidate) => candidate.id)).toContain(bot.id);
    expect(state.pendingQueued[bot.threadId]).toEqual([
      { queueId: "queued-1", text: "keep this" },
    ]);
  });

  it("removes the bot only after DELETE succeeds", async () => {
    let state = stateWithQueuedWork();
    const cancel = vi.fn();
    const requestDelete = vi.fn(async () => ({ ok: true }));

    await requestConfirmedBotDeletion(bot.id, requestDelete, (botId) => {
      cancel(botId);
      state = reducer(state, { type: "deleteBot", botId });
    });

    expect(requestDelete).toHaveBeenCalledWith(bot.id);
    expect(cancel).toHaveBeenCalledWith(bot.id);
    expect(state.bots).toHaveLength(0);
  });

  it("coalesces repeated delete clicks while the server request is pending", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const requestDelete = vi.fn(async () => gate);
    const onConfirmed = vi.fn();

    const first = requestConfirmedBotDeletion(bot.id, requestDelete, onConfirmed);
    const second = requestConfirmedBotDeletion(bot.id, requestDelete, onConfirmed);
    expect(requestDelete).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, second]);

    expect(onConfirmed).toHaveBeenCalledTimes(1);
    expect(onConfirmed).toHaveBeenCalledWith(bot.id);
  });

  it("keeps a visible pending marker until deletion settles or fails", () => {
    const state = stateWithQueuedWork();
    const pending = reducer(state, { type: "botDeletionPending", botId: bot.id, on: true });

    expect(pending.bots.map((candidate) => candidate.id)).toContain(bot.id);
    expect(pending.deletingBots).toEqual({ [bot.id]: true });

    const failed = reducer(pending, { type: "botDeletionPending", botId: bot.id, on: false });
    expect(failed.bots.map((candidate) => candidate.id)).toContain(bot.id);
    expect(failed.deletingBots).toEqual({});

    const removed = reducer(pending, { type: "deleteBot", botId: bot.id });
    expect(removed.bots).toHaveLength(0);
    expect(removed.deletingBots).toEqual({});
  });
});

type SnapshotFrame =
  | { kind: "hello"; resumed: boolean; cursor: string }
  | { kind: "message"; threadId: string; message: { id: string } };

class SnapshotEventSource implements LiveEventSourceLike {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string; lastEventId?: string }) => void) | null = null;
  close = vi.fn();

  constructor(readonly url: string) {}

  message(frame: SnapshotFrame, lastEventId = "") {
    this.onmessage?.({ data: JSON.stringify(frame), lastEventId });
  }
}

describe("replacement snapshot boundary", () => {
  it("flushes bot frames without reconnecting when a peripheral snapshot fails", async () => {
    const sources: SnapshotEventSource[] = [];
    const applied: unknown[] = [];
    const pending: unknown[] = [];
    const scheduleRetry = vi.fn();
    let hydrated = false;
    const platform: LiveEventsPlatform = {
      createEventSource: (url) => {
        const source = new SnapshotEventSource(url);
        sources.push(source);
        return source;
      },
      isOnline: () => true,
      isVisible: () => true,
      now: Date.now,
    };
    const stop = openLiveEvents(
      {
        onSnapshotRequired: async () => {
          const chatReady = await loadSnapshotBoundary(
            async () => {},
            [{ key: "webhooks", load: async () => Promise.reject(new Error("webhooks unavailable")) }],
            (part, error) => scheduleRetry(part.key, error),
          );
          if (chatReady) {
            hydrated = true;
            applied.push(...pending.splice(0));
          }
          return chatReady;
        },
        onFrame: (frame) => {
          if (hydrated) applied.push(frame);
          else pending.push(frame);
        },
        retryMinMs: 1,
        retryMaxMs: 1,
      },
      platform,
    );

    sources[0]!.message({ kind: "hello", resumed: false, cursor: "stream00:4" });
    sources[0]!.message(
      { kind: "message", threadId: "bot-thread", message: { id: "user-1" } },
      "stream00:5",
    );
    await vi.waitFor(() => expect(applied).toHaveLength(1));

    expect(applied).toEqual([
      { kind: "message", threadId: "bot-thread", message: { id: "user-1" } },
    ]);
    expect(scheduleRetry).toHaveBeenCalledWith("webhooks", expect.any(Error));
    expect(sources).toHaveLength(1);
    expect(sources[0]!.close).not.toHaveBeenCalled();
    stop();
  });
});

describe("notification routing", () => {
  const bots = [{ id: "bot-1", threadId: "main-thread", tasks: [{ threadId: "detached-thread" }] }];
  const groups = [{
    id: "room-1",
    threadId: "room-thread",
    tasks: [
      { threadId: "room-thread", title: "Current", createdAt: 1 },
      { threadId: "older-room-thread", title: "Older", createdAt: 0 },
    ],
  }];

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

  it("opens the room and restores the exact inactive channel task", () => {
    const dispatch = vi.fn();

    openNotificationTarget(dispatch, { botId: "bot-1", threadId: "older-room-thread" }, { bots, groups });

    expect(dispatch.mock.calls.map(([action]) => action)).toEqual([
      { type: "select", id: "room-1" },
      { type: "switchGroupTask", groupId: "room-1", threadId: "older-room-thread" },
    ]);
  });

  it("lands on a plain bot select for a thread it cannot place, not an error", () => {
    const dispatch = vi.fn();

    openNotificationTarget(dispatch, { botId: "bot-1", threadId: "deleted-task-thread" }, { bots, groups });

    expect(dispatch.mock.calls.map(([action]) => action)).toEqual([{ type: "select", id: "bot-1" }]);
  });

  it("identifies only the exact chat thread currently on screen", () => {
    expect(visibleNotificationThread({
      activeView: "chat",
      selectedId: "bot-1",
      bots,
      groups,
    })).toBe("main-thread");
    expect(visibleNotificationThread({
      activeView: "chat",
      selectedId: "room-1",
      bots,
      groups,
    })).toBe("room-thread");
    expect(visibleNotificationThread({
      activeView: "routines",
      selectedId: "bot-1",
      bots,
      groups,
    })).toBeNull();
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
        features: { skillRecorder: true },
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
      features: { skillRecorder: true },
    });
  });
});

describe("task rename", () => {
  it("updates the task title in local state immediately", () => {
    const bot = {
      id: "echo",
      threadId: "t1",
      name: "Echo",
      title: "",
      description: "",
      notifications: true,
      color: "green",
      unread: false,
      modelSelection: { instanceId: "x", model: "y" },
      messages: [],
      tasks: [
        { threadId: "t1", title: "New task", createdAt: 1 },
        { threadId: "t2", title: "Other", createdAt: 2 },
      ],
    } satisfies Bot;
    const next = reducer(
      { ...initialState, bots: [bot] },
      { type: "renameTask", botId: bot.id, threadId: "t1", title: "Renamed" },
    );
    expect(next.bots[0]?.tasks?.find((task) => task.threadId === "t1")?.title).toBe("Renamed");
    expect(next.bots[0]?.tasks?.find((task) => task.threadId === "t2")?.title).toBe("Other");
  });

  it("updates a channel task title in local state immediately", () => {
    const group = {
      id: "room",
      threadId: "room-task-1",
      name: "Launch",
      memberIds: [],
      defaultResponder: { kind: "everyone" },
      bulletin: "",
      unread: false,
      createdAt: 1,
      messages: [],
      tasks: [
        { threadId: "room-task-1", title: "New task", createdAt: 1 },
        { threadId: "room-task-2", title: "Other", createdAt: 2 },
      ],
    } satisfies Group;
    const next = reducer(
      { ...initialState, groups: [group] },
      { type: "renameGroupTask", groupId: group.id, threadId: "room-task-1", title: "Renamed" },
    );
    expect(next.groups[0]?.tasks?.find((task) => task.threadId === "room-task-1")?.title).toBe("Renamed");
    expect(next.groups[0]?.tasks?.find((task) => task.threadId === "room-task-2")?.title).toBe("Other");
  });
});

describe("Teach a skill feature flag", () => {
  const config = configStatusFromFrame({
    composio: { configured: false },
    box: { configured: false },
    vps: { configured: false, sshAlias: "" },
    rooms: { turnTimeoutMinutes: 5 },
    localVm: { mode: "shared", maxInstances: 2 },
    features: { skillRecorder: true },
  });

  it("does not open the recorder while the experiment is disabled", () => {
    expect(reducer(initialState, { type: "showSkillRecorder" }).activeView).toBe("chat");
  });

  it("opens after opt-in and returns to chat when disabled", () => {
    const enabled = reducer({ ...initialState, config }, { type: "showSkillRecorder" });
    expect(enabled.activeView).toBe("skill-recorder");

    const disabled = reducer(enabled, {
      type: "configStatus",
      config: { ...config, features: { skillRecorder: false } },
    });
    expect(disabled.activeView).toBe("chat");
  });
});

describe("onboarding quiz", () => {
  const quizCard = {
    title: "What do you mostly want help with?",
    subtitle: "Pick whatever's closest; we can always expand from there.",
    options: ["Work & projects"],
  };
  const bot = {
    id: "echo",
    threadId: "t1",
    name: "Echo",
    title: "",
    description: "",
    notifications: true,
    color: "green",
    unread: false,
    modelSelection: { instanceId: "x", model: "y" },
    messages: [
      { id: "g", role: "bot", kind: "text", text: "Hey", at: 1 },
      { id: "q", role: "bot", kind: "options", card: quizCard, at: 2 },
    ],
    activeLeafId: "q",
  } satisfies Bot;

  it("hides the quiz as soon as the person sends a message", () => {
    const state = { ...initialState, bots: [bot], selectedId: bot.id };
    const next = reducer(state, { type: "send", botId: bot.id, text: "Hi bro" });
    expect(next.bots[0]?.messages.find((message) => message.id === "q")?.card?.dismissed).toBe(true);
  });

  it("hides the quiz when they pick an option", () => {
    const state = { ...initialState, bots: [bot], selectedId: bot.id };
    const next = reducer(state, { type: "answerCard", botId: bot.id, messageId: "q", answer: "Work & projects" });
    expect(next.bots[0]?.messages.find((message) => message.id === "q")?.card).toMatchObject({
      answered: "Work & projects",
      dismissed: true,
    });
  });

  it("leaves a live permission card in place", () => {
    const askBot: Bot = {
      ...bot,
      messages: [
        ...bot.messages,
        {
          id: "ask",
          role: "bot",
          kind: "options",
          card: {
            title: "Approval needed",
            subtitle: "rm",
            options: ["Allow", "Deny"],
            requestId: "r1",
            tool: "Bash",
          },
          at: 3,
        },
      ],
      activeLeafId: "ask",
    };
    const state = { ...initialState, bots: [askBot], selectedId: askBot.id };
    const next = reducer(state, { type: "send", botId: askBot.id, text: "ok" });
    expect(next.bots[0]?.messages.find((message) => message.id === "ask")?.card?.dismissed).toBeUndefined();
    expect(next.bots[0]?.messages.find((message) => message.id === "q")?.card?.dismissed).toBe(true);
  });
});

describe("optimistic sent messages", () => {
  const root: Message = { id: "root", role: "bot", kind: "text", text: "Ready", at: 1 };
  const bot: Bot = {
    id: "preview-bot",
    threadId: "preview-thread",
    name: "Preview",
    title: "",
    description: "",
    notifications: true,
    color: "purple",
    unread: false,
    modelSelection: { instanceId: "claude", model: "default" },
    messages: [root],
    activeLeafId: root.id,
  };

  it("shows a direct send immediately and replaces it with the canonical server message", () => {
    const sent = reducer(
      { ...initialState, bots: [bot] },
      {
        type: "send",
        botId: bot.id,
        threadId: bot.threadId,
        sendId: "send-preview",
        text: "look\n\n<attached-image path=\"/private/photo.png\" />",
      },
    );
    expect(sent.bots[0]?.messages.at(-1)).toMatchObject({
      id: "optimistic-send-preview",
      role: "user",
      sendId: "send-preview",
    });
    expect(sent.bots[0]?.activeLeafId).toBe("optimistic-send-preview");

    const canonical: Message = {
      id: "server-message",
      role: "user",
      kind: "text",
      text: "look\n\n<attached-image path=\"/private/photo.png\" />",
      at: 2,
      parentId: root.id,
      sendId: "send-preview",
    };
    const reconciled = reducer(sent, {
      type: "messageAdded",
      threadId: bot.threadId,
      message: canonical,
    });
    expect(reconciled.bots[0]?.messages).toEqual([root, canonical]);
    expect(reconciled.bots[0]?.activeLeafId).toBe(canonical.id);
  });

  it("removes only the optimistic row when a send queues or fails", () => {
    const sent = reducer(
      { ...initialState, bots: [bot] },
      { type: "send", botId: bot.id, sendId: "send-failed", text: "later" },
    );
    const removed = reducer(sent, {
      type: "optimisticMessageRemoved",
      threadId: bot.threadId,
      sendId: "send-failed",
    });
    expect(removed.bots[0]?.messages).toEqual([root]);
    expect(removed.bots[0]?.activeLeafId).toBe(root.id);
  });

  it("uses the same immediate reconciliation for a channel", () => {
    const group: Group = {
      id: "preview-room",
      threadId: "preview-room-thread",
      name: "Preview room",
      memberIds: [bot.id],
      defaultResponder: { kind: "member", botId: bot.id },
      bulletin: "",
      unread: false,
      createdAt: 1,
      messages: [],
    };
    const sent = reducer(
      { ...initialState, groups: [group] },
      {
        type: "sendGroup",
        groupId: group.id,
        threadId: group.threadId,
        sendId: "room-preview",
        text: "show this",
        mode: "chat",
      },
    );
    expect(sent.groups[0]?.messages).toEqual([
      expect.objectContaining({ id: "optimistic-room-preview", sendId: "room-preview" }),
    ]);

    const canonical: Message = {
      id: "server-room-message",
      role: "user",
      kind: "text",
      text: "show this",
      at: 2,
      sendId: "room-preview",
    };
    const reconciled = reducer(sent, {
      type: "messageAdded",
      threadId: group.threadId,
      message: canonical,
    });
    expect(reconciled.groups[0]?.messages).toEqual([canonical]);
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

describe("routine receipt retention", () => {
  const run = (id: string, scheduledFor: number, status: RoutineRun["status"]): RoutineRun => ({
    id,
    routineId: "routine",
    routineName: "Check inbox",
    target: "bot",
    botId: "echo",
    runOn: "maus",
    scheduledFor,
    status,
    manual: false,
    createdAt: scheduledFor,
  });

  it("trims finished history without hiding older active work", () => {
    const waiting = run("waiting", 0, "waiting");
    const history = Array.from({ length: 2_000 }, (_, index) =>
      run(`finished-${index}`, index + 1, "completed"),
    );

    const hydrated = reducer(initialState, {
      type: "routinesHydrated",
      routines: [],
      runs: [waiting, ...history],
    });
    expect(hydrated.routineRuns).toHaveLength(2_000);
    expect(hydrated.routineRuns).toContainEqual(waiting);

    const running = { ...waiting, status: "running" as const, startedAt: 2_000 };
    const activePatched = reducer(hydrated, {
      type: "routineRunPatched",
      run: running,
    });
    expect(activePatched.routineRuns).toContainEqual(running);

    const next = reducer(activePatched, {
      type: "routineRunPatched",
      run: run("newest", 2_001, "completed"),
    });
    expect(next.routineRuns).toHaveLength(2_000);
    expect(next.routineRuns).toContainEqual(running);
    expect(next.routineRuns[0]?.id).toBe("newest");
  });
});

describe("canonical message races", () => {
  it("does not rewind the active branch when POST repeats a user message after the reply", () => {
    const sent = {
      id: "sent",
      role: "user",
      kind: "text",
      text: "Ship it",
      at: 1,
      parentId: null,
    } satisfies Message;
    const reply = {
      id: "reply",
      role: "bot",
      kind: "text",
      text: "Done",
      at: 2,
      parentId: sent.id,
    } satisfies Message;
    const bot = {
      id: "race-bot",
      threadId: "race-thread",
      name: "Race",
      title: "",
      description: "",
      notifications: true,
      color: "green",
      unread: false,
      modelSelection: { instanceId: "codex", model: "default" },
      messages: [sent, reply],
      activeLeafId: reply.id,
    } satisfies Bot;
    const state = { ...initialState, bots: [bot] };

    const next = reducer(state, {
      type: "messageAdded",
      threadId: bot.threadId,
      message: sent,
    });

    expect(next).toBe(state);
    expect(next.bots[0]?.activeLeafId).toBe(reply.id);
    expect(next.bots[0]?.messages).toEqual([sent, reply]);
  });
});

describe("section Chiefs", () => {
  const bot = (id: string, section: string, chiefOfStaff = false) => ({
    id,
    threadId: `thread-${id}`,
    name: id,
    title: "",
    description: "",
    notifications: true,
    color: "green" as const,
    unread: false,
    modelSelection: { instanceId: "codex", model: "default" },
    section,
    chiefOfStaff,
  });

  it("hands off only within the patched bot's section", () => {
    const workChief = bot("work-a", "Work", true);
    const workCandidate = bot("work-b", "Work");
    const personalChief = bot("personal", "Personal", true);
    const state = {
      ...initialState,
      bots: [workChief, workCandidate, personalChief].map((candidate) => ({ ...candidate, messages: [] })),
    };

    const next = reducer(state, {
      type: "botPatched",
      bot: { ...workCandidate, chiefOfStaff: true },
    });

    expect(next.bots.find((candidate) => candidate.id === workChief.id)?.chiefOfStaff).toBe(false);
    expect(next.bots.find((candidate) => candidate.id === workCandidate.id)?.chiefOfStaff).toBe(true);
    expect(next.bots.find((candidate) => candidate.id === personalChief.id)?.chiefOfStaff).toBe(true);
  });

  it("keeps other section Chiefs during an optimistic settings update", () => {
    const workChief = bot("work-a", "Work", true);
    const workCandidate = bot("work-b", "Work");
    const personalChief = bot("personal", "Personal", true);
    const state = {
      ...initialState,
      bots: [workChief, workCandidate, personalChief].map((candidate) => ({ ...candidate, messages: [] })),
    };

    const next = reducer(state, {
      type: "updateBot",
      botId: workCandidate.id,
      patch: { chiefOfStaff: true },
    });

    expect(next.bots.find((candidate) => candidate.id === workChief.id)?.chiefOfStaff).toBe(false);
    expect(next.bots.find((candidate) => candidate.id === workCandidate.id)?.chiefOfStaff).toBe(true);
    expect(next.bots.find((candidate) => candidate.id === personalChief.id)?.chiefOfStaff).toBe(true);
  });

  it("optimistically clears an explicit computer when Auto is selected", () => {
    const current = { ...bot("cloud-bot", "Work"), computer: "cloud" as const, messages: [] };
    const next = reducer({ ...initialState, bots: [current] }, {
      type: "updateBot",
      botId: current.id,
      patch: { computer: null },
    });

    expect(next.bots[0]?.computer).toBeUndefined();
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

  it("starts mascot work motion when the queued line is released into the transcript", () => {
    const withBot = reducer(initialState, { type: "botPatched", bot });
    const landed = reducer(withBot, {
      type: "messageAdded",
      threadId: "t1",
      message: {
        id: "landed",
        at: 2,
        role: "user",
        kind: "text",
        text: "now run this",
        queueId: "q-landed",
      },
    });

    expect(landed.mascotMotion).toMatchObject({ botId: "b1", kind: "working" });
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

  it("reconciles a missed drain from hydration and rejects its late POST continuation", () => {
    const withBot = reducer(initialState, { type: "botPatched", bot });
    const queued = reducer(withBot, {
      type: "pendingQueued",
      threadId: "t1",
      queueId: "q-snapshot",
      text: "already ran",
    });
    const canonical = {
      id: "m-snapshot",
      at: 100,
      role: "user",
      kind: "text",
      text: "already ran",
      queueId: "q-snapshot",
    } satisfies Message;
    const hydrated = reducer(queued, {
      type: "hydrate",
      bots: [{ ...bot, messages: [canonical] }],
      groups: [],
      computerControl: {},
    });

    expect(hydrated.pendingQueued).toEqual({});
    expect(hydrated.consumedQueueIds["q-snapshot"]).toBe(true);
    const late = reducer(hydrated, {
      type: "pendingQueued",
      threadId: "t1",
      queueId: "q-snapshot",
      text: "already ran",
    });
    expect(late.pendingQueued).toEqual({});
    expect(late.consumedQueueIds["q-snapshot"]).toBeUndefined();
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

  it("drops a cancelled pending chip without waiting for drain", () => {
    const withBot = reducer(initialState, { type: "botPatched", bot });
    const queued = reducer(withBot, {
      type: "pendingQueued",
      threadId: "t1",
      queueId: "q-drop",
      text: "never mind",
    });
    const cancelled = reducer(queued, {
      type: "cancelQueued",
      botId: "b1",
      queueId: "q-drop",
    });
    expect(cancelled.pendingQueued).toEqual({});
  });

  it("drops a cancelled channel follow-up from its original task", () => {
    const queued = reducer(initialState, {
      type: "pendingQueued",
      threadId: "room-task-1",
      queueId: "q-room-drop",
      text: "never mind",
    });
    const cancelled = reducer(queued, {
      type: "cancelGroupQueued",
      groupId: "room-1",
      threadId: "room-task-1",
      queueId: "q-room-drop",
    });
    expect(cancelled.pendingQueued).toEqual({});
  });
});

describe("messageAdded leaf adoption", () => {
  const baseBot = {
    id: "bot-1",
    threadId: "thread-1",
    messages: [
      { id: "m1", at: 1, role: "bot", kind: "text", text: "turn done" },
      { id: "m2", at: 2, parentId: "m1", role: "user", kind: "text", text: "next question" },
    ],
    activeLeafId: "m2",
  } as never as Bot;
  const state = { ...initialState, bots: [baseBot] };

  it("adopts the leaf for a message chaining onto it", () => {
    const next = reducer(state, {
      type: "messageAdded",
      threadId: "thread-1",
      message: { id: "m3", at: 3, parentId: "m2", role: "bot", kind: "text", text: "reply" } as never as Message,
    });
    expect(next.bots[0].activeLeafId).toBe("m3");
  });

  it("keeps the leaf when a late artifact is chain-inserted mid-branch", () => {
    // the settle-time screenshot arrives parented to m1 while m2 is the leaf
    const next = reducer(state, {
      type: "messageAdded",
      threadId: "thread-1",
      message: { id: "shot", at: 3, parentId: "m1", role: "bot", kind: "screen", png: "x" } as never as Message,
    });
    expect(next.bots[0].activeLeafId).toBe("m2"); // the user's message stays the tail
    expect(next.bots[0].messages.map((m) => m.id)).toContain("shot");
  });
});

describe("bot settings section", () => {
  const bot = {
    id: "test-bot",
    threadId: "test-thread",
    name: "Test",
    title: "",
    description: "",
    notifications: true,
    color: "green",
    unread: false,
    modelSelection: { instanceId: "x", model: "y" },
    messages: [],
  } as never as Bot;

  it("toggleSettings with a section sets it and opens", () => {
    const next = reducer(initialState, {
      type: "toggleSettings",
      open: true,
      section: "identity",
    });
    expect(next.settingsOpen).toBe(true);
    expect(next.botSettingsSection).toBe("identity");
  });

  it("toggleSettings leaves the computer panel and inspector open, closes app settings", () => {
    const withPanels = { ...initialState, computerOpen: true, inspectorOpen: true, appSettingsOpen: true };
    const next = reducer(withPanels, { type: "toggleSettings", open: true });
    expect(next.settingsOpen).toBe(true);
    expect(next.computerOpen).toBe(true);
    expect(next.inspectorOpen).toBe(true);
    expect(next.appSettingsOpen).toBe(false);
  });

  it("toggleSettings without a section keeps it", () => {
    const state = reducer(initialState, {
      type: "toggleSettings",
      open: true,
      section: "soul",
    });
    const next = reducer(state, {
      type: "toggleSettings",
      open: true,
    });
    expect(next.botSettingsSection).toBe("soul");
  });

  it("selecting a different bot resets botSettingsSection to overview", () => {
    // Add bot A and select it
    let state = reducer(initialState, {
      type: "botAdded",
      bot: { ...bot, id: "bot-a", threadId: "thread-a" },
    });
    // Add bot B (becomes selected automatically)
    state = reducer(state, {
      type: "botAdded",
      bot: { ...bot, id: "bot-b", threadId: "thread-b" },
    });
    expect(state.selectedId).toBe("bot-b");

    // Set section to "identity" while bot-b is selected
    state = reducer(state, {
      type: "toggleSettings",
      open: true,
      section: "identity",
    });
    expect(state.botSettingsSection).toBe("identity");

    // Select bot A → should reset to "overview" because we're changing bots
    const next = reducer(state, {
      type: "select",
      id: "bot-a",
    });
    expect(next.botSettingsSection).toBe("overview");
  });

  it("re-selecting the same bot keeps botSettingsSection, but selecting a different bot resets it", () => {
    // Add bot A (becomes selected)
    let state = reducer(initialState, {
      type: "botAdded",
      bot: { ...bot, id: "bot-a", threadId: "thread-a" },
    });
    expect(state.selectedId).toBe("bot-a");

    // Open settings with section "soul"
    state = reducer(state, {
      type: "toggleSettings",
      open: true,
      section: "soul",
    });
    expect(state.botSettingsSection).toBe("soul");

    // Re-select bot A (same bot) → section should stay "soul"
    state = reducer(state, {
      type: "select",
      id: "bot-a",
    });
    expect(state.botSettingsSection).toBe("soul");

    // Add bot B (becomes selected)
    state = reducer(state, {
      type: "botAdded",
      bot: { ...bot, id: "bot-b", threadId: "thread-b" },
    });
    expect(state.selectedId).toBe("bot-b");

    // Select bot A again → should reset to "overview" because we're changing from bot-b to bot-a
    state = reducer(state, {
      type: "select",
      id: "bot-a",
    });
    expect(state.botSettingsSection).toBe("overview");
  });
});
