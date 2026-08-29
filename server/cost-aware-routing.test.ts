import { describe, expect, it } from "vitest";

import {
  CostAwareRouter,
  InMemoryCostRoutingLedger,
  type CostRoutingCandidate,
  type CostRoutingJob,
} from "./cost-aware-routing.ts";

const job: CostRoutingJob = {
  jobId: "job-1",
  batchId: "batch-1",
  engineId: "engine-a",
  model: "cheap",
  contextTokens: 10_000,
  expectedOutputTokens: 2_000,
  qualityBar: 0.8,
};

const cheap: CostRoutingCandidate = {
  engineId: "engine-a",
  model: "cheap",
  pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 2, source: "test-card" },
  qualityScore: 0.82,
};

const expensive: CostRoutingCandidate = {
  engineId: "engine-b",
  model: "expensive",
  pricing: { inputUsdPerMillion: 4, outputUsdPerMillion: 8, source: "test-card" },
  qualityScore: 0.98,
};

describe("cost-aware routing", () => {
  it("predicts a range from model pricing and context size before dispatch", () => {
    const router = new CostAwareRouter({ ledger: new InMemoryCostRoutingLedger() });
    expect(router.predict(job, cheap)).toEqual({
      lowUsd: 0.0098,
      expectedUsd: 0.014,
      highUsd: 0.0182,
      confidence: 0.25,
      sampleCount: 0,
      source: "model-pricing",
    });
  });

  it("chooses the cheapest candidate likely to clear the quality bar", () => {
    const router = new CostAwareRouter({ ledger: new InMemoryCostRoutingLedger(), minimumConfidence: 0.2 });
    const decision = router.choose(job, [expensive, cheap]);
    expect(decision.status).toBe("selected");
    expect(decision.candidate?.model).toBe("cheap");
    expect(decision.ceiling).toBe("within");
  });

  it("uses historical actuals for prediction and recalibrates after a job", () => {
    const ledger = new InMemoryCostRoutingLedger();
    const router = new CostAwareRouter({ ledger, minimumConfidence: 0.2 });
    router.choose(job, [cheap]);
    router.recordOutcome({ jobId: job.jobId, actualUsd: 0.021, verified: true, observedAt: 1_000 });
    const next = router.predict({ ...job, jobId: "job-2" }, cheap);
    expect(next.source).toBe("historical");
    expect(next.expectedUsd).toBe(0.021);
    expect(router.summary().calibration.completedJobs).toBe(1);
  });

  it("escalates only for low confidence or failed verification", () => {
    const ledger = new InMemoryCostRoutingLedger();
    const router = new CostAwareRouter({ ledger });
    const decision = router.choose(job, [cheap]);
    expect(decision.status).toBe("escalated");
    expect(router.recordOutcome({ jobId: job.jobId, actualUsd: 0.014, verified: true })).toEqual({ escalate: false });

    const secondJob = { ...job, jobId: "job-2" };
    router.choose(secondJob, [cheap]);
    expect(router.recordOutcome({ jobId: secondJob.jobId, actualUsd: 0.014, verified: false })).toEqual({
      escalate: true,
      reason: "verification-failed",
    });
  });

  it("reports a visible soft ceiling and blocks only at the hard ceiling", () => {
    const softLedger = new InMemoryCostRoutingLedger();
    const softRouter = new CostAwareRouter({ ledger: softLedger, minimumConfidence: 0.2, ceilings: { softUsd: 0.01, hardUsd: 1 } });
    expect(softRouter.choose(job, [cheap]).ceiling).toBe("soft-exceeded");

    const hardRouter = new CostAwareRouter({ ledger: new InMemoryCostRoutingLedger(), minimumConfidence: 0.2, ceilings: { hardUsd: 0.01 } });
    const blocked = hardRouter.choose(job, [cheap]);
    expect(blocked.status).toBe("blocked");
    expect(blocked.reason).toBe("hard-ceiling");
  });

  it("does not fabricate costs when pricing and history are absent", () => {
    const router = new CostAwareRouter({ ledger: new InMemoryCostRoutingLedger() });
    const decision = router.choose(job, [{ ...cheap, pricing: undefined }]);
    expect(decision.status).toBe("escalated");
    expect(decision.reason).toBe("confidence-low");
    expect(decision.prediction?.source).toBe("unavailable");
    expect(router.summary({ taskId: job.taskId }).allTime.predictedUsd).toBeNull();
  });

  it("does not treat an unknown price as cheaper than a priced candidate", () => {
    const router = new CostAwareRouter({ ledger: new InMemoryCostRoutingLedger(), minimumConfidence: 0.2 });
    const decision = router.choose(job, [{ ...expensive, pricing: undefined }, cheap]);
    expect(decision.candidate?.model).toBe("cheap");
  });
});
