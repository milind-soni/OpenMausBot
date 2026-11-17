// Burst mode's host: the lane's threads are ordinary threads of the bot, started through the same turn start any turn uses,
// so a burst thread gets the memory gate, the budget check and every other guard of a normal turn. The seam for a thread's
// own computer is `openThread`: each part is one thread with one model today, and the same place can ask for a computer.
import { fastModelFor } from "../turn-route.ts";
import { buildNotification, summarize, type NotifyBot } from "../notify.ts";
import type { BurstCardData, BurstPhase } from "../../shared/burst.ts";
import type { Notification } from "../../shared/notification.ts";
import { redactSecretsInText } from "../../shared/redact.ts";
import type { ModelSelection } from "../../shared/wire.ts";
import type { ModelCatalog } from "../contracts.ts";
import { burstLimits, type BurstLimits } from "../burst/limits.ts";
import { createBurstManager, type BurstManager, type BurstTurnOutcome } from "../burst/manager.ts";
import { openBurstStore, type BurstRecord, type BurstStore } from "../burst/store.ts";
import type { HostTurnResult } from "../coordinator.ts";
import type { WorkOrigin } from "../peer-provenance.ts";
import { serverLine, type ServerLineKey } from "../server-lines.ts";
import type { BotRecord, Message, Store } from "../store.ts";

const INBOX_TEXT_MAX = 2_000;
const CARD_LINE: Record<BurstPhase, ServerLineKey> = {
  preview: "server.burst.preview",
  running: "server.burst.running",
  merging: "server.burst.merging",
  done: "server.burst.done",
  cancelled: "server.burst.cancelled",
};

/** A turn start, as `startTurn` takes it for a part or a merge. */
export interface BurstTurnOptions {
  threadId: string;
  peerAsk?: { botId: string; name: string };
  cardContinuation?: true;
  requestMessageId?: string;
  origin?: WorkOrigin;
  allowRoomTurnElsewhere: true;
  onSettled: (outcome: HostTurnResult) => void;
  onDispatchError: (message: string) => void;
}

export interface BurstHostDeps {
  dataDir: string;
  cloudHome: boolean;
  tier(): string | undefined;
  maxParallel(): number | undefined;
  hasRoom(): boolean;
  store: Pick<Store, "bot" | "taskByThread" | "createTask" | "appendMessage" | "patchMessage">;
  language(threadId: string): string | undefined;
  startTurn(botId: string, text: string, opts: BurstTurnOptions): Promise<unknown>;
  stop(botId: string, threadId: string, cause: string): void;
  threadBusy(botId: string, threadId: string): boolean;
  /** Records who opened a part's thread: the same person as the parent chat. */
  opened(threadId: string, parentThreadId: string): void;
  /** Whom this request came from, in the record's words, for what a turn may reach. */
  origin(burst: BurstRecord): WorkOrigin;
  approval(bot: BotRecord, selection: ModelSelection): "ask" | undefined;
  /** The model a burst defaults to: the bot's own engine's fast model, or the model of the chat that asked. */
  defaultModel(bot: BotRecord, threadId: string): ModelSelection;
  modelName(selection: ModelSelection): string;
  route(notification: Notification): Notification | null;
  announce(notification: Notification): void;
  log?: (line: string) => void;
}

const outcomeOf = (result: HostTurnResult): BurstTurnOutcome => ({ ok: result.ok && !result.stalled, text: result.text, asked: Boolean(result.cards?.ids.length) });

