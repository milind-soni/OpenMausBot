import { describe, expect, it } from "vitest";

import { assignmentReadRefusal, assignmentResultPart, RESULT_PART_CHARS, type AssignmentReadPlace } from "./assignment-read.ts";

// Bot A's own chats: its main chat and a second thread; "room" is a room it sits in; "other-bot" is another bot's chat.
const ownChats = new Set(["main", "second", "guest-chat", "member-b"]);
const place = (over: Partial<AssignmentReadPlace> = {}): AssignmentReadPlace => ({
  ownChat: (threadId) => ownChats.has(threadId),
  guest: (threadId) => threadId === "guest-chat",
  audienceOf: (threadId) => (threadId === "member-b" ? "member:b" : "member:a"),
  ...over,
});

describe("assignmentReadRefusal", () => {
  it("lets the conversation that sent the hand-off read it", () => {
    expect(assignmentReadRefusal("main", "main", place())).toBeNull();
    expect(assignmentReadRefusal("room", "room", place())).toBeNull();
  });

  it("lets another of the same bot's own chats read it", () => {
    expect(assignmentReadRefusal("second", "main", place())).toBeNull();
    expect(assignmentReadRefusal("main", "second", place())).toBeNull();
  });

  it("refuses a hand-off another bot sent or one sent from a room", () => {
    expect(assignmentReadRefusal("main", "other-bot", place())).toMatch(/another bot/);
    expect(assignmentReadRefusal("main", "room", place())).toMatch(/room/);
    expect(assignmentReadRefusal("room", "main", place())).toMatch(/room/);
    expect(assignmentReadRefusal("main", undefined, place())).toMatch(/only the conversation that sent it/);
  });

  it("keeps a guest's chat and the owner's chats apart in both directions", () => {
    expect(assignmentReadRefusal("guest-chat", "main", place())).toMatch(/someone else/);
    expect(assignmentReadRefusal("main", "guest-chat", place())).toMatch(/someone else/);
  });

  it("keeps one team member's chats apart from another's", () => {
    expect(assignmentReadRefusal("member-b", "main", place())).toMatch(/someone else/);
    expect(assignmentReadRefusal("main", "member-b", place())).toMatch(/someone else/);
  });
});

describe("assignmentResultPart", () => {
  const whole = `${"r".repeat(40_000)}US$`;
  const kept = (text: string) => (_id: string, offset: number, limit: number) => ({ text: text.slice(offset, offset + limit), total: whole.length, kept: text.length });

  it("adds nothing to a result its record holds whole, unless asked for a part", () => {
    expect(assignmentResultPart({ id: "a", result: "short" }, null, kept(whole))).toEqual({});
    expect(assignmentResultPart({ id: "a", result: "short" }, "2", kept(whole))).toEqual({ resultChars: 5,
      resultPart: { offset: 2, end: 5, total: 5, text: "ort", truncated: false } });
  });

  it("gives a long result's length, and its parts from the whole text kept beside the record", () => {
    const a = { id: "a", result: whole.slice(0, 12_000), resultChars: whole.length };
    expect(assignmentResultPart(a, null, kept(whole))).toEqual({ resultChars: whole.length });
    const last = assignmentResultPart(a, String(whole.length - 10), kept(whole)).resultPart!;
    expect(last).toEqual({ offset: whole.length - 10, end: whole.length, total: whole.length, text: whole.slice(-10), truncated: false });
    expect(assignmentResultPart(a, "0", kept(whole)).resultPart!.text).toHaveLength(RESULT_PART_CHARS);
  });

  it("marks truncated when less than the whole was kept, or nothing beside the record", () => {
    const a = { id: "a", result: whole.slice(0, 12_000), resultChars: whole.length };
    expect(assignmentResultPart(a, "20000", kept(whole.slice(0, 20_000))).resultPart).toMatchObject({ end: 20_000, text: "", truncated: true });
    expect(assignmentResultPart(a, "12000", () => undefined).resultPart).toMatchObject({ offset: 12_000, end: 12_000, text: "", truncated: true });
  });
});
