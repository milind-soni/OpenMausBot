import { failedTurnTool } from "../../shared/failed-turn.ts";
import { admit } from "../admission.ts";
import { ESCALATIONS_THREAD_TITLE, EscalationLedger, escalationChip, escalationDeliverable, escalationText, type Escalation, type EscalationKind } from "../escalations.ts";
import {
  AUTO_RETRY_LEAD, chiefForBot, INCIDENTS_THREAD_TITLE, IncidentLedger, incidentChip, incidentContext, incidentText, RETRY_BLOCKED, RETRY_LEAD,
  type Incident, type IncidentKind, type IncidentRetry,
} from "../incidents.ts";
import { buildNotification, type Notification } from "../notify.ts";
import { quoteInNote } from "../peer-provenance.ts";
import { peerName } from "../peer-roster.ts";
import { redactSecretsInText } from "../redact.ts";
import { retriesTeammateThread, type RoutineFailureFacts } from "../routine-recovery.ts";
import { queueSteeredMessage } from "../steer-queue.ts";
import type { BotRecord, Message, Store } from "../store.ts";

type PeerAsk = NonNullable<Message["peerAsk"]>;

export type EscalationOutcome = "chief" | "person" | "muted" | "off" | "skipped" | "failed";

export interface ChiefNoticeDeps {
  store: Pick<Store, "bots" | "bot" | "tasks" | "taskByThread" | "groupByThread" | "createTask" | "appendMessage" | "messagesFor" | "activePath">;
  assignerOf(threadId: string): unknown;
  notify(notification: Notification | null): void;
  threadBusy(botId: string, threadId: string): boolean;
  botAtThreadCapacity(botId: string): boolean;
  groupTurnActive(botId: string): boolean;
  startTurn(botId: string, text: string, opts: { threadId: string; unattended?: boolean; peerAsk: PeerAsk }): Promise<unknown>;
  escalationsEnabled(): boolean;
  /** The thread's last run has ended but is still shutting down. */
  threadSettling?(threadId: string): boolean;
  /** The thread waits for a free slot and starts on its own. */
  threadQueued?(botId: string, threadId: string): boolean;
  /** Runs OpenMausBot's automatic retry after the failed turn's own handling is done; the host's next tick by default. */
  schedule?(run: () => void): void;
  /** Security invariant: a read-and-draft run's prompt and reply carry mail and invite text, so its failures and
   * questions never reach a Chief as a notice. */
  quietThread?(botId: string, threadId: string): boolean;
  /** A person's private chat on a Team Cloud: its notices go to that person, never into a Chief's thread the team reads. */
  privateThread?(threadId: string): boolean;
  /** A Team Cloud: a notice reaches a Chief only when the conversation's asks are its person's (a member's private chat
   * is theirs alone), into a notices chat of that person's own. */
  routing?: {
    askedPerson(botId: string, threadId: string): string | null;
    personOf(chief: BotRecord): string | null;
    startedBy(threadId: string): string | undefined;
    open(threadId: string, person: string): void;
  };
}

