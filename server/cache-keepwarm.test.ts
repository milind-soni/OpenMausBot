// The keep-warm window on a manual clock: when it pings, what stops it, and
// that a busy thread, a new turn, a deletion or a quit never leaves a ping
// or a held session behind. Rules from Cache Tax (MIT), hooks/register.ts.
import { describe, expect, it } from "vitest";

import {
  BUSY_RETRY_MS,
  CACHE_TTL_MS,
  createCacheKeepWarm,
  MIN_CONTEXT_TOKENS,
  PING_AFTER_MS,
  pingWasWarm,
  type KeepWarmDeps,
  type KeepWarmPingResult,
  type KeepWarmTarget,
} from "./cache-keepwarm.ts";
import { cacheKeepWarmSettings, parseConfigPatch } from "./config.ts";

const MIN = 60_000;
const T: KeepWarmTarget = { threadId: "t1", botId: "b1", instanceId: "claude" };
const WARM: KeepWarmPingResult = { ok: true, input: 4, cacheRead: 154_000, cacheWrite: 30, output: 2, costUsd: 0.05, model: "claude-opus-5-5" };
const BIG = { ok: true, contextTokens: 200_000 };

function harness(overrides: Partial<KeepWarmDeps> = {}) {
  let now = 1_000_000;
  let timers: Array<{ at: number; fn: () => void; live: boolean }> = [];
  const pings: KeepWarmTarget[] = [];
  const booked: KeepWarmPingResult[] = [];
  const holds: Array<number | null> = [];
  let replies: KeepWarmPingResult[] = [];
  let pending: { resolve: (r: KeepWarmPingResult) => void; signal: AbortSignal } | null = null;
  const state = { windowMs: 3 * 60 * MIN as number | null, ineligible: null as string | null, busy: false, overBudget: false, manual: false };
  const deps: KeepWarmDeps = {
    now: () => now,
    after: (ms, fn) => {
      const timer = { at: now + ms, fn, live: true };
      timers.push(timer);
      return { cancel: () => { timer.live = false; } };
    },
    windowMs: () => state.windowMs,
    ineligible: () => state.ineligible,
    busy: () => state.busy,
    overBudget: () => state.overBudget,
    ping: (target, signal) => {
      pings.push(target);
      if (state.manual) return new Promise((resolve) => { pending = { resolve, signal }; });
      return Promise.resolve(replies.shift() ?? WARM);
    },
    hold: (_target, until) => { holds.push(until); },
    book: (_target, result) => { booked.push(result); },
    changed: () => {},
    ...overrides,
  };
  const keepWarm = createCacheKeepWarm(deps);
  const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
  const advance = async (ms: number) => {
    const end = now + ms;
    for (;;) {
      timers = timers.filter((timer) => timer.live);
      const next = timers.filter((timer) => timer.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      now = next.at;
      next.live = false;
      next.fn();
      await flush();
    }
    now = end;
  };
  return {
    keepWarm, state, pings, booked, holds, advance, flush,
    reply: (...results: KeepWarmPingResult[]) => { replies = results; },
    settle: async (result: KeepWarmPingResult) => { pending?.resolve(result); pending = null; await flush(); },
    aborted: () => pending?.signal.aborted ?? true,
    liveTimers: () => timers.filter((timer) => timer.live).length,
  };
}

describe("cache keep-warm", () => {
  it("pings once per idle stretch, 50 minutes after the last request, until the window ends", async () => {
    const h = harness();
    h.keepWarm.noteTurnCompleted(T, BIG);
    expect(h.holds).toEqual([1_000_000 + 3 * 60 * MIN]);
    expect(h.keepWarm.status("t1")).toMatchObject({ state: "warm", nextPingAt: 1_000_000 + PING_AFTER_MS });
    await h.advance(PING_AFTER_MS - MIN);
    expect(h.pings).toHaveLength(0);
    await h.advance(MIN);
    expect(h.pings).toEqual([T]);
    expect(h.booked).toEqual([WARM]);
    expect(h.keepWarm.status("t1")).toMatchObject({ state: "warm", last: { read: 154_000, write: 30, costUsd: 0.05 } });
    // 3h window: pings at 50, 100 and 150 minutes, none at 200
    await h.advance(3 * 60 * MIN);
    expect(h.pings).toHaveLength(3);
    expect(h.keepWarm.status("t1")).toBeUndefined();
    expect(h.holds.at(-1)).toBeNull();
    expect(h.liveTimers()).toBe(0);
  });

  it("stops when a ping reads nothing or writes a tenth of what it read", async () => {
    expect(pingWasWarm(150_000, 14_999)).toBe(true);
    expect(pingWasWarm(150_000, 15_000)).toBe(false);
    expect(pingWasWarm(0, 0)).toBe(false);
    for (const cold of [{ ...WARM, cacheRead: 0, cacheWrite: 0 }, { ...WARM, cacheRead: 100_000, cacheWrite: 10_000 }]) {
      const h = harness();
      h.reply(cold as KeepWarmPingResult);
      h.keepWarm.noteTurnCompleted(T, BIG);
      await h.advance(3 * 60 * MIN);
      expect(h.pings).toHaveLength(1);
      expect(h.booked).toHaveLength(1);
      expect(h.keepWarm.status("t1")).toMatchObject({ state: "stopped", stopped: expect.stringContaining("the cache was already gone") });
      expect(h.holds.at(-1)).toBeNull();
    }
  });

  it("stops on a failed ping and on the account's usage limit, booking nothing", async () => {
    const h = harness();
    h.reply({ ok: false, reason: "the account's usage limit refused the ping", limit: true });
    h.keepWarm.noteTurnCompleted(T, BIG);
    await h.advance(3 * 60 * MIN);
    expect(h.pings).toHaveLength(1);
    expect(h.booked).toEqual([]);
    expect(h.keepWarm.status("t1")).toEqual({ state: "stopped", stopped: "the account's usage limit refused the ping" });
  });

  it("arms only for a finished turn with a big context on an eligible engine, with keep-warm on", async () => {
    const small = harness();
    small.keepWarm.noteTurnCompleted(T, { ok: true, contextTokens: MIN_CONTEXT_TOKENS - 1 });
    const failed = harness();
    failed.keepWarm.noteTurnCompleted(T, { ok: false, contextTokens: 200_000 });
    const off = harness();
    off.state.windowMs = null;
    off.keepWarm.noteTurnCompleted(T, BIG);
    const apiKey = harness();
    apiKey.state.ineligible = "keep-warm runs only on a Claude subscription sign-in";
    apiKey.keepWarm.noteTurnCompleted(T, BIG);
    for (const h of [small, failed, off, apiKey]) {
      await h.advance(3 * 60 * MIN);
      expect(h.pings).toEqual([]);
      expect(h.holds).toEqual([]);
      expect(h.keepWarm.status("t1")).toBeUndefined();
    }
  });

  it("never pings during a turn, aborts one in flight, and re-arms from the turn's end", async () => {
    const h = harness();
    h.state.manual = true;
    h.keepWarm.noteTurnCompleted(T, BIG);
    await h.advance(PING_AFTER_MS);
    expect(h.pings).toHaveLength(1);
    h.keepWarm.noteTurnStarted("t1");
    expect(h.aborted()).toBe(true);
    expect(h.keepWarm.status("t1")).toEqual({ state: "warm", until: expect.any(Number) });
    await h.settle(WARM);
    expect(h.booked).toHaveLength(1);
    await h.advance(2 * 60 * MIN);
    expect(h.pings).toHaveLength(1);
    h.state.manual = false;
    h.keepWarm.noteTurnCompleted(T, BIG);
    await h.advance(PING_AFTER_MS);
    expect(h.pings).toHaveLength(2);
  });

  it("asks a busy bot again a minute later while the cache is still warm, then gives up", async () => {
    const h = harness();
    h.state.busy = true;
    h.keepWarm.noteTurnCompleted(T, BIG);
    await h.advance(PING_AFTER_MS + BUSY_RETRY_MS * 3);
    expect(h.pings).toEqual([]);
    h.state.busy = false;
    await h.advance(BUSY_RETRY_MS);
    expect(h.pings).toHaveLength(1);

    const stuck = harness();
    stuck.state.busy = true;
    stuck.keepWarm.noteTurnCompleted(T, BIG);
    await stuck.advance(CACHE_TTL_MS);
    expect(stuck.pings).toEqual([]);
    expect(stuck.keepWarm.status("t1")).toBeUndefined();
    expect(stuck.liveTimers()).toBe(0);
  });

  it("stops at the spend cap, and when the engine is no longer eligible", async () => {
    const capped = harness();
    capped.keepWarm.noteTurnCompleted(T, BIG);
    capped.state.overBudget = true;
    await capped.advance(PING_AFTER_MS);
    expect(capped.pings).toEqual([]);
    expect(capped.keepWarm.status("t1")).toMatchObject({ state: "stopped", stopped: expect.stringContaining("spend limit") });

    const gone = harness();
    gone.keepWarm.noteTurnCompleted(T, BIG);
    gone.state.ineligible = "the thread was deleted";
    await gone.advance(PING_AFTER_MS);
    expect(gone.pings).toEqual([]);
    expect(gone.keepWarm.status("t1")).toEqual({ state: "stopped", stopped: "the thread was deleted" });
  });

  it("ends windows on bot deletion, a switch-off and quit, releasing the session", async () => {
    const h = harness();
    h.keepWarm.noteTurnCompleted(T, BIG);
    h.keepWarm.noteTurnCompleted({ ...T, threadId: "t2" }, BIG);
    h.keepWarm.noteTurnCompleted({ threadId: "t3", botId: "b2", instanceId: "claude" }, BIG);
    h.keepWarm.cancelBot("b1");
    expect(h.keepWarm.status("t1")).toBeUndefined();
    expect(h.keepWarm.status("t2")).toBeUndefined();
    expect(h.keepWarm.status("t3")).toMatchObject({ state: "warm" });
    h.state.windowMs = null;
    h.keepWarm.refresh();
    expect(h.keepWarm.status("t3")).toBeUndefined();
    h.state.windowMs = 60 * MIN;
    h.keepWarm.noteTurnCompleted(T, BIG);
    h.keepWarm.dispose();
    expect(h.holds.filter((until) => until === null)).toHaveLength(4);
    await h.advance(3 * 60 * MIN);
    expect(h.pings).toEqual([]);
    expect(h.liveTimers()).toBe(0);
    h.keepWarm.noteTurnCompleted(T, BIG);
    expect(h.liveTimers()).toBe(0);
  });

  it("a window shorter than the ping delay just ends", async () => {
    const h = harness();
    h.state.windowMs = 30 * MIN;
    h.keepWarm.noteTurnCompleted(T, BIG);
    expect(h.keepWarm.status("t1")).toEqual({ state: "warm", until: expect.any(Number) });
    await h.advance(60 * MIN);
    expect(h.pings).toEqual([]);
    expect(h.holds).toEqual([expect.any(Number), null]);
  });
});

describe("keep-warm setting", () => {
  it("is off with a 3h window by default and validates a patch", () => {
    expect(cacheKeepWarmSettings({})).toEqual({ enabled: false, windowMinutes: 180 });
    expect(cacheKeepWarmSettings({ cacheKeepWarm: { enabled: true, windowMinutes: 360 } })).toEqual({ enabled: true, windowMinutes: 360 });
    expect(parseConfigPatch({ cacheKeepWarm: { enabled: true, windowMinutes: 180 } })).toEqual({ cacheKeepWarm: { enabled: true, windowMinutes: 180 } });
    expect(() => parseConfigPatch({ cacheKeepWarm: { enabled: true, windowMinutes: 5 } })).toThrow();
    expect(() => parseConfigPatch({ cacheKeepWarm: { enabled: "yes" } })).toThrow();
  });
});
