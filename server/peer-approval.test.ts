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
  MAX_PENDING_PEER_APPROVALS,
  MAX_PENDING_PEER_APPROVALS_PER_BOT,
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

function pendingCards(store: Store, bot: BotRecord) {
  return store
    .messagesFor(bot.threadId)
    .filter((m) => m.kind === "options" && m.card?.requestId && !m.card.answered && !m.card.dismissed);
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
    store.setTaskActivity(from.id, from.threadId, "working");

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

  it("aims the notification and legacy activity at the room when the card is raised there", () => {
    const frames: Array<Notification | null> = [];
    bus = { store, broadcast: () => {}, notify: (frame) => frames.push(frame) };
    const room = store.createGroup("Standup", [from.id, target.id], false);
    store.setActivity(from.id, "working");

    void requestPeerApproval(bus, from, target, "ping", "post_to_room", room.threadId);

    expect(frames[0]).toMatchObject({
      kind: "approval",
      threadId: room.threadId,
      groupId: room.id,
      title: "Asker in Standup needs approval",
    });
    expect(store.bot(from.id)?.activity).toBe("waiting-on-you");
    expect(store.taskByThread(from.id, from.threadId)?.activity).toBe("idle");
    cancelPeerApprovalsForThread(room.threadId);
    expect(store.bot(from.id)?.activity).toBe("working");
  });

  it("answers task A's approval after switching to B without unblocking B", async () => {
    const threadA = from.threadId;
    const taskB = store.createTask(from.id, "Independent B", true)!;
    store.setTaskActivity(from.id, threadA, "working");
    store.setTaskActivity(from.id, taskB.threadId, "working");
    const answerA = requestPeerApproval(bus, from, target, "A request", "ask_bot", threadA);
    const answerB = requestPeerApproval(bus, from, target, "B request", "ask_bot", taskB.threadId);
    const cardA = store.messagesFor(threadA).find((message) => message.card?.requestId)!;
    const cardB = store.messagesFor(taskB.threadId).find((message) => message.card?.requestId)!;
    expect(store.taskByThread(from.id, threadA)?.activity).toBe("waiting-on-you");
    expect(store.taskByThread(from.id, taskB.threadId)?.activity).toBe("waiting-on-you");

    resolvePeerComms(bus, cardA.card!.requestId!, "allow");
    await expect(answerA).resolves.toBe("allow");
    expect(store.taskByThread(from.id, threadA)?.activity).toBe("working");
    expect(store.taskByThread(from.id, taskB.threadId)?.activity).toBe("waiting-on-you");
    expect(store.bot(from.id)?.activity).toBe("waiting-on-you");
    expect(store.messagesFor(taskB.threadId).find((message) => message.id === cardB.id)?.card?.answered).toBeUndefined();

    cancelPeerApprovalsForThread(taskB.threadId);
    await expect(answerB).resolves.toBe("deny");
    expect(store.taskByThread(from.id, threadA)?.activity).toBe("working");
  });

  it("stays quiet when a standing grant answers without a card", async () => {
    const frames: Array<Notification | null> = [];
    bus = { store, broadcast: () => {}, notify: (frame) => frames.push(frame) };
    store.patchBot(from.id, { alwaysAllow: [peerAllowKey("ask_bot", target.id)] });
    store.setTaskActivity(from.id, from.threadId, "working");

    await expect(requestPeerApproval(bus, from, target, "ping", "ask_bot")).resolves.toBe("allow");
    expect(frames).toEqual([]);
    expect(store.bot(from.id)?.activity).toBe("working");
  });

  it("honors Full only for the exact source conversation without prompting or notifying", async () => {
    const frames: Array<Notification | null> = [];
    const fullThread = from.threadId;
    const askThread = store.createTask(from.id, "Ask sibling")!.threadId;
    store.patchBot(from.id, { approvalMode: "full" });
    bus = { store, broadcast: () => {}, notify: frame => frames.push(frame),
      autoApply: (botId, threadId) => botId === from.id && threadId === fullThread };
    for (const action of ["ask_bot", "delegate_bot", "post_to_room"] as const) {
      await expect(requestPeerApproval(bus, from, target, "ping", action, fullThread)).resolves.toBe("allow");
    }
    expect(store.messagesFor(fullThread).some(message => message.card?.requestId)).toBe(false);
    expect(frames).toEqual([]);
    const pending = requestPeerApproval(bus, from, target, "ask sibling", "ask_bot", askThread);
    const card = store.messagesFor(askThread).find(message => message.card?.requestId)!.card!;
    expect(card.answered).toBeUndefined();
    resolvePeerComms(bus, card.requestId!, "deny");
    await expect(pending).resolves.toBe("deny");
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

// A looping or unattended fleet must never bury the user in approval cards,
// and a peer request must never gain authority when we cannot ask — the
// budget refuses ("too_many") rather than failing open. `pendingComms` is a
// module-level singleton, so every test here must clean up every card it
// raises (resolve or cancel) or it would bleed into whichever test runs
// next, in this file or another vitest worker sharing the module.
describe("peer approval caps", () => {
  let store: Store;
  let bus: ApprovalBus;

  beforeEach(() => {
    store = new Store(selection);
    bus = { store, broadcast: () => {} };
  });

  afterEach(() => {
    closeMessageDb();
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  function makeBot(name: string): BotRecord {
    return store.patchBot(store.createBot().id, { name })!;
  }

  it("refuses a bot's 4th pending approval with too_many, fails closed (not allow), and leaves the first 3 untouched", async () => {
    const asker = makeBot("Asker");
    const helper = makeBot("Helper");
    const verdicts = Array.from({ length: MAX_PENDING_PEER_APPROVALS_PER_BOT }, (_, i) =>
      requestPeerApproval(bus, asker, helper, `ping ${i}`, "ask_bot"),
    );
    expect(pendingCards(store, asker)).toHaveLength(MAX_PENDING_PEER_APPROVALS_PER_BOT);

    const fourth = await requestPeerApproval(bus, asker, helper, "ping 4", "ask_bot");

    expect(fourth).toBe("too_many");
    expect(fourth).not.toBe("allow"); // fail closed, never open
    expect(pendingCards(store, asker)).toHaveLength(MAX_PENDING_PEER_APPROVALS_PER_BOT);

    cancelPeerApprovalsFor(asker.id);
    await Promise.all(verdicts);
  });

  it("frees a bot's budget once a pending approval is answered", async () => {
    const asker = makeBot("Asker");
    const helper = makeBot("Helper");
    const pending = Array.from({ length: MAX_PENDING_PEER_APPROVALS_PER_BOT }, (_, i) =>
      requestPeerApproval(bus, asker, helper, `ping ${i}`, "ask_bot"),
    );
    const firstCard = pendingCards(store, asker)[0]!;
    resolvePeerComms(bus, firstCard.card!.requestId!, "allow");
    await pending[0];

    const next = requestPeerApproval(bus, asker, helper, "ping again", "ask_bot");
    expect(pendingCards(store, asker)).toHaveLength(MAX_PENDING_PEER_APPROVALS_PER_BOT);

    cancelPeerApprovalsFor(asker.id);
    await Promise.all([...pending.slice(1), next]);
  });

  it("caps each bot independently: bot A at its cap does not block bot B", async () => {
    const botA = makeBot("Asker A");
    const botB = makeBot("Asker B");
    const helper = makeBot("Helper");
    const pendingA = Array.from({ length: MAX_PENDING_PEER_APPROVALS_PER_BOT }, (_, i) =>
      requestPeerApproval(bus, botA, helper, `ping ${i}`, "ask_bot"),
    );

    const verdictB = requestPeerApproval(bus, botB, helper, "ping", "ask_bot");
    expect(pendingCard(store, botB)).toBeTruthy();

    cancelPeerApprovalsFor(botA.id);
    cancelPeerApprovalsFor(botB.id);
    await Promise.all([...pendingA, verdictB]);
  });

  it("refuses a fresh bot once the workspace-wide cap is reached, even under its own per-bot cap", async () => {
    const helper = makeBot("Helper");
    // Spread MAX_PENDING_PEER_APPROVALS cards across enough bots that none of
    // them individually reaches MAX_PENDING_PEER_APPROVALS_PER_BOT.
    const perBot = MAX_PENDING_PEER_APPROVALS_PER_BOT - 1;
    const botCount = Math.ceil(MAX_PENDING_PEER_APPROVALS / perBot);
    const askers = Array.from({ length: botCount }, (_, i) => makeBot(`Asker ${i}`));
    const pending: Array<Promise<"allow" | "deny" | "too_many">> = [];
    for (let i = 0; i < MAX_PENDING_PEER_APPROVALS; i++) {
      const asker = askers[Math.floor(i / perBot)]!;
      pending.push(requestPeerApproval(bus, asker, helper, `ping ${i}`, "ask_bot"));
    }

    const freshBot = makeBot("Fresh asker");
    const verdict = await requestPeerApproval(bus, freshBot, helper, "ping", "ask_bot");

    expect(verdict).toBe("too_many");
    expect(pendingCard(store, freshBot)).toBeUndefined();

    for (const asker of askers) cancelPeerApprovalsFor(asker.id);
    await Promise.all(pending);
  });

  it("still allows a standing grant at or over the cap, and raises no card", async () => {
    const asker = makeBot("Asker");
    const helper = makeBot("Helper");
    store.patchBot(asker.id, { alwaysAllow: [peerAllowKey("ask_bot", helper.id)] });
    const filler = Array.from({ length: MAX_PENDING_PEER_APPROVALS_PER_BOT }, (_, i) =>
      requestPeerApproval(bus, asker, helper, `filler ${i}`, "delegate_bot"),
    );
    expect(pendingCards(store, asker)).toHaveLength(MAX_PENDING_PEER_APPROVALS_PER_BOT);

    const verdict = await requestPeerApproval(bus, asker, helper, "ping", "ask_bot");

    expect(verdict).toBe("allow");
    expect(pendingCards(store, asker)).toHaveLength(MAX_PENDING_PEER_APPROVALS_PER_BOT);

    cancelPeerApprovalsFor(asker.id);
    await Promise.all(filler);
  });
});
