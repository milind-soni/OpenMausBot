/** Types for the offline Agent Centipede benchmark lab. */

export type ScenarioId =
  | "product-build-qa"
  | "browser-workflow"
  | "windows-software"
  | "research-decide-draft-execute"
  | "auth-tool-recovery"
  | "unattended-multi-hour"
  | "privacy-approval-boundary";

export type ActionKind =
  | "build"
  | "qa"
  | "browser"
  | "windows"
  | "research"
  | "draft"
  | "execute"
  | "auth"
  | "cursor"
  | "unattended"
  | "privacy"
  | "approval";

export type EventStatus = "ok" | "failed" | "blocked" | "needs-auth" | "dry-run";

/** Describes how an outcome was obtained. This is intentionally separate from
 * an event's status: an adapter saying `ok` is not independent proof that the
 * requested outcome exists in the target system. */
export type EvidenceMode = "fixture" | "adapter-reported" | "independent";

export type EvidenceEvent = {
  id: string;
  scenarioId: ScenarioId;
  actionId: string;
  kind: ActionKind;
  status: EventStatus;
  attempt: number;
  timestampMs: number;
  latencyMs: number;
  costUsd: number;
  /** Provider-reported token usage. Fixture adapters may leave this at zero. */
  tokens: number;
  /** Agent selected by the topology router, when a topology is under test. */
  agentId?: string;
  data: Record<string, string | number | boolean | null>;
};

export type SandboxPaths = {
  root: string;
  marker: string;
  profile: string;
  storage: string;
  database: string;
  config: string;
  sourceCursors: string;
  fixtures: string;
  traces: string;
};

export type BenchmarkSandbox = {
  paths: SandboxPaths;
  env: Readonly<Record<string, string>>;
  dispose: () => Promise<void>;
};

/** Explicit boundary required by live adapters. Never infer these paths from
 * the production app; callers must opt into a disposable benchmark root. */
export type SandboxProfile = {
  profileDir: string;
  dataRoot: string;
  traceDir: string;
  dryRun: boolean;
  allowNetwork?: boolean;
};

export type ScenarioAction = {
  id: string;
  kind: ActionKind;
  target: string;
  latencyMs: number;
  costUsd: number;
  sideEffect?: boolean;
  requiresApproval?: boolean;
  /** Assigned by the benchmark topology router; scenario definitions stay topology-neutral. */
  agentId?: string;
  failure?: "once" | "always";
  data?: Record<string, string | number | boolean | null>;
};

export type EvidenceCriterion = {
  id: string;
  description: string;
  weight: number;
  check: (events: readonly EvidenceEvent[]) => boolean;
};

export type ScenarioDefinition = {
  id: ScenarioId;
  title: string;
  description: string;
  tags: readonly string[];
  actions: readonly ScenarioAction[];
  criteria: readonly EvidenceCriterion[];
  maxRetries?: number;
};

export type RunOptions = {
  dryRun?: boolean;
  maxRetries?: number;
  approvedActionIds?: readonly string[];
  clockStartMs?: number;
  /** Use a real adapter only when this is explicitly provided. */
  adapter?: BenchmarkAdapter;
  adapterFactory?: (sandbox: BenchmarkSandbox) => BenchmarkAdapter;
  budgets?: BudgetLimits;
  retainSandbox?: boolean;
  /** Optional topology to use when routing scenario actions. */
  topology?: import("./topologies.ts").AgentTopology;
};

export type RunMetrics = {
  actionCount: number;
  attempts: number;
  retries: number;
  failures: number;
  blocked: number;
  costUsd: number;
  tokens: number;
  latencyMs: number;
  safetyViolations: number;
  budgetViolations: readonly string[];
};

export type BudgetLimits = {
  maxLatencyMs?: number;
  maxCostUsd?: number;
  maxTokens?: number;
  maxAttempts?: number;
};

export type BenchmarkAdapter = {
  readonly name: string;
  /** Fixture and live adapters must declare the strength of their evidence.
   * Built-in live adapters are adapter-reported; independent mode is only
   * appropriate for a caller that actually performs a fresh postcondition
   * read and emits verificationRef/outcomeVerified on each completed action. */
  readonly evidenceMode?: EvidenceMode;
  readonly events: readonly EvidenceEvent[];
  /** Live adapters must be rebound to the disposable sandbox before use. */
  readonly requiresSandboxBinding?: boolean;
  readonly bindSandbox?: (sandbox: BenchmarkSandbox) => void;
  perform: (scenarioId: ScenarioId, action: ScenarioAction, attempt: number) => Promise<EvidenceEvent> | EvidenceEvent;
  dispose?: () => Promise<void>;
};

export type CriterionResult = {
  id: string;
  description: string;
  passed: boolean;
  weight: number;
};

export type EvidenceQuality = {
  mode: EvidenceMode;
  completedActions: number;
  independentlyVerifiedActions: number;
  /** Percentage of completed actions backed by independent postcondition proof. */
  outcomeScore: number;
  unverifiedActionIds: readonly string[];
  /** True only when every completed action has explicit independent evidence. */
  e2eVerified: boolean;
};

export type BenchmarkResult = {
  scenario: Pick<ScenarioDefinition, "id" | "title" | "tags">;
  passed: boolean;
  score: number;
  criteria: readonly CriterionResult[];
  metrics: RunMetrics;
  evidence: EvidenceQuality;
  events: readonly EvidenceEvent[];
  sandbox: SandboxPaths;
  adapter: string;
  topology?: import("./topologies.ts").TopologySummary;
};
