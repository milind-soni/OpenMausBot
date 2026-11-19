import { useEffect, useState, type CSSProperties } from "react";
import { AlarmClock, ArrowLeft, Pencil, Play, Plus, Trash2 } from "lucide-react";
import { api, useStore } from "@/state/store";
import { cn } from "@/lib/cn";
import { ProjectMentionText } from "./ProjectMentionText";
import { Switch } from "./Switch";
import { UsageRings } from "./UsageRings";
import type { Schedule, ScheduleRepeat } from "../../server/schedule-types";

const panel = "rounded-2xl border border-hairline/50 bg-card p-4";
const primary = "inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
const iconButton = "inline-flex size-9 items-center justify-center rounded-lg text-ink-secondary hover:bg-raised hover:text-ink focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-35";

function cadence(repeat: ScheduleRepeat) {
  switch (repeat.kind) {
    case "once": return "One time";
    case "every": return repeat.hours === 1 ? "Every hour" : `Every ${repeat.hours} hours`;
    case "weekdays": return `Monday to Friday at ${repeat.time}`;
    case "weekly": return `${repeat.days.map((day) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][day]).join(", ")} at ${repeat.time}`;
    case "daily": return `Every day at ${repeat.time}`;
  }
}

function dateTime(at: string, timeZone: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short", timeZone }).format(new Date(at));
}

const outcomes = { queued: "Queued", missed: "Missed", failed: "Failed", sent: "Sent" };

