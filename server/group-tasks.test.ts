import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

let home: string;

async function freshStore() {
  home = mkdtempSync(join(tmpdir(), "omb-group-tasks-"));
  vi.resetModules();
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  const { Store, UNTITLED_TASK } = await import("./store.ts");
  return { store: new Store(() => ({ instanceId: "claude", model: "m" })), Store, UNTITLED_TASK };
}

afterEach(async () => {
  const { closeMessageDb } = await import("./message-db.ts");
  closeMessageDb();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe("channel tasks", () => {
  it("gives a user-created channel one task while DMs stay single-threaded", async () => {
    const { store, UNTITLED_TASK } = await freshStore();
    const bot = store.createBot();
    const channel = store.createGroup("Product", [bot.id]);
    const dm = store.createGroup("DM", [bot.id], true);

    expect(store.groupTasks(channel.id)).toEqual([
      expect.objectContaining({ threadId: channel.threadId, title: UNTITLED_TASK }),
    ]);
    expect(store.groupTasks(dm.id)).toEqual([]);
    expect(store.createGroupTask(dm.id)).toBeNull();
  });

  it("keeps transcripts, pins, and folders isolated while switching", async () => {
    const { store } = await freshStore();
    const bot = store.createBot();
    const channel = store.createGroup("Product", [bot.id]);
    const first = channel.threadId;
    store.appendMessage(first, { role: "user", kind: "text", text: "Plan launch" });
    store.titleGroupTaskFromFirstMessage(channel.id, "Plan launch", first);
    store.patchGroup(channel.id, { cwd: "/tmp/product" });
    expect(store.pinGroupCwd(channel.id, first)).toBe("/tmp/product");
    store.patchGroup(channel.id, { pinnedMessageId: "launch-pin" });

    const second = store.createGroupTask(channel.id)!;
    expect(second.threadId).not.toBe(first);
    expect(store.group(channel.id)).toMatchObject({ threadId: second.threadId });
    expect(store.group(channel.id)?.pinnedCwd).toBeUndefined();
    expect(store.group(channel.id)?.pinnedMessageId).toBeUndefined();
    expect(store.messagesFor(second.threadId)).toEqual([]);

    store.appendMessage(second.threadId, { role: "user", kind: "text", text: "Audit onboarding" });
    store.titleGroupTaskFromFirstMessage(channel.id, "Audit onboarding", second.threadId);
    store.patchGroup(channel.id, { pinnedMessageId: "audit-pin" });

    expect(store.switchGroupTask(channel.id, first)).toMatchObject({
      threadId: first,
      pinnedCwd: "/tmp/product",
      pinnedMessageId: "launch-pin",
    });
    expect(store.messagesFor(first).some((message) => message.text === "Plan launch")).toBe(true);
    expect(store.groupTaskByThread(channel.id, second.threadId)).toMatchObject({
      title: "Audit onboarding",
      pinnedMessageId: "audit-pin",
    });
    expect(store.groupByThread(second.threadId)?.id).toBe(channel.id);
  });

  it("renames and deletes tasks but never removes the final conversation", async () => {
    const { store } = await freshStore();
    const bot = store.createBot();
    const channel = store.createGroup("Product", [bot.id]);
    const first = channel.threadId;
    const second = store.createGroupTask(channel.id)!;
    store.appendMessage(second.threadId, { role: "user", kind: "text", text: "private branch" });

    expect(store.renameGroupTask(channel.id, second.threadId, "  Research  ")?.title).toBe("Research");
    expect(store.deleteGroupTask(channel.id, second.threadId)).toMatchObject({ threadId: first });
    expect(store.messagesFor(second.threadId)).toEqual([]);
    expect(store.deleteGroupTask(channel.id, first)).toBeNull();
  });

  it("normalizes a supplied task title at the store boundary", async () => {
    const { store } = await freshStore();
    const bot = store.createBot();
    const channel = store.createGroup("Product", [bot.id]);
    const longTitle = "x".repeat(100);

    expect(store.createGroupTask(channel.id, `  ${longTitle}  `)?.title).toBe(longTitle.slice(0, 80));
  });

  it("can create a background task without changing the active conversation", async () => {
    const { store } = await freshStore();
    const bot = store.createBot();
    const channel = store.createGroup("Product", [bot.id]);
    const activeThreadId = channel.threadId;
    store.patchGroup(channel.id, { pinnedMessageId: "active-pin" });

    const background = store.createGroupTask(channel.id, "Daily team goal", false)!;

    expect(background.threadId).not.toBe(activeThreadId);
    expect(store.groupTaskByThread(channel.id, background.threadId)).toEqual(background);
    expect(store.group(channel.id)).toMatchObject({
      threadId: activeThreadId,
      pinnedMessageId: "active-pin",
    });
  });

  it("fails durable working goal cards after a process restart", async () => {
    const { store } = await freshStore();
    const bot = store.createBot();
    const channel = store.createGroup("Product", [bot.id]);
    const background = store.createGroupTask(channel.id, "Scheduled goal", false)!;
    const working = store.appendMessage(background.threadId, {
      role: "bot",
      kind: "goal.run",
      text: "Goal in progress",
      goalRun: {
        runId: "goal-working",
        goal: "Prepare the report",
        status: "working",
        coordinatorBotId: bot.id,
        coordinatorName: bot.name,
        turnCount: 2,
        maxTurns: 12,
        startedAt: 100,
      },
    });
    const settled = store.appendMessage(channel.threadId, {
      role: "bot",
      kind: "goal.run",
      text: "Goal completed",
      goalRun: {
        runId: "goal-complete",
        goal: "Ship the report",
        status: "completed",
        coordinatorBotId: bot.id,
        coordinatorName: bot.name,
        turnCount: 3,
        maxTurns: 12,
        startedAt: 50,
        finishedAt: 90,
      },
    });

    expect(store.reconcileInterruptedGroupGoals(undefined, "Restarted during this goal.", 200)).toBe(1);
    expect(store.messagesFor(background.threadId).find((message) => message.id === working.id)).toMatchObject({
      text: "Goal failed: Restarted during this goal.",
      goalRun: {
        status: "failed",
        detail: "Restarted during this goal.",
        turnCount: 2,
        finishedAt: 200,
      },
    });
    expect(store.messagesFor(channel.threadId).find((message) => message.id === settled.id)?.goalRun?.status)
      .toBe("completed");
  });

  it("keeps a longer turn limit on one conversation and reloads it", async () => {
    const { store, Store } = await freshStore();
    const bot = store.createBot();
    const channel = store.createGroup("Product", [bot.id]);
    const original = channel.threadId;
    const sibling = store.createGroupTask(channel.id)!;
    expect(store.setGroupTaskTurnTimeout(channel.id, original, 30)?.turnTimeoutMinutes).toBe(30);
    expect(store.groupTaskByThread(channel.id, sibling.threadId)?.turnTimeoutMinutes).toBeUndefined();
    const dm = store.createGroup("DM", [bot.id], true);
    expect(store.patchGroup(dm.id, { turnTimeoutMinutes: 30 })?.turnTimeoutMinutes).toBe(30);

    const reloaded = new Store(() => ({ instanceId: "claude", model: "m" }));
    expect(reloaded.groupTaskByThread(channel.id, original)?.turnTimeoutMinutes).toBe(30);
    expect(reloaded.groupTaskByThread(channel.id, sibling.threadId)?.turnTimeoutMinutes).toBeUndefined();
    expect(reloaded.group(dm.id)?.turnTimeoutMinutes).toBe(30);
    expect(reloaded.setGroupTaskTurnTimeout(channel.id, original, null)?.turnTimeoutMinutes).toBeUndefined();
    expect(reloaded.patchGroup(dm.id, { turnTimeoutMinutes: null })?.turnTimeoutMinutes).toBeUndefined();
  });

  it("adopts a legacy channel thread without losing its folder or pin", async () => {
    const { store, Store } = await freshStore();
    const bot = store.createBot();
    const channel = store.createGroup("Legacy", [bot.id]);
    store.appendMessage(channel.threadId, { role: "user", kind: "text", text: "Prepare the report" });
    const legacy = store.group(channel.id)!;
    delete legacy.tasks;
    legacy.pinnedCwd = "/tmp/legacy";
    legacy.pinnedMessageId = "legacy-pin";
    store.patchGroup(channel.id, { name: "Legacy saved" });

    const reloaded = new Store(() => ({ instanceId: "claude", model: "m" }));
    expect(reloaded.groupTasks(channel.id)).toEqual([
      expect.objectContaining({
        threadId: channel.threadId,
        title: "Prepare the report",
        pinnedCwd: "/tmp/legacy",
        pinnedMessageId: "legacy-pin",
      }),
    ]);
  });
});
