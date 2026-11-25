/** What a check-back (a bot's `check_back`) is doing: waiting for its time, started its turn, or ended without one. */
export type CheckBackStatus = "pending" | "started" | "cancelled" | "dropped" | "failed";

/** The quiet line a check-back keeps in its conversation (`WireMessage.checkBack`), patched in place as it moves on. */
export interface CheckBackLine {
  id: string;
  /** When the bot comes back, epoch ms. */
  dueAt: number;
  status: CheckBackStatus;
  /** What the bot will check, in its words. */
  note: string;
  /** When its turn started, epoch ms; later than `dueAt` when the computer was asleep or the app closed. */
  startedAt?: number;
  /** Why it ended without a turn, one line. */
  why?: string;
}

/** `WireMessage.checkBack`: set on the line a check-back keeps in its conversation. */
export interface CheckBackLineField {
  checkBack?: CheckBackLine;
}

/** Pending check-backs a conversation and a bot may hold, and how near and far one may be set. */
export const CHECK_BACK_LIMITS = {
  perConversation: 10,
  perBot: 50,
  minMs: 60_000,
  maxMs: 90 * 24 * 60 * 60_000,
} as const;
