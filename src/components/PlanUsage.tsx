import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { api } from "@/state/store";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { Card, SIMPLE_CARD } from "./SettingsPrimitives";
import { UsageSummaryCard } from "./CloudUsageMeter";
import { formatPlanSpend, type PlanSpend } from "@/lib/plan-spend";

interface PlanWindow {
  available: boolean;
  remainingPercent: number | null;
  usedPercent: number | null;
  resetsAt: string | null;
}

interface PlanExtra {
  label: string;
  remainingPercent: number;
  usedPercent: number;
  resetsAt: string | null;
  spend?: PlanSpend;
}

interface PlanModelUsage {
  name: string;
  windows: PlanExtra[];
}

interface PlanProvider {
  id: string;
  name: string;
  driver: string;
  plan: string | null;
  ok: boolean;
  error: string | null;
  fiveHour: PlanWindow;
  weekly: PlanWindow;
  extra: PlanExtra[];
  models?: PlanModelUsage[];
}

interface PlanUsageReport {
  fetchedAt: string;
  providers: PlanProvider[];
}

function formatResetDistance(resetsAt: string | null, now: number): string | null {
  if (!resetsAt) return null;
  const at = Date.parse(resetsAt);
  if (!Number.isFinite(at) || at <= now) return null;
  const minutes = Math.floor((at - now) / 60_000);
  if (minutes < 1) return "less than a minute";
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  return `${mins}m`;
}

function dueResetDeadlines(report: PlanUsageReport, now: number, seen: Set<string>): string[] {
  const due: string[] = [];
  for (const provider of report.providers) {
    if (!provider.ok) continue;
    const stamps = [
      provider.fiveHour.available ? provider.fiveHour.resetsAt : null,
      provider.weekly.available ? provider.weekly.resetsAt : null,
      ...provider.extra.map((extra) => extra.resetsAt),
      ...(provider.models ?? []).flatMap((model) => model.windows.map((entry) => entry.resetsAt)),
    ];
    for (const resetsAt of stamps) {
      if (!resetsAt || seen.has(resetsAt) || due.includes(resetsAt)) continue;
      const at = Date.parse(resetsAt);
      if (Number.isFinite(at) && at <= now) due.push(resetsAt);
    }
  }
  return due;
}

function usageTone(used: number): string {
  if (used >= 90) return "bg-danger";
  if (used >= 70) return "bg-warning";
  return "bg-success";
}

function windowLabel(label: string): string {
  if (label === "5-hour") return t("planUsage.fiveHour");
  if (label === "Weekly") return t("planUsage.weekly");
  if (label === "Monthly spend") return t("planUsage.monthlySpend");
  return label;
}

function providerLabel(provider: Pick<PlanProvider, "name">): string {
  const normalized = provider.name.trim().toLowerCase();
  if (normalized === "chatgpt plan") return t("planUsage.provider.chatgptPlan");
  if (normalized === "claude (api key)") return t("planUsage.provider.claudeApiKey");
  return provider.name;
}

function providerError(provider: Pick<PlanProvider, "error">): string | null {
  const message = provider.error?.trim();
  if (!message) return null;
  const signIn = /^Sign in again in (.+)$/i.exec(message);
  return signIn ? t("planUsage.signInAgain", { provider: providerLabel({ name: signIn[1]! }) }) : message;
}

function WindowRow({
  label,
  window,
  now,
  usedHeadline = false,
  detail,
}: {
  label: string;
  window: PlanWindow;
  now: number;
  usedHeadline?: boolean;
  detail?: string;
}) {
  const when = window.available ? formatResetDistance(window.resetsAt, now) : null;
  const used = window.usedPercent ?? 0;
  const headline = usedHeadline
    ? window.usedPercent == null ? null : t("planUsage.used", { used: Math.round(window.usedPercent) })
    : window.remainingPercent == null ? null : t("planUsage.left", { remaining: Math.round(window.remainingPercent) });
  return (
    <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-x-3 gap-y-1">
      <div className="text-[12px] text-ink-secondary">{label}</div>
      {window.available && headline ? (
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-2 text-[13px] text-ink">
            <span className="tabular-nums">{headline}</span>
            {detail && <span data-plan-spend className="text-[12px] tabular-nums text-ink-secondary">{detail}</span>}
            {when && <span className="text-[12px] text-ink-secondary">{t("planUsage.resetsIn", { when })}</span>}
          </div>
          <div
            className="mt-1 h-1.5 overflow-hidden rounded-full bg-inset"
            role="meter"
            aria-label={label}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(Math.min(100, Math.max(0, used)))}
          >
            <div className={cn("h-full rounded-full", usageTone(used))} style={{ width: `${Math.min(100, Math.max(0, used))}%` }} />
          </div>
        </div>
      ) : (
        <div className="text-[12px] text-ink-secondary">{t("planUsage.notReported")}</div>
      )}
    </div>
  );
}

/** One allowance row from the hub console's /api/quota (relayed here as /hub/quota). */
interface HubQuota {
  name?: string;
  displayName?: string;
  used?: number;
  total?: number;
  unlimited?: boolean;
  recurring?: boolean;
  resetAt?: string;
  remainingPercentage?: number;
}

