import type { PlanExtra, PlanWindows } from "./plan-usage.ts";
import { asRecord, closedWindow, extraLine, finiteNumber, isoOrNull, openWindow, planLabel, timeMs, titleWords } from "./plan-usage-values.ts";

/** GitHub's copilot_internal/user: premium requests are the monthly allowance, paid plans report chat and
 * completions as unlimited, and each snapshot's own quota_reset_at is 0 beside the plan's quota_reset_date_utc. */
export function parseCopilotUsage(body: unknown): PlanWindows {
  const root = asRecord(body);
  const extra: PlanExtra[] = [];
  const resetsAt = isoOrNull(root?.quota_reset_date_utc ?? root?.quota_reset_date);
  const snapshots = asRecord(root?.quota_snapshots);
  for (const [key, value] of Object.entries(snapshots ?? {})) {
    const snapshot = asRecord(value);
    if (!snapshot || snapshot.unlimited === true) continue;
    if (snapshot.has_quota === false && key !== "premium_interactions") continue;
    if (!/^[a-z][a-z0-9_]{0,40}$/i.test(key)) continue;
    const used = copilotUsedPercent(snapshot);
    if (used == null) continue;
    const ownReset = timeMs(snapshot.quota_reset_at);
    const window = openWindow(used, ownReset ? isoOrNull(ownReset) : resetsAt);
    const line: PlanExtra = key === "premium_interactions"
      ? { ...extraLine("Monthly", window), kind: "monthly" }
      : extraLine(titleWords(key), window);
    if (key === "premium_interactions") extra.unshift(line);
    else extra.push(line);
  }
  return { plan: planLabel(root?.copilot_plan), fiveHour: closedWindow(), weekly: closedWindow(), extra, models: [] };
}

function copilotUsedPercent(snapshot: Record<string, unknown>): number | null {
  const remaining = finiteNumber(snapshot.percent_remaining);
  if (remaining != null) return 100 - remaining;
  const entitlement = finiteNumber(snapshot.entitlement);
  const left = finiteNumber(snapshot.quota_remaining ?? snapshot.remaining);
  if (entitlement == null || left == null || entitlement <= 0) return null;
  return ((entitlement - left) / entitlement) * 100;
}
