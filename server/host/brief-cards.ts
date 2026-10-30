// The server-built cards of the brief: the daily brief itself, meeting prep and the 10-minute reminder. Each is a widget
// the server writes and only the server may edit. Text from mail and invites is untrusted, so it is shown as plain Text
// and Caption nodes only, and a link becomes a button only when it is an https link with no username or password.
import { WEB_URL_MAX, WIDGET_LIMITS, type WidgetRoot } from "../../shared/widget.ts";
import type { CalendarEvent } from "../connected-reads.ts";
import { intlLocale } from "../language.ts";
import { morningWords, type MorningWords } from "./brief-morning-words.ts";
import { briefWords, type BriefWords } from "./brief-words.ts";
import { localDate, validZone } from "./check-plan.ts";
import { clip, oneLine } from "./text-clip.ts";

export interface BuiltCard {
  card: WidgetRoot;
  summary: string;
}

type Node = Record<string, unknown>;
export type OpenTarget = { botId: string; threadId: string };
const DAY = 24 * 60 * 60_000;
const SUMMARY_MAX = 140;
const summary = (value: string): string => oneLine(value, SUMMARY_MAX);
const zoneOf = (timeZone: string | undefined): string => validZone(timeZone) ?? "UTC";
// ICU puts a narrow no-break space before AM/PM; cards and tests read plain spaces.
const plain = (text: string): string => text.replace(/\s/g, " ");
const bareClock = (ms: number, timeZone: string | undefined, language?: string): string =>
  plain(new Date(ms).toLocaleTimeString(intlLocale(language), { hour: "numeric", minute: "2-digit", timeZone: zoneOf(timeZone) }));

/** Labelled UTC when no zone is known. */
export function clockTime(ms: number, timeZone: string | undefined, language?: string): string {
  return validZone(timeZone) ? bareClock(ms, timeZone, language) : `${bareClock(ms, timeZone, language)} UTC`;
}

function dayLabel(start: number, timeZone: string | undefined, now: number): string {
  const date = localDate(start, timeZone);
  if (date === localDate(now, timeZone)) return "Today";
  if (date === localDate(now + DAY, timeZone)) return "Tomorrow";
  return plain(new Date(start).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: zoneOf(timeZone) }));
}

export function meetingWhen(start: number, end: number, timeZone: string | undefined, now: number): string {
  return `${dayLabel(start, timeZone, now)}, ${bareClock(start, timeZone)} to ${clockTime(end, timeZone)}`;
}

export function attendeeNames(event: CalendarEvent): string {
  const others = event.attendees.filter((attendee) => !attendee.self);
  const name = (attendee: CalendarEvent["attendees"][number]) => attendee.name ?? attendee.email.split("@")[0]!;
  if (others.length <= 1) return others[0] ? name(others[0]) : "your meeting";
  return `${name(others[0]!)} and ${others.length - 1} other${others.length === 2 ? "" : "s"}`;
}

export const gmailUrl = (threadId: string): string => `https://mail.google.com/mail/#all/${encodeURIComponent(threadId)}`;

