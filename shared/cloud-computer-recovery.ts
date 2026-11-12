/** What MausBot is doing about a cloud computer that stopped answering, as `GET /api/bots/:id/computer/recovery` reports it.
 * `not-responding`, `restarting` and `replacing` are under way; the others are how it ended. */
export const CLOUD_COMPUTER_RECOVERY_STATES = [
  "not-responding", "restarting", "replacing", "restarted", "replaced", "unreachable", "capped", "needs-person",
] as const;
export type CloudComputerRecoveryState = (typeof CLOUD_COMPUTER_RECOVERY_STATES)[number];

export interface CloudComputerRecovery {
  state: CloudComputerRecoveryState;
  at: number;
  /** The person asked for it from the computer panel. */
  manual?: true;
}

export const recoveryUnderWay = (state: CloudComputerRecoveryState): boolean =>
  state === "not-responding" || state === "restarting" || state === "replacing";

/** What the bot is told, in place of a computer call, while its computer is being restarted or replaced. */
export const CLOUD_COMPUTER_NOT_RESPONDING =
  "This bot's cloud computer isn't responding; MausBot is replacing it. Try again in a minute. Do not retry now.";
/** Told once, on the bot's first computer call after the replacement. */
export const CLOUD_COMPUTER_REPLACED =
  "This bot's cloud computer stopped responding and was replaced with a new one. Files that were only on the old computer are gone.";
export const CLOUD_COMPUTER_REPLACED_BY_PERSON =
  "This bot's cloud computer was replaced with a new one. Files that were only on the old computer are gone.";
export const CLOUD_COMPUTER_RESTARTED =
  "This bot's cloud computer stopped responding and was restarted. Programs that were open on it were closed; its files are still there.";
export const CLOUD_COMPUTER_UNREACHABLE =
  "Cloud computers can't be reached right now. This call may not have run. Try again in a few minutes.";
export const CLOUD_COMPUTER_CAPPED =
  "This bot's cloud computer isn't responding, and it was already replaced once in the last hour, so MausBot stopped replacing it. Do not retry computer work in this turn; tell the person.";
/** Automatic replacement is off: the person decides, from the computer panel. */
export const CLOUD_COMPUTER_NEEDS_PERSON =
  "This bot's cloud computer isn't responding. The person can replace it from the computer panel. Do not retry computer work in this turn; tell the person.";
/** One command got no answer; the computer is not judged on one. */
export const CLOUD_COMPUTER_NO_ANSWER =
  "The cloud computer did not answer this call, so it may not have run. Take a fresh screenshot in a moment before repeating it.";

/** The person's one line in the chat and the Inbox, by its language pack key; each takes the bot's `{name}`. */
export const CLOUD_COMPUTER_PERSON_LINES = {
  replaced: "server.cloudComputer.replaced",
  restarted: "server.cloudComputer.restarted",
  capped: "server.cloudComputer.capped",
  unreachable: "server.cloudComputer.unreachable",
  needsPerson: "server.cloudComputer.needsPerson",
} as const;
export type CloudComputerPersonLine = keyof typeof CLOUD_COMPUTER_PERSON_LINES;
