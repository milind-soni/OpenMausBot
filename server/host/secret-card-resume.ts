// Resumes saved secret cards whose waiting coordinator node already settled or moved on, coalescing cards saved while
// a turn is busy into a single follow-up continuation once the conversation is idle.
import type { SecretRequestCardData } from "../../shared/wire.ts";
import type { Message, Store } from "../store.ts";

export interface DirectContinuationOptions {
  requestMessageId?: string;
  delegated?: boolean;
  onLateError?: (error: unknown) => void;
}

export interface RoomContinuationOptions {
  requestMessageId?: string;
  onLateError?: (error: unknown) => void;
}

export interface MovedOnCardContext {
  nodeId: string;
  botId: string;
  threadId: string;
  groupId?: string;
  delegated?: boolean;
  requestMessageId?: string;
}

export interface SecretCardResumeDeps {
  store: Pick<Store, "activePath" | "patchMessage">;
  connectorThread(botId: string, threadId: string): { group: { id: string } | undefined } | null;
  updateText(messageId: string, secret: SecretRequestCardData, outcome: "provided" | "dismissed"): string;
  isWaitingCard(threadId: string, messageId: string): boolean;
  isDirectBlocked(botId: string, threadId: string): boolean;
  isRoomBlocked(groupId: string, botId: string, threadId: string): boolean;
  scheduleDrain?(): void;
  startDirectContinuation(botId: string, threadId: string, text: string, options?: DirectContinuationOptions): Promise<unknown>;
  startRoomContinuation(groupId: string, botId: string, threadId: string, text: string, options?: RoomContinuationOptions): Promise<unknown>;
}

/** Original person request line preceding the earliest resumed card so room Stop keeps its requester lock. */
export function roomRequestMessageIdForCards(path: readonly Message[], cards: readonly Message[]): string | undefined {
  const cardIds = new Set(cards.map((card) => card.id));
  const earliest = path.findIndex((message) => cardIds.has(message.id));
  if (earliest <= 0) return undefined;
  for (let index = earliest - 1; index >= 0; index -= 1) {
    const message = path[index]!;
    if (message.role !== "user" || message.aside) continue;
    return message.kind === "text" && !message.peerAsk && !message.relayed && !message.via ? message.id : undefined;
  }
  return undefined;
}

const isEligibleSecretCard = (message: Message): boolean => {
  const secret = message.secret;
  return (
    message.kind === "secret"
    && Boolean(secret)
    && !secret!.resumed
    && !secret!.superseded
    && !secret!.stopped
    && !secret!.error
  );
};

const isUnresumedProvidedSecret = (message: Message): boolean =>
  isEligibleSecretCard(message) && message.secret?.provided === true;

const RETRYABLE_CODES = new Set(["thread_busy", "settling", "thread_limit"]);

/** Throws a structured error when a queued room continuation never reached provider dispatch. */
export function roomContinuationNotStartedError(cancelled: boolean, dispatchError: string | undefined): Error & { code?: string } {
  const retryable = cancelled || !dispatchError || /busy|settling|being updated|being changed|confirm/i.test(dispatchError);
  return Object.assign(new Error(dispatchError ?? "Room continuation did not start"), retryable ? { code: "thread_busy" } : {});
}

/** Distinguishes pre-dispatch non-starts from post-acceptance failures so accepted turns are never replayed. */
export function roomContinuationError(
  cancelled: boolean,
  dispatchError: string | undefined,
  providerAccepted = false,
): Error & { code?: string; postDispatch?: true } {
  if (providerAccepted && dispatchError !== undefined) {
    return Object.assign(new Error(dispatchError), { postDispatch: true as const });
  }
  return roomContinuationNotStartedError(cancelled, dispatchError);
}

/** Classifies direct continuation dispatch failures identically to room continuations. */
export function directContinuationError(dispatchError: string, postDispatch = false): Error & { code?: string; postDispatch?: true } {
  return roomContinuationError(false, dispatchError, postDispatch);
}