const button = (label: string, onClickAction: Node, primary = false): Node => ({ type: "Button", label: clip(label, WIDGET_LIMITS.label), style: primary ? "primary" : "secondary", onClickAction });
function openUrl(url: string): Node | undefined {
  const payload = { url };
  return url.length <= WEB_URL_MAX && JSON.stringify(payload).length <= WIDGET_LIMITS.actionPayloadBytes ? { type: "open_url", payload } : undefined;
}
// Invites are untrusted, so only an https link without a username or password becomes a button.
export function httpsLink(url: string | undefined): string | undefined {
  try {
    const parsed = url ? new URL(url) : undefined;
    return parsed?.protocol === "https:" && !parsed.username && !parsed.password && openUrl(parsed.href) ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}
const joinButton = (event: Pick<CalendarEvent, "joinUrl">, label = "Join"): Node[] => {
  const link = httpsLink(event.joinUrl);
  const action = link ? openUrl(link) : undefined;
  return action ? [button(label, action, true)] : [];
};
const buttons = (items: Node[]): Node[] => (items.length ? [{ type: "Row", gap: 2, wrap: true, children: items }] : []);
const text = (value: string): Node => ({ type: "Text", value: clip(value, WIDGET_LIMITS.text) });
const caption = (value: string): Node => ({ type: "Caption", value: clip(value, 160) });

function root(title: string, subtitle: string | undefined, children: Node[]): WidgetRoot {
  return { type: "Card", id: "root", title: oneLine(title, WIDGET_LIMITS.title), ...(subtitle ? { caption: oneLine(subtitle, WIDGET_LIMITS.caption) } : {}), children } as unknown as WidgetRoot;
}

const PREP_LINES = 60;
// The prep is AI text shaped by untrusted invites: plain Text nodes only, so no link, image or HTML can render.
function prepLines(prep: string): Node[] {
  const lines = clip(prep, WIDGET_LIMITS.markdown).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const shown = lines.length > PREP_LINES ? [...lines.slice(0, PREP_LINES - 1), lines.slice(PREP_LINES - 1).join(" ")] : lines;
  return shown.map((line) => text(line));
}

export function prepCard(input: { event: CalendarEvent; prep: string; timeZone?: string; now: number }): BuiltCard {
  const { event } = input;
  const when = meetingWhen(event.start, event.end, input.timeZone, input.now);
  const where = event.location && event.location !== event.joinUrl ? ` · ${event.location}` : "";
  return {
    card: root(`Prep: ${event.title}`, `${when}${where}`, [...prepLines(input.prep), ...buttons(joinButton(event))]),
    summary: summary(`Prep ready: ${event.title}, ${when}`),
  };
}

export function reminderCard(input: { event: CalendarEvent; timeZone?: string; now: number }): BuiltCard {
  const { event } = input;
  const minutes = Math.max(1, Math.round((event.start - input.now) / 60_000));
  const title = `${event.title} with ${attendeeNames(event)} in ${minutes} minute${minutes === 1 ? "" : "s"}`;
  return { card: root(title, meetingWhen(event.start, event.end, input.timeZone, input.now), buttons(joinButton(event))), summary: summary(title) };
}

export const BRIEF_ROWS = 6;
const DONE_ROWS = 8;
/** Room left in a button's label for the name of whose row it is on. */
const CHOICE_LABEL = 50;
export const DISMISS_ACTION = "dismiss_row";
export const DRAFT_ACTION = "draft_reply";
export const ANSWER_ACTION = "answer_row";
export const LATER_ACTION = "not_now";
export const MORNING_ACTION = "morning_time";
/** The morning times the brief offers, "HH:MM" in the person's zone. */
export const MORNING_CHOICES = ["06:00", "07:00", "08:00", "09:00", "10:00"] as const;
export const MORNING_OFF = "off";

export interface BriefEmail { messageId: string; threadId: string; from: string; subject: string; why?: string; needsReply: boolean }
/** `page`: the live page a routine's run published; its row's Open page opens it, while Open opens the run's chat. */
export interface BriefRow { text: string; note: string; open?: OpenTarget; page?: string }
/** A row that needs the person. `key` names what it is about in no particular language, so a new language is not news.
 * `ref` is the id a press on the row names: with it the row offers Not now, and `choices` answer its question in place.
 * `bot` and `since` say who is waiting and from when. */
export type NeedRow = BriefRow & { key: string; ref?: string; bot?: string; since?: number; choices?: string[] };
/** A piece of work a bot finished while the person was away. */
export interface DoneRow { text: string; note: string; open?: OpenTarget }
export interface BriefMeeting { title: string; start: number; joinUrl?: string }
export interface BriefFacts {
  now: number;
  timeZone?: string;
  /** The language set in Settings; absent, the brief is in English. */
  language?: string;
  intro: boolean;
  /** Things only the person can fix: failed routines, clashes, a read that failed, a signed-out AI, a question waiting. */
  needs: NeedRow[];
  /** null: no calendar is read, so Your day is left out. */
  meetings: BriefMeeting[] | null;
  emails: BriefEmail[];
  /** New emails that wait for the next sort, or true when there were more than one check reads. */
  waiting?: number | true;
  routines: BriefRow[];
  /** From the nightly dream: suggestions, never news, so they are left out of what notifies. */
  ideas?: BriefRow[];
  /** The morning brief's first line: what was done while the person was away, already in their words. */
  overnight?: string;
  /** When today's card was first posted: the card opens with a greeting for that time of day and a count of what is in it. */
  greetAt?: number;
  /** How many finished pieces of work the Done overnight card lists. */
  doneOvernight?: number;
  /** The morning time ("HH:MM", absent when off), and whether the person is choosing a new one. Absent: no time row. */
  morning?: { at?: string; choosing: boolean };
  /** Questions answered from this card today, as receipts under Needs you. */
  answered?: Array<{ bot: string; answer: string }>;
}

const BRIEF_TEXT = { line: 120, note: 160, sender: 40, label: 32, link: 600 } as const;

function senderName(rawFrom: string): string {
  const from = rawFrom.slice(0, 300);
  const match = /^\s*"?([^"<]*?)"?\s*<([^>]*)>\s*$/.exec(from);
  return match ? match[1]!.trim() || match[2]!.trim() : from.trim();
}
const sender = (email: BriefEmail, max: number, w: BriefWords): string => oneLine(senderName(email.from), max) || w.noSender;
const rowLines = (value: string, note: string): Node[] => [{ type: "Text", value: clip(value, BRIEF_TEXT.line), weight: "medium" }, ...(note ? [caption(note)] : [])];
const rowBeside = (value: string, note: string, presses: Node[]): Node =>
  ({ type: "Row", gap: 3, align: "center", children: [{ type: "Col", flex: 1, children: rowLines(value, note) }, ...presses] });
