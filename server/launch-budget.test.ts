// Global launch budget (Phase 0, item 0.4): one fuse across every bot for
// the turns the harness starts. Pure decision function first; then the
// stateful budget with persistence, quota pauses and tickets.
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { DEFAULT_LAUNCH_LIMITS, decideLaunch, LaunchBudget, type LaunchState, type LaunchTicket } from "./launch-budget.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const dir = mkdtempSync(join(tmpdir(), "omb-launch-budget-"));
afterAll(() => removeTempDir(dir));

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;
const state = (over: Partial<LaunchState> = {}): LaunchState => ({ active: 0, launches: [], pausedUntil: 0, ...over });
const limits = { maxConcurrent: 3, maxPerHour: 5, maxPerDay: 8, pauseMs: 15 * 60_000, ticketTtlMs: 30 * 60_000 };

describe("decideLaunch", () => {
  it("allows when nothing is near a cap", () => {
    expect(decideLaunch(state(), limits, { kind: "routine" }, NOW)).toEqual({ ok: true });
  });

  it("denies on the concurrency cap with a short retry", () => {
    const d = decideLaunch(state({ active: 3 }), limits, { kind: "routine" }, NOW);
    expect(d).toMatchObject({ ok: false, reason: "concurrent" });
    expect((d as { retryAfterMs: number }).retryAfterMs).toBeGreaterThan(0);
  });

  it("denies unattended launches past the hourly cap until the oldest launch ages out", () => {
    const launches = [NOW - 50 * 60_000, NOW - 40 * 60_000, NOW - 30 * 60_000, NOW - 20 * 60_000, NOW - 10 * 60_000];
    const d = decideLaunch(state({ launches }), limits, { kind: "wake" }, NOW);
    expect(d).toMatchObject({ ok: false, reason: "hourly", retryAfterMs: 10 * 60_000 });
  });

  it("denies unattended launches past the daily cap", () => {
    const launches = Array.from({ length: 8 }, (_, i) => NOW - (i + 2) * HOUR);
    const d = decideLaunch(state({ launches }), limits, { kind: "routine" }, NOW);
    expect(d).toMatchObject({ ok: false, reason: "daily" });
  });

  it("holds every unattended launch while paused after a quota error", () => {
    const d = decideLaunch(state({ pausedUntil: NOW + 5 * 60_000 }), limits, { kind: "wake" }, NOW);
    expect(d).toEqual({ ok: false, reason: "paused", retryAfterMs: 5 * 60_000 });
  });

  it("never denies a person's own turn: not on hourly, daily, pause, or concurrency caps", () => {
    const launches = Array.from({ length: 8 }, (_, i) => NOW - (i + 1) * 60_000);
    expect(decideLaunch(state({ launches, pausedUntil: NOW + HOUR }), limits, { kind: "turn", attended: true }, NOW)).toEqual({ ok: true });
    expect(decideLaunch(state({ active: 3 }), limits, { kind: "turn", attended: true }, NOW)).toEqual({ ok: true });
    // an unattended turn of the same kind is capped like any other launch
    expect(decideLaunch(state({ active: 3 }), limits, { kind: "turn", attended: false }, NOW)).toMatchObject({ ok: false, reason: "concurrent" });
  });

  it("ships with generous defaults", () => {
    expect(DEFAULT_LAUNCH_LIMITS).toEqual({ maxConcurrent: 12, maxPerHour: 120, maxPerDay: 800, pauseMs: 15 * 60_000, ticketTtlMs: 30 * 60_000 });
  });
});

