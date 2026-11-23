import { useEffect } from "react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { useAdvancedMode } from "@/lib/interface-mode";
import { formatResetDistance, usePlanUsage, type PlanProvider } from "./PlanUsage";

export interface PlanUsageBandLine {
  label: string;
  percent: number;
  resetsAt: string | null;
}

type Tone = "ok" | "near" | "full";

const BAR: Record<Tone, string> = { ok: "bg-success", near: "bg-warning", full: "bg-danger" };
const TEXT: Record<Tone, string> = { ok: "text-ink-secondary", near: "text-warning", full: "text-danger" };
const level = (percent: number): Tone => percent >= 90 ? "full" : percent >= 75 ? "near" : "ok";

function linesFor(provider: PlanProvider): PlanUsageBandLine[] {
  const lines: PlanUsageBandLine[] = [];
  if (provider.fiveHour.available) lines.push({ label: t("planUsage.fiveHour"), percent: provider.fiveHour.usedPercent ?? 0, resetsAt: provider.fiveHour.resetsAt });
  if (provider.weekly.available) lines.push({ label: t("planUsage.weekly"), percent: provider.weekly.usedPercent ?? 0, resetsAt: provider.weekly.resetsAt });
  for (const extra of provider.extra) lines.push({ label: extra.label, percent: extra.usedPercent, resetsAt: extra.resetsAt });
  return lines.slice(0, 3);
}

/** The active AI's plan windows, above the composer: the same report AI plan limits reads, for any provider. */
export function PlanUsageBand({ instanceId }: { instanceId: string }) {
  const advanced = useAdvancedMode();
  if (!advanced) return null;
  return <AdvancedPlanUsageBand instanceId={instanceId} />;
}

function AdvancedPlanUsageBand({ instanceId }: { instanceId: string }) {
  const { report, now, load } = usePlanUsage();
  useEffect(() => {
    const timer = window.setInterval(() => void load(false), 60_000);
    return () => window.clearInterval(timer);
  }, [load]);
  if (!report) return null;
  const provider = report.providers.find((row) => row.id === instanceId);
  if (!provider?.ok) return null;
  const lines = linesFor(provider);
  if (lines.length === 0) return null;
  return <PlanUsageBandView lines={lines} now={now} />;
}

export function PlanUsageBandView({ lines, now }: { lines: PlanUsageBandLine[]; now: number }) {
  return (
    <div data-plan-usage-band role="group" aria-label={t("planUsage.title")}
      className="pointer-events-auto mx-auto mb-2 flex w-fit max-w-full flex-wrap items-center justify-center gap-1.5 px-4">
      {lines.map((line, index) => {
        const percent = Math.round(Math.min(100, Math.max(0, line.percent)));
        const tone = level(percent);
        const reset = formatResetDistance(line.resetsAt, now);
        const title = [t("planUsage.used", { used: percent }), reset ? t("planUsage.resetsIn", { when: reset }) : ""].filter(Boolean).join(" · ");
        return (
          <div key={`${line.label}-${index}`} title={title}
            className="flex h-8 items-center gap-2 rounded-full border border-hairline bg-card px-3 text-[12px] leading-none">
            <span className="font-medium text-ink-secondary">{line.label}</span>
            <span role="meter" aria-label={line.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}
              className="h-1.5 w-16 overflow-hidden rounded-full bg-ink/[0.08]">
              <span className={cn("block h-full rounded-full", BAR[tone])} style={{ width: `${percent > 0 ? Math.max(percent, 2) : 0}%` }} />
            </span>
            <span className={cn("font-medium tabular-nums", TEXT[tone])}>{percent}%</span>
            {reset && (
              <>
                <span aria-hidden="true" className="text-ink-tertiary">·</span>
                <span className="tabular-nums text-ink-tertiary">{reset}</span>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
