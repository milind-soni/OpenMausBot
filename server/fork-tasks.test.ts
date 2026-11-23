import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

let home: string;

async function freshStore() {
  home = mkdtempSync(join(tmpdir(), "omb-fork-tasks-"));
  vi.resetModules();
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  const { Store } = await import("./store.ts");
  return new Store(() => ({ instanceId: "claude", model: "m" }));
}

afterEach(async () => {
  const { closeMessageDb } = await import("./message-db.ts");
  closeMessageDb();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

it("forks a bot conversation at a completed message and keeps it after deleting the source", async () => {
  const store = await freshStore();
  const bot = store.createBot();
  const sourceThreadId = bot.threadId;
  store.appendMessage(sourceThreadId, { role: "user", kind: "text", text: "First question" });
  const answer = store.appendMessage(sourceThreadId, { role: "bot", kind: "text", text: "First answer" });
  const expectedHistory = store.activePath(sourceThreadId).map((message) => [message.id, message.text]);
  store.appendMessage(sourceThreadId, { role: "user", kind: "text", text: "Unrelated follow-up" });

  const fork = store.forkTask(bot.id, sourceThreadId, answer.id);
  expect(fork).toMatchObject({ origin: { threadId: sourceThreadId, messageId: answer.id }, unread: false, lastReadMessageId: answer.id });
  expect(store.bot(bot.id)?.threadId).toBe(sourceThreadId);
  expect(store.activePath(fork!.threadId).map((message) => [message.id, message.text])).toEqual(expectedHistory);

  store.appendMessage(sourceThreadId, { role: "bot", kind: "text", text: "Source changed" });
  store.patchMessage(sourceThreadId, answer.id, { text: "Edited after the fork" });
  expect(store.activePath(fork!.threadId).map((message) => [message.id, message.text])).toEqual(expectedHistory);
  const nested = store.forkTask(bot.id, fork!.threadId, answer.id);
  expect(nested?.origin).toEqual({ threadId: fork!.threadId, messageId: answer.id });
  store.deleteTask(bot.id, sourceThreadId);
  expect(store.taskByThread(bot.id, fork!.threadId)).toBeTruthy();
  expect(store.activePath(fork!.threadId).map((message) => [message.id, message.text])).toEqual(expectedHistory);
  store.appendMessage(fork!.threadId, { role: "user", kind: "text", text: "Independent follow-up" });
  expect(store.activePath(fork!.threadId).at(-1)?.text).toBe("Independent follow-up");
  const { closeMessageDb } = await import("./message-db.ts");
  closeMessageDb();
  const { Store } = await import("./store.ts");
  const reopened = new Store(() => ({ instanceId: "claude", model: "m" }));
  expect(reopened.taskByThread(bot.id, fork!.threadId)?.origin).toEqual({ threadId: sourceThreadId, messageId: answer.id });
  expect(reopened.activePath(fork!.threadId).map((message) => message.text)).toEqual([...expectedHistory.map(([, text]) => text), "Independent follow-up"]);
});

it("forks a room conversation into a normal room task", async () => {
  const store = await freshStore();
  const bot = store.createBot();
  const room = store.createGroup("Review", [bot.id]);
  const sourceThreadId = room.threadId;
  const anchor = store.appendMessage(sourceThreadId, { role: "user", kind: "text", text: "Review this" });
  const reply = store.appendMessage(sourceThreadId, { role: "bot", kind: "text", text: "Review complete" });

  const fork = store.forkGroupTask(room.id, sourceThreadId, anchor.id);
  expect(fork?.origin).toEqual({ threadId: sourceThreadId, messageId: anchor.id });
  expect(fork?.lastReadMessageId).toBe(anchor.id);
  expect(store.group(room.id)?.threadId).toBe(sourceThreadId);
  expect(store.groupTasks(room.id).map((task) => task.threadId)).toContain(fork!.threadId);
  expect(store.activePath(fork!.threadId).map((message) => message.id)).toEqual([anchor.id]);
  const replyFork = store.forkGroupTask(room.id, sourceThreadId, reply.id);
  expect(store.activePath(replyFork!.threadId).map((message) => message.id)).toEqual([anchor.id, reply.id]);
  expect(store.forkGroupTask(room.id, sourceThreadId, "missing")).toBeNull();
  store.deleteGroupTask(room.id, sourceThreadId);
  expect(store.groupTaskByThread(room.id, fork!.threadId)).toBeTruthy();
});

it("uses the newest text on the selected branch for a fork without an explicit message", async () => {
  const store = await freshStore();
  const bot = store.createBot();
  const { threadId } = store.createTask(bot.id)!;
  expect(store.forkTask(bot.id, threadId, undefined)).toBeNull();
  const question = store.appendMessage(threadId, { role: "user", kind: "text", text: "First question" });
  const reply = store.appendMessage(threadId, { role: "bot", kind: "text", text: "First answer" });
  const followUp = store.appendMessage(threadId, { role: "user", kind: "text", text: "Follow up on the first answer" });
  const activity = store.appendMessage(threadId, { role: "bot", kind: "activity" });
  const otherBranch = store.appendMessage(threadId, { role: "bot", kind: "text", text: "Another branch", parentId: question.id });
  const pinned = store.forkTask(bot.id, threadId, undefined, activity.id);
  expect(pinned?.origin).toEqual({ threadId, messageId: followUp.id });
  expect(store.activeLeaf(threadId)).toBe(otherBranch.id);
  expect(store.forkTask(bot.id, threadId, undefined, "unknown-branch")).toBeNull();
  expect(store.setActiveLeaf(threadId, reply.id)).toBe(activity.id);

  const fork = store.forkTask(bot.id, threadId, undefined);
  expect(fork?.origin).toEqual({ threadId, messageId: followUp.id });
  expect(store.activePath(fork!.threadId).map((message) => message.id)).toEqual([question.id, reply.id, followUp.id]);
});

it("keeps a background room fork unread when the shown conversation is read", async () => {
  const store = await freshStore();
  const room = store.createGroup("Review", [store.createBot().id]);
  const anchor = store.appendMessage(room.threadId, { role: "user", kind: "text", text: "Review this" });
  const fork = store.forkGroupTask(room.id, room.threadId, anchor.id)!;
  store.markGroupThreadUnread(room.id, fork.threadId, true);
  expect(store.groupTaskByThread(room.id, fork.threadId)?.unread).toBe(true);
  store.markGroupThreadUnread(room.id, room.threadId, false);
  expect(store.group(room.id)?.unread).toBe(true);
  expect(store.groupTaskByThread(room.id, fork.threadId)?.unread).toBe(true);
  store.markGroupThreadUnread(room.id, fork.threadId, false);
  expect(store.group(room.id)?.unread).toBe(false);
  store.switchGroupTask(room.id, fork.threadId);
  expect(store.group(room.id)?.lastReadMessageId).toBe(anchor.id);
});

it("keeps the source thread's effective permissions without inheriting a pending elevation", async () => {
  const store = await freshStore();
  const bot = store.createBot();
  const anchor = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "Restricted work" });
  store.patchTask(bot.id, bot.threadId, { approvalMode: "custom", autoApprove: false, alwaysAllow: ["provider-tool:example"], outside: true, botApi: true });
  const restricted = store.forkTask(bot.id, bot.threadId, anchor.id)!;
  expect(restricted).toMatchObject({ approvalMode: "custom", autoApprove: false, alwaysAllow: ["provider-tool:example"], outside: true, botApi: true });
  expect(restricted.alwaysAllow).not.toBe(store.taskByThread(bot.id, bot.threadId)?.alwaysAllow);

  store.bot(bot.id)!.approvalGrant = {
    requestId: "pending", mode: "full", phase: "prepared", threadId: bot.threadId, threadOnly: true,
  };
  const pending = store.forkTask(bot.id, bot.threadId, anchor.id)!;
  expect(pending).toMatchObject({ approvalMode: "ask", autoApprove: false });
  expect(store.projectBotForTask(bot.id, pending.threadId)?.approvalGrant).toBeUndefined();
});

