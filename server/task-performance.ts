import type { RuntimeEvent } from "./contracts.ts";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type PerformanceMetric = number | null;
export type UsageSource = "provider" | "estimated" | "unavailable";
export type CostSource = "provider" | "estimate" | "unavailable";
export type ProviderSessionMode = "cold" | "warm" | "unknown";

export interface TokenPricing {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  /** Human-readable provenance, for example a provider billing export. */
  source: string;
}

export interface TaskPerformanceStart {
  taskId: string;
  threadId: string;
  provider: string;
  providerInstanceId: string;
  model: string;
  /** Defaults to the tracker's clock; callers can pass the original send time. */
  sendAt?: number;
  /** Set when a message waited in the server-side queue. */
  queueEnteredAt?: number;
  pricing?: TokenPricing;
}

export interface TaskPerformanceSnapshot {
  taskId: string;
  threadId: string;
  turnId: string | null;
  provider: string;
  providerInstanceId: string;
  model: string;
  /** Missing on receipts written before session reuse telemetry existed. */
  sessionMode?: ProviderSessionMode;
  timestampsMs: {
    send: number;
    dispatch: number | null;
    providerStartup: number | null;
    firstVisibleOutput: number | null;
    completion: number | null;
  };
  durationsMs: {
    /** Server-side send through the provider adapter dispatch boundary. */
    sendToDispatch: PerformanceMetric;
    /** Includes queue and setup time before adapter dispatch. */
    queueDelay: PerformanceMetric;
    /** Cold provider setup only; null when the provider session was reused. */
    providerStartup: PerformanceMetric;
    firstVisibleOutput: PerformanceMetric;
    /** Original send through final turn.completed. */
    completion: PerformanceMetric;
  };
  tools: Array<{
    itemId: string;
    name: string | null;
    durationMs: PerformanceMetric;
    ok: boolean | null;
  }>;
  usage: {
    input: number | null;
    output: number | null;
    /** Approximate total when the provider omits token telemetry. Never an exact count. */
    estimatedTokens: number | null;
    source: UsageSource;
  };
  cost: {
    reportedUsd: number | null;
    estimatedUsd: number | null;
    source: CostSource;
    pricingSource?: string;
  };
  /** True only after the terminal turn.completed event was observed. */
  completed: boolean;
}

export interface PerformanceBudgets {
  p95QueueDelayMs: number;
  p95SendToDispatchMs: number;
  medianProviderStartupMs: number;
  medianFirstVisibleMs: number;
  p95FirstVisibleMs: number;
  medianCompletionMs: number;
  minimumTokenCoverage: number;
}

export const DEFAULT_PERFORMANCE_BUDGETS: PerformanceBudgets = {
  p95QueueDelayMs: 1_000,
  p95SendToDispatchMs: 1_500,
  medianProviderStartupMs: 3_000,
  medianFirstVisibleMs: 5_000,
  p95FirstVisibleMs: 12_000,
  medianCompletionMs: 30_000,
  minimumTokenCoverage: 0.95,
};

export interface PerformanceBudgetReport {
  sampleSize: number;
  passing: boolean;
  metrics: Record<string, { observed: number | null; target: number; status: "pass" | "breach" | "unavailable" }>;
}

export interface PerformanceUsageSummary {
  /** Turns with provider-supplied input/output counts. */
  providerReportedTurns: number;
  /** Turns with a clearly labelled local estimate. */
  estimatedTurns: number;
  /** Completed receipts where neither provider counts nor an estimate exists. */
  unavailableTurns: number;
  /** Fraction of receipts with provider-supplied counts, not a cost estimate. */
  providerReportedCoverage: number | null;
  estimatedTokens: number;
}

export interface SessionReuseSummary {
  coldTurns: number;
  warmTurns: number;
  unknownTurns: number;
  reuseRate: number | null;
  medianColdFirstVisibleMs: number | null;
  medianWarmFirstVisibleMs: number | null;
}

