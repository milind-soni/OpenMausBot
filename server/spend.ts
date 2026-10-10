// Spend limits over the usage ledger: what this workspace has spent this
// month against its cap, the refusal a turn gets once the cap is reached,
// and the one-per-month notices when the month crosses the warning
// threshold and the cap. The figure is every cost in the ledger: what
// engines reported (on a workspace of personal subscriptions, their
// equivalents too) plus the estimates booked for engines that report tokens
// but no price (server/model-prices.ts). A turn on an unpriced model counts
// nothing. Enforced only with the `budgets` entitlement; without it the
// setting is inert.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppConfig } from "./config.ts";
import { entitled } from "./enterprise.ts";
import { readUsage, usageRowKey } from "./usage-ledger.ts";

export interface SpendState {
  month: string;
  monthlyUsd: number;
  spentUsd: number;
  percent: number;
  warnAtPercent: number;
  warn: boolean;
  exceeded: boolean;
}

const DEFAULT_WARN_AT_PERCENT = 80;
const CACHE_MS = 15_000;
// Every turn start asks; reading the month file each time would be silly.
// A read keeps the keys of the rows it summed, so a booked row can be told
// apart from the same row read back later.
const cache = new Map<string, { at: number; month: string; fileUsd: number; keys: Set<string> }>();
// Booked turns whose ledger row may not be on disk yet: dataDir → row key →
// cost. The append is asynchronous, and a turn that ran longer than CACHE_MS
// would otherwise be re-read out of the month before its own row landed.
const unwritten = new Map<string, Map<string, { month: string; costUsd: number }>>();

function monthOf(now: Date): string {
  return now.toISOString().slice(0, 7);
}

const costOf = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);

/** Reported and estimated cost this month so far: the ledger file (read at
 * most every CACHE_MS) plus turns booked since whose rows have not landed. */
export function monthToDateSpend(dataDir: string, now = new Date()): number {
  const month = monthOf(now);
  let read = cache.get(dataDir);
  if (!read || read.month !== month || now.getTime() - read.at >= CACHE_MS) {
    const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const rows = readUsage(dataDir, { from, to: now });
    read = { at: now.getTime(), month, fileUsd: rows.reduce((sum, row) => sum + costOf(row.costUsd), 0), keys: new Set(rows.map(usageRowKey)) };
    cache.set(dataDir, read);
  }
  let pending = 0;
  for (const [key, entry] of unwritten.get(dataDir) ?? []) {
    if (entry.month === month && !read.keys.has(key)) pending += entry.costUsd;
  }
  return read.fileUsd + pending;
}

/** Called as a turn is booked, with the ledger's write for its row
 * (appendUsage's promise). The cost counts from memory at once; when the
 * row lands it moves into the cached read, and a re-read that already sees
 * the row never counts it twice. A write that failed stops counting, as
 * the ledger has no row for it. */
export function noteSpend(
  dataDir: string,
  row: { at: string; threadId: string; botId: string; costUsd: number | null | undefined },
  written: Promise<boolean>,
): void {
  const costUsd = costOf(row.costUsd);
  if (!costUsd) return;
  const key = usageRowKey(row);
  const month = row.at.slice(0, 7);
  const entries = unwritten.get(dataDir) ?? new Map<string, { month: string; costUsd: number }>();
  unwritten.set(dataDir, entries);
  entries.set(key, { month, costUsd });
  void written.then((landed) => {
    entries.delete(key);
    if (entries.size === 0 && unwritten.get(dataDir) === entries) unwritten.delete(dataDir);
    const read = cache.get(dataDir);
    if (landed && read && read.month === month && !read.keys.has(key)) {
      read.fileUsd += costUsd;
      read.keys.add(key);
    }
  });
}

export function resetSpendCacheForTests(): void {
  cache.clear();
  unwritten.clear();
}

/** The cap and where the month stands against it; null when there is no
 * enforceable cap (no entitlement, or none set). */
