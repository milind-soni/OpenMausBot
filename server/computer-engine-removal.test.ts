// The Computer engine is gone (decision D5): a whole turn ran on Boat's own
// agent, which has no AI sign-in on a Cloud. These pin the one-time move off
// it: the engine is never offered again, and saved settings that name it move
// to the engine a new bot gets, keeping where each conversation works.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { BUILT_IN_DRIVERS } from "./drivers/builtIn.ts";
import { computerEngineMoveText, removedComputerInstanceIds, writeComputerEngineMoveLines } from "./computer-engine-removal.ts";
import { DATA_DIR, instanceConfigs, persistableInstanceConfigs, type AppConfig } from "./config.ts";
import { SECTION_CONTEXTS_FILE } from "./section-context.ts";
import { Store, type BotRecord } from "./store.ts";

describe("the Computer engine is not offered", () => {
  it("is in no built-in driver list and no default fleet", () => {
    expect(BUILT_IN_DRIVERS.map(driver => driver.driverKind)).not.toContain("boxAgent");
    const fleet = instanceConfigs({ box: { token: "box_fixture" } });
    expect(fleet).not.toHaveProperty("computer");
    expect(Object.values(fleet).map(entry => entry.driver)).not.toContain("boxAgent");
  });

  it("drops a saved fleet's entries for it, so the next save leaves them off disk", () => {
    const cfg: AppConfig = {
      box: { token: "box_fixture" },
      instances: {
        claude: { driver: "claudeAgent" },
        computer: { driver: "boxAgent", environment: { BOX_TOKEN: "box_instance" } },
        myBoat: { driver: "boxAgent", displayName: "My Boat" },
      },
    };
    for (const map of [instanceConfigs(cfg), persistableInstanceConfigs(cfg)]) {
      expect(Object.keys(map)).toContain("claude");
      expect(map).not.toHaveProperty("computer");
      expect(map).not.toHaveProperty("myBoat");
    }
    // The caller's saved map is never changed in place.
    expect(cfg.instances).toHaveProperty("computer");
  });

  it("names every id the engine had, and leaves an id the person reused for another engine", () => {
    expect([...removedComputerInstanceIds(undefined)]).toEqual(["computer"]);
    expect([...removedComputerInstanceIds({ claude: { driver: "claudeAgent" }, myBoat: { driver: "boxAgent" } })].sort())
      .toEqual(["computer", "myBoat"]);
    expect([...removedComputerInstanceIds({ computer: { driver: "claudeAgent" } })]).toEqual([]);
  });
});

