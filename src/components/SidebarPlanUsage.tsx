import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { quietPlanRow } from "@/lib/plan-usage";
import { useSidebarPlanUsage } from "@/lib/sidebar-preferences";
import { meterBand, type MeterBand } from "@/lib/usage-meter";
import { api, useStore } from "@/state/store";

export const POLL_MS = 5 * 60_000;
export const WAKE_GAP_MS = 60_000;
const PRODUCTS = [{ driver: "claude", name: "Claude" }, { driver: "copilot", name: "Copilot" }];

type PlanWindowUse = { available: boolean; usedPercent: number | null; remainingPercent: number | null };
type PlanExtraUse = { label: string; kind?: "monthly"; usedPercent: number; remainingPercent: number };
export type SidebarPlanReport = {
  providers: Array<{ id: string; name: string; driver: string; ok: boolean; reason?: string | null; fiveHour: PlanWindowUse; weekly: PlanWindowUse; extra?: PlanExtraUse[] }>;
};
type SidebarPlanProvider = SidebarPlanReport["providers"][number];

export interface SidebarPlanWindow { label: string; percent: number }
export type SidebarPlanView =
  | { state: "ok"; product: string; name: string; windows: SidebarPlanWindow[] }
  | { state: "unavailable"; product: string; name: string };

export function windowPercent(use: PlanWindowUse): number | null {
  if (!use.available || use.usedPercent === null) return null;
  if (use.remainingPercent === 0 || use.usedPercent >= 100) return 100;
  return Math.min(99, Math.max(0, Math.floor(use.usedPercent)));
}

export const planTitle = (product: string, name: string) =>
  (name.startsWith(product) || name === `GitHub ${product}` ? name : `${product} · ${name}`);

const planRows = (report: SidebarPlanReport | null) =>
  report?.providers.filter((provider) => PRODUCTS.some((product) => product.driver === provider.driver)) ?? [];

function providerWindows(provider: SidebarPlanProvider): SidebarPlanWindow[] {
  const monthly = provider.extra?.find((entry) => entry.kind === "monthly");
  return [
    { label: t("planUsage.fiveHour"), percent: windowPercent(provider.fiveHour) },
    { label: t("planUsage.weekly"), percent: windowPercent(provider.weekly) },
    { label: t(monthly?.label === "Monthly spend" ? "planUsage.monthlySpend" : "planUsage.monthly"), percent: monthly ? windowPercent({ available: true, ...monthly }) : null },
  ].filter((entry): entry is SidebarPlanWindow => entry.percent !== null);
}

function busiestUse(provider: SidebarPlanProvider): number {
  const monthly = provider.extra?.find((entry) => entry.kind === "monthly");
  const used = [provider.fiveHour, provider.weekly].flatMap((use) => (use.available && use.usedPercent !== null ? [use.usedPercent] : []));
  return Math.max(-1, ...used, ...(monthly ? [monthly.usedPercent] : []));
}

function productView(product: (typeof PRODUCTS)[number], providers: SidebarPlanProvider[]): SidebarPlanView | null {
  const mine = providers.filter((provider) => provider.driver === product.driver);
  const rows = mine
    .filter((provider) => provider.ok)
    .map((provider) => ({ provider, windows: providerWindows(provider) }))
    .filter((row) => row.windows.length > 0);
  if (rows.length === 0) {
    const failed = mine.find((provider) => !provider.ok && !quietPlanRow(provider));
    return failed ? { state: "unavailable", product: product.driver, name: planTitle(product.name, failed.name) } : null;
  }
  const busiest = (row: (typeof rows)[number]) => busiestUse(row.provider);
  const tightest = rows.reduce((most, row) => (busiest(row) > busiest(most) ? row : most));
  return { state: "ok", product: product.driver, name: planTitle(product.name, tightest.provider.name), windows: tightest.windows };
}

export function sidebarPlanViews(report: SidebarPlanReport | null): SidebarPlanView[] {
  const providers = planRows(report);
  return PRODUCTS.map((product) => productView(product, providers)).filter((view): view is SidebarPlanView => view !== null);
}

export interface PlanPollerHost {
  now(): number;
  visible(): boolean;
  every(run: () => void, ms: number): () => void;
  onWake(run: () => void): () => void;
}

export function startPlanPoller(load: () => void, host: PlanPollerHost, options: { every: number | null; last: { at: number } }): () => void {
  const run = (gap: number) => {
    if (!host.visible() || host.now() - options.last.at < gap) return;
    options.last.at = host.now();
    load();
  };
  run(WAKE_GAP_MS);
  const stopTimer = options.every === null ? () => {} : host.every(() => run(0), options.every);
  const stopWake = host.onWake(() => run(WAKE_GAP_MS));
  return () => { stopTimer(); stopWake(); };
}

