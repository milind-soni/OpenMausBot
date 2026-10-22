// Reads Google Calendar events and Gmail headers from the server through the connected-apps relay, with no AI turn, as
// the default connected account of each app. Tool names, arguments and answer shapes follow Composio's documentation; the
// fixtures are not yet checked against the live service, so an answer of any other shape is an error, never an empty list.
import { parseMcpResponse } from "./connector-tools-list.ts";

export const READ_APPS = ["gmail", "googlecalendar"] as const;
export type ReadApp = (typeof READ_APPS)[number];

export interface CalendarEvent {
  id: string;
  title: string;
  start: number;
  end: number;
  allDay: boolean;
  status: "confirmed" | "tentative" | "cancelled";
  selfDeclined: boolean;
  attendees: Array<{ email: string; name?: string; self: boolean; organizer: boolean; response?: string }>;
  seriesId?: string;
  joinUrl?: string;
  location?: string;
  description?: string;
  calendarId?: string;
  ownedCalendar?: boolean;
  iCalUID?: string;
  originalStart?: number;
  organizer?: string;
}

export interface EmailHeader {
  id: string;
  threadId: string;
  at: number;
  from: string;
  subject: string;
  preview: string;
}

export interface ThreadMessage {
  id: string;
  at: number;
  /** The sender's lower-case address, or "" when the answer named none. */
  from: string;
}

const SIGNED_OUT = /\b(?:unauthori[sz]ed|unauthenticated|invalid[_ ]grant|expired|re-?connect|not connected|no connected account|not active|initiated|initializing|permission denied|forbidden|401|403)\b/i;

/** A read that failed: the app, what went wrong, and whether reconnecting the app is what fixes it. */
export class SourceError extends Error {
  readonly app: ReadApp;
  readonly signedOut: boolean;
  constructor(app: ReadApp, message: string) {
    super(message);
    this.app = app;
    this.signedOut = SIGNED_OUT.test(message);
    this.name = "SourceError";
  }
}

export const CALENDAR_LIST_TOOL = "GOOGLECALENDAR_EVENTS_LIST";
export const CALENDARS_TOOL = "GOOGLECALENDAR_LIST_CALENDARS";
export const GMAIL_FETCH_TOOL = "GMAIL_FETCH_EMAILS";
export const GMAIL_PROFILE_TOOL = "GMAIL_GET_PROFILE";
export const GMAIL_MESSAGE_TOOL = "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID";
export const GMAIL_THREAD_TOOL = "GMAIL_FETCH_MESSAGE_BY_THREAD_ID";
const CALENDAR_READS_AT_ONCE = 4;
const CALENDAR_NAME_MAX = 80;
const GOOGLE_NOT_FOUND = /\brequested entity was not found\b/i;
const MESSAGE_WORD = /\b(?:message|email|thread)\b/i;
const MISSING_WORD = /\b(?:not found|deleted|no longer exists)\b/i;
const OTHER_SUBJECT = /\b(?:account|connect|o?auth|token|permission|scope|credential|tool|integration)/i;
const MULTI_EXECUTE = "COMPOSIO_MULTI_EXECUTE_TOOL";
const CALL_ID = "omb-check-call";
const PREVIEW_MAX = 300;
const ADDRESS = /^[\w.+][\w.+-]*@[\w-]+(?:\.[\w-]+)+$/;
const PRIMARY_CALENDAR = { id: "primary", name: "primary", primary: true, owned: true, read: true } as const;
const GONE = Symbol("gone");

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const flat = (value: unknown): string => (typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "");
const seconds = (ms: number): number => Math.floor(ms / 1000);
const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));
export const isAddress = (value: string): boolean => ADDRESS.test(value);

/** The tool itself answered that it failed, as opposed to the relay or Composio failing around it. */
class ToolAnswerError extends Error {}

/** Whether a Gmail tool's own error says the message asked for is missing, while naming no account, connection, token,
 * permission or tool. */
export function messageGone(toolError: string): boolean {
  if (OTHER_SUBJECT.test(toolError)) return false;
  return GOOGLE_NOT_FOUND.test(toolError) || (MESSAGE_WORD.test(toolError) && MISSING_WORD.test(toolError));
}