export function SchedulesScreen() {
  const { state, dispatch } = useStore();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [keepRunning, setKeepRunning] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const paused = state.schedules.paused;
  const desktopBackground = window.gbs?.background;

  useEffect(() => { void desktopBackground?.get().then(setKeepRunning).catch(() => {}); }, [desktopBackground]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || state.scheduleSheet) return;
      if (deleting) setDeleting(null);
      else dispatch({ type: "toggleSchedules", open: false });
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [deleting, dispatch, state.scheduleSheet]);

  async function act(path: string, method: string, body?: unknown) {
    setPending(true);
    setError("");
    try {
      await api(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
      return true;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not update this schedule.");
      return false;
    } finally {
      setPending(false);
    }
  }

  const buckets = new Map<string, Schedule[]>();
  for (const schedule of state.schedules.schedules) {
    const id = schedule.target.botId ?? schedule.target.groupId!;
    const group = buckets.get(id);
    if (group) group.push(schedule);
    else buckets.set(id, [schedule]);
  }
  const targetName = (id: string, type: "Buddy" | "Room") =>
    (type === "Buddy" ? state.bots : state.groups).find((item) => item.id === id)?.name;
  const openSchedule = () => dispatch({ type: "openSchedule" });

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-app">
      <header className="flex min-h-[60px] flex-wrap items-center justify-between gap-3 border-b border-hairline/40 px-4 py-3 sm:px-6" style={{ WebkitAppRegion: "drag", paddingRight: window.gbs?.platform === "win32" ? 148 : undefined } as CSSProperties}>
        <div className="flex items-center gap-2.5">
          <button type="button" aria-label="Back to conversation" className={iconButton} style={{ WebkitAppRegion: "no-drag" } as CSSProperties} onClick={() => dispatch({ type: "toggleSchedules", open: false })}><ArrowLeft size={18} /></button>
          <AlarmClock size={19} className="shrink-0 text-accent" />
          <h1 className="text-base font-semibold text-ink">Schedules</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2" style={{ WebkitAppRegion: "no-drag" } as CSSProperties}>
          <UsageRings />
          <label className="flex items-center gap-2 rounded-lg border border-hairline/50 px-3 py-2 text-xs text-ink">
            Pause all <Switch size="sm" label="Pause all schedules" checked={paused} disabled={pending} onChange={(value) => void act("/api/schedules/pause", "POST", { paused: value })} />
          </label>
          <button type="button" onClick={openSchedule} className={primary}><Plus size={15} /> New schedule</button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:p-6">
        <div className="mx-auto max-w-4xl space-y-5">
          {paused && <div role="status" className="flex flex-wrap items-center gap-3 rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm text-warning">
            <p>All schedules are paused.</p>
            <button type="button" disabled={pending} onClick={() => void act("/api/schedules/pause", "POST", { paused: false })} className="font-medium underline">Resume schedules</button>
          </div>}
          <section className={panel}>
            <h2 className="text-sm font-semibold text-ink">When schedules run</h2>
            <p className="mt-1 text-xs leading-relaxed text-ink-secondary">Keep Studio running for scheduled work. After a shutdown or sleep, Studio starts a missed run once if it is still within its catch-up window. Busy Buddies finish their current work before a scheduled prompt starts.</p>
            {desktopBackground && <label className="mt-3 flex items-center justify-between gap-3 border-t border-hairline/40 pt-3 text-sm text-ink">
              Keep Studio running when the window closes
              <Switch size="sm" label="Keep running when the window is closed" checked={keepRunning} onChange={(enabled) => void desktopBackground.set(enabled).then(setKeepRunning).catch(() => setError("Could not save the keep-running setting."))} />
            </label>}
          </section>

          {error && <p role="alert" className="rounded-lg border border-danger/40 p-3 text-sm text-danger">{error}</p>}
          {buckets.size === 0 && <div className={cn(panel, "mx-auto max-w-lg px-5 py-8 text-center")}>
            <AlarmClock className="mx-auto mb-3 text-accent" size={30} />
            <h2 className="font-semibold text-ink">No schedules yet</h2>
            <p className="mt-2 text-sm text-ink-secondary">Schedule a morning summary, a project check-in, or a message for later.</p>
            <button type="button" onClick={openSchedule} className={cn(primary, "mt-4")}><Plus size={15} /> New schedule</button>
          </div>}

          {[...buckets.entries()].map(([id, schedules]) => {
            const type = schedules[0].target.botId ? "Buddy" : "Room";
            const name = targetName(id, type);
            return <section key={id} className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <h2 className="min-w-0 truncate text-sm font-semibold text-ink">{name ?? `Removed ${type.toLowerCase()}`} <span className="font-normal text-ink-secondary">· {type}</span></h2>
                {name && <button type="button" className="shrink-0 rounded px-2 py-1 text-xs text-accent hover:underline" onClick={() => dispatch({ type: "select", id })}>Open chat</button>}
              </div>
              {schedules.map((schedule) => {
                const path = `/api/schedules/${schedule.id}`;
                const next = !schedule.enabled ? "Off" : paused ? "Paused" : schedule.nextRunAt ? dateTime(schedule.nextRunAt, schedule.timezone) : "No upcoming run";
                return <article key={schedule.id} className={panel}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <p className="min-w-0 flex-1 break-words text-sm text-ink"><ProjectMentionText text={schedule.prompt} /></p>
                    <div className="flex shrink-0 items-center gap-1">
                      <button type="button" disabled={pending} title="Run now" aria-label="Run schedule now" className={iconButton} onClick={() => void act(`${path}/run-now`, "POST")}><Play size={15} /></button>
                      <button type="button" disabled={schedule.origin === "auto-resume" || pending} title="Edit" aria-label="Edit schedule" className={iconButton} onClick={() => dispatch({ type: "openSchedule", schedule })}><Pencil size={15} /></button>
                      <button type="button" disabled={pending} title="Delete" aria-label="Delete schedule" className={cn(iconButton, "hover:text-danger")} onClick={() => setDeleting(schedule.id)}><Trash2 size={15} /></button>
                      {schedule.origin !== "auto-resume" && <Switch size="sm" label={`Schedule for ${name ?? type}`} disabled={pending} checked={schedule.enabled} onChange={(enabled) => void act(path, "PATCH", { enabled })} />}
                    </div>
                  </div>
                  <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-3">
                    <div><dt className="text-ink-secondary">Cadence</dt><dd className="mt-1 text-ink">{cadence(schedule.repeat)}</dd></div>
                    <div><dt className="text-ink-secondary">Time zone</dt><dd className="mt-1 break-words text-ink">{schedule.timezone}</dd></div>
                    <div><dt className="text-ink-secondary">Next run</dt><dd className="mt-1 text-ink">{next}</dd></div>
                  </dl>
                  {schedule.origin === "auto-resume" && <p className="mt-2 text-xs text-ink-secondary">Automatic retry</p>}
                  {schedule.origin === "bot" && <p className="mt-2 text-xs text-ink-secondary">Created by {state.bots.find((buddy) => buddy.id === schedule.createdBy)?.name ?? "a Buddy"}</p>}
                  {schedule.lastRun && <p className={cn("mt-2 text-xs", schedule.lastRun.outcome === "failed" ? "text-danger" : schedule.lastRun.outcome === "missed" ? "text-warning" : "text-ink-secondary")}>
                    Last run · {dateTime(schedule.lastRun.at, schedule.timezone)} · {outcomes[schedule.lastRun.outcome]}{schedule.lastRun.note ? ` · ${schedule.lastRun.note}` : ""}
                  </p>}
                  {deleting === schedule.id && <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-hairline/40 pt-3 text-sm text-ink">
                    <p className="mr-auto">Delete this schedule?</p>
                    <button type="button" className="rounded-lg bg-raised px-3 py-2" onClick={() => setDeleting(null)}>Keep schedule</button>
                    <button type="button" disabled={pending} className="rounded-lg bg-danger/15 px-3 py-2 font-semibold text-danger disabled:opacity-40" onClick={async () => { if (await act(path, "DELETE")) setDeleting(null); }}>Delete schedule</button>
                  </div>}
                </article>;
              })}
            </section>;
          })}
        </div>
      </div>
    </main>
  );
}
