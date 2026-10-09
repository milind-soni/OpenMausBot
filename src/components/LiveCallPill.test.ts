import { describe, expect, it } from "vitest";
import { liveBadgeFor } from "./LiveCallPill";
import type { LiveMediaState } from "@/lib/live-call-media";

const idle: LiveMediaState = { phase: "idle", callId: null, botId: null, threadId: null, startedAt: null, muted: false, caption: "", heard: "", notice: null, needsKey: false, needsPro: false, busyWith: null, action: null, hangingUp: false };

describe("liveBadgeFor", () => {
  it("marks the bot this window is calling", () => {
    expect(liveBadgeFor("b1", { ...idle, phase: "live", botId: "b1" }, null)).toBe(true);
    expect(liveBadgeFor("b1", { ...idle, phase: "starting", botId: "b1" }, null)).toBe(true);
    expect(liveBadgeFor("b2", { ...idle, phase: "live", botId: "b1" }, null)).toBe(false);
  });
  it("marks a bot a phone is calling, and clears when the call ends", () => {
    const server = { callId: "c", botId: "b1", threadId: "t1", client: "android", voice: "marin", startedAt: 0, status: "live" } as const;
    expect(liveBadgeFor("b1", idle, server)).toBe(true);
    expect(liveBadgeFor("b1", idle, { ...server, status: "ended" })).toBe(false);
  });
});
