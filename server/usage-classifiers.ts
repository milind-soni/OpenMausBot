import type { UsageClassification, UsagePatch, UsageWindow } from "./usage-types.ts";

const object = (value: unknown): Record<string, any> => value !== null && typeof value === "object" ? value as Record<string, any> : {};
function seconds(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return;
  const date = new Date(value * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

/** Pure Codex 0.164 account snapshot/rolling-update and turn-error classifier. */
export function classifyCodexUsage(payload: unknown): UsageClassification {
  const message = object(payload);
  const data = object(message.result ?? message.params ?? message);
  const bucketMap = object(data.rateLimitsByLimitId);
  const buckets = Object.keys(bucketMap).length ? Object.entries(bucketMap) : data.rateLimits ? [[object(data.rateLimits).limitId ?? "codex", data.rateLimits] as const] : [];
  if (buckets.length) {
    const windows: NonNullable<UsagePatch["windows"]> = [];
    let exhausted = data.ordinaryUsageAllowed === false;
    for (const [id, raw] of buckets) {
      const bucket = object(raw);
      exhausted ||= Boolean(bucket.rateLimitReachedType) || bucket.spendControlReached === true;
      for (const key of ["primary", "secondary"] as const) {
        const w = object(bucket[key]);
        if (!Object.keys(w).length) continue;
        const duration = w.windowDurationMins;
        const label = duration === 10080 ? "Weekly allowance" : typeof duration === "number" && duration > 0
          ? duration % 60 === 0 ? `${duration / 60}-hour allowance` : `${duration}-minute allowance` : undefined;
        windows.push({ id: `${id}:${key}`, label,
          remainingPercent: typeof w.usedPercent === "number" && Number.isFinite(w.usedPercent) ? Math.max(0, Math.min(100, 100 - w.usedPercent)) : undefined,
          resetsAt: seconds(w.resetsAt),
        });
      }
    }
    // Only explicit backend permission clears a previously exhausted state.
    const known = windows.flatMap(w => typeof w.remainingPercent === "number" ? [w.remainingPercent] : []);
    const status = exhausted ? "exhausted" : data.ordinaryUsageAllowed === true
      ? !known.length ? "unknown" : Math.min(...known) <= 0 ? "exhausted" : Math.min(...known) <= 40 ? "low" : "ok"
      : undefined;
    return { usage: { source: "reported", windows, status } };
  }
  const error = object(data.error ?? object(data.turn).error ?? message.error);
  if (error.codexErrorInfo === "usageLimitExceeded") {
    return { usage: { source: "inferred", status: "exhausted" }, failure: { kind: "usage_limit" } };
  }
  return {};
}

/** Claude numbers stay unknown: the spike did not verify their scale/units. */
export function classifyClaudeUsage(payload: unknown): UsageClassification {
  const message = object(payload);
  if (message.type === "rate_limit_event") {
    const info = object(message.rate_limit_info);
    if (info.status === "rejected" || info.errorCode === "credits_required") {
      return { usage: { source: "reported", status: "exhausted" }, failure: { kind: "usage_limit" } };
    }
    if (info.status === "allowed" || info.status === "allowed_warning") return { usage: { source: "reported", status: "unknown" } };
  }
  if (message.type === "assistant" && ["rate_limit", "billing_error"].includes(message.error)) {
    return { usage: { source: "inferred", status: "exhausted" }, failure: { kind: "usage_limit" } };
  }
  return {};
}

/** No validated wire mapping: generic 429/resource errors are not plan exhaustion. */
export function classifyGrokUsage(_payload: unknown): UsageClassification { return {}; }
export function classifyAntigravityUsage(_payload: unknown): UsageClassification { return {}; }

/** Reset to wait for when every currently exhausted window could have refreshed.
 * A read must still confirm recovery. Never invent a reset from error prose. */
export function usageLimitReset(windows: UsageWindow[], now = Date.now()): string | undefined {
  const exhausted = windows.filter(w => w.remainingPercent === 0);
  if (!exhausted.length || exhausted.some(w => !w.resetsAt || Date.parse(w.resetsAt) <= now)) return;
  return exhausted.map(w => w.resetsAt!).sort().at(-1);
}
