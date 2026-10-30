import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { RegistrySaveError } from "./registry-save.ts";
import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { Store, type BotRecord } from "./store.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });
const locked = () => Object.assign(new Error("EPERM: operation not permitted, rename 'bots.json.tmp' -> 'bots.json'"), { code: "EPERM" });

function failNextSave(store: Store, error: Error = locked()) {
  return vi.spyOn(store as unknown as { saveBots(bots?: BotRecord[]): void }, "saveBots")
    .mockImplementationOnce(() => { throw error; });
}

function storeWithTwoThreads() {
  const store = new Store(selection);
  const bot = store.createBot();
  const first = store.activeTask(bot.id)!;
  store.setResumeCursor(bot.id, "claude", "session-one");
  store.patchTask(bot.id, first.threadId, { pinnedMessageId: "pin-one" });
  const second = store.createTask(bot.id)!;
  store.setResumeCursor(bot.id, "claude", "session-two");
  const changes = vi.fn();
  store.onChange(changes);
  return { store, bot, first, second, changes };
}

describe("bots.json save failures", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("keeps the selected thread, its session and its pin when a switch cannot be saved", () => {
    const { store, bot, first, second, changes } = storeWithTwoThreads();
    failNextSave(store);

    expect(() => store.switchTask(bot.id, first.threadId))
      .toThrow("Couldn't save the thread switch: another program is holding OpenMausBot's bots.json, or its folder is read-only.");
    expect(bot).toMatchObject({ threadId: second.threadId, resumeCursors: { claude: "session-two" } });
    expect(bot.pinnedMessageId).toBeUndefined();
    expect(changes).not.toHaveBeenCalled();
    expect(new Store(selection).bot(bot.id)?.threadId).toBe(second.threadId);

    store.switchTask(bot.id, first.threadId);
    expect(bot).toMatchObject({ threadId: first.threadId, resumeCursors: { claude: "session-one" }, pinnedMessageId: "pin-one" });
    expect(changes).toHaveBeenCalledWith({ type: "bot", botId: bot.id });
    expect(new Store(selection).bot(bot.id)?.threadId).toBe(first.threadId);
  });

  it("does not open a new thread that was never saved", () => {
    const { store, bot, second, changes } = storeWithTwoThreads();
    const tasks = bot.tasks;
    failNextSave(store);

    expect(() => store.createTask(bot.id, "Never saved")).toThrow(RegistrySaveError);
    expect(bot.tasks).toBe(tasks);
    expect(store.tasks(bot.id).map((task) => task.title)).not.toContain("Never saved");
    expect(bot.threadId).toBe(second.threadId);
    expect(changes).not.toHaveBeenCalled();
  });

  it("restores a thread edit, including the bot's unread mark, when it cannot be saved", () => {
    const { store, bot, first } = storeWithTwoThreads();
    failNextSave(store);

    expect(() => store.patchTask(bot.id, first.threadId, { title: "Renamed", unread: true, archivedAt: 1 })).toThrow(RegistrySaveError);
    expect(first).toMatchObject({ unread: false });
    expect(first.title).not.toBe("Renamed");
    expect(first.archivedAt).toBeUndefined();
    expect(bot.unread).toBeFalsy();
  });

  it("keeps a revoked approval live when its save fails, and never applies an unsaved widening", () => {
    const { store, bot, second } = storeWithTwoThreads();
    store.patchTask(bot.id, second.threadId, { approvalMode: "full", autoApprove: false, alwaysAllow: ["tool-a"] });
    failNextSave(store);

    expect(() => store.patchTask(bot.id, second.threadId, { approvalMode: "ask", autoApprove: false, alwaysAllow: [] })).toThrow(RegistrySaveError);
    expect(second).toMatchObject({ approvalMode: "ask", alwaysAllow: [] });
    expect(new Store(selection).taskByThread(bot.id, second.threadId)).toMatchObject({ approvalMode: "full" });

    failNextSave(store);
    expect(() => store.patchTask(bot.id, second.threadId, { approvalMode: "full" })).toThrow(RegistrySaveError);
    expect(second.approvalMode).toBe("ask");
    failNextSave(store);
    expect(() => store.patchTask(bot.id, second.threadId, { alwaysAllow: ["tool-b"] })).toThrow(RegistrySaveError);
    expect(second.alwaysAllow).toEqual([]);
  });

  it("keeps a revocation of permissions a thread inherits from its bot", () => {
    const { store, bot, second } = storeWithTwoThreads();
    store.patchBot(bot.id, { approvalMode: "full", alwaysAllow: ["tool-a", "tool-b"] });
    delete second.approvalMode;
    delete second.autoApprove;
    delete second.alwaysAllow;
    failNextSave(store);

    expect(() => store.patchTask(bot.id, second.threadId, { approvalMode: "auto", alwaysAllow: ["tool-a"] })).toThrow(RegistrySaveError);
    expect(second).toMatchObject({ approvalMode: "auto", alwaysAllow: ["tool-a"] });
    expect(store.projectBotForTask(bot.id, second.threadId)).toMatchObject({ approvalMode: "auto", alwaysAllow: ["tool-a"] });
  });

  it("keeps a thread and its conversation when its deletion cannot be saved, and deletes both on retry", () => {
    const { store, bot, first, second, changes } = storeWithTwoThreads();
    store.appendMessage(second.threadId, { role: "user", kind: "text", text: "Keep this conversation" });
    changes.mockClear();
    failNextSave(store);

    expect(() => store.deleteTasks(bot.id, [second.threadId])).toThrow("Couldn't save the thread deletion");
    expect(store.tasks(bot.id).map((task) => task.threadId)).toEqual([second.threadId, first.threadId]);
    expect(new Store(selection).messagesFor(second.threadId).map((message) => message.text)).toEqual(["Keep this conversation"]);
    expect(bot.threadId).toBe(second.threadId);
    expect(changes).not.toHaveBeenCalled();
    expect(new Store(selection).tasks(bot.id)).toHaveLength(2);

    expect(store.deleteTasks(bot.id, [second.threadId])?.deleted).toEqual([second.threadId]);
    expect(bot.threadId).toBe(first.threadId);
    expect(changes).toHaveBeenCalledWith({ type: "thread.deleted", threadId: second.threadId });
    expect(new Store(selection).tasks(bot.id).map((task) => task.threadId)).toEqual([first.threadId]);
    expect(new Store(selection).messagesFor(second.threadId)).toEqual([]);
  });

  it("keeps what already happened in memory and saves it with the next write", () => {
    const { store, bot, first, second } = storeWithTwoThreads();
    failNextSave(store);

    expect(() => store.setResumeCursor(bot.id, "claude", "session-three"))
      .toThrow("Couldn't save the conversation's engine session: another program is holding OpenMausBot's bots.json, or its folder is read-only.");
    expect(second.resumeCursors.claude).toBe("session-three");
    failNextSave(store);
    expect(() => store.setHandedMessages(bot.id, second.threadId, "claude", { session: "session-three", ids: [] }))
      .toThrow("Couldn't save what this conversation handed its engine");
    expect(second.handedMessages?.claude).toEqual({ session: "session-three", ids: [] });
    failNextSave(store);
    expect(() => store.setTaskAskedAt(bot.id, second.threadId, 1_234)).toThrow("Couldn't save when you last wrote in this thread");
    expect(second.askedAt).toBe(1_234);

    store.patchTask(bot.id, first.threadId, { title: "Next write" });
    const reloaded = new Store(selection).taskByThread(bot.id, second.threadId);
    expect(reloaded?.resumeCursors.claude).toBe("session-three");
    expect(reloaded?.handedMessages?.claude).toEqual({ session: "session-three", ids: [] });
    expect(reloaded?.askedAt).toBe(1_234);
  });

  it("names the unsaved action and keeps the raw error as its cause", () => {
    const fullDisk = new RegistrySaveError("the thread's usage", "bots.json", Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" }));

    expect(fullDisk.message).toBe("Couldn't save the thread's usage: OpenMausBot couldn't write bots.json.");
    expect(fullDisk.cause).toMatchObject({ code: "ENOSPC" });
  });
});

