import { describe, expect, it } from "vitest";

import type { WorkerBatchProjection } from "../../shared/worker-batch";
import { workerBatchSummary } from "./worker-batches";

function batch(
  patch: Partial<WorkerBatchProjection> & Pick<WorkerBatchProjection, "status" | "terminal">,
): WorkerBatchProjection {
  return {
    id: "batch-1",
    taskId: "thread-1",
    label: "Today’s Grok audit",
    jobs: [],
    counts: { total: 4, queued: 0, running: 2, completed: 2, failed: 0, canceled: 0 },
    createdAt: 1,
    updatedAt: 2,
    ...patch,
  };
}

describe("workerBatchSummary", () => {
  it("makes live progress concrete without exposing worker transcripts", () => {
    expect(workerBatchSummary(batch({ status: "running", terminal: false }))).toBe("2 of 4 complete");
  });

  it("distinguishes queued work from work that is actually moving", () => {
    expect(workerBatchSummary(batch({
      status: "queued",
      terminal: false,
      counts: { total: 3, queued: 3, running: 0, completed: 0, failed: 0, canceled: 0 },
    }))).toBe("3 workers queued");
  });

  it("collapses clean completion to one quiet receipt", () => {
    expect(workerBatchSummary(batch({
      status: "completed",
      terminal: true,
      counts: { total: 4, queued: 0, running: 0, completed: 4, failed: 0, canceled: 0 },
    }))).toBe("4 workers · Done");
  });

  it("keeps failed work visible instead of calling the batch done", () => {
    expect(workerBatchSummary(batch({
      status: "failed",
      terminal: true,
      counts: { total: 4, queued: 0, running: 0, completed: 3, failed: 1, canceled: 0 },
    }))).toBe("3 done · 1 failed");
  });

  it("describes a stopped mixed batch without implying replay is safe", () => {
    expect(workerBatchSummary(batch({
      status: "canceled",
      terminal: true,
      counts: { total: 4, queued: 0, running: 0, completed: 2, failed: 0, canceled: 2 },
    }))).toBe("Stopped · 2 completed · 2 canceled");
  });
});
