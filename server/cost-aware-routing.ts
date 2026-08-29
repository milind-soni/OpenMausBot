import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import { z } from "zod";

import type { ModelPricing } from "../shared/model-pricing.ts";
import { writeFileAtomic } from "./atomic.ts";

export interface CostRange {
  readonly lowUsd: number;
  readonly expectedUsd: number;
  readonly highUsd: number;
  readonly confidence: number;
  readonly sampleCount: number;
  readonly source: "model-pricing" | "historical" | "unavailable";
}

export interface CostRoutingCandidate {
  readonly engineId: string;
  readonly model: string;
  readonly pricing?: ModelPricing;
  readonly qualityScore: number;
}

export interface CostRoutingJob {
  readonly jobId: string;
  readonly batchId?: string;
  readonly taskId?: string;
  readonly engineId: string;
  readonly model: string;
  readonly contextTokens: number;
  readonly expectedOutputTokens: number;
  readonly qualityBar: number;
}

export interface CostCeilings {
  readonly softUsd?: number;
  readonly hardUsd?: number;
  readonly dailyUsd?: number;
}

export type CostCeilingStatus = "within" | "soft-exceeded" | "hard-exceeded" | "unknown";

export interface CostRoutingDecision {
  readonly status: "selected" | "escalated" | "blocked";
  readonly candidate?: CostRoutingCandidate;
  readonly prediction?: CostRange;
  readonly qualityProbability?: number;
  readonly ceiling: CostCeilingStatus;
  readonly reason?: "confidence-low" | "quality-bar-unmet" | "hard-ceiling" | "cost-unknown";
}

export interface CostRoutingOutcome {
  readonly jobId: string;
  readonly actualUsd?: number;
  readonly verified: boolean;
  readonly observedAt?: number;
}

export interface CostCalibration {
  readonly jobId: string;
  readonly batchId?: string;
  readonly taskId?: string;
  readonly engineId: string;
  readonly model: string;
  readonly predicted: CostRange | null;
  readonly actualUsd: number | null;
  readonly verified: boolean | null;
  readonly observedAt: number;
}

export interface CostTotals {
  readonly jobs: number;
  readonly predictedUsd: number | null;
  readonly actualUsd: number | null;
  readonly verifiedJobs: number;
}

export interface CostRoutingSummary {
  readonly batch: CostTotals;
  readonly daily: CostTotals;
  readonly allTime: CostTotals;
  readonly calibration: {
    readonly completedJobs: number;
    readonly meanAbsoluteErrorUsd: number | null;
    readonly meanAbsolutePercentageError: number | null;
  };
}

export interface CostRoutingLedger {
  list(): readonly CostCalibration[];
  recordPrediction(job: CostRoutingJob, prediction: CostRange): void;
  recordOutcome(outcome: CostRoutingOutcome): void;
}

const rangeSchema = z.object({
  lowUsd: z.number().finite().min(0),
  expectedUsd: z.number().finite().min(0),
  highUsd: z.number().finite().min(0),
  confidence: z.number().finite().min(0).max(1),
  sampleCount: z.number().int().min(0),
  source: z.enum(["model-pricing", "historical", "unavailable"]),
});
const calibrationSchema = z.object({
  jobId: z.string().min(1),
  batchId: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
  engineId: z.string().min(1),
  model: z.string().min(1),
  predicted: rangeSchema.nullable(),
  actualUsd: z.number().finite().min(0).nullable(),
  verified: z.boolean().nullable(),
  observedAt: z.number().finite(),
});
const fileSchema = z.array(calibrationSchema);

function finiteNonNegative(value: number): number | null {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function bounded(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index] ?? null;
}

