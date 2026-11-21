import type { InsightBucket, InsightEntry, InsightTokens, InsightTotals, UsageInsights } from "../shared/usage-insights.ts";
import { usageGroupOf, type UsageRow } from "./usage-ledger.ts";

const DAY_MS = 24 * 60 * 60_000;
const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

const count = (value: unknown): number => typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
const price = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

export function validTimeZone(zone: string | null): string | null {
  if (!zone || zone.length > 64) return null;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

interface LocalTime { day: string; weekday: number; hour: number }

function localClock(timeZone: string): (at: number) => LocalTime {
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23", weekday: "short",
  });
  return (at) => {
    const parts: Record<string, string> = {};
    for (const part of format.formatToParts(at)) parts[part.type] = part.value;
    return { day: `${parts.year}-${parts.month}-${parts.day}`, weekday: WEEKDAYS[parts.weekday!] ?? 0, hour: Number(parts.hour) % 24 };
  };
}

export function daysBetween(from: string, to: string): string[] {
  const days: string[] = [];
  for (let at = Date.parse(`${from}T00:00:00Z`); at <= Date.parse(`${to}T00:00:00Z`); at += DAY_MS) {
    days.push(new Date(at).toISOString().slice(0, 10));
  }
  return days;
}

const shiftDay = (day: string, by: number) => new Date(Date.parse(`${day}T00:00:00Z`) + by * DAY_MS).toISOString().slice(0, 10);

export function insightReadRange(from: string, to: string): { from: Date; to: Date } {
  const length = daysBetween(from, to).length;
  return { from: new Date(Date.parse(`${shiftDay(from, -length - 1)}T00:00:00Z`)), to: new Date(Date.parse(`${shiftDay(to, 1)}T23:59:59.999Z`)) };
}

const freshInput = (row: UsageRow) => Math.max(0, count(row.input) - Math.min(count(row.cachedInput), count(row.input)));

function addTokens(into: InsightTokens, row: UsageRow): void {
  into.input += freshInput(row);
  into.cachedInput += Math.min(count(row.cachedInput), count(row.input));
  into.output += count(row.output);
  into.reasoning += count(row.reasoning);
}

const rowDuration = (row: UsageRow): number | null => {
  if (!row.startedAt || !row.endedAt) return null;
  const span = Date.parse(row.endedAt) - Date.parse(row.startedAt);
  return Number.isFinite(span) && span >= 0 ? span : null;
};

const failed = (row: UsageRow) => row.outcome?.status === "error";

function totalsOf(rows: readonly { row: UsageRow; local: LocalTime }[], days: number): InsightTotals {
  const totals: InsightTotals = { input: 0, cachedInput: 0, output: 0, reasoning: 0, turns: 0, costUsd: null, unpriced: 0, errors: 0, tools: 0, durationMs: 0, timedTurns: 0, activeDays: 0, days };
  const active = new Set<string>();
  for (const { row, local } of rows) {
    addTokens(totals, row);
    totals.turns += 1;
    const cost = price(row.costUsd);
    if (cost === null) totals.unpriced += 1;
    else totals.costUsd = (totals.costUsd ?? 0) + cost;
    if (failed(row)) totals.errors += 1;
    totals.tools += count(row.tools);
    const duration = rowDuration(row);
    if (duration !== null) { totals.durationMs += duration; totals.timedTurns += 1; }
    active.add(local.day);
  }
  totals.activeDays = active.size;
  return totals;
}

function entries(rows: readonly UsageRow[], keyOf: (row: UsageRow) => { key: string; label: string; driverKind?: string }): InsightEntry[] {
  const found = new Map<string, InsightEntry>();
  for (const row of rows) {
    const { key, label, driverKind } = keyOf(row);
    let entry = found.get(key);
    if (!entry) {
      entry = { key, label, input: 0, cachedInput: 0, output: 0, reasoning: 0, turns: 0, costUsd: null, errors: 0, durationMs: 0, timedTurns: 0, ...(driverKind ? { driverKind } : {}) };
      found.set(key, entry);
    }
    addTokens(entry, row);
    entry.turns += 1;
    const cost = price(row.costUsd);
    if (cost !== null) entry.costUsd = (entry.costUsd ?? 0) + cost;
    if (failed(row)) entry.errors += 1;
    const duration = rowDuration(row);
    if (duration !== null) { entry.durationMs += duration; entry.timedTurns += 1; }
  }
  const weight = (entry: InsightEntry) => entry.input + entry.output;
  return [...found.values()].sort((a, b) => (b.costUsd ?? -1) - (a.costUsd ?? -1) || weight(b) - weight(a));
}

export function summarizeInsights(rows: readonly UsageRow[], range: { from: string; to: string }, timeZone: string): UsageInsights {
  const clock = localClock(timeZone);
  const dayList = daysBetween(range.from, range.to);
  const previousFrom = shiftDay(range.from, -dayList.length);
  const previousTo = shiftDay(range.from, -1);
  const current: { row: UsageRow; local: LocalTime }[] = [];
  const before: { row: UsageRow; local: LocalTime }[] = [];
  for (const row of rows) {
    const at = Date.parse(row.at);
    if (!Number.isFinite(at)) continue;
    const local = clock(row.startedAt && Number.isFinite(Date.parse(row.startedAt)) ? Date.parse(row.startedAt) : at);
    if (local.day >= range.from && local.day <= range.to) current.push({ row, local });
    else if (local.day >= previousFrom && local.day <= previousTo) before.push({ row, local });
  }

  const unit = dayList.length === 1 ? "hour" : "day";
  const starts = unit === "hour" ? Array.from({ length: 24 }, (_, hour) => `${range.from}T${String(hour).padStart(2, "0")}`) : dayList;
  const buckets = new Map<string, InsightBucket>(starts.map((start) => [start, {
    start, input: 0, cachedInput: 0, output: 0, reasoning: 0, turns: 0, costUsd: 0, unpriced: 0, errors: 0, durationMs: 0, timedTurns: 0, models: {}, modelCosts: {},
  }]));
  const hours = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
  for (const { row, local } of current) {
    const day = buckets.get(unit === "hour" ? `${local.day}T${String(local.hour).padStart(2, "0")}` : local.day)!;
    addTokens(day, row);
    day.turns += 1;
    const cost = price(row.costUsd);
    if (cost === null) day.unpriced += 1;
    else day.costUsd += cost;
    if (failed(row)) day.errors += 1;
    const duration = rowDuration(row);
    if (duration !== null) { day.durationMs += duration; day.timedTurns += 1; }
    const model = usageGroupOf(row, "model").key;
    day.models[model] = (day.models[model] ?? 0) + freshInput(row) + count(row.output);
    day.modelCosts[model] = (day.modelCosts[model] ?? 0) + (cost ?? 0);
    hours[local.weekday]![local.hour]! += 1;
  }

  const rowsNow = current.map((item) => item.row);
  return {
    from: range.from,
    to: range.to,
    timeZone,
    totals: totalsOf(current, dayList.length),
    previous: totalsOf(before, dayList.length),
    unit,
    buckets: [...buckets.values()],
    hours,
    models: entries(rowsNow, (row) => ({ ...usageGroupOf(row, "model"), driverKind: row.driverKind })),
    bots: entries(rowsNow, (row) => usageGroupOf(row, "bot")),
    engines: entries(rowsNow, (row) => usageGroupOf(row, "engine")),
    people: entries(rowsNow, (row) => usageGroupOf(row, "user")),
    routines: entries(rowsNow, (row) => usageGroupOf(row, "routine")),
    departments: entries(rowsNow, (row) => usageGroupOf(row, "department")),
  };
}
