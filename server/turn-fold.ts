// The turn fold's in-flight bookkeeping, extracted from index.ts. The two
// maps are module-level mutable singletons: every fold site, route, and
// helper that reads or writes them imports them from here, so the
// bookkeeping stays one table per server process. The fold body itself
// remains in index.ts. Approval answering and closing live here beside the
// maps they read; the store and provider registry come from ./runtime.ts.
import { DATA_DIR } from "./config.ts";
import type { RequestOutcome } from "./contracts.ts";
import { appendDecision } from "./decision-log.ts";
import { cancelPeerApprovalsForThread } from "./peer-approval.ts";
import { registry, store } from "./runtime.ts";

// keyed by `${threadId}:${itemId}` / `${threadId}:${requestId}` — provider
// item/request ids are only unique within a thread, so two bots acting at
// once can collide on a bare id and patch each other's messages.
export const toolMessageByItem = new Map<string, string>(); // threadId:itemId -> messageId
export const askMessageByRequest = new Map<string, string>(); // threadId:requestId -> messageId

export function requestBehavior(value: unknown): "allow" | "deny" | "answer" | null {
  return value === "allow" || value === "deny" || value === "answer" ? value : null;
}

/** Deliver a person's answer to the engine that asked, and tell the truth
 * about what happened. `unavailable` — the turn ended, the ask timed out,
 * the engine has no asks — is fail-closed: the action was never run. The
 * card is settled and a chip says so, instead of the answer vanishing into
 * a 500 while the card sits open forever. */
export async function answerRequest(
  threadId: string,
  instanceId: string,
  requestId: string,
  behavior: "allow" | "deny" | "answer",
  message?: string,
  decidedFor?: { id: string; name: string },
  /** "Always allow this session": the provider keeps the allow, not the app */
  always?: boolean,
): Promise<RequestOutcome> {
  // Snapshot the card BEFORE delivering the answer: a delivered answer
  // resolves the request synchronously through the fold, which consumes
  // the askMessageByRequest entry — by the time the await returns, nobody
  // remembers which tool this requestId was about.
  const thread = store.messagesFor(threadId);
  const cardMessageId = askMessageByRequest.get(`${threadId}:${requestId}`);
  // The map is an in-flight optimization and disappears on restart; the
  // durable transcript still carries the request id and its audit metadata.
  const cardMessage = cardMessageId
    ? thread.find((m) => m.id === cardMessageId)
    : thread.find((m) => m.card?.requestId === requestId);
  const card = cardMessage?.card;
  const instance = registry.get(instanceId);
  let outcome: RequestOutcome = "unavailable";
  if (instance) {
    try {
      outcome = await instance.adapter.respondToRequest(threadId, requestId, { behavior, message, always: always && behavior === "allow" });
    } catch {
      outcome = "unavailable";
    }
  }
  // An answered question keeps its words. `request.resolved` only records
  // the behavior, so without this the card reads "answer" forever and the
  // person can no longer see what they told the bot.
  if (outcome !== "unavailable" && behavior === "answer" && message && cardMessage) {
    const settled = store.messagesFor(threadId).find((m) => m.id === cardMessage.id)?.card;
    if (settled) {
      store.patchMessage(threadId, cardMessage.id, { card: { ...settled, answeredText: message } });
    }
  }
  // The human's verdict, recorded only when it actually reached the engine:
  // `unavailable` means the action never ran, and a "user-approved" row
  // over a request nothing answered would be the audit log lying. A
  // question's `answer` is conversation, not authorization, so it is not a
  // decision either.
  if (outcome !== "unavailable" && behavior !== "answer") {
    appendDecision(DATA_DIR, {
      threadId,
      requestId,
      botId: decidedFor?.id,
      botName: decidedFor?.name,
      tool: card?.tool,
      summary: card?.subtitle,
      decision: behavior === "allow" ? "user-approved" : "user-denied",
      source: "user",
    });
  }
  if (outcome === "unavailable") {
    // The in-flight map is memory-only. After a restart the card is still on
    // the thread, so fall back to the request it carries — otherwise an
    // unreachable approval is never closed and keeps owning the composer.
    const messageId = askMessageByRequest.get(`${threadId}:${requestId}`);
    const thread = store.messagesFor(threadId);
    const existing = messageId
      ? thread.find((m) => m.id === messageId)
      : thread.find((m) => m.card?.requestId === requestId);
    if (existing?.card && !existing.card.answered) {
      store.patchMessage(threadId, existing.id, { card: { ...existing.card, answered: "unavailable", dismissed: true } });
    }
    if (messageId) askMessageByRequest.delete(`${threadId}:${requestId}`);
    store.appendMessage(threadId, {
      role: "bot",
      kind: "activity",
      tool: { name: "Couldn't deliver that answer — the request is no longer open, so the action was not run", ok: false },
    });
  }
  return outcome;
}

/** Close every provider-owned approval still open on a thread. Interrupting a
 * turn kills the process that raised its questions, so those cards can never
 * be answered. Routine proposals are harness-owned and durable, so they stay
 * actionable even after the proposing turn has stopped. */
export function closeOpenApprovals(threadId: string): void {
  // Peer approvals also hold an in-memory promise. Resolve those first; merely
  // patching their cards would leave the delegation queue waiting 15 minutes.
  cancelPeerApprovalsForThread(threadId);
  for (const message of store.messagesFor(threadId)) {
    const card = message.card;
    if (!card?.requestId || card.answered || card.dismissed) continue;
    if (card.routineRequest || card.skillRequest) continue;
    store.patchMessage(threadId, message.id, { card: { ...card, answered: "unavailable", dismissed: true } });
    askMessageByRequest.delete(`${threadId}:${card.requestId}`);
  }
}
