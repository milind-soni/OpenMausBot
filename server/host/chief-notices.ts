import { failedTurnTool } from "../../shared/failed-turn.ts";
import { admit } from "../admission.ts";
import { ESCALATIONS_THREAD_TITLE, EscalationLedger, escalationChip, escalationDeliverable, escalationText, type Escalation, type EscalationKind } from "../escalations.ts";
import { chiefForBot, INCIDENTS_THREAD_TITLE, IncidentLedger, incidentChip, incidentContext, incidentText, type Incident, type IncidentKind } from "../incidents.ts";
import { buildNotification, type Notification } from "../notify.ts";
import { redactSecretsInText } from "../redact.ts";
import { queueSteeredMessage } from "../steer-queue.ts";
import type { BotRecord, Message, Store } from "../store.ts";

type PeerAsk = NonNullable<Message["peerAsk"]>;

export type EscalationOutcome = "chief" | "person" | "muted" | "off" | "skipped" | "failed";

export interface ChiefNoticeDeps {
  store: Pick<Store, "bots" | "bot" | "tasks" | "taskByThread" | "groupByThread" | "createTask" | "appendMessage" | "messagesFor">;
  assignerOf(threadId: string): unknown;
  notify(notification: Notification | null): void;
  threadBusy(botId: string, threadId: string): boolean;
  botAtThreadCapacity(botId: string): boolean;
  groupTurnActive(botId: string): boolean;
  startTurn(botId: string, text: string, opts: { threadId: string; unattended: true; peerAsk: PeerAsk }): Promise<unknown>;
  escalationsEnabled(): boolean;
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
    const elsewhere = routing ? routing.askedPerson(bot.id, threadId) !== person : deps.privateThread?.(threadId) === true;
    if (!chief || elsewhere) return tellThePerson();
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

  function reportIncident(input: { kind: IncidentKind; bot: BotRecord; threadId: string; detail: string }): void {
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
    deliver({
      chief: chiefForBot(store.bots, bot), title: INCIDENTS_THREAD_TITLE, bot, threadId,
      chip: incidentChip(incident), text: incidentText(incident, count),
      alreadyNotified: input.kind === "could-not-start" || input.kind === "routine-failed",
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

  return { reportIncident, reportEscalation, incidentRefused, incidentLastAt: (threadId: string) => incidentLedger.lastAt(threadId) };
}
