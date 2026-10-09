// Tests that check the exact text a turn delivered, or the fake CLI's echo
// of it, compare it without the per-turn clock line (server/turn-clock.ts),
// whose minute depends on when the test runs.
import { TURN_CLOCK_LEAD } from "../turn-clock.ts";

const CLOCK_LINE = new RegExp(`${TURN_CLOCK_LEAD}[^\\n]*\\n\\n`, "g");

export function withoutTurnClock(text: string): string {
  return text.replace(CLOCK_LINE, "");
}
