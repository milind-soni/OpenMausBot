/** Check before done, a bot's setting (`WireBot.checkWork`). Present: an answer that finishes the person's request in
 * the bot's own chat is checked against that request before it is final; absent or null: off. */
export interface CheckWork {
  /** The bot that checks. Absent: a thread of the bot's own on another provider's model, or on its own model when no
   * other is connected. */
  checker?: string;
}

/** Rounds of check and fix one answer gets at most. */
export const CHECK_WORK_ROUNDS = 3;
/** How long one answer's checks may take in all before it is delivered as not checked. */
export const CHECK_WORK_MAX_MS = 30 * 60_000;
