import { describe, expect, it } from "vitest";
import { autoVerdict } from "./auto-approve.ts";
import { createRoomTurnLevels } from "./room-turn-level.ts";

// An ACP engine (Antigravity, Gemini) leaves every permission request to the
// app, with `execute` mapped to the "shell" tool. The verdict must follow the
// level the room turn was sent with, not the bot's own.
const own = () => "ask" as const;

describe("room turn level", () => {
  it("auto-approves a request from a room turn a Chief ran on Full access", () => {
    const levels = createRoomTurnLevels();
    levels.dispatched("room-1", "dev", "full");
    expect(autoVerdict(levels.forRequest("room-1", "dev", own), "shell")).toEqual({ approve: "approved shell (full access)", source: "full-access" });
  });

  it("still asks on a room turn sent on Ask", () => {
    const levels = createRoomTurnLevels();
    levels.dispatched("room-1", "dev", "ask");
    expect(autoVerdict(levels.forRequest("room-1", "dev", own), "shell")).toEqual({ approve: null, source: "no-grant" });
  });

  it("goes back to the bot's own level when the turn ends, and only for that bot and room", () => {
    const levels = createRoomTurnLevels();
    const release = levels.dispatched("room-1", "dev", "full");
    expect(levels.forRequest("room-2", "dev", own)).toBe("ask");
    expect(levels.forRequest("room-1", "ops", own)).toBe("ask");
    release();
    expect(levels.forRequest("room-1", "dev", own)).toBe("ask");
  });

  it("keeps a newer turn's level when an older turn ends late", () => {
    const levels = createRoomTurnLevels();
    const releaseOld = levels.dispatched("room-1", "dev", "ask");
    levels.dispatched("room-1", "dev", "full");
    releaseOld();
    expect(levels.forRequest("room-1", "dev", own)).toBe("full");
  });
});