interface HubQuotaWorker {
  worker: string;
  account?: string;
  plan?: string;
  quotas?: HubQuota[];
}

interface HubQuotaReport {
  updatedAt?: string;
  workers?: Record<string, HubQuotaWorker>;
}

const NO_WINDOW: PlanWindow = { available: false, remainingPercent: null, usedPercent: null, resetsAt: null };

/** The hub console already knows each worker's remaining allowance (it reads the vendor dashboards). This turns one
 * worker into the same shape the plan probe returns, so both sources render through one code path. */
/** "Bonus Pack 1", "Bonus Pack 2" … are one bucket in the vendor's books: same kind, different expiry. Read as a
 * single row, or a provider with twenty of them pushes the real plan off the card. */
function hubBucket(label: string): string {
  return label.replace(/\s*#?\s*\d+\s*$/, "").trim() || label;
}

function hubProvider(key: string, worker: HubQuotaWorker): PlanProvider {
  // Sum same-kind buckets first: used/total add up, the earliest reset is the one that matters.
  const pooled = new Map<string, { label: string; used: number; total: number; resetAt: string | null }>();
  for (const quota of worker.quotas ?? []) {
    const rawLabel = quota.displayName || quota.name || "Quota";
    const label = hubBucket(rawLabel);
    const total = typeof quota.total === "number" ? quota.total : 0;
    const used = typeof quota.used === "number" ? quota.used : 0;
    const at = pooled.get(label);
    if (!at) {
      pooled.set(label, { label, used, total, resetAt: quota.resetAt ?? null });
      continue;
    }
    at.used += used;
    at.total += total;
    if (quota.resetAt && (!at.resetAt || quota.resetAt < at.resetAt)) at.resetAt = quota.resetAt;
  }
  const extra: PlanExtra[] = [...pooled.values()].map((bucket) => {
    const remaining = bucket.total > 0 ? ((bucket.total - bucket.used) / bucket.total) * 100 : 100;
    const remainingPercent = Math.min(100, Math.max(0, remaining));
    return {
      label: bucket.label,
      remainingPercent,
      usedPercent: 100 - remainingPercent,
      resetsAt: bucket.resetAt,
    };
  });
  const account = worker.account?.trim();
  return {
    // `hub:` keeps these from colliding with the probe's own provider ids.
    id: `hub:${key}`,
    name: key,
    driver: key,
    plan: [worker.plan, account].filter(Boolean).join(" · ") || null,
    ok: extra.length > 0,
    error: extra.length > 0 ? null : t("planUsage.notReported"),
    fiveHour: NO_WINDOW,
    weekly: NO_WINDOW,
    extra,
  };
}

/** Name key used to decide "the probe and the hub are talking about the same provider". */
function providerKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Fold the hub's numbers into the probe's report.
 *
 * The probe only answers for what OpenMausBot itself signed in to; everything else comes back
 * "Sign in again". The hub console signs in through each vendor's own CLI, so it often has numbers for
 * exactly those providers — and for workers the probe does not know at all. A provider the probe could
 * not read is replaced by the hub's numbers; a provider that answered stays authoritative.
 */
export function mergeHubQuota(report: PlanUsageReport | null, hub: HubQuotaReport | null): PlanUsageReport | null {
  if (!report || !hub?.workers) return report;
  const providers = [...report.providers];
  const index = new Map(providers.map((provider, at) => [providerKey(provider.name), at]));
  for (const [key, worker] of Object.entries(hub.workers)) {
    const fromHub = hubProvider(key, worker);
    if (!fromHub.ok) continue;
    const at = index.get(providerKey(key)) ?? index.get(providerKey(worker.worker ?? ""));
    if (at === undefined) {
      index.set(providerKey(key), providers.length);
      providers.push(fromHub);
      continue;
    }
    const current = providers[at]!;
    if (!current.ok) providers[at] = { ...fromHub, id: current.id, name: current.name };
  }
  return { ...report, providers };
}

function usePlanUsage() {
  const [report, setReport] = useState<PlanUsageReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const refreshedDeadlines = useRef(new Set<string>());

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    setError("");
    try {
      // The hub relay is best effort: no console, no numbers, and the probe's own report still renders.
      const [data, hub] = await Promise.all([
        api<PlanUsageReport>(refresh ? "/api/plan-usage?refresh=1" : "/api/plan-usage"),
        // No refresh flag: the relay always reads the console's live snapshot, and an unknown query 404s there.
        api<HubQuotaReport>("/hub/quota").catch(() => null),
      ]);
      setReport(mergeHubQuota(data, hub));
      setNow(Date.now());
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : t("planUsage.fetchError"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!report) return;
    const due = dueResetDeadlines(report, now, refreshedDeadlines.current);
    if (due.length === 0) return;
    for (const deadline of due) refreshedDeadlines.current.add(deadline);
    void load(true);
  }, [report, now, load]);

  return { report, loading, error, now, load };
}

