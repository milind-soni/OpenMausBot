import type { HandoffView } from "./coordinator.ts";
import { NEEDS_INPUT_GATE, type EscalationKind } from "./escalations.ts";
import type { IncidentOutcome } from "./host/chief-notices.ts";
import type { IncidentKind } from "./incidents.ts";
import { buildNotification, type Notification, type NotifyKind } from "./notify.ts";
import type { BotRecord, Store } from "./store.ts";

/** What muting a bot conversation thread does to one notice:
 * - "silenced": never reaches the person's devices from a muted thread;
 * - "kept-unless-chief-took-it": silenced only when the Chief of Staff accepted this very report (its incident turn
 *   started or queued); a missing, refusing, rate-limited or busy-elsewhere Chief leaves it to the person;
 * - "kept": always reaches the person — a gate only they can lift, news the brief has for them, or account-level spend.
 * "peer-approval" is the approval a bot asks of the person before it acts on a teammate; every other notice is its NotifyKind. */
export type ThreadMuteNotice = NotifyKind | "peer-approval";
export type ThreadMuteRule = "silenced" | "kept-unless-chief-took-it" | "kept";
export const THREAD_MUTE_POLICY: Record<ThreadMuteNotice, ThreadMuteRule> = {
  done: "silenced",
  "delegation-settled": "silenced",
  mention: "silenced",
  "routine-deferred": "silenced",
  // Waits only the person can lift, whether or not a Chief exists. A turn that ends on NEEDS INPUT in a muted thread
  // also tells the person as a question (reportNeedsInput below).
  approval: "kept",
  question: "kept",
  "sign-in": "kept",
  "turn-failed": "kept-unless-chief-took-it",
  "routine-failed": "kept-unless-chief-took-it",
  // Sent only when no Chief received the incident or escalation (none, out of reach, or it could not start).
  incident: "kept",
  "peer-approval": "kept",
  // Account-level: dispatched outside any thread (index.ts spend alerts), listed so the table is whole.
  spend: "kept",
  // The main agent's brief has something new for the person (host/brief.ts, sent to its main chat).
  brief: "kept",
};

/** Whether a muted thread still sends `notice`. A "kept-unless-chief-took-it" notice is sent: its caller
 * (reportFailure below) withholds it, from a muted thread, once the Chief accepted its report. */
export function mutedThreadNotifies(notice: ThreadMuteNotice): boolean {
  return THREAD_MUTE_POLICY[notice] !== "silenced";
}

export interface ThreadMuteDefault {
  botOpened: boolean;
  mainThreadId: string | undefined;
}

export interface MutableThread {
  threadId: string;
  notificationsMuted?: boolean;
  openedBy?: object;
}

/** `features.muteBotOpenedThreads`: threads a bot opened (a teammate's handoff thread, a bot's own start_thread) start
 * with their notifications muted; the bot's main conversation never does. Off unless true. */
export function muteBotOpenedThreads(cfg: { features?: { muteBotOpenedThreads?: boolean } }): boolean {
  return cfg.features?.muteBotOpenedThreads === true;
}

export function threadNotificationsMuted(task: MutableThread, byDefault: ThreadMuteDefault): boolean {
  return task.notificationsMuted ?? (byDefault.botOpened && task.openedBy !== undefined && task.threadId !== byDefault.mainThreadId);
}

type FailureKind = Extract<IncidentKind, "could-not-start" | "routine-failed">;

export interface ThreadMuteDeps {
  store: Pick<Store, "taskByThread" | "groupByThread">;
  config: { features?: { muteBotOpenedThreads?: boolean } };
  mainThread(botId: string): string | undefined;
  /** index.ts's notify, which applies this module's gate. */
  notify(notification: Notification | null): void;
  /** The Chief of Staff reports (host/chief-notices.ts), read when a report is made. */
  chief(): {
    /** undefined: nobody received the report; it folded into assigned work or hit the rate limit. */
    reportIncident(input: { kind: IncidentKind; bot: BotRecord; threadId: string; detail: string; alreadyNotified?: boolean; personNotice?: Notification }):
      IncidentOutcome | undefined;
    reportEscalation(input: { kind: EscalationKind; bot: BotRecord; threadId: string; gate: string; reason: string; alreadyNotified: boolean }): unknown;
  };
  assignerOf(threadId: string): unknown;
}

