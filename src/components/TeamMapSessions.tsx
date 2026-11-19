import { openThread, useStore } from "@/state/store";
import { useShowThreads } from "@/lib/thread-preferences";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { formatUsd } from "@/lib/usage";
import { formatSessionElapsed, sortSessionsForDisplay, teamMapSessionStatus, type TeamMapSession } from "@/lib/team-map";
import { SESSION_MAX_VISIBLE } from "@/lib/team-canvas";

const DOT: Record<"success" | "warning" | "danger" | "idle", string> = {
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  idle: "bg-ink-secondary/35",
};

/** The open conversations under one bot node: a short stack of cards, capped with an overflow count. */
export function TeamMapSessions({ sessions, now }: { sessions: TeamMapSession[]; now: number }) {
  const { state, dispatch } = useStore();
  const showThreads = useShowThreads();
  if (sessions.length === 0) return null;
  const ordered = sortSessionsForDisplay(sessions);
  const visible = ordered.slice(0, SESSION_MAX_VISIBLE);
  const overflow = ordered.length - visible.length;
  return (
    <div className="mt-1.5 flex w-[236px] flex-col gap-1.5">
      {visible.map((session) => {
        const status = teamMapSessionStatus(session.state);
        const meta = [session.model, session.effort].filter(Boolean).join(" · ");
        const cost = typeof session.usd === "number"
          ? (session.usdEstimated ? t("usage.page.estimated", { cost: formatUsd(session.usd) }) : formatUsd(session.usd))
          : null;
        return (
          <button
            key={`${session.botId}:${session.threadId}`}
            onClick={() => {
              if (session.groupId) dispatch({ type: "select", id: session.groupId });
              else openThread(dispatch, { botId: session.botId, threadId: session.threadId }, state, showThreads);
            }}
            aria-label={t("canvas.session.openAria", { title: session.title })}
            className="flex w-full min-w-0 flex-col gap-0.5 rounded-lg border border-hairline/40 bg-card px-2.5 py-1.5 text-left transition animate-pop-in hover:bg-raised/50"
          >
            <span className="truncate text-[12px] font-medium text-ink">{session.title}</span>
            <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-ink-secondary">
              <span className={cn("size-1.5 shrink-0 rounded-full", DOT[status.tone], status.tone === "success" && "animate-status-pulse")} aria-hidden />
              <span className="shrink-0">{status.label}</span>
              {meta && <span className="truncate">· {meta}</span>}
              <span className="ml-auto shrink-0 tabular-nums">{formatSessionElapsed(session.startedAt, now)}</span>
              {cost && <span className="shrink-0 tabular-nums">· {cost}</span>}
            </span>
          </button>
        );
      })}
      {overflow > 0 && <p className="px-1 text-[11px] text-ink-secondary">{t("canvas.session.moreCount", { count: overflow })}</p>}
    </div>
  );
}
