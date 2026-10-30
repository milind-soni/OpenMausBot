// The main agent's brief: one server-built card a day in a fixed chat of the proactive bot's, edited in place, rendered
// with no AI from what the checks found and what the watch run sorted. It exists only once it has something for the person, opens
// on the first open of the day and after three hours away, and tells the person once per update. Presence, the brief's home and its rows live in brief.json,
// ids and times only; the senders and subjects it shows are read back from Gmail by id after a restart. Where a morning
// time is set, the day's brief is also posted and pushed then, led by what was done while the person was away.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { formatQuestionAnswers, type AskQuestion } from "../../shared/ask-question.ts";
import type { NeedsYouItem, TodayLine } from "../../shared/today.ts";
import type { WidgetAction, WidgetRoot } from "../../shared/widget.ts";
import { writeFileAtomic } from "../atomic.ts";
import { createAgentCard } from "../chat-widgets.ts";
import type { CalendarEvent, EmailHeader, ReadSession } from "../connected-reads.ts";
import { recordsBlock, clean } from "../records-block.ts";
import { ownerOrAdmin, type RequestAuth } from "../request-auth.ts";
import type { RoutineRun } from "../routines.ts";
import type { BotRecord, Message, Store } from "../store.ts";
import { answered, localDate, qualifies, validZone } from "./check-plan.ts";
import { parseWatchResult } from "./check-prompts.ts";
import {
  ANSWER_ACTION, briefCard, clockTime, DISMISS_ACTION, doneCard, DRAFT_ACTION, LATER_ACTION, MORNING_ACTION, MORNING_CHOICES, MORNING_OFF, prepCard, reminderCard,
  type BriefEmail, type BriefFacts, type BriefRow, type BuiltCard, type DoneRow, type NeedRow,
} from "./brief-cards.ts";
import { morningWords, type MorningWords } from "./brief-morning-words.ts";
import { briefWords, type BriefWords } from "./brief-words.ts";
import { proactiveOwner } from "./proactive-owner.ts";
import type { CheckReport } from "./routine-checks.ts";
import { clip, oneLine } from "./text-clip.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Back after this long away, the brief refreshes in place. */
export const AWAY_MS = 3 * HOUR;
const PERSIST_EVERY_MS = MINUTE;
const CLOCK_SKEW_MS = 5 * MINUTE;
const IMPORTANT_DAYS_MS = 7 * DAY;
const DISMISSED_MS = 14 * DAY;
const MAX_ROWS = 60;
/** A watch run still sorting the night's mail at the morning time gets this long before the brief goes without it. */
const MORNING_WAIT_MIN = 20;
/** A sleeping Cloud wakes this early, so the watch reads the night's mail before the brief. */
export const MORNING_WAKE_EARLY_MS = 10 * MINUTE;
/** The morning line counts what was done since the person was last here, at most this far back. */
const OVERNIGHT_MS = 16 * HOUR;
/** Here this recently, the person saw it happen: the morning line is left out. */
const HERE_MS = 30 * MINUTE;
const ACTIVE_RUN = new Set(["queued", "running", "waiting"]);
/** The morning time every install starts with, in the person's zone. */
export const DEFAULT_MORNING = MORNING_CHOICES[2];
/** A question answered in place offers at most this many choices; more go to the bot's chat. */
const MAX_CHOICES = 4;
export const BRIEF_FILE = "brief.json";

const at = z.number().finite().nonnegative();
const id = z.string().min(1).max(512);
const stateSchema = z.object({
  version: z.literal(1),
  timeZone: z.string().max(128).optional(),
  /** The language the person's app shows, from their last open. */
  language: z.string().max(35).optional(),
  lastActiveAt: at.optional(),
  home: z.object({ botId: id, threadId: id }).optional(),
  /** The day the first brief was posted: that day's card says what it does. */
  introducedOn: z.string().max(10).optional(),
  card: z.object({ day: z.string().max(10), botId: id, threadId: id, messageId: id, postedAt: at }).optional(),
  important: z.array(z.object({ messageId: id, threadId: id, at, judgedAt: at, needsReply: z.boolean() })).max(MAX_ROWS),
  dismissed: z.array(z.object({ messageId: id, from: z.string().max(320), at })).max(MAX_ROWS),
  preps: z.array(z.object({ key: id, at })).max(MAX_ROWS),
  notified: z.array(z.string().max(600)).max(200).optional(),
  /** The last day the morning brief went out, and that morning's first line. */
  morningOn: z.string().max(10).optional(),
  morningLine: z.object({ day: z.string().max(10), text: z.string().max(400) }).optional(),
  /** "HH:MM", or "off"; absent is the default time. */
  morningAt: z.string().regex(/^(?:(?:[01]\d|2[0-3]):[0-5]\d|off)$/).optional(),
  /** Rows the person put off with Not now: gone until the next day's brief. */
  later: z.object({ day: z.string().max(10), refs: z.array(z.string().max(600)).max(200) }).optional(),
  /** The Done overnight card a morning posted. */
  done: z.object({ day: z.string().max(10), threadId: id, messageId: id, since: at, count: z.number().int().nonnegative(), postedAt: at }).optional(),
});
type BriefState = z.infer<typeof stateSchema>;
type Important = BriefState["important"][number];

