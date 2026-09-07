// The shape of one line in a bot's activity log, shared by the harness
// reader (server/activity.ts) and the panel that renders it.

export type ActivityOutcome =
  /** the tool finished and reported success */
  | "ran"
  /** the tool finished and reported failure */
  | "failed"
  /** started, no completion seen yet */
  | "running"
  /** approved, but no matching tool run was found in the thread's events */
  | "allowed"
  /** a person or reviewer said no; nothing ran */
  | "denied"
  /** a card is open and nobody has answered it */
  | "waiting";

export interface ActivityRow {
  /** when it started (a tool) or was asked (a request) */
  at: string;
  threadId: string;
  turnId?: string;
  requestId?: string;
  /** the raw tool name, for anyone who wants it */
  tool: string;
  /** the connected app or surface it touched, when there is one */
  app: string | null;
  /** the action, in words */
  label: string;
  /** the arguments the decision log recorded, already redacted */
  summary?: string;
  outcome: ActivityOutcome;
}
