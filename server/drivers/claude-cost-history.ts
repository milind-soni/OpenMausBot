// Each Claude session's last few cost snapshots, so a resumed session's running total is split back into turns.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../config.ts";
import { writeFileAtomic } from "../atomic.ts";

const COST_HISTORY_FILE = join(DATA_DIR, "claude-cost-history.json");
const COST_HISTORY_SESSIONS = 100;
const COST_HISTORY_STATES = 8;

function isCostSnapshot(value: unknown): value is ClaudeCostSnapshot {
  if (!value || typeof value !== "object") return false;
  const { total, models } = value as { total?: unknown; models?: unknown };
  return typeof total === "number" && !!models && typeof models === "object" &&
    Object.values(models).every((counts) => Array.isArray(counts) && counts.length === 4 && counts.every((n) => typeof n === "number"));
}

export function readCostHistory(): Record<string, ClaudeCostSnapshot[]> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(COST_HISTORY_FILE, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).map(([id, states]) => [id, Array.isArray(states) ? states.filter(isCostSnapshot) : []]));
  } catch {
    return {};
  }
}

export function recordCostState(sessionId: string, state: ClaudeCostSnapshot): void {
  const history = readCostHistory();
  const states = [...(history[sessionId] ?? []), state].slice(-COST_HISTORY_STATES);
  delete history[sessionId];
  history[sessionId] = states;
  const ids = Object.keys(history);
  for (const id of ids.slice(0, Math.max(0, ids.length - COST_HISTORY_SESSIONS))) delete history[id];
  try {
    writeFileAtomic(COST_HISTORY_FILE, JSON.stringify(history), { mode: 0o600, durable: false });
  } catch {}
}

/** A turn's cost from total_cost_usd, which is the process's running total (2.1.282): the growth
 * since `previous`, or the whole figure when the start is unknown or the total went down. */
export function turnCostFromRunningTotal(total: number | null, previous: number | null): number | null {
  if (total === null) return null;
  if (previous === null || total < previous) return total;
  return Number((total - previous).toFixed(10));
}

/** total_cost_usd and per-model modelUsage [input, cache read, cache write, output] from a
 * `result`; both cover the whole session, including what --resume restored. */
export interface ClaudeCostSnapshot {
  total: number;
  models: Record<string, [number, number, number, number]>;
}

export function claudeCostSnapshot(total: unknown, modelUsage: unknown): ClaudeCostSnapshot | null {
  if (typeof total !== "number" || !Number.isFinite(total)) return null;
  const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  const models: ClaudeCostSnapshot["models"] = {};
  if (modelUsage && typeof modelUsage === "object" && !Array.isArray(modelUsage)) {
    for (const [model, raw] of Object.entries(modelUsage as Record<string, unknown>)) {
      if (!raw || typeof raw !== "object") continue;
      const u = raw as Record<string, unknown>;
      models[model] = [count(u.inputTokens), count(u.cacheReadInputTokens), count(u.cacheCreationInputTokens), count(u.outputTokens)];
    }
  }
  return { total, models };
}

/** The running total a resumed session carried before this process's first turn. On --resume the
 * CLI (2.1.282) restores cost from an earlier state, not always the latest one seen. */
export function restoredCostBase(
  earlier: readonly ClaudeCostSnapshot[],
  current: ClaudeCostSnapshot,
  usage: { input: number; cacheRead: number; cacheWrite: number; output: number },
): number {
  const turn = [usage.input, usage.cacheRead, usage.cacheWrite, usage.output];
  const nothing: ClaudeCostSnapshot = { total: 0, models: {} };
  let exact: number | null = null;
  let inside = 0;
  for (const state of [nothing, ...earlier]) {
    const within = Object.entries(state.models).every(([model, counts]) =>
      counts.every((n, i) => n <= (current.models[model]?.[i] ?? 0)));
    if (!within) continue;
    inside = state.total;
    const growth = Object.entries(current.models).map(([model, counts]) =>
      counts.map((n, i) => n - (state.models[model]?.[i] ?? 0)));
    const isTurn = (counts: number[]) => counts.every((n, i) => n === turn[i]);
    const summed = turn.map((_, i) => growth.reduce((sum, counts) => sum + counts[i]!, 0));
    if (growth.some(isTurn) || isTurn(summed)) exact = state.total;
  }
  return exact ?? inside;
}
