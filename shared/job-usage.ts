/** Native identities bound by the harness, never accepted from model-supplied usage text. */
export interface JobUsageAttribution {
  rootId: string;
  assignmentId: string;
  attemptId: string;
  turnId: string;
}

/** Cached input is a subset of input; absent measurements are unknown, not free. */
export interface TokenObservation {
  input: boolean;
  output: boolean;
  cachedInput: boolean;
}

export interface JobUsageTotals {
  turns: number;
  input: number;
  output: number;
  cachedInput: number;
  totalTokens: number;
  unknownInputTurns: number;
  unknownOutputTurns: number;
  unknownCachedInputTurns: number;
  reportedUsd: number | null;
  estimatedUsd: number | null;
  unknownCostTurns: number;
}

export interface JobAttemptUsage extends JobUsageTotals {
  assignmentId: string;
  attemptId: string;
  botId: string;
  threadId: string;
  status: string;
  outcome?: string;
  startedAt?: number;
  finishedAt?: number;
  state: "observed" | "pending" | "missing" | "not_started";
}

export interface JobUsageObservation extends JobUsageAttribution {
  at: string;
  botId: string;
  instanceId: string;
  driverKind: string;
  model: string;
  input: number | null;
  output: number | null;
  cachedInput: number | null;
  costUsd: number | null;
  costSource: "reported" | "estimated" | null;
}

/** Known sums remain lower bounds when coverage is partial. USD components are never silently combined. */
export interface JobUsageSummary {
  version: 1;
  rootId: string;
  total: JobUsageTotals;
  assignments: number;
  attempts: JobAttemptUsage[];
  observations: JobUsageObservation[];
  coverage: {
    state: "complete" | "partial" | "pending";
    expectedAttempts: number;
    observedAttempts: number;
    missingAttempts: number;
    pendingAttempts: number;
    untrackedExecutions: number;
    scopeComplete: boolean;
    tokens: "complete" | "partial";
    costs: "complete" | "partial";
  };
}
