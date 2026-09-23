import type { WireMessage as Message } from "../shared/wire.ts";

export function requestConflict(message = "The request no longer owns this conversation") {
  return Object.assign(new Error(message), { status: 409, code: "guarded_request_changed" });
}

export function assertRequestTarget(
  current: { messageId: string; activeLeafId: string | null; activeTurnId: string | null; executionId: string | null },
  expected: { messageId: string; expectedActiveLeafId: string | null; expectedTurnId: string | null; expectedExecutionId: string | null },
) {
  if (current.messageId !== expected.messageId || current.activeLeafId !== expected.expectedActiveLeafId ||
      current.activeTurnId !== expected.expectedTurnId || current.executionId !== expected.expectedExecutionId) throw requestConflict();
}

/** Never infer ownership from timestamps or the latest assistant text. */
export function guardedRequestPath(messages: Message[], activeLeafId: string | null, sendId: string): Message[] {
  const sources = messages.filter(message => message.sendId === sendId);
  const source = sources[0];
  if (sources.length !== 1 || !source || source.role !== "user" || source.kind !== "text" || source.steered || source.peerAsk) {
    throw requestConflict("No unique acknowledged user request matches this sendId");
  }
  const byId = new Map(messages.map(message => [message.id, message]));
  const path: Message[] = [];
  const seen = new Set<string>();
  let id = activeLeafId;
  while (id) {
    if (seen.has(id)) throw requestConflict();
    seen.add(id);
    const message = byId.get(id);
    if (!message) throw requestConflict();
    path.unshift(message);
    if (message.id === source.id) break;
    if (path.length >= 500) throw Object.assign(new Error("Open this request in the workspace; its transcript exceeds the response limit"), { status: 413 });
    id = message.parentId ?? null;
  }
  if (path[0]?.id !== source.id || path.slice(1).some(message => message.role === "user")) throw requestConflict();
  // An abandoned sibling can hold a detached result or approval. A caller
  // must never receive it as the answer to the current branch.
  const ancestors = new Set(path.map(message => message.id));
  if (messages.some(message => message.parentId && ancestors.has(message.parentId) && !seen.has(message.id))) throw requestConflict();
  return path;
}

/** Used only for an explicit control-plane card, never the latest user. */
export function requestSourceForCard(messages: Message[], messageId: string): string | undefined {
  const byId = new Map(messages.map(message => [message.id, message]));
  const seen = new Set<string>();
  let message = byId.get(messageId);
  while (message && !seen.has(message.id)) {
    seen.add(message.id);
    if (message.role === "user") return message.peerAsk || message.steered || message.requestCancelled ? undefined : message.id;
    message = message.parentId ? byId.get(message.parentId) : undefined;
  }
  return undefined;
}

export function requestNeedsInput(message: Message): boolean {
  return Boolean((message.card?.requestId && !message.card.answered && !message.card.dismissed) ||
    (message.connector && !message.connector.dismissed && !message.connector.resumed && message.connector.status !== "connected") ||
    (message.secret && !message.secret.provided && !message.secret.dismissed));
}
