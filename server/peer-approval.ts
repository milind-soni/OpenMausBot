// Harness-native peer-comm approval gate.
//
// A bot with `approvePeerComms = true` may not call ask_bot or
// delegate_bot without a human approving the specific contact. The
// approval rides on the same options-card flow provider permissions
// already use: a card pushed into the SOURCE bot's thread with a
// `requestId`, answered by the user via /api/bots/:id/respond (or
// /api/threads/:id/respond) which the harness intercepts via
// `resolvePeerComms` BEFORE forwarding to the provider adapter. That
// way nothing front-end has to learn about peer comms.
//
// "Always allow" rides on the existing per-bot `alwaysAllow` list. The
// card carries an ID-based `allowKey` and
// the user-facing Always-allow flow already mirrors that key back into
// `alwaysAllow`, so the two sides never disagree about what was granted.

import { newId } from "./contracts.ts";
import { buildNotification, type Notification } from "./notify.ts";
import { peerAllowKey, type PeerAction } from "./peer-approval-key.ts";
import type { BotRecord, Message, Store } from "./store.ts";

export { peerAllowKey } from "./peer-approval-key.ts";

/** What a peer-approval helper needs from the outside world: the store
 * for thread append + persist, and the SSE broadcaster so the chat
 * updates without waiting for a refresh. */
export interface ApprovalBus {
  store: Store;
  /** SSE broadcast (kind: "message" envelope). */
  broadcast: (payload: Record<string, unknown>) => void;
  /** Where a "blocked on you" frame goes. Optional: the boot-time cleanup
   * and the settle paths only ever answer cards, and never raise one. */
  notify?: (notification: Notification | null) => void;
}

interface Pending {
  resolve: (result: "allow" | "deny") => void;
  /** Frees the requestId if the user never answers. */
  timer: ReturnType<typeof setTimeout>;
  fromBotId: string;
  toBotId: string;
  message: string;
  /** Where the card lives, so answering it can settle it. A card that is
   * never settled keeps matching the client's "unanswered" filter, and the
   * composer stays disabled behind it — the thread is unusable from then on. */
  threadId: string;
  messageId: string;
  bus: ApprovalBus;
}

/** Mark the card answered so the UI stops treating it as pending. Mirrors
 * what the `request.resolved` fold does for provider cards; a harness-native
 * card never emits that event, so it has to settle itself. */
function settleCard(pending: Pending, behavior: string, source: "user" | "system"): void {
  const existing = pending.bus.store
    .messagesFor(pending.threadId)
    .find((m) => m.id === pending.messageId);
  if (!existing?.card || existing.card.answered) return;
  pending.bus.store.patchMessage(pending.threadId, pending.messageId, {
    card: { ...existing.card, answered: behavior, dismissed: source !== "user" },
  });
  // answered (by whoever): the turn is working again — the same hand-back
  // the request.resolved fold does for a provider's card
  const waiting = pending.bus.store.bot(pending.fromBotId);
  if (waiting?.activity === "waiting-on-you") pending.bus.store.setActivity(waiting.id, "working");
}

/** requestId → pending ask. Lives only in memory — restarting the
 * server cancels every in-flight approval, like provider permissions do. */
const pendingComms = new Map<string, Pending>();

const APPROVAL_TIMEOUT_MS = 15 * 60_000;

/** The narrow grant "always allow" remembers for a peer comm. Mirrored
 * back into `bot.alwaysAllow` when the user picks "Always allow" on the
 * card. */
function allowKeyAllowed(from: BotRecord, allowKey: string): boolean {
  return from.alwaysAllow?.includes(allowKey) ?? false;
}

/** Who a peer action is aimed at. A bot for ask_bot and delegate_bot, a
 * room for post_to_room — the gate only ever needs its id and its name. */
export interface PeerApprovalTarget {
  id: string;
  name: string;
}

/** How the card names what is about to happen. */
const ACTION_VERB: Record<PeerAction, string> = {
  ask_bot: "contact",
  delegate_bot: "delegate to",
  post_to_room: "post in",
};

function pushApprovalCard(
  bus: ApprovalBus,
  from: BotRecord,
  target: PeerApprovalTarget,
  message: string,
  action: PeerAction,
  requestId: string,
  sourceThreadId: string,
): Message {
  const subtitle = message.length > 200 ? `${message.slice(0, 200)}…` : message;
  const note = bus.store.appendMessage(sourceThreadId, {
    role: "bot",
    kind: "options",
    card: {
      // a room is named as a room; only a bot gets an @
      title: `@${from.name} wants to ${ACTION_VERB[action]} ${action === "post_to_room" ? `“${target.name}”` : `@${target.name}`}`,
      subtitle,
      options: ["Allow", "Deny", "Always allow"],
      requestId,
      tool: action,
      allowKey: peerAllowKey(action, target.id),
    },
  });
  return note;
}

/** This card is the one bot-to-bot event that blocks on a person — for up
 * to fifteen minutes — so it gets exactly what a provider's card gets: the
 * bot shows as waiting rather than working, and a "needs approval" frame
 * goes out aimed at the thread the card is in. Without this the sidebar
 * read "Working…" with no dot and no banner until the timer denied it, and
 * the bot then reported it could not reach a teammate nobody knew it had
 * asked for. A bot speaking in a room is not reachable in its own thread,
 * so the room the card landed in is named, the way takeover does. */
