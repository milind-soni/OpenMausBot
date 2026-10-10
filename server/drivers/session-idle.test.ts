import { describe, expect, it } from "vitest";

import { sessionIdlePolicy } from "./session-idle.ts";

describe("sessionIdlePolicy", () => {
  it("defaults to ten minutes with a ten-second floor", () => {
    expect(sessionIdlePolicy("CLAUDE", {})).toEqual({ idleMs: 10 * 60_000, minimumMs: 10_000 });
    expect(sessionIdlePolicy("ACP", {})).toEqual({ idleMs: 10 * 60_000, minimumMs: 10_000 });
  });

  it("honors each harness's own legacy names", () => {
    expect(sessionIdlePolicy("CLAUDE", { OMB_CLAUDE_SESSION_IDLE_MS: "120000" }).idleMs).toBe(120_000);
    expect(sessionIdlePolicy("ACP", { OMB_ACP_SESSION_IDLE_MS: "120000" }).idleMs).toBe(120_000);
    expect(sessionIdlePolicy("CLAUDE", { OMB_CLAUDE_SESSION_IDLE_MIN_MS: "30000" }).minimumMs).toBe(30_000);
    expect(sessionIdlePolicy("ACP", { OMB_ACP_SESSION_IDLE_MIN_MS: "30000" }).minimumMs).toBe(30_000);
  });

  it("lets the unified names set every harness at once, below a per-harness override", () => {
    expect(sessionIdlePolicy("CLAUDE", { OMB_SESSION_IDLE_MS: "90000" }).idleMs).toBe(90_000);
    expect(sessionIdlePolicy("ACP", { OMB_SESSION_IDLE_MS: "90000", OMB_ACP_SESSION_IDLE_MS: "120000" }).idleMs).toBe(120_000);
    expect(sessionIdlePolicy("ACP", { OMB_SESSION_IDLE_MIN_MS: "4000", OMB_ACP_SESSION_IDLE_MIN_MS: "30000" }).minimumMs).toBe(30_000);
    expect(sessionIdlePolicy("CLAUDE", { OMB_SESSION_IDLE_MIN_MS: "4000" }).minimumMs).toBe(10_000);
  });

  it("never floors below ten seconds, however low the configured minimum", () => {
    expect(sessionIdlePolicy("CLAUDE", { OMB_CLAUDE_SESSION_IDLE_MIN_MS: "2000" }).minimumMs).toBe(10_000);
    expect(
      sessionIdlePolicy("CLAUDE", { OMB_CLAUDE_SESSION_IDLE_MS: "15000", OMB_CLAUDE_SESSION_IDLE_MIN_MS: "2000" }).idleMs,
    ).toBe(15_000);
    expect(
      sessionIdlePolicy("ACP", { OMB_ACP_SESSION_IDLE_MS: "1", OMB_ACP_SESSION_IDLE_MIN_MS: "2000" }).idleMs,
    ).toBe(10_000);
    expect(sessionIdlePolicy("ACP", { OMB_SESSION_IDLE_MIN_MS: "-5" }).minimumMs).toBe(10_000);
  });

  it("rejects unusable delays before the floor instead of coercing them to a 1 ms timer", () => {
    for (const raw of ["not-a-number", "0", "-5", "", "Infinity", "1e309", "2147483648"]) {
      expect(sessionIdlePolicy("CLAUDE", { OMB_CLAUDE_SESSION_IDLE_MS: raw }).idleMs).toBe(10 * 60_000);
      expect(sessionIdlePolicy("ACP", { OMB_SESSION_IDLE_MS: raw }).idleMs).toBe(10 * 60_000);
    }
    expect(sessionIdlePolicy("CLAUDE", { OMB_CLAUDE_SESSION_IDLE_MS: "2147483647" }).idleMs).toBe(2_147_483_647);
    expect(sessionIdlePolicy("ACP", { OMB_ACP_SESSION_IDLE_MIN_MS: "Infinity" }).minimumMs).toBe(10_000);
  });
});
