import { describe, expect, it } from "vitest";

import { initialState, reducer, type Bot, type Group } from "../state/store";
import type { TaskRecord } from "./taskBoard";

const message = (id: string) => ({
  id,
  role: "user" as const,
  kind: "text" as const,
  text: id,
  at: 1,
  parentId: null,
});

const bot = (id: string, threadId: string): Bot => ({
  id,
  threadId,
  name: id,
  title: "",
  description: "",
  notifications: true,
  color: "green",
  unread: true,
  modelSelection: { instanceId: "test", model: "test" },
  messages: [message(`${id}-message`)],
  activeLeafId: `${id}-message`,
});

const group = (id: string, threadId: string): Group => ({
  id,
  threadId,
  name: id,
  memberIds: [],
  bulletin: "",
  handoffs: "inherit",
  unread: true,
  createdAt: 1,
  messages: [message(`${id}-message`)],
});

describe("threadCleared state", () => {
  it("clears one direct transcript and its active branch", () => {
    const first = bot("first", "thread-1");
    const second = bot("second", "thread-2");
    const state = { ...initialState, bots: [first, second] };

    const next = reducer(state, { type: "threadCleared", threadId: first.threadId });

    expect(next.bots[0]).toMatchObject({ messages: [], activeLeafId: null, unread: false });
    expect(next.bots[1]).toBe(second);
  });

  it("clears one room transcript without changing other rooms", () => {
    const first = group("first", "thread-1");
    const second = group("second", "thread-2");
    const state = { ...initialState, groups: [first, second] };

    const next = reducer(state, { type: "threadCleared", threadId: first.threadId });

    expect(next.groups[0]).toMatchObject({ messages: [], unread: false });
    expect(next.groups[1]).toBe(second);
  });
});

describe("room approval cards", () => {
  it("settles the card in the room transcript", () => {
    const room = group("room", "room-thread");
    room.messages = [{
      id: "approval-message",
      role: "bot",
      kind: "options",
      at: 1,
      from: { botId: "agent", name: "Agent", color: "purple" },
      card: {
        title: "Approval needed",
        subtitle: "Run the preview server?",
        options: ["Allow", "Deny"],
        requestId: "request-one",
      },
    }];
    const state = { ...initialState, bots: [bot("agent", "agent-thread")], groups: [room] };

    const next = reducer(state, {
      type: "answerCard",
      botId: "agent",
      threadId: room.threadId,
      messageId: "approval-message",
      answer: "Allow",
    });

    expect(next.groups[0].messages[0].card?.answered).toBe("Allow");
    expect(next.bots[0]).toBe(state.bots[0]);
  });
});

describe("automatic room handoffs", () => {
  it("folds the persisted room preference without changing its transcript", () => {
    const room = group("room", "room-thread");
    const state = { ...initialState, groups: [room] };

    const next = reducer(state, { type: "groupPatched", group: { id: room.id, handoffs: "off", maxHops: 2, defaultResponderId: "bot-a" } });

    expect(next.groups[0]).toMatchObject({ handoffs: "off", maxHops: 2, defaultResponderId: "bot-a" });
    expect(next.groups[0].messages).toBe(room.messages);
  });
});

describe("shared task board state", () => {
  const task = (revision: number): TaskRecord => ({
    id: "task-one",
    mention: "task-one",
    title: `Task revision ${revision}`,
    description: "",
    acceptanceCriteria: [],
    status: "todo",
    type: "feature",
    priority: "normal",
    tags: [],
    dueAt: null,
    projectId: null,
    assigneeBotId: null,
    position: 1024,
    revision,
    createdAt: 1,
    updatedAt: revision,
    createdBy: { kind: "user" },
    updatedBy: { kind: "user" },
    activity: [],
    project: null,
    assignee: null,
    trelloCardId: null,
    trelloCardUrl: null,
  });

  it("hydrates, folds live updates, and removes deleted tasks", () => {
    const hydrated = reducer(initialState, {
      type: "hydrateTasks",
      tasks: [task(1)],
      projects: [{ id: "p1", name: "One", mention: "one", available: true }],
    });
    expect(hydrated.tasksLoaded).toBe(true);
    const updated = reducer(hydrated, { type: "taskUpserted", task: task(2) });
    expect(updated.tasks).toEqual([task(2)]);
    expect(reducer(updated, { type: "taskDeleted", taskId: "task-one" }).tasks).toEqual([]);
  });

  it("keeps task and project destinations mutually exclusive with chats", () => {
    const openBoard = reducer(initialState, { type: "toggleTaskBoard", open: true });
    expect(openBoard).toMatchObject({ taskBoardOpen: true, projectsOpen: false });
    const openProjects = reducer(openBoard, { type: "toggleProjects", open: true });
    expect(openProjects).toMatchObject({ taskBoardOpen: false, projectsOpen: true });
    const withBot = { ...openProjects, bots: [bot("one", "thread-1")] };
    expect(reducer(withBot, { type: "select", id: "one" })).toMatchObject({ taskBoardOpen: false, projectsOpen: false });
  });
});

