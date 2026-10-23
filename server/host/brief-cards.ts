// The server-built cards of the brief: the daily brief itself, meeting prep and the 10-minute reminder. Each is a widget
// the server writes and only the server may edit. Text from mail and invites is untrusted, so it is shown as plain Text
// and Caption nodes only, and a link becomes a button only when it is an https link with no username or password.
import { WEB_URL_MAX, WIDGET_LIMITS, type WidgetRoot } from "../../shared/widget.ts";
import type { WidgetMoment, WidgetText, WidgetTextFields } from "../../shared/widget-text.ts";
import type { CalendarEvent } from "../connected-reads.ts";
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
const bareClock = (ms: number, timeZone: string | undefined): string =>
  plain(new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: zoneOf(timeZone) }));

/** Labelled UTC when no zone is known. */
export function clockTime(ms: number, timeZone: string | undefined): string {
  return validZone(timeZone) ? bareClock(ms, timeZone) : `${bareClock(ms, timeZone)} UTC`;
}

export const moment = (at: number, style: WidgetMoment["style"], timeZone: string | undefined): WidgetMoment =>
  ({ at, style, ...(validZone(timeZone) ? { zone: timeZone } : {}) });
export const words = (key: string, params?: WidgetText["params"]): WidgetText => ({ key, ...(params ? { params } : {}) });

function dayLabel(start: number, timeZone: string | undefined, now: number): { english: string; words: WidgetText | WidgetMoment } {
  const date = localDate(start, timeZone);
  if (date === localDate(now, timeZone)) return { english: "Today", words: words("brief.part.today") };
  if (date === localDate(now + DAY, timeZone)) return { english: "Tomorrow", words: words("brief.part.tomorrow") };
  return {
    english: plain(new Date(start).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: zoneOf(timeZone) })),
    words: moment(start, "shortDate", timeZone),
  };
}

export function meetingWhen(start: number, end: number, timeZone: string | undefined, now: number): string {
  return `${dayLabel(start, timeZone, now).english}, ${bareClock(start, timeZone)} to ${clockTime(end, timeZone)}`;
}

function meetingWhenWords(start: number, end: number, timeZone: string | undefined, now: number, where = ""): WidgetText {
  return words("brief.card.meetingWhen", { day: dayLabel(start, timeZone, now).words, start: moment(start, "bareClock", timeZone), end: moment(end, "clock", timeZone), where });
}

export function attendeeNames(event: CalendarEvent): string {
  const others = event.attendees.filter((attendee) => !attendee.self);
  const name = (attendee: CalendarEvent["attendees"][number]) => attendee.name ?? attendee.email.split("@")[0]!;
  if (others.length <= 1) return others[0] ? name(others[0]) : "your meeting";
  return `${name(others[0]!)} and ${others.length - 1} other${others.length === 2 ? "" : "s"}`;
}

function attendeeWords(event: CalendarEvent): WidgetText | string {
  const others = event.attendees.filter((attendee) => !attendee.self);
  const name = (attendee: CalendarEvent["attendees"][number]) => attendee.name ?? attendee.email.split("@")[0]!;
  if (others.length <= 1) return others[0] ? name(others[0]) : words("brief.part.yourMeeting");
  return words(others.length === 2 ? "brief.part.andOneOther" : "brief.part.andOthers", { name: name(others[0]!), count: others.length - 1 });
}

export const gmailUrl = (threadId: string): string => `https://mail.google.com/mail/#all/${encodeURIComponent(threadId)}`;

const i18n = (fields: WidgetTextFields): Node => ({ i18n: fields });
const button = (label: string, onClickAction: Node, primary = false, said?: WidgetText): Node =>
  ({ type: "Button", label: clip(label, WIDGET_LIMITS.label), style: primary ? "primary" : "secondary", onClickAction, ...(said ? i18n({ label: said }) : {}) });
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
const joinButton = (event: Pick<CalendarEvent, "joinUrl">): Node[] => {
  const link = httpsLink(event.joinUrl);
  const action = link ? openUrl(link) : undefined;
  return action ? [button("Join", action, true, words("brief.card.join"))] : [];
};
const buttons = (items: Node[]): Node[] => (items.length ? [{ type: "Row", gap: 2, wrap: true, children: items }] : []);
const text = (value: string, said?: WidgetText): Node => ({ type: "Text", value: clip(value, WIDGET_LIMITS.text), ...(said ? i18n({ value: said }) : {}) });
const caption = (value: string, said?: WidgetText): Node => ({ type: "Caption", value: clip(value, 160), ...(said ? i18n({ value: said }) : {}) });

