// The licensed monthly spend cap: enforced only with the `budgets` entitlement. It reads its total from the cap engine
// (usage-caps.ts) and adds its own warning threshold, admin notifications and a stop on every kind of turn.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SPEND_LIMIT_REFUSAL } from "../shared/setting-fixes.ts";
import type { AppConfig } from "./config.ts";
import { entitled } from "./enterprise.ts";
import { CAP_WARN_PERCENT, measure, monthKeyOf, noteUsage, periodEnd, resetUsageTotalsForTests, usageTotals } from "./usage-caps.ts";

export interface SpendState {
  month: string;
  monthlyUsd: number;
  spentUsd: number;
  percent: number;
  warnAtPercent: number;
  warn: boolean;
  exceeded: boolean;
}

const DEFAULT_WARN_AT_PERCENT = CAP_WARN_PERCENT;

export function monthToDateSpend(dataDir: string, now = new Date()): number {
  return usageTotals(dataDir, now).server.month.usd;
}

export const noteSpend = noteUsage;
export const resetSpendCacheForTests = resetUsageTotalsForTests;

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
  const { percent, warn, reached } = measure(monthlyUsd, spentUsd, warnAtPercent);
  return { month: monthKeyOf(now), monthlyUsd, spentUsd, percent, warnAtPercent, warn, exceeded: reached };
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
    new Error(`${SPEND_LIMIT_REFUSAL} of $${usd(state.monthlyUsd)} — an admin can raise it under Settings → Spending`),
    // When the month rolls over and work may start again: a Bot API caller is told it as Retry-After.
    { status: 409, code: "spend_cap", resetsAt: periodEnd("month", now) },
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
    ? { title: "Monthly spend limit reached", body: `${spent}. New turns are refused until an admin raises the limit under Settings → Spending.` }
    : { title: `Spend is at ${state.percent}% of the monthly limit`, body: `${spent}. New turns stop when the limit is reached.` };
}