describe("moving saved bots off the engine", () => {
  beforeEach(() => { rmSync(DATA_DIR, { recursive: true, force: true }); });
  const newBotDefault = () => ({ instanceId: "claude", model: "claude-model" });
  const replacement = { instanceId: "claude", model: "claude-model" };
  const removed = new Set(["computer"]);
  /** This server has a Boat account, the bot's cloud backend is Boat, and no
   * team computer serves its section: on Auto, the removed engine ran on the
   * bot's own cloud computer. */
  const boat = { driverKind: "claudeAgent", canWorkOnCloud: true, keepCloud: (bot: BotRecord) => bot.cloudBackend !== "vps" };
  const noBoat = { driverKind: "claudeAgent", canWorkOnCloud: true, keepCloud: () => false };
  /** The same server, but the engine a new bot gets has no computer tools:
   * an OpenAI-compatible endpoint without computer use, like Mistral. */
  const chatOnly = { driverKind: "mistral", canWorkOnCloud: false, keepCloud: (bot: BotRecord) => bot.cloudBackend !== "vps" };

  it("moves the bot's model, each conversation's model and its backups once, and keeps Works on", () => {
    const store = new Store(newBotDefault);
    const bot = store.createBot({ modelSelection: { instanceId: "computer", model: "claude-fable-5" } }, { seedMessages: false });
    const other = store.createBot({ modelSelection: { instanceId: "codex", model: "codex-model" } }, { seedMessages: false });
    store.patchBot(bot.id, { computer: "cloud", fallback: [{ instanceId: "computer", model: "sonnet" }, { instanceId: "codex", model: "codex-model" }] });
    const second = store.createTask(bot.id, "Second", false)!;
    store.patchTask(bot.id, second.threadId, { modelSelection: { instanceId: "computer", model: "gpt-5.4" } });
    store.setResumeCursor(bot.id, "computer", "boat-prompt-run", bot.threadId);
    store.setResumeCursor(bot.id, "codex", "codex-session", bot.threadId);

    const moves = store.retireInstances(removed, replacement, boat);
    expect(moves).toHaveLength(2);
    expect(moves).toEqual(expect.arrayContaining([
      { botId: bot.id, threadId: bot.threadId, scope: "bot", cloud: true, noComputer: false, askNow: false },
      { botId: bot.id, threadId: second.threadId, scope: "conversation", cloud: true, noComputer: false, askNow: false },
    ]));

    const reloaded = new Store(newBotDefault);
    const moved = reloaded.bot(bot.id)!;
    expect(moved.modelSelection).toEqual(replacement);
    expect(moved.computer).toBe("cloud");
    expect(moved.fallback).toEqual([{ instanceId: "codex", model: "codex-model" }]);
    expect(reloaded.taskByThread(bot.id, second.threadId)?.modelSelection).toEqual(replacement);
    expect(reloaded.taskByThread(bot.id, bot.threadId)?.resumeCursors).toEqual({ codex: "codex-session" });
    expect(reloaded.bot(other.id)?.modelSelection).toEqual({ instanceId: "codex", model: "codex-model" });
    // One time: nothing left names the engine.
    expect(reloaded.retireInstances(removed, replacement, boat)).toEqual([]);
  });

  it("keeps an Auto bot on its cloud computer, where the removed engine always ran", () => {
    const store = new Store(newBotDefault);
    const auto = store.createBot({ modelSelection: { instanceId: "computer", model: "claude-fable-5" } }, { seedMessages: false });
    const vps = store.createBot({ modelSelection: { instanceId: "computer", model: "claude-fable-5" } }, { seedMessages: false });
    store.patchBot(vps.id, { cloudBackend: "vps" });
    const local = store.createBot({ modelSelection: { instanceId: "computer", model: "claude-fable-5" } }, { seedMessages: false });
    store.patchBot(local.id, { computer: "local" });

    const moves = store.retireInstances(removed, replacement, boat);

    const reloaded = new Store(newBotDefault);
    expect(reloaded.bot(auto.id)?.computer).toBe("cloud");
    expect(moves.find(move => move.botId === auto.id)?.cloud).toBe(true);
    // The removed engine never ran on a VPS, nor on This computer: those
    // bots now work where their setting says, which the line does not claim.
    expect(reloaded.bot(vps.id)?.computer).toBeUndefined();
    expect(moves.find(move => move.botId === vps.id)?.cloud).toBe(false);
    expect(reloaded.bot(local.id)?.computer).toBe("local");
    expect(moves.find(move => move.botId === local.id)?.cloud).toBe(false);
  });

  it("leaves an Auto bot on Auto when this server has no cloud computers", () => {
    const store = new Store(newBotDefault);
    const auto = store.createBot({ modelSelection: { instanceId: "computer", model: "claude-fable-5" } }, { seedMessages: false });
    expect(store.retireInstances(removed, replacement, noBoat)).toEqual([
      { botId: auto.id, threadId: auto.threadId, scope: "bot", cloud: false, noComputer: false, askNow: false },
    ]);
    expect(new Store(newBotDefault).bot(auto.id)?.computer).toBeUndefined();
  });

  it("moves only the conversation that was on the engine, and keeps it on the cloud computer", () => {
    const store = new Store(newBotDefault);
    const bot = store.createBot({ modelSelection: { instanceId: "codex", model: "codex-model" } }, { seedMessages: false });
    const second = store.createTask(bot.id, "On the engine", false)!;
    store.patchTask(bot.id, second.threadId, { modelSelection: { instanceId: "computer", model: "gpt-5.4" } });

    expect(store.retireInstances(removed, replacement, boat)).toEqual([
      { botId: bot.id, threadId: second.threadId, scope: "conversation", cloud: true, noComputer: false, askNow: false },
    ]);

    const reloaded = new Store(newBotDefault);
    // The bot itself keeps its engine and Works on: Auto.
    expect(reloaded.bot(bot.id)?.modelSelection).toEqual({ instanceId: "codex", model: "codex-model" });
    expect(reloaded.bot(bot.id)?.computer).toBeUndefined();
    const task = reloaded.taskByThread(bot.id, second.threadId)!;
    expect(task.modelSelection).toEqual(replacement);
    // Pinned the way an Auto turn records where it landed, so a later Works
    // on change still moves it.
    expect(task.surface).toBe("cloud");
    expect(task.surfaceSource).toBe("auto");
    expect(reloaded.taskByThread(bot.id, bot.threadId)?.surface).toBeUndefined();
  });

  it("sets a level the new engine would have to confirm back to Ask, as every engine switch does", () => {
    const store = new Store(newBotDefault);
    const full = store.createBot({ modelSelection: { instanceId: "computer", model: "claude-fable-5" } }, { seedMessages: false });
    store.patchBot(full.id, { approvalMode: "full", alwaysAllow: ["Bash(ls:*)"] });
    store.patchTask(full.id, full.threadId, { approvalMode: "full", alwaysAllow: ["Bash(ls:*)"] });
    const auto = store.createBot({ modelSelection: { instanceId: "computer", model: "claude-fable-5" } }, { seedMessages: false });
    store.patchBot(auto.id, { approvalMode: "auto" });
    store.patchTask(auto.id, auto.threadId, { approvalMode: "auto" });

    const moves = store.retireInstances(removed, replacement, noBoat);

    const reloaded = new Store(newBotDefault);
    expect(reloaded.bot(full.id)).toMatchObject({ approvalMode: "ask", autoApprove: false, alwaysAllow: [] });
    expect(reloaded.taskByThread(full.id, full.threadId)).toMatchObject({ approvalMode: "ask", autoApprove: false, alwaysAllow: [] });
    expect(moves.find(move => move.botId === full.id)?.askNow).toBe(true);
    // A level the new engine has as well carries across, as on any switch.
    expect(reloaded.bot(auto.id)?.approvalMode).toBe("auto");
    expect(reloaded.taskByThread(auto.id, auto.threadId)?.approvalMode).toBe("auto");
    expect(moves.find(move => move.botId === auto.id)?.askNow).toBe(false);
  });

  it("keeps the level of a conversation on another engine when the bot's own level goes back to Ask", () => {
    const store = new Store(newBotDefault);
    // The first conversation has no level of its own: it follows the bot's.
    const bot = store.createBot({ modelSelection: { instanceId: "computer", model: "claude-fable-5" } }, { seedMessages: false });
    store.patchBot(bot.id, { approvalMode: "full", alwaysAllow: ["Bash(ls:*)"] });
    const elsewhere = bot.threadId;
    store.patchTask(bot.id, elsewhere, { modelSelection: { instanceId: "codex", model: "codex-model" } });
    expect(store.projectBotForTask(bot.id, elsewhere)).toMatchObject({ approvalMode: "full", alwaysAllow: ["Bash(ls:*)"] });

    const moves = store.retireInstances(removed, replacement, noBoat);

    const reloaded = new Store(newBotDefault);
    // The bot moved and its Full access goes back to Ask, as on any switch.
    expect(reloaded.bot(bot.id)).toMatchObject({ modelSelection: replacement, approvalMode: "ask", alwaysAllow: [] });
    // The conversation stays on Codex, so nothing about its level changes.
    expect(reloaded.projectBotForTask(bot.id, elsewhere)).toMatchObject({
      modelSelection: { instanceId: "codex", model: "codex-model" }, approvalMode: "full", alwaysAllow: ["Bash(ls:*)"],
    });
    // It is the bot's open conversation, so it still hears what moved: the
    // bot's own engine and level, not its own.
    expect(moves).toEqual([
      { botId: bot.id, threadId: elsewhere, scope: "bot-only", cloud: false, noComputer: false, askNow: true },
    ]);
  });

  it("tells a moved conversation that follows the bot's level that it is now Ask", () => {
    const store = new Store(newBotDefault);
    const bot = store.createBot({ modelSelection: { instanceId: "computer", model: "claude-fable-5" } }, { seedMessages: false });
    store.patchBot(bot.id, { approvalMode: "full" });
    const first = bot.threadId;
    // A newer conversation becomes the open one; the first keeps following the bot.
    store.createTask(bot.id, "Newer", true);

    const moves = store.retireInstances(removed, replacement, noBoat);

    expect(moves.find(move => move.threadId === first)).toMatchObject({ scope: "conversation", askNow: true });
    expect(new Store(newBotDefault).projectBotForTask(bot.id, first)).toMatchObject({ approvalMode: "ask" });
  });

  it("keeps a bot on Auto when the new engine can't use a computer, and says so", () => {
    const store = new Store(newBotDefault);
    const auto = store.createBot({ modelSelection: { instanceId: "computer", model: "claude-fable-5" } }, { seedMessages: false });
    const local = store.createBot({ modelSelection: { instanceId: "computer", model: "claude-fable-5" } }, { seedMessages: false });
    store.patchBot(local.id, { computer: "local" });
    const mixed = store.createBot({ modelSelection: { instanceId: "codex", model: "codex-model" } }, { seedMessages: false });
    const mixedConversation = store.createTask(mixed.id, "On the engine", false)!;
    store.patchTask(mixed.id, mixedConversation.threadId, { modelSelection: { instanceId: "computer", model: "gpt-5.4" } });

    const moves = store.retireInstances(removed, replacement, chatOnly);

    const reloaded = new Store(newBotDefault);
    // Works on: Cloud would refuse every turn on this engine, so Auto stays Auto.
    expect(reloaded.bot(auto.id)?.computer).toBeUndefined();
    expect(moves.find(move => move.botId === auto.id)).toMatchObject({ cloud: false, noComputer: "auto" });
    expect(reloaded.taskByThread(mixed.id, mixedConversation.threadId)?.surface).toBeUndefined();
    expect(moves.find(move => move.botId === mixed.id)).toMatchObject({ scope: "conversation", cloud: false, noComputer: "auto" });
    // The removed engine never ran on This computer, so nothing was lost there.
    expect(moves.find(move => move.botId === local.id)).toMatchObject({ cloud: false, noComputer: false });
  });

  it("tells a Cloud the person chose apart from Auto when the new engine can't use a computer", () => {
    const store = new Store(newBotDefault);
    // Works on: Cloud, set by the person.
    const cloud = store.createBot({ modelSelection: { instanceId: "computer", model: "claude-fable-5" } }, { seedMessages: false });
    store.patchBot(cloud.id, { computer: "cloud" });
    // Auto, with one conversation the person set to the cloud computer.
    const pinned = store.createBot({ modelSelection: { instanceId: "computer", model: "claude-fable-5" } }, { seedMessages: false });
    store.patchTask(pinned.id, pinned.threadId, { surface: "cloud", surfaceSource: "user" });

    const moves = store.retireInstances(removed, replacement, chatOnly);

    const reloaded = new Store(newBotDefault);
    // A chosen place stays chosen, and each turn there is refused until it
    // or the model changes: the line names the one setting to change.
    expect(reloaded.bot(cloud.id)?.computer).toBe("cloud");
    expect(moves.find(move => move.botId === cloud.id)).toMatchObject({ scope: "bot", cloud: false, noComputer: "works-on" });
    expect(reloaded.bot(pinned.id)?.computer).toBeUndefined();
    expect(reloaded.taskByThread(pinned.id, pinned.threadId)).toMatchObject({ surface: "cloud", surfaceSource: "user" });
    expect(moves.find(move => move.botId === pinned.id)).toMatchObject({ scope: "bot", cloud: false, noComputer: "pin" });
  });

  it("clears a moved conversation's Auto-recorded cloud pin when the new engine can't use a computer", () => {
    const store = new Store(newBotDefault);
    const auto = store.createBot({ modelSelection: { instanceId: "computer", model: "claude-fable-5" } }, { seedMessages: false });
    store.patchTask(auto.id, auto.threadId, { surface: "cloud", surfaceSource: "auto" });
    // Works on: Cloud matches the pin, so it is the setting that still applies.
    const cloud = store.createBot({ modelSelection: { instanceId: "computer", model: "claude-fable-5" } }, { seedMessages: false });
    store.patchBot(cloud.id, { computer: "cloud" });
    store.patchTask(cloud.id, cloud.threadId, { surface: "cloud", surfaceSource: "auto" });
    // A conversation that stays on its own engine keeps its pin.
    const kept = store.createTask(auto.id, "On Codex", false)!;
    store.patchTask(auto.id, kept.threadId, { modelSelection: { instanceId: "codex", model: "codex-model" }, surface: "cloud", surfaceSource: "auto" });

    const moves = store.retireInstances(removed, replacement, chatOnly);

    const reloaded = new Store(newBotDefault);
    const place = (botId: string, threadId: string) => {
      const task = reloaded.taskByThread(botId, threadId)!;
      return { surface: task.surface, surfaceSource: task.surfaceSource };
    };
    // The machine's memory of where Auto landed gives way, so the next turn
    // runs on Auto instead of being refused there once.
    expect(place(auto.id, auto.threadId)).toEqual({ surface: undefined, surfaceSource: undefined });
    expect(moves.find(move => move.threadId === auto.threadId)).toMatchObject({ cloud: false, noComputer: "auto" });
    expect(place(cloud.id, cloud.threadId)).toEqual({ surface: undefined, surfaceSource: undefined });
    expect(moves.find(move => move.threadId === cloud.threadId)).toMatchObject({ cloud: false, noComputer: "works-on" });
    expect(place(auto.id, kept.threadId)).toEqual({ surface: "cloud", surfaceSource: "auto" });
  });

  it("changes nothing when the save fails, so the next try moves the bot", () => {
    const store = new Store(newBotDefault);
    const bot = store.createBot({ modelSelection: { instanceId: "computer", model: "claude-fable-5" } }, { seedMessages: false });
    // An unreadable teams file stops every bots save.
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(SECTION_CONTEXTS_FILE, "not json");

    expect(() => store.retireInstances(removed, replacement, boat)).toThrow();
    expect(store.bot(bot.id)).toMatchObject({ modelSelection: { instanceId: "computer", model: "claude-fable-5" } });
    expect(store.bot(bot.id)?.computer).toBeUndefined();

    rmSync(SECTION_CONTEXTS_FILE, { force: true });
    expect(store.retireInstances(removed, replacement, boat)).toEqual([
      { botId: bot.id, threadId: bot.threadId, scope: "bot", cloud: true, noComputer: false, askNow: false },
    ]);
    expect(new Store(newBotDefault).bot(bot.id)).toMatchObject({ modelSelection: replacement, computer: "cloud" });
  });
});