async function inParallel<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await run(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** One tool's `data` from a tools/call answer, multi-execute or direct. Anything else throws. */
export function toolData(slug: string, frame: Record<string, unknown> | null): unknown {
  if (!frame) throw new Error(`${slug}: no answer`);
  const rpcError = record(frame.error)?.message;
  if (typeof rpcError === "string") throw new Error(rpcError.slice(0, 300));
  const result = record(frame.result);
  const parts = Array.isArray(result?.content) ? result.content : [];
  const text = parts.map(record).find((part) => typeof part?.text === "string")?.text as string | undefined;
  if (result?.isError === true) throw new Error(text?.slice(0, 300) || `${slug} failed`);
  if (text === undefined) throw new Error(`${slug}: the answer had no text`);
  let body: Record<string, unknown> | undefined;
  try {
    body = record(JSON.parse(text));
  } catch {
    throw new Error(`${slug}: the answer was not JSON`);
  }
  if (!body) throw new Error(`${slug}: the answer was not an object`);
  if (body.successful === false) throw new Error(String(body.error ?? `${slug} failed`).slice(0, 300));
  const results = record(body.data)?.results;
  if (Array.isArray(results)) {
    const response = record(results.map(record).find((item) => item?.tool_slug === slug)?.response);
    if (!response) throw new Error(`${slug}: missing from the answer`);
    if (response.successful === false) throw new ToolAnswerError(String(response.error ?? `${slug} failed`).slice(0, 300));
    if (!("data" in response)) throw new Error(`${slug}: the answer had no data`);
    return response.data;
  }
  if (!("data" in body)) throw new Error(`${slug}: the answer had no data`);
  return body.data;
}

function listIn(data: unknown, keys: readonly string[]): unknown[] | null {
  if (Array.isArray(data)) return data;
  for (const body of [record(data), record(record(data)?.response_data)]) {
    for (const key of keys) if (Array.isArray(body?.[key])) return body[key] as unknown[];
  }
  return null;
}

function headerValue(item: Record<string, unknown>, name: string): string | undefined {
  const headers = record(item.payload)?.headers;
  const value = (Array.isArray(headers) ? headers : []).map(record).find((header) => typeof header?.name === "string" && header.name.toLowerCase() === name)?.value;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function sentAt(item: Record<string, unknown>): number {
  const at = typeof item.messageTimestamp === "string" ? Date.parse(item.messageTimestamp)
    : typeof item.internalDate === "string" || typeof item.internalDate === "number" ? Number(item.internalDate) : Number.NaN;
  return Number.isFinite(at) ? at : 0;
}

function senderOf(item: Record<string, unknown>): string {
  return flat(item.sender ?? item.from ?? headerValue(item, "from"));
}

function oneLine(value: unknown, max: number): string {
  return Array.from(flat(typeof value === "string" ? value.replace(/[^\P{C}\s]/gu, "") : "")).slice(0, max).join("").trim();
}

function addressIn(sender: string): string {
  const candidate = (/<([^<>\s]+)>/.exec(sender)?.[1] ?? sender).trim().toLowerCase();
  return ADDRESS.test(candidate) ? candidate : "";
}

function calendarEvent(raw: unknown, calendar: { id: string; owned: boolean }): CalendarEvent | null {
  const item = record(raw);
  if (!item || typeof item.id !== "string" || !item.id) return null;
  const start = record(item.start);
  const end = record(item.end);
  const allDay = typeof start?.date === "string" && typeof start?.dateTime !== "string";
  const startMs = Date.parse(String(start?.dateTime ?? start?.date ?? ""));
  if (!Number.isFinite(startMs)) return null;
  const endMs = Date.parse(String(end?.dateTime ?? end?.date ?? ""));
  const attendees = (Array.isArray(item.attendees) ? item.attendees : []).flatMap((rawAttendee) => {
    const attendee = record(rawAttendee);
    if (!attendee || typeof attendee.email !== "string" || attendee.resource === true) return [];
    return [{
      email: attendee.email.trim().toLowerCase(),
      ...(typeof attendee.displayName === "string" && attendee.displayName.trim() ? { name: flat(attendee.displayName) } : {}),
      self: attendee.self === true,
      organizer: attendee.organizer === true,
      ...(typeof attendee.responseStatus === "string" ? { response: attendee.responseStatus } : {}),
    }];
  });
  const video = (Array.isArray(record(item.conferenceData)?.entryPoints) ? record(item.conferenceData)!.entryPoints as unknown[] : [])
    .map(record).find((entry) => entry?.entryPointType === "video" && typeof entry.uri === "string")?.uri;
  const location = typeof item.location === "string" && item.location.trim() ? item.location.trim() : undefined;
  const original = record(item.originalStartTime);
  const originalStart = Date.parse(String(original?.dateTime ?? original?.date ?? ""));
  const organizer = record(item.organizer)?.email;
  const joinUrl = [item.hangoutLink, video, location].find((value): value is string => typeof value === "string" && /^https:\/\/\S+$/i.test(value.trim()));
  return {
    id: item.id,
    title: flat(item.summary) || "Untitled meeting",
    start: startMs,
    end: Number.isFinite(endMs) ? endMs : startMs,
    allDay,
    status: item.status === "cancelled" || item.status === "tentative" ? item.status : "confirmed",
    selfDeclined: attendees.some((attendee) => attendee.self && attendee.response === "declined"),
    attendees,
    ...(typeof item.recurringEventId === "string" ? { seriesId: item.recurringEventId } : {}),
    ...(joinUrl ? { joinUrl: joinUrl.trim() } : {}),
    ...(location ? { location } : {}),
    ...(typeof item.description === "string" && item.description.trim() ? { description: item.description } : {}),
    calendarId: calendar.id,
    ownedCalendar: calendar.owned,
    ...(typeof item.iCalUID === "string" && item.iCalUID ? { iCalUID: item.iCalUID } : {}),
    ...(Number.isFinite(originalStart) ? { originalStart } : {}),
    ...(typeof organizer === "string" && organizer.trim() ? { organizer: organizer.trim().toLowerCase() } : {}),
  };
}

export function eventsFromData(data: unknown, calendar: { id: string; owned: boolean }): CalendarEvent[] {
  const list = listIn(data, ["items", "events"]);
  if (!list) throw new Error("the calendar answer had no event list");
  let cancelledDropped = 0;
  const events = list.flatMap((raw) => {
    const event = calendarEvent(raw, calendar);
    if (!event && record(raw)?.status === "cancelled") cancelledDropped += 1;
    return event ? [event] : [];
  });
  if (list.length > cancelledDropped && events.length === 0) throw new Error("none of the calendar events could be read");
  return events;
}

function messageId(item: Record<string, unknown> | undefined): string | undefined {
  const id = item?.messageId ?? item?.id;
  return typeof id === "string" && id ? id : undefined;
}

function emailHeader(raw: unknown): EmailHeader | null {
  const item = record(raw);
  const id = messageId(item);
  if (!item || !id) return null;
  const preview = record(item.preview);
  return {
    id,
    threadId: typeof item.threadId === "string" && item.threadId ? item.threadId : id,
    at: sentAt(item),
    from: senderOf(item),
    subject: flat(item.subject ?? preview?.subject ?? headerValue(item, "subject")),
    preview: flat(preview?.body ?? item.snippet ?? item.messageText).slice(0, PREVIEW_MAX),
  };
}

export function emailsFromData(data: unknown): EmailHeader[] {
  const list = listIn(data, ["messages"]);
  if (!list) throw new Error("the Gmail answer had no message list");
  const headers = list.flatMap((raw) => emailHeader(raw) ?? []);
  if (list.length > 0 && headers.length === 0) throw new Error("none of the Gmail messages could be read");
  return headers;
}

/** Gmail's page token for more messages, or undefined on the last page. */
export function nextPageOf(data: unknown): string | undefined {
  const token = [record(data), record(record(data)?.response_data)].map((body) => body?.nextPageToken).find((value) => typeof value === "string" && value);
  return typeof token === "string" ? token : undefined;
}

export function messageFromData(data: unknown): EmailHeader {
  const top = record(data);
  const header = emailHeader(record(top?.message) ?? record(top?.response_data) ?? top);
  if (!header) throw new Error("the Gmail message could not be read");
  return header;
}

export function threadFromData(data: unknown): ThreadMessage[] {
  const list = listIn(data, ["messages"]);
  if (!list) throw new Error("the Gmail thread had no message list");
  const messages = list.flatMap((raw): ThreadMessage[] => {
    const item = record(raw);
    const id = messageId(item);
    return item && id ? [{ id, at: sentAt(item), from: addressIn(senderOf(item)) }] : [];
  });
  if (list.length > 0 && messages.length === 0) throw new Error("none of the thread's messages could be read");
  return messages;
}

export function profileFromData(data: unknown): string {
  const address = [record(data), record(record(data)?.response_data)].map((body) => body?.emailAddress).find((value) => typeof value === "string");
  const normalised = typeof address === "string" ? address.trim().toLowerCase() : "";
  if (!ADDRESS.test(normalised)) throw new Error("the Gmail profile had no address");
  return normalised;
}

// Google Calendar's access role for a calendar shared as free/busy only: its events carry no details to read.
const FREE_BUSY_ONLY = "freeBusyReader";

export function calendarsFromData(data: unknown): Array<{ id: string; name: string; primary: boolean; owned: boolean; read: boolean }> {
  const list = listIn(data, ["items", "calendars"]);
  if (!list) throw new Error("the answer had no calendar list");
  const calendars = list.flatMap((raw) => {
    const item = record(raw);
    if (!item || typeof item.id !== "string" || !item.id) return [];
    const primary = item.primary === true;
    return [{
      id: item.id, name: oneLine(item.summary, CALENDAR_NAME_MAX) || item.id, primary,
      owned: primary || item.accessRole === "owner", read: primary || (item.selected === true && item.hidden !== true && item.accessRole !== FREE_BUSY_ONLY),
    }];
  });
  if (list.length > 0 && calendars.length === 0) throw new Error("none of the calendars could be read");
  return calendars;
}

export const READ_TIMEOUT_MS = 60_000;

export interface ConnectedReadDeps {
  /** Null when connected apps are not set up here; else which of the two apps are connected. */
  connected(): Promise<Record<ReadApp, boolean> | null>;
  relay(payload: unknown, transportSessionId: string | undefined, signal: AbortSignal): Promise<{ status: number; bytes: Uint8Array; transportSessionId?: string }>;
  readTimeoutMs?: number;
}

/** The reads one check makes, over one connected-apps session. */
export interface ReadSession {
  events(fromMs: number, toMs: number): Promise<CalendarEvent[]>;
  /** Inbox mail since `sinceMs`, newest first, at most `limit`; `more` when there was more than that. */
  emails(sinceMs: number, limit: number): Promise<{ emails: EmailHeader[]; more: boolean }>;
  /** Null only when Gmail says the message is gone. */
  message(messageId: string): Promise<EmailHeader | null>;
  thread(threadId: string): Promise<ThreadMessage[]>;
  /** The connected Gmail account's own address. */
  address(): Promise<string>;
}

export interface ConnectedReads {
  connected(): Promise<Record<ReadApp, boolean> | null>;
  session(): ReadSession;
}

const GMAIL_PAGE = 50;
const GMAIL_PAGES = 6;

const appOf = (slug: string): ReadApp => (slug.startsWith("GMAIL_") ? "gmail" : "googlecalendar");

export function createConnectedReads(deps: ConnectedReadDeps): ConnectedReads {
  const readTimeoutMs = deps.readTimeoutMs ?? READ_TIMEOUT_MS;

  function session(): ReadSession {
    let opened: Promise<string | undefined> | undefined;

    async function open(signal: AbortSignal): Promise<string | undefined> {
      const init = await deps.relay({
        jsonrpc: "2.0", id: "omb-check-init", method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "openmausbot-checks", version: "1" } },
      }, undefined, signal);
      if (init.status !== 200) throw new Error(`connected apps answered HTTP ${init.status}`);
      // Streamable-HTTP MCP servers expect the initialized notification before the first request.
      await deps.relay({ jsonrpc: "2.0", method: "notifications/initialized" }, init.transportSessionId, signal).catch(() => undefined);
      return init.transportSessionId;
    }

    /** One tool's data, or GONE when `gone` says the tool's own failure means the thing asked for is missing. */
    async function call(slug: string, args: Record<string, unknown>, options: { signal?: AbortSignal; gone?: (toolError: string) => boolean } = {}): Promise<unknown> {
      const { gone, signal = AbortSignal.timeout(readTimeoutMs) } = options;
      const app = appOf(slug);
      try {
        signal.throwIfAborted();
        opened ??= open(signal).catch((error: unknown) => {
          opened = undefined;
          throw error;
        });
        const transport = await opened;
        const answer = await deps.relay({
          jsonrpc: "2.0", id: CALL_ID, method: "tools/call",
          params: { name: MULTI_EXECUTE, arguments: { tools: [{ tool_slug: slug, arguments: args }] } },
        }, transport, signal);
        if (answer.status !== 200) throw new Error(`${slug} answered HTTP ${answer.status}`);
        return toolData(slug, parseMcpResponse(new TextDecoder().decode(answer.bytes), CALL_ID));
      } catch (error) {
        if (error instanceof SourceError) throw error;
        if (gone && error instanceof ToolAnswerError && gone(error.message)) return GONE;
        if (signal.aborted) throw new SourceError(app, `${slug} did not answer within ${Math.round(readTimeoutMs / 1000)} seconds`);
        throw new SourceError(app, errorText(error));
      }
    }

    function parsed<T>(app: ReadApp, parse: () => T): T {
      try {
        return parse();
      } catch (error) {
        throw new SourceError(app, errorText(error));
      }
    }

    function requireFinite(app: ReadApp, ...times: number[]): void {
      if (times.some((time) => !Number.isFinite(time))) throw new SourceError(app, "the time window was not a finite time");
    }

    async function calendars(signal?: AbortSignal): Promise<ReturnType<typeof calendarsFromData>> {
      const data = await call(CALENDARS_TOOL, {}, signal ? { signal } : {});
      return parsed("googlecalendar", () => calendarsFromData(data));
    }

    return {
      async events(fromMs, toMs) {
        requireFinite("googlecalendar", fromMs, toMs);
        const failed = new AbortController();
        const signal = AbortSignal.any([AbortSignal.timeout(readTimeoutMs), failed.signal]);
        const listed = await calendars(signal);
        const read = [...(listed.some((calendar) => calendar.primary) ? [] : [PRIMARY_CALENDAR]), ...listed.filter((calendar) => calendar.read)];
        const perCalendar = await inParallel(read, CALENDAR_READS_AT_ONCE, async (calendar) => {
          try {
            const data = await call(CALENDAR_LIST_TOOL, {
              calendarId: calendar.id, timeMin: new Date(fromMs).toISOString(), timeMax: new Date(toMs).toISOString(),
              singleEvents: true, orderBy: "startTime", maxResults: 100, showDeleted: true,
            }, { signal });
            return eventsFromData(data, { id: calendar.id, owned: calendar.owned });
          } catch (error) {
            failed.abort();
            throw new SourceError("googlecalendar", `calendar ${calendar.name}: ${errorText(error)}`);
          }
        });
        return perCalendar.flat();
      },
      async emails(sinceMs, limit) {
        requireFinite("gmail", sinceMs);
        const found: EmailHeader[] = [];
        let page: string | undefined;
        for (let index = 0; index < GMAIL_PAGES; index++) {
          const data = await call(GMAIL_FETCH_TOOL, {
            user_id: "me", query: `in:inbox after:${seconds(sinceMs)} -category:promotions -category:social`,
            max_results: GMAIL_PAGE, include_payload: false, verbose: false, ...(page ? { page_token: page } : {}),
          });
          found.push(...parsed("gmail", () => emailsFromData(data)));
          page = nextPageOf(data);
          if (!page) break;
        }
        const newest = [...new Map(found.map((email) => [email.id, email])).values()].sort((a, b) => b.at - a.at);
        return { emails: newest.slice(0, limit), more: newest.length > limit || page !== undefined };
      },
      async message(id) {
        const data = await call(GMAIL_MESSAGE_TOOL, { user_id: "me", message_id: id, format: "metadata" }, { gone: messageGone });
        return data === GONE ? null : parsed("gmail", () => messageFromData(data));
      },
      async thread(threadId) {
        const data = await call(GMAIL_THREAD_TOOL, { user_id: "me", thread_id: threadId });
        return parsed("gmail", () => threadFromData(data));
      },
      async address() {
        const data = await call(GMAIL_PROFILE_TOOL, { user_id: "me" });
        return parsed("gmail", () => profileFromData(data));
      },
    };
  }

  return { connected: () => deps.connected(), session };
}