export function summarizePerformanceUsage(receipts: readonly TaskPerformanceSnapshot[]): PerformanceUsageSummary {
  const providerReportedTurns = receipts.filter((receipt) => receipt.usage.source === "provider").length;
  const estimatedTurns = receipts.filter((receipt) => receipt.usage.source === "estimated").length;
  const unavailableTurns = receipts.filter((receipt) => receipt.usage.source === "unavailable").length;
  const estimatedTokens = receipts.reduce(
    (total, receipt) => total + (receipt.usage.source === "estimated" && receipt.usage.estimatedTokens !== null ? receipt.usage.estimatedTokens : 0),
    0,
  );
  return {
    providerReportedTurns,
    estimatedTurns,
    unavailableTurns,
    providerReportedCoverage: receipts.length === 0 ? null : providerReportedTurns / receipts.length,
    estimatedTokens,
  };
}

export function summarizeSessionReuse(receipts: readonly TaskPerformanceSnapshot[]): SessionReuseSummary {
  const cold = receipts.filter((receipt) => receipt.sessionMode === "cold");
  const warm = receipts.filter((receipt) => receipt.sessionMode === "warm");
  const knownTurns = cold.length + warm.length;
  return {
    coldTurns: cold.length,
    warmTurns: warm.length,
    unknownTurns: receipts.length - knownTurns,
    reuseRate: knownTurns === 0 ? null : warm.length / knownTurns,
    medianColdFirstVisibleMs: percentile(cold.map((receipt) => receipt.durationsMs.firstVisibleOutput), 0.5),
    medianWarmFirstVisibleMs: percentile(warm.map((receipt) => receipt.durationsMs.firstVisibleOutput), 0.5),
  };
}

function percentile(values: Array<number | null>, quantile: number): number | null {
  const sorted = values.filter((value): value is number => value !== null && Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1))] ?? null;
}

/** Aspirational speed guardrails. This reports regressions without blocking a
 * user's task; benchmark promotion gates can treat the same report as hard. */
export function evaluatePerformanceBudgets(
  receipts: readonly TaskPerformanceSnapshot[],
  budgets: PerformanceBudgets = DEFAULT_PERFORMANCE_BUDGETS,
): PerformanceBudgetReport {
  const observed = {
    p95QueueDelayMs: percentile(receipts.map((receipt) => receipt.durationsMs.queueDelay), 0.95),
    p95SendToDispatchMs: percentile(receipts.map((receipt) => receipt.durationsMs.sendToDispatch), 0.95),
    medianProviderStartupMs: percentile(receipts.map((receipt) => receipt.durationsMs.providerStartup), 0.5),
    medianFirstVisibleMs: percentile(receipts.map((receipt) => receipt.durationsMs.firstVisibleOutput), 0.5),
    p95FirstVisibleMs: percentile(receipts.map((receipt) => receipt.durationsMs.firstVisibleOutput), 0.95),
    medianCompletionMs: percentile(receipts.map((receipt) => receipt.durationsMs.completion), 0.5),
    minimumTokenCoverage: receipts.length === 0 ? null : receipts.filter((receipt) => receipt.usage.source === "provider").length / receipts.length,
  };
  const metrics: PerformanceBudgetReport["metrics"] = {};
  for (const key of Object.keys(observed) as Array<keyof typeof observed>) {
    const value = observed[key];
    const target = budgets[key];
    const minimum = key === "minimumTokenCoverage";
    metrics[key] = {
      observed: value,
      target,
      status: value === null ? "unavailable" : minimum ? (value >= target ? "pass" : "breach") : (value <= target ? "pass" : "breach"),
    };
  }
  return {
    sampleSize: receipts.length,
    passing: receipts.length > 0 && Object.values(metrics).every((metric) => metric.status === "pass"),
    metrics,
  };
}

interface MutableTool {
  itemId: string;
  name: string | null;
  startedAt: number;
  completedAt: number | null;
  ok: boolean | null;
}

