// The main agent's brief: one server-built card a day in a fixed chat of the Chief's, edited in place, rendered with no
// AI from what the checks found and what the watch run sorted. It exists only once it has something for the person, opens
// on the first open of the day and after three hours away, and tells the person once per update. Presence, the brief's home and its rows live in brief.json,
// ids and times only; the senders and subjects it shows are read back from Gmail by id after a restart.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import type { NeedsYouItem } from "../../shared/today.ts";
import type { WidgetAction, WidgetRoot } from "../../shared/widget.ts";
import { writeFileAtomic } from "../atomic.ts";
import { createAgentCard } from "../chat-widgets.ts";
import type { CalendarEvent, EmailHeader, ReadSession } from "../connected-reads.ts";
import { recordsBlock, clean } from "../records-block.ts";
import { ownerOrAdmin, type RequestAuth } from "../request-auth.ts";
import type { RoutineRun } from "../routines.ts";
import { sectionKey, type BotRecord, type Message, type Store } from "../store.ts";
import { answered, localDate, qualifies, validZone } from "./check-plan.ts";
import { parseWatchResult } from "./check-prompts.ts";
import { briefCard, clockTime, DISMISS_ACTION, DRAFT_ACTION, prepCard, reminderCard, type BriefEmail, type BriefFacts, type BriefRow, type BuiltCard } from "./brief-cards.ts";
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
export const BRIEF_FILE = "brief.json";

const at = z.number().finite().nonnegative();
const id = z.string().min(1).max(512);
const stateSchema = z.object({
  version: z.literal(1),
  timeZone: z.string().max(128).optional(),
  lastActiveAt: at.optional(),
  home: z.object({ botId: id, threadId: id }).optional(),
  /** The day the first brief was posted: that day's card says what it does. */
  introducedOn: z.string().max(10).optional(),
  card: z.object({ day: z.string().max(10), botId: id, threadId: id, messageId: id, postedAt: at }).optional(),
  important: z.array(z.object({ messageId: id, threadId: id, at, judgedAt: at, needsReply: z.boolean() })).max(MAX_ROWS),
  dismissed: z.array(z.object({ messageId: id, from: z.string().max(320), at })).max(MAX_ROWS),
  preps: z.array(z.object({ key: id, at })).max(MAX_ROWS),
  notified: z.array(z.string().max(600)).max(200).optional(),
});
type BriefState = z.infer<typeof stateSchema>;
type Important = BriefState["important"][number];

export interface BriefDeps {
  store: Pick<Store, "bots" | "bot" | "tasks" | "taskByThread" | "messagesFor" | "activePath" | "appendMessage" | "patchMessage" | "patchTask" | "groupByThread">;
  dataDir: string;
  now?: () => number;
  /** A hosted team workspace or a Team Cloud: the people there are not one person, so there is no brief. */
  hosted: boolean;
  /** The Chief's briefing routine is on; with it paused or deleted there is no brief. */
  watching(): boolean;
  mainThread(botId: string): string | undefined;
  threadBusy(botId: string, threadId: string): boolean;
  notify(bot: BotRecord, threadId: string, detail: string): void;
  runs(): RoutineRun[];
  needsYou(): NeedsYouItem[];
  engineName(instanceId: string): string;
  /** The computer's own zone; undefined on a Cloud home, whose zone of record comes from the person's device. */
  hostTimeZone(): string | undefined;
  /** Reads for the brief's own follow-ups: an email's sender and subject after a restart, a reply already sent. */
  session(): ReadSession | null;
  /** The person's own Gmail address, once a check has read it. */
  address(): string | undefined;
  /** The run's answer was unreadable: it fails like any run, and its items go back. */
  failRun(runId: string, why: string): void;
  /** The run's answer was read: its items are settled. */
  keep(key: string): void;
  items(key: string): { mail: EmailHeader[]; prep: Array<{ key: string; event: CalendarEvent }> } | null;
}

