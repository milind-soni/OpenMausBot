import { describe, expect, it } from "vitest";

import type { Message } from "@/state/store";
import { awaitedMemberId, showWorkingDots } from "./turn-tail";

const msg = (m: Partial<Message>): Message => ({ id: "m1", role: "bot", kind: "text", at: 1, ...m });

describe("showWorkingDots", () => {
  it("hides the dots when the bot is idle", () => {
    expect(showWorkingDots(false, msg({ role: "user" }))).toBe(false);
  });

  it("shows the dots while a turn runs with nothing settled yet", () => {
    expect(showWorkingDots(true, undefined)).toBe(true);
    expect(showWorkingDots(true, msg({ role: "user" }))).toBe(true);
    expect(showWorkingDots(true, msg({ kind: "activity" }))).toBe(true);
    expect(showWorkingDots(true, msg({ kind: "options" }))).toBe(true);
  });

  it("keeps the dots hidden after the reply settles, while busy winds down", () => {
    // the end-of-stream window: reply landed, turn.completed + busy:false
    // still in flight — re-showing the dots here is the jitter
    expect(showWorkingDots(true, msg({}))).toBe(false);
  });

  it("rooms: a settled reply only covers the bot that said it", () => {
    const fromA = msg({ from: { botId: "a", name: "A", color: "blue" } });
    expect(showWorkingDots(true, fromA, "a")).toBe(false);
    // the floor moved on — the next speaker's dots are real information
    expect(showWorkingDots(true, fromA, "b")).toBe(true);
    // no attribution (older data) — fail toward showing the indicator
    expect(showWorkingDots(true, msg({}), "a")).toBe(true);
  });
});

describe("awaitedMemberId", () => {
  const waitChip = msg({
    kind: "activity",
    from: { botId: "b", name: "B", color: "blue" },
    tool: { name: "B is finishing another conversation — will reply here when free", spoken: "B is finishing another conversation" },
  });

  it("names the member whose wait chip is the newest thing in a working room with no speaker", () => {
    expect(awaitedMemberId(true, null, waitChip)).toBe("b");
    expect(awaitedMemberId(true, undefined, waitChip)).toBe("b");
  });

  it("stands down once someone has the floor or the room stops working", () => {
    expect(awaitedMemberId(true, "a", waitChip)).toBeUndefined();
    expect(awaitedMemberId(false, null, waitChip)).toBeUndefined();
    expect(awaitedMemberId(undefined, null, waitChip)).toBeUndefined();
  });

  it("ignores a settled chip and any other tail", () => {
    expect(awaitedMemberId(true, null, { ...waitChip, tool: { ...waitChip.tool!, ok: true } })).toBeUndefined();
    expect(awaitedMemberId(true, null, { ...waitChip, tool: { ...waitChip.tool!, ok: false } })).toBeUndefined();
    expect(awaitedMemberId(true, null, msg({ from: { botId: "b", name: "B", color: "blue" } }))).toBeUndefined();
    expect(awaitedMemberId(true, null, msg({ kind: "goal.run" }))).toBeUndefined();
    expect(awaitedMemberId(true, null, undefined)).toBeUndefined();
  });
});
