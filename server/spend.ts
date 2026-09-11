// Spend limits over the usage ledger: what this workspace has spent this
// month against its cap, and the refusal a turn gets once the cap is
// reached. The figure is the cost engines reported to the ledger, so on a
// workspace of personal subscriptions it counts their equivalents too; on
// keys it is what the operator actually pays. Enforced only with the
// `budgets` entitlement; without it the setting is inert.
import type { AppConfig } from "./config.ts";
import { entitled } from "./enterprise.ts";
import { readUsage } from "./usage-ledger.ts";

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
const cache = new Map<string, { at: number; month: string; spentUsd: number }>();

function monthOf(now: Date): string {
  return now.toISOString().slice(0, 7);
}

/** Reported cost this month so far, from the ledger, cached briefly. */
export function monthToDateSpend(dataDir: string, now = new Date()): number {
  const month = monthOf(now);
  const hit = cache.get(dataDir);
  if (hit && hit.month === month && now.getTime() - hit.at < CACHE_MS) return hit.spentUsd;
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const spentUsd = readUsage(dataDir, { from, to: now }).reduce(
    (sum, row) => sum + (typeof row.costUsd === "number" && Number.isFinite(row.costUsd) ? row.costUsd : 0),
    0,
  );
  cache.set(dataDir, { at: now.getTime(), month, spentUsd });
  return spentUsd;
}

/** Called right after a turn is booked, so the next check sees it without
 * waiting for the ledger's append to land or the cache to expire. */
export function noteSpend(dataDir: string, costUsd: number | null | undefined, now = new Date()): void {
  const hit = cache.get(dataDir);
  if (hit && hit.month === monthOf(now) && typeof costUsd === "number" && Number.isFinite(costUsd) && costUsd > 0) {
    hit.spentUsd += costUsd;
  }
}

export function resetSpendCacheForTests(): void {
  cache.clear();
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
