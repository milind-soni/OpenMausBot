import type { BenchmarkResult, EvidenceEvent, RunMetrics } from "./types.ts";

export type BaselineScenario = {
  score: number;
  /** Optional for compatibility with baselines written before evidence
   * quality was introduced. */
  evidenceScore?: number;
  metrics: Pick<RunMetrics, "latencyMs" | "costUsd" | "tokens" | "attempts">;
};

export type BenchmarkBaseline = {
  version: 1;
  createdAt: string;
  scenarios: Readonly<Record<string, BaselineScenario>>;
};

export type ScenarioComparison = {
  scenarioId: string;
  baseline: BaselineScenario | null;
  current: BaselineScenario;
  regressions: readonly string[];
};

export type PromotionDecision = {
  promotable: boolean;
  reasons: readonly string[];
  comparisons: readonly ScenarioComparison[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isScenarioId(value: unknown): value is EvidenceEvent["scenarioId"] {
  return typeof value === "string" && ["product-build-qa", "browser-workflow", "windows-software", "research-decide-draft-execute", "auth-tool-recovery", "unattended-multi-hour", "privacy-approval-boundary"].includes(value);
}

function isActionKind(value: unknown): value is EvidenceEvent["kind"] {
  return typeof value === "string" && ["build", "qa", "browser", "windows", "research", "draft", "execute", "auth", "cursor", "unattended", "privacy", "approval"].includes(value);
}

function isEventStatus(value: unknown): value is EvidenceEvent["status"] {
  return typeof value === "string" && ["ok", "failed", "blocked", "needs-auth", "dry-run"].includes(value);
}

export function createBaseline(results: readonly BenchmarkResult[], createdAt = new Date().toISOString()): BenchmarkBaseline {
  const scenarios: Record<string, BaselineScenario> = {};
  for (const result of results) {
    scenarios[result.scenario.id] = {
      score: result.score,
      evidenceScore: result.evidence.outcomeScore,
      metrics: {
        latencyMs: result.metrics.latencyMs,
        costUsd: result.metrics.costUsd,
        tokens: result.metrics.tokens,
        attempts: result.metrics.attempts,
      },
    };
  }
  return { version: 1, createdAt, scenarios };
}

/** Compare reliability first, then resource usage. A missing baseline is
 * intentionally reported so callers can fail closed instead of silently
 * treating a new scenario as a pass. */
export function compareToBaseline(results: readonly BenchmarkResult[], baseline: BenchmarkBaseline, tolerance = 0.1): readonly ScenarioComparison[] {
  if (tolerance < 0 || tolerance >= 1) throw new Error("baseline tolerance must be in [0, 1)");
  return results.map((result) => {
    const current: BaselineScenario = {
      score: result.score,
      evidenceScore: result.evidence.outcomeScore,
      metrics: {
        latencyMs: result.metrics.latencyMs,
        costUsd: result.metrics.costUsd,
        tokens: result.metrics.tokens,
        attempts: result.metrics.attempts,
      },
    };
    const previous = baseline.scenarios[result.scenario.id] ?? null;
    if (!previous) return { scenarioId: result.scenario.id, baseline: null, current, regressions: ["missing-baseline"] };
    const regressions: string[] = [];
    if (current.score < previous.score - (100 * tolerance)) regressions.push(`score<${previous.score.toFixed(2)}%`);
    if (previous.evidenceScore !== undefined && current.evidenceScore !== undefined && current.evidenceScore < previous.evidenceScore - (100 * tolerance)) regressions.push("evidence-regression");
    if (current.metrics.latencyMs > previous.metrics.latencyMs * (1 + tolerance)) regressions.push("latency-regression");
    if (current.metrics.costUsd > previous.metrics.costUsd * (1 + tolerance)) regressions.push("cost-regression");
    if (current.metrics.tokens > previous.metrics.tokens * (1 + tolerance)) regressions.push("token-regression");
    if (current.metrics.attempts > previous.metrics.attempts * (1 + tolerance)) regressions.push("attempt-regression");
    return { scenarioId: result.scenario.id, baseline: previous, current, regressions };
  });
}

/** Promotion is deliberately conservative: one failed scenario, one safety
 * violation, one budget breach, a dry-run event, or missing baseline blocks. */
export function evaluatePromotionGate(results: readonly BenchmarkResult[], baseline?: BenchmarkBaseline, tolerance = 0.1): PromotionDecision {
  const reasons: string[] = [];
  if (results.length === 0) reasons.push("no-results");
  if (!baseline) reasons.push("baseline-required");
  const comparisons = baseline ? compareToBaseline(results, baseline, tolerance) : [];
  for (const result of results) {
    if (!result.passed) reasons.push(`${result.scenario.id}:scenario-failed`);
    if (result.metrics.safetyViolations > 0) reasons.push(`${result.scenario.id}:safety-violation`);
    for (const violation of result.metrics.budgetViolations) reasons.push(`${result.scenario.id}:budget:${violation}`);
    if (result.events.some((event) => event.status === "dry-run")) reasons.push(`${result.scenario.id}:dry-run-evidence`);
    if (!result.evidence.e2eVerified) reasons.push(`${result.scenario.id}:evidence-unverified`);
  }
  for (const comparison of comparisons) {
    for (const regression of comparison.regressions) reasons.push(`${comparison.scenarioId}:${regression}`);
  }
  return { promotable: reasons.length === 0, reasons, comparisons };
}

export function isBenchmarkBaseline(value: unknown): value is BenchmarkBaseline {
  if (!isRecord(value)) return false;
  return value.version === 1 && typeof value.createdAt === "string" && isRecord(value.scenarios);
}

export function isEvidenceEvent(value: unknown): value is EvidenceEvent {
  if (!isRecord(value)) return false;
  return typeof value.id === "string" && isScenarioId(value.scenarioId) && typeof value.actionId === "string" && isActionKind(value.kind) && isEventStatus(value.status) && typeof value.attempt === "number" && typeof value.timestampMs === "number" && typeof value.latencyMs === "number" && typeof value.costUsd === "number" && typeof value.tokens === "number" && (value.agentId === undefined || typeof value.agentId === "string") && isRecord(value.data);
}
