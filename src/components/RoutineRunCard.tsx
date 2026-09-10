import { ArrowRight, Loader2 } from "lucide-react";

import { cn } from "@/lib/cn";
import { routineDateTime } from "@/lib/routine-display";
import { t } from "@/lib/i18n";
import type { RoutineRunCardData } from "../../shared/routine-run";
import type { Message } from "@/state/store";

const DETAIL_LIMIT = 280;

const COPY = {
  queued: { label: "Queued", tone: "text-ink-secondary" },
  running: { label: "Running", tone: "text-accent" },
  waiting: { label: "Waiting", tone: "text-warning" },
  completed: { label: "Completed", tone: "text-ink-secondary" },
  failed: { label: "Failed", tone: "text-danger" },
  cancelled: { label: "Cancelled", tone: "text-ink-secondary" },
  missed: { label: "Missed", tone: "text-danger" },
} satisfies Record<
  RoutineRunCardData["status"],
  { label: string; tone: string }
>;

const GOAL_COPY = {
  completed: COPY.completed,
  "needs-input": { label: "Needs your input", tone: "text-warning" },
  blocked: { label: "Blocked", tone: "text-danger" },
  "limit-reached": { label: "Turn limit reached", tone: "text-warning" },
  paused: { label: "Paused", tone: "text-warning" },
  stopped: { label: "Stopped", tone: "text-ink-secondary" },
  failed: COPY.failed,
} satisfies Record<
  NonNullable<RoutineRunCardData["goalStatus"]>,
  { label: string; tone: string }
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
  const actionLabel = run.goalStatus === "needs-input" ? "Review" : "Open run";

  return (
    <section
      aria-label={`${run.routineName} routine run: ${copy.label}`}
      className="w-full max-w-[680px] rounded-xl border border-hairline/45 bg-card px-4 py-3"
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <h3 className="truncate text-[14px] font-semibold text-ink">{run.routineName}</h3>
            <span aria-live="polite" className={cn("inline-flex items-center gap-1 text-[11.5px] font-semibold", copy.tone)}>
              {run.status === "running" && !run.goalStatus && <Loader2 aria-hidden="true" className="size-3 animate-spin" />}
              {copy.label}
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
            aria-label={`${actionLabel} for ${run.routineName}`}
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
