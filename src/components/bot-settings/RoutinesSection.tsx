// Routines: this bot's scheduled tasks, one row per routine with its next
// and last run. The New-schedule/Manage card is moved from SettingsPanel.tsx
// (the "Scheduled tasks" card + the RoutineEditor mount); the row list is new.
import { CalendarClock, Plus } from "lucide-react";
import { useState } from "react";

import { useStore, type Bot } from "@/state/store";
import type { Routine, RoutineRun } from "@/lib/routines";
import { niceTime, scheduleSentence } from "@/lib/schedule-label";
import { cn } from "@/lib/cn";
import { RoutineEditor } from "../RoutinesPage";

function capitalize(text: string): string {
  return text.length ? text[0]!.toUpperCase() + text.slice(1) : text;
}

/** The newest run recorded for a routine, by finishedAt (settled) falling
 * back to startedAt (in flight) then scheduledFor (never started). */
function lastRunFor(routineId: string, runs: RoutineRun[]): RoutineRun | null {
  const at = (run: RoutineRun) => run.finishedAt ?? run.startedAt ?? run.scheduledFor;
  return runs
    .filter((run) => run.routineId === routineId)
    .reduce<RoutineRun | null>((latest, run) => (!latest || at(run) > at(latest) ? run : latest), null);
}

export function RoutinesSection({ bot, routines, runs }: { bot: Bot; routines: Routine[]; runs: RoutineRun[] }) {
  const { dispatch } = useStore();
  const [creatingRoutine, setCreatingRoutine] = useState(false);
  const activeCount = routines.filter((routine) => routine.enabled).length;

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-xl bg-card p-4">
        <div className="flex items-center gap-2">
          <CalendarClock size={16} className="text-accent" />
          <div className="min-w-0 flex-1 text-[15px] font-medium text-ink">Scheduled tasks</div>
          <span className="shrink-0 text-[11.5px] tabular-nums text-ink-secondary">
            {activeCount} active · {routines.length} total
          </span>
        </div>
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={() => setCreatingRoutine(true)}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-[13px] font-medium text-white hover:brightness-110"
          >
            <Plus size={14} />
            New schedule
          </button>
          <button
            type="button"
            onClick={() => dispatch({ type: "showRoutines" })}
            className="rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover"
          >
            Manage
          </button>
        </div>
      </div>

      {routines.length === 0 ? (
        <div className="rounded-xl bg-card p-4 text-[13px] text-ink-secondary">No schedules yet.</div>
      ) : (
        <div className="divide-y divide-hairline/40 overflow-hidden rounded-xl border border-hairline/40 bg-card">
          {routines.map((routine) => {
            const last = lastRunFor(routine.id, runs);
            return (
              <div key={routine.id} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13.5px] text-ink">
                    {capitalize(scheduleSentence(routine.schedule))} · {routine.name}
                  </div>
                  <div className="mt-0.5 text-[11.5px] text-ink-secondary">
                    {routine.nextRunAt != null && <span>Next {niceTime(routine.nextRunAt)}</span>}
                    {routine.nextRunAt != null && last && " · "}
                    {last && (
                      <span>
                        Last {last.status} {niceTime(last.finishedAt ?? last.startedAt ?? last.scheduledFor)}
                      </span>
                    )}
                  </div>
                </div>
                <span
                  className={cn(
                    "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium",
                    routine.enabled ? "bg-accent/15 text-accent-text" : "bg-control text-ink-secondary",
                  )}
                >
                  {routine.enabled ? "Active" : "Paused"}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {creatingRoutine && (
        <RoutineEditor
          key={bot.id}
          bots={[bot]}
          lockedBotId={bot.id}
          onClose={() => setCreatingRoutine(false)}
        />
      )}
    </div>
  );
}
