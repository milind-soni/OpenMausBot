// Store persistence contract: bots.json + messages-<threadId>.json are
// the durable record — everything here must survive a process restart
// except `busy`, which never does (no turn survives one either).
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR, LEGACY_CLOUD_COMPUTER_DRIVER } from "./config.ts";
import { DEFAULT_BOTS } from "./default-bots.ts";
import type { ModelSelection } from "./contracts.ts";
import { Store, type BotRecord } from "./store.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });

describe("Store", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("migrates cloud computers and old engine selections once, preserving local and off", () => {
    const store = new Store(selection);
    const legacy = store.createBot();
    const local = store.createBot();
    const off = store.createBot();
    const custom = store.createBot();
    const direct = store.createBot();
    store.patchBot(local.id, { computer: "local" });
    store.patchBot(off.id, { computer: "off" });
    const rows = JSON.parse(readFileSync(join(DATA_DIR, "bots.json"), "utf8"));
    rows.find((b: BotRecord) => b.id === legacy.id).computer = "cloud";
    rows.find((b: BotRecord) => b.id === legacy.id).modelSelection = { instanceId: "computer", model: "sonnet" };
    rows.find((b: BotRecord) => b.id === custom.id).modelSelection = { instanceId: "old-desktop", model: "sonnet" };
    rows.find((b: BotRecord) => b.id === direct.id).modelSelection = { instanceId: LEGACY_CLOUD_COMPUTER_DRIVER, model: "sonnet" };
    writeFileSync(join(DATA_DIR, "bots.json"), JSON.stringify(rows));
    const removed = new Set(["computer", "old-desktop", LEGACY_CLOUD_COMPUTER_DRIVER]);
    const reloaded = new Store(selection, removed);
    expect(reloaded.bot(legacy.id)?.computer).toBeUndefined();
    expect(reloaded.bot(local.id)?.computer).toBe("local");
    expect(reloaded.bot(off.id)?.computer).toBe("off");
    for (const bot of [legacy, custom, direct]) {
      expect(reloaded.bot(bot.id)?.modelSelection).toEqual(selection());
      const notices = () => new Store(selection, removed).messagesFor(bot.threadId).filter(m => m.text?.includes("cloud computer, which has been removed"));
      expect(notices()).toHaveLength(1);
      expect(notices()[0].text).toBe(`This bot used the cloud computer, which has been removed. It now uses ${selection().model}.`);
    }
    const persisted = JSON.parse(readFileSync(join(DATA_DIR, "bots.json"), "utf8"));
    expect(persisted.find((b: BotRecord) => b.id === legacy.id)).not.toHaveProperty("computer");
  });

  it("clears only the old cloud preference when the selected engine is still available", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const rows = [{ ...bot, computer: "cloud" }];
    writeFileSync(join(DATA_DIR, "bots.json"), JSON.stringify(rows));
    const reloaded = new Store(selection);
    expect(reloaded.bot(bot.id)?.computer).toBeUndefined();
    expect(reloaded.messagesFor(bot.threadId)).toHaveLength(2);
    expect(reloaded.bot(bot.id)?.modelSelection).toEqual(selection());
  });

  it("createBot seeds a greeting and an onboarding card", () => {
    const store = new Store(selection);
    const bot = store.createBot();

    const messages = store.messagesFor(bot.threadId);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: "bot", kind: "text" });
    expect(messages[1].kind).toBe("options");
    expect(messages[1].card?.options.length).toBeGreaterThan(1);
    expect(bot.modelSelection).toEqual(selection());
  });

  it("rotates colors across created bots", () => {
    const store = new Store(selection);
    const first = store.createBot();
    const second = store.createBot();
    expect(first.color).not.toBe(second.color);
  });

  it("persists bots and messages across a restart, resetting busy", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    store.patchBot(bot.id, { name: "Testy", busy: true });
    store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "hi there" });

    const reloaded = new Store(selection);
    const back = reloaded.bot(bot.id)!;
    expect(back.name).toBe("Testy");
    expect(back.busy).toBe(false);
    const messages = reloaded.messagesFor(bot.threadId);
    expect(messages.at(-1)).toMatchObject({ role: "user", text: "hi there" });
  });

  it("patchMessage merges card patches and returns null for unknown ids", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const card = store.messagesFor(bot.threadId)[1];

    const patched = store.patchMessage(bot.threadId, card.id, {
      card: { ...card.card!, answered: "Work & projects" },
    });
    expect(patched?.card?.answered).toBe("Work & projects");
    expect(store.patchMessage(bot.threadId, "nope", {})).toBeNull();
  });

  it("deleteBot removes the bot and its transcript file", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const file = join(DATA_DIR, `messages-${bot.threadId}.json`);
    expect(existsSync(file)).toBe(true);

    expect(store.deleteBot(bot.id)).toBe(true);
    expect(store.bot(bot.id)).toBeNull();
    expect(existsSync(file)).toBe(false);
    expect(store.deleteBot(bot.id)).toBe(false);
  });

  it("setResumeCursor persists per-instance continuations", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    store.setResumeCursor(bot.id, "claude", "sess-abc");
    store.setResumeCursor(bot.id, "codex", "thread-xyz");

    const reloaded = new Store(selection);
    expect(reloaded.bot(bot.id)?.resumeCursors).toEqual({ claude: "sess-abc", codex: "thread-xyz" });
  });

  it("seedIfEmpty creates the default team, once", () => {
    const store = new Store(selection);
    store.seedIfEmpty();
    expect(store.bots.map((b) => b.name)).toEqual(DEFAULT_BOTS.map((b) => b.name));
    expect(store.bots.every((b) => b.description && b.title)).toBe(true);
    expect(store.bots.every((b) => b.modelSelection.instanceId === selection().instanceId)).toBe(true);
    expect(store.messagesFor(store.bots[0].threadId).at(-1)?.kind).toBe("options");
    store.seedIfEmpty();
    expect(store.bots).toHaveLength(DEFAULT_BOTS.length);

    const reloaded = new Store(selection);
    reloaded.seedIfEmpty();
    expect(reloaded.bots).toHaveLength(DEFAULT_BOTS.length);
  });

  it("seedIfEmpty leaves an existing roster alone", () => {
    const store = new Store(selection);
    store.createBot();
    store.seedIfEmpty();
    expect(store.bots).toHaveLength(1);
  });

  it("chains appended messages and keeps the newest as active leaf", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const user = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "hi" });

    const messages = store.messagesFor(bot.threadId);
    expect(user.parentId).toBe(messages[1].id); // follows the onboarding card
    expect(store.activeLeaf(bot.threadId)).toBe(user.id);
    expect(store.activePath(bot.threadId).map((m) => m.id)).toEqual(messages.map((m) => m.id));
  });

  it("branchMessage forks at the edited message and hides the old tail", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const original = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "v1" });
    const reply = store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "answer to v1" });

    const edited = store.branchMessage(bot.threadId, original.id, "v2")!;
    expect(edited.parentId).toBe(original.parentId); // sibling, not child
    expect(store.activeLeaf(bot.threadId)).toBe(edited.id);

    const path = store.activePath(bot.threadId);
    expect(path.map((m) => m.text)).toContain("v2");
    expect(path.map((m) => m.text)).not.toContain("v1");
    expect(path.map((m) => m.id)).not.toContain(reply.id);
    // the abandoned branch still exists in the tree
    expect(store.messagesFor(bot.threadId).map((m) => m.id)).toContain(original.id);

    expect(store.branchMessage(bot.threadId, "nope", "x")).toBeNull();
  });

  it("setActiveLeaf switches branches and descends to the newest leaf", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const original = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "v1" });
    const reply = store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "answer to v1" });
    store.branchMessage(bot.threadId, original.id, "v2");
    store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "answer to v2" });

    // back to the original branch: the leaf is v1's reply, not v1 itself
    expect(store.setActiveLeaf(bot.threadId, original.id)).toBe(reply.id);
    const path = store.activePath(bot.threadId);
    expect(path.map((m) => m.text)).toContain("v1");
    expect(path.map((m) => m.text)).not.toContain("v2");

    expect(store.setActiveLeaf(bot.threadId, "nope")).toBeNull();
  });

  it("persists the branch tree and active leaf across a restart", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const original = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "v1" });
    const edited = store.branchMessage(bot.threadId, original.id, "v2")!;

    const reloaded = new Store(selection);
    expect(reloaded.activeLeaf(bot.threadId)).toBe(edited.id);
    expect(reloaded.messagesFor(bot.threadId).map((m) => m.text)).toContain("v1");
    expect(reloaded.activePath(bot.threadId).map((m) => m.text)).not.toContain("v1");
  });

  it("clears a thread durably without changing its owner or other transcripts", () => {
    const store = new Store(selection);
    const clearedBot = store.createBot();
    const untouchedBot = store.createBot();
    const untouchedMessages = store.messagesFor(untouchedBot.threadId).map((message) => message.id);
    const original = store.appendMessage(clearedBot.threadId, { role: "user", kind: "text", text: "v1" });
    store.branchMessage(clearedBot.threadId, original.id, "v2");
    store.patchBot(clearedBot.id, { resumeCursors: { claude: "session-with-old-context" }, rewound: true, unread: true });

    store.clearThread(clearedBot.threadId);

    expect(store.bot(clearedBot.id)?.threadId).toBe(clearedBot.threadId);
    expect(store.messagesFor(clearedBot.threadId)).toEqual([]);
    expect(store.activeLeaf(clearedBot.threadId)).toBeNull();
    expect(store.bot(clearedBot.id)).toMatchObject({ resumeCursors: {}, rewound: false, unread: false });
    expect(store.messagesFor(untouchedBot.threadId).map((message) => message.id)).toEqual(untouchedMessages);

    const reloaded = new Store(selection);
    expect(reloaded.bot(clearedBot.id)?.threadId).toBe(clearedBot.threadId);
    expect(reloaded.messagesFor(clearedBot.threadId)).toEqual([]);
    expect(reloaded.activeLeaf(clearedBot.threadId)).toBeNull();
    expect(reloaded.bot(clearedBot.id)).toMatchObject({ resumeCursors: {}, rewound: false, unread: false });
    expect(reloaded.messagesFor(untouchedBot.threadId).map((message) => message.id)).toEqual(untouchedMessages);
  });

  it("migrates a pre-branching flat transcript file", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const legacy = [
      { id: "m1", role: "bot", kind: "text", text: "hello", at: 1 },
      { id: "m2", role: "user", kind: "text", text: "hi", at: 2 },
    ];
    writeFileSync(join(DATA_DIR, `messages-${bot.threadId}.json`), JSON.stringify(legacy));

    const reloaded = new Store(selection);
    const messages = reloaded.messagesFor(bot.threadId);
    expect(messages.map((m) => m.parentId)).toEqual([null, "m1"]);
    expect(reloaded.activeLeaf(bot.threadId)).toBe("m2");
    expect(reloaded.activePath(bot.threadId).map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  it("tolerates a corrupt bots.json by starting empty", () => {
    const store = new Store(selection);
    store.createBot();
    writeFileSync(join(DATA_DIR, "bots.json"), "{not json");

    const reloaded = new Store(selection);
    expect(reloaded.bots).toEqual([]);
  });

  it("busy is wiped even when bots.json says otherwise", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const raw: BotRecord[] = JSON.parse(readFileSync(join(DATA_DIR, "bots.json"), "utf8"));
    raw.find((b) => b.id === bot.id)!.busy = true;
    writeFileSync(join(DATA_DIR, "bots.json"), JSON.stringify(raw));

    const reloaded = new Store(selection);
    expect(reloaded.bot(bot.id)?.busy).toBe(false);
  });

  it("keeps room activity state transient across restarts", () => {
    const store = new Store(selection);
    const first = store.createBot();
    const second = store.createBot();
    const group = store.createGroup("Work room", [first.id, second.id]);
    expect(group.autoHandoffs).toBe(false);
    store.patchGroup(group.id, { autoHandoffs: true, busyBotId: first.id, queuedBotIds: [second.id] });

    expect(store.group(group.id)).toMatchObject({ busyBotId: first.id, queuedBotIds: [second.id] });
    const saved = JSON.parse(readFileSync(join(DATA_DIR, "groups.json"), "utf8"));
    expect(saved[0]).not.toHaveProperty("busyBotId");
    expect(saved[0]).not.toHaveProperty("queuedBotIds");

    const reloaded = new Store(selection);
    expect(reloaded.group(group.id)).toMatchObject({ autoHandoffs: true, busyBotId: null, queuedBotIds: [] });
  });

  it("defaults legacy rooms to manual handoffs", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const group = store.createGroup("Legacy room", [bot.id]);
    const saved = JSON.parse(readFileSync(join(DATA_DIR, "groups.json"), "utf8"));
    delete saved[0].autoHandoffs;
    writeFileSync(join(DATA_DIR, "groups.json"), JSON.stringify(saved));

    expect(new Store(selection).group(group.id)?.autoHandoffs).toBe(false);
  });

  it("persists messages with attachments and preserves them across branching and restart", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const att = {
      id: "att-1",
      name: "diagram.png",
      mimeType: "image/png",
      size: 1024,
      dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    };
    const userMsg = store.appendMessage(bot.threadId, {
      role: "user",
      kind: "text",
      text: "Look at this image",
      attachments: [att],
    });

    expect(userMsg.attachments).toEqual([att]);

    // Branching preserves attachments if none passed
    const branched = store.branchMessage(bot.threadId, userMsg.id, "Edited text without re-upload");
    expect(branched?.attachments).toEqual([att]);

    // Branching with new attachments replaces them
    const att2 = { ...att, id: "att-2", name: "code.ts" };
    const branchedWithNew = store.branchMessage(bot.threadId, userMsg.id, "Second edit", [att2]);
    expect(branchedWithNew?.attachments).toEqual([att2]);

    // Reload from disk
    const reloaded = new Store(selection);
    const msgs = reloaded.messagesFor(bot.threadId);
    const persistedOriginal = msgs.find((m) => m.id === userMsg.id);
    expect(persistedOriginal?.attachments).toEqual([att]);
  });
});

