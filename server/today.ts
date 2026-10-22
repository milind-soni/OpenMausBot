// What a person's bots finished in a window, what only the person can fix,
// and the time it saved, computed on each read from the transcript rows and
// routine runs the server already keeps.
import { isPersistentQuestionCard, type QuestionRequestCardData } from "../shared/ask-question.ts";
import type { TurnDigest } from "../shared/digest.ts";
import { isClientCancellation } from "../shared/client-cancel.ts";
import { failedTurnCause } from "../shared/failed-turn.ts";
import type { PlaceRow, PlaceState } from "../shared/place-view.ts";
import type { RoutineRunReport, RoutineRunStatus, RoutineRunTrigger } from "../shared/routines.ts";
import { classifyToolCall, isReportRoutine, minutesSaved, OUTCOME_CATEGORIES, toolApps, type OutcomeCategory, type OutcomeCounts } from "../shared/today-outcomes.ts";
import { NEEDS_YOU_WINDOW_MS, TODAY_MAX_LINES, TODAY_MAX_WINDOW_MS, type NeedsYouItem, type TodayLine, type TodayReport, type TodayStarter } from "../shared/today.ts";
import { trialCreditKind } from "../shared/trial-credit.ts";
import { toolkitName } from "./activity.ts";
import { classifyError } from "./drivers/retry.ts";
import { attentionRows, requestSenders, successfulCallsMentioning, workRows, type AttentionRow, type WorkRow } from "./message-db.ts";

export interface TodayViewer {
  /** Engines, plans and connected apps are an admin's to fix; anyone else sees only their bots' questions. */
  admin: boolean;
  thread(threadId: string): boolean;
  routine(run: { botId?: unknown; groupId?: unknown }): boolean;
}

interface RunRecord {
  id: string;
  routineId: string;
  routineName: string;
  botId: string;
  groupId?: string;
  status: RoutineRunStatus;
  manual: boolean;
  triggerSource?: RoutineRunTrigger;
  threadId?: string;
  scheduledFor: number;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
  report?: RoutineRunReport;
}

export interface TodaySources {
  bots: ReadonlyArray<{ id: string; threadId: string; tasks?: ReadonlyArray<{ threadId: string }>; modelSelection?: { instanceId: string } }>;
  groups: ReadonlyArray<{ id: string; threadId: string; tasks?: ReadonlyArray<{ threadId: string }> }>;
  routines: { listRoutines(): ReadonlyArray<{ botId: string; groupId?: string }>; listRuns(from?: number): readonly RunRecord[] } | null;
  engines: ReadonlyArray<{ instanceId: string; snapshot?: { state: string; authenticated?: boolean } }>;
  /** Work parked on a question for the person (a NEEDS INPUT line rather than a card). */
  parked: ReadonlyArray<{ id: string; botId: string; threadId: string; question?: string; createdAt: number }>;
}

/** Place failures a person fixes by changing a setting or plan; the rest pass or retry by themselves. */
const OWNER_PLACES: ReadonlySet<PlaceState> = new Set([
  "cc-cannot", "cc-tools-off", "cc-sign-in", "cc-no-hours", "cc-at-once", "cc-ended", "cc-on-my-cloud", "cc-needs-key",
  "browser-off", "browser-cannot", "vm-cannot",
]);
/** A connected app refusing for want of a working sign-in, as Composio and the apps behind it word it. */
const BROKEN_CONNECTION = /\b(?:401|unauthori[sz]ed|invalid[_ ]grant|(?:token|credentials?) (?:has |have )?(?:expired|been revoked)|expired (?:token|credentials?)|re-?authori[sz]e|re-?authenticate|reconnect|no (?:active )?connected account|connected ?account (?:not found|is (?:inactive|expired|disabled))|connection (?:is )?(?:inactive|expired|revoked|not found)|insufficient[_ ](?:scopes?|permissions?)|ACCESS_TOKEN_SCOPE_INSUFFICIENT|not connected)\b/i;
const KIND_ORDER: Record<NeedsYouItem["kind"], number> = { "signed-out": 0, "out-of-credit": 1, "usage-limit": 2, connection: 3, place: 4, question: 5 };
const DAY_MS = 24 * 60 * 60_000;
const TITLE_CHARS = 160;
/** A failed row and the summary its turn ends with are written this close together. */
const FAILURE_SETTLES_MS = 30_000;
/** A run's last turn summary lands this soon after the run is marked finished. */
const RUN_SETTLES_MS = 60_000;
/** Enough of an app's name to find its calls however a tool spells it (GOOGLEDRIVE_…, claude_ai_Google_Drive). */
const APP_WORD_CHARS = 5;

