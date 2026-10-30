// The server-built cards of the brief: the daily brief itself, meeting prep and the 10-minute reminder. Each is a widget
// the server writes and only the server may edit. Text from mail and invites is untrusted, so it is shown as plain Text
// and Caption nodes only, and a link becomes a button only when it is an https link with no username or password.
import { WEB_URL_MAX, WIDGET_LIMITS, type WidgetRoot } from "../../shared/widget.ts";
import type { CalendarEvent } from "../connected-reads.ts";
import { intlLocale } from "../language.ts";
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
export const DISMISS_ACTION = "dismiss_row";
export const DRAFT_ACTION = "draft_reply";

export interface BriefEmail { messageId: string; threadId: string; from: string; subject: string; why?: string; needsReply: boolean }
/** `page`: the live page a routine's run published; its row's Open page opens it, while Open opens the run's chat. */
export interface BriefRow { text: string; note: string; open?: OpenTarget; page?: string }
/** A row that needs the person. `key` names what it is about in no particular language, so a new language is not news. */
export type NeedRow = BriefRow & { key: string };
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
function capped(rows: Node[], w: BriefWords): Node[] {
  const shown = rows.slice(0, BRIEF_ROWS);
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

export function briefCard(facts: BriefFacts): BuiltCard {
  const { timeZone: zone, language } = facts;
  const w = briefWords(language);
  const replies = facts.emails.filter((email) => email.needsReply);
  const important = facts.emails.filter((email) => !email.needsReply);
  const needRows = [...replies.map((email) => emailRow(email, w)), ...facts.needs.map((row) => rowBeside(row.text, row.note, openButton(row.open, w)))];
  const meetings = [...(facts.meetings ?? [])].sort((a, b) => a.start - b.start);
  const meetingRows = meetings.map((meeting) => rowBeside(`${clockTime(meeting.start, zone, language)} · ${meeting.title}`, "", joinButton(meeting, w.join)));
  const waiting = facts.waiting === true ? w.waitingMany : facts.waiting ? w.waitingCount(facts.waiting) : undefined;
  const importantRows = important.map((email) => emailRow(email, w));
  const waitingNotice = waiting ? [caption(waiting)] : [];
  const routineRows = facts.routines.map((row) => rowBeside(row.text, row.note, [...pageButton(row.page, w), ...openButton(row.open, w)]));
  const ideaRows = (facts.ideas ?? []).map((row) => rowBeside(row.text, row.note, []));
  const children: Node[] = [
    ...(facts.overnight ? [{ type: "Text", value: clip(facts.overnight, BRIEF_TEXT.note * 2), weight: "medium" }] : []),
    ...(facts.intro ? [caption(w.intro)] : []),
    ...section(w.needsYou, needRows, w, w.nothingNeedsYou),
    ...(facts.meetings === null ? [] : section(w.yourDay, meetingRows, w, w.noMoreMeetings)),
    ...(importantRows.length || waitingNotice.length ? section(w.importantEmails, importantRows, w, undefined, waitingNotice) : []),
    ...(routineRows.length ? section(w.routines, routineRows, w) : []),
    ...(ideaRows.length ? section(w.ideas, ideaRows, w) : []),
  ];
  const parts = [
    needRows.length && w.summary.needs(needRows.length),
    facts.meetings && facts.meetings.length && w.summary.meetings(facts.meetings.length),
    important.length && w.summary.emails(important.length),
    facts.routines.length && w.summary.routines(facts.routines.length),
    ideaRows.length && w.summary.ideas(ideaRows.length),
  ].filter(Boolean);
  return { card: root(w.title, longDate(facts.now, zone, language), children), summary: summary(`${w.title}: ${parts.length ? parts.join(", ") : w.summary.nothing}`) };
}
