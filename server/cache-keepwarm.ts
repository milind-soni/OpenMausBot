// Ported from the design of Cache Tax (MIT, Copyright (c) 2026 Karan Bansal,
// https://github.com/karanb192/claude-code-mods, hooks/register.ts): bots run
// Claude Code with project-only settings, so a person's own Claude Code
// plugins never reach them.
//
// Only subscription (Pro/Max) logins are pinged: their prompt cache lives an hour. A metered API key's main cache lives
// five minutes by default, so pinging it costs more than the re-write it avoids. Nothing is persisted: after a restart the
// CLI relaunches with a fresh system prompt that misses the cache anyway.

import type { CacheWarmPingResult } from "./contracts.ts";
import type { CacheKeepWarmStatus } from "../shared/wire.ts";

export const CACHE_TTL_MS = 60 * 60_000;
export const PING_AFTER_MS = 50 * 60_000;
export const BUSY_RETRY_MS = 60_000;
export const MIN_CONTEXT_TOKENS = 50_000;
export const DEFAULT_WINDOW_MINUTES = 180;
export const MAX_WINDOW_MINUTES = 24 * 60;
/** Cache Tax's stop rule: a warm ping writes only its own few tokens. */
export const MAX_WRITE_RATIO = 0.1;

export interface KeepWarmTarget {
  threadId: string;
  botId: string;
  instanceId: string;
}

export type KeepWarmPingResult = CacheWarmPingResult;

export type KeepWarmStatus = CacheKeepWarmStatus;

export interface KeepWarmDeps {
  now: () => number;
  after: (ms: number, fn: () => void) => { cancel: () => void };
  windowMs: (botId: string) => number | null;
  ineligible: (target: KeepWarmTarget) => string | null;
  busy: (target: KeepWarmTarget) => boolean;
  overBudget: () => boolean;
  ping: (target: KeepWarmTarget, signal: AbortSignal) => Promise<KeepWarmPingResult>;
  hold: (target: KeepWarmTarget, until: number | null) => void;
  book: (target: KeepWarmTarget, result: Extract<KeepWarmPingResult, { ok: true }>) => void;
  changed: (target: KeepWarmTarget) => void;
}

interface Window {
  target: KeepWarmTarget;
  deadline: number;
  lastRequestAt: number;
  pending: { cancel: () => void } | null;
  nextPingAt: number | null;
  inflight: AbortController | null;
  paused: boolean;
}

