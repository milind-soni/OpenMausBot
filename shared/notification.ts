/** The notification wire shape — what the harness decides is worth
 * interrupting someone for, emitted as the `notify` live frame. Single home
 * in shared/ so the server emitter and the client banner stack agree;
 * server/notify.ts re-exports under the historical name. */
export type NotifyKind =
  | "approval"
  | "question"
  | "done"
  | "routine-failed"
  | "routine-deferred"
  /** A routine finished its turn, but its reply says the task was not done
   * (a sign-in failed, access was missing). The run is not a failure. */
  | "routine-blocked"
  | "turn-failed"
  /** A run failed, stalled or could not start and no Chief of Staff was
   * there to take it: the person is the one who has to look. */
  | "incident"
  | "takeover"
  /** A delegated room request settled and the coordinator auto-resumed with
   * the results. The delegated turn and the resume are both internal, so
   * without this frame the parent conversation can sit in silence for the
   * minutes a huge context takes to reach its first token. */
  | "delegation-settled"
  /** The repeat detector fired and the decision model is confident the bot
   * is going in circles. It only reports: the turn keeps running until the
   * person stops it or gives it a hint. */
  | "stuck"
  /** The workspace crossed its monthly spend warning or reached its cap.
   * Sent to admins only, at most once per month for each. */
  | "spend";

export interface Notification {
  kind: NotifyKind;
  botId: string;
  botName: string;
  threadId: string;
  title: string;
  body: string;
  /** The bot's stored profile image, when it has one; clients show it as
   * the OS notification's icon so every banner carries its bot's face. */
  avatarUrl?: string;
  /** The room this came out of, when the bot was speaking in one. Routing
   * already works off `threadId` alone; this is what lets a client say which
   * room, and stack a room's banners together instead of under the bot. */
  groupId?: string;
  /** Arrive without a sound. Set only on a notification that reports
   * finished work, when the decision model judged it can wait; clients that
   * do not know the field play their usual sound. Never set on anything
   * that needs the person. */
  quiet?: boolean;
}

