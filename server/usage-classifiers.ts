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

function windowsStatus(windows: NonNullable<UsagePatch["windows"]>): UsagePatch["status"] {
  const known = windows.flatMap(w => typeof w.remainingPercent === "number" ? [w.remainingPercent] : []);
  if (!known.length) return "unknown";
  const tightest = Math.min(...known);
  return tightest <= 0 ? "exhausted" : tightest <= 40 ? "low" : "ok";
}

const CLAUDE_WINDOW_LABELS: Record<string, string> = {
  five_hour: "5-hour allowance",
  seven_day: "Weekly allowance",
  seven_day_opus: "Weekly Opus allowance",
  seven_day_sonnet: "Weekly Sonnet allowance",
};

/** Claude stream-json rate_limit_event: unifiedWindows carry utilization as a 0-1 fraction. */
export function classifyClaudeUsage(payload: unknown): UsageClassification {
  const message = object(payload);
  if (message.type === "rate_limit_event") {
    const info = object(message.rate_limit_info);
    if (info.status === "rejected" || info.errorCode === "credits_required") {
      return { usage: { source: "reported", status: "exhausted" }, failure: { kind: "usage_limit" } };
    }
    if (info.status === "allowed" || info.status === "allowed_warning") {
      const windows: NonNullable<UsagePatch["windows"]> = [];
      for (const [key, raw] of Object.entries(object(info.unifiedWindows))) {
        const w = object(raw);
        if (typeof w.utilization !== "number" || !Number.isFinite(w.utilization)) continue;
        windows.push({ id: `claude:${key}`, label: CLAUDE_WINDOW_LABELS[key] ?? "Current allowance",
          remainingPercent: Math.max(0, Math.min(100, 100 - w.utilization * 100)), resetsAt: seconds(w.resetsAt) });
      }
      return { usage: { source: "reported", windows, status: windowsStatus(windows) } };
    }
  }
  if (message.type === "assistant" && ["rate_limit", "billing_error"].includes(message.error)) {
    return { usage: { source: "inferred", status: "exhausted" }, failure: { kind: "usage_limit" } };
  }
  return {};
}

/** Claude account usage endpoint (what Claude Code's /usage shows): utilization is 0-100. */
export function classifyClaudeAccountUsage(payload: unknown): UsageClassification {
  const data = object(payload);
  const windows: NonNullable<UsagePatch["windows"]> = [];
  for (const key of Object.keys(CLAUDE_WINDOW_LABELS)) {
    const w = object(data[key]);
    if (typeof w.utilization !== "number" || !Number.isFinite(w.utilization)) continue;
    const reset = typeof w.resets_at === "string" && Number.isFinite(Date.parse(w.resets_at)) ? new Date(w.resets_at).toISOString() : null;
    windows.push({ id: `claude:${key}`, label: CLAUDE_WINDOW_LABELS[key], remainingPercent: Math.max(0, Math.min(100, 100 - w.utilization)), resetsAt: reset });
  }
  return windows.length ? { usage: { source: "reported", windows, status: windowsStatus(windows) } } : {};
}

/** Antigravity fetchAvailableModels: per-model quotaInfo, grouped by family (tightest model wins). */
export function classifyAntigravityQuota(payload: unknown): UsageClassification {
  const models = object(object(payload).models);
  const families = new Map<string, { remaining: number; resetsAt: string | null }>();
  for (const raw of Object.values(models)) {
    const model = object(raw);
    const quota = object(model.quotaInfo);
    if (typeof model.displayName !== "string" || typeof quota.remainingFraction !== "number") continue;
    const name = model.displayName.toLowerCase();
    const family = name.startsWith("claude") ? "Claude models" : name.includes("pro") ? "Gemini Pro" : name.startsWith("gemini") ? "Gemini Flash" : "Other models";
    const remaining = Math.max(0, Math.min(100, quota.remainingFraction * 100));
    const resetsAt = typeof quota.resetTime === "string" && Number.isFinite(Date.parse(quota.resetTime)) ? new Date(quota.resetTime).toISOString() : null;
    const prev = families.get(family);
    if (!prev || remaining < prev.remaining) families.set(family, { remaining, resetsAt });
  }
  if (!families.size) return {};
  const windows = [...families].map(([label, f]) => ({ id: `antigravity:${label.toLowerCase().replace(/\s+/g, "-")}`, label, remainingPercent: f.remaining, resetsAt: f.resetsAt }));
  return { usage: { source: "reported", windows, status: windowsStatus(windows) } };
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
