import { describe, expect, it } from "vitest";

import { createBoatHealth } from "./boat-health.ts";
import { boatSignals, createBoatReadiness, READY_WAIT } from "./boat-ready.ts";
import { createCloudComputerCounters } from "./cloud-computer-counters.ts";
import type { AppConfig } from "./config.ts";

const cfg = {} as AppConfig;
const BOX = "bx_23456789";

/** A clock that only moves when the wait sleeps or a probe takes its time. */
function harness(probe: (at: number, call: number) => boolean | null, sandbox: (at: number) => unknown = () => ({ state: "idle", health: "ok" })) {
  let at = 1_000_000;
  let probes = 0;
  const now = () => at;
  const health = createBoatHealth(now);
  const counters = createCloudComputerCounters(now);
  const phases: string[] = [];
  const readiness = createBoatReadiness({
    probe: async () => {
      const answered = probe(at, probes++);
      if (answered === false) at += READY_WAIT.probeTimeoutMs;
      return answered;
    },
    read: async () => sandbox(at), health, counters, now,
    sleep: async (ms) => { at += ms; },
  });
  return { readiness, health, counters, phases, now, probes: () => probes, advance: (ms: number) => { at += ms; }, start: at };
}

describe("what the provider says about a sandbox", () => {
  it("reads a disk restore from any of the fields seen on a silent computer", () => {
    expect(boatSignals({ state: "idle", health: "ok", hydrated: false, lastSnapshotStatus: "in_progress" })).toEqual({ restoring: true, degraded: false });
    expect(boatSignals({ hydrated: true, lastSnapshotStatus: "in_progress" }).restoring).toBe(true);
    expect(boatSignals({ hydration: { status: "pending" } }).restoring).toBe(true);
    expect(boatSignals({ hydration: "hydrating" }).restoring).toBe(true);
    expect(boatSignals({ hydrated: true, lastSnapshotStatus: "completed" }).restoring).toBe(false);
  });

  it("treats a field that is not there as unknown, never as healthy", () => {
    expect(boatSignals({ state: "idle" })).toEqual({ restoring: null, degraded: null });
    expect(boatSignals(null)).toEqual({ restoring: null, degraded: null });
    expect(boatSignals({ lastSnapshotStatus: "completed" }).restoring).toBeNull();
  });

  it("reads trouble from health and degradedSince", () => {
    expect(boatSignals({ health: "degraded" }).degraded).toBe(true);
    expect(boatSignals({ health: "ok", degradedSince: "2026-11-14T10:00:00Z" }).degraded).toBe(true);
    expect(boatSignals({ health: "ok" }).degraded).toBe(false);
  });
});