export interface BriefDeps {
  store: Pick<Store, "bots" | "bot" | "tasks" | "taskByThread" | "messagesFor" | "activePath" | "appendMessage" | "patchMessage" | "patchTask" | "groupByThread">;
  dataDir: string;
  now?: () => number;
  /** A hosted team workspace or a Team Cloud: the people there are not one person, so there is no brief. */
  hosted: boolean;
  /** The proactive bot's briefing routine is on; with it paused or deleted there is no brief. */
  watching(): boolean;
  mainThread(botId: string): string | undefined;
  threadBusy(botId: string, threadId: string): boolean;
  notify(bot: BotRecord, threadId: string, detail: string): void;
  runs(): RoutineRun[];
  needsYou(): NeedsYouItem[];
  engineName(instanceId: string): string;
  /** The computer's own zone; undefined on a Cloud home, whose zone of record comes from the person's device. */
  hostTimeZone(): string | undefined;
  /** The server's configured language, for a brief no app has opened with a language yet. */
  language(): string | undefined;
  /** Reads for the brief's own follow-ups: an email's sender and subject after a restart, a reply already sent. */
  session(): ReadSession | null;
  /** The person's own Gmail address, once a check has read it. */
  address(): string | undefined;
  /** The run's answer was unreadable: it fails like any run, and its items go back. */
  failRun(runId: string, why: string): void;
  /** The run's answer was read: its items are settled. */
  keep(key: string): void;
  items(key: string): { mail: EmailHeader[]; prep: Array<{ key: string; event: CalendarEvent }> } | null;
  /** What the bot's last nightly dream noticed across its chats, while fresh. AI text: shown as plain text only. */
  ideas?(botId: string): { ideas: string[]; conversations: number };
  /** A meeting prep card was posted. */
  prepped?(): void;
  morning?: MorningDeps;
  /** Every bot's finished work since a time, newest first: the Done overnight card's rows. */
  done?(since: number): TodayLine[];
  /** Answers a bot's open question as the person who pressed; false when the question is no longer open. */
  answer?(auth: RequestAuth, threadId: string, requestId: string, message: string): Promise<boolean>;
}

export interface MorningDeps {
  /** The push's words for this morning's brief. */
  push(summary: string): string;
  /** The line that leads the morning brief: what was done since `since`, or nothing. */
  overnight(since: number): string | undefined;
}

const clockMinutesOf = (clock: string): number => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));
function localMinutes(ms: number, zone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms));
  const part = (type: "hour" | "minute") => Number(parts.find((entry) => entry.type === type)?.value ?? 0);
  return part("hour") * 60 + part("minute");
}
/** The instant near `guess` whose local clock reads `minutes`, so a day with a clock change still lands on the time. */
function atLocalMinutes(guess: number, minutes: number, zone: string): number {
  let at = guess;
  for (let step = 0; step < 2; step += 1) {
    const off = ((minutes - localMinutes(at, zone) + 720 + 1440) % 1440) - 720;
    if (!off) break;
    at += off * MINUTE;
  }
  return at;
}

export interface PresenceAnswer {
  returned: boolean;
  /** The brief's chat, when this arrival is the moment to show it. */
  open?: { botId: string; threadId: string };
}

const SERVER_PRESSES: ReadonlySet<string> = new Set([DISMISS_ACTION, LATER_ACTION, MORNING_ACTION, ANSWER_ACTION]);
const BRIEF_ROWS_ANSWERED = 6;
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const addressOf = (from: string): string => (/<([^<>\s]+)>/.exec(from)?.[1] ?? from).trim().toLowerCase();
const firstSentence = (text: string): string => {
  const value = text.trim();
  return (/^[\s\S]*?[.!?](?=\s|$)/.exec(value)?.[0] ?? value.split(/\r?\n/)[0]!).replace(/\s+/g, " ").trim();
};

/** Security invariant: a run's answer is only the bot's own text in that turn, never a tool's output or the prompt. */
export function turnReply(lines: readonly Message[], turnId: string | undefined): string {
  if (!turnId) return "";
  return lines.filter((line) => line.role === "bot" && line.kind === "text" && line.turnId === turnId).map((line) => line.text ?? "").join("\n\n");
}

