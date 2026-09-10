// The USAGE ledger: one row per settled turn, append-only, month by month
// under <data>/usage/, so "what did this workspace spend, by bot, by model,
// by person, by day" is answerable after a restart and exportable for an
// invoice. The per-task tally (store.ts addTaskUsage) is a running total
// that lives and dies with the task; this is the durable record.
//
// Same discipline as the decision log: 0600 files, serialized appends per
// directory, fire-and-forget. Bookkeeping must never fail the turn it is
// booking. Rows carry who asked and what it cost, never message text.
import { readFileSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { billableFor, type PriceList } from "./prices.ts";

/** Who asked for the turn. A person is named by the email they signed in
 * with when the server knows it (email sign-in), else by their device
 * label; `owner` is the machine itself (loopback, the desktop app). */
export type UsageTrigger =
  | { kind: "user"; email?: string; label?: string }
  | { kind: "owner" }
  | { kind: "routine"; routineId?: string; label?: string }
  | { kind: "bot"; botId?: string };

export interface UsageRow {
  at: string;
  botId: string;
  botName: string;
  threadId: string;
  instanceId: string;
  driverKind: string;
  model: string;
  input: number;
  output: number;
  cachedInput?: number;
  /** As the engine reported it: real on a metered key, an equivalent on a
   * subscription, null when the engine reports no price at all. */
  costUsd: number | null;
  trigger: UsageTrigger;
}

export type UsageGroupBy = "bot" | "model" | "user" | "day" | "engine";
export const USAGE_GROUPINGS: readonly UsageGroupBy[] = ["bot", "model", "user", "day", "engine"];

export interface UsageGroup {
  key: string;
  label: string;
  turns: number;
  input: number;
  output: number;
  cachedInput: number;
  /** Sum of the rows that reported a price; null when none did. */
  costUsd: number | null;
  /** Rows in this group that reported no price. */
  unpriced: number;
  /** What the operator charges for the group, from the price list; null
   * without a list or when nothing in the group is priced. */
  billableUsd: number | null;
}

export interface UsageSummary {
  groups: UsageGroup[];
  total: UsageGroup;
}

const DIR = "usage";
const MAX_RANGE_DAYS = 366;
const DAY_MS = 24 * 60 * 60_000;
const writeQueues = new Map<string, Promise<void>>();

const clean = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
const finiteOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

function monthKey(at: Date): string {
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function usageFileFor(dataDir: string, at: Date): string {
  return join(dataDir, DIR, `${monthKey(at)}.jsonl`);
}

/** Append one settled turn. Fire-and-forget; see the module comment. */
export function appendUsage(dataDir: string, row: Omit<UsageRow, "at"> & { at?: string }): void {
  const record: UsageRow = {
    ...row,
    at: row.at ?? new Date().toISOString(),
    input: clean(row.input),
    output: clean(row.output),
    ...(typeof row.cachedInput === "number" ? { cachedInput: clean(row.cachedInput) } : {}),
    costUsd: finiteOrNull(row.costUsd),
  };
  const previous = writeQueues.get(dataDir) ?? Promise.resolve();
  const queued = previous
    .then(() => write(dataDir, record))
    .catch(() => {
      /* bookkeeping must never take down the turn */
    });
  writeQueues.set(dataDir, queued);
  void queued.finally(() => {
    if (writeQueues.get(dataDir) === queued) writeQueues.delete(dataDir);
  });
}

async function write(dataDir: string, record: UsageRow): Promise<void> {
  await mkdir(join(dataDir, DIR), { recursive: true, mode: 0o700 });
  await appendFile(usageFileFor(dataDir, new Date(record.at)), JSON.stringify(record) + "\n", { mode: 0o600 });
}

/** Test/shutdown seam: wait until everything queued for this directory is on disk. */
export async function flushUsageLedger(dataDir: string): Promise<void> {
  await writeQueues.get(dataDir);
}

const isTrigger = (value: unknown): value is UsageTrigger =>
  typeof value === "object" && value !== null && typeof (value as UsageTrigger).kind === "string";

const isUsageRow = (value: unknown): value is UsageRow =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as UsageRow).at === "string" &&
  typeof (value as UsageRow).botId === "string" &&
  typeof (value as UsageRow).model === "string" &&
  typeof (value as UsageRow).input === "number" &&
  typeof (value as UsageRow).output === "number" &&
  isTrigger((value as UsageRow).trigger);

function monthsBetween(from: Date, to: Date): string[] {
  const keys: string[] = [];
  const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
  while (cursor.getTime() <= to.getTime()) {
    keys.push(monthKey(cursor));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return keys;
}

/** Every row whose time falls inside the range, oldest first. */
export function readUsage(dataDir: string, range: { from: Date; to: Date }): UsageRow[] {
  const rows: UsageRow[] = [];
  const from = range.from.getTime();
  const to = range.to.getTime();
  for (const key of monthsBetween(range.from, range.to)) {
    let text: string;
    try {
      text = readFileSync(join(dataDir, DIR, `${key}.jsonl`), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        const value: unknown = JSON.parse(line);
        if (!isUsageRow(value)) continue;
        const at = Date.parse(value.at);
        if (at >= from && at <= to) rows.push(value);
      } catch {
        /* a line torn mid-write: skip the fragment, keep the rest */
      }
    }
  }
  return rows;
}

/** A date range from query strings: `YYYY-MM-DD` each, `to` inclusive to
 * the end of its day (UTC). Defaults to the current month to date. Null
 * for anything malformed, reversed, or longer than a year. */
export function parseUsageRange(from: string | null | undefined, to: string | null | undefined, now = new Date()): { from: Date; to: Date } | null {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/;
  const parse = (value: string, endOfDay: boolean): Date | null => {
    const match = day.exec(value);
    if (!match) return null;
    const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, endOfDay ? 999 : 0));
    // Reject 2026-02-31 style rollovers.
    return date.getUTCMonth() === Number(match[2]) - 1 && date.getUTCDate() === Number(match[3]) ? date : null;
  };
  const start = from ? parse(from, false) : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = to ? parse(to, true) : now;
  if (!start || !end || start.getTime() > end.getTime()) return null;
  if (end.getTime() - start.getTime() > MAX_RANGE_DAYS * DAY_MS) return null;
  return { from: start, to: end };
}

