import { USAGE_STALE_MS, type EngineUsage } from "../../server/usage-types";

export const RING_CIRCUMFERENCE = 2 * Math.PI * 8;
export const ringOffset = (percent: number | null) => RING_CIRCUMFERENCE * (1 - Math.max(0, Math.min(100, percent ?? 0)) / 100);
export type UsageTone = "ok" | "low" | "critical" | "exhausted" | "unknown";
export function usageView(engine?: EngineUsage, now = Date.now()): { percent: number | null; tone: UsageTone; resetsAt: string | null } {
  if (!engine || !engine.updatedAt || now - Date.parse(engine.updatedAt) > USAGE_STALE_MS || engine.status === "unknown") return { percent: null, tone: "unknown", resetsAt: null };
  const windows = engine.windows.filter(w => w.remainingPercent !== null && (!w.resetsAt || Date.parse(w.resetsAt) > now) && now - Date.parse(w.updatedAt ?? engine.updatedAt) <= USAGE_STALE_MS);
  if (engine.status === "exhausted") {
    const empty = windows.filter(w => w.remainingPercent === 0);
    const resetsAt = empty.length && empty.every(w => w.resetsAt) ? empty.map(w => w.resetsAt!).sort().at(-1)! : null;
    return { percent: 0, tone: "exhausted", resetsAt };
  }
  const tightest = windows.sort((a, b) => a.remainingPercent! - b.remainingPercent!)[0];
  const percent = tightest ? Math.max(0, Math.min(100, tightest.remainingPercent!)) : null;
  return { percent, tone: percent === null ? "unknown" : percent === 0 ? "exhausted" : percent < 15 ? "critical" : percent <= 40 ? "low" : "ok", resetsAt: tightest?.resetsAt ?? null };
}
export function refreshTime(iso: string, now = Date.now()): string {
  const date = new Date(iso);
  return date.toLocaleString(undefined, { weekday: date.toDateString() === new Date(now).toDateString() ? undefined : "short", hour: "numeric", minute: "2-digit" });
}
export function usageLabel(name: string, engine?: EngineUsage, now = Date.now()): string {
  const view = usageView(engine, now);
  if (view.tone === "unknown") return `${name} usage: not reported by this AI app`;
  const suffix = view.resetsAt ? `, refreshes at ${refreshTime(view.resetsAt, now)}` : "";
  if (view.tone === "exhausted") return `${name} usage ran out${suffix}`;
  const status = view.tone === "critical" ? " almost out" : view.tone === "low" ? " low" : "";
  const windows = (engine?.windows ?? []).map(w => `${w.label}: ${w.remainingPercent === null ? "not reported" : `${Math.round(w.remainingPercent)} percent left`}${w.resetsAt ? `, refreshes at ${refreshTime(w.resetsAt, now)}` : ""}`).join(". ");
  return `${name} usage${status}: ${Math.round(view.percent!)} percent left${suffix}${windows ? `. ${windows}` : ""}`;
}
export function urgentUsage<T extends { usage?: EngineUsage }>(items: T[], now = Date.now()): T | undefined {
  const rank: Record<UsageTone, number> = { exhausted: 0, critical: 1, low: 2, ok: 3, unknown: 4 };
  return [...items].sort((a, b) => {
    const av = usageView(a.usage, now), bv = usageView(b.usage, now);
    return rank[av.tone] - rank[bv.tone] || (av.percent ?? 101) - (bv.percent ?? 101);
  })[0];
}