const rowUnder = (value: string, note: string, presses: Node[]): Node =>
  ({ type: "Col", gap: 1, children: [...rowLines(value, note), ...buttons(presses)] });
function capped(rows: Node[], w: BriefWords, max = BRIEF_ROWS): Node[] {
  const shown = rows.slice(0, max);
  return rows.length > shown.length ? [...shown, caption(w.more(rows.length - shown.length))] : shown;
}
const section = (title: string, rows: Node[], w: BriefWords, empty?: string, after: Node[] = []): Node[] =>
  [{ type: "Title", value: title, size: "sm" }, ...(rows.length ? capped(rows, w) : empty ? [text(empty)] : []), ...after];
const openButton = (target: OpenTarget | undefined, w: BriefWords): Node[] => (target ? [button(w.open, { type: "open_thread", payload: target })] : []);
const pageButton = (url: string | undefined, w: BriefWords): Node[] => { const link = httpsLink(url), open = link ? openUrl(link) : undefined; return open ? [button(w.openPage, open)] : []; };

function emailRow(email: BriefEmail, w: BriefWords): Node {
  const who = sender(email, BRIEF_TEXT.label, w);
  const gmail = email.threadId.length <= BRIEF_TEXT.link ? openUrl(gmailUrl(email.threadId)) : undefined;
  const note = email.needsReply ? (email.why ? `${w.waitingOnReply} · ${email.why}` : w.waitingOnReply) : email.why ?? w.important;
  return rowUnder(`${sender(email, BRIEF_TEXT.sender, w)}: ${email.subject || w.noSubject}`, note, [
    button(w.draftReply(who), { type: DRAFT_ACTION, payload: { messageId: email.messageId } }, true),
    ...(gmail ? [button(w.openInGmail, gmail)] : []),
    button(w.dismiss(who), { type: DISMISS_ACTION, payload: { messageId: email.messageId } }),
  ]);
}

const longDate = (now: number, timeZone: string | undefined, language: string | undefined): string =>
  plain(new Date(now).toLocaleDateString(intlLocale(language), { weekday: "long", month: "long", day: "numeric", timeZone: zoneOf(timeZone) }));
