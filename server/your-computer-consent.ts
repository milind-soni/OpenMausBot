// Asking before a bot uses the person's own computer. "Just do it" covers what a bot does in its own places (its
// browser, a cloud desktop, its files), never taking over the person's screen: when a turn reaches this computer without
// the person having picked it as the place, its first screen call waits on one plain card, Allow once or Deny, at every
// approval level. The answer covers that turn only. Pending asks live in memory; a card left by a previous run is closed.
import { newId } from "./contracts.ts";
import { optionCardsForTools } from "./message-db.ts";
import { buildNotification, type Notification } from "./notify.ts";
import type { BotRecord, Store } from "./store.ts";
import {
  cleanAppName,
  cleanSiteName,
  YOUR_COMPUTER_TOOL,
  yourComputerQuestion,
  yourComputerText,
  type YourComputerCall,
} from "../shared/your-computer.ts";

export interface YourComputerBus {
  store: Store;
  notify?: (notification: Notification | null) => void;
}

export const YOUR_COMPUTER_WAITING =
  "OpenMausBot is asking the person whether you may use their own computer, and they have not answered yet, so this call was NOT performed and nothing happened on their screen. Do not ask them again in chat: the question is already in front of them. To keep waiting, take a screenshot (each call waits up to 45 seconds); meanwhile you may work on anything that does not need their computer.";

/** The claim fails with this, so the turn is told why without a failed-turn row: the person chose, nothing broke. */
export const YOUR_COMPUTER_DECLINED =
  "the person said no to using their own computer. Finish without it: use your own browser, a cloud computer or a connected app, or give them the links to do it themselves";
const YOUR_COMPUTER_ENDED = "the request ended before the person answered whether you may use their computer";

export class YourComputerDeclined extends Error {
  readonly declined = true;
  constructor(message: string) {
    super(message);
    this.name = "YourComputerDeclined";
  }
}

export function yourComputerDeclined(error: unknown): boolean {
  return error instanceof YourComputerDeclined;
}

interface Pending {
  threadId: string;
  generation: string;
  messageId: string;
  botId?: string;
  store: Store;
  resolve: (allowed: boolean, why?: string) => void;
}

const pending = new Map<string, Pending>();

/** The cleaned call a computer-control request carries in its query, or nothing. */
export function yourComputerCallFrom(query: URLSearchParams): YourComputerCall | undefined {
  const app = cleanAppName(query.get("app"));
  const site = cleanSiteName(query.get("site"));
  return app || site ? { ...(app ? { app } : {}), ...(site ? { site } : {}) } : undefined;
}

function settle(entry: Pending, answer: "allow" | "deny", source: "user" | "system"): void {
  const card = entry.store.messagesFor(entry.threadId).find((message) => message.id === entry.messageId)?.card;
  if (card && !card.answered) {
    entry.store.patchMessage(entry.threadId, entry.messageId, { card: { ...card, answered: answer, dismissed: source !== "user" } });
  }
  const task = entry.botId ? entry.store.projectBotForTask(entry.botId, entry.threadId) : null;
  if (task?.activity === "waiting-on-you") entry.store.setTaskActivity(task.id, entry.threadId, "working");
}

/** Resolves when the person allows; rejects with YourComputerDeclined when they deny or the request ends first. */
export function askToUseYourComputer(
  bus: YourComputerBus,
  bot: Pick<BotRecord, "id" | "name" | "color" | "avatarUrl" | "notifications"> | undefined,
  owner: { threadId: string; generation: string },
  call?: YourComputerCall,
): Promise<void> {
  const { store } = bus;
  const { key, params } = yourComputerQuestion(call);
  const title = yourComputerText(key, params);
  const name = bot?.name ?? "The bot";
  const room = store.groupByThread(owner.threadId);
  const requestId = newId();
  return new Promise<void>((resolve, reject) => {
    // The card exists before the entry, so an answer or a cancellation can always settle it.
    const message = store.appendMessage(owner.threadId, {
      role: "bot",
      kind: "options",
      ...(room && bot ? { from: { botId: bot.id, name: bot.name, color: bot.color } } : {}),
      card: {
        title,
        subtitle: yourComputerText("approval.yourComputer.detail", { name }),
        options: ["Allow once", "Deny"],
        requestId,
        requestType: "permission",
        tool: YOUR_COMPUTER_TOOL,
        yourComputer: call ? { ...(call.app ? { app: call.app } : {}), ...(call.site ? { site: call.site } : {}) } : {},
      },
    });
    pending.set(requestId, {
      threadId: owner.threadId, generation: owner.generation, messageId: message.id, botId: bot?.id, store,
      resolve: (allowed, why) => (allowed ? resolve() : reject(new YourComputerDeclined(why ?? YOUR_COMPUTER_DECLINED))),
    });
    if (bot) {
      const task = store.projectBotForTask(bot.id, owner.threadId);
      if (task?.busy) store.setTaskActivity(bot.id, owner.threadId, "waiting-on-you");
      bus.notify?.(buildNotification("approval", bot, owner.threadId, title, {
        avatarUrl: bot.avatarUrl, ...(room && !room.dm ? { group: { id: room.id, name: room.name } } : {}),
      }));
    }
  });
}

/** True when it settled one of these asks; call before handing an answer to the engine. */
export function resolveYourComputerAsk(requestId: string, behavior: string | undefined): boolean {
  const entry = pending.get(requestId);
  if (!entry) return false;
  pending.delete(requestId);
  const allowed = behavior === "allow";
  settle(entry, allowed ? "allow" : "deny", "user");
  entry.resolve(allowed);
  return true;
}

/** Closes what a request left open: every ask in the thread, or only its own generation's. */
export function cancelYourComputerAsks(threadId: string, generation?: string): void {
  for (const [requestId, entry] of pending) {
    if (entry.threadId !== threadId || (generation !== undefined && entry.generation !== generation)) continue;
    pending.delete(requestId);
    settle(entry, "deny", "system");
    entry.resolve(false, YOUR_COMPUTER_ENDED);
  }
}

/** What the screen call is told while the person has not answered this generation's ask. */
export function yourComputerWaiting(threadId: string, generation: string): string | undefined {
  for (const entry of pending.values()) if (entry.threadId === threadId && entry.generation === generation) return YOUR_COMPUTER_WAITING;
  return undefined;
}

/** Asks live in memory only: a card a previous run left open can never be answered, so it is closed at startup. */
export function dismissStaleYourComputerCards(store: Store): number {
  let dismissed = 0;
  for (const { threadId, messageId } of optionCardsForTools([YOUR_COMPUTER_TOOL])) {
    const card = store.messagesFor(threadId).find((message) => message.id === messageId)?.card;
    if (!card?.requestId || card.answered || card.dismissed || pending.has(card.requestId)) continue;
    if (store.patchMessage(threadId, messageId, { card: { ...card, answered: "deny", dismissed: true } })) dismissed += 1;
  }
  return dismissed;
}
