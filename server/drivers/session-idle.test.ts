import { afterEach, describe, expect, it } from "vitest";

import { forgetPresence, personAsks, sawThread, seenWithin } from "../thread-presence.ts";
import { engineIdleMs, sessionIdlePolicy, UNWATCHED_IDLE_MS } from "./session-idle.ts";

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

describe("an idle engine's keep-alive", () => {
  const policy = { idleMs: 10 * 60_000, minimumMs: 10_000 };
  const now = 1_800_000_000_000;
  const cloud = (headroom: number) => ({ enabled: true, headroom: () => headroom });
  afterEach(forgetPresence);

  it("keeps the configured time where the memory gate is off", () => {
    expect(engineIdleMs("unseen", policy, { enabled: false, headroom: () => 0.1 }, now)).toBe(10 * 60_000);
  });

  it("closes soon a thread nobody has had in front of them: a teammate's delegated work or a routine", () => {
    expect(engineIdleMs("delegated", policy, cloud(1), now)).toBe(UNWATCHED_IDLE_MS);
    sawThread("stale", now - 31 * 60_000);
    expect(engineIdleMs("stale", policy, cloud(1), now)).toBe(UNWATCHED_IDLE_MS);
    expect(engineIdleMs("delegated", { idleMs: 15_000, minimumMs: 10_000 }, cloud(1), now)).toBe(15_000);
    expect(engineIdleMs("delegated", { idleMs: 10 * 60_000, minimumMs: 45_000 }, cloud(1), now)).toBe(45_000);
  });

  it("keeps the conversation a person has open, wrote in from any channel, or read, for as long as memory allows", () => {
    sawThread("open", now - 5 * 60_000);
    personAsks.set("telegram", now - 60_000);
    expect(engineIdleMs("open", policy, cloud(1), now)).toBe(10 * 60_000);
    expect(engineIdleMs("telegram", policy, cloud(1), now)).toBe(10 * 60_000);
    expect(engineIdleMs("open", policy, cloud(0.5), now)).toBe(5 * 60_000);
    expect(engineIdleMs("open", policy, cloud(0.1), now)).toBe(60_000);
    // A teammate's report resuming the conversation clears "person asked"; the person was still there a minute ago.
    personAsks.delete("telegram");
    expect(engineIdleMs("telegram", policy, cloud(1), now)).toBe(10 * 60_000);
    expect(engineIdleMs("open", { idleMs: 60_000, minimumMs: 10_000 }, cloud(0.1), now)).toBe(10_000);
  });

  it("remembers the latest sighting of each thread, and only so many threads", () => {
    sawThread("a", now - 40 * 60_000);
    sawThread("a", now);
    expect(seenWithin("a", 60_000, now)).toBe(true);
    for (let i = 0; i < 2_001; i++) sawThread(`t${i}`, now);
    expect(seenWithin("a", 60_000, now)).toBe(false);
    expect(seenWithin("t2000", 60_000, now)).toBe(true);
  });
});
