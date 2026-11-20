/** Token counts as the insights page shows them: `input` is fresh input, without the cached part. */
export interface InsightTokens {
  input: number;
  cachedInput: number;
  output: number;
  reasoning: number;
}

/** One period's figures. `cost` is null when no turn in it had a price. */
export interface InsightTotals extends InsightTokens {
  turns: number;
  costUsd: number | null;
  /** Turns whose model has no price; they add tokens but no dollars. */
  unpriced: number;
  errors: number;
  tools: number;
  /** Summed over timed turns only; `timedTurns` says how many. */
  durationMs: number;
  timedTurns: number;
  /** Distinct local days with at least one turn, out of `days` in the period. */
  activeDays: number;
  days: number;
}

/** One local day, or one local hour when the period is a single day; zero-filled when nothing ran. `start` is
 * YYYY-MM-DD or YYYY-MM-DDTHH. `models` maps a model key to its fresh-input plus output tokens, `modelCosts` to its dollars.
 * `costUsd` sums the priced turns only; `unpriced` counts the others. */
export interface InsightBucket extends InsightTokens {
  start: string;
  turns: number;
  costUsd: number;
  unpriced: number;
  errors: number;
  durationMs: number;
  timedTurns: number;
  models: Record<string, number>;
  modelCosts: Record<string, number>;
}

/** A series or a leaderboard entry: a bot, a model, an engine or a person. */
export interface InsightEntry extends InsightTokens {
  key: string;
  label: string;
  turns: number;
  costUsd: number | null;
  errors: number;
  durationMs: number;
  timedTurns: number;
  /** Set on a model entry: the engine it ran on. */
  driverKind?: string;
}

/** `GET /api/usage/insights?from&to&tz`: one period read back for charts, in the viewer's time zone. */
export interface UsageInsights {
  from: string;
  to: string;
  timeZone: string;
  totals: InsightTotals;
  /** The same number of days just before `from`, for the change figures. */
  previous: InsightTotals;
  unit: "day" | "hour";
  buckets: InsightBucket[];
  /** Turns started in each hour of each weekday, Sunday first: `hours[weekday][hour]`. */
  hours: number[][];
  models: InsightEntry[];
  bots: InsightEntry[];
  engines: InsightEntry[];
  people: InsightEntry[];
  routines: InsightEntry[];
  departments: InsightEntry[];
}