describe("dedicated settings page state", () => {
  it("opens settings and closes task board and projects", () => {
    const openBoard = reducer(initialState, { type: "toggleTaskBoard", open: true });
    expect(openBoard).toMatchObject({ taskBoardOpen: true, appSettingsOpen: false });
    const openSettings = reducer(openBoard, { type: "toggleAppSettings", open: true });
    expect(openSettings).toMatchObject({ taskBoardOpen: false, projectsOpen: false, appSettingsOpen: true });
  });

  it("resets appSettingsOpen when selecting a bot or group", () => {
    const withBotAndGroup = {
      ...initialState,
      appSettingsOpen: true,
      bots: [bot("one", "thread-1")],
      groups: [group("room-1", "thread-r1")],
    };
    const selectBot = reducer(withBotAndGroup, { type: "select", id: "one" });
    expect(selectBot).toMatchObject({ appSettingsOpen: false, selectedId: "one" });

    const selectGroup = reducer(withBotAndGroup, { type: "select", id: "room-1" });
    expect(selectGroup).toMatchObject({ appSettingsOpen: false, selectedId: "room-1" });
  });

  it("resets appSettingsOpen when a bot is added", () => {
    const withSettings = { ...initialState, appSettingsOpen: true };
    const newBot = bot("two", "thread-2");
    const afterAdd = reducer(withSettings, { type: "botAdded", bot: newBot });
    expect(afterAdd).toMatchObject({ appSettingsOpen: false, selectedId: "two" });
  });
});

describe("dedicated apps page state", () => {
  it("opens apps and closes task board, settings, and projects", () => {
    const openBoard = reducer(initialState, { type: "toggleTaskBoard", open: true });
    expect(openBoard).toMatchObject({ taskBoardOpen: true, appsOpen: false });
    const openApps = reducer(openBoard, { type: "toggleApps", open: true });
    expect(openApps).toMatchObject({ taskBoardOpen: false, projectsOpen: false, appSettingsOpen: false, appsOpen: true });
  });

  it("resets appsOpen when selecting a bot or group", () => {
    const withBotAndGroup = {
      ...initialState,
      appsOpen: true,
      bots: [bot("one", "thread-1")],
      groups: [group("room-1", "thread-r1")],
    };
    const selectBot = reducer(withBotAndGroup, { type: "select", id: "one" });
    expect(selectBot).toMatchObject({ appsOpen: false, selectedId: "one" });

    const selectGroup = reducer(withBotAndGroup, { type: "select", id: "room-1" });
    expect(selectGroup).toMatchObject({ appsOpen: false, selectedId: "room-1" });
  });

  it("resets appsOpen when a bot is added", () => {
    const withApps = { ...initialState, appsOpen: true };
    const newBot = bot("two", "thread-2");
    const afterAdd = reducer(withApps, { type: "botAdded", bot: newBot });
    expect(afterAdd).toMatchObject({ appsOpen: false, selectedId: "two" });
  });
});


describe("schedule navigation", () => {
  it("keeps the schedule screen separate from chats and opens a prefilled sheet", () => {
    const initial = { ...initialState, bots: [bot("b", "t")] };
    const open = reducer(initial, { type: "toggleSchedules", open: true });
    expect(open.schedulesOpen).toBe(true); expect(open.taskBoardOpen).toBe(false);
    const sheet = reducer(open, { type: "openSchedule", target: { botId: "b" }, prompt: "Saved draft" });
    expect(sheet.scheduleSheet).toMatchObject({ target: { botId: "b" }, prompt: "Saved draft" });
    const selected = reducer(sheet, { type: "select", id: "b" }); expect(selected.schedulesOpen).toBe(false);
    const settings = reducer(open, { type: "toggleSettings", open: true, focusBackup: true });
    expect(settings.schedulesOpen).toBe(false); expect(settings.settingsFocus).toBe("backup");
  });
});
describe("dedicated preview page state", () => {
  it("opens preview and closes task board, settings, apps, and projects", () => {
    const openProjects = reducer(initialState, { type: "toggleProjects", open: true });
    expect(openProjects).toMatchObject({ projectsOpen: true, previewOpen: false });
    const openPreview = reducer(openProjects, { type: "togglePreview", open: true });
    expect(openPreview).toMatchObject({
      previewOpen: true,
      projectsOpen: false,
      taskBoardOpen: false,
      appsOpen: false,
      appSettingsOpen: false,
    });
  });

  it("resets previewOpen when selecting a bot or group", () => {
    const withBotAndGroup = {
      ...initialState,
      previewOpen: true,
      bots: [bot("one", "thread-1")],
      groups: [group("room-1", "thread-r1")],
    };
    expect(reducer(withBotAndGroup, { type: "select", id: "one" })).toMatchObject({
      previewOpen: false,
      selectedId: "one",
    });
    expect(reducer(withBotAndGroup, { type: "select", id: "room-1" })).toMatchObject({
      previewOpen: false,
      selectedId: "room-1",
    });
  });
});




describe("combined schedule and preview navigation", () => {
  it("switches between schedules and preview without leaving both selected", () => {
    const schedules = reducer(initialState, { type: "toggleSchedules", open: true });
    const preview = reducer(schedules, { type: "togglePreview", open: true });
    expect(preview).toMatchObject({ previewOpen: true, schedulesOpen: false });
    expect(reducer(preview, { type: "toggleSchedules", open: true })).toMatchObject({ previewOpen: false, schedulesOpen: true });
  });
});
