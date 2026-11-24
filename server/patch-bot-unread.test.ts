import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

let home: string | undefined;

async function freshStore() {
  home = mkdtempSync(join(tmpdir(), "omb-patch-bot-unread-"));
  vi.resetModules();
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  const { Store } = await import("./store.ts");
  return { store: new Store(() => ({ instanceId: "claude", model: "m" })) };
}

afterEach(async () => {
  if (!home) return;
  const { closeMessageDb } = await import("./message-db.ts");
  closeMessageDb();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
  home = undefined;
});

describe("patchBot unread targeting", () => {
  it("marks the open main conversation unread when activeTask is a routine run, without dirtying the routine run", async () => {
    const { store } = await freshStore();
    const bot = store.createBot();
    const openThreadId = bot.threadId;
    const routine = store.createTask(bot.id, "Daily check", true)!;
    store.patchTask(bot.id, routine.threadId, { routineRunId: "run-1", unread: false });
    expect(store.bot(bot.id)!.threadId).toBe(routine.threadId);

    const patched = store.patchBot(bot.id, { unread: true })!;
    expect(patched.unread).toBe(true);
    expect(store.taskByThread(bot.id, routine.threadId)!.unread).toBe(false);
    expect(store.taskByThread(bot.id, openThreadId)!.unread).toBe(true);

    const { Store } = await import("./store.ts");
    const reloaded = new Store(() => ({ instanceId: "claude", model: "m" }));
    expect(reloaded.bot(bot.id)!.unread).toBe(true);
    expect(reloaded.taskByThread(bot.id, routine.threadId)!.unread).toBe(false);
    expect(reloaded.taskByThread(bot.id, openThreadId)!.unread).toBe(true);
  });

  it("marks the open main conversation unread when activeTask is archived, leaving the archived thread untouched", async () => {
    const { store } = await freshStore();
    const bot = store.createBot();
    const firstOpen = bot.threadId;
    const chosenOpen = store.createTask(bot.id, "Chosen main", false)!;
    store.patchBot(bot.id, { mainThreadChoice: chosenOpen.threadId });
    const oldTask = store.createTask(bot.id, "Closed chat", true)!;
    store.patchTask(bot.id, oldTask.threadId, { archivedAt: 1_000, unread: false });
    store.switchTask(bot.id, oldTask.threadId);
    expect(store.bot(bot.id)!.threadId).toBe(oldTask.threadId);

    const patched = store.patchBot(bot.id, { unread: true })!;
    expect(patched.unread).toBe(true);
    expect(store.taskByThread(bot.id, oldTask.threadId)!.unread).toBe(false);
    expect(store.taskByThread(bot.id, firstOpen)!.unread).toBe(false);
    expect(store.taskByThread(bot.id, chosenOpen.threadId)!.unread).toBe(true);
  });

  it("marks the main conversation kept for the bot unread when the active one is archived and no choice was made", async () => {
    const { store } = await freshStore();
    const bot = store.createBot();
    const first = bot.threadId;
    const kept = store.createTask(bot.id, "Kept main", false)!;
    expect(store.keepMainThread(bot.id, () => kept.threadId)).toBe(kept.threadId);
    const oldTask = store.createTask(bot.id, "Closed chat", true)!;
    store.patchTask(bot.id, oldTask.threadId, { archivedAt: 1_000, unread: false });

    expect(store.patchBot(bot.id, { unread: true })!.unread).toBe(true);
    expect(store.taskByThread(bot.id, kept.threadId)!.unread).toBe(true);
    expect(store.taskByThread(bot.id, first)!.unread).toBe(false);
    expect(store.taskByThread(bot.id, oldTask.threadId)!.unread).toBe(false);
  });

  it("leaves bot.unread false when every non-routine conversation is archived", async () => {
    const { store } = await freshStore();
    const bot = store.createBot();
    store.patchTask(bot.id, bot.threadId, { archivedAt: 1_000, unread: false });

    const patched = store.patchBot(bot.id, { unread: true })!;
    expect(patched.unread).toBe(false);
    expect(store.taskByThread(bot.id, bot.threadId)!.unread).toBe(false);
  });
});
