import { failedTurnTool } from "../../shared/failed-turn.ts";
import { admit } from "../admission.ts";
import { engineMemory, memoryStopped } from "../engine-memory.ts";
import { outOfProcesses } from "../process-shortage.ts";
import {
  AUTO_RETRY_LEAD, ChiefIncidentBudget, chiefForBot, INCIDENTS_THREAD_TITLE, OLD_INCIDENTS_THREAD_TITLE, IncidentLedger, incidentChip, incidentContext, incidentText, RETRY_BLOCKED, RETRY_LEAD,
  type Incident, type IncidentKind, type IncidentRetry,
} from "../incidents.ts";
import { buildNotification, type Notification } from "../notify.ts";
import { quoteInNote } from "../peer-provenance.ts";
import { peerName } from "../peer-roster.ts";
import { redactSecretsInText } from "../redact.ts";
import { serverLine } from "../server-lines.ts";
import { retriesTeammateThread, type RoutineFailureFacts } from "../routine-recovery.ts";
import { queueSteeredMessage } from "../steer-queue.ts";
import type { BotRecord, Message, Store } from "../store.ts";
import type { Coordinator, CoordinateBotsCall } from "../coordinator.ts";
import type { PeerDeliveryReceipt } from "../peer-delivery.ts";

type PeerAsk = NonNullable<Message["peerAsk"]>;

export interface ChiefNoticeDeps {
  store: Pick<Store, "bots" | "bot" | "tasks" | "taskByThread" | "groupByThread" | "createTask" | "appendMessage" | "messagesFor" | "activePath"> & Partial<Pick<Store, "patchMessage">>;
  assignerOf(threadId: string): unknown;
  /** Who asked, with reply resume, for this thread's newest assignment, and whether it was a question, when it failed (`failedRequester`). */
  failedRequester?(threadId: string): FailedRequest | undefined;
  notify(notification: Notification | null): void;
  threadBusy(botId: string, threadId: string): boolean;
  botAtThreadCapacity(botId: string): boolean;
  groupTurnActive(botId: string): boolean;
  startTurn(botId: string, text: string, opts: { threadId: string; unattended?: boolean; peerAsk: PeerAsk }): Promise<unknown>;
  /** The thread's last run has ended but is still shutting down. */
  threadSettling?(threadId: string): boolean;
  /** The thread waits for a free slot and starts on its own. */
  threadQueued?(botId: string, threadId: string): boolean;
  /** Runs OpenMausBot's automatic retry after the failed turn's own handling is done; the host's next tick by default. */
  schedule?(run: () => void): void;
  /** Starts this thread's request again where it stopped: a continuation of the request the harness recorded, never a line
   * of the person's. Absent: a run stopped for memory with no Chief to retry it is only reported. */
  continueRequest?(botId: string, threadId: string, text: string): Promise<unknown>;
  /** A self-hosted server where turns wait for room: a run stopped for memory there is the server's shortage, as a start
   * it had no room for is, and no Chief is asked about it. */
  selfHosted?(): boolean;
  /** Runs a retry after a run stopped for memory, MEMORY_RETRY_MS later by default, so the machine settles first. */
  later?(run: () => void, ms: number): void;
  /** Security invariant: a read-and-draft run's prompt and reply carry mail and invite text, so its failures and
   * questions never reach a Chief as a notice. */
  quietThread?(botId: string, threadId: string): boolean;
  /** A person's private chat on a Team Cloud: its notices go to that person, never into a Chief's thread the team reads. */
  privateThread?(threadId: string): boolean;
  /** Security invariant: a confined conversation's words never start a Chief's turn at its own level, so its notices go to a person. */
  confined?(threadId: string): boolean;
  /** The language a line about this conversation is written in for its person (server/server-lines.ts). */
  threadLanguage?(threadId: string): string | undefined;
  /** The incident turns a Chief may start in an hour, across threads (OMB_CHIEF_INCIDENT_TURNS_PER_HOUR by default). */
  chiefTurnsPerHour?(): number;
  now?(): number;
  /** A Team Cloud: a notice reaches a Chief only when the conversation's asks are its person's (a member's private chat
   * is theirs alone), into a notices chat of that person's own. */
  routing?: {
    askedPerson(botId: string, threadId: string): string | null;
    personOf(chief: BotRecord): string | null;
    startedBy(threadId: string): string | undefined;
    open(threadId: string, person: string): void;
  };
}