const shortDate = (at: number, timeZone: string | undefined, language: string | undefined): string =>
  plain(new Date(at).toLocaleDateString(intlLocale(language), { month: "short", day: "numeric", timeZone: zoneOf(timeZone) }));

/** "08:00" as the person's language writes a time of day. */
export function clockLabel(clock: string, language: string | undefined): string {
  const at = Date.UTC(2000, 0, 1, Number(clock.slice(0, 2)), Number(clock.slice(3, 5)));
  return plain(new Date(at).toLocaleTimeString(intlLocale(language), { hour: "numeric", minute: "2-digit", timeZone: "UTC" }));
}

function waitingSince(since: number, facts: BriefFacts, m: MorningWords): string {
  const { timeZone: zone, language } = facts, day = localDate(since, zone);
  if (day === localDate(facts.now, zone)) return m.waiting.today(clockTime(since, zone, language));
  if (day === localDate(facts.now - DAY, zone)) return m.waiting.yesterday(clockTime(since, zone, language));
  return m.waiting.earlier(shortDate(since, zone, language));
}

/** A card's buttons that reach the server need labels no other button in it has: a repeat names whose row it is on. */
function distinctLabels(): (label: string, owner: string) => string {
  const used = new Set<string>();
  return (label, owner) => {
    let named = label;
    for (let n = 1; used.has(named); n += 1) named = n === 1 && owner ? `${label} (${owner})` : `${label} (${owner ? `${owner}, ` : ""}${n})`;
    used.add(named);
    return named;
  };
}

function needRow(row: NeedRow, facts: BriefFacts, w: BriefWords, m: MorningWords, label: ReturnType<typeof distinctLabels>): Node {
  const note = [row.bot, row.since === undefined ? "" : waitingSince(row.since, facts, m), row.note].filter(Boolean).join(" · ");
  if (!row.ref) return rowBeside(row.text, note, openButton(row.open, w));
  const ref = row.ref, owner = oneLine(row.bot ?? row.text, 24);
  return rowUnder(row.text, note, [
    ...(row.choices ?? []).map((choice, option) => button(label(clip(choice, CHOICE_LABEL), owner), { type: ANSWER_ACTION, payload: { row: ref, option } })),
    ...openButton(row.open, w),
    button(label(m.notNow, owner), { type: LATER_ACTION, payload: { row: ref } }),
  ]);
}

function partOfDay(at: number, timeZone: string | undefined): keyof MorningWords["greeting"] {
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: zoneOf(timeZone), hour: "2-digit", hourCycle: "h23" }).format(new Date(at)));
  return hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
}

const upperFirst = (text: string): string => text.charAt(0).toLocaleUpperCase() + text.slice(1);

function greetingLine(greetAt: number, parts: string[], facts: BriefFacts, w: BriefWords, m: MorningWords): Node {
  const greeting = m.greeting[partOfDay(greetAt, facts.timeZone)];
  const said = parts.length ? `${upperFirst(parts.join(m.comma))}${m.stop}` : w.nothingNeedsYou;
  return { type: "Text", value: clip(`${greeting}${m.stop}${m.gap}${said}`, WIDGET_LIMITS.text), weight: "medium" };
}

function morningRow(morning: NonNullable<BriefFacts["morning"]>, language: string | undefined, m: MorningWords, label: ReturnType<typeof distinctLabels>): Node[] {
  const pick = (clock: string, text: string, primary = false): Node => button(label(text, ""), { type: MORNING_ACTION, payload: { at: clock } }, primary);
  if (morning.choosing) {
    return [caption(m.changeTime), ...buttons([
      ...MORNING_CHOICES.map((clock) => pick(clock, clockLabel(clock, language), clock === morning.at)),
      ...(morning.at ? [pick(MORNING_OFF, m.turnOff)] : []),
      button(label(m.cancel, ""), { type: MORNING_ACTION, payload: { cancel: true } }),
    ])];
  }
  const said = morning.at ? m.morningAt(clockLabel(morning.at, language)) : m.morningOff;
  const press = morning.at ? button(label(m.changeTime, ""), { type: MORNING_ACTION, payload: { pick: true } }) : pick(MORNING_CHOICES[2], m.turnOn);
  return [{ type: "Row", gap: 3, align: "center", children: [{ type: "Col", flex: 1, children: [caption(said)] }, press] }];
}

