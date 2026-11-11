// Monthly spend cap over the usage ledger; enforced only with the `budgets` entitlement.
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
const cache = new Map<string, { at: number; month: string; fileUsd: number; keys: Set<string> }>();
// Rows whose async ledger append may not have landed yet: a long turn would otherwise re-read the month without its own row.
const unwritten = new Map<string, Map<string, { month: string; costUsd: number }>>();

function monthOf(now: Date): string {
  return now.toISOString().slice(0, 7);
}

const costOf = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);

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

function usd(value: number): string {
  return Number.isInteger(Math.round(value * 1000) / 10) ? value.toFixed(2) : value.toFixed(3);
}

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

function writeMarks(dataDir: string, marks: AlertMarks): void {
  try {
    mkdirSync(join(dataDir, "usage"), { recursive: true, mode: 0o700 });
    writeFileSync(join(dataDir, "usage", ALERTS_FILE), JSON.stringify(marks), { mode: 0o600 });
    unsavedMarks.delete(dataDir);
  } catch {
    unsavedMarks.add(dataDir);
  }
}

export function takeSpendAlert(dataDir: string, state: SpendState | null): SpendAlert | null {
  const pending = unsavedMarks.has(dataDir) ? memoryMarks.get(dataDir) : undefined;
  if (pending) writeMarks(dataDir, pending);
  if (!state || (!state.warn && !state.exceeded)) return null;
  const saved = memoryMarks.get(dataDir) ?? readMarks(dataDir);
  const marks: AlertMarks = saved && saved.month === state.month && saved.monthlyUsd === state.monthlyUsd
    ? saved
    : { month: state.month, monthlyUsd: state.monthlyUsd };
  const alert: SpendAlert | null = state.exceeded && !marks.cap ? "cap" : state.warn && !marks.warn && !marks.cap ? "warn" : null;
  if (!alert) return null;
  const next: AlertMarks = { ...marks, warn: true, ...(alert === "cap" ? { cap: true as const } : {}) };
  memoryMarks.set(dataDir, next);
  writeMarks(dataDir, next);
  return alert;
}
const memoryMarks = new Map<string, AlertMarks>();
const unsavedMarks = new Set<string>();

export function resetSpendAlertsForTests(): void {
  memoryMarks.clear();
  unsavedMarks.clear();
}

export function spendAlertText(alert: SpendAlert, state: SpendState): { title: string; body: string } {
  const spent = `$${state.spentUsd.toFixed(2)} of $${usd(state.monthlyUsd)} spent this month (${state.month})`;
  return alert === "cap"
    ? { title: "Monthly spend limit reached", body: `${spent}. New turns are refused until an admin raises the limit under Settings → Usage.` }
    : { title: `Spend is at ${state.percent}% of the monthly limit`, body: `${spent}. New turns stop when the limit is reached.` };
}
