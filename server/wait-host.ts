import { waitNoticeText } from "./wait-notice-text.ts";
import { redactParams } from "../shared/redact.ts";
import type { Notification } from "../shared/notification.ts";
import { buildNotification } from "./notify.ts";
import type { RoutineManager, RoutineRun } from "./routines.ts";
import type { BotRecord, Store } from "./store.ts";
import type { WaitManager, WaitManagerOptions } from "./waits.ts";

export interface WaitHostDeps {
  store: Pick<Store, "appendMessage" | "patchMessage" | "patchTask" | "messagesFor" | "bot">;
  /** A one-to-one chat this bot owns; a room is not one. */
  directChat(botId: string, threadId: string): boolean;
  threadBusy(botId: string, threadId: string): boolean;
  wrote(bot: BotRecord, threadId: string): void;
  notify(notification: Notification | null): void;
  enqueue(input: Parameters<RoutineManager["enqueueWebhook"]>[0]): { id: string };
  cloudHome: boolean;
  now?: () => number;
}

/** The chat a wait's follow-up run works in: the one it was asked in, never on a Cloud home or in a room. */
export function waitRunChat(
  run: Pick<RoutineRun, "botId" | "resultsThreadId">,
  directChat: (botId: string, threadId: string) => boolean,
  cloudHome: boolean,
): string | null {
  if (cloudHome || !run.resultsThreadId) return null;
  return directChat(run.botId, run.resultsThreadId) ? run.resultsThreadId : null;
}

/** A wait continuation is proved by the turn's originating run and fired notice in the same bot's chat, never its prompt. */
export function waitContinuesHere(
  run: Pick<RoutineRun, "id" | "eventSource" | "triggerSource" | "botId" | "threadId" | "resultsThreadId" | "webhookId" | "deliveryId"> | null,
  botId: string,
  threadId: string,
  store: Pick<Store, "messagesFor">,
  originatingRunId: string | undefined,
): boolean {
  if (!run || !originatingRunId || run.id !== originatingRunId || run.eventSource !== "wait" || run.triggerSource !== "webhook" || run.botId !== botId
    || run.threadId !== threadId || run.resultsThreadId !== threadId || !run.deliveryId
    || run.webhookId !== `wait:${run.deliveryId}`) return false;
  return store.messagesFor(threadId).some((message) => message.wait?.status === "fired" && message.wait.id === run.deliveryId);
}

/** The wait a follow-up's line starts, recorded on that line: only for the turn its own run started. */
export function waitLineFields(
  run: Pick<RoutineRun, "id" | "eventSource" | "triggerSource" | "webhookId" | "deliveryId"> | null,
  originatingRunId: string | undefined,
): { waitId?: string } {
  return run && originatingRunId && run.id === originatingRunId && run.eventSource === "wait" && run.triggerSource === "webhook"
    && run.deliveryId && run.webhookId === `wait:${run.deliveryId}` ? { waitId: run.deliveryId } : {};
}

interface WaitRunOwner {
  automationRunId?: string;
  messageId?: string;
  stopped?: boolean;
  generations: ReadonlySet<string>;
}

export function waitTurnRunId(
  turn: { automationRunId?: string; cardContinuation?: boolean; computerSelectionContinuation?: boolean } | undefined,
  previous: Pick<WaitRunOwner, "automationRunId" | "messageId" | "stopped"> | undefined,
  requestMessageId: string | undefined,
): string | undefined {
  if (turn?.automationRunId) return turn.automationRunId;
  if (!(turn?.cardContinuation || turn?.computerSelectionContinuation) || !requestMessageId
    || previous?.stopped || previous?.messageId !== requestMessageId) return undefined;
  return previous.automationRunId;
}

