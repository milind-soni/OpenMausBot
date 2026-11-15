import type { RoutineRun } from "./routines.ts";

/** What the host knows of a run's conversation. */
export interface RunTurnFacts {
  /** A turn is working there, or one is being started. */
  busy: boolean;
  /** Its last turn is still being settled. */
  settling: boolean;
  /** A message waits there for its turn. */
  queued: boolean;
  /** Work it handed on, or a turn the runtime will resume, is still open. */
  pending: boolean;
  /** Its turn gave up waiting for a computer another conversation holds, and resumes by itself when that is free. */
  parked: boolean;
}

/** Whether a bot's run still has a turn of its own, working or able to carry on by itself: while it has, the run is
 * never started again beside it. Null for a run the host cannot tell this for (a room goal's, one with no conversation). */
export function runTurnLive(run: Pick<RoutineRun, "target" | "threadId">, facts: (threadId: string) => RunTurnFacts): boolean | null {
  if (run.target !== "bot" || !run.threadId) return null;
  const { busy, settling, queued, pending, parked } = facts(run.threadId);
  return busy || settling || queued || pending || parked;
}