/** A stable key and a display label for who asked. Labels for the
 * non-person kinds are English fallbacks; the app localizes by key. */
export function triggerKey(trigger: UsageTrigger): string {
  switch (trigger.kind) {
    case "user":
      return `user:${(trigger.email ?? trigger.label ?? "").toLowerCase() || "unknown"}`;
    case "owner":
      return "owner";
    case "routine":
      return `routine:${trigger.routineId ?? trigger.label ?? "unknown"}`;
    default:
      return "bot";
  }
}

export function triggerLabel(trigger: UsageTrigger): string {
  switch (trigger.kind) {
    case "user":
      return trigger.email ?? trigger.label ?? "Signed-in user";
    case "owner":
      return "This computer";
    case "routine":
      return `Routine: ${trigger.label ?? trigger.routineId ?? "unknown"}`;
    default:
      return "Bot to bot";
  }
}

function groupOf(row: UsageRow, groupBy: UsageGroupBy): { key: string; label: string } {
  switch (groupBy) {
    case "bot":
      return { key: `bot:${row.botId}`, label: row.botName || row.botId };
    case "model":
      return { key: `model:${row.driverKind}/${row.model}`, label: row.model };
    case "user":
      return { key: triggerKey(row.trigger), label: triggerLabel(row.trigger) };
    case "day":
      return { key: `day:${row.at.slice(0, 10)}`, label: row.at.slice(0, 10) };
    default:
      return { key: `engine:${row.driverKind}`, label: row.driverKind };
  }
}

function emptyGroup(key: string, label: string): UsageGroup {
  return { key, label, turns: 0, input: 0, output: 0, cachedInput: 0, costUsd: null, unpriced: 0, billableUsd: null };
}

function add(group: UsageGroup, row: UsageRow, prices: PriceList | null): void {
  group.turns += 1;
  group.input += clean(row.input);
  group.output += clean(row.output);
  group.cachedInput += clean(row.cachedInput);
  const cost = finiteOrNull(row.costUsd);
  if (cost === null) group.unpriced += 1;
  else group.costUsd = (group.costUsd ?? 0) + cost;
  const billable = prices ? billableFor(row, prices) : null;
  if (billable !== null) group.billableUsd = (group.billableUsd ?? 0) + billable;
}

/** Totals per group, money first then volume; days stay chronological. */
export function summarizeUsage(rows: UsageRow[], groupBy: UsageGroupBy, prices: PriceList | null = null): UsageSummary {
  const groups = new Map<string, UsageGroup>();
  const total = emptyGroup("total", "total");
  for (const row of rows) {
    const { key, label } = groupOf(row, groupBy);
    let group = groups.get(key);
    if (!group) {
      group = emptyGroup(key, label);
      groups.set(key, group);
    }
    add(group, row, prices);
    add(total, row, prices);
  }
  const ordered = [...groups.values()];
  if (groupBy === "day") ordered.sort((a, b) => a.key.localeCompare(b.key));
  else {
    ordered.sort((a, b) => {
      const costA = a.costUsd ?? Number.NEGATIVE_INFINITY;
      const costB = b.costUsd ?? Number.NEGATIVE_INFINITY;
      return costB - costA || b.input + b.output - (a.input + a.output);
    });
  }
  return { groups: ordered, total };
}

function csvCell(value: string | number | null): string {
  if (value === null) return "";
  const text = String(value);
  // A leading formula character is neutralised so a spreadsheet never
  // executes a bot name or an email address.
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

/** One line per turn, spreadsheet-ready; a billable column when a price list is given. */
export function usageCsv(rows: UsageRow[], prices: PriceList | null = null): string {
  const header = ["time", "bot", "model", "engine", "triggered_by", "input_tokens", "output_tokens", "cached_input_tokens", "cost_usd", ...(prices ? ["billable_usd"] : []), "thread"];
  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push([
      row.at,
      row.botName || row.botId,
      row.model,
      row.driverKind,
      triggerLabel(row.trigger),
      clean(row.input),
      clean(row.output),
      clean(row.cachedInput),
      finiteOrNull(row.costUsd),
      ...(prices ? [billableFor(row, prices)] : []),
      row.threadId,
    ].map(csvCell).join(","));
  }
  return lines.join("\n") + "\n";
}