describe("waiting for a cloud computer to answer", () => {
  it("asks nothing of a computer that answered a command a moment ago", async () => {
    const h = harness(() => true);
    h.health.answered(BOX);
    h.advance(READY_WAIT.freshMs - 1);
    await expect(h.readiness.awaitAnswer(cfg, BOX)).resolves.toEqual({ ok: true, waitedMs: 0 });
    expect(h.probes()).toBe(0);
  });

  it("probes one that answered longer ago, and one that was just woken however recently it answered", async () => {
    const h = harness(() => true);
    h.health.answered(BOX);
    await h.readiness.awaitAnswer(cfg, BOX, { woke: true });
    expect(h.probes()).toBe(1);
    h.advance(READY_WAIT.freshMs + 1);
    await h.readiness.awaitAnswer(cfg, BOX);
    expect(h.probes()).toBe(2);
  });

  it("keeps probing a computer the provider calls ready until it answers, and says it was waking meanwhile", async () => {
    const h = harness((at) => at >= h.start + 40_000);
    const phases: string[] = [];
    const answer = await h.readiness.awaitAnswer(cfg, BOX, { woke: true, onPhase: (phase) => phases.push(phase) });
    expect(answer.ok).toBe(true);
    expect(answer.waitedMs).toBeGreaterThanOrEqual(40_000);
    expect(answer.waitedMs).toBeLessThan(READY_WAIT.answerPatienceMs);
    expect(phases).toEqual(["waking"]);
    expect(h.readiness.waitingOn(BOX)).toBeNull();
    expect(h.health.answeredWithin(BOX, 1)).toBe(true);
    expect(h.counters.snapshot(BOX)).toMatchObject({ wakes: 1, restoreWaits: 0 });
  });

  it("gives up after a minute and a half when the provider gives no reason for the silence", async () => {
    const h = harness(() => false);
    h.health.answered(BOX);
    h.advance(READY_WAIT.freshMs + 1);
    const answer = await h.readiness.awaitAnswer(cfg, BOX);
    expect(answer).toMatchObject({ ok: false, phase: "waking" });
    expect(answer.waitedMs).toBeLessThanOrEqual(READY_WAIT.answerPatienceMs + READY_WAIT.probeTimeoutMs);
    expect(answer.waitedMs).toBeGreaterThan(READY_WAIT.answerPatienceMs - READY_WAIT.probeTimeoutMs - READY_WAIT.probeGapMs);
  });

  it("after a wake, waits three minutes with longer and longer gaps before it gives up", async () => {
    const gaps: number[] = [];
    const h = harness(() => false);
    const readiness = createBoatReadiness({
      probe: async () => { h.advance(READY_WAIT.probeTimeoutMs); return false; },
      read: async () => ({ state: "idle", health: "ok" }), health: h.health, counters: h.counters, now: h.now,
      sleep: async (ms) => { gaps.push(ms); h.advance(ms); },
    });
    const answer = await readiness.awaitAnswer(cfg, BOX, { woke: true });
    expect(answer).toMatchObject({ ok: false, phase: "waking" });
    expect(answer.waitedMs).toBeGreaterThan(READY_WAIT.wakePatienceMs - READY_WAIT.probeTimeoutMs - 20_000);
    expect(answer.waitedMs).toBeLessThanOrEqual(READY_WAIT.wakePatienceMs + READY_WAIT.probeTimeoutMs);
    expect(gaps.slice(0, 5)).toEqual([...READY_WAIT.wakeGapsMs]);
    expect(gaps.slice(5).every((gap) => gap === 20_000)).toBe(true);
  });

  it("after a wake, a computer silent for two and a half minutes is still waited for, and answers", async () => {
    const h = harness((at) => at >= h.start + 150_000);
    const answer = await h.readiness.awaitAnswer(cfg, BOX, { woke: true });
    expect(answer.ok).toBe(true);
    expect(answer.waitedMs).toBeGreaterThanOrEqual(150_000);
  });

  it("waits up to ten minutes while the provider says the disk is being restored, and reports that", async () => {
    const restoring = { state: "idle", health: "ok", hydrated: false, lastSnapshotStatus: "in_progress" };
    const slow = harness((at) => at >= slow.start + 6 * 60_000, () => restoring);
    const phases: string[] = [];
    const answer = await slow.readiness.awaitAnswer(cfg, BOX, { woke: true, onPhase: (phase) => phases.push(phase) });
    expect(answer.ok).toBe(true);
    expect(answer.waitedMs).toBeGreaterThanOrEqual(6 * 60_000);
    expect(phases).toEqual(["restoring"]);
    expect(slow.counters.snapshot(BOX)).toMatchObject({ restoreWaits: 1 });

    const never = harness(() => false, () => restoring);
    const gaveUp = await never.readiness.awaitAnswer(cfg, BOX, { woke: true });
    expect(gaveUp).toMatchObject({ ok: false, phase: "restoring" });
    expect(gaveUp.waitedMs).toBeLessThanOrEqual(READY_WAIT.restorePatienceMs + READY_WAIT.probeTimeoutMs);
    expect(gaveUp.waitedMs).toBeGreaterThan(READY_WAIT.answerPatienceMs);
  });

  it("never waits past the caller's deadline, restore or not", async () => {
    const h = harness(() => false, () => ({ hydrated: false }));
    const answer = await h.readiness.awaitAnswer(cfg, BOX, { woke: true, deadline: h.start + 20_000 });
    expect(answer.ok).toBe(false);
    expect(answer.waitedMs).toBeLessThanOrEqual(20_000);
  });

  it("lets the call through when the probe is turned away rather than unanswered", async () => {
    const h = harness(() => null);
    await expect(h.readiness.awaitAnswer(cfg, BOX, { woke: true })).resolves.toMatchObject({ ok: true });
    expect(h.probes()).toBe(1);
    expect(h.health.answeredWithin(BOX, 60_000)).toBe(false);
  });

  it("counts its unanswered probes toward the computer's health, so a silent one is noticed with no command running", async () => {
    const h = harness(() => false);
    const silent: string[] = [];
    h.health.onNotResponding((boxId) => silent.push(boxId));
    await h.readiness.awaitAnswer(cfg, BOX, { woke: true });
    expect(silent).toEqual([BOX]);
    expect(h.health.notRespondingSince(BOX)).not.toBeNull();
  });
});
