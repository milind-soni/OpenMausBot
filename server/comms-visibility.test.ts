import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BOT_CHATS_SECTION } from "../shared/sidebar-layout.ts";
import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { getOrCreateChannel } from "./comms-visibility.ts";
import { closeMessageDb } from "./message-db.ts";
import { Store } from "./store.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "fake-model" });

describe("getOrCreateChannel", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });
  afterEach(() => {
    closeMessageDb();
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("files a new bot chat under Bot Chats, not the sender's team section", () => {
    const store = new Store(selection);
    const from = store.createBot({ name: "Forge", section: "Agents" });
    const target = store.createBot({ name: "Quarry", section: "Agents" });
    const channel = getOrCreateChannel(store, from, target);
    expect(channel.dm).toBe(true);
    expect(channel.section).toBe(BOT_CHATS_SECTION);
    expect(channel.name).toContain("⇄");
  });

  it("moves an existing Agents DM into Bot Chats the next time the pair talks", () => {
    const store = new Store(selection);
    const from = store.createBot({ name: "Forge", section: "Agents" });
    const target = store.createBot({ name: "Quarry", section: "Agents" });
    const stale = store.createGroup("Forge ⇄ Quarry", [from.id, target.id], true, "Agents");
    const channel = getOrCreateChannel(store, from, target);
    expect(channel.id).toBe(stale.id);
    expect(channel.section).toBe(BOT_CHATS_SECTION);
  });
});
