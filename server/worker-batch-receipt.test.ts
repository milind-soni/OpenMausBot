import { describe, expect, it } from "vitest";

import { workerBatchReceiptText } from "./worker-batch-receipt.ts";
import type { WorkerJobRecord } from "./worker-jobs.ts";

function job(patch: Partial<WorkerJobRecord>): WorkerJobRecord {
  return {
    id: "job-1",
    taskId: "thread-1",
    hidden: true,
    status: "completed",
    prompt: "PRIVATE WORKER PROMPT",
    label: "Inventory",
    createdAt: 1,
    ...patch,
  };
}

describe("workerBatchReceiptText", () => {
  it("consolidates all lanes into one receipt without exposing worker prompts", () => {
    const text = workerBatchReceiptText("Today’s Grok audit", [
      job({ id: "one", label: "Inventory", result: "Found 12 tasks." }),
      job({ id: "two", label: "Counterfactual", result: "Centipede saves two approval loops." }),
    ]);

    expect(text).toContain("Parallel work finished: Today’s Grok audit");
    expect(text).toContain("**Inventory**\nFound 12 tasks.");
    expect(text).toContain("**Counterfactual**\nCentipede saves two approval loops.");
    expect(text).not.toContain("PRIVATE WORKER PROMPT");
  });

  it("reports a failed lane honestly in the same receipt", () => {
    const text = workerBatchReceiptText("Deploy checks", [
      job({ id: "one", status: "completed", result: "Guest browser passed." }),
      job({ id: "two", label: "Mobile smoke", status: "failed", error: "Device unavailable" }),
    ]);

    expect(text).toContain("Parallel work needs attention: Deploy checks");
    expect(text).toContain("**Mobile smoke — failed**\nDevice unavailable");
  });

  it("preserves the complete worker result instead of discarding the tail", () => {
    const tail = "TAIL_MUST_SURVIVE";
    const result = `${"x".repeat(7_000)}${tail}`;
    const text = workerBatchReceiptText("Large result", [job({ result })]);

    expect(text).toContain(result);
    expect(text).toContain(tail);
    expect(text).not.toContain("[Result shortened in chat.]");
  });

  it("omits canceled lanes that have no useful result", () => {
    const text = workerBatchReceiptText("Stopped audit", [
      job({ status: "canceled", result: undefined, error: undefined }),
    ]);

    expect(text).toBe("");
  });
});
