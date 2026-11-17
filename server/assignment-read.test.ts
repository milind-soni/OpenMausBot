import { describe, expect, it } from "vitest";

import { assignmentReadRefusal, type AssignmentReadPlace } from "./assignment-read.ts";

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
