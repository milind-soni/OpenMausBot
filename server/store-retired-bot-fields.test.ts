// What an earlier version saved about bots asking before they contact each other: the fields load as if absent and
// reach is everyone's, a card left open is settled, and an old Team escalations conversation is an ordinary one.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { dismissLeftoverPeerCards } from "./host/leftover-peer-cards.ts";
import { canReach, reachablePeers } from "./peer-roster.ts";
import { Store, type BotRecord } from "./store.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });

describe("data saved with a peers list, a peer-approval switch or an escalations thread", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("load without them, and the bot reaches every other bot", () => {
    const store = new Store(selection);
    const narrow = store.createBot({ name: "Narrow" });
    const other = store.createBot({ name: "Other" });
    const file = join(DATA_DIR, "bots.json");
    const saved: Array<BotRecord & { peers?: string[]; approvePeerComms?: boolean }> = JSON.parse(readFileSync(file, "utf8"));
    const record = saved.find((bot) => bot.id === narrow.id)!;
    record.peers = ["nobody"];
    record.approvePeerComms = true;
    writeFileSync(file, JSON.stringify(saved));

    const reloaded = new Store(selection);
    const bot = reloaded.bot(narrow.id)!;
    expect("peers" in bot).toBe(false);
    expect("approvePeerComms" in bot).toBe(false);
    expect(canReach(bot, reloaded.bot(other.id)!)).toBe(true);
    expect(reachablePeers(reloaded.bots, bot).map((peer) => peer.id)).toEqual([other.id]);
    expect(JSON.stringify(bot)).not.toMatch(/peers|approvePeerComms/);
  });

  it("leave the saved file on the next load, even when that load has nothing else to rewrite", () => {
    const narrow = new Store(selection).createBot({ name: "Narrow" });
    new Store(selection);
    const file = join(DATA_DIR, "bots.json");
    const saved: Array<BotRecord & { peers?: string[]; approvePeerComms?: boolean }> = JSON.parse(readFileSync(file, "utf8"));
    const record = saved.find((bot) => bot.id === narrow.id)!;
    record.peers = ["nobody"];
    record.approvePeerComms = true;
    writeFileSync(file, JSON.stringify(saved));

    new Store(selection);
    const persisted: Array<Record<string, unknown>> = JSON.parse(readFileSync(file, "utf8"));
    expect(persisted.find((entry) => entry.id === narrow.id)).not.toHaveProperty("peers");
    expect(persisted.find((entry) => entry.id === narrow.id)).not.toHaveProperty("approvePeerComms");
  });

  it("settle a peer card left open, so it cannot lock the composer, and leave every other card alone", () => {
    const store = new Store(selection);
    const bot = store.createBot({ name: "Asker" });
    const card = (tool: string, requestId: string) => store.appendMessage(bot.threadId, { role: "bot", kind: "options",
      card: { title: "A question", subtitle: "", options: ["Allow", "Deny"], requestId, tool } });
    const left = card("delegate_bot", "left-open");
    const other = card("Bash", "still-live");
    expect(dismissLeftoverPeerCards(store)).toBe(1);
    const cardOf = (id: string) => store.messagesFor(bot.threadId).find((message) => message.id === id)?.card;
    expect(cardOf(left.id)).toMatchObject({ answered: "deny", dismissed: true });
    expect(cardOf(other.id)?.answered).toBeUndefined();
    expect(dismissLeftoverPeerCards(store)).toBe(0);
  });

  it("keep an old Team escalations conversation readable", () => {
    const store = new Store(selection);
    const chief = store.createBot({ name: "Chief" });
    const old = store.createTask(chief.id, "Team escalations", false)!;
    store.appendMessage(old.threadId, { role: "user", kind: "text", text: "A teammate waits on a sign-in.", peerAsk: { botId: "fox", name: "Fox", unattended: true, incident: { threadId: "t" } } });
    const reloaded = new Store(selection);
    expect(reloaded.taskByThread(chief.id, old.threadId)?.title).toBe("Team escalations");
    expect(reloaded.messagesFor(old.threadId).map((line) => line.text)).toEqual(["A teammate waits on a sign-in."]);
  });
});
