// Shared types for the event-fold family modules (server/event-fold/).
// GroupGoalCoordinatorTurn moved here from event-fold.ts when the subscriber
// bodies were split into families; event-fold.ts re-exports it so index.ts's
// import path is unchanged.

/** The central runtime fold uses this to hide a coordinator's private
 * decision envelope from both streaming UI and the durable transcript. */
export type GroupGoalCoordinatorTurn = {
  token: symbol;
  turnId?: string;
  assistantItems: string[];
  /** A timed-out provider may still emit after the goal operation returns.
   * Keep swallowing that abandoned turn until its real completion arrives. */
  discard: boolean;
  cleanupTimer?: ReturnType<typeof setTimeout>;
};
