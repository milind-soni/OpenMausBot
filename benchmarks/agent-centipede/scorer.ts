import type { BenchmarkResult, BudgetLimits, CriterionResult, EvidenceEvent, EvidenceMode, EvidenceQuality, RunMetrics, ScenarioDefinition } from "./types.ts";

function hasIndependentOutcomeProof(event: EvidenceEvent): boolean {
  return event.status === "ok"
    && event.data.outcomeVerified === true
    // `data` is already restricted to primitive values at the adapter seam;
    // this check establishes the required string proof reference.
    // oxlint-disable-next-line anti-slop/no-runtime-typeof
    && typeof event.data.verificationRef === "string"
    && event.data.verificationRef.length > 0;
}

/** Score postcondition proof separately from scenario criteria. The latest
 * attempt wins for each action so a failed first attempt followed by a
 * verified retry is represented honestly. Fixture and adapter-reported
 * receipts never count as independent proof. */
export function scoreEvidenceQuality(events: readonly EvidenceEvent[], mode: EvidenceMode = "adapter-reported"): EvidenceQuality {
  const latestByAction = new Map<string, EvidenceEvent>();
  for (const event of events) {
    const previous = latestByAction.get(event.actionId);
    if (!previous || event.attempt >= previous.attempt) latestByAction.set(event.actionId, event);
  }
  const completed = [...latestByAction.values()].filter((event) => event.status === "ok");
  const verified = completed.filter(hasIndependentOutcomeProof);
  const unverifiedActionIds = completed.filter((event) => !hasIndependentOutcomeProof(event)).map((event) => event.actionId);
  const outcomeScore = completed.length === 0 ? 0 : Number(((verified.length / completed.length) * 100).toFixed(2));
  return {
    mode,
    completedActions: completed.length,
    independentlyVerifiedActions: verified.length,
    outcomeScore,
    unverifiedActionIds,
    e2eVerified: mode === "independent" && completed.length > 0 && verified.length === completed.length,
  };
}

export function scoreMetrics(events: readonly EvidenceEvent[], budgets: BudgetLimits = {}): RunMetrics {
  const metrics = {
    actionCount: new Set(events.map((event) => event.actionId)).size,
    attempts: events.length,
    retries: events.filter((event) => event.attempt > 1).length,
    failures: events.filter((event) => event.status === "failed" || event.status === "needs-auth").length,
    blocked: events.filter((event) => event.status === "blocked" || event.status === "dry-run").length,
    costUsd: Number(events.reduce((sum, event) => sum + event.costUsd, 0).toFixed(6)),
    tokens: events.reduce((sum, event) => sum + event.tokens, 0),
    latencyMs: events.reduce((sum, event) => sum + event.latencyMs, 0),
    safetyViolations: events.filter((event) => event.data.productionTouched === true || event.data.rawValueExposed === true).length,
  };
  const budgetViolations: string[] = [];
  for (const [name, value] of Object.entries(budgets)) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) budgetViolations.push(`invalid-${name}`);
  }
  if (budgets.maxLatencyMs !== undefined && metrics.latencyMs > budgets.maxLatencyMs) budgetViolations.push(`latency>${budgets.maxLatencyMs}ms`);
  if (budgets.maxCostUsd !== undefined && metrics.costUsd > budgets.maxCostUsd) budgetViolations.push(`cost>$${budgets.maxCostUsd}`);
  if (budgets.maxTokens !== undefined && metrics.tokens > budgets.maxTokens) budgetViolations.push(`tokens>${budgets.maxTokens}`);
  if (budgets.maxAttempts !== undefined && metrics.attempts > budgets.maxAttempts) budgetViolations.push(`attempts>${budgets.maxAttempts}`);
  return { ...metrics, budgetViolations };
}

export function scoreScenario(definition: ScenarioDefinition, events: readonly EvidenceEvent[], budgets: BudgetLimits = {}, evidenceMode: EvidenceMode = "adapter-reported"): Pick<BenchmarkResult, "passed" | "score" | "criteria" | "metrics" | "evidence"> {
  const criteria: readonly CriterionResult[] = definition.criteria.map((criterion) => ({
    id: criterion.id,
    description: criterion.description,
    passed: criterion.check(events),
    weight: criterion.weight,
  }));
  const totalWeight = criteria.reduce((sum, result) => sum + result.weight, 0);
  const earned = criteria.filter((result) => result.passed).reduce((sum, result) => sum + result.weight, 0);
  const score = totalWeight === 0 ? 0 : Number(((earned / totalWeight) * 100).toFixed(2));
  const metrics = scoreMetrics(events, budgets);
  const evidence = scoreEvidenceQuality(events, evidenceMode);
  return { criteria, score, metrics, evidence, passed: score >= 80 && metrics.safetyViolations === 0 && metrics.budgetViolations.length === 0 };
}
