/** Durable, non-actionable projection of one background routine run.
 *
 * The provider still runs in its isolated execution task. This small card is
 * upserted into the trusted conversation that created the routine so the user
 * can see progress, results, and where to review an approval without hunting
 * through the routines calendar.
 */
export interface RoutineRunCardData {
  runId: string;
  routineId: string;
  routineName: string;
  scheduledFor?: number;
  status: "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled" | "missed";
  /** Present while a queued run is being held because its target bot or room
   * is busy. The status stays queued; this is the surfaced deferral fact. */
  deferredAt?: number;
  /** Exact terminal team-goal outcome when this run targeted a room. */
  goalStatus?: "completed" | "needs-input" | "blocked" | "limit-reached" | "paused" | "stopped" | "failed";
  executionThreadId?: string;
  summary?: string;
  error?: string;
}

/** A bot line one automation run wrote into the chat it reports to: the run's
 * result, a copy of a card the run waits on (answering it there answers the
 * run), or why the run failed. The run works in its own hidden conversation,
 * `executionThreadId`, which keeps its full transcript. */
export interface AutomationLine {
  routineId: string;
  runId: string;
  name: string;
  /** What started the run; "app" is a connected-app event. */
  trigger: "schedule" | "manual" | "startup" | "webhook" | "app";
  executionThreadId: string;
  scheduledFor: number;
  /** The run needs the person: it asked them something or cannot go on without them. */
  needsYou?: true;
  failed?: true;
  /** A run that had nothing new, posted only because this automation's line before it in the chat said a run failed. */
  recovered?: true;
  /** The card in the run's conversation this line stands for: an option card
   * is copied whole, a sign-in, connection or credential card is named. */
  copyOf?: string;
}
