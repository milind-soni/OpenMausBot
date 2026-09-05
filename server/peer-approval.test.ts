// The approval card's LIFECYCLE, as opposed to its verdict. A card that is
// raised but never settled keeps matching the client's "unanswered" filter,
// and the composer stays disabled behind it — so a gate that works
// perfectly can still make a thread unusable. These tests pin the settle.
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import {
  cancelPeerApprovalsFor,
  cancelPeerApprovalsForThread,
  dismissStalePeerCards,
  peerAllowKey,
  requestPeerApproval,
  resolvePeerComms,
  type ApprovalBus,
} from "./peer-approval.ts";
import { closeMessageDb } from "./message-db.ts";
import type { Notification } from "./notify.ts";
import { Store, type BotRecord } from "./store.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "fake-model" });

function pendingCard(store: Store, bot: BotRecord) {
  return store
    .messagesFor(bot.threadId)
    .find((m) => m.kind === "options" && m.card?.requestId && !m.card.answered && !m.card.dismissed);
}

describe("peer approval card lifecycle", () => {
  let store: Store;
  let bus: ApprovalBus;
  let from: BotRecord;
  let target: BotRecord;

  beforeEach(() => {
    store = new Store(selection);
    from = store.patchBot(store.createBot().id, { name: "Asker", approvePeerComms: true })!;
    target = store.patchBot(store.createBot().id, { name: "Helper" })!;
    bus = { store, broadcast: () => {} };
  });

  afterEach(() => {
    closeMessageDb();
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("settles the card when the user allows, so the composer unblocks", async () => {
    const verdict = requestPeerApproval(bus, from, target, "ping", "ask_bot");
    const card = pendingCard(store, from);
    expect(card).toBeTruthy();

    expect(resolvePeerComms(bus, card!.card!.requestId!, "allow")).toBe(true);
    expect(await verdict).toBe("allow");

    // the card the client renders must now be answered — this is the bit
    // whose absence bricked the thread
    const settled = store.messagesFor(from.threadId).find((m) => m.id === card!.id);
    expect(settled?.card?.answered).toBe("allow");
    expect(settled?.card?.dismissed).toBe(false);
    expect(pendingCard(store, from)).toBeUndefined();
  });

  it("settles the card on deny too", async () => {
    const verdict = requestPeerApproval(bus, from, target, "ping", "delegate_bot");
    const card = pendingCard(store, from)!;
    resolvePeerComms(bus, card.card!.requestId!, "deny");
    expect(await verdict).toBe("deny");
    expect(store.messagesFor(from.threadId).find((m) => m.id === card.id)?.card?.answered).toBe("deny");
  });

  // The card is the one bot-to-bot event that blocks on a person. Everything
  // else a hop does is deliberately silent; this must not be.
  it("tells the person the bot is waiting on them: a waiting state and a notification", async () => {
    const frames: Array<Notification | null> = [];
    bus = { store, broadcast: () => {}, notify: (frame) => frames.push(frame) };
    store.setActivity(from.id, "working"); // mid-turn, the way ask_bot always is

    const verdict = requestPeerApproval(bus, from, target, "Helper, can you take the deploy?", "ask_bot");
    const card = pendingCard(store, from)!;

    expect(store.bot(from.id)?.activity).toBe("waiting-on-you");
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      kind: "approval",
      botId: from.id,
      threadId: from.threadId,
      title: "Asker needs approval",
    });
    expect(frames[0]?.body).toContain("@Asker wants to contact @Helper");
    expect(frames[0]?.body).toContain("Helper, can you take the deploy?");

    // answered: the turn is working again, and nothing buzzes twice
    resolvePeerComms(bus, card.card!.requestId!, "allow");
    expect(await verdict).toBe("allow");
    expect(store.bot(from.id)?.activity).toBe("working");
    expect(frames).toHaveLength(1);
  });

  it("aims the notification at the room when the card is raised there", () => {
    const frames: Array<Notification | null> = [];
    bus = { store, broadcast: () => {}, notify: (frame) => frames.push(frame) };
    const room = store.createGroup("Standup", [from.id, target.id], false);

    void requestPeerApproval(bus, from, target, "ping", "post_to_room", room.threadId);

    expect(frames[0]).toMatchObject({
      kind: "approval",
      threadId: room.threadId,
      groupId: room.id,
      title: "Asker in Standup needs approval",
    });
    cancelPeerApprovalsForThread(room.threadId);
  });

  it("stays quiet when a standing grant answers without a card", async () => {
    const frames: Array<Notification | null> = [];
    bus = { store, broadcast: () => {}, notify: (frame) => frames.push(frame) };
    store.patchBot(from.id, { alwaysAllow: [peerAllowKey("ask_bot", target.id)] });
    store.setActivity(from.id, "working");

    await expect(requestPeerApproval(bus, from, target, "ping", "ask_bot")).resolves.toBe("allow");
    expect(frames).toEqual([]);
    expect(store.bot(from.id)?.activity).toBe("working");
  });

  it("answers an unknown requestId as not-ours, so provider cards still route", () => {
    expect(resolvePeerComms(bus, "not-a-peer-request", "allow")).toBe(false);
  });

  it("keys persistent grants by target identity, not mutable or duplicate names", async () => {
    const originalName = target.name;
    store.patchBot(from.id, { alwaysAllow: [peerAllowKey("ask_bot", target.id)] });
    store.patchBot(target.id, { name: "Renamed helper" });

    await expect(requestPeerApproval(bus, from, target, "ping", "ask_bot")).resolves.toBe("allow");
    expect(pendingCard(store, from)).toBeUndefined();

    const impostor = store.patchBot(store.createBot().id, { name: originalName })!;
    const verdict = requestPeerApproval(bus, from, impostor, "ping", "ask_bot");
    const card = pendingCard(store, from);
    expect(card).toBeTruthy();
    cancelPeerApprovalsFor(impostor.id);
    await expect(verdict).resolves.toBe("deny");
  });

  it("denies and settles when the bot on either side is deleted", async () => {
    const verdict = requestPeerApproval(bus, from, target, "ping", "ask_bot");
    const card = pendingCard(store, from)!;

    cancelPeerApprovalsFor(target.id);

    expect(await verdict).toBe("deny");
    const settled = store.messagesFor(from.threadId).find((m) => m.id === card.id);
    expect(settled?.card?.answered).toBe("deny");
    expect(settled?.card?.dismissed).toBe(true); // not the user's answer
  });

  it("denies and settles approvals owned by an interrupted thread", async () => {
    const verdict = requestPeerApproval(bus, from, target, "ping", "ask_bot");
    const card = pendingCard(store, from)!;

    cancelPeerApprovalsForThread(from.threadId);

    expect(await verdict).toBe("deny");
    const settled = store.messagesFor(from.threadId).find((m) => m.id === card.id);
    expect(settled?.card?.answered).toBe("deny");
    expect(settled?.card?.dismissed).toBe(true);
    expect(pendingCard(store, from)).toBeUndefined();
  });

  it("dismisses cards left by a previous run, which nothing can answer", () => {
    // a card on disk whose in-memory approval died with the process
    const orphan = store.appendMessage(from.threadId, {
      role: "bot",
      kind: "options",
      card: {
        title: "@Asker wants to contact @Helper",
        subtitle: "ping",
        options: ["Allow", "Deny"],
        requestId: "from-a-dead-process",
        tool: "ask_bot",
      },
    });

    expect(dismissStalePeerCards(bus)).toBe(1);
    const settled = store.messagesFor(from.threadId).find((m) => m.id === orphan.id);
    expect(settled?.card?.dismissed).toBe(true);
    // and it is idempotent — a second boot must not re-dismiss or double count
    expect(dismissStalePeerCards(bus)).toBe(0);
  });

  it("dismisses stale cards in non-active task threads", () => {
    const background = store.createTask(from.id, "Background", false)!;
    const orphan = store.appendMessage(background.threadId, {
      role: "bot",
      kind: "options",
      card: {
        title: "@Asker wants to contact @Helper",
        subtitle: "ping",
        options: ["Allow", "Deny"],
        requestId: "background-dead-process",
        tool: "ask_bot",
      },
    });

    expect(dismissStalePeerCards(bus)).toBe(1);
    expect(
      store.messagesFor(background.threadId).find((message) => message.id === orphan.id)?.card?.dismissed,
    ).toBe(true);
  });

  it("dismisses a stale card left in a room's thread, not just a bot's", () => {
    // post_to_room and ask_bot both run from a room turn, and the card goes
    // into the thread the caller is speaking from — the room's. Quitting the
    // app with one open used to leave that room's composer blocked forever.
    const room = store.createGroup("Standup", [from.id, target.id]);
    const orphan = store.appendMessage(room.threadId, {
      role: "bot",
      kind: "options",
      card: {
        title: "@Asker wants to post in “Standup”",
        subtitle: "deploy is green",
        options: ["Allow", "Deny"],
        requestId: "room-card-from-a-dead-process",
        tool: "post_to_room",
      },
    });

    expect(dismissStalePeerCards(bus)).toBe(1);
    const settled = store.messagesFor(room.threadId).find((message) => message.id === orphan.id);
    expect(settled?.card?.dismissed, "a room's composer stayed blocked after a restart").toBe(true);
    expect(settled?.card?.answered).toBe("deny");
    expect(dismissStalePeerCards(bus)).toBe(0);
  });

  it("dismisses a stale card left in a room's background task thread", () => {
    const room = store.createGroup("Release", [from.id, target.id]);
    const task = store.createGroupTask(room.id, "Cut 1.2", false)!;
    store.appendMessage(task.threadId, {
      role: "bot",
      kind: "options",
      card: {
        title: "@Asker wants to contact @Helper",
        subtitle: "ping",
        options: ["Allow", "Deny"],
        requestId: "room-task-card-from-a-dead-process",
        tool: "ask_bot",
      },
    });

    expect(dismissStalePeerCards(bus)).toBe(1);
  });

  it("leaves a live card alone at boot", async () => {
    void requestPeerApproval(bus, from, target, "ping", "ask_bot");
    expect(pendingCard(store, from)).toBeTruthy();
    expect(dismissStalePeerCards(bus)).toBe(0);
    expect(pendingCard(store, from)).toBeTruthy();
    cancelPeerApprovalsFor(from.id); // don't leave a timer pending
  });
});
