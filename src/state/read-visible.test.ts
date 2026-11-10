import { expect, it } from "vitest";
import { markVisibleBotThreadsRead, markVisibleGroupThreadsRead } from "./read-visible";
import type { AppState, BotAnnouncement, Group } from "./store";

it("marks both visible bot threads read while leaving a hidden task unread", () => {
  const bot = { id: "bot", unread: true, tasks: [
    { threadId: "main", unread: true }, { threadId: "fork", unread: true }, { threadId: "hidden", unread: true },
  ] } as unknown as BotAnnouncement;
  const state = { selectedId: "bot", activeView: "chat", bots: [{ id: "bot", threadId: "main" }],
    forkPanel: { kind: "bot", ownerId: "bot", threadId: "fork" } } as unknown as AppState;
  const read: string[] = [];
  markVisibleBotThreadsRead(state, bot, true, (_path, threadId) => read.push(threadId));
  expect(read).toEqual(["main", "fork"]);
  expect(bot.tasks?.map((task) => task.unread)).toEqual([false, false, true]);
  expect(bot.unread).toBe(true);
});

it("marks the main room and its open fork read", () => {
  const group = { id: "room", unread: true, tasks: [
    { threadId: "main", unread: true }, { threadId: "fork", unread: true }, { threadId: "hidden", unread: true },
  ] } as Partial<Group> & { id: string };
  const state = { selectedId: "room", activeView: "chat", groups: [{ id: "room", threadId: "main" }],
    forkPanel: { kind: "group", ownerId: "room", threadId: "fork" } } as unknown as AppState;
  const read: string[] = [];
  markVisibleGroupThreadsRead(state, group, true, (_path, threadId) => read.push(threadId));
  expect(read).toEqual(["main", "fork"]);
  expect(group.tasks?.map((task) => task.unread)).toEqual([false, false, true]);
  expect(group.unread).toBe(true);
});
