// What the calendar and mail checks found, decided in plain code: which meetings need prep or a reminder, which ones
// clash, and which new emails go to the AI to sort. Pure, so every rule is tested without a clock or a connected app.
import { createHash } from "node:crypto";

import type { CalendarEvent, EmailHeader, ThreadMessage } from "../connected-reads.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
export const PREP_LEAD_MS = 4 * HOUR;
export const REMINDER_LEAD_MS = 10 * MINUTE;
export const LOOKAHEAD_MS = 36 * HOUR;
/** Emails one run sorts; any more since the last check wait for the next, newest first. */
export const TRIAGE_BATCH = 20;
/** Important emails one run may pick. */
export const PICKS_PER_TRIAGE = 5;
export const EMAIL_MAX_AGE_MS = 24 * HOUR;
export const KEEP_MEETINGS_MS = 7 * 24 * HOUR;
/** How far back a routine's first mail check reads: the morning's mail, not only the last few minutes. */
export const FIRST_MAIL_LOOK_BACK_MS = 12 * HOUR;

/** What the checks remember about one meeting: ids and times only. */
export interface MeetingRecord {
  start: number;
  /** The other attendees' addresses, hashed: a changed guest list is a different meeting to prepare for. */
  fingerprint: string;
  /** Handed to a run for prep and not yet done. */
  prepStartedAt?: number;
  preppedAt?: number;
  remindedAt?: number;
}

export type MeetingJob<T extends CalendarEvent = CalendarEvent> = { kind: "prep"; event: T; short: boolean } | { kind: "remind"; event: T };

export const validZone = (zone: string | undefined): string | undefined => {
  if (!zone) return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    return undefined;
  }
};

/** A meeting with someone else that the person has not declined. */
export function qualifies(event: CalendarEvent): boolean {
  return event.status !== "cancelled" && !event.allDay && !event.selfDeclined && event.attendees.some((attendee) => !attendee.self);
}

export function fingerprint(event: CalendarEvent): string {
  const others = event.attendees.filter((attendee) => !attendee.self).map((attendee) => attendee.email.toLowerCase()).sort();
  return createHash("sha256").update(others.join("\n")).digest("hex").slice(0, 32);
}

export function localDate(ms: number, timeZone: string | undefined): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: validZone(timeZone) ?? "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(ms));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** Prep once a meeting with others is 4 hours away (a short one when the check came late), and a reminder 10 minutes
 * before. A meeting whose guest list changed after its prep is prepared again. */
export function planMeetings<T extends CalendarEvent>(input: { now: number; events: readonly T[]; meetings: Record<string, MeetingRecord>; checkMs: number }): MeetingJob<T>[] {
  const { now, meetings } = input;
  const jobs: MeetingJob<T>[] = [];
  for (const event of input.events) {
    if (!qualifies(event) || event.start <= now) continue;
    const record = meetings[event.id];
    const same = record !== undefined && record.fingerprint === fingerprint(event) && record.start === event.start;
    const prepared = same && (record.preppedAt !== undefined || record.prepStartedAt !== undefined);
    if (!prepared && event.start - now <= PREP_LEAD_MS) jobs.push({ kind: "prep", event, short: now - (event.start - PREP_LEAD_MS) > input.checkMs });
    const reminded = record?.remindedAt !== undefined && record.start === event.start;
    if (!reminded && event.start - now <= REMINDER_LEAD_MS) jobs.push({ kind: "remind", event });
  }
  return jobs;
}

/** The next time a meeting needs prep or its reminder: the only time the checks need the computer awake. */
export function nextMeetingDue(input: { now: number; events: readonly CalendarEvent[]; meetings: Record<string, MeetingRecord> }): number | undefined {
  const times = input.events.filter((event) => qualifies(event) && event.start > input.now).flatMap((event) => {
    const record = input.meetings[event.id];
    const same = record?.start === event.start;
    return [
      ...(same && (record.preppedAt !== undefined || record.prepStartedAt !== undefined) ? [] : [event.start - PREP_LEAD_MS]),
      ...(same && record.remindedAt !== undefined ? [] : [event.start - REMINDER_LEAD_MS]),
    ];
  }).filter((at) => at > input.now);
  return times.length ? Math.min(...times) : undefined;
}

export function pruneMeetings(meetings: Record<string, MeetingRecord>, now: number): Record<string, MeetingRecord> {
  return Object.fromEntries(Object.entries(meetings).filter(([, record]) => now - record.start <= KEEP_MEETINGS_MS));
}