function announceCard(bus: ApprovalBus, from: BotRecord, card: Message, sourceThreadId: string): void {
  // the bot is not working now — it is waiting on a person. A delegation
  // drained after its turn has already settled is idle, and stays so.
  const live = bus.store.bot(from.id);
  if (live?.busy) bus.store.setActivity(from.id, "waiting-on-you");
  const room = bus.store.groupByThread(sourceThreadId);
  const group = room && !room.dm ? { id: room.id, name: room.name } : undefined;
  const title = card.card?.title ?? "";
  const detail = card.card?.subtitle ? `${title} — ${card.card.subtitle}` : title;
  bus.notify?.(buildNotification("approval", from, sourceThreadId, detail, { avatarUrl: from.avatarUrl, group }));
}

/** Ask the user (in the source task thread) whether `from` may `action` `target`.
 * Resolves with `"allow"` or `"deny"`. If `from.alwaysAllow` already
 * covers the (action, target) pair, returns `"allow"` immediately
 * without a card. */
export function requestPeerApproval(
  bus: ApprovalBus,
  from: BotRecord,
  target: PeerApprovalTarget,
  message: string,
  action: PeerAction,
  sourceThreadId = from.threadId,
): Promise<"allow" | "deny"> {
  if (allowKeyAllowed(from, peerAllowKey(action, target.id))) {
    return Promise.resolve("allow");
  }
  return new Promise((resolve) => {
    const requestId = newId();
    // the card has to exist before the entry, so a timeout or an answer can
    // always find it to settle
    const card = pushApprovalCard(bus, from, target, message, action, requestId, sourceThreadId);
    announceCard(bus, from, card, sourceThreadId);
    const timer = setTimeout(() => {
      // 15 minutes without an answer → deny. Keeps an unattended bot from
      // stalling its own turn forever (matches the Claude broker timeout).
      const pending = pendingComms.get(requestId);
      if (!pending) return;
      pendingComms.delete(requestId);
      settleCard(pending, "deny", "system");
      resolve("deny");
    }, APPROVAL_TIMEOUT_MS);
    timer.unref?.(); // a waiting card must never hold the process open
    pendingComms.set(requestId, {
      resolve,
      timer,
      fromBotId: from.id,
      toBotId: target.id,
      message,
      threadId: sourceThreadId,
      messageId: card.id,
      bus,
    });
  });
}

/** Called by the respond endpoints BEFORE forwarding to the provider
 * adapter. Returns true if the requestId belonged to a pending peer
 * approval (and resolves it); false if it was a provider request and
 * the endpoint should keep going. */
export function resolvePeerComms(
  _bus: ApprovalBus,
  requestId: string,
  behavior: string | undefined,
): boolean {
  const pending = pendingComms.get(requestId);
  if (!pending) return false;
  pendingComms.delete(requestId);
  clearTimeout(pending.timer);
  const allow = behavior === "allow";
  settleCard(pending, allow ? "allow" : "deny", "user");
  pending.resolve(allow ? "allow" : "deny");
  return true;
}

/** Drop every approval waiting on a bot that no longer exists (or is being
 * deleted), denying it so the caller's turn doesn't wait out the timeout. */
export function cancelPeerApprovalsFor(botId: string): void {
  for (const [requestId, pending] of [...pendingComms]) {
    if (pending.fromBotId !== botId && pending.toBotId !== botId) continue;
    pendingComms.delete(requestId);
    clearTimeout(pending.timer);
    settleCard(pending, "deny", "system");
    pending.resolve("deny");
  }
}

/** Deny every peer-communication approval owned by a thread whose turn was
 * interrupted. Patching the card alone is not enough: the in-memory promise
 * must resolve too, or the delegation queue waits until its 15-minute timer. */
export function cancelPeerApprovalsForThread(threadId: string): void {
  for (const [requestId, pending] of pendingComms) {
    if (pending.threadId !== threadId) continue;
    pendingComms.delete(requestId);
    clearTimeout(pending.timer);
    settleCard(pending, "deny", "system");
    pending.resolve("deny");
  }
}

/** Every thread a peer card can be raised in. A card lands in the thread
 * the CALLER is speaking from, and since a bot's turn can now run in a room
 * — ask_bot and post_to_room are both callable from there — that thread is
 * as often a room's as a bot's. A walk that knew only about bot threads
 * would leave a room's composer blocked behind a card nothing can answer. */
function peerCardThreads(bus: ApprovalBus): Set<string> {
  const threadIds = new Set<string>();
  for (const bot of bus.store.bots) {
    threadIds.add(bot.threadId);
    for (const task of bot.tasks ?? []) threadIds.add(task.threadId);
  }
  for (const group of bus.store.groups) {
    threadIds.add(group.threadId);
    for (const task of group.tasks ?? []) threadIds.add(task.threadId);
  }
  return threadIds;
}

/** Cards left on disk by a previous run can never be answered — their
 * in-memory approval died with the process. Settle them at boot so a
 * crashed run doesn't leave a thread with a permanently blocked composer. */
export function dismissStalePeerCards(bus: ApprovalBus): number {
  let dismissed = 0;
  for (const threadId of peerCardThreads(bus)) {
    for (const message of bus.store.messagesFor(threadId)) {
      const card = message.card;
      if (!card?.requestId || card.answered || card.dismissed) continue;
      if (card.tool !== "ask_bot" && card.tool !== "delegate_bot" && card.tool !== "post_to_room") continue;
      if (pendingComms.has(card.requestId)) continue;
      const patched = bus.store.patchMessage(threadId, message.id, {
        card: { ...card, answered: "deny", dismissed: true },
      });
      if (patched) dismissed += 1;
    }
  }
  return dismissed;
}
