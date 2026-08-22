import { describe, expect, it } from "vitest";

import type { Message } from "@/state/store";
import { showWorkingDots } from "./turn-tail";

const msg = (m: Partial<Message>): Message => ({ id: "m1", role: "bot", kind: "text", at: 1, ...m });

describe("showWorkingDots", () => {
  it("hides the dots when the bot is idle or a stream is rendering", () => {
    expect(showWorkingDots(false, undefined, msg({ role: "user" }))).toBe(false);
    expect(showWorkingDots(true, "partial reply…", msg({ role: "user" }))).toBe(false);
  });

  it("shows the dots while a turn runs with nothing settled yet", () => {
    expect(showWorkingDots(true, undefined, undefined)).toBe(true);
    expect(showWorkingDots(true, undefined, msg({ role: "user" }))).toBe(true);
    expect(showWorkingDots(true, undefined, msg({ kind: "activity" }))).toBe(true);
    expect(showWorkingDots(true, undefined, msg({ kind: "options" }))).toBe(true);
  });

  it("keeps the dots hidden after the reply settles, while busy winds down", () => {
    // the end-of-stream window: reply landed, turn.completed + busy:false
    // still in flight — re-showing the dots here is the jitter
    expect(showWorkingDots(true, undefined, msg({}))).toBe(false);
  });

  it("rooms: a settled reply only covers the bot that said it", () => {
    const fromA = msg({ from: { botId: "a", name: "A", color: "blue" } });
    expect(showWorkingDots(true, undefined, fromA, "a")).toBe(false);
    // the floor moved on — the next speaker's dots are real information
    expect(showWorkingDots(true, undefined, fromA, "b")).toBe(true);
    // no attribution (older data) — fail toward showing the indicator
    expect(showWorkingDots(true, undefined, msg({}), "a")).toBe(true);
  });
});
