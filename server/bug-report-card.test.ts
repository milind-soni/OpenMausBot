import { describe, expect, it, vi } from "vitest";

import { bugReportDraftText } from "../shared/bug-report.ts";
import { settleBugReport, type BugReportSettleDeps } from "./bug-report-card.ts";
import { createAgentCard, type AgentCardStore } from "./chat-widgets.ts";
import { answeredCardResume, openCardWaits, stoppedCardPatch } from "./parked-cards.ts";
import type { MausColor } from "../shared/wire.ts";
import type { Message } from "./store.ts";

const THREAD = "thread-scout";
const ROOM = "thread-room";
const SCOUT: { id: string; name: string; color: MausColor } = { id: "bot-scout", name: "Scout", color: "blue" };
const PIPER: { id: string; name: string; color: MausColor } = { id: "bot-piper", name: "Piper", color: "green" };
// A shape shared/redact.ts recognises.
const API_KEY = "sk-ant-api03-abcdefghijklmnopqrstuvwx";

function fakeStore() {
  const threads = new Map<string, Message[]>();
  const rows = (threadId: string) => threads.get(threadId) ?? threads.set(threadId, []).get(threadId)!;
  let next = 1;
  const patchMessage = vi.fn((threadId: string, messageId: string, patch: Partial<Message>): Message | null => {
    const list = rows(threadId);
    const index = list.findIndex((message) => message.id === messageId);
    if (index === -1) return null;
    list[index] = { ...list[index]!, ...patch };
    return list[index]!;
  });
  const store: AgentCardStore & BugReportSettleDeps["store"] = {
    groupByThread: (threadId) => (threadId === ROOM ? { id: "room-1" } : undefined),
    messagesFor: rows,
    activePath: rows,
    appendMessage: (threadId, message) => {
      const full: Message = { ...message, id: `m${next++}`, at: 1 };
      rows(threadId).push(full);
      return full;
    },
    patchMessage,
  };
  return { store, rows, patchMessage };
}

type Fake = ReturnType<typeof fakeStore>;

const draft = (fake: Fake, input: Record<string, unknown>, { bot = SCOUT, threadId = THREAD, guest = false } = {}) =>
  createAgentCard({ store: fake.store, bot, threadId, guest, input: { tool: "draft_bug_report", ...input } });

const card = (fake: Fake, id: string, threadId = THREAD) => fake.rows(threadId).find((message) => message.id === id)!;

describe("draft_bug_report", () => {
  it("posts a bugreport card with its readable fallback and no from in a direct thread", () => {
    const fake = fakeStore();
    const authored = vi.fn();
    const result = createAgentCard({
      store: fake.store, bot: SCOUT, threadId: THREAD, authored,
      input: { tool: "draft_bug_report", summary: "  Team   tools did not\nconnect ", details: " coordinate_bots failed with ECONNREFUSED. " },
    });
    expect(result).toEqual({ ok: true, messageId: "m1" });
    expect(card(fake, "m1")).toEqual({
      id: "m1", at: 1, role: "bot", kind: "bugreport",
      text: "Scout drafted a bug report for the OpenMausBot team: “Team tools did not connect”. Open this conversation in the OpenMausBot desktop app to review and send it.",
      bugReport: { summary: "Team tools did not connect", details: "coordinate_bots failed with ECONNREFUSED." },
    });
    expect(authored).toHaveBeenCalledExactlyOnceWith("m1");
  });

  it("masks secrets before anything is stored, and clips each field to its limit", () => {
    const fake = fakeStore();
    draft(fake, { summary: `Sign-in loops with key ${API_KEY}`, details: `token=${API_KEY} ${"x".repeat(9_000)}` });
    const stored = JSON.stringify(card(fake, "m1"));
    expect(stored).not.toContain(API_KEY);
    expect(card(fake, "m1").bugReport!.details.length).toBe(8_000);
    expect(bugReportDraftText(card(fake, "m1").bugReport!).length).toBeLessThanOrEqual(10_000);
  });

  it("names the bot in a room, and supersedes only that bot's own open drafts", () => {
    const fake = fakeStore();
    draft(fake, { summary: "First", details: "" }, { threadId: ROOM });
    draft(fake, { summary: "Piper's", details: "" }, { threadId: ROOM, bot: PIPER });
    draft(fake, { summary: "Second", details: "" }, { threadId: ROOM });
    expect(card(fake, "m3", ROOM).from).toEqual({ botId: SCOUT.id, name: "Scout", color: "blue" });
    expect(card(fake, "m1", ROOM).bugReport!.superseded).toBe(true);
    expect(card(fake, "m2", ROOM).bugReport!.superseded).toBeUndefined();
    expect(card(fake, "m3", ROOM).bugReport!.superseded).toBeUndefined();
  });

  it("refuses a guest's turn and an empty summary, and stores nothing", () => {
    const fake = fakeStore();
    expect(draft(fake, { summary: "Broken", details: "" }, { guest: true })).toMatchObject({ ok: false, status: 403 });
    expect(draft(fake, { summary: "   ", details: "Something" })).toEqual({ ok: false, status: 400, error: "summary: one line on what failed in OpenMausBot." });
    expect(fake.rows(THREAD)).toEqual([]);
  });
});