function failNextGroupSave(store: Store) {
  return vi.spyOn(store as unknown as { saveGroups(): void }, "saveGroups")
    .mockImplementationOnce(() => { throw Object.assign(new Error("EPERM: operation not permitted, rename 'groups.json.tmp' -> 'groups.json'"), { code: "EPERM" }); });
}

function roomWithTwoThreads() {
  const store = new Store(selection);
  const room = store.createGroup("Launch team", [store.createBot().id, store.createBot().id]);
  const first = store.activeGroupTask(room.id)!;
  store.patchGroup(room.id, { pinnedMessageId: "pin-one" });
  store.pinGroupCwd(room.id);
  const second = store.createGroupTask(room.id)!;
  const changes = vi.fn();
  store.onChange(changes);
  return { store, room, first, second, changes };
}

describe("groups.json save failures", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("keeps a room on its thread when a switch cannot be saved", () => {
    const { store, room, first, second, changes } = roomWithTwoThreads();
    failNextGroupSave(store);

    expect(() => store.switchGroupTask(room.id, first.threadId))
      .toThrow("Couldn't save the thread switch: another program is holding OpenMausBot's groups.json, or its folder is read-only.");
    expect(room.threadId).toBe(second.threadId);
    expect(room.pinnedMessageId).toBeUndefined();
    expect(room.pinnedCwd).toBeUndefined();
    expect(changes).not.toHaveBeenCalled();
    expect(new Store(selection).group(room.id)?.threadId).toBe(second.threadId);

    store.switchGroupTask(room.id, first.threadId);
    expect(room).toMatchObject({ threadId: first.threadId, pinnedMessageId: "pin-one" });
    expect(changes).toHaveBeenCalledWith({ type: "group", groupId: room.id });
    expect(new Store(selection).group(room.id)?.threadId).toBe(first.threadId);
  });

  it("does not open a room thread that was never saved", () => {
    const { store, room, second, changes } = roomWithTwoThreads();
    const tasks = room.tasks;
    failNextGroupSave(store);

    expect(() => store.createGroupTask(room.id, "Never saved")).toThrow(RegistrySaveError);
    expect(room.tasks).toBe(tasks);
    expect(room.tasks!.map((task) => task.title)).not.toContain("Never saved");
    expect(room.threadId).toBe(second.threadId);
    expect(changes).not.toHaveBeenCalled();
  });

  it("restores a room thread's name, pin, time limit, title and folder when they cannot be saved", () => {
    const { store, room, second, changes } = roomWithTwoThreads();
    const unchanged = structuredClone(second);
    const attempts = [
      () => store.patchGroupTask(room.id, second.threadId, { title: "Renamed" }),
      () => store.patchGroupTask(room.id, second.threadId, { pinned: true }),
      () => store.patchGroupTask(room.id, second.threadId, { turnTimeoutMinutes: 15 }),
      () => store.patchGroupTask(room.id, second.threadId, { title: "Renamed", pinned: true, turnTimeoutMinutes: 15 }),
      () => store.titleGroupTaskFromFirstMessage(room.id, "Plan the launch", second.threadId),
      () => store.pinGroupCwd(room.id, second.threadId),
    ];
    for (const attempt of attempts) {
      failNextGroupSave(store);
      expect(attempt).toThrow(RegistrySaveError);
      expect(second).toEqual(unchanged);
    }
    expect(room.pinnedCwd).toBeUndefined();
    expect(changes).not.toHaveBeenCalled();
    expect(new Store(selection).groupTaskByThread(room.id, second.threadId)).toEqual(unchanged);
  });

  it("does not show a room that was never saved", () => {
    const store = new Store(selection);
    const members = [store.createBot().id, store.createBot().id];
    failNextGroupSave(store);

    expect(() => store.createGroup("Never saved", members)).toThrow("Couldn't save the new room");
    expect(store.groups.map((group) => group.name)).not.toContain("Never saved");
  });

  it("keeps a room and its conversations when its deletion cannot be saved", () => {
    const { store, room, second, changes } = roomWithTwoThreads();
    store.appendMessage(second.threadId, { role: "user", kind: "text", text: "Keep this conversation" });
    changes.mockClear();
    failNextGroupSave(store);

    expect(() => store.deleteGroup(room.id)).toThrow("Couldn't save the room deletion");
    expect(store.group(room.id)).toBe(room);
    expect(changes).not.toHaveBeenCalled();
    expect(store.messagesFor(second.threadId).map((message) => message.text)).toEqual(["Keep this conversation"]);
  });

  it("restores a room's settings and its active thread's pin when they cannot be saved", () => {
    const { store, room, second, changes } = roomWithTwoThreads();
    const unchanged = structuredClone(room);
    failNextGroupSave(store);

    expect(() => store.patchGroup(room.id, { name: "Renamed", bulletin: "Ship it", pinnedMessageId: "pin-two", unread: true }))
      .toThrow("Couldn't save the room's settings: another program is holding OpenMausBot's groups.json, or its folder is read-only.");
    expect(room).toEqual(unchanged);
    expect(second.pinnedMessageId).toBeUndefined();
    expect(changes).not.toHaveBeenCalled();
    expect(new Store(selection).group(room.id)?.name).toBe("Launch team");
  });

  it("clears a finished turn's speaker even when the room cannot be saved", () => {
    const { store, room } = roomWithTwoThreads();
    store.patchGroup(room.id, { busyBotId: room.memberIds[0]! });
    failNextGroupSave(store);

    expect(() => store.patchGroup(room.id, { busyBotId: null, unread: true })).toThrow(RegistrySaveError);
    expect(room.busyBotId).toBeNull();
    expect(room.turnStartedAt).toBeUndefined();
    expect(room.unread).toBe(false);
  });

  it("restores a direct chat's turn limit when it cannot be saved", () => {
    const store = new Store(selection);
    const chat = store.createGroup("", [store.createBot().id, store.createBot().id], true);
    store.patchGroup(chat.id, { turnTimeoutMinutes: 10 });
    failNextGroupSave(store);

    expect(() => store.patchGroup(chat.id, { turnTimeoutMinutes: null })).toThrow("Couldn't save the chat's settings");
    expect(chat.turnTimeoutMinutes).toBe(10);
  });

  it("keeps a room thread and its conversation when its deletion cannot be saved, and deletes both on retry", () => {
    const { store, room, first, second, changes } = roomWithTwoThreads();
    store.appendMessage(second.threadId, { role: "user", kind: "text", text: "Keep this conversation" });
    changes.mockClear();
    failNextGroupSave(store);

    expect(() => store.deleteGroupTasks(room.id, [second.threadId])).toThrow("Couldn't save the thread deletion");
    expect(room.tasks!.map((task) => task.threadId)).toEqual([second.threadId, first.threadId]);
    expect(room.threadId).toBe(second.threadId);
    expect(changes).not.toHaveBeenCalled();
    expect(new Store(selection).messagesFor(second.threadId).map((message) => message.text)).toEqual(["Keep this conversation"]);

    expect(store.deleteGroupTasks(room.id, [second.threadId])?.deleted).toEqual([second.threadId]);
    expect(room).toMatchObject({ threadId: first.threadId, pinnedMessageId: "pin-one" });
    expect(new Store(selection).group(room.id)?.tasks?.map((task) => task.threadId)).toEqual([first.threadId]);
    expect(new Store(selection).messagesFor(second.threadId)).toEqual([]);
  });
});
