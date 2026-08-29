import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AutonomyTelemetry, type AutonomyTelemetryInterface } from "./autonomy-telemetry.ts";

const directories: string[] = [];
const stores: AutonomyTelemetryInterface[] = [];

function harness(options: { maxEvents?: number } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "omb-autonomy-telemetry-"));
  directories.push(directory);
  let now = 1_000;
  const store = new AutonomyTelemetry({ file: join(directory, "telemetry.db"), now: () => now, ...options });
  stores.push(store);
  return { store, setNow: (value: number) => { now = value; } };
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("AutonomyTelemetry", () => {
  it("persists observed events and deduplicates an idempotency key", () => {
    const { store } = harness();
    const first = store.record({ type: "work.started", workId: "work-1", idempotencyKey: "start-1", observedAt: 1_100 });
    const duplicate = store.record({ type: "work.started", workId: "work-1", idempotencyKey: "start-1", observedAt: 1_100 });

    expect(first.status).toBe("recorded");
    expect(duplicate.status).toBe("deduplicated");
    expect(duplicate.event.eventId).toBe(first.event.eventId);
    expect(store.list()).toMatchObject([{ type: "work.started", workId: "work-1", observedAt: 1_100 }]);

    store.close();
    stores.splice(stores.indexOf(store), 1);
    const restarted = new AutonomyTelemetry({ file: join(directories[0]!, "telemetry.db"), now: () => 1_200 });
    stores.push(restarted);
    expect(restarted.list()).toHaveLength(1);
    expect(restarted.record({ type: "work.started", workId: "work-1", idempotencyKey: "start-1", observedAt: 1_100 }).status).toBe("deduplicated");
  });

  it("rejects a reused idempotency key when its observed payload changes", () => {
    const { store } = harness();
    store.record({ type: "work.started", workId: "work-1", idempotencyKey: "same-key" });
    expect(() => store.record({ type: "work.started", workId: "work-2", idempotencyKey: "same-key" })).toThrowError(
      expect.objectContaining({ code: "idempotency_conflict" }),
    );
  });

  it("summarizes only explicitly observed evidence and leaves unavailable metrics null", () => {
    const { store } = harness();
    const record = (event: Parameters<AutonomyTelemetryInterface["record"]>[0]) => store.record(event);
    record({ type: "work.started", workId: "a", idempotencyKey: "a-start", observedAt: 1_000 });
    record({ type: "human.touch", workId: "a", idempotencyKey: "a-touch", touchKind: "review", observedAt: 1_050 });
    record({ type: "approval.requested", workId: "a", idempotencyKey: "a-approval-request", approvalKey: "publish", observedAt: 1_100 });
    record({ type: "approval.decided", workId: "a", idempotencyKey: "a-approval-decision", approvalKey: "publish", decision: "approved", actor: "human", observedAt: 1_150 });
    record({ type: "interruption.classified", workId: "a", idempotencyKey: "a-interrupt", classification: "false", reasonCode: "duplicate-notification", observedAt: 1_200 });
    record({ type: "rework.recorded", workId: "a", idempotencyKey: "a-rework", reasonCode: "review-change", observedAt: 1_250 });
    record({ type: "auth.failure", workId: "a", idempotencyKey: "a-auth", provider: "aws", service: "s3", failureCode: "expired-credential", observedAt: 1_300 });
    record({ type: "cost.reference", workId: "a", idempotencyKey: "a-cost", source: "provider_reported", reference: "billing-1", amountUsd: 0.12, observedAt: 1_400 });
    record({ type: "outcome.verified", workId: "a", idempotencyKey: "a-verified", evidenceRef: "receipt-1", observedAt: 1_500 });
    record({ type: "work.closed", workId: "a", idempotencyKey: "a-close", closureKind: "success", observedAt: 1_800 });
    record({ type: "work.started", workId: "b", idempotencyKey: "b-start", observedAt: 1_100 });
    record({ type: "interruption.classified", workId: "b", idempotencyKey: "b-interrupt", classification: "unknown", observedAt: 1_200 });
    record({ type: "cost.reference", workId: "b", idempotencyKey: "b-cost", source: "estimate", reference: "local-estimate-1", amountUsd: 0.5, observedAt: 1_250 });
    record({ type: "work.closed", workId: "b", idempotencyKey: "b-close", closureKind: "cancelled", observedAt: 1_400 });
    record({ type: "work.closed", workId: "c", idempotencyKey: "c-close", closureKind: "unknown", observedAt: 1_600 });

    expect(store.summary()).toEqual(expect.objectContaining({
      retainedEvents: 15,
      observedWorkCount: 3,
      closedWorkCount: 3,
      verifiedOutcomeCount: 1,
      verifiedOutcomeRate: 1 / 3,
      humanTouchCount: 1,
      approvalRequestCount: 1,
      humanApprovalDecisionCount: 1,
      interruptionClassificationCount: 2,
      falseInterruptionCount: 1,
      falseInterruptionRate: 0.5,
      reworkCount: 1,
      authFailureCount: 1,
      timeToCloseMs: { count: 2, median: 550 },
      cost: { referenceCount: 2, reportedUsd: 0.12, estimatedUsd: 0.5, unavailableUsdReferences: null },
    }));
  });

  it("returns null when no evidence exists, and never infers a false interruption", () => {
    const { store } = harness();
    const summary = store.summary();
    expect(summary.verifiedOutcomeRate).toBeNull();
    expect(summary.falseInterruptionCount).toBeNull();
    expect(summary.falseInterruptionRate).toBeNull();
    expect(summary.reworkCount).toBeNull();
    expect(summary.authFailureCount).toBeNull();
    expect(summary.timeToCloseMs).toEqual({ count: 0, median: null });
    expect(summary.cost).toEqual({ referenceCount: 0, reportedUsd: null, estimatedUsd: null, unavailableUsdReferences: null });
    expect(summary.awsAutonomousVerifiedShare).toEqual({ numerator: null, denominator: null, value: null, coverage: "unavailable" });
  });

  it("computes the AWS autonomous share only after explicit human-interaction coverage", () => {
    const { store } = harness();
    store.record({ type: "work.started", workId: "aws-1", idempotencyKey: "aws-start", workScope: "aws", observedAt: 1_000 });
    store.record({ type: "outcome.verified", workId: "aws-1", idempotencyKey: "aws-verified", evidenceRef: "aws-receipt", observedAt: 1_100 });
    store.record({ type: "work.closed", workId: "aws-1", idempotencyKey: "aws-close", closureKind: "success", observedAt: 1_200 });
    expect(store.summary().awsAutonomousVerifiedShare).toEqual({ numerator: null, denominator: null, value: null, coverage: "partial" });

    store.record({ type: "coverage.asserted", workId: "aws-1", idempotencyKey: "aws-coverage", coverageKind: "human_interactions", coverageStatus: "complete", observedAt: 1_300 });
    expect(store.summary().awsAutonomousVerifiedShare).toEqual({ numerator: 1, denominator: 1, value: 1, coverage: "complete" });
  });

  it("enforces privacy-safe metadata and bounded retention", () => {
    const { store } = harness({ maxEvents: 2 });
    const unsafeMetadata = Object.fromEntries([["prompt", "do not retain"]]);
    expect(() => store.record({ type: "work.started", workId: "safe", idempotencyKey: "unsafe", metadata: unsafeMetadata })).toThrow();
    store.record({ type: "work.started", workId: "safe", idempotencyKey: "one", metadata: { provider: "aws", region: "us-east-1" } });
    store.record({ type: "work.closed", workId: "safe", idempotencyKey: "two", closureKind: "success" });
    store.record({ type: "outcome.verified", workId: "safe", idempotencyKey: "three", evidenceRef: "receipt-2" });

    expect(store.list()).toHaveLength(2);
    expect(store.summary().retention).toEqual(expect.objectContaining({ maxEvents: 2, truncated: true }));
    expect(store.list()[0]?.metadata).toBeNull();
  });
});
