// How each model does in this harness, from the usage ledger (Settings → Usage → Model performance): turns, how many
// ended well, its steps and tool calls and their errors, how often it ran as the quick model and fell back to the
// bot's own, how long a turn took, and its tokens and cost. Rows booked before a field existed count as unknown.
import type { UsageRow } from "./usage-ledger.ts";

export interface ModelPerformance {
  model: string;
  driverKind: string;
  turns: number;
  /** Turns whose outcome was ok; `ended` is how many had any outcome. */
  ok: number;
  ended: number;
  steps: number;
  tools: number;
  toolErrors: number;
  /** Turns this model ran as the quick model, and those of them that fell back to the bot's own model. */
  quickTurns: number;
  fallbacks: number;
  /** Turn time in milliseconds, over turns that were timed. */
  p50Ms: number | null;
  p90Ms: number | null;
  input: number;
  output: number;
  costUsd: number | null;
}

const percentile = (sorted: readonly number[], share: number): number | null =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))]! : null;

export function modelPerformance(rows: readonly UsageRow[]): ModelPerformance[] {
  const groups = new Map<string, { row: ModelPerformance; times: number[] }>();
  const groupOf = (driverKind: string, model: string) => {
    const key = `${driverKind}\u0000${model}`;
    let group = groups.get(key);
    if (!group) {
      group = { times: [], row: { model, driverKind, turns: 0, ok: 0, ended: 0, steps: 0, tools: 0, toolErrors: 0,
        quickTurns: 0, fallbacks: 0, p50Ms: null, p90Ms: null, input: 0, output: 0, costUsd: null } };
      groups.set(key, group);
    }
    return group;
  };
  for (const row of rows) {
    const group = groupOf(row.driverKind, row.model);
    const into = group.row;
    into.turns++;
    if (row.outcome) {
      into.ended++;
      if (row.outcome.status === "ok") into.ok++;
    }
    into.steps += row.steps ?? 0;
    into.tools += row.tools ?? 0;
    into.toolErrors += row.toolErrors ?? 0;
    if (row.route === "quick") into.quickTurns++;
    // A fallback's row is the bot's own model's turn; the refusal counts against the quick model.
    if (row.route === "fallback" && row.quickModel) {
      const quick = groupOf(row.driverKind, row.quickModel).row;
      quick.quickTurns++;
      quick.fallbacks++;
    }
    into.input += row.input;
    into.output += row.output;
    if (row.costUsd !== null) into.costUsd = (into.costUsd ?? 0) + row.costUsd;
    const started = row.startedAt ? Date.parse(row.startedAt) : Number.NaN;
    const ended = row.endedAt ? Date.parse(row.endedAt) : Number.NaN;
    if (Number.isFinite(started) && Number.isFinite(ended) && ended >= started) group.times.push(ended - started);
  }
  return [...groups.values()].map(({ row, times }) => {
    const sorted = times.sort((a, b) => a - b);
    return { ...row, p50Ms: percentile(sorted, 0.5), p90Ms: percentile(sorted, 0.9) };
  }).sort((a, b) => b.turns - a.turns || a.model.localeCompare(b.model));
}

/** The quick-model fallbacks in the rows, for the daily anonymous count. */
export const quickFallbacks = (rows: readonly UsageRow[]): number => rows.filter((row) => row.route === "fallback").length;
