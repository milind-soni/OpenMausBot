import {
  CheckCircle2,
  CircleAlert,
  Hand,
  Loader2,
  Square,
  XCircle,
} from "lucide-react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { useStore, type Message } from "@/state/store";
import type { GroupGoalRunCardData } from "../../shared/group-goal-run";

const DETAIL_LIMIT = 280;

const COPY = {
  working: { label: "Working", tone: "text-accent", border: "border-accent/30" },
  completed: { label: "Completed", tone: "text-success", border: "border-success/30" },
  "needs-input": { label: "Needs your input", tone: "text-warning", border: "border-warning/35" },
  blocked: { label: "Blocked", tone: "text-warning", border: "border-warning/35" },
  "limit-reached": { label: "Turn limit reached", tone: "text-warning", border: "border-warning/35" },
  paused: { label: "Paused", tone: "text-warning", border: "border-warning/35" },
  stopped: { label: "Stopped", tone: "text-ink-secondary", border: "border-hairline/45" },
  failed: { label: "Failed", tone: "text-danger", border: "border-danger/35" },
} satisfies Record<
  GroupGoalRunCardData["status"],
  { label: string; tone: string; border: string }
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

/** `solo` is a one-on-one chat's run, where the bot works alone; `onStop` ends a working run from the card. */
export function GoalRunCard({ message, solo = false, onStop }: { message: Message; solo?: boolean; onStop?: () => void }) {
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
    ? `Turn ${Math.min(run.turnCount + 1, run.maxTurns)} of ${run.maxTurns}`
    : `${run.turnCount} ${run.turnCount === 1 ? "turn" : "turns"}`;

  return (
    <section
      aria-label={`Goal run: ${copy.label}`}
      className={cn("w-full max-w-[680px] rounded-2xl border bg-card px-3.5 py-3 shadow-sm", copy.border)}
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-xl bg-inset">
          <StatusIcon status={run.status} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <h3 className="truncate text-[14px] font-semibold text-ink">{goal || "Group goal"}</h3>
            <span aria-live="polite" className={cn("text-[12px] font-medium", copy.tone)}>
              {copy.label}
            </span>
          </div>
          {detail && <p className="mt-1 line-clamp-2 text-[13px] leading-relaxed text-ink-secondary">{detail}</p>}
          <p className="mt-1 text-[12px] text-ink-tertiary">
            {run.coordinatorName}{solo ? "" : " coordinating"} · {turns}
          </p>
        </div>
        {onStop && run.status === "working" && (
          <button
            type="button"
            onClick={onStop}
            className="shrink-0 rounded-lg border border-hairline/50 px-2.5 py-1 text-[12px] font-medium text-ink-secondary hover:bg-raised hover:text-ink"
          >
            {t("chat.stop")}
          </button>
        )}
      </div>
    </section>
  );
}

export function GoalRunRow({ botId, threadId, message }: { botId: string; threadId?: string; message: Message }) {
  const { dispatch } = useStore();
  return (
    <div className="flex justify-start">
      <GoalRunCard message={message} solo onStop={() => dispatch({ type: "interrupt", botId, threadId })} />
    </div>
  );
}
