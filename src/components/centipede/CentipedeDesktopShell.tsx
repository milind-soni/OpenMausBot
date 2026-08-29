import { useMemo, type ReactNode } from "react";
import { CalendarClock, CircleAlert, LayoutGrid, Monitor, Settings2 } from "lucide-react";
import { useStore, type Bot } from "@/state/store";
import { cn } from "@/lib/cn";
import { TaskList } from "@/components/TaskPicker";
import "./centipede-desktop.css";

type CentipedeDesktopShellProps = {
  sidebar: ReactNode;
  children: ReactNode;
};

function selectedBot(bots: Bot[], selectedId: string): Bot | undefined {
  return bots.find((bot) => bot.id === selectedId && !bot.hidden) ?? bots.find((bot) => !bot.hidden);
}

function nextScheduleLabel(botId: string | undefined, routines: ReturnType<typeof useStore>["state"]["routines"]): string {
  const next = routines
    .filter((routine) => routine.enabled && (!botId || routine.botId === botId) && routine.nextRunAt !== null)
    .sort((left, right) => (left.nextRunAt ?? Number.MAX_SAFE_INTEGER) - (right.nextRunAt ?? Number.MAX_SAFE_INTEGER))[0];
  if (!next?.nextRunAt) return "No upcoming run";
  return `${next.name} · ${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(next.nextRunAt)}`;
}

function TaskHomeRail() {
  const { state, dispatch } = useStore();
  const bot = selectedBot(state.bots, state.selectedId);
  const needsYou = bot?.activity === "waiting-on-you";
  const schedule = useMemo(() => nextScheduleLabel(bot?.id, state.routines), [bot?.id, state.routines]);
  const failedRun = state.routineRuns.find((run) => ["failed", "blocked", "missed"].includes(run.status) && !run.seenAt);

  return (
    <aside className="centipede-task-home-rail" aria-label="Task home">
      <div className="centipede-rail-heading">
        <div>
          <p className="centipede-eyebrow">TASK HOME</p>
          <h2>{needsYou ? "Needs you" : "Your work"}</h2>
        </div>
        {needsYou && <span className="centipede-rail-alert" aria-label="Needs you"><CircleAlert size={15} /></span>}
      </div>

      {bot ? <TaskList bot={bot} rail /> : <p className="centipede-rail-empty">Choose an agent to see its tasks.</p>}

      <div className="centipede-rail-links">
        <button type="button" onClick={() => dispatch({ type: "showWork" })} className={cn(state.activeView === "work" && "is-active")}>
          <LayoutGrid size={15} /><span><strong>Work</strong><small>Canonical locks, decisions, and proof</small></span>
        </button>
        <button type="button" onClick={() => dispatch({ type: "showRoutines" })} className={cn(state.activeView === "routines" && "is-active")}>
          <CalendarClock size={15} /><span><strong>Recurring schedules</strong><small>{schedule}</small></span>
          {failedRun && <CircleAlert size={13} className="text-danger" aria-label="Schedule needs attention" />}
        </button>
      </div>

      {failedRun && <div className="centipede-rail-failure" role="status"><CircleAlert size={14} /><span>{failedRun.error ?? failedRun.blocker ?? "A scheduled run needs attention."}</span></div>}

      <div className="centipede-rail-actions">
        <button type="button" onClick={() => dispatch({ type: "toggleComputer" })} disabled={!bot}><Monitor size={15} /> {state.computerOpen ? "Hide computer" : "Use computer"}</button>
        <button type="button" onClick={() => dispatch({ type: "toggleAppSettings" })}><Settings2 size={15} /> Tune things</button>
      </div>
    </aside>
  );
}

export function CentipedeDesktopShell({ sidebar, children }: CentipedeDesktopShellProps) {
  const { state } = useStore();
  const isWindows = window.ogb?.platform === "win32";
  return (
    <div className={cn("centipede-desktop-shell", isWindows && "is-windows", state.settingsOpen && "is-detail-open")}>
      {isWindows && (
        <div className="centipede-window-titlebar" aria-hidden="true">
          <span className="centipede-window-titlebar-mark" />
          <span>AGENT CENTIPEDE</span>
          <span className="centipede-window-titlebar-rule">LOCAL WORKSPACE</span>
        </div>
      )}
      {sidebar}
      <div className="centipede-desktop-main">
        <div className="centipede-desktop-content">{children}</div>
      </div>
      <TaskHomeRail />
    </div>
  );
}
