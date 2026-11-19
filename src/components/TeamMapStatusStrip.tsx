import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { Select } from "./Select";
import { providerLabel, usePlanUsage, usageTone, type PlanProvider } from "./PlanUsage";
import { teamMapSessionCounts, type TeamMapSession, type TeamMapSessionState } from "@/lib/team-map";

/** Sentinel `<Select>` value for "no department filter", distinct from the unsectioned team's own key (`""`). */
export const ALL_SECTIONS_FILTER = "__all__";

const COUNT_DOT: Record<TeamMapSessionState, string> = {
  running: "bg-success",
  stuck: "bg-danger",
  waiting: "bg-warning",
  queued: "bg-ink-secondary/35",
};

const COUNTED_STATES = ["running", "stuck", "waiting", "queued"] as const;

function countLabel(state: TeamMapSessionState, count: number): string {
  switch (state) {
    case "running": return t("canvas.strip.runningCount", { count });
    case "stuck": return t("canvas.strip.stuckCount", { count });
    case "waiting": return t("canvas.strip.waitingCount", { count });
    case "queued": return t("canvas.strip.queuedCount", { count });
  }
}

function primaryUsage(provider: PlanProvider): number | null {
  if (provider.weekly.available && provider.weekly.usedPercent != null) return provider.weekly.usedPercent;
  if (provider.fiveHour.available && provider.fiveHour.usedPercent != null) return provider.fiveHour.usedPercent;
  return null;
}

/** The Live layer's top strip: session-state counts, a compact per-provider usage readout, a department filter and the Live toggle. */
export function TeamMapStatusStrip({
  sessions,
  doneLast24h,
  sectionOptions,
  sectionFilter,
  onSectionFilterChange,
  live,
  onToggleLive,
}: {
  sessions: TeamMapSession[];
  doneLast24h: number;
  sectionOptions: { key: string; name: string }[];
  sectionFilter: string;
  onSectionFilterChange: (key: string) => void;
  live: boolean;
  onToggleLive: () => void;
}) {
  const { report } = usePlanUsage();
  const counts = teamMapSessionCounts(sessions);
  const usageProviders = (report?.providers ?? []).flatMap((provider) => {
    const used = provider.ok ? primaryUsage(provider) : null;
    return used === null ? [] : [{ provider, used: Math.round(Math.min(100, Math.max(0, used))) }];
  });
  return (
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-hairline/40 bg-panel px-6 py-2.5">
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        {COUNTED_STATES.filter((state) => counts[state] > 0).map((state) => (
          <span key={state} className="flex items-center gap-1.5 text-[12px] text-ink-secondary">
            <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", COUNT_DOT[state])} />
            {countLabel(state, counts[state])}
          </span>
        ))}
        {doneLast24h > 0 && <span className="text-[12px] text-ink-secondary">{t("canvas.strip.doneCount", { count: doneLast24h })}</span>}
        {usageProviders.length > 0 && (
          <div className="flex min-w-0 flex-wrap items-center gap-3 border-l border-hairline/40 pl-3">
            {usageProviders.map(({ provider, used }) => (
              <span key={provider.id} className="flex items-center gap-1.5 text-[11px] text-ink-secondary">
                <span className="max-w-[88px] truncate">{providerLabel(provider)}</span>
                <span className="h-1.5 w-10 overflow-hidden rounded-full bg-inset" role="meter" aria-label={providerLabel(provider)} aria-valuemin={0} aria-valuemax={100} aria-valuenow={used}>
                  <span className={cn("block h-full rounded-full", usageTone(used))} style={{ width: `${used}%` }} />
                </span>
                <span className="tabular-nums">{used}%</span>
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="flex items-center gap-2">
        {sectionOptions.length > 1 && (
          <Select aria-label={t("canvas.strip.filterDepartment")} size="sm" value={sectionFilter} onChange={(event) => onSectionFilterChange(event.target.value)}>
            <option value={ALL_SECTIONS_FILTER}>{t("canvas.strip.allDepartments")}</option>
            {sectionOptions.map((section) => <option key={section.key || "general"} value={section.key}>{section.name}</option>)}
          </Select>
        )}
        <button onClick={onToggleLive} aria-pressed={live} title={live ? t("canvas.strip.pauseHint") : t("canvas.strip.resumeHint")}
          className={cn("flex items-center gap-2 rounded-lg border px-3 py-2 text-[12px] font-medium transition-colors", live ? "border-accent/40 bg-accent/10 text-ink" : "border-hairline/60 bg-panel text-ink-secondary hover:bg-control hover:text-ink")}>
          <span aria-hidden className={cn("relative h-4 w-7 shrink-0 rounded-full transition-colors", live ? "bg-accent" : "bg-control")}>
            <span className={cn("absolute top-0.5 size-3 rounded-full bg-white shadow-sm transition-[left]", live ? "left-3.5" : "left-0.5")} />
          </span>
          {t("canvas.strip.live")}
        </button>
      </div>
    </div>
  );
}
