import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createExecutionLearning,
  type OutcomeRecord,
  type RetrospectiveReview,
} from "./execution-learning.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function record(outcomeId: string, statement = "Use the previously verified safe route."): OutcomeRecord {
  return {
    recordId: `record:${outcomeId}:v1`,
    links: {
      inputContextId: `input:${outcomeId}:v1`,
      executionTraceId: `trace:${outcomeId}:v1`,
      verifiedOutputId: `verified:${outcomeId}:v1`,
      retrospectiveId: `retrospective:${outcomeId}:v1`,
      contractId: `${outcomeId}:v1`,
      contractVersion: 1,
      workIds: [`work:${outcomeId}`],
      evidenceIds: [`evidence:${outcomeId}`],
    },
    inputContext: {
      id: `input:${outcomeId}:v1`,
      outcomeId,
      contractId: `${outcomeId}:v1`,
      contractVersion: 1,
      contextRefs: ["context:fixture"],
      evidenceRefs: [`evidence:${outcomeId}`],
      presumedOutcome: "A verified result",
      presumedOutcomeHash: "a".repeat(64),
    },
    executionTrace: {
      id: `trace:${outcomeId}:v1`,
      outcomeId,
      contractId: `${outcomeId}:v1`,
      contractVersion: 1,
      traceIdentity: `trace-identity:${outcomeId}`,
      complete: true,
      entries: [{ seq: 1, at: 1_000, phase: "verification", action: "verified-output", refs: [`evidence:${outcomeId}`], detail: statement }],
    },
    verifiedOutput: {
      id: `verified:${outcomeId}:v1`,
      outcomeId,
      contractId: `${outcomeId}:v1`,
      contractVersion: 1,
      traceIdentity: `trace-identity:${outcomeId}`,
      status: "independently-verified",
      evidenceRefs: [`evidence:${outcomeId}`],
      artifactRefs: [`artifact:${outcomeId}`],
      criteriaHash: "b".repeat(64),
      verifiedAt: 2_000,
      usage: { costCents: 4, units: 2 },
    },
    retrospective: {
      id: `retrospective:${outcomeId}:v1`,
      outcomeId,
      contractId: `${outcomeId}:v1`,
      contractVersion: 1,
      traceIdentity: `trace-identity:${outcomeId}`,
      metrics: [],
      alternatives: [{ id: "route:known-safe", statement, evidenceRefs: [`trace:${outcomeId}:v1`], selected: false }],
      learnings: [{ id: `learning:${outcomeId}:v1`, statement, boundedEffect: "routing-only", evidenceRefs: [`trace:${outcomeId}:v1`] }],
      trusted: true,
    },
  };
}

describe("execution learning seam", () => {
  it("persists only verified records, keeps retrospective values typed, and changes routing only", () => {
    const directory = mkdtempSync(join(tmpdir(), "centipede-learning-"));
    directories.push(directory);
    const learning = createExecutionLearning({ file: join(directory, "learning.json") });

    expect(learning.record(record("first"))).toBe(true);
    const review = learning.review("first");
    expect(review?.trusted).toBe(true);
    expect(review?.metrics.every((metric: RetrospectiveReview["metrics"][number]) => ["measured", "derived", "unknown", "not-applicable"].includes(metric.value.status))).toBe(true);
    expect(review?.metrics.find((metric) => metric.name === "aws")?.value.status).toBe("unknown");
    expect(learning.chooseRoute({ outcomeId: "later", taskId: "task-1", candidates: ["default", "known-safe"] })).toEqual("known-safe");
    const restarted = createExecutionLearning({ file: join(directory, "learning.json") });
    expect(restarted.review("first")).toEqual(review);
    expect(restarted.chooseRoute({ outcomeId: "later", taskId: "task-1", candidates: ["default", "known-safe"] })).toBe("known-safe");
    expect(JSON.stringify(JSON.parse(readFileSync(join(directory, "learning.json"), "utf8")))).not.toContain("password");
  });
});