function dayKey(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function modeledCost(job: CostRoutingJob, pricing: ModelPricing): number | null {
  const inputRate = finiteNonNegative(pricing.inputUsdPerMillion);
  const outputRate = finiteNonNegative(pricing.outputUsdPerMillion);
  if (inputRate === null || outputRate === null) return null;
  return (job.contextTokens * inputRate + job.expectedOutputTokens * outputRate) / 1_000_000;
}

function rangeFromHistory(values: readonly number[]): CostRange {
  const expectedUsd = percentile(values, 0.5) ?? 0;
  const lowUsd = percentile(values, 0.25) ?? expectedUsd;
  const highUsd = percentile(values, 0.75) ?? expectedUsd;
  return {
    lowUsd,
    expectedUsd,
    highUsd: Math.max(expectedUsd, highUsd),
    confidence: Math.min(0.98, 0.45 + values.length * 0.08),
    sampleCount: values.length,
    source: "historical",
  };
}

export class InMemoryCostRoutingLedger implements CostRoutingLedger {
  private records: CostCalibration[] = [];

  list(): readonly CostCalibration[] {
    return this.records.map((record) => structuredClone(record));
  }

  recordPrediction(job: CostRoutingJob, prediction: CostRange): void {
    const existing = this.records.find((record) => record.jobId === job.jobId);
    if (existing) {
      if (existing.engineId !== job.engineId || existing.model !== job.model) {
        throw new Error(`cost prediction already belongs to a different route: ${job.jobId}`);
      }
      this.records = this.records.map((record) => record.jobId === job.jobId
        ? { ...record, predicted: structuredClone(prediction) }
        : record);
      return;
    }
    this.records.push({
      jobId: job.jobId,
      ...(job.batchId ? { batchId: job.batchId } : {}),
      ...(job.taskId ? { taskId: job.taskId } : {}),
      engineId: job.engineId,
      model: job.model,
      predicted: structuredClone(prediction),
      actualUsd: null,
      verified: null,
      observedAt: Date.now(),
    });
  }

  recordOutcome(outcome: CostRoutingOutcome): void {
    const record = this.records.find((candidate) => candidate.jobId === outcome.jobId);
    if (!record) throw new Error(`cost prediction not found: ${outcome.jobId}`);
    if (record.actualUsd !== null) return;
    this.records = this.records.map((candidate) => candidate.jobId === outcome.jobId
      ? {
          ...candidate,
          actualUsd: outcome.actualUsd === undefined ? null : finiteNonNegative(outcome.actualUsd),
          verified: outcome.verified,
          observedAt: outcome.observedAt ?? Date.now(),
        }
      : candidate);
  }
}

export class JsonCostRoutingLedger implements CostRoutingLedger {
  private readonly path: string;
  private readonly memory: InMemoryCostRoutingLedger;

  constructor(path: string) {
    this.path = path;
    this.memory = new InMemoryCostRoutingLedger();
    if (!existsSync(path)) return;
    try {
      const parsed = fileSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
      if (parsed.success) {
        for (const record of parsed.data) this.memoryImport(record);
      }
    } catch {
      // An optional cost receipt file must not prevent the app from starting.
    }
  }

  list(): readonly CostCalibration[] {
    return this.memory.list();
  }

  recordPrediction(job: CostRoutingJob, prediction: CostRange): void {
    this.memory.recordPrediction(job, prediction);
    this.save();
  }

  recordOutcome(outcome: CostRoutingOutcome): void {
    this.memory.recordOutcome(outcome);
    this.save();
  }

  private memoryImport(record: CostCalibration): void {
    this.memory.recordPrediction({
      jobId: record.jobId,
      ...(record.batchId ? { batchId: record.batchId } : {}),
      ...(record.taskId ? { taskId: record.taskId } : {}),
      engineId: record.engineId,
      model: record.model,
      contextTokens: 0,
      expectedOutputTokens: 0,
      qualityBar: 0,
    }, record.predicted ?? {
      lowUsd: 0,
      expectedUsd: 0,
      highUsd: 0,
      confidence: 0,
      sampleCount: 0,
      source: "unavailable",
    });
    if (record.actualUsd !== null && record.verified !== null) {
      this.memory.recordOutcome({ jobId: record.jobId, actualUsd: record.actualUsd, verified: record.verified, observedAt: record.observedAt });
    }
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileAtomic(this.path, JSON.stringify(this.memory.list(), null, 2), { mode: 0o600 });
  }
}

export interface CostAwareRouterOptions {
  readonly ledger: CostRoutingLedger;
  readonly ceilings?: CostCeilings;
  readonly minimumConfidence?: number;
  readonly now?: () => number;
}

export class CostAwareRouter {
  private readonly ledger: CostRoutingLedger;
  private readonly ceilings: CostCeilings;
  private readonly minimumConfidence: number;
  private readonly now: () => number;

  constructor(options: CostAwareRouterOptions) {
    this.ledger = options.ledger;
    this.ceilings = options.ceilings ?? {};
    this.minimumConfidence = bounded(options.minimumConfidence ?? 0.6);
    this.now = options.now ?? Date.now;
  }

  predict(job: CostRoutingJob, candidate: CostRoutingCandidate): CostRange {
    const history = this.ledger.list()
      .filter((record) => record.engineId === candidate.engineId && record.model === candidate.model && record.actualUsd !== null)
      .map((record) => record.actualUsd)
      .filter((value): value is number => value !== null);
    if (history.length > 0) return rangeFromHistory(history);
    const modeled = candidate.pricing === undefined ? null : modeledCost(job, candidate.pricing);
    if (modeled === null) {
      return { lowUsd: 0, expectedUsd: 0, highUsd: 0, confidence: 0, sampleCount: 0, source: "unavailable" };
    }
    return {
      lowUsd: modeled * 0.7,
      expectedUsd: modeled,
      highUsd: modeled * 1.3,
      confidence: 0.25,
      sampleCount: 0,
      source: "model-pricing",
    };
  }

  choose(job: CostRoutingJob, candidates: readonly CostRoutingCandidate[]): CostRoutingDecision {
    const ranked = candidates
      .map((candidate) => {
        const prediction = this.predict(job, candidate);
        const matching = this.ledger.list().filter((record) => record.engineId === candidate.engineId && record.model === candidate.model && record.verified !== null);
        const historicalQuality = matching.length === 0
          ? candidate.qualityScore
          : matching.filter((record) => record.verified === true).length / matching.length;
        const qualityProbability = bounded(matching.length === 0 ? candidate.qualityScore : (historicalQuality + candidate.qualityScore) / 2);
        return { candidate, prediction, qualityProbability };
      })
      .sort((left, right) => {
        const leftUnavailable = left.prediction.source === "unavailable" ? 1 : 0;
        const rightUnavailable = right.prediction.source === "unavailable" ? 1 : 0;
        return leftUnavailable - rightUnavailable || left.prediction.expectedUsd - right.prediction.expectedUsd;
      });
    const likely = ranked.filter((item) => item.qualityProbability >= job.qualityBar);
    const chosen = likely.find((item) => item.prediction.confidence >= this.minimumConfidence) ?? likely[0];
    if (!chosen) {
      const strongest = [...ranked].sort((left, right) => right.qualityProbability - left.qualityProbability)[0];
      if (!strongest) return { status: "blocked", ceiling: "unknown", reason: "quality-bar-unmet" };
      const ceiling = this.ceilingFor(strongest.prediction);
      if (ceiling === "hard-exceeded") return { status: "blocked", candidate: strongest.candidate, prediction: strongest.prediction, qualityProbability: strongest.qualityProbability, ceiling, reason: "hard-ceiling" };
      this.ledger.recordPrediction({ ...job, engineId: strongest.candidate.engineId, model: strongest.candidate.model }, strongest.prediction);
      return { status: "escalated", candidate: strongest.candidate, prediction: strongest.prediction, qualityProbability: strongest.qualityProbability, ceiling, reason: strongest.prediction.confidence < this.minimumConfidence ? "confidence-low" : "quality-bar-unmet" };
    }
    const ceiling = this.ceilingFor(chosen.prediction);
    if (ceiling === "hard-exceeded") return { status: "blocked", candidate: chosen.candidate, prediction: chosen.prediction, qualityProbability: chosen.qualityProbability, ceiling, reason: "hard-ceiling" };
    this.ledger.recordPrediction({ ...job, engineId: chosen.candidate.engineId, model: chosen.candidate.model }, chosen.prediction);
    return {
      status: chosen.prediction.confidence < this.minimumConfidence ? "escalated" : "selected",
      candidate: chosen.candidate,
      prediction: chosen.prediction,
      qualityProbability: chosen.qualityProbability,
      ceiling,
      ...(chosen.prediction.confidence < this.minimumConfidence ? { reason: "confidence-low" } : {}),
    };
  }

  recordOutcome(outcome: CostRoutingOutcome): { readonly escalate: boolean; readonly reason?: "verification-failed" | "cost-unavailable" } {
    this.ledger.recordOutcome(outcome);
    if (!outcome.verified) return { escalate: true, reason: "verification-failed" };
    if (outcome.actualUsd === undefined || finiteNonNegative(outcome.actualUsd) === null) return { escalate: true, reason: "cost-unavailable" };
    return { escalate: false };
  }

  summary(options: { batchId?: string; taskId?: string } = {}, now = this.now()): CostRoutingSummary {
    const records = this.ledger.list();
    const totals = (selected: readonly CostCalibration[]): CostTotals => ({
      jobs: selected.length,
      predictedUsd: selected.some((record) => record.predicted?.source !== "unavailable")
        ? selected.reduce((sum, record) => sum + (record.predicted?.source === "unavailable" ? 0 : record.predicted?.expectedUsd ?? 0), 0)
        : null,
      actualUsd: selected.some((record) => record.actualUsd !== null) ? selected.reduce((sum, record) => sum + (record.actualUsd ?? 0), 0) : null,
      verifiedJobs: selected.filter((record) => record.verified === true).length,
    });
    const today = dayKey(now);
    const completed = records.filter((record) => record.actualUsd !== null && record.predicted !== null);
    const errors = completed.map((record) => ({
      absolute: Math.abs((record.actualUsd ?? 0) - (record.predicted?.expectedUsd ?? 0)),
      percentage: record.actualUsd === 0 ? null : Math.abs((record.actualUsd ?? 0) - (record.predicted?.expectedUsd ?? 0)) / (record.actualUsd ?? 1),
    }));
    const percentages = errors.map((error) => error.percentage).filter((value): value is number => value !== null);
    return {
      batch: totals(options.batchId === undefined && options.taskId === undefined
        ? []
        : records.filter((record) => (options.batchId === undefined || record.batchId === options.batchId) && (options.taskId === undefined || record.taskId === options.taskId))),
      daily: totals(records.filter((record) => dayKey(record.observedAt) === today)),
      allTime: totals(records),
      calibration: {
        completedJobs: completed.length,
        meanAbsoluteErrorUsd: errors.length === 0 ? null : errors.reduce((sum, error) => sum + error.absolute, 0) / errors.length,
        meanAbsolutePercentageError: percentages.length === 0 ? null : percentages.reduce((sum, value) => sum + value, 0) / percentages.length,
      },
    };
  }

  private ceilingFor(prediction: CostRange): CostCeilingStatus {
    if (prediction.source === "unavailable") return "unknown";
    const records = this.ledger.list();
    const actual = records.reduce((sum, record) => sum + (record.actualUsd ?? 0), 0);
    const daily = records.filter((record) => dayKey(record.observedAt) === dayKey(this.now())).reduce((sum, record) => sum + (record.actualUsd ?? 0), 0);
    if ((this.ceilings.hardUsd !== undefined && actual + prediction.highUsd > this.ceilings.hardUsd)
      || (this.ceilings.dailyUsd !== undefined && daily + prediction.highUsd > this.ceilings.dailyUsd)) return "hard-exceeded";
    if (this.ceilings.softUsd !== undefined && actual + prediction.expectedUsd > this.ceilings.softUsd) return "soft-exceeded";
    return "within";
  }
}