interface MutableTurn extends TaskPerformanceStart {
  sendAt: number;
  dispatchAt: number | null;
  turnId: string | null;
  sessionMode: ProviderSessionMode;
  providerStartupAt: number | null;
  firstVisibleOutputAt: number | null;
  completionAt: number | null;
  input: number | null;
  output: number | null;
  assistantTextChars: number;
  reasoningTextChars: number;
  toolTitleChars: number;
  providerTurnObserved: boolean;
  reportedCostUsd: number | null;
  tools: Map<string, MutableTool>;
  completed: boolean;
}

function finiteNonNegative(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function completeUsage(value: { input?: unknown; output?: unknown } | null | undefined): { input: number; output: number } | null {
  const input = finiteNonNegative(typeof value?.input === "number" ? value.input : null);
  const output = finiteNonNegative(typeof value?.output === "number" ? value.output : null);
  return input === null || output === null ? null : { input, output };
}

function eventTime(event: RuntimeEvent, fallback: number): number {
  const parsed = Date.parse(event.createdAt);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function duration(start: number | null, end: number | null): PerformanceMetric {
  return start === null || end === null ? null : Math.max(0, end - start);
}

function estimatedTokens(turn: MutableTurn): number | null {
  if (turn.input !== null && turn.output !== null) return null;
  // A pre-dispatch failure did not reach the provider and should remain
  // unavailable rather than looking like billable work.
  if (!turn.completed || !turn.providerTurnObserved) return null;
  // Providers that omit usage still leave us observable output/tool evidence.
  // Four characters is a deliberately conservative English/code token proxy;
  // the fixed envelope covers the prompt, system context, and tool protocol.
  const observed = turn.assistantTextChars + turn.reasoningTextChars + turn.toolTitleChars;
  return Math.max(2_000, Math.round(2_000 + observed / 4));
}

function estimateCost(turn: MutableTurn): number | null {
  const pricing = turn.pricing;
  const tokenEstimate = estimatedTokens(turn);
  if (!pricing || (turn.input === null && tokenEstimate === null)) return null;
  const inputRate = finiteNonNegative(pricing.inputUsdPerMillion);
  const outputRate = finiteNonNegative(pricing.outputUsdPerMillion);
  if (inputRate === null || outputRate === null) return null;
  if (turn.input === null || turn.output === null) {
    // The split is also approximate: prompts/context tend to dominate a
    // normal agent turn. Keep it internal and expose only the estimate source.
    return (tokenEstimate! * (inputRate * 0.75 + outputRate * 0.25)) / 1_000_000;
  }
  return (turn.input * inputRate + turn.output * outputRate) / 1_000_000;
}

function snapshot(turn: MutableTurn): TaskPerformanceSnapshot {
  const hasUsage = turn.input !== null && turn.output !== null;
  const tokenEstimate = estimatedTokens(turn);
  const estimatedUsd = estimateCost(turn);
  const reportedUsd = turn.reportedCostUsd;
  return {
    taskId: turn.taskId,
    threadId: turn.threadId,
    turnId: turn.turnId,
    provider: turn.provider,
    providerInstanceId: turn.providerInstanceId,
    model: turn.model,
    sessionMode: turn.sessionMode,
    timestampsMs: {
      send: turn.sendAt,
      dispatch: turn.dispatchAt,
      providerStartup: turn.providerStartupAt,
      firstVisibleOutput: turn.firstVisibleOutputAt,
      completion: turn.completionAt,
    },
    durationsMs: {
      sendToDispatch: duration(turn.sendAt, turn.dispatchAt),
      queueDelay: turn.queueEnteredAt === undefined ? 0 : duration(turn.queueEnteredAt, turn.dispatchAt),
      providerStartup: duration(turn.dispatchAt, turn.providerStartupAt),
      firstVisibleOutput: duration(turn.dispatchAt, turn.firstVisibleOutputAt),
      completion: duration(turn.sendAt, turn.completionAt),
    },
    tools: [...turn.tools.values()].map((tool) => ({
      itemId: tool.itemId,
      name: tool.name,
      durationMs: duration(tool.startedAt, tool.completedAt),
      ok: tool.ok,
    })),
    usage: {
      input: turn.input,
      output: turn.output,
      estimatedTokens: tokenEstimate,
      source: hasUsage ? "provider" : tokenEstimate === null ? "unavailable" : "estimated",
    },
    cost: {
      reportedUsd,
      estimatedUsd,
      source: reportedUsd !== null ? "provider" : estimatedUsd !== null ? "estimate" : "unavailable",
      ...(turn.pricing?.source ? { pricingSource: turn.pricing.source } : {}),
    },
    completed: turn.completed,
  };
}

/**
 * Correlates one task's provider events into a durable, UI-safe performance
 * snapshot. It never invents exact provider counts: missing token telemetry is
 * represented as a separately labelled estimate based on observable output
 * and a conservative context envelope.
 */
export class TaskPerformanceTracker {
  private readonly turns = new Map<string, MutableTurn>();
  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  begin(input: TaskPerformanceStart): void {
    this.turns.set(input.threadId, {
      ...input,
      sendAt: input.sendAt ?? this.now(),
      dispatchAt: null,
      turnId: null,
      sessionMode: "unknown",
      providerStartupAt: null,
      firstVisibleOutputAt: null,
      completionAt: null,
      input: null,
      output: null,
      assistantTextChars: 0,
      reasoningTextChars: 0,
      toolTitleChars: 0,
      providerTurnObserved: false,
      reportedCostUsd: null,
      tools: new Map(),
      completed: false,
    });
  }

  /** Marks the adapter boundary; a turn id is the correlation key thereafter. */
  dispatched(threadId: string, turnId: string | null = null, at = this.now()): boolean {
    const turn = this.turns.get(threadId);
    if (!turn) return false;
    if (turnId) turn.turnId = turnId;
    if (turn.dispatchAt === null) turn.dispatchAt = at;
    return true;
  }

  /** Records queue entry for a send that waited behind another turn. */
  queued(threadId: string, at = this.now()): boolean {
    const turn = this.turns.get(threadId);
    if (!turn) return false;
    turn.queueEnteredAt = at;
    return true;
  }

  current(threadId: string): TaskPerformanceSnapshot | null {
    const turn = this.turns.get(threadId);
    return turn ? snapshot(turn) : null;
  }

  /** Settle setup/dispatch failures that occur before a provider can emit a
   * terminal event. The absent provider metrics remain null by design. */
  failedDispatch(threadId: string, at = this.now()): TaskPerformanceSnapshot | null {
    const turn = this.turns.get(threadId);
    if (!turn) return null;
    turn.completionAt = at;
    turn.completed = true;
    const result = snapshot(turn);
    this.turns.delete(threadId);
    return result;
  }

  event(event: RuntimeEvent): TaskPerformanceSnapshot | null {
    const turn = this.turns.get(event.threadId);
    if (!turn) return null;
    if (turn.turnId !== null && event.turnId !== undefined && event.turnId !== turn.turnId) return null;
    if (turn.turnId === null && event.turnId !== undefined) turn.turnId = event.turnId;
    turn.providerTurnObserved = true;
    const at = eventTime(event, this.now());
    switch (event.type) {
      case "turn.started":
        // This marks the adapter accepting the turn, not provider readiness.
        // Startup is measured from dispatch to session.started below.
        break;
      case "session.started":
        // A warm/reused provider session is already started. Keep startup
        // unavailable for that turn instead of reporting the marker's tiny
        // dispatch-to-event gap as a cold-start duration.
        if (event.reused === true) {
          turn.sessionMode = "warm";
          turn.providerStartupAt = null;
        } else if (turn.providerStartupAt === null) {
          turn.sessionMode = "cold";
          turn.providerStartupAt = at;
        }
        break;
      case "content.delta":
        if (event.streamKind === "assistant_text" && turn.firstVisibleOutputAt === null) turn.firstVisibleOutputAt = at;
        if (event.streamKind === "assistant_text") turn.assistantTextChars += event.delta.length;
        if (event.streamKind === "reasoning_text") turn.reasoningTextChars += event.delta.length;
        break;
      case "item.completed":
        if (event.itemType === "assistant_text" && turn.firstVisibleOutputAt === null) turn.firstVisibleOutputAt = at;
        if (event.itemType === "tool" && event.itemId) {
          const tool = turn.tools.get(event.itemId);
          if (tool) {
            tool.completedAt = at;
            tool.ok = event.ok;
          }
        }
        break;
      case "item.started":
        if (event.itemType === "tool" && event.itemId && !turn.tools.has(event.itemId)) {
          turn.tools.set(event.itemId, {
            itemId: event.itemId,
            name: event.title ?? null,
            startedAt: at,
            completedAt: null,
            ok: null,
          });
          turn.toolTitleChars += event.title?.length ?? 0;
        }
        break;
      case "thread.token-usage.updated":
        {
          const usage = completeUsage(event);
          if (usage) {
            turn.input = usage.input;
            turn.output = usage.output;
          }
        }
        break;
      case "turn.completed":
        {
          const usage = completeUsage(event.usage);
          if (usage) {
            turn.input = usage.input;
            turn.output = usage.output;
          }
        }
        turn.reportedCostUsd = finiteNonNegative(event.cost);
        turn.completionAt = at;
        turn.completed = true;
        {
          const result = snapshot(turn);
          this.turns.delete(event.threadId);
          return result;
        }
      default:
        break;
    }
    return snapshot(turn);
  }
}

/** Small durable receipt ledger. The tracker owns correlation; this module
 * owns retention and crash-safe persistence so a performance regression can
 * be compared across app restarts without storing transcript content. */
export class TaskPerformanceLedger {
  private readonly file: string;
  private readonly maxEntries: number;
  private receipts: TaskPerformanceSnapshot[] = [];

  constructor(options: { file: string; maxEntries?: number }) {
    this.file = options.file;
    this.maxEntries = Math.max(10, Math.min(20_000, Math.trunc(options.maxEntries ?? 2_000)));
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, "utf8"));
      if (Array.isArray(parsed)) this.receipts = parsed.filter(isPerformanceSnapshot).slice(-this.maxEntries);
    } catch {
      this.receipts = [];
    }
  }

  record(receipt: TaskPerformanceSnapshot): void {
    if (!receipt.completed) return;
    this.receipts.push(receipt);
    if (this.receipts.length > this.maxEntries) this.receipts.splice(0, this.receipts.length - this.maxEntries);
    mkdirSync(dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    writeFileSync(temp, JSON.stringify(this.receipts, null, 2));
    renameSync(temp, this.file);
  }

  list(options: { since?: number; limit?: number } = {}): TaskPerformanceSnapshot[] {
    const since = Number.isFinite(options.since) ? Number(options.since) : Number.NEGATIVE_INFINITY;
    const limit = Math.max(1, Math.min(2_000, Math.trunc(options.limit ?? 200)));
    return this.receipts
      .filter((receipt) => (receipt.timestampsMs.completion ?? 0) >= since)
      .slice(-limit)
      .reverse()
      .map((receipt) => structuredClone(receipt));
  }
}

function isPerformanceSnapshot(value: unknown): value is TaskPerformanceSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Partial<TaskPerformanceSnapshot>;
  return typeof row.taskId === "string"
    && typeof row.threadId === "string"
    && typeof row.provider === "string"
    && typeof row.model === "string"
    && row.completed === true
    && Boolean(row.timestampsMs)
    && Boolean(row.durationsMs)
    && Array.isArray(row.tools);
}
