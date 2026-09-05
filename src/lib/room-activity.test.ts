import { describe, expect, it } from "vitest";

import { roomActivityVisible } from "./room-activity";
import type { Message } from "@/state/store";

const chip = (partial: Partial<Message>): Message => ({
  id: "m",
  role: "bot",
  kind: "activity",
  at: 1,
  tool: { name: "Read a file", ok: true },
  ...partial,
});

describe("roomActivityVisible", () => {
  it("hides an ordinary finished step unless tool calls are on", () => {
    expect(roomActivityVisible(chip({}), false)).toBe(false);
    expect(roomActivityVisible(chip({}), true)).toBe(true);
  });

  it("always shows a failure", () => {
    expect(roomActivityVisible(chip({ tool: { name: "Ran a command", ok: false } }), false)).toBe(true);
    expect(roomActivityVisible(chip({ tool: { name: "error: engine missing" } }), false)).toBe(true);
  });

  // the trace that a teammate was consulted must not depend on a developer
  // flag that is off for everyone
  it("always shows a bot-to-bot comm chip", () => {
    const comm = chip({
      tool: { name: "Messaged @Ada" },
      comm: { groupId: "g1", withBotId: "ada", withName: "Ada", withColor: "teal" },
    });
    expect(roomActivityVisible(comm, false)).toBe(true);
  });

  it("is not for text or cards", () => {
    expect(roomActivityVisible(chip({ kind: "text", text: "hi", tool: undefined }), true)).toBe(false);
  });
});
