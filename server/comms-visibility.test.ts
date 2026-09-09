import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import {
  getOrCreateChannel,
  mirrorActivity,
  mirrorExchange,
  mirrorReply,
  type CommsBus,
} from "./comms-visibility.ts";
import { closeMessageDb } from "./message-db.ts";
import { Store, type StoreChange } from "./store.ts";

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

describe("bot⇄bot mirrors and the badge", () => {
  /** A pair plus their auto-created channel, watching every store change
   * from the moment the channel exists — the mirrors' own writes only. */
  const pair = (dm = true) => {
    const store = new Store(selection);
    const from = store.createBot({ name: "Forge", section: "Agents" });
    const target = store.createBot({ name: "Quarry", section: "Agents" });
    const room = dm ? undefined : store.createGroup("Planning", [from.id, target.id], false, "Agents");
    const channel = getOrCreateChannel(store, from, target, room);
    const changes: StoreChange[] = [];
    store.onChange((change) => changes.push(change));
    const bus: CommsBus = { store, broadcast: () => {} };
    return { store, from, target, channel, bus, changes };
  };
  const groupFrames = (changes: StoreChange[], groupId: string) =>
    changes.filter((change) => change.type === "group" && change.groupId === groupId).length;

  it("keeps the whole record of a pair exchange while raising no badge", () => {
    const { store, from, target, channel, bus, changes } = pair();
    mirrorExchange(bus, from, target, "can you take the deploy?", channel);

    // the record, unabridged: the channel has the message and both 1:1
    // threads have their clickable chip
    expect(store.messagesFor(channel.threadId).some((m) => m.text === "can you take the deploy?")).toBe(true);
    expect(
      store.messagesFor(from.threadId).some((m) => m.tool?.name === "Messaged @Quarry" && m.comm?.groupId === channel.id),
    ).toBe(true);
    expect(
      store.messagesFor(target.threadId).some((m) => m.tool?.name === "Message from @Forge" && m.comm?.groupId === channel.id),
    ).toBe(true);
    // ...and no badge, but still a group frame, so the channel keeps its
    // place in the sidebar and the user can open it and read everything
    expect(store.group(channel.id)?.unread).toBe(false);
    expect(groupFrames(changes, channel.id)).toBe(1);
  });

  it("keeps a peer reply and a terminal chip silent in the same way", () => {
    const { store, target, channel, bus, changes } = pair();
    mirrorReply(bus, target, "on it", channel);
    mirrorActivity(bus, target, channel, "Delegated turn completed", true);

    expect(store.messagesFor(channel.threadId).some((m) => m.text === "on it")).toBe(true);
    expect(store.messagesFor(channel.threadId).some((m) => m.tool?.name === "Delegated turn completed")).toBe(true);
    expect(store.group(channel.id)?.unread).toBe(false);
    expect(groupFrames(changes, channel.id)).toBe(2);
  });

  it("still badges a shared room — people are reading that one", () => {
    const { store, from, target, channel, bus } = pair(false);
    expect(channel.dm).toBeFalsy();
    mirrorExchange(bus, from, target, "@Quarry can you take the deploy?", channel);
    expect(store.group(channel.id)?.unread).toBe(true);
  });

  it("lets a caller ask for the badge on a pair channel anyway", () => {
    const { store, from, target, channel, bus } = pair();
    mirrorExchange(bus, from, target, "heads up", channel, from.threadId, true);
    expect(store.group(channel.id)?.unread).toBe(true);
    store.patchGroup(channel.id, { unread: false });
    mirrorReply(bus, target, "noted", channel, true);
    expect(store.group(channel.id)?.unread).toBe(true);
    store.patchGroup(channel.id, { unread: false });
    mirrorActivity(bus, target, channel, "Delegated turn completed", true, true);
    expect(store.group(channel.id)?.unread).toBe(true);
  });
});