export function spendState(
  cfg: Pick<AppConfig, "budgets">,
  dataDir: string,
  now = new Date(),
  isEntitled: (feature: string) => boolean = entitled,
): SpendState | null {
  const monthlyUsd = cfg.budgets?.monthlyUsd;
  if (!isEntitled("budgets") || typeof monthlyUsd !== "number" || !Number.isFinite(monthlyUsd) || monthlyUsd <= 0) return null;
  const spentUsd = monthToDateSpend(dataDir, now);
  const warnAtPercent = cfg.budgets?.warnAtPercent ?? DEFAULT_WARN_AT_PERCENT;
  const percent = Math.min(999, Math.round((spentUsd / monthlyUsd) * 100));
  return {
    month: monthOf(now),
    monthlyUsd,
    spentUsd,
    percent,
    warnAtPercent,
    warn: percent >= warnAtPercent,
    exceeded: spentUsd >= monthlyUsd,
  };
}

/** Dollars for a message: cents normally, mills for a cap under a cent. */
function usd(value: number): string {
  return Number.isInteger(Math.round(value * 1000) / 10) ? value.toFixed(2) : value.toFixed(3);
}

/** Throws the HTTP-shaped refusal a turn start gets once the cap is reached. */
export function assertWithinBudget(
  cfg: Pick<AppConfig, "budgets">,
  dataDir: string,
  now = new Date(),
  isEntitled: (feature: string) => boolean = entitled,
): void {
  const state = spendState(cfg, dataDir, now, isEntitled);
  if (!state?.exceeded) return;
  throw Object.assign(
    new Error(`this workspace has reached its monthly spend limit of $${usd(state.monthlyUsd)} — an admin can raise it under Settings → Usage`),
    { status: 409, code: "spend_cap" },
  );
}

export type SpendAlert = "warn" | "cap";

interface AlertMarks {
  month: string;
  monthlyUsd: number;
  warn?: true;
  cap?: true;
}

const ALERTS_FILE = "alerts.json";

function readMarks(dataDir: string): AlertMarks | null {
  try {
    const value: unknown = JSON.parse(readFileSync(join(dataDir, "usage", ALERTS_FILE), "utf8"));
    if (typeof value !== "object" || value === null) return null;
    const marks = value as AlertMarks;
    return typeof marks.month === "string" && typeof marks.monthlyUsd === "number" ? marks : null;
  } catch {
    return null;
  }
}

/** The notice this booking should raise, if any: the cap the first time the
 * month reaches it, the warning the first time it crosses the threshold, and
 * nothing again for either that month. A new month, or a different cap, is a
 * new budget and starts over. Marks live beside the ledger so a restart does
 * not repeat them; if they cannot be written the notice is still sent once
 * for this run. */
export function takeSpendAlert(dataDir: string, state: SpendState | null): SpendAlert | null {
  if (!state || (!state.warn && !state.exceeded)) return null;
  const saved = readMarks(dataDir) ?? memoryMarks.get(dataDir) ?? null;
  const marks: AlertMarks = saved && saved.month === state.month && saved.monthlyUsd === state.monthlyUsd
    ? saved
    : { month: state.month, monthlyUsd: state.monthlyUsd };
  const alert: SpendAlert | null = state.exceeded && !marks.cap ? "cap" : state.warn && !marks.warn && !marks.cap ? "warn" : null;
  if (!alert) return null;
  // Reaching the cap also answers the warning: one notice, the stronger one.
  const next: AlertMarks = { ...marks, warn: true, ...(alert === "cap" ? { cap: true as const } : {}) };
  memoryMarks.set(dataDir, next);
  try {
    mkdirSync(join(dataDir, "usage"), { recursive: true, mode: 0o700 });
    writeFileSync(join(dataDir, "usage", ALERTS_FILE), JSON.stringify(next), { mode: 0o600 });
  } catch {
    /* bookkeeping must never take down the turn */
  }
  return alert;
}
const memoryMarks = new Map<string, AlertMarks>();

export function resetSpendAlertsForTests(): void {
  memoryMarks.clear();
}

/** The notice's words. English like the server's other notification titles. */
export function spendAlertText(alert: SpendAlert, state: SpendState): { title: string; body: string } {
  const spent = `$${state.spentUsd.toFixed(2)} of $${usd(state.monthlyUsd)} spent this month (${state.month})`;
  return alert === "cap"
    ? { title: "Monthly spend limit reached", body: `${spent}. New turns are refused until an admin raises the limit under Settings → Usage.` }
    : { title: `Spend is at ${state.percent}% of the monthly limit`, body: `${spent}. New turns stop when the limit is reached.` };
}