function root(title: string, subtitle: string | undefined, children: Node[], said: WidgetTextFields = {}): WidgetRoot {
  return { type: "Card", id: "root", title: oneLine(title, WIDGET_LIMITS.title), ...(subtitle ? { caption: oneLine(subtitle, WIDGET_LIMITS.caption) } : {}), children,
    ...(Object.keys(said).length ? i18n(said) : {}) } as unknown as WidgetRoot;
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
    card: root(`Prep: ${event.title}`, `${when}${where}`, [...prepLines(input.prep), ...buttons(joinButton(event))],
      { title: words("brief.card.prepTitle", { title: event.title }), caption: meetingWhenWords(event.start, event.end, input.timeZone, input.now, where) }),
    summary: summary(`Prep ready: ${event.title}, ${when}`),
  };
}

export function reminderCard(input: { event: CalendarEvent; timeZone?: string; now: number }): BuiltCard {
  const { event } = input;
  const minutes = Math.max(1, Math.round((event.start - input.now) / 60_000));
  const title = `${event.title} with ${attendeeNames(event)} in ${minutes} minute${minutes === 1 ? "" : "s"}`;
  const said = { title: words(minutes === 1 ? "brief.card.reminderOne" : "brief.card.reminderMany", { title: event.title, who: attendeeWords(event), minutes }),
    caption: meetingWhenWords(event.start, event.end, input.timeZone, input.now) };
  return { card: root(title, meetingWhen(event.start, event.end, input.timeZone, input.now), buttons(joinButton(event)), said), summary: summary(title) };
}

export const BRIEF_TITLE = "Your brief";
export const BRIEF_ROWS = 6;
export const DISMISS_ACTION = "dismiss_row";
export const DRAFT_ACTION = "draft_reply";
export const BRIEF_INTRO = "I keep an eye on your calendar and email and put what needs you here, once a day and when you come back. Tell me to stop, or what to watch for.";

export interface BriefEmail { messageId: string; threadId: string; from: string; subject: string; why?: string; needsReply: boolean }
/** `page`: the live page a routine's run published; its row's Open page opens it, while Open opens the run's chat. */
export interface BriefRow { text: string; note: string; open?: OpenTarget; page?: string; said?: { text?: WidgetText; note?: WidgetText } }
export interface BriefMeeting { title: string; start: number; joinUrl?: string }
export interface BriefFacts {
  now: number;
  timeZone?: string;
  intro: boolean;
  /** Things only the person can fix: failed routines, clashes, a read that failed, a signed-out AI, a question waiting. */
  needs: BriefRow[];
  /** null: no calendar is read, so Your day is left out. */
  meetings: BriefMeeting[] | null;
  emails: BriefEmail[];
  /** New emails that wait for the next sort, or true when there were more than one check reads. */
  waiting?: number | true;
  routines: BriefRow[];
}

const BRIEF_TEXT = { line: 120, note: 160, sender: 40, label: 32, link: 600 } as const;
const NOTHING_NEEDS_YOU = "Nothing needs you right now.";
const NEEDS_YOU = "Needs you";

function senderName(rawFrom: string): string {
  const from = rawFrom.slice(0, 300);
  const match = /^\s*"?([^"<]*?)"?\s*<([^>]*)>\s*$/.exec(from);
  return match ? match[1]!.trim() || match[2]!.trim() : from.trim();
}
const sender = (email: BriefEmail, max: number): string => oneLine(senderName(email.from), max) || "(no sender)";
type RowWords = BriefRow["said"];
const rowLines = (value: string, note: string, said: RowWords = {}): Node[] =>
  [{ type: "Text", value: clip(value, BRIEF_TEXT.line), weight: "medium", ...(said.text ? i18n({ value: said.text }) : {}) }, ...(note ? [caption(note, said.note)] : [])];
const rowBeside = (value: string, note: string, presses: Node[], said?: RowWords): Node =>
  ({ type: "Row", gap: 3, align: "center", children: [{ type: "Col", flex: 1, children: rowLines(value, note, said) }, ...presses] });
const rowUnder = (value: string, note: string, presses: Node[], said?: RowWords): Node =>
  ({ type: "Col", gap: 1, children: [...rowLines(value, note, said), ...buttons(presses)] });
function capped(rows: Node[], total: number): Node[] {
  const shown = rows.slice(0, BRIEF_ROWS);
  const more = total - shown.length;
  return more > 0 ? [...shown, caption(`and ${more} more`, words("brief.card.more", { count: more }))] : shown;
}
const section = (title: [string, string], rows: Node[], total: number, empty?: [string, string]): Node[] =>
  [{ type: "Title", value: title[0], size: "sm", ...i18n({ value: words(title[1]) }) }, ...(rows.length ? capped(rows, total) : empty ? [text(empty[0], words(empty[1]))] : [])];
const openButton = (target: OpenTarget | undefined): Node[] => (target ? [button("Open", { type: "open_thread", payload: target }, false, words("brief.card.open"))] : []);
const pageButton = (url: string | undefined): Node[] => { const link = httpsLink(url), open = link ? openUrl(link) : undefined; return open ? [button("Open page", open)] : []; };

