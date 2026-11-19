/** How an open conversation on the Team Map is doing right now. */
export type TeamMapSessionState =
  /** A turn is running and produced output recently. */
  | "running"
  /** A turn is running but has produced no output for longer than the stuck threshold. */
  | "stuck"
  /** Handed to the bot and waiting for its turn to start. */
  | "queued"
  /** The bot asked the person something and is waiting for their answer or approval. */
  | "waiting";

/** One open conversation of one bot, as drawn under that bot on the Team Map. */
export interface TeamMapSession {
  botId: string;
  threadId: string;
  /** Present when the conversation lives in a room. */
  groupId?: string;
  title: string;
  /** The model the bot is running this conversation on, as shown in the model picker. */
  model?: string;
  /** Reasoning effort when the engine reports one, such as "low", "medium", "high". */
  effort?: string;
  state: TeamMapSessionState;
  /** Epoch ms when the current turn started, or when it was queued. */
  startedAt: number;
  /** Epoch ms of the last output from the current turn. */
  lastOutputAt?: number;
  /** Spend on this conversation so far, in US dollars, from the usage ledger. */
  usd?: number;
  /** True when `usd` is a list-price estimate for a subscription plan, not money billed. */
  usdEstimated?: boolean;
}

/** Live session data added to `GET /api/team-map`. */
export interface TeamMapSessionsSnapshot {
  sessions: TeamMapSession[];
  /** Turns (not helper or other non-turn ledger rows) that finished in the last 24 hours, on threads this viewer can see. */
  doneLast24h: number;
  /** A running turn with no output for this many ms counts as stuck. */
  stuckAfterMs: number;
}
