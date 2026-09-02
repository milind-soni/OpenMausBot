import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { getOrCreateChannel } from "./comms-visibility.ts";
import { closeMessageDb } from "./message-db.ts";
import { Store } from "./store.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "fake-model" });

describe("bot-to-bot channel context", () => {
  beforeEach(() => {
    closeMessageDb();
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  afterEach(() => {
    closeMessageDb();
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("keeps a new DM in the sender's semantic section", () => {
    const store = new Store(selection);
    const from = store.createBot({ name: "Forge", section: "Agents" });
    const target = store.createBot({ name: "Quarry", section: "Agents" });

    const channel = getOrCreateChannel(store, from, target);

    expect(channel.dm).toBe(true);
    expect(channel.section).toBe("Agents");
  });

  it("updates an existing DM's context without turning Bot Chats into a stored section", () => {
    const store = new Store(selection);
    const from = store.createBot({ name: "Forge", section: "Agents" });
    const target = store.createBot({ name: "Quarry", section: "Agents" });
    const existing = store.createGroup("Forge ⇄ Quarry", [from.id, target.id], true, "Personal");

    const channel = getOrCreateChannel(store, from, target);

    expect(channel.id).toBe(existing.id);
    expect(channel.section).toBe("Agents");
    expect(channel.section).not.toBe("Bot Chats");
  });

  it("reuses an originating shared group when both bots are members", () => {
    const store = new Store(selection);
    const from = store.createBot({ name: "Forge", section: "Agents" });
    const target = store.createBot({ name: "Quarry", section: "Agents" });
    const shared = store.createGroup("Planning", [from.id, target.id], false, "Agents");

    const channel = getOrCreateChannel(store, from, target, shared);

    expect(channel.id).toBe(shared.id);
    expect(channel.dm).toBeFalsy();
  });

  it("falls back to a DM when the originating group is missing a member", () => {
    const store = new Store(selection);
    const from = store.createBot({ name: "Forge", section: "Agents" });
    const target = store.createBot({ name: "Quarry", section: "Agents" });
    const other = store.createBot({ name: "Observer", section: "Agents" });
    const shared = store.createGroup("Planning", [from.id, other.id], false, "Agents");

    const channel = getOrCreateChannel(store, from, target, shared);

    expect(channel.dm).toBe(true);
    expect(store.dmGroup(from.id, target.id)?.id).toBe(channel.id);
  });

  it("ignores a DM passed as the originating group and uses the pair DM fallback", () => {
    const store = new Store(selection);
    const from = store.createBot({ name: "Forge", section: "Agents" });
    const target = store.createBot({ name: "Quarry", section: "Agents" });
    const dm = store.createGroup("Forge ⇄ Quarry", [from.id, target.id], true, "Agents");

    const channel = getOrCreateChannel(store, from, target, dm);

    expect(channel.id).toBe(dm.id);
    expect(channel.dm).toBe(true);
  });
});
