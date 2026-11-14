// A conversation's turn ended with a card still open: it rests on the person, on every surface, until the card settles.
// The state follows the card rows, so every way a card opens or closes (saved, declined, replaced, stopped, answered in
// the chat, a restart, another branch) reads the same. A card a person isn't looking at reaches them by notification,
// and a turn that ends resting on them says so instead of "finished".
import { openPersonWait, personWait, restingOnPerson, type PersonWait } from "../../shared/person-wait.ts";
import type { Notification } from "../../shared/notification.ts";
import { NEEDS_YOU_WINDOW_MS } from "../../shared/today.ts";
import { buildNotification } from "../notify.ts";
import { conversationLanguage, serverLine } from "../server-lines.ts";
import type { BotRecord, Message, Store } from "../store.ts";

export interface PersonWaitsDeps {
  store: Pick<Store, "activePath" | "bot" | "botByThread" | "groups" | "groupByThread" | "groupTaskByThread" | "patchGroupTask" | "setTaskActivity" | "taskByThread" | "onChange">;
  notify(notification: Notification | null): void;
  /** The conversations that may hold an open card asked since then. */
  threadsWithCards(since: number): readonly string[];
  now?: () => number;
}

const NOTIFIED_ELSEWHERE: ReadonlySet<PersonWait["kind"]> = new Set(["question", "approval"]);
const CARD_ROWS: ReadonlySet<Message["kind"]> = new Set(["secret", "signin", "connector", "options"]);

export function createPersonWaits(deps: PersonWaitsDeps) {
  const { store } = deps;
  const now = deps.now ?? Date.now;
  const resting = new Map<string, PersonWait>();
  const withCards = new Set<string>();

  const askerOf = (threadId: string, wait: Pick<PersonWait, "botId">): BotRecord | null => (wait.botId ? store.bot(wait.botId) : null) ?? store.botByThread(threadId);

  /** What this conversation rests on: a card older than the Needs you window has been left, and no longer asks. */
  const restsOn = (threadId: string): PersonWait | undefined => {
    const wait = restingOnPerson(store.activePath(threadId));
    return wait && now() - wait.at < NEEDS_YOU_WINDOW_MS ? wait : undefined;
  };

  function show(threadId: string, wait: PersonWait | undefined): void {
    const group = store.groupByThread(threadId);
    if (group) {
      const task = store.groupTaskByThread(group.id, threadId);
      if (task && Boolean(task.activity) !== Boolean(wait)) store.patchGroupTask(group.id, threadId, { activity: wait ? "waiting-on-you" : null });
      return;
    }
    const bot = store.botByThread(threadId);
    const task = bot ? store.taskByThread(bot.id, threadId) : null;
    if (!bot || !task || task.busy) return;
    if (wait && (task.activity ?? "idle") === "idle") store.setTaskActivity(bot.id, threadId, "waiting-on-you", true);
    else if (!wait && task.activity === "waiting-on-you") store.setTaskActivity(bot.id, threadId, "idle");
  }

  function refresh(threadId: string): void {
    const wait = restsOn(threadId);
    if (wait) resting.set(threadId, wait);
    else resting.delete(threadId);
    show(threadId, wait);
  }

  function announce(threadId: string, messageId: string): void {
    const message = store.activePath(threadId).find((row) => row.id === messageId);
    const wait = message && personWait(message);
    if (!wait || NOTIFIED_ELSEWHERE.has(wait.kind)) return;
    const detail = message.secret ? message.secret.reason ?? message.secret.description
      : message.signIn ? message.signIn.reason ?? serverLine(conversationLanguage(threadId), "server.notify.openToSignIn", { site: wait.label })
        : message.connector?.description ?? wait.label;
    deps.notify(cardNotification(threadId, wait, detail));
  }

  function cardNotification(threadId: string, wait: PersonWait, detail: string): Notification | null {
    const bot = askerOf(threadId, wait);
    if (!bot) return null;
    const group = store.groupByThread(threadId);
    const extra = { avatarUrl: bot.avatarUrl, ...(group ? { group: { id: group.id, name: group.name } } : {}) };
    const target = { ...bot, threadId };
    switch (wait.kind) {
      case "password": return buildNotification("secret", target, threadId, detail, { ...extra, label: wait.label });
      case "sign-in": return buildNotification("sign-in", target, threadId, detail, { ...extra, site: wait.label });
      case "connect": return buildNotification("sign-in", target, threadId, detail, { ...extra, app: wait.label });
      case "question": return buildNotification("question", target, threadId, detail, extra);
      default: return buildNotification("approval", target, threadId, detail, extra);
    }
  }

  store.onChange((change) => {
    if (change.type === "message" || change.type === "message.patch") {
      if (!CARD_ROWS.has(change.message.kind)) return;
      withCards.add(change.threadId);
      refresh(change.threadId);
      // A proposal applied at once (Full access) settles in the same tick it is added: only one left open asks.
      if (change.type === "message") setImmediate(() => announce(change.threadId, change.message.id));
    } else if (change.type === "thread") {
      if (withCards.has(change.threadId)) refresh(change.threadId);
    } else if (change.type === "thread.deleted") {
      withCards.delete(change.threadId);
      resting.delete(change.threadId);
    } else if (change.type === "bot") {
      for (const [threadId, wait] of resting) if (store.taskByThread(change.botId, threadId)) show(threadId, wait);
    }
  });

  return {
    /** Nothing is running after a restart: what rested on the person still does. */
    boot(): void {
      for (const group of store.groups) for (const task of group.tasks ?? []) if (task.activity) store.patchGroupTask(group.id, task.threadId, { activity: null });
      for (const threadId of deps.threadsWithCards(now() - NEEDS_YOU_WINDOW_MS)) {
        withCards.add(threadId);
        refresh(threadId);
      }
    },
    /** Every conversation resting on the person, newest first, by its card's kind: what an inbox lists beside the questions
     * and approvals a running turn waits on. */
    waiting(): Array<PersonWait & { threadId: string; botId: string }> {
      return [...resting].flatMap(([threadId, wait]) => {
        const bot = askerOf(threadId, wait);
        return bot ? [{ ...wait, threadId, botId: bot.id }] : [];
      }).sort((a, b) => b.at - a.at);
    },
    /** What this conversation waits on the person for, a running turn's approval included. */
    open: (threadId: string): PersonWait | undefined => openPersonWait(store.activePath(threadId)),
    /** At a turn's end: whether it rests on the person, so it isn't news that it finished. Asked again in a turn the person
     * spoke into, the reminder carries the bot's reply. */
    atTurnEnd(threadId: string, reply: string): boolean {
      const wait = restsOn(threadId);
      if (!wait) return false;
      const path = store.activePath(threadId);
      const card = path.findIndex((row) => row.id === wait.messageId);
      const spokenSince = path.slice(card + 1).some((row) => row.role === "user" && !row.peerAsk && !row.relayed);
      if (spokenSince) deps.notify(cardNotification(threadId, wait, reply || wait.label));
      return true;
    },
  };
}

export type PersonWaits = ReturnType<typeof createPersonWaits>;