/** How long a run stopped for memory waits before it starts again; the memory gate then holds it until there is room. */
export const MEMORY_RETRY_MS = 30_000;
/** The chats a Chief's line for the problems it was not started for names; its count covers the rest. */
export const FOLDED_LISTED = 5;
export const MEMORY_RETRY_TEXT = "[OpenMausBot started this again by itself, once: the last run was stopped to free memory on this Cloud. "
  + "Continue the request above from where it stopped and finish it. If the same problem comes back, say exactly what is blocking and stop.]";

export const SERVER_MEMORY_RETRY_TEXT = "[OpenMausBot started this again by itself, once: the last run was stopped to free memory on this server. "
  + "Continue the request above from where it stopped and finish it. If the same problem comes back, say exactly what is blocking and stop.]";

/** A run the server had no room to start is the server's shortage: it starts again by itself, and no AI is asked about it. */
export const ROOM_RETRY_TEXT = "[OpenMausBot started this again by itself, once: the last run could not start because this server had no room for another program. "
  + "Continue the request above from where it stopped and finish it. If the same problem comes back, say exactly what is blocking and stop.]";

/** The bot that asked, with reply resume, for this thread's newest assignment, and whether it asked a question (consult). */
export interface FailedRequest { botId: string; consult: boolean }

/** Who asked for the work this thread's newest assignment was, when that assignment failed. */
export function failedRequester(coordinator: Pick<Coordinator, "inThread" | "node">, threadId: string): FailedRequest | undefined {
  const last = coordinator.inThread(threadId).at(-1);
  const botId = last?.status === "failed" && last.reply === "resume" && last.parentId ? coordinator.node(last.parentId)?.botId : undefined;
  return last && botId ? { botId, consult: last.mode === "consult" } : undefined;
}

/** What retry_thread tells the Chief: a retry of its own failed request comes back to it; any other result stays there. */
export function retriedMessage(botName: string, title: string, how: "request" | "turn"): string {
  return how === "request"
    ? `${botName}'s thread #${title} is running again as a new request from you: its result comes back to this conversation and resumes you.`
    : `${botName}'s thread #${title} is running again. Its result stays in that thread; you are not woken for it — check later with list_threads or session_search if you need to.`;
}

