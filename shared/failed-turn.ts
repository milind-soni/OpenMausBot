// A failed turn is stored as an activity row named "error: <what went
// wrong>", in a 1:1 chat and a room alike. The server writes every such row
// through failedTurnTool and the clients read it back through
// failedTurnCause, so the marker and the one length limit live here only.
// A place that could not be used also stores its state (place-view.ts), so
// the app words it again in the reader's language; the words stay English
// and whole for the phones, which read only them.
import type { PlaceRow } from "./place-view.ts";

const MARKER = "error:";

/** The longest cause a row keeps. Clients wrap the row and show it whole, so
 * this only bounds a pathological message (a provider's HTML body, a stack
 * trace); a sentence a person acts on fits, its next action included. */
export const FAILED_TURN_MAX_CHARS = 600;

export interface FailedTurnTool {
  name: string;
  ok: false;
  /** fixed by installing or signing in, not by retrying */
  setup?: boolean;
  terminal?: boolean;
  /** the installed Claude Code is too old for the model */
  claudeUpdate?: boolean;
  /** the place this turn could not use, and where that place came from */
  place?: PlaceRow;
}

/** The activity row a failed turn is stored as. */
export function failedTurnTool(
  cause: string,
  flags: { setup?: boolean; terminal?: boolean; claudeUpdate?: boolean; place?: PlaceRow } = {},
): FailedTurnTool {
  const words = cause.length > FAILED_TURN_MAX_CHARS ? `${cause.slice(0, FAILED_TURN_MAX_CHARS - 1)}…` : cause;
  return {
    name: `${MARKER} ${words}`,
    ok: false,
    ...(flags.setup ? { setup: true } : {}),
    ...(flags.terminal ? { terminal: true } : {}),
    ...(flags.claudeUpdate ? { claudeUpdate: true } : {}),
    ...(flags.place ? { place: flags.place } : {}),
  };
}

/** The cause a failed-turn row carries, without its marker; null for any
 * other activity row. */
export function failedTurnCause(name: string): string | null {
  return name.startsWith(MARKER) ? name.slice(MARKER.length).trim() : null;
}
