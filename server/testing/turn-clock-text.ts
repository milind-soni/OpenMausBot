// Exact-text assertions compare a turn without its per-turn clock line, whose minute depends on when the test runs.
import { TURN_CLOCK_LEAD } from "../turn-clock.ts";

const CLOCK_LINE = new RegExp(`${TURN_CLOCK_LEAD}[^\\n]*\\n\\n`, "g");

export function withoutTurnClock(text: string): string {
  return text.replace(CLOCK_LINE, "");
}