type Owner = { botId?: string; groupId?: string };
/** A card's fields that tell a question for the person from an approval, a receipt or an offer to switch engines. */
type QuestionCard = NonNullable<Parameters<typeof isPersistentQuestionCard>[0]> & {
  requestId?: string; title?: string; subtitle?: string; questionRequest?: QuestionRequestCardData; outboundRequest?: unknown; quotaSwitch?: unknown;
  teamMemoryRequest?: unknown; autoApplied?: boolean;
};

function threadOwners(sources: TodaySources): Map<string, Owner> {
  const owners = new Map<string, Owner>();
  for (const bot of sources.bots) {
    owners.set(bot.threadId, { botId: bot.id });
    for (const task of bot.tasks ?? []) owners.set(task.threadId, { botId: bot.id });
  }
  for (const group of sources.groups) {
    if (!owners.has(group.threadId)) owners.set(group.threadId, { groupId: group.id });
    for (const task of group.tasks ?? []) if (!owners.has(task.threadId)) owners.set(task.threadId, { groupId: group.id });
  }
  return owners;
}

const turnKey = (threadId: string, turnId: string) => `${threadId}\u0000${turnId}`;
const add = (counts: OutcomeCounts, category: OutcomeCategory) => { counts[category] = (counts[category] ?? 0) + 1; };
const parse = <T,>(text: string | null): T | null => {
  if (!text) return null;
  try { return JSON.parse(text) as T; } catch { return null; }
};

