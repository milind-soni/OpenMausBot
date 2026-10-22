import {
  CheckCircle2,
  CircleAlert,
  Hand,
  Loader2,
  Square,
  XCircle,
} from "lucide-react";

import { cn } from "@/lib/cn";
import type { Message } from "@/state/store";
import type { GroupGoalRunCardData } from "../../shared/group-goal-run";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";

const DETAIL_LIMIT = 280;

const COPY = {
  working: { label: "routines.goal.working", tone: "text-accent", border: "border-accent/30" },
  completed: { label: "routines.goal.completed", tone: "text-success", border: "border-success/30" },
  "needs-input": { label: "routines.goal.needs-input", tone: "text-warning", border: "border-warning/35" },
  blocked: { label: "routines.goal.blocked", tone: "text-warning", border: "border-warning/35" },
  "limit-reached": { label: "routines.goal.limit-reached", tone: "text-warning", border: "border-warning/35" },
  paused: { label: "routines.goal.paused", tone: "text-warning", border: "border-warning/35" },
  stopped: { label: "routines.goal.stopped", tone: "text-ink-secondary", border: "border-hairline/45" },
  failed: { label: "routines.goal.failed", tone: "text-danger", border: "border-danger/35" },
} satisfies Record<
  GroupGoalRunCardData["status"],
  { label: LocaleKey; tone: string; border: string }
>;

function compact(value: string | undefined, limit: number): string {
  const clean = value?.replace(/\s+/g, " ").trim() ?? "";
  return clean.length > limit ? `${clean.slice(0, limit - 1).trimEnd()}…` : clean;
}

function StatusIcon({ status }: { status: GroupGoalRunCardData["status"] }) {
  const className = "size-4 shrink-0";
  switch (status) {
    case "working":
      return <Loader2 aria-hidden="true" className={cn(className, "animate-spin text-accent")} />;
    case "completed":
      return <CheckCircle2 aria-hidden="true" className={cn(className, "text-success")} />;
    case "needs-input":
      return <Hand aria-hidden="true" className={cn(className, "text-warning")} />;
    case "blocked":
    case "limit-reached":
    case "paused":
      return <CircleAlert aria-hidden="true" className={cn(className, "text-warning")} />;
    case "stopped":
      return <Square aria-hidden="true" className={cn(className, "text-ink-secondary")} />;
    case "failed":
      return <XCircle aria-hidden="true" className={cn(className, "text-danger")} />;
  }
}

export function GoalRunCard({ message }: { message: Message }) {
  const run = message.goalRun;
  if (!run) {
    const fallback = compact(message.text, DETAIL_LIMIT);
    return fallback ? (
      <div className="w-fit max-w-[min(var(--chat-bubble-max),var(--chat-card-pct))] rounded-2xl bg-card px-4 py-2.5 text-[14px] leading-relaxed text-ink">
        {fallback}
      </div>
    ) : null;
  }

  const copy = COPY[run.status];
  const goal = compact(run.goal, 180);
  const detail = compact(run.detail, DETAIL_LIMIT);
  const turns = run.status === "working"
    ? t("routines.goal.turnOf", { turn: Math.min(run.turnCount + 1, run.maxTurns), max: run.maxTurns })
    : run.turnCount === 1 ? t("routines.goal.turnsOne") : t("routines.goal.turnsMany", { count: run.turnCount });

  return (
    <section
      aria-label={t("routines.goal.runLabel", { status: t(copy.label) })}
      className={cn("w-full max-w-[680px] rounded-2xl border bg-card px-3.5 py-3 shadow-sm", copy.border)}
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-xl bg-inset">
          <StatusIcon status={run.status} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <h3 className="truncate text-[13.5px] font-semibold text-ink">{goal || t("routines.goal.groupGoal")}</h3>
            <span aria-live="polite" className={cn("text-[11.5px] font-medium", copy.tone)}>
              {t(copy.label)}
            </span>
          </div>
          {detail && <p className="mt-1 line-clamp-2 text-[12.5px] leading-relaxed text-ink-secondary">{detail}</p>}
          <p className="mt-1 text-[11.5px] text-ink-tertiary">
            {t("routines.goal.coordinating", { name: run.coordinatorName, turns })}
          </p>
        </div>
      </div>
    </section>
  );
}