describe("the line a moved conversation shows", () => {
  it("names the bot, the new engine, the removed choice as people saw it, and only what is true", () => {
    expect(computerEngineMoveText({ scope: "bot", cloud: true, askNow: false }, "Scout", "Claude")).toBe(
      "Scout now uses Claude. The Computer choice in the model list was removed. Scout still works on its cloud computer.");
    expect(computerEngineMoveText({ scope: "bot", cloud: false, askNow: true }, "Scout", "Claude")).toBe(
      "Scout now uses Claude. The Computer choice in the model list was removed. Its permissions are now Ask.");
    expect(computerEngineMoveText({ scope: "conversation", cloud: true, askNow: false }, "Scout", "Claude")).toBe(
      "This conversation now uses Claude. The Computer choice in the model list was removed. It still works on Scout's cloud computer.");
  });

  it("says the cloud computer is out of reach on Auto when the new engine can't use a computer", () => {
    expect(computerEngineMoveText({ scope: "bot", cloud: false, noComputer: "auto", askNow: false }, "Scout", "Mistral")).toBe(
      "Scout now uses Mistral. The Computer choice in the model list was removed. Mistral can't use a computer, " +
      "so Scout no longer works on its cloud computer. To use it again, choose a model that can use a computer.");
    expect(computerEngineMoveText({ scope: "conversation", cloud: false, noComputer: "auto", askNow: true }, "Scout", "Mistral")).toBe(
      "This conversation now uses Mistral. The Computer choice in the model list was removed. Mistral can't use a computer, " +
      "so it no longer works on Scout's cloud computer. To use it again, choose a model that can use a computer. " +
      "Its permissions are now Ask.");
  });

  it("says turns stop, and the one setting to change, where the person chose Cloud", () => {
    expect(computerEngineMoveText({ scope: "bot", cloud: false, noComputer: "works-on", askNow: false }, "Scout", "Mistral")).toBe(
      "Scout now uses Mistral. The Computer choice in the model list was removed. Mistral can't use a computer, " +
      "so Scout can't reply on Mistral while its Works on is Cloud computer. Choose a model that can use a computer, or set Works on to Auto.");
    expect(computerEngineMoveText({ scope: "conversation", cloud: false, noComputer: "pin", askNow: false }, "Scout", "Mistral")).toBe(
      "This conversation now uses Mistral. The Computer choice in the model list was removed. Mistral can't use a computer, " +
      "so Scout can't reply here while this conversation is pinned to its cloud computer. " +
      "Choose a model that can use a computer, or clear this conversation's place in the composer.");
  });

  it("tells the bot's open conversation on its own engine about the bot, not about itself", () => {
    expect(computerEngineMoveText({ scope: "bot-only", cloud: true, noComputer: false, askNow: true }, "Scout", "Claude")).toBe(
      "Scout now uses Claude; this conversation keeps its own model. The Computer choice in the model list was removed. " +
      "Scout still works on its cloud computer. Scout's permissions are now Ask, but this conversation's stay as they were.");
  });
});

describe("writing the moved conversations' lines", () => {
  it("writes every other line when one fails", () => {
    const move = (threadId: string) => ({ botId: "bot", threadId, scope: "bot" as const, cloud: false, noComputer: false as const, askNow: false });
    const written: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      writeComputerEngineMoveLines([move("first"), move("second")], ({ threadId }) => {
        if (threadId === "first") throw new Error("disk full");
        written.push(threadId);
      });
      expect(written).toEqual(["second"]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("disk full"));
    } finally {
      warn.mockRestore();
    }
  });
});