export function fmtTokens(n: number): string {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

/** A ping that read the prefix and wrote only its own message. */
export function pingWasWarm(read: number, write: number): boolean {
  return read > 0 && write < MAX_WRITE_RATIO * read;
}

export function createCacheKeepWarm(deps: KeepWarmDeps) {
  const windows = new Map<string, Window>();
  const lastPing = new Map<string, { target: KeepWarmTarget; ping: NonNullable<KeepWarmStatus["last"]> }>();
  const stoppedWhy = new Map<string, string>();
  let disposed = false;

  const disarm = (w: Window) => {
    w.pending?.cancel();
    w.pending = null;
    w.nextPingAt = null;
  };

  const end = (w: Window, why: string | null) => {
    disarm(w);
    w.inflight?.abort();
    w.inflight = null;
    if (windows.get(w.target.threadId) === w) windows.delete(w.target.threadId);
    if (why) stoppedWhy.set(w.target.threadId, why);
    deps.hold(w.target, null);
    deps.changed(w.target);
  };

  const arm = (w: Window) => {
    disarm(w);
    if (disposed || w.paused || windows.get(w.target.threadId) !== w) return;
    const now = deps.now();
    if (now >= w.deadline) return end(w, null);
    // A cold cache is never pinged: that would pay the re-write it avoids.
    const untilCold = w.lastRequestAt + CACHE_TTL_MS - now;
    if (untilCold <= 0) return end(w, null);
    const due = Math.max(1000, w.lastRequestAt + PING_AFTER_MS - now);
    const delay = Math.min(w.deadline - now, untilCold, due);
    w.nextPingAt = now + due < w.deadline && due < untilCold ? now + due : null;
    w.pending = deps.after(delay, () => { void ping(w); });
    deps.changed(w.target);
  };

  const ping = async (w: Window) => {
    w.pending = null;
    if (disposed || w.paused || windows.get(w.target.threadId) !== w) return;
    const now = deps.now();
    if (now >= w.deadline || now - w.lastRequestAt >= CACHE_TTL_MS) return end(w, null);
    if (now - w.lastRequestAt < PING_AFTER_MS - 1000) return arm(w);
    if (deps.windowMs(w.target.botId) === null) return end(w, null);
    const ineligible = deps.ineligible(w.target);
    if (ineligible) return end(w, ineligible);
    if (deps.overBudget()) return end(w, "the workspace's monthly spend limit is reached");
    if (deps.busy(w.target)) return retryLater(w, now);
    const controller = new AbortController();
    w.inflight = controller;
    let result: KeepWarmPingResult;
    try {
      result = await deps.ping(w.target, controller.signal);
    } catch (error) {
      result = { ok: false, reason: `the ping failed: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (w.inflight === controller) w.inflight = null;
    // Whatever happened to the window meanwhile, a ping that ran is booked.
    if (result.ok) {
      try { deps.book(w.target, result); } catch {}
    }
    if (disposed || windows.get(w.target.threadId) !== w || controller.signal.aborted) return;
    if (!result.ok) {
      if (result.busy) return retryLater(w, deps.now());
      return end(w, result.reason);
    }
    const warm = pingWasWarm(result.cacheRead, result.cacheWrite);
    lastPing.set(w.target.threadId, {
      target: { ...w.target },
      ping: { at: now, read: result.cacheRead, write: result.cacheWrite, costUsd: result.costUsd },
    });
    if (!warm) {
      return end(w, `the ping read ${fmtTokens(result.cacheRead)} and wrote ${fmtTokens(result.cacheWrite)} tokens: the cache was already gone`);
    }
    w.lastRequestAt = now;
    arm(w);
  };

  const retryLater = (w: Window, now: number) => {
    disarm(w);
    const untilCold = w.lastRequestAt + CACHE_TTL_MS - now;
    if (untilCold <= BUSY_RETRY_MS || now + BUSY_RETRY_MS >= w.deadline) return end(w, null);
    w.nextPingAt = now + BUSY_RETRY_MS;
    w.pending = deps.after(BUSY_RETRY_MS, () => { void ping(w); });
    deps.changed(w.target);
  };

  return {
    noteTurnStarted(threadId: string): void {
      const w = windows.get(threadId);
      if (!w) return;
      w.paused = true;
      disarm(w);
      w.inflight?.abort();
      w.inflight = null;
      deps.changed(w.target);
    },

    noteTurnCompleted(target: KeepWarmTarget, turn: { ok: boolean; stopReason?: string | null; contextTokens?: number }): void {
      if (disposed) return;
      let existing = windows.get(target.threadId);
      const hadStopped = stoppedWhy.delete(target.threadId);
      const windowMs = deps.windowMs(target.botId);
      const quiet = (w: Window | undefined) => {
        const hadLast = lastPing.delete(target.threadId);
        if (w) end(w, null);
        else if (hadStopped || hadLast) deps.changed(target);
      };
      if (windowMs === null || !turn.ok) return quiet(existing);
      if ((turn.contextTokens ?? 0) < MIN_CONTEXT_TOKENS) return quiet(existing);
      if (deps.ineligible(target)) return quiet(existing);
      const previousPing = lastPing.get(target.threadId);
      if (previousPing && (previousPing.target.botId !== target.botId || previousPing.target.instanceId !== target.instanceId)) {
        lastPing.delete(target.threadId);
      }
      if (existing && (existing.target.botId !== target.botId || existing.target.instanceId !== target.instanceId)) {
        end(existing, null);
        existing = undefined;
      }
      const now = deps.now();
      const w: Window = existing ?? { target, deadline: 0, lastRequestAt: now, pending: null, nextPingAt: null, inflight: null, paused: false };
      w.target = target;
      w.deadline = now + windowMs;
      w.lastRequestAt = now;
      w.paused = false;
      windows.set(target.threadId, w);
      deps.hold(target, w.deadline);
      arm(w);
    },

    cancelThread(threadId: string): void {
      stoppedWhy.delete(threadId);
      lastPing.delete(threadId);
      const w = windows.get(threadId);
      if (w) end(w, null);
    },

    cancelBot(botId: string): void {
      for (const w of windows.values()) if (w.target.botId === botId) end(w, null);
    },

    refresh(): void {
      for (const w of windows.values()) if (deps.windowMs(w.target.botId) === null) end(w, null);
    },

    status(threadId: string): KeepWarmStatus | undefined {
      const w = windows.get(threadId);
      const last = lastPing.get(threadId)?.ping;
      if (w) {
        return {
          state: "warm",
          until: w.deadline,
          ...(w.nextPingAt !== null && !w.paused ? { nextPingAt: w.nextPingAt } : {}),
          ...(last ? { last } : {}),
        };
      }
      const why = stoppedWhy.get(threadId);
      return why ? { state: "stopped", stopped: why, ...(last ? { last } : {}) } : undefined;
    },

    dispose(): void {
      disposed = true;
      for (const w of windows.values()) {
        disarm(w);
        w.inflight?.abort();
        deps.hold(w.target, null);
      }
      windows.clear();
    },
  };
}

export type CacheKeepWarm = ReturnType<typeof createCacheKeepWarm>;
