// The headless bench driver (docs/plans/2026-09-14-phase-0-foundation.md,
// item 0.8).
//
// A benchmark, and the harness's own regression fixture, need one thing
// the chat UI does not offer: run ONE task on ONE bot, unattended, inside a
// budget, and hand back a result and a trajectory a script can read. The
// driver is deliberately thin — it starts a detached thread the way a
// routine does (an unattended launch, so the launch budget applies), lets
// the ordinary fold do the work, and only watches the budget from the side.
// The bot's engine is whatever the bot is configured with, so this is full
// for every driver by construction; the result records which one it was.
// These are the pure parts; server/index.ts owns the routes and the watch.

export interface BenchBudget {
  /** Tool calls the turn may make. */
  steps: number;
  /** Input + output tokens, as the engine reports them. */
  tokens: number;
  /** Wall-clock minutes from the start of the run. */
  minutes: number;
}

export const DEFAULT_BENCH_BUDGET: BenchBudget = { steps: 200, tokens: 400_000, minutes: 30 };

export type BenchStatus = "running" | "settled" | "failed" | "budget_exceeded";
export type BenchBudgetKind = keyof BenchBudget;

export interface BenchRun {
  id: string;
  botId: string;
  botName: string;
  threadId: string;
  task: string;
  cwd?: string;
  budget: BenchBudget;
  /** Recorded on the result either way; enforced only where an engine can
   * take a network allow-list (none does today, so `enforced` is false). */
  network?: { allow: string[] };
  startedAt: number;
  endedAt?: number;
  status: BenchStatus;
  exceeded?: BenchBudgetKind;
  stopReason?: string | null;
  steps: number;
  turns: number;
  tokens: { input: number; output: number; cachedInput: number };
  /** The largest running token indicator seen mid-turn, for the budget
   * check only: per-driver semantics differ, so it is never summed. */
  liveTokens?: number;
  costUsd: number | null;
  driverKind: string;
  model: string;
}

/** `steps=200,tokens=400000,minutes=30`, or an object with the same keys;
 * anything missing takes the default. */
export function parseBudget(input: unknown): BenchBudget {
  const budget: BenchBudget = { ...DEFAULT_BENCH_BUDGET };
  const entries: Array<[string, unknown]> = typeof input === "string"
    ? input.split(",").filter((part) => part.trim()).map((part) => {
        const [key, value] = part.split("=");
        return [key!.trim(), value?.trim()];
      })
    : input && typeof input === "object" ? Object.entries(input as Record<string, unknown>) : [];
  for (const [key, raw] of entries) {
    if (!(key in DEFAULT_BENCH_BUDGET)) throw new Error(`unknown budget "${key}" (use steps, tokens, minutes)`);
    const value = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(value) || value <= 0) throw new Error(`budget ${key} must be a positive number`);
    budget[key as BenchBudgetKind] = value;
  }
  return budget;
}

/** The first budget the run has crossed, or null. */
export function budgetExceeded(run: BenchRun, now: number): BenchBudgetKind | null {
  if (run.steps >= run.budget.steps) return "steps";
  const tokens = Math.max(run.tokens.input + run.tokens.output, run.liveTokens ?? 0);
  if (tokens >= run.budget.tokens) return "tokens";
  if (now - run.startedAt >= run.budget.minutes * 60_000) return "minutes";
  return null;
}

export interface BenchResult {
  id: string;
  status: BenchStatus;
  exceeded?: BenchBudgetKind;
  stopReason?: string | null;
  botId: string;
  botName: string;
  threadId: string;
  driverKind: string;
  model: string;
  budget: BenchBudget;
  cwd?: string;
  network?: { allow: string[]; enforced: false };
  steps: number;
  turns: number;
  tokens: { input: number; output: number; cachedInput: number };
  costUsd: number | null;
  durationMs: number;
}

/** The result.json shape. */
export function benchResult(run: BenchRun, now = Date.now()): BenchResult {
  return {
    id: run.id,
    status: run.status,
    ...(run.exceeded ? { exceeded: run.exceeded } : {}),
    ...(run.stopReason !== undefined ? { stopReason: run.stopReason } : {}),
    botId: run.botId,
    botName: run.botName,
    threadId: run.threadId,
    driverKind: run.driverKind,
    model: run.model,
    budget: run.budget,
    ...(run.cwd ? { cwd: run.cwd } : {}),
    ...(run.network ? { network: { allow: run.network.allow, enforced: false as const } } : {}),
    steps: run.steps,
    turns: run.turns,
    tokens: run.tokens,
    costUsd: run.costUsd,
    durationMs: Math.max(0, (run.endedAt ?? now) - run.startedAt),
  };
}