export function createChiefNotices(deps: ChiefNoticeDeps) {
  const { store } = deps;
  const incidentLedger = new IncidentLedger();
  const escalationLedger = new EscalationLedger();
  const schedule = deps.schedule ?? ((run: () => void) => { setTimeout(run, 0).unref?.(); });

  /** Why a teammate's stopped thread cannot be retried now, in words a Chief can act on, or null. */
  function retryRefusal(botId: string, threadId: string): string | null {
    const blocked = deps.threadBusy(botId, threadId) ? (deps.threadSettling?.(threadId) ? "settling" : "running")
      : deps.threadQueued?.(botId, threadId) ? "queued" : null;
    if (blocked) return RETRY_BLOCKED[blocked];
    // A thread that finished a run since it was last reported has nothing to resume: resuming would redo finished work.
    const reportedAt = incidentLedger.lastAt(threadId);
    if (reportedAt !== undefined && store.activePath(threadId).some((line) => line.turnSucceeded === true && line.at > reportedAt)) {
      return "that thread has finished a run since it was reported — there is nothing to retry; read what it did before deciding anything else";
    }
    return null;
  }

  /** The one way a teammate's stopped thread runs again: a Chief's retry_thread and OpenMausBot's automatic retry both
   * start it here, after the same refusal checks. Throws the refusal, or why the start failed. */
  async function retryThread(input: { chief: BotRecord; bot: BotRecord; threadId: string; unattended: boolean; note?: string; automatic?: true }): Promise<void> {
    const refused = retryRefusal(input.bot.id, input.threadId);
    if (refused) throw new Error(refused);
    const chief = peerName(input.chief.name);
    const lead = input.automatic
      ? `${AUTO_RETRY_LEAD}, once, before telling ${chief}, your Chief of Staff, that this thread's last run failed.`
      : `${RETRY_LEAD}${chief}, your Chief of Staff, after this thread's last run stopped.${input.note ? ` Note from ${chief}: ${quoteInNote(input.note, 300)}` : ""}`;
    await deps.startTurn(input.bot.id, `${lead} Continue the request above from where it stopped and finish it. If the same problem comes back, say exactly what is blocking and stop.]`,
      { threadId: input.threadId, unattended: input.unattended, peerAsk: { botId: input.chief.id, name: input.chief.name, ...(input.unattended ? { unattended: true } : {}) } });
  }

  /** A notice about this thread may go to `chief`: its asks are the Chief's person's, never another person's private chat. */
  function reachesChief(chief: BotRecord, bot: BotRecord, threadId: string): boolean {
    const routing = deps.routing;
    return routing ? routing.askedPerson(bot.id, threadId) === routing.personOf(chief) : deps.privateThread?.(threadId) !== true;
  }

  function incidentRefused(chief: BotRecord, incidentsThreadId: string, asks: ReadonlyArray<Message["peerAsk"]>, why: string): void {
    const refused = `the incident could not reach ${chief.name} — ${why}`;
    store.appendMessage(incidentsThreadId, { role: "bot", kind: "activity", tool: failedTurnTool(refused) });
    const lines = store.messagesFor(incidentsThreadId);
    for (const ask of asks) {
      if (!ask?.incident || ask.incident.notified) continue;
      const bot = store.bot(ask.botId);
      if (!bot) continue;
      const { threadId } = ask.incident;
      const chip = lines.findLast(line => line.kind === "activity" && line.tool?.ok === false && line.threadRef?.threadId === threadId)?.tool?.name;
      const group = store.groupByThread(threadId);
      deps.notify(buildNotification("incident", bot, threadId, chip ?? refused, {
        avatarUrl: bot.avatarUrl,
        ...(group ? { group: { id: group.id, name: group.name } } : {}),
      }));
    }
  }

  function deliver(input: {
    chief: BotRecord | null; title: string; bot: BotRecord; threadId: string; chip: string; text: string; alreadyNotified: boolean;
  }): "chief" | "person" {
    const { chief, bot, threadId } = input;
    const task = store.taskByThread(bot.id, threadId);
    const group = store.groupByThread(threadId);
    const tellThePerson = () => {
      if (!input.alreadyNotified) {
        deps.notify(buildNotification("incident", bot, threadId, input.chip, {
          avatarUrl: bot.avatarUrl,
          ...(group ? { group: { id: group.id, name: group.name } } : {}),
        }));
      }
      return "person" as const;
    };
    const routing = deps.routing;
    const person = chief && routing ? routing.personOf(chief) : null;
    if (!chief || !reachesChief(chief, bot, threadId)) return tellThePerson();
    const notices = store.tasks(chief.id).find((candidate) => candidate.title === input.title && !candidate.archivedAt &&
        (!routing || routing.startedBy(candidate.threadId) === (person ?? undefined)))
      ?? store.createTask(chief.id, input.title, false, undefined, { botId: chief.id, name: chief.name, at: Date.now() });
    if (!notices || notices.threadId === threadId) return tellThePerson();
    if (routing && person && routing.startedBy(notices.threadId) === undefined) routing.open(notices.threadId, person);
    store.appendMessage(notices.threadId, {
      role: "bot",
      kind: "activity",
      tool: { name: input.chip, ok: false },
      threadRef: { botId: bot.id, threadId, title: task?.title ?? (group ? group.name : `${bot.name}'s conversation`) },
    });
    const peerAsk = { botId: bot.id, name: bot.name, unattended: true,
      incident: { threadId, ...(input.alreadyNotified ? { notified: true } : {}) } };
    const decision = admit("incident", {}, {
      threadBusy: deps.threadBusy(chief.id, notices.threadId),
      atCapacity: deps.botAtThreadCapacity(chief.id),
      groupTurn: deps.groupTurnActive(chief.id),
    });
    if (decision.action === "queue") {
      queueSteeredMessage(chief.id, notices.threadId, input.text, { reason: decision.reason, unattended: true, peerAsk });
      return "chief";
    }
    void deps.startTurn(chief.id, input.text, { threadId: notices.threadId, unattended: true, peerAsk }).catch((error) => {
      incidentRefused(chief, notices.threadId, [peerAsk], error instanceof Error ? error.message : String(error));
    });
    return "chief";
  }

  /** A failed teammate run gets one retry from OpenMausBot before its Chief hears; the Chief then hears how that retry ended.
   * Never retried: a stall the turn watchdog stopped (kind "stalled"), a stop, a refusal or a cap (retriesTeammateThread,
   * from the failure's words and `facts`), a run that answered a retry, and a thread whose asks are not the Chief's person's. */
  function reportIncident(input: { kind: IncidentKind; bot: BotRecord; threadId: string; detail: string; facts?: RoutineFailureFacts }): void {
    const { bot, threadId } = input;
    if (deps.quietThread?.(bot.id, threadId)) return;
    const task = store.taskByThread(bot.id, threadId);
    if (deps.assignerOf(threadId)) return;
    const group = store.groupByThread(threadId);
    const incident: Incident = {
      kind: input.kind,
      bot,
      threadId,
      title: task?.title ?? null,
      room: group?.name ?? null,
      detail: redactSecretsInText(input.detail),
      ...incidentContext(deps.store.messagesFor(threadId)),
    };
    const count = incidentLedger.note(threadId);
    if (count.muted) return;
    const chief = chiefForBot(store.bots, bot);
    const report = (retry?: IncidentRetry): void => void deliver({
      chief, title: INCIDENTS_THREAD_TITLE, bot, threadId,
      chip: incidentChip(incident), text: incidentText(incident, count, retry),
      alreadyNotified: input.kind === "could-not-start" || input.kind === "routine-failed",
    });
    if (!chief || group || !reachesChief(chief, bot, threadId)) return report();
    const answered = store.activePath(threadId).findLast((line) => line.role === "user")?.text ?? "";
    if (answered.startsWith(AUTO_RETRY_LEAD)) return report({ retried: true });
    if (input.kind !== "failed" || answered.startsWith(RETRY_LEAD) || !count.mayRetry || !retriesTeammateThread(input.detail, input.facts)) return report();
    const failedAt = Date.now();
    schedule(() => {
      if (!store.bot(bot.id) || !store.taskByThread(bot.id, threadId)) return;
      if (store.activePath(threadId).some((line) => line.role === "user" && line.at > failedAt)) return report({ notRetried: "someone wrote in that thread since" });
      retryThread({ chief, bot, threadId, unattended: true, automatic: true })
        .catch((error) => report({ notRetried: `its retry could not start (${error instanceof Error ? error.message : String(error)})` }));
    });
  }

  // Advisory: a delivery fault is logged and never reaches the gate, the turn fold or the caller's own outcome.
  function reportEscalation(input: {
    kind: EscalationKind; bot: BotRecord; threadId: string; gate: string; reason: string; alreadyNotified: boolean;
  }): EscalationOutcome {
    if (!deps.escalationsEnabled()) return "off";
    try {
      const { bot, threadId } = input;
      if (deps.quietThread?.(bot.id, threadId)) return "skipped";
      if (input.kind === "needs-input" && deps.assignerOf(threadId)) return "skipped";
      const task = store.taskByThread(bot.id, threadId);
      const group = store.groupByThread(threadId);
      const escalation: Escalation = {
        kind: input.kind,
        bot,
        threadId,
        title: task?.title ?? null,
        room: group?.name ?? null,
        gate: input.gate,
        reason: redactSecretsInText(input.reason),
      };
      const count = escalationLedger.note(threadId);
      if (count.muted) return "muted";
      const chief = chiefForBot(store.bots, bot);
      return deliver({
        chief: chief && escalationDeliverable(chief, bot) ? chief : null, title: ESCALATIONS_THREAD_TITLE, bot, threadId,
        chip: escalationChip(escalation), text: escalationText(escalation, count), alreadyNotified: input.alreadyNotified,
      });
    } catch (error) {
      console.warn(`escalation for thread ${input.threadId} not delivered: ${error instanceof Error ? error.message : String(error)}`);
      return "failed";
    }
  }

  return { reportIncident, reportEscalation, incidentRefused, retryRefusal, retryThread };
}
