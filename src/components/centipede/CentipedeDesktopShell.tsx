import { useMemo, type ReactNode } from "react";
import { Activity, CalendarClock, Check, CircleAlert, Eye, LayoutGrid, Monitor, Settings2, X } from "lucide-react";
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

type ActivitySparklineProps = {
  values: number[];
  waiting: boolean;
};

function ActivitySparkline({ values, waiting }: ActivitySparklineProps) {
  const points = values.length > 1 ? values : [0, 1];
  const max = Math.max(...points, 1);
  const min = Math.min(...points, 0);
  const span = Math.max(max - min, 1);
  const path = points
    .map((point, index) => {
      const x = points.length === 1 ? 50 : (index / (points.length - 1)) * 100;
      const y = 18 - ((point - min) / span) * 16;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <svg className={cn("centipede-stat-sparkline", waiting && "is-waiting")} viewBox="0 0 100 20" role="img" aria-label="Recent activity trend">
      <path d={`M ${path}`} />
    </svg>
  );
}

type MissionStageStatus = "done" | "active" | "waiting" | "idle";

type MissionStage = {
  label: string;
  detail: string;
  status: MissionStageStatus;
};

function stageClass(status: MissionStageStatus): string {
  switch (status) {
    case "done":
      return "is-done";
    case "active":
      return "is-active";
    case "waiting":
      return "is-waiting";
    case "idle":
      return "";
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

function NowRail({ bot }: { bot: Bot }) {
  const activityMessages = bot.messages.filter((message) => message.kind === "activity").slice(-8);
  const screenSignals = bot.messages.filter((message) => message.kind === "screen").slice(-6);
  const waiting = bot.activity === "waiting-on-you";
  const healthSegmentCount = bot.activity === "dead" || bot.activity === "no-signal" ? 1 : bot.activity === "waiting-on-you" ? 3 : bot.activity === "working" ? 4 : 5;
  const activityValues = activityMessages.map((message) => (message.tool?.ok === false ? 0 : 1));
  const successfulActivities = activityMessages.filter((message) => message.tool?.ok !== false).length;
  const missionStages: MissionStage[] = [
    { label: "Understand", detail: "Request and context", status: activityMessages.length > 0 ? "done" : "active" },
    { label: "Execute", detail: `${activityMessages.length} observed action${activityMessages.length === 1 ? "" : "s"}`, status: bot.activity === "working" ? "active" : activityMessages.length > 0 ? "done" : "idle" },
    { label: "Verify", detail: `${screenSignals.length} evidence signal${screenSignals.length === 1 ? "" : "s"}`, status: screenSignals.length > 0 ? "done" : bot.activity === "working" ? "active" : "idle" },
    { label: "Handoff", detail: waiting ? "Your decision is needed" : "No external action yet", status: waiting ? "waiting" : bot.activity === "idle" ? "active" : "idle" },
  ];

  return (
    <aside className="centipede-now-rail" aria-label="Current work context">
      <header className="centipede-now-head">
        <div>
          <p className="centipede-eyebrow">CURRENT WORK</p>
          <h2>{bot.name}</h2>
        </div>
        <span className={cn("centipede-live-dot", bot.activity === "working" && "is-live", waiting && "is-muted")} aria-label={bot.activity ?? "unknown"} />
      </header>

      <div className="centipede-now-stats">
        <div>
          <strong>{successfulActivities}</strong>
          <span>verified actions</span>
          <ActivitySparkline values={activityValues} waiting={waiting} />
        </div>
        <div>
          <strong>{screenSignals.length}</strong>
          <span>screen signals</span>
          <div className="centipede-item-pulse" aria-hidden="true" />
        </div>
      </div>

      <section className="centipede-now-section centipede-mission-surface">
        <div className="centipede-mission-heading">
          <div>
            <p className="centipede-eyebrow">MISSION STATE</p>
            <h3>{bot.busy ? "Work is in motion" : waiting ? "Waiting for you" : "Ready when you are"}</h3>
          </div>
          <span className="centipede-mission-count">{activityMessages.length + screenSignals.length} signals</span>
        </div>
        <ul className="centipede-mission-stages">
          {missionStages.map((stage, index) => (
            <li className={stageClass(stage.status)} key={stage.label}>
              <span className="centipede-stage-marker">{stage.status === "done" ? <Check size={11} /> : stage.status === "waiting" ? <CircleAlert size={11} /> : index + 1}</span>
              <span className="centipede-stage-copy"><strong>{stage.label}</strong><small>{stage.detail}</small></span>
              <span className="centipede-stage-status">{stage.status === "done" ? "done" : stage.status === "waiting" ? "your call" : stage.status}</span>
            </li>
          ))}
        </ul>
        {waiting && <div className="centipede-approval-link" role="status"><CircleAlert size={13} /> Approval boundary reached <Eye size={13} /></div>}
        <p className="centipede-mission-note">Consequential external actions stay paused until you approve them.</p>
      </section>

      <section className="centipede-now-section">
        <div className="centipede-section-heading"><h3>Evidence signals</h3><Activity size={15} /></div>
        {activityMessages.length === 0 && screenSignals.length === 0 ? (
          <div className="centipede-empty-state"><Check size={14} /> No signals captured yet.</div>
        ) : (
          <div className="centipede-now-list">
            {activityMessages.slice(-3).map((message) => (
              <div className={cn("centipede-now-item", message.tool?.ok === false && "is-attention")} key={message.id}>
                <span className="centipede-item-icon">{message.tool?.ok === false ? <X size={13} /> : <Check size={13} />}</span>
                <span className="centipede-item-copy"><strong>{message.tool?.name ?? "Agent action"}</strong><small>{message.tool?.ok === false ? "Needs review" : "Completed and recorded"}</small></span>
                <span className="centipede-status-word">{message.tool?.ok === false ? "check" : "ready"}</span>
              </div>
            ))}
            {screenSignals.length > 0 && <div className="centipede-now-item"><span className="centipede-item-icon"><Eye size={13} /></span><span className="centipede-item-copy"><strong>Computer evidence</strong><small>{screenSignals.length} recent frame{screenSignals.length === 1 ? "" : "s"} retained</small></span><span className="centipede-status-word">seen</span></div>}
          </div>
        )}
      </section>

      <section className="centipede-health-card">
        <div className="centipede-health-title"><span className={cn("centipede-health-icon", healthSegmentCount < 3 ? "is-warn" : "is-good")}>{healthSegmentCount < 3 ? <CircleAlert size={14} /> : <Check size={14} />}</span><strong>{healthSegmentCount < 3 ? "Signal degraded" : "Execution healthy"}</strong></div>
        <p className={healthSegmentCount < 3 ? "centipede-health-error" : undefined}>{bot.activity === "no-signal" ? "No live signal from this agent." : bot.activity === "dead" ? "The agent stopped before completion." : waiting ? "The next step is held at an approval boundary." : "The latest work state is available locally."}</p>
        <div className="centipede-health-meter" aria-label={`${healthSegmentCount} of 5 health segments ready`}>
          {Array.from({ length: 5 }, (_, index) => <span className={cn(index < healthSegmentCount && "is-ready")} key={index} />)}
        </div>
      </section>
    </aside>
  );
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
  const bot = selectedBot(state.bots, state.selectedId);
  const activityMessages = bot?.messages.filter((message) => message.kind === "activity").slice(-8) ?? [];
  const screenSignals = bot?.messages.filter((message) => message.kind === "screen").slice(-6) ?? [];
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
       {bot && (bot.busy || activityMessages.length > 0 || screenSignals.length > 0) && <NowRail bot={bot} />}
     </div>
  );
}
