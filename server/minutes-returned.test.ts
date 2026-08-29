import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AutonomyTelemetry } from "./autonomy-telemetry.ts";
import { MinutesReturnedLedger } from "./minutes-returned.ts";
import { WorkLockStore } from "./work-lock-store.ts";

const directories: string[] = [];
const stores: Array<{ close(): void }> = [];

function harness() {
  const directory = mkdtempSync(join(tmpdir(), "omb-minutes-returned-"));
  directories.push(directory);
  let now = 1_000;
  const work = new WorkLockStore({ file: join(directory, "work.db"), now: () => now });
  const telemetry = new AutonomyTelemetry({ file: join(directory, "telemetry.db"), now: () => now });
  const ledger = new MinutesReturnedLedger({ file: join(directory, "minutes.db"), now: () => now, workLocks: work, telemetry, settlementWindowMs: 72 });
  stores.push(work, telemetry, ledger);
  return { ledger, work, setNow: (value: number) => { now = value; } };
}

function completedWork(work: WorkLockStore, workId = "work-1"): string {
  const created = work.createObligation({ title: "A bounded job", source: "test", externalId: workId });
  work.recordEvidence(created.obligation.id, { kind: "receipt", reference: `receipt-${workId}`, summary: "Verified by test" });
  work.completeObligation(created.obligation.id);
  return created.obligation.id;
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("MinutesReturnedLedger", () => {
  it("snapshots a configured task price, holds credit for 72 hours, and settles idempotently", () => {
    const { ledger, work, setNow } = harness();
    ledger.configureTaskClass({ taskClass: "browser.workflow", manualMinutes: 30 });
    const workId = completedWork(work);
    const first = ledger.recordOutcome({ workId, taskClass: "browser.workflow", outcomeKind: "qualified", residualInterventions: [{ kind: "approval", minutes: 4 }], idempotencyKey: "outcome-1", submittedAt: 1_000 });
    expect(first.status).toBe("recorded");
    expect(first.outcome).toMatchObject({ manualMinutes: 30, residualMinutes: 4, minutesReturned: 26, status: "pending", settlesAt: 1_072 });
    expect(ledger.summary()).toMatchObject({ minutesReturned: null, pendingOutcomeCount: 1, investmentCoverage: "unavailable" });
    expect(ledger.recordOutcome({ workId, taskClass: "browser.workflow", outcomeKind: "qualified", residualInterventions: [{ kind: "approval", minutes: 4 }], idempotencyKey: "outcome-1", submittedAt: 1_000 }).status).toBe("deduplicated");
    setNow(1_072);
    expect(ledger.settleDue()).toHaveLength(1);
    expect(ledger.summary()).toMatchObject({ minutesReturned: 26, settledOutcomeCount: 1, pendingOutcomeCount: 0 });
  });

  it("requires completed, evidenced work and an explicit configured price", () => {
    const { ledger, work } = harness();
    const created = work.createObligation({ title: "Not complete", source: "test", externalId: "open" });
    expect(() => ledger.recordOutcome({ workId: created.obligation.id, taskClass: "unknown", outcomeKind: "qualified", residualInterventions: [], idempotencyKey: "x" })).toThrowError(expect.objectContaining({ code: "not_completed" }));
    const completeId = completedWork(work, "complete");
    expect(() => ledger.recordOutcome({ workId: completeId, taskClass: "unknown", outcomeKind: "qualified", residualInterventions: [], idempotencyKey: "y" })).toThrowError(expect.objectContaining({ code: "invalid" }));
  });

  it("does not score health checks or empty sweeps, even with a configured price", () => {
    const { ledger, work, setNow } = harness();
    ledger.configureTaskClass({ taskClass: "capture.sweep", manualMinutes: 20 });
    for (const [index, outcomeKind] of (["health_check", "empty_sweep"] as const).entries()) {
      const workId = completedWork(work, `non-scoring-${index}`);
      ledger.recordOutcome({ workId, taskClass: "capture.sweep", outcomeKind, residualInterventions: [{ kind: "none", minutes: 0 }], idempotencyKey: `non-scoring-${index}`, submittedAt: 1_000 });
    }
    setNow(2_000);
    ledger.settleDue();
    expect(ledger.summary()).toMatchObject({ outcomeCount: 2, settledOutcomeCount: 2, minutesReturned: null, investmentCoverage: "unavailable" });
    expect(ledger.summary().byTaskClass[0]).toMatchObject({ taskClass: "capture.sweep", minutesReturned: null });
  });

  it("can retain an unpriced non-scoring health event without inventing value", () => {
    const { ledger, work, setNow } = harness();
    const workId = completedWork(work, "health-without-price");
    const result = ledger.recordOutcome({ workId, taskClass: "new.source", outcomeKind: "health_check", residualInterventions: [], idempotencyKey: "health-without-price", submittedAt: 1_000 });
    expect(result.outcome.manualMinutes).toBe(0);
    setNow(2_000);
    ledger.settleDue();
    expect(ledger.summary().minutesReturned).toBeNull();
  });

  it("requires explicit investment coverage before reporting a multiplier", () => {
    const { ledger, work, setNow } = harness();
    ledger.configureTaskClass({ taskClass: "research.brief", manualMinutes: 60 });
    const first = ledger.recordOutcome({ workId: completedWork(work, "invested"), taskClass: "research.brief", outcomeKind: "qualified", residualInterventions: [{ kind: "review", minutes: 10 }], idempotencyKey: "invested", submittedAt: 1_000 });
    const unobserved = ledger.recordOutcome({ workId: completedWork(work, "unobserved"), taskClass: "research.brief", outcomeKind: "qualified", residualInterventions: [], idempotencyKey: "unobserved", submittedAt: 1_000 });
    ledger.recordInvestment({ outcomeId: first.outcome.id, minutes: 15, idempotencyKey: "investment-1", observedAt: 1_001 });
    setNow(2_000);
    ledger.settleDue();
    expect(ledger.summary()).toMatchObject({ minutesReturned: 110, minutesInvested: 15, multiplier: null, investmentCoverage: "partial" });
    ledger.recordInvestment({ outcomeId: unobserved.outcome.id, minutes: 10, idempotencyKey: "investment-2", observedAt: 2_001 });
    expect(ledger.summary()).toMatchObject({ minutesReturned: 110, minutesInvested: 25, multiplier: 4.4, investmentCoverage: "complete" });
  });

  it("allows reversals and rework to make the current credit negative", () => {
    const { ledger, work, setNow } = harness();
    ledger.configureTaskClass({ taskClass: "calendar.rsvp", manualMinutes: 10 });
    const result = ledger.recordOutcome({ workId: completedWork(work, "reversed"), taskClass: "calendar.rsvp", outcomeKind: "qualified", residualInterventions: [], idempotencyKey: "reversed", submittedAt: 1_000 });
    setNow(2_000);
    ledger.settleDue();
    ledger.recordAdjustment({ outcomeId: result.outcome.id, kind: "reversal", minutes: 12, idempotencyKey: "reversal-1", observedAt: 2_001 });
    ledger.recordAdjustment({ outcomeId: result.outcome.id, kind: "rework", minutes: 3, idempotencyKey: "rework-1", observedAt: 2_002 });
    expect(ledger.summary()).toMatchObject({ minutesReturned: -5 });
    expect(() => ledger.recordAdjustment({ outcomeId: result.outcome.id, kind: "rework", minutes: 3, idempotencyKey: "rework-1", observedAt: 2_002 }).status).not.toThrow();
  });

  it("never accepts a changed idempotent observation", () => {
    const { ledger, work, setNow } = harness();
    ledger.configureTaskClass({ taskClass: "ops.task", manualMinutes: 5 });
    const outcome = ledger.recordOutcome({ workId: completedWork(work, "idempotent"), taskClass: "ops.task", outcomeKind: "qualified", residualInterventions: [], idempotencyKey: "idempotent", submittedAt: 1_000 });
    setNow(2_000);
    ledger.settleDue();
    ledger.recordInvestment({ outcomeId: outcome.outcome.id, minutes: 2, idempotencyKey: "same", observedAt: 2_000 });
    expect(() => ledger.recordInvestment({ outcomeId: outcome.outcome.id, minutes: 3, idempotencyKey: "same", observedAt: 2_000 })).toThrowError(expect.objectContaining({ code: "duplicate_conflict" }));
    expect(() => ledger.recordAdjustment({ outcomeId: outcome.outcome.id, kind: "reversal", minutes: 1, idempotencyKey: "same", observedAt: 2_000 })).toThrowError(expect.objectContaining({ code: "duplicate_conflict" }));
  });

  it("keeps retries idempotent when the observation timestamp was not supplied", () => {
    const { ledger, work, setNow } = harness();
    ledger.configureTaskClass({ taskClass: "ops.task", manualMinutes: 5 });
    const outcome = ledger.recordOutcome({ workId: completedWork(work, "timestamp-retry"), taskClass: "ops.task", outcomeKind: "qualified", residualInterventions: [], idempotencyKey: "timestamp-retry", submittedAt: 1_000 });
    setNow(2_000);
    ledger.settleDue();
    expect(ledger.recordInvestment({ outcomeId: outcome.outcome.id, minutes: 2, idempotencyKey: "timestamp-omitted" }).status).toBe("recorded");
    setNow(2_500);
    expect(ledger.recordInvestment({ outcomeId: outcome.outcome.id, minutes: 2, idempotencyKey: "timestamp-omitted" }).status).toBe("deduplicated");
  });
});