function sharedRequestMessageId(contexts: readonly MovedOnCardContext[]): string | undefined {
  let shared: string | undefined;
  for (const ctx of contexts) {
    if (!ctx.requestMessageId) continue;
    if (shared === undefined) shared = ctx.requestMessageId;
    else if (shared !== ctx.requestMessageId) return undefined;
  }
  return shared;
}

export function createSecretCardResumer(deps: SecretCardResumeDeps) {
  const pending = new Set<string>();
  const inFlight = new Set<string>();
  const movedOn = new Map<string, MovedOnCardContext>();

  const keyOf = (botId: string, threadId: string) => `${botId}\0${threadId}`;
  const cardKey = (threadId: string, messageId: string) => `${threadId}\0${messageId}`;

  /** Records sibling secret cards on a waiting node whose turn moved on so later saves can resume them. */
  function noteTurnMovedOn(
    threadId: string,
    cardIds: readonly string[],
    answeredCardIds: readonly string[],
    context: MovedOnCardContext,
  ): void {
    const answered = new Set(answeredCardIds);
    const byId = new Map(deps.store.activePath(threadId).map((message) => [message.id, message]));
    let hasAlreadyProvided = false;
    for (const cardId of cardIds) {
      if (answered.has(cardId)) continue;
      const message = byId.get(cardId);
      if (!message || !isEligibleSecretCard(message)) continue;
      if (context.groupId !== undefined && message.from?.botId !== context.botId) continue;
      movedOn.set(cardKey(threadId, cardId), context);
      if (message.secret?.provided === true) hasAlreadyProvided = true;
    }
    if (hasAlreadyProvided) {
      pending.add(keyOf(context.botId, threadId));
      deps.scheduleDrain?.();
    }
  }

  function trackedCardIds(threadId: string): string[] {
    const prefix = `${threadId}\0`;
    const ids: string[] = [];
    for (const [key] of movedOn) {
      if (key.startsWith(prefix)) ids.push(key.slice(prefix.length));
    }
    return ids;
  }

  function forgetThread(threadId: string): void {
    const prefix = `${threadId}\0`;
    const suffix = `\0${threadId}`;
    for (const key of Array.from(movedOn.keys())) {
      if (key.startsWith(prefix)) movedOn.delete(key);
    }
    for (const key of Array.from(pending)) {
      if (key.endsWith(suffix)) pending.delete(key);
    }
  }

  function forgetNode(nodeId: string): void {
    for (const [key, context] of Array.from(movedOn)) {
      if (context.nodeId === nodeId) movedOn.delete(key);
    }
  }

  function unresumedProvided(botId: string, threadId: string, isRoom: boolean): Message[] {
    const path = deps.store.activePath(threadId);
    const eligibleById = new Map<string, Message>();
    for (const message of path) {
      if (isEligibleSecretCard(message)) eligibleById.set(message.id, message);
    }
    const prefix = `${threadId}\0`;
    for (const key of Array.from(movedOn.keys())) {
      if (!key.startsWith(prefix)) continue;
      if (!eligibleById.has(key.slice(prefix.length))) movedOn.delete(key);
    }
    return path.filter((message) => {
      if (!isUnresumedProvidedSecret(message)) return false;
      if (isRoom && message.from?.botId !== botId) return false;
      const context = movedOn.get(cardKey(threadId, message.id));
      return context !== undefined && context.botId === botId;
    });
  }

  function rollback(
    botId: string,
    threadId: string,
    cards: readonly Message[],
    claimedContexts: ReadonlyMap<string, MovedOnCardContext>,
    error: unknown,
  ): void {
    const postDispatch = Boolean((error as { postDispatch?: unknown } | null)?.postDispatch);
    const code = typeof (error as { code?: unknown } | null)?.code === "string"
      ? (error as { code: string }).code
      : "";
    const retryable = !postDispatch && RETRYABLE_CODES.has(code);
    const reason = error instanceof Error ? error.message : String(error);
    for (const item of cards) {
      const current = deps.store.activePath(threadId).find((candidate) => candidate.id === item.id);
      if (!current?.secret || current.secret.stopped || current.secret.superseded) continue;
      if (postDispatch) {
        deps.store.patchMessage(threadId, current.id, {
          secret: { ...current.secret, resumed: true, error: reason },
        });
      } else {
        const { resumed: _dropped, ...rest } = current.secret;
        deps.store.patchMessage(threadId, current.id, {
          secret: { ...rest, ...(retryable ? {} : { error: reason }) },
        });
        if (retryable) {
          const key = cardKey(threadId, current.id);
          const ctx = claimedContexts.get(key);
          if (ctx) movedOn.set(key, ctx);
        }
      }
    }
    if (retryable && deps.connectorThread(botId, threadId)) {
      pending.add(keyOf(botId, threadId));
      deps.scheduleDrain?.();
    }
  }

  function resume(botId: string, threadId: string): boolean {
    const key = keyOf(botId, threadId);
    const owner = deps.connectorThread(botId, threadId);
    if (!owner) {
      pending.delete(key);
      return false;
    }
    const groupId = owner.group?.id;
    const isRoom = groupId !== undefined;
    const allProvided = unresumedProvided(botId, threadId, isRoom);
    if (!allProvided.length) {
      pending.delete(key);
      return false;
    }
    const cards = allProvided.filter((message) => !deps.isWaitingCard(threadId, message.id));
    if (!cards.length || inFlight.has(key) || (isRoom ? deps.isRoomBlocked(groupId, botId, threadId) : deps.isDirectBlocked(botId, threadId))) {
      pending.add(key);
      return false;
    }
    if (cards.length === allProvided.length) pending.delete(key);
    else pending.add(key);
    inFlight.add(key);
    const claimedContexts = new Map<string, MovedOnCardContext>();
    for (const card of cards) {
      const cKey = cardKey(threadId, card.id);
      const ctx = movedOn.get(cKey);
      if (ctx) claimedContexts.set(cKey, ctx);
      movedOn.delete(cKey);
    }
    const contexts = Array.from(claimedContexts.values());
    const delegated = contexts.some((ctx) => ctx.delegated === true);
    const sharedReqId = sharedRequestMessageId(contexts);
    const requestMessageId = isRoom
      ? sharedReqId ?? roomRequestMessageIdForCards(deps.store.activePath(threadId), cards)
      : sharedReqId;
    const combinedText = cards.map((message) => deps.updateText(message.id, message.secret!, "provided")).join("\n\n");
    for (const message of cards) {
      deps.store.patchMessage(threadId, message.id, {
        secret: { ...message.secret!, resumed: true, error: undefined },
      });
    }
    let rolledBack = false;
    const fail = (error: unknown) => {
      if (rolledBack) return;
      rolledBack = true;
      rollback(botId, threadId, cards, claimedContexts, error);
    };
    try {
      const run = isRoom
        ? deps.startRoomContinuation(groupId, botId, threadId, combinedText, { requestMessageId, onLateError: fail })
        : deps.startDirectContinuation(botId, threadId, combinedText, { requestMessageId, delegated, onLateError: fail });
      void Promise.resolve(run).catch(fail);
      return true;
    } catch (error) {
      fail(error);
      return false;
    } finally {
      inFlight.delete(key);
    }
  }

  function drain(): void {
    for (const key of Array.from(pending)) {
      const sep = key.indexOf("\0");
      if (sep < 0) {
        pending.delete(key);
        continue;
      }
      resume(key.slice(0, sep), key.slice(sep + 1));
    }
  }

  return { resume, drain, noteTurnMovedOn, trackedCardIds, forgetThread, forgetNode };
}
