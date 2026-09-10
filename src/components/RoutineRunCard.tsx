import { ArrowRight, Loader2 } from "lucide-react";

import { cn } from "@/lib/cn";
import { routineDateTime } from "@/lib/routine-display";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import type { RoutineRunCardData } from "../../shared/routine-run";
import type { Message } from "@/state/store";

const DETAIL_LIMIT = 280;

const COPY = {
  queued: { labelKey: "runCard.status.queued", tone: "text-ink-secondary" },
  running: { labelKey: "runCard.status.running", tone: "text-accent" },
  waiting: { labelKey: "runCard.status.waiting", tone: "text-warning" },
  completed: { labelKey: "runCard.status.completed", tone: "text-ink-secondary" },
  failed: { labelKey: "runCard.status.failed", tone: "text-danger" },
  cancelled: { labelKey: "runCard.status.cancelled", tone: "text-ink-secondary" },
  missed: { labelKey: "runCard.status.missed", tone: "text-danger" },
} satisfies Record<
  RoutineRunCardData["status"],
  { labelKey: LocaleKey; tone: string }
>;

const GOAL_COPY = {
  completed: COPY.completed,
  "needs-input": { labelKey: "runCard.goal.needsInput", tone: "text-warning" },
  blocked: { labelKey: "runCard.goal.blocked", tone: "text-danger" },
  "limit-reached": { labelKey: "runCard.goal.limitReached", tone: "text-warning" },
  paused: { labelKey: "runCard.goal.paused", tone: "text-warning" },
  stopped: { labelKey: "runCard.goal.stopped", tone: "text-ink-secondary" },
  failed: COPY.failed,
} satisfies Record<
  NonNullable<RoutineRunCardData["goalStatus"]>,
  { labelKey: LocaleKey; tone: string }
>;

function compactDetail(value: string | undefined): string {
  const clean = value?.replace(/\s+/g, " ").trim() ?? "";
  return clean.length > DETAIL_LIMIT ? `${clean.slice(0, DETAIL_LIMIT - 1).trimEnd()}…` : clean;
}

/** A lifecycle receipt can outlive its isolated execution task. Only offer
 * navigation while the task is still present in the owning bot's task list. */
export function hasRoutineExecutionTask(
  tasks: ReadonlyArray<{ threadId: string }> | undefined,
  executionThreadId: string | undefined,
): executionThreadId is string {
  return Boolean(
    executionThreadId && tasks?.some((task) => task.threadId === executionThreadId),
  );
}

export function RoutineRunCard({
  message,
  onOpen,
}: {
  message: Message;
  /** Opens the isolated execution task; absent when it no longer exists. */
  onOpen?: () => void;
}) {
  const run = message.routineRun;
  // Newer computers can send this message kind to an older or partially
  // hydrated client. Keep the concise text fallback visible instead of
  // leaving an unexplained hole in the conversation.
  if (!run) {
    const fallback = compactDetail(message.text);
    return fallback ? (
      <div className="w-fit max-w-[min(42rem,88%)] rounded-2xl bg-card px-4 py-2.5 text-[14px] leading-relaxed text-ink">
        {fallback}
      </div>
    ) : null;
  }

  const copy = run.goalStatus ? GOAL_COPY[run.goalStatus] : COPY[run.status];
  const detail = compactDetail(
    run.status === "failed" || run.status === "missed"
      ? (run.error ?? run.summary)
      : (run.summary ?? run.error),
  );
  const actionLabel = t(run.goalStatus === "needs-input" ? "runCard.review" : "runCard.openRun");

  return (
    <section
      aria-label={t("runCard.aria", { name: run.routineName, status: t(copy.labelKey) })}
      className="w-full max-w-[680px] rounded-xl border border-hairline/45 bg-card px-4 py-3"
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <h3 className="truncate text-[14px] font-semibold text-ink">{run.routineName}</h3>
            <span aria-live="polite" className={cn("inline-flex items-center gap-1 text-[11.5px] font-semibold", copy.tone)}>
              {run.status === "running" && !run.goalStatus && <Loader2 aria-hidden="true" className="size-3 animate-spin" />}
              {t(copy.labelKey)}
            </span>
          </div>
          <time dateTime={new Date(run.scheduledFor ?? message.at).toISOString()} className="mt-0.5 block text-[11.5px] text-ink-secondary">
            {routineDateTime(run.scheduledFor ?? message.at)}
          </time>
          {detail && <p className="mt-1.5 text-[13px] leading-relaxed text-ink-secondary">{detail}</p>}
          {run.status === "completed" && run.summary && run.summary.length > DETAIL_LIMIT && <details className="mt-2 text-[12px] text-ink-secondary">
            <summary className="cursor-pointer font-medium text-ink-secondary hover:text-ink">{t("routines.results.showReport")}</summary>
            <p className="mt-2 whitespace-pre-wrap leading-relaxed">{run.summary}</p>
          </details>}
        </div>
        {onOpen && run.executionThreadId && (
          <button
            type="button"
            onClick={onOpen}
            aria-label={t("runCard.actionAria", { action: actionLabel, name: run.routineName })}
            className={cn(
              "flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[12px] font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent",
              run.goalStatus === "needs-input"
                ? "bg-warning/15 text-warning hover:bg-warning/25"
                : "text-ink-secondary hover:bg-inset hover:text-ink",
            )}
          >
            {actionLabel}
            <ArrowRight aria-hidden="true" size={13} />
          </button>
        )}
      </div>
    </section>
  );
}
