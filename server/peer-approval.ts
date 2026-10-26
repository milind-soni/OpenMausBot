// Harness-native approval cards for peer comms (approvePeerComms), resolved before an answer reaches the provider adapter.

import { newId } from "./contracts.ts";
import { optionCardsForTools } from "./message-db.ts";
import { buildNotification, type Notification } from "./notify.ts";
import { peerAllowKey, type PeerAction } from "./peer-approval-key.ts";
import type { BotRecord, Message, Store } from "./store.ts";

export { peerAllowKey } from "./peer-approval-key.ts";

/** Only allow authorizes work; absence of an answer is not a user decision. */
export type PeerApprovalOutcome = "allow" | "deny" | "cancelled";
export type PeerApprovalFailure = Exclude<PeerApprovalOutcome, "allow">;

export function peerApprovalFailure(outcome: PeerApprovalFailure): {
  error: string;
  approvalOutcome: PeerApprovalFailure;
  approvalSource: "user" | "system";
} {
  return {
    error: outcome === "deny" ? "denied by user"
      : "the approval was cancelled before a decision",
    approvalOutcome: outcome,
    approvalSource: outcome === "deny" ? "user" : "system",
  };
}

export interface ApprovalBus {
  store: Store;
  broadcast: (payload: Record<string, unknown>) => void;
  notify?: (notification: Notification | null) => void;
  autoApply?: (botId: string, threadId: string) => boolean;
  onPeerApprovalPending?: (from: BotRecord, target: PeerApprovalTarget, action: PeerAction, sourceThreadId: string, message: string) => void;
}

interface Pending {
  resolve: (result: PeerApprovalOutcome) => void;
  fromBotId: string;
  toBotId: string;
  message: string;
  threadId: string;
  messageId: string;
  bus: ApprovalBus;
}

function settleCard(pending: Pending, behavior: string, source: "user" | "system"): void {
  const existing = pending.bus.store
    .messagesFor(pending.threadId)
    .find((m) => m.id === pending.messageId);
  if (!existing?.card || existing.card.answered) return;
  pending.bus.store.patchMessage(pending.threadId, pending.messageId, {
    card: { ...existing.card, answered: behavior, dismissed: source !== "user" },
  });
  const store = pending.bus.store;
  const task = store.projectBotForTask(pending.fromBotId, pending.threadId);
  if (task) {
    if (task.activity === "waiting-on-you") store.setTaskActivity(task.id, pending.threadId, "working");
  } else if (store.groupByThread(pending.threadId)) {
    const waiting = store.bot(pending.fromBotId);
    if (waiting?.activity === "waiting-on-you") store.setActivity(waiting.id, "working");
  }
}

const pendingComms = new Map<string, Pending>();

function allowKeyAllowed(from: BotRecord, allowKey: string): boolean {
  return from.alwaysAllow?.includes(allowKey) ?? false;
}

export interface PeerApprovalTarget {
  id: string;
  name: string;
}

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

function announceCard(bus: ApprovalBus, from: BotRecord, card: Message, sourceThreadId: string): void {
  const task = bus.store.projectBotForTask(from.id, sourceThreadId);
  const room = bus.store.groupByThread(sourceThreadId);
  if (task) {
    if (task.busy) bus.store.setTaskActivity(from.id, sourceThreadId, "waiting-on-you");
  } else if (room && bus.store.bot(from.id)?.busy) {
    bus.store.setActivity(from.id, "waiting-on-you");
  }
  const group = room && !room.dm ? { id: room.id, name: room.name } : undefined;
  const title = card.card?.title ?? "";
  const detail = card.card?.subtitle ? `${title} — ${card.card.subtitle}` : title;
  bus.notify?.(buildNotification("approval", from, sourceThreadId, detail, { avatarUrl: from.avatarUrl, group }));
}

export function requestPeerApproval(
  bus: ApprovalBus,
  from: BotRecord,
  target: PeerApprovalTarget,
  message: string,
  action: PeerAction,
  sourceThreadId = from.threadId,
): Promise<PeerApprovalOutcome> {
  if (bus.autoApply?.(from.id, sourceThreadId) || allowKeyAllowed(from, peerAllowKey(action, target.id))) {
    return Promise.resolve("allow");
  }
  return new Promise((resolve) => {
    const requestId = newId();
    // The card must exist before the entry, so an answer or a cancellation can always settle it.
    const card = pushApprovalCard(bus, from, target, message, action, requestId, sourceThreadId);
    announceCard(bus, from, card, sourceThreadId);
    pendingComms.set(requestId, {
      resolve,
      fromBotId: from.id,
      toBotId: target.id,
      message,
      threadId: sourceThreadId,
      messageId: card.id,
      bus,
    });
    try {
      bus.onPeerApprovalPending?.(from, target, action, sourceThreadId, message);
    } catch (error) {
      console.warn(`peer approval ${requestId}: pending hook failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

/** Call before forwarding an answer to the provider adapter; true when it settled a peer approval. */
export function resolvePeerComms(
  _bus: ApprovalBus,
  requestId: string,
  behavior: string | undefined,
): boolean {
  const pending = pendingComms.get(requestId);
  if (!pending) return false;
  pendingComms.delete(requestId);
  const allow = behavior === "allow";
  settleCard(pending, allow ? "allow" : "deny", "user");
  pending.resolve(allow ? "allow" : "deny");
  return true;
}

export function cancelPeerApprovalsFor(botId: string): void {
  for (const [requestId, pending] of Array.from(pendingComms)) {
    if (pending.fromBotId !== botId && pending.toBotId !== botId) continue;
    pendingComms.delete(requestId);
      settleCard(pending, "deny", "system");
    pending.resolve("cancelled");
  }
}

export function cancelPeerApprovalsForThread(threadId: string): void {
  for (const [requestId, pending] of pendingComms) {
    if (pending.threadId !== threadId) continue;
    pendingComms.delete(requestId);
      settleCard(pending, "deny", "system");
    pending.resolve("cancelled");
  }
}

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

export function dismissStalePeerCards(bus: ApprovalBus): number {
  let dismissed = 0;
  const threads = peerCardThreads(bus);
  for (const { threadId, messageId } of optionCardsForTools(Object.keys(ACTION_VERB))) {
    if (!threads.has(threadId)) continue;
    const card = bus.store.messagesFor(threadId).find((message) => message.id === messageId)?.card;
    if (!card?.requestId || card.answered || card.dismissed) continue;
    if (pendingComms.has(card.requestId)) continue;
    const patched = bus.store.patchMessage(threadId, messageId, {
      card: { ...card, answered: "deny", dismissed: true },
    });
    if (patched) dismissed += 1;
  }
  return dismissed;
}
