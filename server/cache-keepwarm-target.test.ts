import { afterEach, describe, expect, it, vi } from "vitest";

import { createCacheKeepWarm, PING_AFTER_MS, type CacheKeepWarm, type KeepWarmPingResult, type KeepWarmTarget } from "./cache-keepwarm.ts";

const target: KeepWarmTarget = { threadId: "thread", botId: "bot", instanceId: "claude-one" };
const turn = { ok: true, contextTokens: 200_000 };
const warm: KeepWarmPingResult = { ok: true, input: 4, cacheRead: 100_000, cacheWrite: 20, output: 2, costUsd: 0.01, model: "claude-opus-5-5" };
const instances: CacheKeepWarm[] = [];

function fixture() {
  vi.useFakeTimers();
  const holds: Array<{ target: KeepWarmTarget; until: number | null }> = [];
  const booked: KeepWarmTarget[] = [];
  let finish!: (result: KeepWarmPingResult) => void;
  const keepWarm = createCacheKeepWarm({
    now: () => Date.now(),
    after: (ms, fn) => { const timer = setTimeout(fn, ms); return { cancel: () => clearTimeout(timer) }; },
    windowMs: () => 3 * 60 * 60_000,
    ineligible: () => null,
    busy: () => false,
    overBudget: () => false,
    ping: () => new Promise((resolve) => { finish = resolve; }),
    hold: (heldTarget, until) => { holds.push({ target: heldTarget, until }); },
    book: (bookedTarget) => { booked.push(bookedTarget); },
    changed: () => {},
  });
  instances.push(keepWarm);
  return { keepWarm, holds, booked, settle: async () => { finish(warm); await Promise.resolve(); } };
}

afterEach(() => {
  for (const instance of instances.splice(0)) instance.dispose();
  vi.useRealTimers();
});

describe.each([
  ["engine", { ...target, instanceId: "claude-two" }],
  ["room speaker", { ...target, botId: "another-bot" }],
] as const)("keep-warm after a change of %s", (_kind, replacement) => {
  it("releases the previous target's held session before holding its replacement", () => {
    const h = fixture();
    h.keepWarm.noteTurnCompleted(target, turn);
    h.keepWarm.noteTurnStarted(target.threadId);
    h.keepWarm.noteTurnCompleted(replacement, turn);
    expect(h.holds).toEqual([
      { target, until: expect.any(Number) },
      { target, until: null },
      { target: replacement, until: expect.any(Number) },
    ]);
  });

  it("books a late ping to the target that ran it without updating the replacement", async () => {
    const h = fixture();
    h.keepWarm.noteTurnCompleted(target, turn);
    await vi.advanceTimersByTimeAsync(PING_AFTER_MS);
    h.keepWarm.noteTurnStarted(target.threadId);
    h.keepWarm.noteTurnCompleted(replacement, turn);
    await h.settle();
    expect(h.booked).toEqual([target]);
    expect(h.keepWarm.status(target.threadId)?.last).toBeUndefined();
    expect(h.keepWarm.status(target.threadId)?.nextPingAt).toBe(Date.now() + PING_AFTER_MS);
  });

  it("does not show the previous target's ping as the replacement's last ping", async () => {
    const h = fixture();
    h.keepWarm.noteTurnCompleted(target, turn);
    await vi.advanceTimersByTimeAsync(PING_AFTER_MS);
    await h.settle();
    expect(h.keepWarm.status(target.threadId)?.last).toBeDefined();
    h.keepWarm.noteTurnStarted(target.threadId);
    h.keepWarm.noteTurnCompleted(replacement, turn);
    expect(h.keepWarm.status(target.threadId)?.last).toBeUndefined();
  });
});
