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
