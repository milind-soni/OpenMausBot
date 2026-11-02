import { useEffect } from "react";

import type { RoutineRun } from "@/lib/routines";
import { api, useStore } from "./store";

/** Loads the runs scheduled from `start` up to where the app's window begins, once a view shows dates before it. */
export function useRoutineRunsFrom(start: number): void {
  const { state, dispatch } = useStore();
  const since = state.routineRunsSince;
  useEffect(() => {
    if (since === null || start >= since) return;
    let live = true;
    api(`/api/routines?from=${start}&to=${since}`)
      .then(({ runs }) => { if (live && Array.isArray(runs)) dispatch({ type: "routineRunsLoaded", runs, from: start, to: since }); })
      .catch(() => {});
    return () => { live = false; };
  }, [start, since, dispatch]);
}

/** The run that worked in this conversation; one older than the app's window is loaded when the thread is a run's. */
export function useThreadRoutineRun(botId: string, threadId: string): RoutineRun | undefined {
  const { state, dispatch } = useStore();
  const run = state.routineRuns.find((candidate) => candidate.target === "bot" && candidate.botId === botId && candidate.threadId === threadId);
  const marked = state.bots.find((bot) => bot.id === botId)?.tasks?.some((task) => task.threadId === threadId && task.routineRunId);
  const missing = !run && Boolean(marked) && state.routineRunsSince !== null;
  useEffect(() => {
    if (!missing) return;
    let live = true;
    api(`/api/routines?thread=${encodeURIComponent(threadId)}`)
      .then(({ runs }) => { if (live && Array.isArray(runs) && runs.length) dispatch({ type: "routineRunsLoaded", runs }); })
      .catch(() => {});
    return () => { live = false; };
  }, [missing, threadId, dispatch]);
  return run;
}
