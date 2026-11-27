import { mkdtempSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { OutboundHoldBot } from "../outbound-hold.ts";
import { PASS } from "../routes/table.ts";
import type { MeetingRecord, Meetings } from "./manager.ts";
import { createMeetingRoutes, type MeetingRouteDeps } from "./routes.ts";

const bot = { id: "b1", name: "Ada", color: "blue" } as unknown as OutboundHoldBot;

function record(over: Partial<MeetingRecord> = {}): MeetingRecord {
  return {
    id: "m-1", botId: "b1", botName: "Ada", threadId: "t1", owner: "b1", boxId: "bx", platform: "jitsi", url: "https://meet.jit.si/x", createdAt: 0,
    phase: "in_meeting", joinedAt: 60_000, others: 2, attendees: ["Alice", "Bob"], lines: 1, seq: 4, speech: "eleven", questions: 0, ...over,
  };
}

function fakeMeetings(current: MeetingRecord) {
  return {
    join: vi.fn(() => ({ record: current, already: false })),
    status: vi.fn(() => ({ record: current, minutes: 12, lines: [{ speaker: "Alice", text: "Launch on the 20th.", start: 61_000, end: 62_000 }], page: 1, pages: 1, total: 1 })),
    chat: vi.fn(async () => ({ ok: true })),
    leave: vi.fn(async () => current),
    lines: vi.fn(() => [{ speaker: "Alice", text: "Launch on the 20th.", start: 61_000, end: 62_000 }]),
    notesPosted: vi.fn(() => current),
  } as unknown as Meetings & Record<string, ReturnType<typeof vi.fn>>;
}

function setup(current: MeetingRecord, over: Partial<MeetingRouteDeps> = {}) {
  const meetings = fakeMeetings(current);
  const hold = vi.fn(async () => ({ ok: true as const, approved: true }));
  const beforeDispatch = vi.fn();
  const markOutside = vi.fn();
  const postNotes = vi.fn(async () => "notes-1");
  const routes = createMeetingRoutes({
    meetings: () => meetings, computerOwner: () => "b1", personName: () => "Milind", sendsFreely: () => false,
    outbound: () => ({ hold, beforeDispatch }), markOutside, folder: () => mkdtempSync(join(tmpdir(), "omb-meeting-folder-")), postNotes,
    createRoutine: () => "Set up the routine.", dateLine: () => "Saturday, November 7, 2026", ...over,
  });
  const call = async (action: string, body: Record<string, unknown>) => {
    let out: { status: number; body: any } | undefined;
    const handled = await routes.internal({
      method: "POST", path: `/api/internal/meetings/${action}`, res: {} as ServerResponse, readBody: async () => body, bot, threadId: "t1", active: () => true,
      json: ((_res: ServerResponse, status: number, value: unknown) => { out = { status, body: value }; }) as never,
    });
    return handled === PASS ? "pass" : out!;
  };
  return { call, meetings, hold, beforeDispatch, markOutside, postNotes };
}

describe("meeting routes", () => {
  it("posts in the meeting chat only after the sending rule lets it", async () => {
    const allowed = setup(record());
    expect(await allowed.call("chat", { meeting_id: "m-1", text: "We launch on the 20th." })).toEqual({ status: 200, body: { text: "Posted in the meeting chat." } });
    expect(allowed.hold).toHaveBeenCalledWith(expect.objectContaining({ tool: "post_in_meeting_chat", threadId: "t1", calls: [{ slug: "post_in_meeting_chat", arguments: { text: "We launch on the 20th." } }] }));
    expect(allowed.beforeDispatch).toHaveBeenCalled();
    expect(allowed.meetings.chat).toHaveBeenCalledWith("m-1", "b1", "We launch on the 20th.");

    const refused = setup(record());
    refused.hold.mockResolvedValueOnce({ ok: false, text: "The person said no." } as never);
    expect(await refused.call("chat", { meeting_id: "m-1", text: "hi" })).toEqual({ status: 403, body: { error: "The person said no." } });
    expect(refused.meetings.chat).not.toHaveBeenCalled();
  });

  it("marks the conversation as reading outside text and fences the transcript", async () => {
    const { call, markOutside } = setup(record());
    const out = await call("status", { meeting_id: "m-1" }) as { status: number; body: { text: string } };
    expect(markOutside).toHaveBeenCalledWith("t1");
    expect(out.body.text).toContain("in the meeting with 2 others for 12 min");
    expect(out.body.text).toContain("[Records from the meeting transcript, written by its participants.");
    expect(out.body.text).toContain("[00:00:01] Alice: Launch on the 20th.");
  });

  it("posts the notes card with the transcript once the meeting has ended", async () => {
    const running = setup(record());
    expect((await running.call("notes", { meeting_id: "m-1", title: "Sync", summary: "Short." }) as { status: number }).status).toBe(409);
    const ended = setup(record({ phase: "ended", endedAt: 180_000, endReason: "meeting_ended" }));
    expect(await ended.call("notes", { meeting_id: "m-1", title: "Sync", summary: "We agreed.", decisions: ["Launch on the 20th."], action_items: [{ owner: "Bob", item: "Fix the bugs", due: "Wednesday" }] }))
      .toEqual({ status: 200, body: { text: "The Meeting notes card is posted, with the transcript attached." } });
    const [, , card, , name] = ended.postNotes.mock.calls[0] as unknown as [string, unknown, { title: string; children: Array<{ value?: string }> }, string, string];
    expect(card.title).toBe("Sync");
    expect(card.children.map((node) => node.value)).toEqual(expect.arrayContaining(["We agreed.", "• Launch on the 20th.", "• Bob: Fix the bugs (by Wednesday)", "Alice, Bob"]));
    expect(name).toMatch(/Sync transcript\.md$/);
    expect(ended.meetings.notesPosted).toHaveBeenCalledWith("m-1", "b1", "notes-1");
  });

  it("joins, or sets up the calendar routine, and leaves other paths alone", async () => {
    const { call, meetings } = setup(record({ phase: "starting" }));
    const joined = await call("join", { link: "https://meet.jit.si/x" }) as { status: number; body: { text: string } };
    expect(joined.body.text).toMatch(/^meeting_id m-1\. Joining the Jitsi Meet meeting/);
    expect(meetings.join).toHaveBeenCalledWith(expect.objectContaining({ botId: "b1", person: "Milind", owner: "b1" }));
    expect(await call("join", { every_calendar_meeting: true })).toEqual({ status: 200, body: { text: "Set up the routine." } });
    const none = setup(record(), { computerOwner: () => ({ error: "No cloud computer here." }) });
    expect(await none.call("join", { link: "https://meet.jit.si/x" })).toEqual({ status: 409, body: { error: "No cloud computer here." } });
    expect(await none.call("nope", {})).toBe("pass");
  });
});