export function createBrief(deps: BriefDeps) {
  const now = deps.now ?? Date.now;
  const file = join(deps.dataDir, BRIEF_FILE);
  let state: BriefState = { version: 1, important: [], dismissed: [], preps: [] };
  try {
    const parsed = stateSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    if (parsed.success) state = parsed.data;
    else console.warn(`brief: ${file} is not a brief file; starting fresh`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`brief: ${file} is unreadable; starting fresh`);
  }
  let persistedAt: number | undefined;
  const save = (): void => {
    persistedAt = now();
    try {
      writeFileAtomic(file, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    } catch (error) {
      console.warn(`brief: could not save ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  /** What this process last saw: the latest calendar read, and the headers and reasons behind the rows. */
  let calendar: { meetings: CalendarEvent[]; clashes: Array<[CalendarEvent, CalendarEvent]> } | undefined;
  let trouble: CheckReport["trouble"] = [];
  let waiting: CheckReport["waiting"];
  let unfenced = false;
  let helpersSort = false;
  const headers = new Map<string, EmailHeader & { why?: string }>();
  let dirty = false;
  let rendering = false;
  /** The card last written, so a check that changed nothing leaves it (and a press on it) alone. */
  let written: { messageId: string; json: string } | undefined;

  const timeZone = (): string | undefined => validZone(state.timeZone) ?? deps.hostTimeZone();
  const today = (): string => localDate(now(), timeZone());
  /** The person's local midnight, to the minute. */
  const dayStart = (): number => {
    const zone = timeZone(), day = today();
    let start = Math.floor(now() / MINUTE) * MINUTE;
    while (localDate(start - HOUR, zone) === day) start -= HOUR;
    while (localDate(start - MINUTE, zone) === day) start -= MINUTE;
    return start;
  };

  /** The bot the brief belongs to: proactiveOwner decides. */
  const chief = (): BotRecord | null => proactiveOwner(deps.store);

  /** The brief's chat: chosen once, the bot's main chat at the time, and chosen again only if it is gone. */
  function home(bot: BotRecord): string | undefined {
    if (state.home?.botId === bot.id && deps.store.taskByThread(bot.id, state.home.threadId)) return state.home.threadId;
    const threadId = deps.mainThread(bot.id);
    if (!threadId) return undefined;
    state.home = { botId: bot.id, threadId };
    save();
    return threadId;
  }

  /** Today's card, while it is this bot's: one the brief's earlier bot posted stays where it is. */
  const currentCard = (bot: BotRecord): { row: Message; card: NonNullable<BriefState["card"]> } | null => {
    const card = state.card;
    if (!card || card.day !== today() || card.botId !== bot.id) return null;
    const row = deps.store.messagesFor(card.threadId).find((message) => message.id === card.messageId);
    return row?.serverCard ? { row, card } : null;
  };

  function liveImportant(at: number): Important[] {
    const dismissed = new Set(state.dismissed.map((one) => one.messageId));
    return state.important.filter((row) => !dismissed.has(row.messageId) && at - row.judgedAt <= IMPORTANT_DAYS_MS);
  }

  /** The page a run published, from its live card in the run's chat: the brief opens the page itself, not a prompt. */
  function publishedPage(run: RoutineRun): string | undefined {
    if (!run.threadId) return undefined;
    const from = run.startedAt ?? run.createdAt, to = run.finishedAt ?? Number.POSITIVE_INFINITY;
    return deps.store.messagesFor(run.threadId).findLast((row) => row.publishedPage?.state === "live" && row.at >= from && row.at <= to)?.publishedPage?.url;
  }

  function routineRows(since: number, doneSince: number, w: BriefWords): { needs: NeedRow[]; done: BriefRow[] } {
    const needs: NeedRow[] = [], done: BriefRow[] = [];
    const latest = new Map<string, RoutineRun>();
    for (const run of deps.runs()) {
      const end = run.finishedAt ?? run.createdAt;
      if (end < since || !["completed", "failed", "missed"].includes(run.status) || run.report?.state === "quiet") continue;
      if (run.status === "completed" && run.deliver === "brief") continue;
      const seen = latest.get(run.routineId);
      if (!seen || (seen.finishedAt ?? seen.createdAt) <= end) latest.set(run.routineId, run);
    }
    for (const run of latest.values()) {
      const bot = deps.store.bot(run.botId);
      if (!bot || bot.hidden) continue;
      const open = run.threadId && deps.store.taskByThread(run.botId, run.threadId) ? { botId: run.botId, threadId: run.threadId } : undefined;
      const name = oneLine(run.routineName, 80);
      const page = run.status === "completed" && open ? publishedPage(run) : undefined;
      if (run.status === "completed") {
        if ((run.finishedAt ?? run.createdAt) >= doneSince) done.push({ text: name, note: clip(firstSentence(run.output ?? "") || w.finished, 140), ...(open ? { open } : {}), ...(page ? { page } : {}) });
      } else {
        needs.push({ key: `routine:${name}:${run.status}`, ref: run.id, bot: bot.name, since: run.finishedAt ?? run.createdAt,
          text: run.status === "missed" ? w.missed(name) : w.failed(name), note: clip(oneLine(run.error ?? "", 140) || w.didNotFinish, 140), ...(open ? { open } : {}) });
      }
    }
    return { needs, done };
  }

  /** The one single-choice question an open card asks, when it can be answered with a press. */
  function askedIn(item: Extract<NeedsYouItem, { kind: "question" }>): { requestId: string; question: AskQuestion } | null {
    const card = deps.store.messagesFor(item.threadId).find((row) => row.id === item.id)?.card;
    const questions = card?.questionRequest?.questions;
    const question = questions?.length === 1 ? questions[0]! : undefined;
    if (!card?.requestId || card.answered || !question || question.multiSelect || question.options.length < 2 || question.options.length > MAX_CHOICES) return null;
    return { requestId: card.requestId, question };
  }

  function needsYouRows(w: BriefWords): NeedRow[] {
    return deps.needsYou().map((item): NeedRow => {
      const open = item.threadId ? { botId: "botId" in item ? item.botId : item.botIds[0]!, threadId: item.threadId } : undefined;
      const row = (about: string, text: string, note: string): NeedRow =>
        ({ key: `${item.kind}:${about}`, ref: item.id, text, note, ...(open && deps.store.taskByThread(open.botId, open.threadId) ? { open } : {}) });
      switch (item.kind) {
        case "signed-out": { const engine = deps.engineName(item.instanceId); return row(engine, w.signedOut(engine), w.signInAgain); }
        case "usage-limit": return row("", w.usageLimit, clip(item.text, 140));
        case "out-of-credit": return row("", w.outOfCredit, w.ownAccount);
        case "connection": return row(item.app, w.reconnecting(item.app), clip(item.text, 140));
        case "place": return row("", w.unreachable, w.chooseAnother);
        case "question": {
          const bot = deps.store.bot(item.botId)?.name, asked = deps.answer ? askedIn(item) : null;
          return { ...row(bot ?? "", clip(item.text, 140) || w.asked(bot ?? w.aBot), ""), bot: bot ?? w.aBot, since: item.at,
            ...(asked ? { choices: asked.question.options.map((option) => option.label) } : {}) };
        }
        case "message": return { ...row(item.from, clip(item.text, 140) || w.asked(item.from), ""), bot: item.from, since: item.at };
      }
    });
  }

  /** What the bots finished since a time, one row each: the brief's own runs and quiet runs are left out. */
  function doneRows(since: number, m: MorningWords): DoneRow[] {
    const zone = timeZone(), language = state.language ?? deps.language();
    const runs = new Map(deps.runs().map((run) => [run.id, run]));
    return (deps.done?.(since) ?? []).flatMap((line): DoneRow[] => {
      const bot = deps.store.bot(line.botId), run = line.routineId ? runs.get(line.id) : undefined;
      if (!line.ok || line.at < since || !bot || bot.hidden || run?.deliver === "brief") return [];
      const text = (run ? firstSentence(run.output ?? "") : "") || line.title;
      if (!text) return [];
      const how = run ? oneLine(run.routineName, 80) : line.startedBy === "person" ? m.youAsked : line.startedBy === "bot" ? m.botAsked : m.onItsOwn;
      const open = line.threadId && deps.store.taskByThread(line.botId, line.threadId) ? { botId: line.botId, threadId: line.threadId } : undefined;
      return [{ text: clip(text, 140), note: `${bot.name} · ${how} · ${clockTime(line.at, zone, language)}`, ...(open ? { open } : {}) }];
    });
  }

  /** The morning's count of finished work and when it was counted, before its card is posted. */
  let overnight: { day: string; count: number; at: number } | undefined;
  /** The person is picking a new morning time on today's card. */
  let choosing = false;
  /** Questions answered from today's card, shown as receipts until the day ends. */
  let receipts: { day: string; rows: Array<{ bot: string; answer: string }> } | undefined;
  const morningClock = (): string | undefined => (deps.hosted || state.morningAt === MORNING_OFF ? undefined : state.morningAt ?? DEFAULT_MORNING);

  function facts(chiefBot: BotRecord): BriefFacts {
    const at = now(), zone = timeZone(), day = today(), language = state.language ?? deps.language(), w = briefWords(language);
    const doneToday = state.done?.day === day ? state.done : undefined, counted = overnight?.day === day ? overnight : undefined;
    const { needs: failed, done } = routineRows(dayStart(), doneToday?.postedAt ?? counted?.at ?? dayStart(), w);
    const later = new Set(state.later?.day === day ? state.later.refs : []);
    const clashRows: NeedRow[] = (calendar?.clashes ?? []).map(([first, second]) => ({
      key: `clash:${oneLine(first.title, 52)}:${oneLine(second.title, 52)}`,
      text: w.overlap(oneLine(first.title, 52), oneLine(second.title, 52)),
      note: w.both(clockTime(first.start, zone, language), clockTime(second.start, zone, language)),
    }));
    const troubleRows: NeedRow[] = (trouble ?? []).map((one) => {
      const app = one.app === "gmail" ? "Gmail" : "Google Calendar";
      return { key: `trouble:${one.app}`, text: w.couldNotRead(app), note: one.signedOut ? w.reconnect(app) : w.tryAgainSoon };
    });
    const unfencedRows: NeedRow[] = !unfenced ? []
      : helpersSort
        ? [{ key: "unfenced:meetings", text: w.unpreparedMeetings, note: w.unpreparedNote(chiefBot.name) }]
        : [{ key: "unfenced:all", text: w.unsorted, note: w.unsortedNote(chiefBot.name) }];
    const meetings = calendar === undefined ? null : calendar.meetings
      .filter((meeting) => qualifies(meeting) || (meeting.ownedCalendar === true && meeting.status !== "cancelled" && !meeting.allDay && !meeting.selfDeclined))
      .filter((meeting) => meeting.end > at && localDate(meeting.start, zone) === day)
      .map((meeting) => ({ title: meeting.title, start: meeting.start, ...(meeting.joinUrl ? { joinUrl: meeting.joinUrl } : {}) }));
    const emails = liveImportant(at).flatMap((row): BriefEmail[] => {
      const header = headers.get(row.messageId);
      return header ? [{ messageId: row.messageId, threadId: row.threadId, from: header.from, subject: header.subject, needsReply: row.needsReply, ...(header.why ? { why: header.why } : {}) }] : [];
    });
    const dreamt = deps.ideas?.(chiefBot.id);
    const ideas = (dreamt?.ideas ?? []).map((idea): BriefRow => ({ text: idea, note: w.noticedAcross(dreamt!.conversations) }));
    const doneCount = doneToday?.count ?? counted?.count ?? 0;
    const clock = morningClock();
    return {
      now: at, ...(zone ? { timeZone: zone } : {}), ...(language ? { language } : {}), intro: state.introducedOn === undefined || state.introducedOn === day,
      ...(state.morningLine?.day === day ? { overnight: state.morningLine.text } : {}),
      needs: [...troubleRows, ...failed, ...clashRows, ...needsYouRows(w), ...unfencedRows].filter((row) => !row.ref || !later.has(row.ref)),
      meetings, emails, ...(waiting !== undefined ? { waiting } : {}), routines: done, ...(ideas.length ? { ideas } : {}),
      greetAt: state.card?.day === day ? state.card.postedAt : at, ...(doneCount ? { doneOvernight: doneCount } : {}),
      morning: { ...(clock ? { at: clock } : {}), choosing }, ...(receipts?.day === day && receipts.rows.length ? { answered: receipts.rows } : {}),
    };
  }

  /** The rows a person would be told about: a new one among them is worth one notification. */
  const signature = (built: BriefFacts): string[] => [
    ...built.needs.map((row) => `need:${row.key}`),
    ...built.emails.map((email) => `email:${email.messageId}`),
  ];

  /** Headers of the rows this process has not seen, read back from Gmail by id. */
  async function rereadHeaders(): Promise<void> {
    const missing = liveImportant(now()).filter((row) => !headers.has(row.messageId));
    if (!missing.length) return;
    const session = deps.session();
    if (!session) return;
    for (const row of missing.slice(0, 12)) {
      try {
        const header = await session.message(row.messageId);
        if (header) headers.set(row.messageId, header);
        else state.important = state.important.filter((one) => one.messageId !== row.messageId);
      } catch {
        return;
      }
    }
  }

  /** Posts today's brief, or edits it in place. `create`: post one when it has anything to show, not only what needs the
   * person. `worth`: the card has something in it, so an arrival may open it. */
  async function render(options: { create: boolean; notify: boolean; morning?: boolean }): Promise<{ botId: string; threadId: string; worth: boolean } | null> {
    if (deps.hosted || !deps.watching()) return null;
    const bot = chief();
    if (!bot) return null;
    if (rendering) {
      dirty = true;
      return null;
    }
    rendering = true;
    try {
      await rereadHeaders();
      const existing = currentCard(bot);
      const built = facts(bot);
      const threadId = existing?.card.threadId ?? home(bot);
      if (!threadId) return null;
      const needsPerson = built.needs.length > 0 || built.emails.length > 0;
      const worth = needsPerson || (built.meetings?.length ?? 0) > 0 || (built.ideas?.length ?? 0) > 0 || Boolean(built.overnight) || Boolean(built.doneOvernight);
      if (!existing && !(options.create ? worth : needsPerson)) return null;
      if (deps.threadBusy(bot.id, threadId)) {
        dirty = true;
        return null;
      }
      dirty = false;
      const card = briefCard(built);
      const json = JSON.stringify(card.card);
      if (existing && written?.messageId === existing.card.messageId && written.json === json && !options.morning) return { botId: bot.id, threadId, worth };
      const shown = existing ? edit(bot, existing.card, card) : post(bot, threadId, card);
      if (!shown) return null;
      written = { messageId: shown, json };
      if (!existing) {
        state.card = { day: today(), botId: bot.id, threadId, messageId: shown, postedAt: now() };
        state.introducedOn ??= state.card.day;
      }
      const seen = new Set(state.notified ?? []);
      const fresh = signature(built).filter((key) => !seen.has(key));
      if (options.morning && worth) deps.notify(bot, threadId, deps.morning?.push(card.summary) ?? card.summary);
      else if ((options.notify || !existing) && (fresh.length || !existing) && needsPerson) deps.notify(bot, threadId, card.summary);
      state.notified = [...seen, ...fresh].slice(-200);
      save();
      return { botId: bot.id, threadId, worth };
    } finally {
      rendering = false;
    }
  }

  function post(bot: BotRecord, threadId: string, card: BuiltCard): string | null {
    const posted = createAgentCard({ store: deps.store as Parameters<typeof createAgentCard>[0]["store"], bot, threadId, input: { tool: "show_widget", widget: card.card }, serverCard: true });
    if (!posted.ok) {
      console.warn(`brief: the card was refused: ${posted.error}`);
      return null;
    }
    deps.store.patchTask(bot.id, threadId, { unread: true });
    return posted.messageId;
  }

  function edit(bot: BotRecord, card: NonNullable<BriefState["card"]>, built: BuiltCard): string | null {
    const edited = createAgentCard({ store: deps.store as Parameters<typeof createAgentCard>[0]["store"], bot, threadId: card.threadId, input: { tool: "update_widget", widget_id: card.messageId, widget: built.card }, serverCard: true });
    if (!edited.ok) {
      console.warn(`brief: the card could not be edited: ${edited.error}`);
      return null;
    }
    return edited.messageId;
  }

  /** A server card of its own in the brief's chat: a prep or a reminder. Null when there is no proactive bot or chat. */
  function postCard(built: BuiltCard): { bot: BotRecord; threadId: string; messageId: string } | null {
    const bot = chief();
    const threadId = bot ? home(bot) : undefined;
    if (!bot || !threadId) return null;
    const messageId = post(bot, threadId, built);
    if (!messageId) return null;
    deps.notify(bot, threadId, built.summary);
    return { bot, threadId, messageId };
  }

  /** An email picked for the brief, by a watch run or by the helper models: its row, with the why kept for this process. */
  function keepImportant(email: EmailHeader, why: string, needsReply: boolean, at: number): void {
    headers.set(email.id, { ...email, why });
    state.important = [...state.important.filter((row) => row.messageId !== email.id), { messageId: email.id, threadId: email.threadId, at: email.at, judgedAt: at, needsReply }].slice(-MAX_ROWS);
  }

  /** What the checks found that needs no AI: today's meetings, clashes, reminders, other routines, trouble, and the
   * emails the helper models picked. */
  async function report(found: CheckReport): Promise<void> {
    if (deps.hosted) return;
    if (found.meetings) calendar = { meetings: found.meetings, clashes: found.clashes ?? [] };
    trouble = found.trouble ?? [];
    waiting = found.waiting;
    unfenced = found.unfenced === true;
    helpersSort = found.helpersSort === true;
    for (const event of found.remind ?? []) postCard(reminderCard({ event, timeZone: timeZone(), now: now() }));
    const picked = found.picked ?? [];
    for (const pick of picked) keepImportant(pick.email, pick.why, pick.needsReply, found.at);
    if (picked.length) save();
    await followUpReplies(found.session);
    if (picked.length) await render({ create: true, notify: true });
    else if (state.lastActiveAt !== undefined) await render({ create: false, notify: true });
  }

  /** An email waiting on a reply leaves the brief once the person has replied in its thread. */
  async function followUpReplies(session: ReadSession | undefined): Promise<void> {
    const address = deps.address();
    const open = liveImportant(now()).filter((row) => row.needsReply);
    if (!session || !address || !open.length) return;
    for (const row of open.slice(0, 10)) {
      try {
        if (answered({ at: row.at }, await session.thread(row.threadId), address)) state.important = state.important.filter((one) => one.messageId !== row.messageId);
      } catch {
        return;
      }
    }
  }

  /** A watch run ended: its answer becomes rows and prep cards, or the run fails and its items go back. */
  async function consume(run: RoutineRun, turnId: string | undefined): Promise<void> {
    const key = run.checkKey;
    if (!key || run.deliver !== "brief" || run.status !== "completed") return;
    const items = deps.items(key);
    const reply = run.threadId ? turnReply(deps.store.activePath(run.threadId), turnId) : "";
    const given = { mail: new Set(items?.mail.map((email) => email.id) ?? []), prep: new Set(items?.prep.map((one) => one.key) ?? []) };
    const result = items ? parseWatchResult(reply, given) : null;
    if (!items || !result) {
      deps.failRun(run.id, items ? "The watch's answer could not be read, so nothing was posted. Its emails and meetings wait for the next check." : "OpenMausBot restarted before this run's answer was read; its emails and meetings wait for the next check.");
      return;
    }
    const at = now();
    if (!result.quiet) {
      for (const pick of result.important) keepImportant(items.mail.find((one) => one.id === pick.id)!, pick.why, pick.needsReply, at);
      for (const prep of result.prep) {
        const meeting = items.prep.find((one) => one.key === prep.id)!;
        if (state.preps.some((one) => one.key === meeting.key && one.at > at - DAY)) continue;
        if (postCard(prepCard({ event: meeting.event, prep: prep.brief, timeZone: timeZone(), now: at }))) {
          state.preps = [...state.preps, { key: meeting.key, at }].slice(-MAX_ROWS);
          deps.prepped?.();
        }
      }
    }
    deps.keep(key);
    save();
    if (!result.quiet && result.important.length) await render({ create: true, notify: true });
  }

  /** The person arrived: the first open of a day, or a return after 3 hours away, shows today's brief when it has anything
   * in it. Any other ping only records the time, so the brief never takes the screen from a chat in use. */
  async function active(source: "desktop" | "phone", zone?: string, language?: string): Promise<PresenceAnswer> {
    if (deps.hosted) return { returned: false };
    const at = now();
    if (zone && validZone(zone) && zone !== state.timeZone) state.timeZone = zone;
    const relabel = language !== undefined && language !== state.language;
    if (relabel) state.language = language;
    const previous = state.lastActiveAt;
    state.lastActiveAt = at;
    const skewed = previous !== undefined && previous > at + CLOCK_SKEW_MS;
    const returned = previous !== undefined && !skewed && at - previous >= AWAY_MS;
    const firstToday = previous === undefined || (!skewed && localDate(previous, timeZone()) !== today());
    if (relabel || returned || firstToday || persistedAt === undefined || at - persistedAt >= PERSIST_EVERY_MS) save();
    void source;
    if (!returned && !firstToday) {
      const owner = relabel ? chief() : null;
      if (owner && currentCard(owner)) await render({ create: false, notify: false });
      return { returned: false };
    }
    const shown = await render({ create: true, notify: false });
    return shown?.worth ? { returned, open: { botId: shown.botId, threadId: shown.threadId } } : { returned };
  }

  /** Once a day at the morning time: today's brief posted or refreshed, led by what was done while the person was away,
   * and pushed. A watch run still sorting the night's mail gets a few minutes first; a busy chat, until it is free. */
  async function morning(): Promise<void> {
    const clock = morningClock(), zone = validZone(timeZone());
    if (!clock || !zone || !deps.watching() || !chief()) return;
    const day = today();
    if (state.morningOn === day) return;
    const minutes = localMinutes(now(), zone), due = clockMinutesOf(clock);
    if (minutes < due) return;
    if (minutes < due + MORNING_WAIT_MIN && deps.runs().some((run) => run.deliver === "brief" && ACTIVE_RUN.has(run.status))) return;
    const away = state.lastActiveAt === undefined || now() - state.lastActiveAt >= HERE_MS;
    const since = Math.max(state.lastActiveAt ?? 0, now() - OVERNIGHT_MS);
    if (state.morningLine?.day !== day) {
      const text = away ? deps.morning?.overnight(since) : undefined;
      if (text) state.morningLine = { day, text: clip(text, 400) };
    }
    const rows = away && state.done?.day !== day ? doneRows(since, morningWords(state.language ?? deps.language())) : [];
    overnight = rows.length ? { day, count: rows.length, at: now() } : undefined;
    const shown = await render({ create: true, notify: true, morning: true });
    if (!shown && dirty) return;
    if (shown && rows.length) postDone(shown, rows, since);
    state.morningOn = day;
    save();
  }

  /** The night's finished work as its own card under the brief. It is never edited: tomorrow brings a new one. */
  function postDone(home: { botId: string; threadId: string }, rows: DoneRow[], since: number): void {
    const bot = deps.store.bot(home.botId);
    if (!bot) return;
    const zone = timeZone(), language = state.language ?? deps.language();
    const built = doneCard({ rows, since, now: now(), ...(zone ? { timeZone: zone } : {}), ...(language ? { language } : {}) });
    const messageId = post(bot, home.threadId, built);
    if (messageId) state.done = { day: today(), threadId: home.threadId, messageId, since, count: rows.length, postedAt: now() };
  }

  /** When a sleeping Cloud must be up for the next morning brief, or null with no morning time. */
  function nextWakeAt(): number | null {
    const clock = morningClock(), zone = validZone(timeZone());
    if (!clock || !zone || !deps.watching()) return null;
    const due = clockMinutesOf(clock);
    const todayAt = atLocalMinutes(dayStart() + due * MINUTE, due, zone);
    const next = state.morningOn === today() || now() >= todayAt + MORNING_WAIT_MIN * MINUTE ? atLocalMinutes(todayAt + DAY, due, zone) : todayAt;
    return next - MORNING_WAKE_EARLY_MS;
  }

  const briefRow = (threadId: string, messageId: string): boolean => {
    const card = state.card;
    return card !== undefined && card.threadId === threadId && card.messageId === messageId;
  };

  /** A press on a question's choice answers the bot's own card as the person who pressed, so its rules apply as there. */
  async function answerRow(ref: string, option: number, auth: RequestAuth): Promise<void> {
    const item = deps.needsYou().find((one) => one.kind === "question" && one.id === ref);
    const asked = item?.kind === "question" ? askedIn(item) : null;
    const label = asked?.question.options[option]?.label;
    if (item?.kind !== "question" || !asked || !label || !deps.answer) return;
    if (await deps.answer(auth, item.threadId, asked.requestId, formatQuestionAnswers([asked.question], [[label]]))) {
      const day = today(), bot = deps.store.bot(item.botId)?.name ?? briefWords(state.language ?? deps.language()).aBot;
      receipts = { day, rows: [...(receipts?.day === day ? receipts.rows : []), { bot, answer: label }].slice(-BRIEF_ROWS_ANSWERED) };
    }
    await render({ create: false, notify: false });
  }

  function pressed(action: WidgetAction, auth: RequestAuth): void {
    const payload = isRecord(action.payload) ? action.payload : {};
    const ref = typeof payload.row === "string" ? payload.row : undefined;
    if (action.type === DISMISS_ACTION && typeof payload.messageId === "string") {
      const target = payload.messageId, header = headers.get(target);
      state.dismissed = [...state.dismissed.filter((one) => one.messageId !== target && now() - one.at <= DISMISSED_MS), { messageId: target, from: header ? addressOf(header.from) : "", at: now() }].slice(-MAX_ROWS);
    } else if (action.type === LATER_ACTION && ref) {
      const day = today(), refs = state.later?.day === day ? state.later.refs : [];
      state.later = { day, refs: [...refs.filter((one) => one !== ref), ref].slice(-200) };
    } else if (action.type === MORNING_ACTION) {
      const at = typeof payload.at === "string" && (payload.at === MORNING_OFF || (MORNING_CHOICES as readonly string[]).includes(payload.at)) ? payload.at : undefined;
      // The person is looking at today's brief as they pick: today's morning push is not owed any more.
      if (at) Object.assign(state, { morningAt: at, morningOn: today() });
      choosing = payload.pick === true && !at;
    } else if (action.type === ANSWER_ACTION && ref && typeof payload.option === "number") {
      void answerRow(ref, payload.option, auth).catch((error: unknown) => console.warn("brief: the answer was not sent", error));
      return;
    } else {
      return;
    }
    save();
    void render({ create: false, notify: false });
  }

  /** Security invariant: only the owner or an admin presses, only on the brief card itself, and the press starts no
   * turn. Null for any other press, which goes to the bot as usual. */
  function serverPress(bot: Pick<BotRecord, "id">, threadId: string, messageId: string, action: WidgetAction, auth: RequestAuth): "handled" | "refused" | null {
    if (deps.hosted || !SERVER_PRESSES.has(action.type) || !briefRow(threadId, messageId) || state.card?.botId !== bot.id) return null;
    if (deps.store.messagesFor(threadId).find((row) => row.id === messageId)?.serverCard !== true) return null;
    if (!ownerOrAdmin(auth)) return "refused";
    pressed(action, auth);
    return "handled";
  }

  /** What a press on the brief is about, from the server's own records by id: a press carries only an id. */
  function pressRecords(bot: Pick<BotRecord, "id">, action: WidgetAction): string | null {
    if (deps.hosted || action.type !== DRAFT_ACTION || state.card?.botId !== bot.id || !isRecord(action.payload)) return null;
    const messageId = action.payload.messageId;
    const row = typeof messageId === "string" ? state.important.find((one) => one.messageId === messageId) : undefined;
    if (!row) return null;
    const header = headers.get(row.messageId);
    return [
      recordsBlock("Gmail", [header
        ? `id ${clean(row.messageId, 120)} · thread ${clean(row.threadId, 120)} · from ${clean(header.from, 160)} · subject ${clean(header.subject, 200)} · preview ${clean(header.preview, 300)}`
        : `id ${clean(row.messageId, 120)} · thread ${clean(row.threadId, 120)}`]),
      "Write a reply to this email as a Gmail draft in the same thread, to its sender, and leave it for the person to send. Do not send it.",
    ].join("\n");
  }

  return {
    chief, report, consume, active, serverPress, pressRecords, timeZone,
    /** Something the brief shows changed outside a check (a watch run failed): edit today's card in place. */
    refresh: (): Promise<unknown> => render({ create: false, notify: true }),
    dismissedFrom: (): string[] => [...new Set(state.dismissed.filter((one) => one.from && now() - one.at <= DISMISSED_MS).reverse().map((one) => one.from))].slice(0, 20),
    /** Each minute: the morning brief when it is due, else an edit a busy chat held back. */
    tick: (): void => {
      if (morningClock() && state.morningOn !== today()) void morning().catch((error: unknown) => console.warn("brief: the morning brief was not posted", error));
      if (dirty) void render({ create: false, notify: false });
    },
    nextWakeAt,
    /** The language the person's app shows, else the one set in Settings. */
    language: (): string | undefined => state.language ?? deps.language(),
    card: (): WidgetRoot | undefined => {
      const bot = chief();
      return bot ? currentCard(bot)?.row.widget?.root : undefined;
    },
    /** The brief moved to another bot: from now on it lives in that bot's main chat, and its next card says what it
     * does. Cards already posted stay where they are. */
    moveTo: (botId: string): void => {
      if (state.home?.botId === botId) return;
      const threadId = deps.mainThread(botId);
      if (threadId) state.home = { botId, threadId };
      else delete state.home;
      delete state.introducedOn;
      save();
    },
  };
}

export type Brief = ReturnType<typeof createBrief>;