export function createBurstHost(deps: BurstHostDeps): BurstManager & { model(bot: BotRecord, threadId: string): { selection: ModelSelection; name: string } } {
  const { store } = deps;
  const burstStore: BurstStore = openBurstStore(deps.dataDir);
  const limits = (): BurstLimits => burstLimits({ cloudHome: deps.cloudHome, tier: deps.tier(), maxParallel: deps.maxParallel() });

  function cardLine(burst: BurstRecord, card: BurstCardData): string {
    const language = deps.language(burst.threadId);
    return serverLine(language, CARD_LINE[card.phase], { count: card.total, done: card.counts.done, total: card.total, failed: card.counts.failed });
  }

  const manager = createBurstManager({
    store: burstStore,
    limits,
    hasRoom: deps.hasRoom,
    openThread(burst, child) {
      const bot = store.bot(burst.botId);
      if (!bot) return null;
      const task = store.createTask(bot.id, child.title, false, undefined,
        { botId: bot.id, name: bot.name, threadId: burst.threadId, burstId: burst.id, at: Date.now() }, deps.approval(bot, burst.model), burst.model);
      if (!task) return null;
      deps.opened(task.threadId, burst.threadId);
      return task.threadId;
    },
    startChild(burst, child, text, done) {
      const bot = store.bot(burst.botId);
      if (!bot) return Promise.reject(new Error("The bot is no longer here."));
      return deps.startTurn(bot.id, text, { threadId: child.threadId, peerAsk: { botId: bot.id, name: bot.name }, origin: deps.origin(burst), allowRoomTurnElsewhere: true,
        onSettled: (result) => { done(outcomeOf(result)); }, onDispatchError: (message) => { done({ ok: false, text: message }); } }).then(() => undefined);
    },
    stopChild(burst, child) {
      if (child.threadId) deps.stop(burst.botId, child.threadId, "The person cancelled this burst.");
    },
    async startMerge(burst, text, done) {
      if (!store.bot(burst.botId)) throw new Error("The bot is no longer here.");
      if (deps.threadBusy(burst.botId, burst.threadId)) return false;
      await deps.startTurn(burst.botId, text(), { threadId: burst.threadId, cardContinuation: true, ...(burst.cardMessageId ? { requestMessageId: burst.cardMessageId } : {}), origin: deps.origin(burst), allowRoomTurnElsewhere: true,
        onSettled: (result) => { done(outcomeOf(result)); }, onDispatchError: (message) => { done({ ok: false, text: message }); } });
      return true;
    },
    draw(burst, card) {
      const bot = store.bot(burst.botId);
      const line = cardLine(burst, card);
      if (!burst.cardMessageId) return store.appendMessage(burst.threadId, { role: "bot", kind: "burst", text: line, burst: card, ...(bot ? { from: { botId: bot.id, name: bot.name, color: bot.color } } : {}) } as Omit<Message, "id" | "at">).id;
      store.patchMessage(burst.threadId, burst.cardMessageId, { text: line, burst: card });
      return burst.cardMessageId;
    },
    postParts(burst, parts) {
      const language = deps.language(burst.threadId);
      const body = parts.map((child) => child.status === "done"
        ? `**${child.title}**\n\n${child.result ?? ""}`
        : `**${child.title}**: ${serverLine(language, "server.burst.partFailed", { reason: child.error ?? "" })}`).join("\n\n");
      const text = `${serverLine(language, "server.burst.partsHeader", { task: burst.task })}\n\n${body}`;
      store.appendMessage(burst.threadId, { role: "bot", kind: "text", text: redactSecretsInText(text) });
      return text;
    },
    deliver(burst, text) {
      const bot = store.bot(burst.botId);
      if (!bot) return;
      const notifiable: NotifyBot = { id: bot.id, name: bot.name, threadId: burst.threadId, notifications: bot.notifications };
      const short = buildNotification("done", notifiable, burst.threadId, text, { avatarUrl: bot.avatarUrl });
      if (!short) return;
      const clean = redactSecretsInText(text);
      const routed = deps.route({ ...short, body: clean.length > INBOX_TEXT_MAX ? `${clean.slice(0, INBOX_TEXT_MAX - 1).trimEnd()}…` : clean });
      if (routed) deps.announce({ ...routed, body: summarize(clean) });
    },
    ...(deps.log ? { log: deps.log } : {}),
  });

  return Object.assign(manager, {
    model(bot: BotRecord, threadId: string) {
      const selection = deps.defaultModel(bot, threadId);
      return { selection, name: deps.modelName(selection) };
    },
  });
}

export type BurstHost = ReturnType<typeof createBurstHost>;

/** The bot's own engine's fast model when it has one this bot may use; otherwise the chat's own model. */
export function burstDefaultModel(input: { own: ModelSelection; catalog(instanceId: string): ModelCatalog | undefined; refused(instanceId: string): ReadonlySet<string>; usable(selection: ModelSelection): boolean }): ModelSelection {
  const fast = fastModelFor(input.catalog(input.own.instanceId), input.own.model, input.refused(input.own.instanceId));
  if (!fast || fast === input.own.model) return input.own;
  const selection = { instanceId: input.own.instanceId, model: fast };
  return input.usable(selection) ? selection : input.own;
}

export const BURST_ROOM_REFUSAL = "A burst runs from a bot's own chat, not a room. Ask the person to start it there.";
export const BURST_OUTSIDE_REFUSAL = "This work came in from outside, so it can't open a burst. Finish it here.";

/** Who may open a burst: a person's own request in the bot's own chat, the same rule as opening a thread on yourself. */
export function burstProposalRefusal(input: { owner: { group?: unknown } | null | undefined; outside: boolean; self: string | undefined }): string | null {
  if (!input.owner) return "source conversation does not belong to sender";
  if (input.owner.group) return BURST_ROOM_REFUSAL;
  if (input.outside) return BURST_OUTSIDE_REFUSAL;
  return input.self ?? null;
}