it("preserves an explicit no-folder choice when forking a bot conversation", async () => {
  const store = await freshStore();
  const bot = store.createBot();
  const anchor = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "No working folder" });
  store.patchTask(bot.id, bot.threadId, { cwd: null });
  const fork = store.forkTask(bot.id, bot.threadId, anchor.id)!;
  expect(fork.cwd).toBeNull();
  expect(store.taskByThread(bot.id, fork.threadId)?.cwd).toBeNull();
  expect(store.pinTaskCwd(bot.id, fork.threadId, join(home, "available-folder"))).toBeNull();
});

it("carries a person's computer for the conversation into its fork, never an Auto pin", async () => {
  const store = await freshStore();
  const bot = store.createBot();
  const other = store.createTask(bot.id, "Sibling", false)!;
  const anchor = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "Work on the private desktop" });
  store.patchTask(bot.id, bot.threadId, { surface: "vm", surfaceSource: "user" });
  const chosen = store.forkTask(bot.id, bot.threadId, anchor.id)!;
  expect(store.taskByThread(bot.id, chosen.threadId)).toMatchObject({ surface: "vm", surfaceSource: "user" });
  expect(store.taskByThread(bot.id, other.threadId)?.surface).toBeUndefined();
  expect(store.bot(bot.id)?.computer).toBeUndefined();

  store.patchTask(bot.id, bot.threadId, { surface: "local", surfaceSource: undefined });
  expect(store.taskByThread(bot.id, store.forkTask(bot.id, bot.threadId, anchor.id)!.threadId)?.surface).toBe("local");

  store.patchTask(bot.id, bot.threadId, { surface: "cloud", surfaceSource: "auto" });
  const followsBot = store.taskByThread(bot.id, store.forkTask(bot.id, bot.threadId, anchor.id)!.threadId)!;
  expect(followsBot.surface).toBeUndefined();
  expect(followsBot.surfaceSource).toBeUndefined();
  expect(store.createTask(bot.id, "New", false)?.surface).toBeUndefined();
});

it("removes copied history when registering the fork fails", async () => {
  const store = await freshStore();
  const bot = store.createBot();
  const anchor = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "Keep this atomic" });
  const { createBotFork } = await import("./store-forks.ts");
  const { readMessage } = await import("./message-db.ts");
  let importedThreadId = "";
  expect(() => createBotFork(bot, store.activeTask(bot.id)!, store.activePath(bot.threadId), anchor.id,
    { mode: "ask", alwaysAllow: [] }, (task) => {
      importedThreadId = task.threadId;
      throw new Error("registry unavailable");
    })).toThrow("registry unavailable");
  expect(importedThreadId).not.toBe("");
  expect(readMessage(importedThreadId, anchor.id)).toBeNull();
  expect(store.taskByThread(bot.id, importedThreadId)).toBeUndefined();
});