export interface PresenceAnswer {
  returned: boolean;
  /** The brief's chat, when this arrival is the moment to show it. */
  open?: { botId: string; threadId: string };
}

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
    let start = now();
    while (localDate(start - HOUR, zone) === day) start -= HOUR;
    while (localDate(start - MINUTE, zone) === day) start -= MINUTE;
    return start;
  };

  /** The main agent: the Chief of the whole workspace, or the first Chief there is. */
  function chief(): BotRecord | null {
    const chiefs = deps.store.bots.filter((bot) => bot.chiefOfStaff && !bot.hidden);
    return chiefs.find((bot) => sectionKey(bot.section) === "") ?? chiefs[0] ?? null;
  }

  /** The brief's chat: chosen once, the Chief's main chat at the time, and chosen again only if it is gone. */
  function home(bot: BotRecord): string | undefined {
    if (state.home?.botId === bot.id && deps.store.taskByThread(bot.id, state.home.threadId)) return state.home.threadId;
    const threadId = deps.mainThread(bot.id);
    if (!threadId) return undefined;
    state.home = { botId: bot.id, threadId };
    save();
    return threadId;
  }

  const currentCard = (): { row: Message; card: NonNullable<BriefState["card"]> } | null => {
    const card = state.card;
    if (!card || card.day !== today()) return null;
    const row = deps.store.messagesFor(card.threadId).find((message) => message.id === card.messageId);
    return row?.serverCard ? { row, card } : null;
  };

  function liveImportant(at: number): Important[] {
    const dismissed = new Set(state.dismissed.map((one) => one.messageId));
    return state.important.filter((row) => !dismissed.has(row.messageId) && at - row.judgedAt <= IMPORTANT_DAYS_MS);
  }

  function routineRows(since: number): { needs: BriefRow[]; done: BriefRow[] } {
    const needs: BriefRow[] = [], done: BriefRow[] = [];
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
      if (run.status === "completed") done.push({ text: oneLine(run.routineName, 80), note: clip(firstSentence(run.output ?? "") || "Finished", 140), ...(open ? { open } : {}) });
      else needs.push({ text: `${oneLine(run.routineName, 80)} ${run.status === "missed" ? "was missed" : "failed"}`, note: clip(oneLine(run.error ?? "", 140) || "It did not finish", 140), ...(open ? { open } : {}) });
    }
    return { needs, done };
  }

  function needsYouRows(): BriefRow[] {
    return deps.needsYou().map((item): BriefRow => {
      const open = item.threadId ? { botId: "botId" in item ? item.botId : item.botIds[0]!, threadId: item.threadId } : undefined;
      const row = (text: string, note: string): BriefRow => ({ text, note, ...(open && deps.store.taskByThread(open.botId, open.threadId) ? { open } : {}) });
      switch (item.kind) {
        case "signed-out": return row(`${deps.engineName(item.instanceId)} is signed out`, "Sign in again in Settings, Model providers.");
        case "usage-limit": return row("An AI reached its usage limit", clip(item.text, 140));
        case "out-of-credit": return row("The trial credit can't run this", "Sign in with your own AI account, or add a key.");
        case "connection": return row(`${item.app} needs reconnecting`, clip(item.text, 140));
        case "place": return row("A bot couldn't reach its computer", "Open it to choose another place.");
        case "question": return row(`${deps.store.bot(item.botId)?.name ?? "A bot"} asked you`, clip(item.text, 140));
      }
    });
  }

  function facts(chiefBot: BotRecord): BriefFacts {
    const at = now(), zone = timeZone(), day = today();
    const { needs: failed, done } = routineRows(dayStart());
    const clashRows: BriefRow[] = (calendar?.clashes ?? []).map(([first, second]) => ({
      text: `${oneLine(first.title, 52)} and ${oneLine(second.title, 52)} overlap`,
      note: `${clockTime(first.start, zone)} and ${clockTime(second.start, zone)}`,
    }));
    const troubleRows: BriefRow[] = (trouble ?? []).map((one) => {
      const app = one.app === "gmail" ? "Gmail" : "Google Calendar";
      return { text: `Couldn't read ${app}`, note: one.signedOut ? `Reconnect ${app} in Connected apps.` : "I'll try again soon." };
    });
    const unfencedRows: BriefRow[] = unfenced
      ? [{ text: "I didn't sort email or prepare meetings", note: `That needs a Claude model as ${chiefBot.name}'s AI. Your day, reminders and clashes still show here.` }]
      : [];
    const meetings = calendar === undefined ? null : calendar.meetings
      .filter((meeting) => qualifies(meeting) || (meeting.ownedCalendar === true && meeting.status !== "cancelled" && !meeting.allDay && !meeting.selfDeclined))
      .filter((meeting) => meeting.end > at && localDate(meeting.start, zone) === day)
      .map((meeting) => ({ title: meeting.title, start: meeting.start, ...(meeting.joinUrl ? { joinUrl: meeting.joinUrl } : {}) }));
    const emails = liveImportant(at).flatMap((row): BriefEmail[] => {
      const header = headers.get(row.messageId);
      return header ? [{ messageId: row.messageId, threadId: row.threadId, from: header.from, subject: header.subject, needsReply: row.needsReply, ...(header.why ? { why: header.why } : {}) }] : [];
    });
    return {
      now: at, ...(zone ? { timeZone: zone } : {}), intro: state.introducedOn === undefined || state.introducedOn === day,
      needs: [...troubleRows, ...failed, ...clashRows, ...needsYouRows(), ...unfencedRows],
      meetings, emails, ...(waiting !== undefined ? { waiting } : {}), routines: done,
    };
  }

  /** The rows a person would be told about: a new one among them is worth one notification. */
  const signature = (built: BriefFacts): string[] => [
    ...built.needs.map((row) => `need:${row.text}`),
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
  async function render(options: { create: boolean; notify: boolean }): Promise<{ botId: string; threadId: string; worth: boolean } | null> {
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
      const existing = currentCard();
      const built = facts(bot);
      const threadId = existing?.card.threadId ?? home(bot);
      if (!threadId) return null;
      const needsPerson = built.needs.length > 0 || built.emails.length > 0;
      const worth = needsPerson || (built.meetings?.length ?? 0) > 0;
      if (!existing && !(options.create ? worth : needsPerson)) return null;
      if (deps.threadBusy(bot.id, threadId)) {
        dirty = true;
        return null;
      }
      dirty = false;
      const card = briefCard(built);
      const json = JSON.stringify(card.card);
      if (existing && written?.messageId === existing.card.messageId && written.json === json) return { botId: bot.id, threadId, worth };
      const shown = existing ? edit(bot, existing.card, card) : post(bot, threadId, card);
      if (!shown) return null;
      written = { messageId: shown, json };
      if (!existing) {
        state.card = { day: today(), botId: bot.id, threadId, messageId: shown, postedAt: now() };
        state.introducedOn ??= state.card.day;
      }
      const seen = new Set(state.notified ?? []);
      const fresh = signature(built).filter((key) => !seen.has(key));
      if ((options.notify || !existing) && (fresh.length || !existing) && needsPerson) deps.notify(bot, threadId, card.summary);
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

  /** A server card of its own in the brief's chat: a prep or a reminder. Null when there is no Chief or chat. */
  function postCard(built: BuiltCard): { bot: BotRecord; threadId: string; messageId: string } | null {
    const bot = chief();
    const threadId = bot ? home(bot) : undefined;
    if (!bot || !threadId) return null;
    const messageId = post(bot, threadId, built);
    if (!messageId) return null;
    deps.notify(bot, threadId, built.summary);
    return { bot, threadId, messageId };
  }

  /** What the checks found that needs no AI: today's meetings, clashes, reminders, other routines, trouble. */
  async function report(found: CheckReport): Promise<void> {
    if (deps.hosted) return;
    if (found.meetings) calendar = { meetings: found.meetings, clashes: found.clashes ?? [] };
    trouble = found.trouble ?? [];
    waiting = found.waiting;
    unfenced = found.unfenced === true;
    for (const event of found.remind ?? []) postCard(reminderCard({ event, timeZone: timeZone(), now: now() }));
    await followUpReplies(found.session);
    if (state.lastActiveAt !== undefined) await render({ create: false, notify: true });
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
      for (const pick of result.important) {
        const email = items.mail.find((one) => one.id === pick.id)!;
        headers.set(email.id, { ...email, why: pick.why });
        state.important = [...state.important.filter((row) => row.messageId !== email.id), { messageId: email.id, threadId: email.threadId, at: email.at, judgedAt: at, needsReply: pick.needsReply }].slice(-MAX_ROWS);
      }
      for (const prep of result.prep) {
        const meeting = items.prep.find((one) => one.key === prep.id)!;
        if (state.preps.some((one) => one.key === meeting.key && one.at > at - DAY)) continue;
        if (postCard(prepCard({ event: meeting.event, prep: prep.brief, timeZone: timeZone(), now: at }))) state.preps = [...state.preps, { key: meeting.key, at }].slice(-MAX_ROWS);
      }
    }
    deps.keep(key);
    save();
    if (!result.quiet && result.important.length) await render({ create: true, notify: true });
  }

  /** The person arrived: the first open of a day, or a return after 3 hours away, shows today's brief when it has anything
   * in it. Any other ping only records the time, so the brief never takes the screen from a chat in use. */
  async function active(source: "desktop" | "phone", zone?: string): Promise<PresenceAnswer> {
    if (deps.hosted) return { returned: false };
    const at = now();
    if (zone && validZone(zone) && zone !== state.timeZone) state.timeZone = zone;
    const previous = state.lastActiveAt;
    state.lastActiveAt = at;
    const skewed = previous !== undefined && previous > at + CLOCK_SKEW_MS;
    const returned = previous !== undefined && !skewed && at - previous >= AWAY_MS;
    const firstToday = previous === undefined || (!skewed && localDate(previous, timeZone()) !== today());
    if (returned || firstToday || persistedAt === undefined || at - persistedAt >= PERSIST_EVERY_MS) save();
    void source;
    if (!returned && !firstToday) return { returned: false };
    const shown = await render({ create: true, notify: false });
    return shown?.worth ? { returned, open: { botId: shown.botId, threadId: shown.threadId } } : { returned };
  }

  const briefRow = (threadId: string, messageId: string): boolean => {
    const card = state.card;
    return card !== undefined && card.threadId === threadId && card.messageId === messageId;
  };

  /** Security invariant: only the owner or an admin dismisses, only on the brief card itself, and the press starts no
   * turn. Null for any other press, which goes to the bot as usual. */
  function serverPress(bot: Pick<BotRecord, "id">, threadId: string, messageId: string, action: WidgetAction, auth: RequestAuth): "handled" | "refused" | null {
    if (deps.hosted || action.type !== DISMISS_ACTION || !briefRow(threadId, messageId) || state.card?.botId !== bot.id) return null;
    if (deps.store.messagesFor(threadId).find((row) => row.id === messageId)?.serverCard !== true) return null;
    if (!ownerOrAdmin(auth)) return "refused";
    const target = isRecord(action.payload) && typeof action.payload.messageId === "string" ? action.payload.messageId : null;
    if (!target) return "handled";
    const header = headers.get(target);
    state.dismissed = [...state.dismissed.filter((one) => one.messageId !== target && now() - one.at <= DISMISSED_MS), { messageId: target, from: header ? addressOf(header.from) : "", at: now() }].slice(-MAX_ROWS);
    save();
    void render({ create: false, notify: false });
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
    /** Each minute: an edit a busy chat held back. */
    tick: (): void => { if (dirty) void render({ create: false, notify: false }); },
    card: (): WidgetRoot | undefined => {
      const shown = currentCard();
      return shown?.row.widget?.root;
    },
  };
}

export type Brief = ReturnType<typeof createBrief>;