export function createChiefNotices(deps: ChiefNoticeDeps) {
  const { store } = deps;
  const incidentLedger = new IncidentLedger();
  const chiefBudget = new ChiefIncidentBudget({ now: deps.now, limit: deps.chiefTurnsPerHour });
  /** Each Chief's line that counts the problems it was not started for, while its hour's share is spent. */
  const folded = new Map<string, { threadId: string; messageId: string; count: number; until: number; chats: Array<{ botId: string; threadId: string; title: string; name: string }> }>();
  const schedule = deps.schedule ?? ((run: () => void) => { setTimeout(run, 0).unref?.(); });
  const later = deps.later ?? ((run: () => void, ms: number) => { setTimeout(run, ms).unref?.(); });
  /** Each thread's last request a run stopped for memory was started again for: once a request. */
  const roomRetries = new Map<string, string>();

  /** A run stopped for memory that no Chief retries starts once more by itself; the person hears only if that one fails too,
   * or can't start. Never a run whose thread someone wrote in since, or that is running or queued again. */
  function retryForRoom(bot: BotRecord, threadId: string, report: (retry?: IncidentRetry) => void, text = MEMORY_RETRY_TEXT): boolean {
    const continueRequest = deps.continueRequest;
    if (!continueRequest) return false;
    const asked = store.activePath(threadId).findLast((line) => line.role === "user")?.id ?? "";
    if (roomRetries.get(threadId) === asked) { report({ retried: true }); return true; }
    roomRetries.set(threadId, asked);
    if (roomRetries.size > 500) roomRetries.delete(roomRetries.keys().next().value!);
    const failedAt = Date.now();
    later(() => {
      if (!store.bot(bot.id) || !store.taskByThread(bot.id, threadId)) return;
      if (store.activePath(threadId).some((line) => line.role === "user" && line.at > failedAt)) return;
      if (deps.threadBusy(bot.id, threadId) || deps.threadQueued?.(bot.id, threadId)) return;
      continueRequest(bot.id, threadId, text)
        .catch((error) => report({ notRetried: `its retry could not start (${error instanceof Error ? error.message : String(error)})` }));
    }, MEMORY_RETRY_MS);
    return true;
  }

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
   * start it here, after the same refusal checks. Throws the refusal, or why the start failed. A Chief's retry of an idle
   * thread whose bot is busy elsewhere (at its turn limit, or in a room's turn) waits in that thread's queue instead, and
   * the queue starts it when the bot frees up. A thread that still runs, shuts down or already waits is refused as before. */
  async function retryThread(input: { chief: BotRecord; bot: BotRecord; threadId: string; unattended: boolean; note?: string; automatic?: true;
    /** The retrying Chief's own coordinate_bots, from its current turn; left out from a room, where it would address the room, not this thread. */
    coordinateBots?: (call: CoordinateBotsCall) => Promise<{ status: number; body: Record<string, unknown> }> }): Promise<"request" | "turn" | "queued"> {
    const refused = retryRefusal(input.bot.id, input.threadId);
    if (refused) throw new Error(refused);
    // The Chief's own request failed here: it asks again from its current turn, so the result wakes it as the first would have.
    const failed = input.automatic || !input.coordinateBots ? undefined : deps.failedRequester?.(input.threadId);
    if (input.coordinateBots && failed?.botId === input.chief.id) {
      const note = input.note ? ` Note: ${quoteInNote(input.note, 300)}` : "";
      // A question stays a question: asked again, the teammate still acts on nothing.
      const sent = await input.coordinateBots({ botIds: [input.bot.id], thread: input.threadId, reply: "resume", consult: failed.consult, rework: false,
        message: `Your last run in this thread stopped before it finished my request, so I am asking again.${note} Continue the request above from where it stopped and finish it. If the same problem comes back, say exactly what is blocking and stop.` });
      const receipt = (sent.body.receipts as PeerDeliveryReceipt[] | undefined)?.[0];
      if (sent.status !== 200 || !receipt || receipt.outcome === "failed") throw new Error(String(receipt?.detail ?? sent.body.error ?? "Not delivered."));
      return "request";
    }
    const chief = peerName(input.chief.name);
    const lead = input.automatic
      ? `${AUTO_RETRY_LEAD}, once, before telling ${chief}, your Chief of Staff, that this thread's last run failed.`
      : `${RETRY_LEAD}${chief}, your Chief of Staff, after this thread's last run stopped.${input.note ? ` Note from ${chief}: ${quoteInNote(input.note, 300)}` : ""}`;
    const text = `${lead} Continue the request above from where it stopped and finish it. If the same problem comes back, say exactly what is blocking and stop.]`;
    const peerAsk = { botId: input.chief.id, name: input.chief.name, ...(input.unattended ? { unattended: true } : {}) };
    const atCapacity = !input.automatic && deps.botAtThreadCapacity(input.bot.id);
    if (atCapacity || (!input.automatic && deps.groupTurnActive(input.bot.id))) {
      queueSteeredMessage(input.bot.id, input.threadId, text, { reason: atCapacity ? "capacity" : "group-turn", unattended: input.unattended, peerAsk });
      return "queued";
    }
    await deps.startTurn(input.bot.id, text, { threadId: input.threadId, unattended: input.unattended, peerAsk });
    return "turn";
  }

  /** A notice about this thread may go to `chief`: its asks are the Chief's person's, never another person's private chat. */
  function reachesChief(chief: BotRecord, bot: BotRecord, threadId: string): boolean {
    const routing = deps.routing;
    if (deps.confined?.(threadId)) return false;
    return routing ? routing.askedPerson(bot.id, threadId) === routing.personOf(chief) : deps.privateThread?.(threadId) !== true;
  }

  function incidentRefused(chief: BotRecord, incidentsThreadId: string, asks: ReadonlyArray<Message["peerAsk"]>, why: string): void {
    const refused = `the problem report could not reach ${chief.name} — ${why}`;
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

  /** Past its hour's share a Chief is not started again: the problems are counted on one line in its notices chat, which
   * lists the chats they came from (the first FOLDED_LISTED) and links the newest. */
  function fold(chief: BotRecord, threadId: string, until: number, from: { botId: string; threadId: string; title: string; name: string }): void {
    const open = folded.get(chief.id), now = deps.now?.() ?? Date.now();
    const same = open && open.threadId === threadId && open.until > now ? open : null;
    const count = (same?.count ?? 0) + 1;
    const chats = same?.chats.some((chat) => chat.threadId === from.threadId) ? same.chats : [...(same?.chats ?? []), from];
    const list = chats.slice(0, FOLDED_LISTED).map((chat) => chat.name).join("; ");
    const name = serverLine(deps.threadLanguage?.(threadId), "server.incidents.folded", { count, chief: chief.name, list });
    const threadRef = { botId: from.botId, threadId: from.threadId, title: from.title };
    const line = same && store.patchMessage?.(threadId, same.messageId, { tool: { name, ok: false }, threadRef })
      || store.appendMessage(threadId, { role: "bot", kind: "activity", tool: { name, ok: false }, threadRef });
    folded.set(chief.id, { threadId, messageId: line.id, count, chats, until: Math.max(until, same?.until ?? 0) });
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
    const notices = store.tasks(chief.id).find((candidate) => (candidate.title === input.title || (input.title === INCIDENTS_THREAD_TITLE && candidate.title === OLD_INCIDENTS_THREAD_TITLE)) && !candidate.archivedAt &&
        (!routing || routing.startedBy(candidate.threadId) === (person ?? undefined)))
      ?? store.createTask(chief.id, input.title, false, undefined, { botId: chief.id, name: chief.name, at: Date.now() }, undefined, undefined, undefined,
        routing && person ? (created) => routing.open(created.threadId, person) : undefined);
    if (!notices || notices.threadId === threadId) return tellThePerson();
    if (routing && person && routing.startedBy(notices.threadId) === undefined) routing.open(notices.threadId, person);
    const spent = chiefBudget.take(chief.id);
    if (spent) {
      const title = task?.title ?? (group ? group.name : `${bot.name}'s conversation`);
      fold(chief, notices.threadId, spent.until, { botId: bot.id, threadId, title, name: `${bot.name} · ${title}` });
      tellThePerson();
      return "chief";
    }
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
  /** `notified`: the person already heard of it another way (a usage limit's own notice), so only the Chief is told. */
  /** `failure`: the failure's own words when `detail` adds a name to them; only those are read for the kind of failure. */
  function reportIncident(input: { kind: IncidentKind; bot: BotRecord; threadId: string; detail: string; failure?: string; facts?: RoutineFailureFacts; notified?: boolean }): void {
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
      failure: { text: input.failure ?? input.detail, stopReason: input.facts?.stopReason },
      ...incidentContext(deps.store.messagesFor(threadId)),
    };
    const count = incidentLedger.note(threadId);
    if (count.muted) return;
    const chief = chiefForBot(store.bots, bot);
    const report = (retry?: IncidentRetry): void => void deliver({
      chief, title: INCIDENTS_THREAD_TITLE, bot, threadId,
      chip: incidentChip(incident, deps.threadLanguage?.(threadId)), text: incidentText(incident, count, retry),
      alreadyNotified: input.notified === true || input.kind === "could-not-start" || input.kind === "routine-failed",
    });
    const chiefRetries = Boolean(chief && !group && reachesChief(chief, bot, threadId));
    // Before any Chief hears: a Chief's turn about it would be a paid one, started on the same full server.
    const noRoom = outOfProcesses(input.detail), stoppedHere = !noRoom && memoryStopped(input.detail) && (deps.selfHosted ?? (() => engineMemory.selfHosted()))();
    if (noRoom || stoppedHere) {
      const person = (retry?: IncidentRetry): void => void deliver({ chief: null, title: INCIDENTS_THREAD_TITLE, bot, threadId, chip: incidentChip(incident, deps.threadLanguage?.(threadId)),
        text: incidentText(incident, count, retry), alreadyNotified: input.notified === true || input.kind === "could-not-start" || input.kind === "routine-failed" });
      if (group || input.kind === "routine-failed" || !retryForRoom(bot, threadId, person, noRoom ? ROOM_RETRY_TEXT : SERVER_MEMORY_RETRY_TEXT)) person();
      return;
    }
    if (input.kind === "failed" && !group && !chiefRetries && memoryStopped(input.detail) && retryForRoom(bot, threadId, report)) return;
    if (!chief || !chiefRetries) return report();
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

  return { reportIncident, incidentRefused, retryRefusal, retryThread };
}
