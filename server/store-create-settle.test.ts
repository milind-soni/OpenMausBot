import { existsSync, readFileSync, rmSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { OwnedFile } from "./atomic.ts";
import { soulFile } from "./bot-folder.ts";
import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { BOTS_FILE } from "./registry-store.ts";
import { Store, type StoreChange } from "./store.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });
const savedBots = () => (JSON.parse(readFileSync(BOTS_FILE, "utf8")) as Array<{ id: string; name: string; cwd?: string }>);

/** How many times bots.json was really written while `run` ran: a save of unchanged text writes nothing. */
function botsFileWrites(run: () => void): number {
  const write = vi.spyOn(OwnedFile.prototype, "write");
  try {
    run();
    return write.mock.results.filter((result, call) => result.value === true && (write.mock.contexts[call] as OwnedFile).path === BOTS_FILE).length;
  } finally {
    write.mockRestore();
  }
}

describe("Store.createBot with settle", () => {
  beforeEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));

  it("saves the bot once, finished, before anyone hears of it", () => {
    const store = new Store(selection);
    store.createBot({ name: "Already here" });
    const heard: Array<{ change: StoreChange; saved: boolean }> = [];
    let made = "";
    store.onChange((change) => { if (change.type === "bot") heard.push({ change, saved: savedBots().some((bot) => bot.id === made && bot.cwd === "/work") }); });

    const writes = botsFileWrites(() => {
      const bot = store.createBot({ name: "Scout", soul: "Be brief." }, { seedMessages: false, settle: (fresh) => { made = fresh.id; store.patchBot(fresh.id, { cwd: "/work" }); } });
      expect(bot.cwd).toBe("/work");
    });

    expect(writes).toBe(1);
    expect(heard.length).toBeGreaterThan(0);
    expect(heard.every((entry) => entry.saved)).toBe(true);
    expect(savedBots().map((bot) => bot.name)).toEqual(["Scout", "Already here"]);
    expect(readFileSync(soulFile(made), "utf8")).toBe("Be brief.");
  });

  it("leaves nothing of a greeted bot for a later save: its one write holds what memory holds", () => {
    const store = new Store(selection);
    for (const settle of [undefined, (fresh: { id: string }) => { store.patchBot(fresh.id, { cwd: "/work" }); }]) {
      let bot = store.bots[0]!;
      expect(botsFileWrites(() => { bot = store.createBot({ name: "Greeted" }, { settle }); })).toBe(1);
      const greeting = store.messagesFor(bot.threadId);
      expect(greeting).toHaveLength(1);
      expect(greeting[0]!.at).toBe(bot.createdAt);
      const { busy: _busy, activity: _activity, ...task } = bot.tasks![0]!;
      expect((savedBots().find((saved) => saved.id === bot.id) as unknown as typeof bot).tasks![0]).toEqual(task);
      expect(botsFileWrites(() => { store.patchBot(bot.id, { name: bot.name }); })).toBe(0);
    }
  });

  it("writes bots.json once without settle too", () => {
    const store = new Store(selection);
    expect(botsFileWrites(() => { store.createBot({ name: "Scout" }, { seedMessages: false }); })).toBe(1);
  });

  it("leaves no bot in memory or on disk when settle throws, before or after its own save", () => {
    const store = new Store(selection);
    const kept = store.createBot({ name: "Already here" });
    const heard: StoreChange[] = [];
    store.onChange((change) => heard.push(change));

    expect(() => store.createBot({ name: "Early" }, { settle: () => { throw new Error("refused early"); } })).toThrow("refused early");
    expect(heard.map((change) => change.type)).toEqual(["bot.deleted"]);
    let late = "";
    expect(() => store.createBot({ name: "Late" }, { settle: (fresh) => { late = fresh.id; store.patchBot(fresh.id, { cwd: "/work" }); throw new Error("refused late"); } })).toThrow("refused late");

    expect(heard.filter((change) => "botId" in change && change.botId === late).map((change) => change.type)).toEqual(["bot", "bot.deleted"]);
    expect(store.bots.map((bot) => bot.id)).toEqual([kept.id]);
    expect(savedBots().map((bot) => bot.id)).toEqual([kept.id]);
    expect(new Store(selection).bots.map((bot) => bot.id)).toEqual([kept.id]);
    expect(existsSync(soulFile(late))).toBe(false);
    expect(store.messagesFor(kept.threadId).length).toBeGreaterThan(0);
  });

  it("leaves no bot in memory when the save fails", () => {
    const store = new Store(selection);
    const kept = store.createBot({ name: "Already here" });
    const write = vi.spyOn(OwnedFile.prototype, "write").mockImplementation(() => { throw new Error("disk full"); });
    try {
      expect(() => store.createBot({ name: "Plain" })).toThrow("disk full");
      expect(() => store.createBot({ name: "Settled" }, { settle: (fresh) => { store.patchBot(fresh.id, { cwd: "/work" }); } })).toThrow("disk full");
    } finally {
      write.mockRestore();
    }
    expect(store.bots.map((bot) => bot.id)).toEqual([kept.id]);
    expect(savedBots().map((bot) => bot.id)).toEqual([kept.id]);
  });
});
