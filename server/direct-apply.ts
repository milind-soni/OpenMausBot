// Which of a bot's proposed changes apply without a person. One rule for
// routines, skills, profile and default model, on the desktop, a server and
// a Cloud home alike:
// - Full access applies everything it always has, with no new limits;
// - at any other level a bot's change to ITSELF applies directly (its own
//   routines, skills, profile, model), and the person sees a one-line
//   receipt with Undo. A change for another bot keeps its card.
// The one exception is a Cloud home's guest-driven turn, which keeps today's
// card for everything (`blocked`). Team setup and peer approvals are not
// changes to the bot itself and stay Full access only.

/** Why a change applied without a person. Also the decision log's source. */
export type DirectApply = "full-access" | "self";

/** Server-owned and decided per request, never from request input. */
export type DirectApplyCheck = (botId: string, threadId: string, targetBotId: string) => DirectApply | null;

/** What Undo says, applying nothing, once the thing changed since. */
export const UNDO_STALE = "Changed since, so it can't be undone here.";

/** A bot applying its own routines directly keeps at most this many
 * enabled; past it, a create or resume shows today's card instead. */
export const SELF_ROUTINE_CAP = 20;

export function directApply(args: {
  fullAccess: boolean;
  botId: string;
  targetBotId: string;
  blocked: boolean;
}): DirectApply | null {
  if (args.fullAccess) return "full-access";
  return args.targetBotId === args.botId && !args.blocked ? "self" : null;
}