export function waitContinuationCheck<T extends { botId: string; threadId: string; generation: string; externalRuntime?: unknown }>(
  capability: T,
  deps: {
    active: (capability: T) => boolean;
    request: (threadId: string) => WaitRunOwner | undefined;
    run: (threadId: string) => Parameters<typeof waitContinuesHere>[0];
    store: Pick<Store, "messagesFor">;
  },
): () => boolean {
  return () => {
    const request = deps.request(capability.threadId);
    return !capability.externalRuntime && deps.active(capability)
      && request?.stopped !== true && request?.generations.has(capability.generation) === true
      && waitContinuesHere(deps.run(capability.threadId), capability.botId, capability.threadId, deps.store, request.automationRunId);
  };
}

type CardStore = Pick<Store, "messagesFor" | "patchMessage">;

function settleWaitCard(store: CardStore, threadId: string, messageId: string, how: "fired" | "expired" | "cancelled"): void {
  const card = store.messagesFor(threadId).find((m) => m.id === messageId)?.card;
  if (!card?.waitRequest || card.waitRequest.settled) return;
  store.patchMessage(threadId, messageId, {
    card: { ...card, ...(how === "cancelled" ? { undone: true } : {}), waitRequest: { ...card.waitRequest, settled: how } },
  });
}

/** The card's Cancel: true once it stopped the wait. A wait that already ended settles its card instead, so Cancel goes. */
export function cancelWaitFromCard(
  waits: Pick<WaitManager, "cancel">,
  store: CardStore,
  card: { botId: string; threadId: string; messageId: string; waitId: string },
): boolean {
  if (waits.cancel(card.waitId, card.botId)) return true;
  settleWaitCard(store, card.threadId, card.messageId, "expired");
  return false;
}

export function createWaitHost(deps: WaitHostDeps): Pick<WaitManagerOptions, "sourceAlive" | "botBusy" | "post" | "followUp" | "showCard" | "settleCard"> {
  const { store } = deps;
  const now = deps.now ?? Date.now;
  return {
    sourceAlive: (botId, threadId) => store.bot(botId) !== null && deps.directChat(botId, threadId),
    botBusy: (botId) => {
      const bot = store.bot(botId);
      return bot ? bot.busy === true : undefined;
    },
    post(wait, notice) {
      const bot = store.bot(wait.botId);
      if (!bot) return true;
      if (deps.threadBusy(wait.botId, wait.threadId)) return false;
      const posted = store.messagesFor(wait.threadId).some((m) => m.wait?.id === wait.id && m.wait.status === notice.status);
      if (posted) return true;
      const words = waitNoticeText(wait, notice);
      store.appendMessage(wait.threadId, { role: "bot", kind: "text", text: notice.text, textCode: words?.key, textParams: words?.params && redactParams(words.params), wait: { id: wait.id, status: notice.status } });
      store.patchTask(wait.botId, wait.threadId, { unread: true });
      deps.wrote(bot, wait.threadId);
      if (notice.status === "fired") deps.notify(buildNotification("wait", bot, wait.threadId, notice.text, { avatarUrl: bot.avatarUrl }));
      return true;
    },
    followUp(wait) {
      deps.enqueue({
        webhookId: `wait:${wait.id}`,
        webhookName: wait.label,
        prompt: `[Wait finished: ${wait.label}] ${wait.followUp}`,
        botId: wait.botId,
        runOn: "maus",
        deliveryId: wait.id,
        receivedAt: now(),
        eventSource: "wait",
        ...(deps.cloudHome ? {} : { resultsThreadId: wait.threadId }),
      });
    },
    showCard(wait) {
      const bot = store.bot(wait.botId);
      if (!bot) return undefined;
      const message = store.appendMessage(wait.threadId, {
        role: "bot",
        kind: "options",
        card: {
          title: `Waiting: ${wait.label}`,
          subtitle: `Then ${bot.name} will: ${wait.followUp}`,
          options: [],
          answered: "allow",
          dismissed: true,
          autoApplied: true,
          requestId: wait.id,
          tool: "wait_until",
          waitRequest: { waitId: wait.id, label: wait.label, followUp: wait.followUp },
        },
      });
      return message.id;
    },
    settleCard(wait, how) {
      if (wait.cardMessageId) settleWaitCard(store, wait.threadId, wait.cardMessageId, how);
    },
  };
}
