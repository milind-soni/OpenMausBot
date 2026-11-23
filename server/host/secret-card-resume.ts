// Resumes saved secret cards whose waiting coordinator node already settled or moved on, coalescing cards saved while
// a turn is busy into a single follow-up continuation once the conversation is idle.
import type { SecretRequestCardData } from "../../shared/wire.ts";
import type { Message, Store } from "../store.ts";

export interface SecretCardResumeDeps {
  store: Pick<Store, "activePath" | "patchMessage">;
  connectorThread(botId: string, threadId: string): { group: { id: string } | undefined } | null;
  updateText(messageId: string, secret: SecretRequestCardData, outcome: "provided" | "dismissed"): string;
  isWaitingCard(threadId: string, messageId: string): boolean;
  isDirectBlocked(botId: string, threadId: string): boolean;
  isRoomBlocked(groupId: string, botId: string, threadId: string): boolean;
  discoverPending?(): Array<{ botId: string; threadId: string }>;
  scheduleDrain?(): void;
  startDirectContinuation(botId: string, threadId: string, text: string): Promise<unknown>;
  startRoomContinuation(groupId: string, botId: string, threadId: string, text: string): Promise<unknown>;
}

const isUnresumedProvidedSecret = (message: Message): boolean => {
  const secret = message.secret;
  return (
    message.kind === "secret"
    && secret?.provided === true
    && !secret.resumed
    && !secret.superseded
    && !secret.stopped
  );
};

/** Discovers direct and room threads with persisted provided secret cards that still need resumption after restart. */
export function collectPersistedSecretCardTargets(
  store: Pick<Store, "bots" | "groups" | "tasks" | "groupTasks" | "activePath">,
): Array<{ botId: string; threadId: string }> {
  const seen = new Set<string>();
  const targets: Array<{ botId: string; threadId: string }> = [];
  const add = (botId: string, threadId: string) => {
    const key = `${botId}\0${threadId}`;
    if (seen.has(key)) return;
    seen.add(key);
    targets.push({ botId, threadId });
  };
  for (const bot of store.bots) {
    for (const threadId of new Set([bot.threadId, ...store.tasks(bot.id).map((task) => task.threadId)])) {
      if (store.activePath(threadId).some(isUnresumedProvidedSecret)) add(bot.id, threadId);
    }
  }
  for (const group of store.groups) {
    const threadIds = new Set([group.threadId, ...(group.dm ? [] : store.groupTasks(group.id).map((task) => task.threadId))]);
    for (const threadId of threadIds) {
      for (const message of store.activePath(threadId)) {
        const sender = message.from?.botId;
        if (typeof sender === "string" && group.memberIds.includes(sender) && isUnresumedProvidedSecret(message)) {
          add(sender, threadId);
        }
      }
    }
  }
  return targets;
}

const RETRYABLE_CODES = new Set(["thread_busy", "settling", "thread_limit"]);

/** Throws a structured error when a queued room continuation never reached provider dispatch. */
export function roomContinuationNotStartedError(cancelled: boolean, dispatchError: string | undefined): Error & { code?: string } {
  const retryable = cancelled || !dispatchError || /busy|settling|being updated|being changed|confirm/i.test(dispatchError);
  return Object.assign(new Error(dispatchError ?? "Room continuation did not start"), retryable ? { code: "thread_busy" } : {});
}

export function createSecretCardResumer(deps: SecretCardResumeDeps) {
  const pending = new Set<string>();
  const inFlight = new Set<string>();
  let seeded = false;

  const keyOf = (botId: string, threadId: string) => `${botId}\0${threadId}`;

  function unresumedProvided(botId: string, threadId: string, isRoom: boolean): Message[] {
    return deps.store.activePath(threadId).filter(
      (message) => isUnresumedProvidedSecret(message) && (!isRoom || message.from?.botId === botId),
    );
  }

  function rollback(botId: string, threadId: string, cards: readonly Message[], error: unknown): void {
    const code = typeof (error as { code?: unknown } | null)?.code === "string"
      ? (error as { code: string }).code
      : "";
    const retryable = RETRYABLE_CODES.has(code);
    const reason = error instanceof Error ? error.message : String(error);
    for (const item of cards) {
      const current = deps.store.activePath(threadId).find((candidate) => candidate.id === item.id);
      if (!current?.secret || current.secret.stopped || current.secret.superseded) continue;
      const { resumed: _dropped, ...rest } = current.secret;
      deps.store.patchMessage(threadId, current.id, {
        secret: { ...rest, ...(retryable ? {} : { error: reason }) },
      });
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
    const combinedText = cards.map((message) => deps.updateText(message.id, message.secret!, "provided")).join("\n\n");
    for (const message of cards) {
      deps.store.patchMessage(threadId, message.id, {
        secret: { ...message.secret!, resumed: true, error: undefined },
      });
    }
    try {
      const run = isRoom
        ? deps.startRoomContinuation(groupId, botId, threadId, combinedText)
        : deps.startDirectContinuation(botId, threadId, combinedText);
      void Promise.resolve(run).catch((error: unknown) => rollback(botId, threadId, cards, error));
      return true;
    } catch (error) {
      rollback(botId, threadId, cards, error);
      return false;
    } finally {
      inFlight.delete(key);
    }
  }

  function drain(): void {
    if (!seeded) {
      seeded = true;
      for (const target of deps.discoverPending?.() ?? []) {
        pending.add(keyOf(target.botId, target.threadId));
      }
    }
    for (const key of Array.from(pending)) {
      const sep = key.indexOf("\0");
      if (sep < 0) {
        pending.delete(key);
        continue;
      }
      resume(key.slice(0, sep), key.slice(sep + 1));
    }
  }

  return { resume, drain };
}