export function doneCard(input: { rows: DoneRow[]; since: number; now: number; timeZone?: string; language?: string }): BuiltCard {
  const w = briefWords(input.language), m = morningWords(input.language);
  const rows = input.rows.map((row) => rowBeside(row.text, row.note, openButton(row.open, w)));
  return {
    card: root(m.doneTitle, m.doneSince(clockTime(input.since, input.timeZone, input.language)), capped(rows, w, DONE_ROWS)),
    summary: summary(`${m.doneTitle}: ${m.done(input.rows.length)}`),
  };
}

export function briefCard(facts: BriefFacts): BuiltCard {
  const { timeZone: zone, language } = facts;
  const w = briefWords(language), m = morningWords(language), label = distinctLabels();
  const replies = facts.emails.filter((email) => email.needsReply);
  const important = facts.emails.filter((email) => !email.needsReply);
  const needRows = [...replies.map((email) => emailRow(email, w)), ...facts.needs.map((row) => needRow(row, facts, w, m, label))];
  const meetings = [...(facts.meetings ?? [])].sort((a, b) => a.start - b.start);
  const meetingRows = meetings.map((meeting) => rowBeside(`${clockTime(meeting.start, zone, language)} · ${meeting.title}`, "", joinButton(meeting, w.join)));
  const waiting = facts.waiting === true ? w.waitingMany : facts.waiting ? w.waitingCount(facts.waiting) : undefined;
  const importantRows = important.map((email) => emailRow(email, w));
  const waitingNotice = waiting ? [caption(waiting)] : [];
  const routineRows = facts.routines.map((row) => rowBeside(row.text, row.note, [...pageButton(row.page, w), ...openButton(row.open, w)]));
  const ideaRows = (facts.ideas ?? []).map((row) => rowBeside(row.text, row.note, []));
  const done = facts.doneOvernight ?? 0;
  const parts = [
    needRows.length && w.summary.needs(needRows.length),
    done && m.done(done),
    facts.meetings && facts.meetings.length && w.summary.meetings(facts.meetings.length),
    important.length && w.summary.emails(important.length),
    facts.routines.length && w.summary.routines(facts.routines.length),
    ideaRows.length && w.summary.ideas(ideaRows.length),
  ].filter((part): part is string => Boolean(part));
  const children: Node[] = [
    ...(facts.greetAt === undefined ? [] : [greetingLine(facts.greetAt, parts, facts, w, m)]),
    ...(facts.overnight ? [{ type: "Text", value: clip(facts.overnight, BRIEF_TEXT.note * 2), weight: "medium" }] : []),
    ...(facts.intro ? [caption(w.intro)] : []),
    ...section(w.needsYou, needRows, w, w.nothingNeedsYou, (facts.answered ?? []).map((one) => caption(m.answered(one.bot, one.answer)))),
    ...(facts.meetings === null ? [] : section(w.yourDay, meetingRows, w, w.noMoreMeetings)),
    ...(importantRows.length || waitingNotice.length ? section(w.importantEmails, importantRows, w, undefined, waitingNotice) : []),
    ...(routineRows.length ? section(w.routines, routineRows, w) : []),
    ...(ideaRows.length ? section(w.ideas, ideaRows, w) : []),
    ...(facts.morning ? [{ type: "Divider" }, ...morningRow(facts.morning, language, m, label)] : []),
  ];
  return { card: root(w.title, longDate(facts.now, zone, language), children), summary: summary(`${w.title}: ${parts.length ? parts.join(", ") : w.summary.nothing}`) };
}
