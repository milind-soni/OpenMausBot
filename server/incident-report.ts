// The incidents delivery path — extracted from the harness host (index.ts).
// The policy (chip, report text, retry budget) lives in ./incidents.ts; this
// module turns a broken run into a turn of the Chief of Staff's. The host
// (engine-wiring.ts) binds setIncidentReportHost once at boot, after the
// delegation watch exists; the failure sites — dispatch settlement, the
// stall watchdog, turn completion, the routine wiring — import
// reportIncident directly, exactly as they reached for it in index.ts
// before the split.
import type { DelegationWatchEntry } from "./delegation-watch.ts";
import {
  INCIDENTS_THREAD_TITLE,
  IncidentLedger,
  chiefForBot,
  incidentChip,
  incidentText,
  type Incident,
  type IncidentKind,
} from "./incidents.ts";
import { buildNotification, type Notification } from "./notify.ts";
import { redactSecretsInText } from "./redact.ts";
import type { RoomHandoffs } from "./room-handoffs.ts";
import { store } from "./runtime.ts";
import type { BotRecord, GroupRecord, Message } from "./store.ts";
import { queueSteeredMessage } from "./steer-queue.ts";
import { botAtThreadCapacity } from "./turn-admission.ts";

/** Everything the reporter reads from its host. Thunks cover the consts
 * engine-wiring declares after the binding site, mirroring the lateBound
 * families its other factories take. */
export interface IncidentReportHost {
  delegationWatch: Map<string, DelegationWatchEntry>;
  roomHandoffs(): RoomHandoffs;
  notify(notification: Notification | null): void;
  activeGroupTurnForBot(botId: string): { group: GroupRecord; threadId: string } | null;
  startTurn(botId: string, text: string, opts?: { threadId?: string; unattended?: boolean; peerAsk?: Message["peerAsk"] }): Promise<unknown>;
}

let host: IncidentReportHost | null = null;

/** Bind the host once at boot; before that, reports are dropped, which is
 * exactly right — nothing can break before the engine exists. */
export function setIncidentReportHost(next: IncidentReportHost): void {
  host = next;
}

/** What the broken thread was about: the last line the person (or the
 * requester) sent there, and the last thing the bot said. */
function incidentContext(threadId: string): { lastRequest: string | null; lastReply: string | null } {
  const messages = [...store.messagesFor(threadId)].reverse();
  return {
    lastRequest: messages.find((message) => message.role === "user" && message.kind === "text" && message.text)?.text ?? null,
    lastReply: messages.find((message) => message.role === "bot" && message.kind === "text" && message.text)?.text ?? null,
  };
}

// a crash loop is one incident, not a storm
const incidentLedger = new IncidentLedger();

export function reportIncident(input: { kind: IncidentKind; bot: BotRecord; threadId: string; detail: string }): void {
  if (!host) return;
  const bound = host;
  const { bot, threadId } = input;
  const task = store.taskByThread(bot.id, threadId);
  // A thread another bot opened and is watching is that bot's to handle:
  // the delegator is woken with the failure already (wakeDelegationSource).
  if (task?.openedBy?.delegationId || bound.delegationWatch.has(threadId) || bound.roomHandoffs().activeDirect(threadId)) return;
  const group = store.groupByThread(threadId);
  const incident: Incident = {
    kind: input.kind,
    bot,
    threadId,
    title: task?.title ?? null,
    room: group?.name ?? null,
    detail: redactSecretsInText(input.detail),
    ...incidentContext(threadId),
  };
  const count = incidentLedger.note(threadId);
  if (count.muted) return;
  const chief = chiefForBot(store.bots, bot);
  // A run that could not start and a failed routine have already buzzed
  // the person (turn-failed, routine-failed) by the time they get here; a
  // failure or stall mid-run has not. One notification per failure, never two.
  const alreadyNotified = input.kind === "could-not-start" || input.kind === "routine-failed";
  const tellThePerson = () => {
    if (alreadyNotified) return;
    bound.notify(buildNotification("incident", bot, threadId, incidentChip(incident), {
      avatarUrl: bot.avatarUrl,
      ...(group ? { group: { id: group.id, name: group.name } } : {}),
    }));
  };
  // no Chief on duty, or the Chief itself broke: the person is next
  if (!chief) {
    tellThePerson();
    return;
  }
  const incidents = store.tasks(chief.id).find((candidate) => candidate.title === INCIDENTS_THREAD_TITLE && !candidate.archivedAt)
    ?? store.createTask(chief.id, INCIDENTS_THREAD_TITLE, false, undefined, { botId: chief.id, name: chief.name, at: Date.now() });
  if (!incidents || incidents.threadId === threadId) {
    tellThePerson();
    return;
  }
  store.appendMessage(incidents.threadId, {
    role: "bot",
    kind: "activity",
    tool: { name: incidentChip(incident), ok: false },
    threadRef: { botId: bot.id, threadId, title: task?.title ?? (group ? group.name : `${bot.name}'s conversation`) },
  });
  const text = incidentText(incident, count);
  // the report carries the broken bot's name as its provenance: it is about
  // that bot's work and nobody was at the keyboard
  const peerAsk = { botId: bot.id, name: bot.name, unattended: true };
  if (botAtThreadCapacity(chief.id) || bound.activeGroupTurnForBot(chief.id)) {
    queueSteeredMessage(chief.id, incidents.threadId, text, { reason: "capacity", unattended: true, peerAsk });
    return;
  }
  void bound.startTurn(chief.id, text, { threadId: incidents.threadId, unattended: true, peerAsk }).catch((error) => {
    const why = error instanceof Error ? error.message : String(error);
    store.appendMessage(incidents.threadId, {
      role: "bot",
      kind: "activity",
      tool: { name: `error: the incident could not reach ${chief.name} — ${why.slice(0, 120)}`, ok: false },
    });
    tellThePerson();
  });
}
