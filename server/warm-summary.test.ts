import { describe, expect, it } from "vitest";

import {
  createWarmSummary,
  WARM_SUMMARY_GIVE_UP_MS,
  WARM_SUMMARY_IDLE_MS,
  WARM_SUMMARY_RETRY_MS,
  WARM_SUMMARY_SOON_MS,
  type WarmSummaryDeps,
  type WarmSummaryOutcome,
  type WarmSummaryPlan,
  type WarmSummaryTarget,
} from "./warm-summary.ts";

const target: WarmSummaryTarget = { threadId: "t1", botId: "b1", instanceId: "claude" };

/** A manual clock: timers fire only when `advance` passes them. */
function clock() {
  let now = 1_000_000;
  const timers: Array<{ at: number; fn: () => void; cancelled: boolean }> = [];
  return {
    now: () => now,
    after: (ms: number, fn: () => void) => {
      const timer = { at: now + ms, fn, cancelled: false };
      timers.push(timer);
      return { cancel: () => { timer.cancelled = true; } };
    },
    async advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const next = timers.filter((t) => !t.cancelled && t.at <= until).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        now = next.at;
        next.cancelled = true;
        next.fn();
        await new Promise((resolve) => setImmediate(resolve));
      }
      now = until;
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

function setup(overrides: Partial<WarmSummaryDeps> = {}, plan: WarmSummaryPlan | null = { way: "native", soon: false }) {
  const time = clock();
  const runs: Array<{ target: WarmSummaryTarget; plan: WarmSummaryPlan; signal: AbortSignal; awaited: () => boolean; finish: (outcome: WarmSummaryOutcome) => void }> = [];
  const warm = createWarmSummary({
    now: time.now,
    after: time.after,
    plan: () => plan,
    hold: () => null,
    run: (t, p, control) => new Promise((resolve) => { runs.push({ target: t, plan: p, signal: control.signal, awaited: control.awaited, finish: resolve }); }),
    ...overrides,
  });
  return { time, warm, runs };
}

describe("warm summary scheduling", () => {
  it("summarizes a big conversation once it has been idle for a few minutes", async () => {
    const { time, warm, runs } = setup();
    warm.turnCompleted(target, { ok: true, contextTokens: 150_000 });
    await time.advance(WARM_SUMMARY_IDLE_MS - 1);
    expect(runs).toHaveLength(0);
    await time.advance(1);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.target).toEqual(target);
    runs[0]!.finish({ ok: true });
    await time.advance(0);
    expect(warm.state("t1")).toMatchObject({ running: false, last: { outcome: "summarized" } });
  });

  it("starts almost at once when the next turn would summarize anyway", async () => {
    const { time, warm, runs } = setup({}, { way: "native", soon: true });
    warm.turnCompleted(target, { ok: true, contextTokens: 170_000 });
    await time.advance(WARM_SUMMARY_SOON_MS);
    expect(runs).toHaveLength(1);
  });

  it("arms nothing for a conversation that does not qualify, or a turn that failed", async () => {
    const small = setup({}, null);
    small.warm.turnCompleted(target, { ok: true, contextTokens: 20_000 });
    await small.time.advance(WARM_SUMMARY_GIVE_UP_MS);
    expect(small.runs).toHaveLength(0);
    const failed = setup();
    failed.warm.turnCompleted(target, { ok: false, contextTokens: 150_000 });
    await failed.time.advance(WARM_SUMMARY_GIVE_UP_MS);
    expect(failed.runs).toHaveLength(0);
  });

  it("never summarizes while work is due, and lets the next turn arm it again", async () => {
    let reason: { reason: string; retry: boolean } | null = { reason: "a message is waiting for this conversation", retry: false };
    const { time, warm, runs } = setup({ hold: () => reason });
    warm.turnCompleted(target, { ok: true, contextTokens: 150_000 });
    await time.advance(WARM_SUMMARY_GIVE_UP_MS);
    expect(runs).toHaveLength(0);
    expect(warm.state("t1")?.last?.outcome).toBe("skipped: a message is waiting for this conversation");
    reason = null;
    warm.turnCompleted(target, { ok: true, contextTokens: 160_000 });
    await time.advance(WARM_SUMMARY_IDLE_MS);
    expect(runs).toHaveLength(1);
  });

  it("looks again while the bot is busy or a routine is due, until the cache would be cold", async () => {
    let busy = true;
    const { time, warm, runs } = setup({ hold: () => (busy ? { reason: "the bot is busy", retry: true } : null) });
    warm.turnCompleted(target, { ok: true, contextTokens: 150_000 });
    await time.advance(WARM_SUMMARY_IDLE_MS + WARM_SUMMARY_RETRY_MS);
    expect(runs).toHaveLength(0);
    busy = false;
    await time.advance(WARM_SUMMARY_RETRY_MS);
    expect(runs).toHaveLength(1);

    const stuck = setup({ hold: () => ({ reason: "the bot is busy", retry: true }) });
    stuck.warm.turnCompleted(target, { ok: true, contextTokens: 150_000 });
    await stuck.time.advance(WARM_SUMMARY_GIVE_UP_MS * 2);
    expect(stuck.runs).toHaveLength(0);
    expect(stuck.warm.state("t1")?.last?.outcome).toBe("skipped: the bot is busy");
  });

  it("abandons a running summary when a turn starts, and arms nothing until that turn ends", async () => {
    const { time, warm, runs } = setup();
    warm.turnCompleted(target, { ok: true, contextTokens: 150_000 });
    await time.advance(WARM_SUMMARY_IDLE_MS);
    expect(runs).toHaveLength(1);
    warm.turnStarted("t1");
    expect(runs[0]!.signal.aborted).toBe(true);
    runs[0]!.finish({ ok: false, reason: "the summary was interrupted", retry: true });
    await time.advance(WARM_SUMMARY_GIVE_UP_MS);
    expect(runs).toHaveLength(1);
    expect(warm.state("t1")?.last?.outcome).toBe("abandoned: the summary was interrupted");
  });

  it("cancels a summary not yet started when a turn starts", async () => {
    const { time, warm, runs } = setup();
    warm.turnCompleted(target, { ok: true, contextTokens: 150_000 });
    warm.turnStarted("t1");
    await time.advance(WARM_SUMMARY_GIVE_UP_MS);
    expect(runs).toHaveLength(0);
  });

  it("before a turn, abandons a summary the turn did not need, so the person never waits for it", async () => {
    const { time, warm, runs } = setup();
    warm.turnCompleted(target, { ok: true, contextTokens: 150_000 });
    await time.advance(WARM_SUMMARY_IDLE_MS);
    expect(await warm.beforeTurn("t1")).toBe("abandoned");
    expect(runs[0]!.signal.aborted).toBe(true);
    expect(await warm.beforeTurn("t2")).toBe("none");
  });

  it("before a turn that would summarize at its start anyway, waits for the summary already being written", async () => {
    const { time, warm, runs } = setup({}, { way: "native", soon: true });
    warm.turnCompleted(target, { ok: true, contextTokens: 170_000 });
    await time.advance(WARM_SUMMARY_SOON_MS);
    const waiting = warm.beforeTurn("t1");
    await time.advance(0);
    expect(runs[0]!.awaited()).toBe(true);
    expect(runs[0]!.signal.aborted).toBe(false);
    runs[0]!.finish({ ok: true });
    expect(await waiting).toBe("waited");
    // The turn's own start is not a reason to drop the summary it waited for.
    warm.turnStarted("t1");
    expect(runs[0]!.signal.aborted).toBe(false);
  });

  it("stops waiting when the turn is stopped", async () => {
    const { time, warm, runs } = setup({}, { way: "native", soon: true });
    warm.turnCompleted(target, { ok: true, contextTokens: 170_000 });
    await time.advance(WARM_SUMMARY_SOON_MS);
    let wanted = true;
    const waiting = warm.beforeTurn("t1", () => wanted);
    wanted = false;
    expect(await waiting).toBe("gave-up");
    expect(runs[0]!.signal.aborted).toBe(true);
  });

  it("starts a summary the next turn needs as soon as the person opens the conversation", async () => {
    const { time, warm, runs } = setup({}, { way: "native", soon: true });
    warm.turnCompleted(target, { ok: true, contextTokens: 170_000 });
    warm.seen("t1");
    await time.advance(0);
    expect(runs).toHaveLength(1);

    const later = setup();
    later.warm.turnCompleted(target, { ok: true, contextTokens: 150_000 });
    later.warm.seen("t1");
    await later.time.advance(0);
    expect(later.runs).toHaveLength(0);
  });

  it("retries a summary refused because a turn was running, and gives up on a failure", async () => {
    const { time, warm, runs } = setup();
    warm.turnCompleted(target, { ok: true, contextTokens: 150_000 });
    await time.advance(WARM_SUMMARY_IDLE_MS);
    runs[0]!.finish({ ok: false, reason: "a turn is running", retry: true });
    await time.advance(0);
    await time.advance(WARM_SUMMARY_RETRY_MS);
    expect(runs).toHaveLength(2);
    runs[1]!.finish({ ok: false, reason: "the summary failed: overloaded" });
    await time.advance(WARM_SUMMARY_GIVE_UP_MS);
    expect(runs).toHaveLength(2);
    expect(warm.state("t1")?.last?.outcome).toBe("failed: the summary failed: overloaded");
  });

  it("runs its delays faster under a time scale, for fixtures", async () => {
    const { time, warm, runs } = setup({ timeScale: 0.01 });
    warm.turnCompleted(target, { ok: true, contextTokens: 150_000 });
    await time.advance(Math.round(WARM_SUMMARY_IDLE_MS * 0.01));
    expect(runs).toHaveLength(1);
  });
});
