import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  calendarsFromData, createConnectedReads, emailsFromData, eventsFromData, messageFromData, profileFromData, SourceError, threadFromData, toolData,
} from "./connected-reads.ts";

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./testing/fixtures/${name}.json`, import.meta.url), "utf8"));

/** One relay that answers like Composio's multi-execute tool, from `answers` by tool slug. */
function relay(answers: Record<string, (args: Record<string, unknown>) => { successful: boolean; data?: unknown; error?: string }>) {
  const frames: Array<{ method: string; session?: string; slug?: string; args?: Record<string, unknown>; item?: Record<string, unknown> }> = [];
  let sessions = 0;
  const deps = {
    connected: async () => ({ gmail: true, googlecalendar: true }),
    relay: async (payload: unknown, session: string | undefined) => {
      const frame = payload as { method: string; params?: { arguments?: { tools?: Array<Record<string, unknown>> } } };
      const item = frame.params?.arguments?.tools?.[0];
      frames.push({ method: frame.method, ...(session ? { session } : {}), ...(item ? { slug: String(item.tool_slug), args: item.arguments as Record<string, unknown>, item } : {}) });
      if (frame.method === "initialize") return { status: 200, bytes: new TextEncoder().encode("{}"), transportSessionId: `s-${++sessions}` };
      if (frame.method !== "tools/call") return { status: 202, bytes: new Uint8Array() };
      const response = answers[String(item!.tool_slug)]!(item!.arguments as Record<string, unknown>);
      const text = JSON.stringify({ successful: true, data: { results: [{ tool_slug: item!.tool_slug, response }] } });
      return { status: 200, bytes: new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id: "omb-check-call", result: { content: [{ type: "text", text }] } })) };
    },
  };
  return { deps, frames };
}

describe("reading Composio's answers", () => {
  it("reads events, skipping resources and id-less entries, with https join links only", () => {
    const events = eventsFromData(fixture("composio-calendar-events"), { id: "primary", owned: true });
    expect(events.map((event) => [event.id, event.status])).toEqual([["demo-1", "confirmed"], ["weekly-2_20261017", "confirmed"], ["holiday", "confirmed"], ["gone", "cancelled"]]);
    expect(events[0]).toMatchObject({ title: "Supamaus demo with Jake", joinUrl: "https://meet.google.com/abc-defg-hij", ownedCalendar: true });
    expect(events[0]!.attendees.map((one) => one.email)).toEqual(["me@example.test", "jake@pin.example"]);
    expect(events[1]).toMatchObject({ seriesId: "weekly-2", selfDeclined: true, joinUrl: "https://zoom.us/j/1" });
    expect(events[2]).toMatchObject({ allDay: true });
  });

  it("reads mail headers, profiles, single messages, threads and the calendar list", () => {
    const emails = emailsFromData(fixture("composio-gmail-fetch"));
    expect(emails.map((email) => [email.id, email.threadId, email.from, email.subject])).toEqual([
      ["important-1", "thread-important", "Ada <ada@example.test>", "Q3 numbers due Friday"],
      ["newsletter-1", "thread-news", "News <news@example.test>", "This week in tech"],
    ]);
    expect(emails[0]!.preview).toBe("Can you send the Q3 numbers by Friday? Thanks");
    expect(profileFromData(fixture("composio-gmail-profile"))).toBe("admin@example.test");
    expect(messageFromData(fixture("composio-gmail-message"))).toMatchObject({ id: "m-1", threadId: "t-1", subject: "Q3 numbers" });
    expect(threadFromData(fixture("composio-gmail-thread")).map((message) => message.from)).toEqual(["ada@pin.example", "omkar@example.test"]);
    expect(calendarsFromData(fixture("composio-calendar-list")).filter((calendar) => calendar.read).map((calendar) => calendar.id))
      .toEqual(["admin@example.test", "team@group.calendar.google.com", "ada@example.test"]);
  });

  it("an answer of another shape is an error, never an empty list", () => {
    expect(() => emailsFromData({ items: [] })).toThrow("no message list");
    expect(() => eventsFromData({ messages: [] }, { id: "primary", owned: true })).toThrow("no event list");
    expect(() => emailsFromData({ messages: [{ subject: "no id" }] })).toThrow("none of the Gmail messages could be read");
    expect(() => toolData("GMAIL_FETCH_EMAILS", { result: { content: [{ type: "text", text: "<html>" }] } })).toThrow("not JSON");
    expect(emailsFromData({ messages: [] })).toEqual([]);
  });
});

describe("a check's reads", () => {
  it("share one connected-apps session, page through mail newest first, and never name an account", async () => {
    const pages: Record<string, unknown> = {
      first: { messages: [{ messageId: "a", threadId: "ta", messageTimestamp: "2026-10-22T08:00:00Z", sender: "A <a@x.test>", subject: "A" }], nextPageToken: "p2" },
      p2: { messages: [{ messageId: "b", threadId: "tb", messageTimestamp: "2026-10-22T09:00:00Z", sender: "B <b@x.test>", subject: "B" }] },
    };
    const { deps, frames } = relay({
      GMAIL_FETCH_EMAILS: (args) => ({ successful: true, data: pages[String(args.page_token ?? "first")] }),
      GMAIL_GET_PROFILE: () => ({ successful: true, data: { emailAddress: "Me@X.test" } }),
    });
    const session = createConnectedReads(deps).session();
    expect(await session.address()).toBe("me@x.test");
    const read = await session.emails(Date.parse("2026-10-22T00:00:00Z"), 10);
    expect(read).toMatchObject({ more: false });
    expect(read.emails.map((email) => email.id)).toEqual(["b", "a"]);
    expect(frames.filter((frame) => frame.method === "initialize")).toHaveLength(1);
    expect(new Set(frames.filter((frame) => frame.method === "tools/call").map((frame) => frame.session))).toEqual(new Set(["s-1"]));
    for (const frame of frames.filter((one) => one.item)) expect(Object.keys(frame.item!).sort()).toEqual(["arguments", "tool_slug"]);
    expect(frames.find((frame) => frame.slug === "GMAIL_FETCH_EMAILS")!.args!.query).toContain("in:inbox after:");
  });

  it("says more mail waits beyond the limit", async () => {
    const messages = Array.from({ length: 5 }, (_, index) => ({ messageId: `m${index}`, threadId: `t${index}`, messageTimestamp: `2026-10-22T0${index}:00:00Z`, sender: "x@y.test", subject: "s" }));
    const { deps } = relay({ GMAIL_FETCH_EMAILS: () => ({ successful: true, data: { messages } }) });
    const read = await createConnectedReads(deps).session().emails(0, 3);
    expect(read.more).toBe(true);
    expect(read.emails.map((email) => email.id)).toEqual(["m4", "m3", "m2"]);
  });

  it("names the app that failed, and whether reconnecting fixes it", async () => {
    const { deps } = relay({
      GMAIL_FETCH_EMAILS: () => ({ successful: false, error: "Connected account is not ACTIVE: token expired" }),
      GOOGLECALENDAR_LIST_CALENDARS: () => ({ successful: false, error: "Backend error 500" }),
    });
    const session = createConnectedReads(deps).session();
    const mail = await session.emails(0, 5).catch((error: unknown) => error);
    expect(mail).toBeInstanceOf(SourceError);
    expect(mail).toMatchObject({ app: "gmail", signedOut: true });
    const calendar = await session.events(0, 1).catch((error: unknown) => error);
    expect(calendar).toMatchObject({ app: "googlecalendar", signedOut: false });
  });
});