describe("settling a draft", () => {
  function settled(fake: Fake, { resumes = true, owner = { group: undefined as unknown } as { group?: unknown } | null } = {}) {
    const resume = vi.fn((_threadId: string, _messageId: string, _text: string) => resumes);
    const deps: BugReportSettleDeps = { store: fake.store, ownerOf: () => owner, resume };
    return { deps, resume };
  }

  it("records Send with the report id and resumes the bot with what happened", () => {
    const fake = fakeStore();
    draft(fake, { summary: "Broken", details: "" });
    const { deps, resume } = settled(fake);
    expect(settleBugReport(deps, SCOUT.id, THREAD, "m1", "sent", "br_42")).toEqual({ status: 200, body: { sent: true, resumed: true } });
    expect(resume).toHaveBeenCalledExactlyOnceWith(THREAD, "m1", expect.stringContaining("the person sent your bug report to the OpenMausBot team (report br_42)"));
    expect(card(fake, "m1").bugReport).toEqual({ summary: "Broken", details: "", sent: true, reportId: "br_42", resumed: true });
  });

  it("records Dismiss, and keeps an answer whose turn is not parked yet for the park to pick up", () => {
    const fake = fakeStore();
    draft(fake, { summary: "Broken", details: "" });
    const { deps, resume } = settled(fake, { resumes: false });
    expect(settleBugReport(deps, SCOUT.id, THREAD, "m1", "dismissed")).toEqual({ status: 200, body: { dismissed: true, resumed: false } });
    expect(resume.mock.calls[0]![2]).toContain("the person dismissed your bug report draft, so nothing was sent");
    expect(card(fake, "m1").bugReport).toEqual({ summary: "Broken", details: "", dismissed: true });
    expect(answeredCardResume(card(fake, "m1"))).toEqual({
      text: expect.stringContaining("dismissed your bug report draft"),
      patch: { bugReport: { summary: "Broken", details: "", dismissed: true, resumed: true } },
    });
  });

  it("answers a repeat idempotently, and refuses the other outcome, a superseded draft and an unknown id", () => {
    const fake = fakeStore();
    draft(fake, { summary: "Old", details: "" });
    draft(fake, { summary: "New", details: "" });
    const { deps } = settled(fake);
    expect(settleBugReport(deps, SCOUT.id, THREAD, "m1", "sent")).toEqual({ status: 409, body: { error: "this bug report draft was replaced by a newer one" } });
    expect(settleBugReport(deps, SCOUT.id, THREAD, "m2", "sent", "br_1").status).toBe(200);
    expect(settleBugReport(deps, SCOUT.id, THREAD, "m2", "sent")).toEqual({ status: 200, body: { sent: true, resumed: true } });
    expect(settleBugReport(deps, SCOUT.id, THREAD, "m2", "dismissed")).toEqual({ status: 409, body: { error: "this bug report draft was already sent" } });
    expect(settleBugReport(deps, SCOUT.id, THREAD, "nope", "sent").status).toBe(404);
  });

  it("finds a room card only under its own bot, and nothing in a conversation that is not the bot's", () => {
    const fake = fakeStore();
    draft(fake, { summary: "Broken", details: "" }, { threadId: ROOM });
    expect(settleBugReport(settled(fake, { owner: { group: { id: "room-1" } } }).deps, PIPER.id, ROOM, "m1", "sent").status).toBe(404);
    expect(settleBugReport(settled(fake, { owner: null }).deps, SCOUT.id, ROOM, "m1", "sent").status).toBe(404);
    expect(card(fake, "m1", ROOM).bugReport!.sent).toBeUndefined();
  });

  it("keeps only a well-formed report id", () => {
    const fake = fakeStore();
    draft(fake, { summary: "Broken", details: "" });
    settleBugReport(settled(fake).deps, SCOUT.id, THREAD, "m1", "sent", "<script>");
    expect(card(fake, "m1").bugReport).not.toHaveProperty("reportId");
  });
});

describe("a draft parks the turn", () => {
  it("waits on an open draft, resumes once answered, and is marked stopped by Stop", () => {
    const fake = fakeStore();
    draft(fake, { summary: "Broken", details: "" });
    expect(openCardWaits(fake.rows(THREAD))).toEqual([{ id: "m1", waits: "review a bug report draft" }]);
    expect(answeredCardResume(card(fake, "m1"))).toBeNull();
    expect(stoppedCardPatch(card(fake, "m1"))).toEqual({ bugReport: { summary: "Broken", details: "", stopped: true } });
    settleBugReport({ store: fake.store, ownerOf: () => ({}), resume: () => true }, SCOUT.id, THREAD, "m1", "sent", "br_9");
    expect(openCardWaits(fake.rows(THREAD))).toEqual([]);
    expect(answeredCardResume(card(fake, "m1"))).toEqual({ text: expect.stringContaining("(report br_9)"), patch: null });
  });
});