function emailRow(email: BriefEmail): Node {
  const who = sender(email, BRIEF_TEXT.label);
  const gmail = email.threadId.length <= BRIEF_TEXT.link ? openUrl(gmailUrl(email.threadId)) : undefined;
  const note = email.needsReply ? (email.why ? `Waiting on your reply · ${email.why}` : "Waiting on your reply") : email.why ?? "Important";
  const noteWords = email.needsReply ? (email.why ? words("brief.card.waitingReplyWhy", { why: email.why }) : words("brief.card.waitingReply")) : email.why ? undefined : words("brief.card.important");
  const whoWords = senderName(email.from).trim() ? who : words("brief.part.noSender");
  const line = words("brief.card.emailLine", { sender: senderName(email.from).trim() ? sender(email, BRIEF_TEXT.sender) : words("brief.part.noSender"), subject: email.subject || words("brief.part.noSubject") });
  return rowUnder(`${sender(email, BRIEF_TEXT.sender)}: ${email.subject || "(no subject)"}`, note, [
    button(`Draft a reply to ${who}`, { type: DRAFT_ACTION, payload: { messageId: email.messageId } }, true, words("brief.card.draftReply", { who: whoWords })),
    ...(gmail ? [button("Open in Gmail", gmail, false, words("brief.card.openGmail"))] : []),
    button(`Dismiss ${who}'s email`, { type: DISMISS_ACTION, payload: { messageId: email.messageId } }, false, words("brief.card.dismissEmail", { who: whoWords })),
  ], { text: line, ...(noteWords ? { note: noteWords } : {}) });
}

const longDate = (now: number, timeZone: string | undefined): string =>
  plain(new Date(now).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: zoneOf(timeZone) }));
const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;

export function briefCard(facts: BriefFacts): BuiltCard {
  const zone = facts.timeZone;
  const replies = facts.emails.filter((email) => email.needsReply);
  const important = facts.emails.filter((email) => !email.needsReply);
  const needRows = [...replies.map(emailRow), ...facts.needs.map((row) => rowBeside(row.text, row.note, openButton(row.open), row.said))];
  const meetings = [...(facts.meetings ?? [])].sort((a, b) => a.start - b.start);
  const meetingRows = meetings.map((meeting) => rowBeside(`${clockTime(meeting.start, zone)} · ${meeting.title}`, "", joinButton(meeting),
    { text: words("brief.card.meetingLine", { time: moment(meeting.start, "clock", zone), title: meeting.title }) }));
  const waiting = facts.waiting === true ? "More new emails than one check reads; I'll sort the rest next."
    : facts.waiting ? `${plural(facts.waiting, "more new email")} since you were away; I'll sort them next.` : undefined;
  const waitingWords = facts.waiting === true ? words("brief.card.waitingMany")
    : words(facts.waiting === 1 ? "brief.card.waitingOne" : "brief.card.waitingOther", { count: facts.waiting || 0 });
  const importantRows = [...important.map(emailRow), ...(waiting ? [caption(waiting, waitingWords)] : [])];
  const routineRows = facts.routines.map((row) => rowBeside(row.text, row.note, [...pageButton(row.page), ...openButton(row.open)], row.said));
  const children: Node[] = [
    ...(facts.intro ? [caption(BRIEF_INTRO, words("brief.card.intro"))] : []),
    ...section([NEEDS_YOU, "brief.card.needsYou"], needRows, needRows.length, [NOTHING_NEEDS_YOU, "brief.card.nothingNeedsYou"]),
    ...(facts.meetings === null ? [] : section(["Your day", "brief.card.yourDay"], meetingRows, meetingRows.length, ["No more meetings today.", "brief.card.noMeetings"])),
    ...(importantRows.length ? section(["Important emails", "brief.card.importantEmails"], importantRows, importantRows.length) : []),
    ...(routineRows.length ? section(["Routines", "brief.card.routines"], routineRows, routineRows.length) : []),
  ];
  const needCount = needRows.length;
  const parts = [
    needCount && `${needCount} ${needCount === 1 ? "needs" : "need"} you`,
    facts.meetings && facts.meetings.length && plural(facts.meetings.length, "meeting"),
    important.length && plural(important.length, "important email"),
    facts.routines.length && plural(facts.routines.length, "routine result"),
  ].filter(Boolean);
  return { card: root(BRIEF_TITLE, longDate(facts.now, zone), children, { title: words("brief.card.title"), caption: words("brief.card.date", { date: { at: Date.parse(`${localDate(facts.now, zone)}T12:00:00Z`), style: "longDate", zone: "UTC" } }) }), summary: summary(`${BRIEF_TITLE}: ${parts.length ? parts.join(", ") : "nothing needs you right now"}`) };
}