/** The budget of a plan with no weekly window, to stand in for the weekly figure. */
export function monthlySpend(report: Pick<PlanUsageReport, "providers"> | null): { provider: PlanProvider; budget: PlanExtra } | null {
  for (const provider of report?.providers ?? []) {
    const budget = provider.ok && !provider.weekly.available ? provider.extra.find((extra) => extra.label === "Monthly spend") : undefined;
    if (budget) return { provider, budget };
  }
  return null;
}

export function busiestWeekly(report: Pick<PlanUsageReport, "providers"> | null): { provider: PlanProvider; used: number } | null {
  let busiest: { provider: PlanProvider; used: number } | null = null;
  for (const provider of report?.providers ?? []) {
    const used = provider.ok && provider.weekly.available ? provider.weekly.usedPercent : null;
    if (used !== null && (!busiest || used > busiest.used)) busiest = { provider, used };
  }
  return busiest;
}

export function PlanUsageSummary() {
  const { report, now } = usePlanUsage();
  if (!report) return null;
  const busiest = busiestWeekly(report);
  const spending = busiest ? null : monthlySpend(report);
  if (spending) {
    const name = providerLabel(spending.provider);
    const used = Math.round(Math.min(100, Math.max(0, spending.budget.usedPercent)));
    return <UsageSummaryCard kind="plan" title={t("settings.simple.billing.monthlySpend", { provider: name })} percent={used} label={`${name}: ${t("planUsage.used", { used })}`}
      note={spending.budget.spend ? formatPlanSpend(spending.budget.spend) : null} />;
  }
  if (!busiest) {
    return <section data-usage-summary="own-ai" className={cn(SIMPLE_CARD, "px-4 py-3.5 text-[14px] leading-5 text-ink-secondary")}>{t("settings.simple.billing.ownAi")}</section>;
  }
  const percent = Math.round(Math.min(100, Math.max(0, busiest.used)));
  const when = formatResetDistance(busiest.provider.weekly.resetsAt, now);
  const name = providerLabel(busiest.provider);
  return (
    <UsageSummaryCard kind="plan" title={t("settings.simple.billing.weekly", { provider: name })} percent={percent} label={`${name}: ${t("planUsage.used", { used: percent })}`}
      note={when ? t("planUsage.resetsIn", { when }) : null} />
  );
}

export function PlanUsage() {
  const { report, loading, error, now, load } = usePlanUsage();

  return (
    <Card title={t("planUsage.title")} subtitle={t("planUsage.subtitle")}>
      <div className="mb-3 flex justify-end">
        <button
          type="button"
          onClick={() => void load(true)}
          disabled={loading}
          aria-label={t("planUsage.refresh")}
          title={t("planUsage.refresh")}
          className="rounded-md p-2 text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-50"
        >
          {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
        </button>
      </div>
      {loading && !report && <p role="status" className="text-[13px] text-ink-secondary">{t("planUsage.loading")}</p>}
      {error && <p role="alert" className="mb-3 text-[13px] text-danger">{error}</p>}
      {report && report.providers.length === 0 && (
        <p className="text-[13px] text-ink-secondary">{t("planUsage.empty")}</p>
      )}
      {report && report.providers.length > 0 && (
        <div className="flex flex-col gap-4">
          {report.providers.map((provider) => (
            <div key={provider.id} className="border-t border-hairline/30 pt-3 first:border-t-0 first:pt-0">
              <div className="mb-2 flex min-w-0 items-baseline gap-2">
                <span className="truncate text-[14px] font-medium text-ink">{providerLabel(provider)}</span>
                {provider.plan && <span className="truncate text-[12px] text-ink-secondary">{provider.plan}</span>}
              </div>
              {provider.ok ? (
                <div className="flex flex-col gap-2">
                  <WindowRow label={t("planUsage.fiveHour")} window={provider.fiveHour} now={now} />
                  <WindowRow label={t("planUsage.weekly")} window={provider.weekly} now={now} />
                  {provider.extra.map((extra, index) => (
                    <WindowRow
                      key={`${extra.label}-${index}`}
                      label={windowLabel(extra.label)}
                      now={now}
                      usedHeadline={Boolean(extra.spend)}
                      detail={extra.spend ? formatPlanSpend(extra.spend) : undefined}
                      window={{
                        available: true,
                        remainingPercent: extra.remainingPercent,
                        usedPercent: extra.usedPercent,
                        resetsAt: extra.resetsAt,
                      }}
                    />
                  ))}
                  {(provider.models ?? []).length > 0 && (
                    <div className="mt-1 flex flex-col gap-2">
                      <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-secondary">{t("planUsage.byModel")}</div>
                      {(provider.models ?? []).map((model) => (
                        <div key={model.name} className="flex flex-col gap-1">
                          <div className="truncate text-[13px] font-medium text-ink">{model.name}</div>
                          {model.windows.map((entry, index) => (
                            <WindowRow
                              key={`${model.name}-${entry.label}-${index}`}
                              label={windowLabel(entry.label)}
                              now={now}
                              usedHeadline
                              window={{
                                available: true,
                                remainingPercent: entry.remainingPercent,
                                usedPercent: entry.usedPercent,
                                resetsAt: entry.resetsAt,
                              }}
                            />
                          ))}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-[13px] text-danger">{providerError(provider)}</p>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
