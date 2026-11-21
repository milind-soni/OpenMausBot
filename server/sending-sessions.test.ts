import { describe, expect, it } from "vitest";
import { noteSendingSession, sendingSession } from "./sending-sessions.ts";

describe("the session that sent a line", () => {
  it("is known only for the same thread and sendId", () => {
    noteSendingSession("thread-a", "send-1", "pc-session");
    expect(sendingSession("thread-a", "send-1")).toBe("pc-session");
    expect(sendingSession("thread-a", "send-2")).toBeUndefined();
    expect(sendingSession("thread-b", "send-1")).toBeUndefined();
    expect(sendingSession("thread-a", undefined)).toBeUndefined();
  });

  it("keeps the first session for a line: a later send reusing its sendId does not take it over", () => {
    noteSendingSession("thread-first", "send-1", "pc-session");
    noteSendingSession("thread-first", "send-1", "laptop-session");
    expect(sendingSession("thread-first", "send-1")).toBe("pc-session");
  });

  it("keeps the newest lines and forgets the oldest past its limit", () => {
    noteSendingSession("thread-old", "send-old", "old");
    for (let index = 0; index < 2_000; index++) noteSendingSession("thread-many", `send-${index}`, "pc");
    expect(sendingSession("thread-old", "send-old")).toBeUndefined();
    expect(sendingSession("thread-many", "send-1999")).toBe("pc");
  });
});
