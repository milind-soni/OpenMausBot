import { Cron } from "croner";

export interface RoutineCronSchedule {
  type: "cron";
  expression: string;
  /** Explicit IANA timezone; independent of the server or viewer's timezone. */
  timeZone: string;
}

const MAX_EXPRESSION_LENGTH = 256;
const MAX_PREVIEW_RUNS = 1000;

function cronCalculator(value: unknown): { schedule: RoutineCronSchedule; cron: Cron } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Choose a valid cron schedule");
  const input = value as Partial<RoutineCronSchedule>;
  if (input.type !== "cron" || typeof input.expression !== "string") throw new Error("Choose a valid cron schedule");
  if (Object.keys(input).some(key => !["type", "expression", "timeZone"].includes(key))) {
    throw new Error("Cron schedules accept only type, expression and timeZone; start/end dates and other restrictions are not supported");
  }
  const expression = input.expression.trim().replace(/\s+/g, " ");
  if (expression.length > MAX_EXPRESSION_LENGTH || expression.split(" ").length !== 5 || expression.includes("@")) {
    throw new Error("Cron must have five fields: minute hour day-of-month month weekday (no seconds, year, or macros)");
  }
  const timeZone = typeof input.timeZone === "string" ? input.timeZone.trim() : "";
  // Intl also accepts numeric offsets in newer runtimes. Require a named zone
  // so wall-clock schedules follow its daylight-saving rules instead.
  if (timeZone.length > 128 || !(timeZone === "UTC" || /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)+$/.test(timeZone))) {
    throw new Error("Choose an IANA timezone such as America/New_York, Asia/Kolkata, or UTC");
  }
  try { new Intl.DateTimeFormat("en-US", { timeZone }).format(0); }
  catch { throw new Error("Choose a valid IANA timezone such as America/New_York, Asia/Kolkata, or UTC"); }
  try {
    // Date calculator only: no callback, name, or timer. RoutineManager owns
    // dispatch, persistence, catch-up and cancellation. Croner bounds its
    // five-field search at year 3000, including impossible calendar dates.
    const cron = new Cron(expression, { timezone: timeZone, mode: "5-part", paused: true });
    return { schedule: { type: "cron", expression, timeZone }, cron };
  } catch (error) {
    throw new Error(`Invalid cron expression: ${(error as Error).message}`);
  }
}

function calculationDate(after: number): Date {
  const date = new Date(after);
  if (!Number.isFinite(after) || !Number.isFinite(date.getTime())) throw new Error("Choose a valid cron preview date");
  return date;
}

function futureRuns(cron: Cron, after: number, count: number): number[] {
  const from = calculationDate(after);
  // Croner resolves an ambiguous wall-clock time to its first occurrence.
  // If the cursor is already in the second occurrence, its first candidate
  // can therefore be in the past. Ask the same calculator for more candidates
  // and discard those, rather than moving the scheduler cursor backwards.
  // Minute precision bounds even a full-day historical timezone fold at 1440.
  const maximum = count + 1440;
  let requested = count;
  while (true) {
    const candidates = cron.nextRuns(requested, from);
    const runs: number[] = [];
    for (const date of candidates) {
      const at = date.getTime();
      if (!Number.isFinite(at)) throw new Error("The cron schedule produced an invalid date");
      if (at > (runs.at(-1) ?? after)) runs.push(at);
      if (runs.length === count) return runs;
    }
    if (candidates.length < requested || requested === maximum) return runs;
    // Sparse schedules normally need just one more candidate. Grow only when
    // needed, so a daily preview never scans years to skip one repeated hour.
    requested = Math.min(maximum, requested * 2);
  }
}

/** Normalize once at the trust boundary, rejecting impossible schedules. */
export function normalizeCronSchedule(value: unknown, after = Date.now()): RoutineCronSchedule {
  const { schedule, cron } = cronCalculator(value);
  if (!futureRuns(cron, after, 1).length) throw new Error("This cron expression has no future runs. Choose dates that exist.");
  return schedule;
}

/** Strictly-future instants, shared by the scheduler, cards and calendar.
 * Croner's DST policy is intentional: missing clock times advance through
 * the gap, and repeated clock times use their first occurrence only. */
export function nextCronRuns(schedule: RoutineCronSchedule, after: number, count: number): number[] {
  if (!Number.isInteger(count) || count < 1 || count > MAX_PREVIEW_RUNS) throw new Error("Choose between 1 and 1000 cron preview runs");
  const { cron } = cronCalculator(schedule);
  return futureRuns(cron, after, count);
}