export function createThreadMute(deps: ThreadMuteDeps) {
  const { store } = deps;
  const defaultFor = (botId: string, mainThreadId = deps.mainThread(botId)): ThreadMuteDefault =>
    ({ botOpened: muteBotOpenedThreads(deps.config), mainThreadId });

  function muted(botId: string, threadId: string): boolean {
    const task = store.taskByThread(botId, threadId);
    return task !== undefined && threadNotificationsMuted(task, defaultFor(botId));
  }

  /** The mute fields of a thread on the wire: always the effective value, and whether nobody chose it. */
  const wire = (task: MutableThread, muteDefault: ThreadMuteDefault) =>
    ({ notificationsMuted: threadNotificationsMuted(task, muteDefault), followsMuteDefault: task.notificationsMuted === undefined });

  /** Whether `notification` reaches the person's devices. `notice` names a notification whose kind alone does not say
   * what it is to a muted thread: the approval bus sends only peer approval cards, a gate the person alone lifts. */
  const lets = (notification: Notification, notice?: ThreadMuteNotice): boolean =>
    !muted(notification.botId, notification.threadId) || mutedThreadNotifies(notice ?? notification.kind);

  /** The coordinator parked `node` on `question`. A muted thread drops "delegation-settled". Assigned work's question
   * then reaches the person only when nobody else gets it: the runtime wakes the assigner (runtime.ts wake) unless the
   * reply is "none", and a woken assigner whose thread is gone has nowhere to answer. Cards on the node already
   * notified the person themselves. */
  function parkedKind(botId: string, node: Pick<HandoffView, "parentId" | "reply" | "cards" | "threadId">, liveParent: HandoffView | undefined):
    "question" | "delegation-settled" {
    const assignerWoken = liveParent !== undefined && node.reply !== "none";
    return node.parentId !== undefined && !assignerWoken && !node.cards?.length && muted(botId, node.threadId) ? "question" : "delegation-settled";
  }

  /** A turn that could not start, or a routine that failed: the person hears of it once. From a muted thread the direct
   * notice waits on the report: the Chief accepting it replaces the notice, anything else leaves exactly one. */
  function reportFailure(input: { notification: Notification | null; kind: FailureKind; bot: BotRecord; threadId: string; detail: string }): void {
    const { notification, ...incident } = input;
    const { reportIncident } = deps.chief();
    if (!notification || !muted(notification.botId, notification.threadId)) {
      deps.notify(notification);
      reportIncident({ ...incident, alreadyNotified: true });
      return;
    }
    // "person": delivery sent this notice; "chief": a refusal tells them through incidentRefused, the report not marked
    // notified; undefined: nobody else will.
    if (reportIncident({ ...incident, alreadyNotified: false, personNotice: notification }) === undefined) deps.notify(notification);
  }

  /** A turn that ended on NEEDS INPUT. In a muted thread the person hears of it directly, whatever the escalation
   * setting or Chief, since the Chief's escalations thread may itself be muted; the escalation then counts it as told.
   * A question for assigned work goes to its assigner, as the escalation's own rule says. */
  function reportNeedsInput(input: { bot: BotRecord; threadId: string; question: string }): void {
    const { bot, threadId, question } = input;
    let told = false;
    if (muted(bot.id, threadId) && !deps.assignerOf(threadId)) {
      const group = store.groupByThread(threadId);
      const notification = buildNotification("question", bot, threadId, question, {
        avatarUrl: bot.avatarUrl,
        ...(group ? { group: { id: group.id, name: group.name } } : {}),
      });
      deps.notify(notification);
      told = notification !== null;
    }
    deps.chief().reportEscalation({ kind: "needs-input", bot, threadId, gate: NEEDS_INPUT_GATE, reason: question, alreadyNotified: told });
  }

  return { defaultFor, muted, wire, lets, parkedKind, reportFailure, reportNeedsInput };
}