export function keepNewest<T>(list: readonly T[], max: number): T[] {
  return list.length > max ? list.slice(list.length - max) : [...list];
}

/** Where the next mail check starts: the cursor, but never more than a day back; the first check reads the last 12 hours. */
export function emailSince(input: { now: number; emailCursor?: number }): number {
  if (input.emailCursor === undefined) return input.now - FIRST_MAIL_LOOK_BACK_MS;
  return Math.max(input.emailCursor, input.now - EMAIL_MAX_AGE_MS);
}

const MEETING_KEY_MAX = 256;
const hashed = (kind: string, value: string): string => `${kind}:${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;

/** One key for a meeting however many of the person's calendars show it. */
export function meetingKey(event: CalendarEvent): string {
  if (!event.iCalUID) return hashed("sig", JSON.stringify([event.title.toLowerCase().replace(/\s+/g, " ").trim(), event.start, event.end]));
  const key = event.seriesId ? `${event.iCalUID}#${event.originalStart ?? event.id}` : event.iCalUID;
  return key.length > MEETING_KEY_MAX ? hashed("uid", key) : key;
}

export function isMine(event: CalendarEvent, address: string | undefined): boolean {
  if (event.ownedCalendar === true) return true;
  if (address === undefined) return false;
  return event.organizer?.toLowerCase() === address || event.attendees.some((attendee) => attendee.email.toLowerCase() === address);
}

/** The person's meetings, each once: a meeting several of their calendars show keeps the copy with the most guests, under
 * one key, and the person's own address marks them as the attendee who is themselves. */
export function mergeMeetings(events: readonly CalendarEvent[], address: string | undefined): CalendarEvent[] {
  const groups = new Map<string, CalendarEvent[]>();
  for (const event of events.filter((one) => isMine(one, address))) {
    const key = meetingKey(event);
    groups.set(key, [...(groups.get(key) ?? []), event]);
  }
  return [...groups].map(([key, group]) => {
    const live = group.filter((copy) => copy.status !== "cancelled");
    const pool = live.length > 0 ? live : group;
    const lead = pool.reduce((best, copy) => (copy.attendees.length > best.attendees.length || (copy.attendees.length === best.attendees.length && copy.id < best.id) ? copy : best));
    const attendees = lead.attendees.map((attendee) => ({ ...attendee, self: attendee.self || (address !== undefined && attendee.email.toLowerCase() === address) }));
    const mine = attendees.filter((attendee) => attendee.self);
    return { ...lead, id: key, attendees, selfDeclined: mine.length > 0 ? mine.every((attendee) => attendee.response === "declined") : lead.selfDeclined };
  }).sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Meetings with others today that overlap and have not ended. */
export function clashes<T extends CalendarEvent>(meetings: readonly T[], input: { now: number; timeZone?: string }): Array<[T, T]> {
  const today = localDate(input.now, input.timeZone);
  const open = meetings
    .filter((meeting) => qualifies(meeting) && meeting.end > input.now && localDate(meeting.start, input.timeZone) === today)
    .sort((a, b) => a.start - b.start);
  const pairs: Array<[T, T]> = [];
  open.forEach((first, index) => {
    for (const second of open.slice(index + 1)) {
      if (second.start < first.end && first.start < second.end) pairs.push([first, second]);
    }
  });
  return pairs;
}

/** New mail not yet sorted: the newest batch goes to the AI, older than a day stays quiet, and the rest waits. */
export function planMail(input: { now: number; emails: readonly EmailHeader[]; judged: ReadonlySet<string> }): { batch: EmailHeader[]; quiet: EmailHeader[]; waiting: EmailHeader[] } {
  const fresh = input.emails.filter((email) => !input.judged.has(email.id));
  const quiet = fresh.filter((email) => input.now - email.at > EMAIL_MAX_AGE_MS);
  const recent = fresh.filter((email) => input.now - email.at <= EMAIL_MAX_AGE_MS).sort((a, b) => b.at - a.at);
  return { batch: recent.slice(0, TRIAGE_BATCH), quiet, waiting: recent.slice(TRIAGE_BATCH) };
}

/** The person replied in the thread after this email arrived. */
export function answered(email: Pick<EmailHeader, "at">, thread: readonly ThreadMessage[], address: string | undefined): boolean {
  return address !== undefined && thread.some((message) => message.at > email.at && message.from === address);
}
