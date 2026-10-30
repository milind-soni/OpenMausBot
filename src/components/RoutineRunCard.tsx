import { ArrowRight, Loader2, Zap } from "lucide-react";

import { cn } from "@/lib/cn";
import { routineDateTime } from "@/lib/routine-display";
import { t } from "@/lib/i18n";
import { useShowThreads } from "@/lib/thread-preferences";
import { liveCardKind } from "../../shared/live-approval";
import type { AutomationLine, RoutineRunCardData } from "../../shared/routine-run";
import { formatTime, openNotificationTarget, useStore, type Message } from "@/state/store";

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
  onOpen?: () => void;
}) {
  const run = message.routineRun;
  if (!run) {
    const fallback = compactDetail(message.text);
    return fallback ? (
      <div className="w-fit max-w-[min(var(--chat-bubble-max),var(--chat-card-pct))] rounded-2xl bg-card px-4 py-2.5 text-[14px] leading-relaxed text-ink">
        {fallback}
      </div>
    ) : null;
  }

  const copy = run.goalStatus
    ? GOAL_COPY[run.goalStatus]
    : run.status === "queued" && run.deferredAt != null
      ? { label: "Deferred: target busy", tone: "text-warning" }
      : COPY[run.status];
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
            <span aria-live="polite" className={cn("inline-flex items-center gap-1 text-[12px] font-semibold", copy.tone)}>
              {run.status === "running" && !run.goalStatus && <Loader2 aria-hidden="true" className="size-3 animate-spin" />}
              {copy.label}
            </span>
          </div>
          <time dateTime={new Date(run.scheduledFor ?? message.at).toISOString()} className="mt-0.5 block text-[12px] text-ink-secondary">
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

export function RoutineRunRow({ message, botId }: { message: Message; botId: string }) {
  const { state, dispatch } = useStore();
  const showThreads = useShowThreads();
  const executionThreadId = message.routineRun?.executionThreadId;
  const canOpen = executionThreadId && state.bots.some((candidate) =>
    candidate.threadId === executionThreadId || hasRoutineExecutionTask(candidate.tasks, executionThreadId)
  );
  return (
    <RoutineRunCard
      message={message}
      onOpen={canOpen && executionThreadId
        ? () => openNotificationTarget(dispatch, { botId, threadId: executionThreadId }, state, showThreads)
        : undefined}
    />
  );
}

/** Above a line an automation run wrote in a chat: which automation, when, and the way to its full run. */
export function AutomationCaption({ message, line, botId }: { message: Message; line: AutomationLine; botId: string }) {
  const { state, dispatch } = useStore();
  const showThreads = useShowThreads();
  const canOpen = state.bots.some((bot) => bot.threadId === line.executionThreadId || hasRoutineExecutionTask(bot.tasks, line.executionThreadId));
  const asking = line.needsYou === true && (message.card ? liveCardKind(message.card) !== null : line.copyOf !== undefined ||
    !state.bots.find((bot) => bot.id === botId)?.messages.some((later) => later.role === "user" && later.at > message.at));
  const tone = line.failed ? "text-danger" : asking ? "text-warning" : "text-accent";
  return (
    <div data-automation-caption={line.runId} className="-mb-2 flex min-w-0 items-center gap-1.5 pl-0.5 text-[11px] text-ink-tertiary">
      <Zap aria-hidden="true" size={12} className={cn("shrink-0", tone)} />
      <span className="truncate font-medium text-ink-secondary">{line.name}</span>
      <time className="shrink-0" dateTime={new Date(line.scheduledFor).toISOString()}>· {formatTime(line.scheduledFor)}</time>
      {(line.failed || asking) && <span className={cn("shrink-0", tone)}>· {t(line.failed ? "chat.automation.failed" : "chat.automation.needsYou")}</span>}
      {canOpen && (
        <button
          type="button"
          onClick={() => openNotificationTarget(dispatch, { botId, threadId: line.executionThreadId }, state, showThreads)}
          aria-label={t("chat.automation.openRunFor", { name: line.name })}
          className="shrink-0 rounded px-1 hover:bg-inset hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        >
          {t("chat.automation.openRun")}
        </button>
      )}
    </div>
  );
}
