/** Pausing or deleting a routine ends its runs that have not started, and those waiting for the person, whose turns end too. */
import type { RoutineManagerOptions, RoutineRun } from "./routines.ts";

/** Cancels this routine's queued and waiting runs; returns them all, and the waiting ones apart. */
export function cancelUnfinishedRuns(runs: readonly RoutineRun[], routineId: string, now: number, change: "paused" | "deleted") {
  const cancelled: RoutineRun[] = [];
  const waited: RoutineRun[] = [];
  for (const run of runs) {
    if (run.routineId !== routineId || (run.status !== "queued" && run.status !== "waiting")) continue;
    if (run.status === "waiting") {
      run.error = `The routine was ${change} while this run waited for you`;
      if (run.target === "room-goal") run.goalStatus = "stopped";
      waited.push(run);
    } else if (change === "paused") run.error = "The routine was paused before this run started";
    run.status = "cancelled";
    run.attention = undefined;
    run.finishedAt = now;
    cancelled.push(run);
  }
  return { cancelled, waited };
}

/** Ends the turns of runs that stopped while their bot or room worked or waited, so their open cards stop and nothing shows them waiting. */
export function interruptRunTurns(runs: readonly RoutineRun[], options: Pick<RoutineManagerOptions, "interruptTurn" | "interruptGoal">) {
  for (const run of runs) {
    if (run.threadId && run.target === "room-goal") void options.interruptGoal?.(run.groupId, run.threadId).catch(() => {});
    else if (run.threadId) void options.interruptTurn?.(run.botId, run.threadId).catch(() => {});
  }
}