function plainTitle(text: string): string {
  const line = text.replace(/^[\s#>]+/gm, "").replace(/\*\*|__|`/g, "").replace(/\s+/g, " ").trim();
  return line.length > TITLE_CHARS ? `${line.slice(0, TITLE_CHARS - 1).trimEnd()}…` : line;
}

function starter(sender: { role: string; peer: number; via: string | null; relayed: number } | undefined): TodayStarter | undefined {
  if (!sender || sender.role !== "user") return undefined;
  if (sender.peer) return "bot";
  if (sender.via === "api") return "api";
  if (sender.relayed) return "relay";
  return "person";
}

function runEnd(run: RunRecord, now: number): number | null {
  if (run.status === "completed" || run.status === "failed") return run.finishedAt ?? run.startedAt ?? run.scheduledFor;
  if (run.status === "missed") return run.finishedAt ?? run.scheduledFor;
  return run.status === "cancelled" ? null : now;
}

function questionText(card: QuestionCard): string {
  return plainTitle(card.questionRequest?.questions?.[0]?.question || card.title || card.subtitle || "");
}

export function todayReport(sources: TodaySources, viewer: TodayViewer, requestedSince: number, now = Date.now()): TodayReport {
  const since = Math.min(now, Math.max(requestedSince, now - TODAY_MAX_WINDOW_MS));
  const owners = threadOwners(sources);
  const seen = (threadId: string | undefined): threadId is string => Boolean(threadId && owners.has(threadId) && viewer.thread(threadId));

  const counts: OutcomeCounts = {};
  const byTurn = new Map<string, OutcomeCounts>();
  const failures: Array<{ row: WorkRow; cause: string }> = [];
  const byThread = new Map<string, Array<{ at: number; categories: readonly OutcomeCategory[] }>>();
  const digests: Array<{ row: WorkRow; digest: TurnDigest }> = [];
  for (const row of workRows(since, now)) {
    if (!seen(row.threadId)) continue;
    if (row.kind === "digest") {
      const digest = parse<TurnDigest>(row.digest);
      if (digest) digests.push({ row, digest });
      continue;
    }
    if (!row.name) continue;
    const cause = row.ok === 0 ? failedTurnCause(row.name) : null;
    if (cause !== null && !isClientCancellation(cause)) failures.push({ row, cause });
    if (row.ok !== 1) continue;
    const categories = classifyToolCall(row.name, row.input ?? undefined);
    if (!categories.length) continue;
    const turn = row.turnId ? byTurn.get(turnKey(row.threadId, row.turnId)) ?? {} : null;
    for (const category of categories) {
      add(counts, category);
      if (turn) add(turn, category);
    }
    if (turn && row.turnId) byTurn.set(turnKey(row.threadId, row.turnId), turn);
    const events = byThread.get(row.threadId) ?? [];
    events.push({ at: row.at, categories });
    byThread.set(row.threadId, events);
  }

  const lines: TodayLine[] = [];
  const routines = { ok: 0, failed: 0 };
  const runWindows = new Map<string, Array<{ start: number; end: number }>>();
  for (const run of sources.routines?.listRuns(since - 2 * DAY_MS) ?? []) {
    const end = runEnd(run, now);
    if (end === null || !viewer.routine(run)) continue;
    if (run.threadId && run.startedAt !== undefined) {
      const windows = runWindows.get(run.threadId) ?? [];
      windows.push({ start: run.startedAt, end: (run.finishedAt ?? now) + RUN_SETTLES_MS });
      runWindows.set(run.threadId, windows);
    }
    if (end < since || end > now || !["completed", "failed", "missed"].includes(run.status)) continue;
    const ok = run.status === "completed";
    if (ok) routines.ok += 1;
    else routines.failed += 1;
    if (run.report?.state === "quiet") continue;
    const reported = run.report?.state === "posted" && seen(run.report.threadId) ? run.report.threadId : undefined;
    const outcomes: OutcomeCounts = {};
    for (const event of run.threadId && run.startedAt !== undefined ? byThread.get(run.threadId) ?? [] : []) {
      if (event.at >= run.startedAt! && event.at <= end) for (const category of event.categories) add(outcomes, category);
    }
    if (ok && isReportRoutine(run.routineName)) {
      add(counts, "report");
      add(outcomes, "report");
    }
    lines.push({
      id: run.id, at: end, botId: run.botId, ...(reported ?? seen(run.threadId) ? { threadId: reported ?? run.threadId } : {}), routineId: run.routineId,
      title: plainTitle(run.routineName), ok, ...(!ok && run.error ? { error: plainTitle(run.error) } : {}),
      startedBy: run.triggerSource ?? (run.manual ? "manual" : "schedule"), outcomes,
    });
  }

  const inRun = (threadId: string, at: number) => (runWindows.get(threadId) ?? []).some((window) => at >= window.start && at <= window.end);
  const turnLines: Array<TodayLine & { requestMessageId?: string; turn?: string }> = [];
  for (const { row, digest } of digests) {
    if (inRun(row.threadId, row.at)) continue;
    const botId = digest.botId || row.fromBotId || owners.get(row.threadId)?.botId;
    if (!botId) continue;
    const turn = digest.turnId || row.turnId || "";
    turnLines.push({
      id: row.id, at: row.at, botId, threadId: row.threadId, title: plainTitle(digest.reply ?? ""), ok: row.turnSucceeded !== 0,
      outcomes: byTurn.get(turnKey(row.threadId, turn)) ?? {}, turn,
      ...(row.requestMessageId ? { requestMessageId: row.requestMessageId } : {}),
    });
  }
  for (const { row, cause } of failures) {
    if (inRun(row.threadId, row.at)) continue;
    const settledBy = turnLines.find((line) => line.threadId === row.threadId &&
      (row.turnId ? line.turn === row.turnId : line.at >= row.at && line.at - row.at <= FAILURE_SETTLES_MS));
    if (settledBy) {
      if (!settledBy.ok && !settledBy.error) settledBy.error = plainTitle(cause);
      continue;
    }
    const botId = row.fromBotId || owners.get(row.threadId)?.botId;
    if (botId) lines.push({ id: row.id, at: row.at, botId, threadId: row.threadId, title: "", ok: false, error: plainTitle(cause), outcomes: {} });
  }
  lines.push(...turnLines);
  lines.sort((a, b) => b.at - a.at);
  const shown = lines.slice(0, TODAY_MAX_LINES);
  const asked = shown.flatMap((line: TodayLine & { requestMessageId?: string }) => line.requestMessageId && line.threadId
    ? [{ threadId: line.threadId, id: line.requestMessageId }] : []);
  const senders = asked.length ? requestSenders(asked) : new Map();
  const finished = shown.map(({ requestMessageId, turn: _turn, ...line }: TodayLine & { requestMessageId?: string; turn?: string }) => {
    if (!requestMessageId || !line.threadId) return line;
    const startedBy = starter(senders.get(`${line.threadId}\u0000${requestMessageId}`));
    return startedBy ? { ...line, startedBy } : line;
  });

  return {
    since,
    until: now,
    tiles: OUTCOME_CATEGORIES.flatMap((category) => counts[category] ? [{ category, count: counts[category]! }] : []),
    minutesSaved: minutesSaved(counts),
    routines,
    needsYou: needsYou(sources, viewer, owners, seen, now),
    lines: finished,
    moreLines: Math.max(0, lines.length - shown.length),
    routineCount: (sources.routines?.listRoutines() ?? []).filter((routine) => viewer.routine(routine)).length,
  };
}

/** What only the person can fix right now, across every conversation the viewer may see. */
export function needsYouNow(sources: TodaySources, viewer: TodayViewer, now = Date.now()): NeedsYouItem[] {
  const owners = threadOwners(sources);
  return needsYou(sources, viewer, owners, (threadId): threadId is string => Boolean(threadId && owners.has(threadId) && viewer.thread(threadId)), now);
}

function needsYou(sources: TodaySources, viewer: TodayViewer, owners: Map<string, Owner>, seen: (threadId: string | undefined) => threadId is string, now: number): NeedsYouItem[] {
  const rows = attentionRows(now - NEEDS_YOU_WINDOW_MS).filter((row) => seen(row.threadId));
  const botOf = (row: AttentionRow) => row.digestBotId ?? row.fromBotId ?? owners.get(row.threadId)?.botId;
  const engineOf = new Map(sources.bots.map((bot) => [bot.id, bot.modelSelection?.instanceId]));
  const lastTurnByBot = new Map<string, number>(), lastTurnByThread = new Map<string, number>();
  for (const row of rows) {
    if (row.kind !== "digest") continue;
    const botId = botOf(row);
    if (botId) lastTurnByBot.set(botId, row.at);
    lastTurnByThread.set(row.threadId, row.at);
  }

  const items = new Map<string, NeedsYouItem>();
  const askedIn = new Map<string, string>();
  const connectionApps = new Map<string, string>();
  const keep = (key: string, item: NeedsYouItem) => {
    const previous = items.get(key);
    if (!previous) return void items.set(key, item);
    const botIds = "botIds" in previous && "botIds" in item ? [...new Set([...previous.botIds, ...item.botIds])] : [];
    const newer = item.at >= previous.at ? item : previous;
    items.set(key, "botIds" in newer ? { ...newer, botIds } as NeedsYouItem : newer);
  };
  const settled = (botId: string, at: number) => (lastTurnByBot.get(botId) ?? -Infinity) > at;

  for (const row of rows) {
    if (row.kind === "options") {
      const card = parse<QuestionCard>(row.card);
      const botId = botOf(row);
      if (!card || !botId || !isPersistentQuestionCard(card) || card.outboundRequest || card.quotaSwitch || card.teamMemoryRequest || card.autoApplied) continue;
      if ((lastTurnByThread.get(row.threadId) ?? -Infinity) > row.at) continue;
      const earlier = card.requestId ? askedIn.get(card.requestId) : undefined;
      if (earlier && earlier !== `question:${row.threadId}`) items.delete(earlier);
      if (card.requestId) askedIn.set(card.requestId, `question:${row.threadId}`);
      keep(`question:${row.threadId}`, { kind: "question", id: row.id, at: row.at, botId, threadId: row.threadId, text: questionText(card) });
      continue;
    }
    if (!viewer.admin || row.kind !== "activity" || !row.name) continue;
    const botId = botOf(row);
    if (!botId) continue;
    const cause = failedTurnCause(row.name);
    if (cause === null) {
      const app = toolApps(row.name, row.input ?? undefined)[0];
      if (app && row.output && BROKEN_CONNECTION.test(row.output)) {
        keep(`connection:${app}`, { kind: "connection", id: row.id, at: row.at, app: toolkitName(app), botIds: [botId], threadId: row.threadId, text: plainTitle(row.output) });
        connectionApps.set(`connection:${app}`, app);
      }
      continue;
    }
    if (settled(botId, row.at)) continue;
    const credit = trialCreditKind(cause);
    const place = parse<PlaceRow>(row.place);
    const instanceId = engineOf.get(botId);
    if (credit) {
      if (credit !== "paused") keep("out-of-credit", { kind: "out-of-credit", id: row.id, at: row.at, credit, botIds: [botId], threadId: row.threadId });
    } else if (place) {
      if (OWNER_PLACES.has(place.state)) keep(`place:${place.state}:${botId}`, { kind: "place", id: row.id, at: row.at, place, botIds: [botId], threadId: row.threadId });
    } else {
      const reason = classifyError({ text: cause }).reason;
      if ((row.setup || reason === "auth") && instanceId) keep(`signed-out:${instanceId}`, { kind: "signed-out", id: row.id, at: row.at, instanceId, botIds: [botId], threadId: row.threadId });
      else if (reason === "quota") keep(`usage-limit:${instanceId ?? botId}`, { kind: "usage-limit", id: row.id, at: row.at, ...(instanceId ? { instanceId } : {}), botIds: [botId], threadId: row.threadId, text: plainTitle(cause) });
    }
  }

  for (const [key, app] of connectionApps) {
    const item = items.get(key);
    const worked = item && successfulCallsMentioning(item.at, app.slice(0, APP_WORD_CHARS))
      .some((call) => toolApps(call.name, call.input ?? undefined).includes(app));
    if (worked) items.delete(key);
  }

  if (viewer.admin) {
    for (const engine of sources.engines) {
      const key = `signed-out:${engine.instanceId}`;
      const signedOut = engine.snapshot?.state === "available" && engine.snapshot.authenticated === false;
      if (engine.snapshot?.authenticated === true) items.delete(key);
      if (!signedOut) continue;
      const users = sources.bots.filter((bot) => bot.modelSelection?.instanceId === engine.instanceId && seen(bot.threadId)).map((bot) => bot.id);
      if (users.length) keep(key, { kind: "signed-out", id: key, at: items.get(key)?.at ?? now, instanceId: engine.instanceId, botIds: users });
    }
  }

  for (const work of sources.parked) {
    if (!work.question || items.has(`question:${work.threadId}`) || !seen(work.threadId)) continue;
    keep(`question:${work.threadId}`, { kind: "question", id: work.id, at: work.createdAt, botId: work.botId, threadId: work.threadId, text: plainTitle(work.question) });
  }

  return [...items.values()].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || b.at - a.at);
}
