import type { Routine, RoutineRun } from "./routines";
import { activeLocale, t } from "./i18n";

export function routineRunTime(run: RoutineRun): number {
  return run.createdAt || run.startedAt || run.scheduledFor;
}

export function latestRoutineRun(routineId: string, runs: readonly RoutineRun[]): RoutineRun | undefined {
  return runs.filter((run) => run.routineId === routineId)
    .reduce<RoutineRun | undefined>((latest, run) => !latest || routineRunTime(run) > routineRunTime(latest) ? run : latest, undefined);
}

export function routineRunLabel(run: RoutineRun): string {
  if (run.goalStatus) return t(`routines.goal.${run.goalStatus}`);
  return t(`routines.status.${run.status}`);
}

export function routineRunTone(run: RoutineRun): string {
  if (run.status === "waiting" || ["needs-input", "limit-reached", "paused"].includes(run.goalStatus ?? "")) return "text-warning";
  if (["failed", "missed"].includes(run.status) || ["failed", "blocked"].includes(run.goalStatus ?? "")) return "text-danger";
  if (run.status === "running") return "text-accent";
  if (run.status === "completed" && (!run.goalStatus || run.goalStatus === "completed")) return "text-success";
  return "text-ink-secondary";
}

export function routineDateTime(at: number): string {
  return new Date(at).toLocaleString(activeLocale(), { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function routineScheduleState(routine: Routine): string {
  // A consumed one-shot has no next date. It is not a paused recurring schedule.
  if (routine.schedule.type === "once" && routine.nextRunAt == null && routine.schedule.at <= Date.now()) return t("routines.finishedSchedule");
  return routine.enabled ? t("routines.activeSchedule") : t("routines.pausedSchedule");
}

export function routineNextLabel(routine: Routine): string {
  if (!routine.enabled) return routineScheduleState(routine);
  return routine.nextRunAt == null ? t("routines.noNextRun") : t("routines.nextRun", { time: routineDateTime(routine.nextRunAt) });
}