const browserHost: PlanPollerHost = {
  now: () => Date.now(),
  visible: () => document.visibilityState === "visible",
  every: (run, ms) => { const timer = window.setInterval(run, ms); return () => window.clearInterval(timer); },
  onWake: (run) => {
    window.addEventListener("focus", run);
    document.addEventListener("visibilitychange", run);
    return () => { window.removeEventListener("focus", run); document.removeEventListener("visibilitychange", run); };
  },
};

function useSidebarPlanReport(enabled: boolean): SidebarPlanReport | null {
  const [report, setReport] = useState<SidebarPlanReport | null>(null);
  const last = useRef({ at: Number.NEGATIVE_INFINITY });
  const noPlan = report !== null && sidebarPlanViews(report).length === 0;
  useEffect(() => {
    if (!enabled) return;
    const load = () => {
      void api<SidebarPlanReport>("/api/plan-usage", { background: true })
        // No cancelled flag: `last` outlives a restarted effect, so a dropped answer would not be asked for again for a minute.
        .then(setReport)
        .catch(() => {});
    };
    const stop = startPlanPoller(load, browserHost, { every: noPlan ? null : POLL_MS, last: last.current });
    return stop;
  }, [enabled, noPlan]);
  return enabled ? report : null;
}

const TONE: Record<MeterBand, string> = { ok: "text-accent", near: "text-warning", full: "text-danger" };
const AMOUNT: Record<MeterBand, string> = { ok: "text-ink-secondary", near: "text-warning", full: "text-danger" };
const RADIUS = 6;
const RING = 2 * Math.PI * RADIUS;
const MIN_ARC = 4;

function PlanRing({ entry }: { entry: SidebarPlanWindow }) {
  const band = meterBand(entry.percent);
  const arc = entry.percent > 0 ? Math.max(entry.percent, MIN_ARC) : 0;
  return (
    <span data-plan-ring={entry.label} data-band={band} title={`${entry.label} ${entry.percent}%`} className="flex shrink-0 items-center gap-1">
      <svg viewBox="0 0 16 16" className="size-3.5 -rotate-90">
        <circle cx="8" cy="8" r={RADIUS} fill="none" strokeWidth="2.5" className="stroke-current text-ink/15" />
        {arc > 0 && (
          <circle cx="8" cy="8" r={RADIUS} fill="none" strokeWidth="2.5" className={cn("stroke-current", TONE[band])}
            strokeDasharray={`${(RING * arc) / 100} ${RING}`} />
        )}
      </svg>
      <span className={cn("tabular-nums", AMOUNT[band])}>{entry.percent}%</span>
    </span>
  );
}

export function sidebarPlanLabel(view: SidebarPlanView): string {
  const detail = view.state === "ok" ? view.windows.map((entry) => `${entry.label} ${entry.percent}%`).join(", ") : t("planUsage.fetchError");
  return `${view.name}: ${detail} ${t("planUsage.title")}`;
}

export function SidebarPlanUsageView({ view, onOpen }: { view: SidebarPlanView; onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen} data-sidebar-plan-usage={view.state} aria-label={sidebarPlanLabel(view)} title={t("planUsage.title")}
      className="flex w-full min-w-0 items-center gap-2.5 rounded-lg px-2 py-1 text-start text-[11px] hover:bg-control/50">
      <span aria-hidden="true" className="min-w-0 flex-1 truncate font-medium text-ink-secondary">{view.name}</span>
      {view.state === "unavailable" ? (
        <span aria-hidden="true" className="min-w-0 truncate text-ink-tertiary">{t("planUsage.fetchError")}</span>
      ) : (
        <span aria-hidden="true" className="flex shrink-0 items-center gap-2.5">
          {view.windows.map((entry) => <PlanRing key={entry.label} entry={entry} />)}
        </span>
      )}
    </button>
  );
}

function ShownSidebarPlanUsage() {
  const { state, dispatch } = useStore();
  const enabled = state.config?.cloudHome !== true && window.ogb?.remoteClient?.active !== true;
  const views = sidebarPlanViews(useSidebarPlanReport(enabled));
  if (views.length === 0) return null;
  const open = () => dispatch({ type: "toggleAppSettings", open: true, section: "usage" });
  return <div className="mb-2">{views.map((view) => <SidebarPlanUsageView key={view.product} view={view} onOpen={open} />)}</div>;
}

export function SidebarPlanUsage() {
  return useSidebarPlanUsage() ? <ShownSidebarPlanUsage /> : null;
}
