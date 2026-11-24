import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { memberAudience } from "./audience.ts";
import { memberBot, VisibleSet } from "./bot-visibility.ts";

let home: string | undefined;

async function freshStore() {
  home = mkdtempSync(join(tmpdir(), "omb-archived-unread-"));
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

describe("archived threads and bot.unread", () => {
  it("excludes archived threads from bot.unread across patches and reloads, and restores it when unarchived", async () => {
    const { store } = await freshStore();
    const bot = store.createBot();
    const open = bot.threadId;
    const hidden = store.createTask(bot.id, "Hidden unread", false)!;

    store.patchTask(bot.id, hidden.threadId, { unread: true });
    expect(store.bot(bot.id)!.unread).toBe(true);

    store.patchTask(bot.id, hidden.threadId, { archivedAt: 1_000 });
    expect(store.bot(bot.id)!.unread).toBe(false);
    expect(store.taskByThread(bot.id, hidden.threadId)!.unread).toBe(true);

    const { Store } = await import("./store.ts");
    const reloaded = new Store(() => ({ instanceId: "claude", model: "m" }));
    expect(reloaded.bot(bot.id)!.unread).toBe(false);

    reloaded.patchTask(bot.id, hidden.threadId, { archivedAt: undefined });
    expect(reloaded.bot(bot.id)!.unread).toBe(true);
    expect(reloaded.bot(bot.id)!.threadId).toBe(open);
  });

  it("excludes archived threads when narrowing Team Cloud shownConversations unread state", () => {
    const bot = {
      id: "b1",
      threadId: "t-open",
      unread: true,
      tasks: [
        { threadId: "t-private", title: "Alice private", createdAt: 1, unread: true },
        { threadId: "t-archived", title: "Team archived", createdAt: 2, unread: true, archivedAt: 500 },
        { threadId: "t-open", title: "Team open", createdAt: 3, unread: false },
      ],
    };
    const visible = new VisibleSet([bot], [], { kind: "member", email: "bob@example.com" }, undefined, {
      person: "bob",
      of: (threadId) => (threadId === "t-private" ? memberAudience("alice") : "team"),
    });
    expect(memberBot(bot, visible).unread).toBe(false);
  });
});