describe("LaunchBudget", () => {
  it("issues a ticket per acquire, counts it as active until released, and releases idempotently", () => {
    let now = NOW;
    const budget = new LaunchBudget(join(dir, "a.json"), { ...limits, maxConcurrent: 1 }, () => now);
    const first = budget.acquire({ kind: "routine", botId: "b1" });
    expect(first.ok).toBe(true);
    expect(budget.acquire({ kind: "routine", botId: "b2" })).toMatchObject({ ok: false, reason: "concurrent" });
    const ticket = (first as { ok: true; ticket: LaunchTicket }).ticket;
    budget.release(ticket);
    budget.release(ticket);
    expect(budget.snapshot().active).toBe(0);
    now += 1;
    expect(budget.acquire({ kind: "routine", botId: "b2" }).ok).toBe(true);
  });

  it("persists launch timestamps and the pause across a restart, but not the active count", () => {
    const file = join(dir, "b.json");
    const first = new LaunchBudget(file, { ...limits, maxPerHour: 2 }, () => NOW);
    expect(first.acquire({ kind: "routine" }).ok).toBe(true);
    expect(first.acquire({ kind: "routine" }).ok).toBe(true);
    first.noteQuotaError();
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ launches: [NOW, NOW], pausedUntil: NOW + limits.pauseMs });

    const again = new LaunchBudget(file, { ...limits, maxPerHour: 2 }, () => NOW + 1_000);
    expect(again.snapshot().active).toBe(0);
    expect(again.acquire({ kind: "routine" })).toMatchObject({ ok: false, reason: "paused" });
    const later = new LaunchBudget(file, { ...limits, maxPerHour: 2 }, () => NOW + limits.pauseMs + 1);
    expect(later.acquire({ kind: "routine" })).toMatchObject({ ok: false, reason: "hourly" });
    const muchLater = new LaunchBudget(file, { ...limits, maxPerHour: 2 }, () => NOW + HOUR + 1);
    expect(muchLater.acquire({ kind: "routine" }).ok).toBe(true);
  });

  it("forgets launches older than a day so the file cannot grow without bound", () => {
    const file = join(dir, "c.json");
    mkdirSync(dir, { recursive: true });
    const old = new LaunchBudget(file, limits, () => NOW - 2 * 24 * HOUR);
    old.acquire({ kind: "routine" });
    const fresh = new LaunchBudget(file, limits, () => NOW);
    fresh.acquire({ kind: "routine" });
    expect(JSON.parse(readFileSync(file, "utf8")).launches).toEqual([NOW]);
  });

  it("reports a snapshot the UI can show", () => {
    const budget = new LaunchBudget(join(dir, "d.json"), limits, () => NOW);
    budget.acquire({ kind: "turn", attended: true, botId: "b1" });
    budget.noteQuotaError();
    expect(budget.snapshot()).toEqual({
      active: 1,
      lastHour: 1,
      lastDay: 1,
      limits,
      pausedUntil: NOW + limits.pauseMs,
    });
  });
});

describe("LaunchBudget: tickets cannot leak", () => {
  it("expires a ticket that was never released once a turn could not still be running", () => {
    let now = NOW;
    const budget = new LaunchBudget(join(dir, "e.json"), { ...limits, maxConcurrent: 1 }, () => now);
    expect(budget.acquire({ kind: "routine", botId: "b1", threadId: "t1" }).ok).toBe(true);
    expect(budget.acquire({ kind: "routine", botId: "b2", threadId: "t2" })).toMatchObject({ ok: false, reason: "concurrent" });
    now += limits.ticketTtlMs + 1;
    expect(budget.snapshot().active).toBe(0);
    expect(budget.acquire({ kind: "routine", botId: "b2", threadId: "t2" }).ok).toBe(true);
  });

  it("releases every ticket of a thread on a terminal event, whichever generation held it", () => {
    const budget = new LaunchBudget(join(dir, "f.json"), { ...limits, maxConcurrent: 2 }, () => NOW);
    expect(budget.acquire({ kind: "peer", botId: "b1", threadId: "t1" }).ok).toBe(true);
    expect(budget.acquire({ kind: "peer", botId: "b1", threadId: "t1" }).ok).toBe(true);
    expect(budget.snapshot().active).toBe(2);
    budget.releaseThread("t1");
    expect(budget.snapshot().active).toBe(0);
    budget.releaseThread("never-seen");
  });
});
