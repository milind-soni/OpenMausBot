/** Turns each bot took in one room round, keyed by that round's `spoken` set, so a repeat @mention is answered once per reply. */
const roundTurns = new WeakMap<Set<string>, Map<string, number>>();
/** The last pass of a room message whose members take more than one turn, with how many turns each takes. */
const finalPasses = new WeakMap<Set<string>, number>();

export const MAX_TURNS_PER_MEMBER = 5;

export function noteGroupTurn(spoken: Set<string>, botId: string): void {
  spoken.add(botId);
  const turns = roundTurns.get(spoken) ?? new Map<string, number>();
  turns.set(botId, (turns.get(botId) ?? 0) + 1);
  roundTurns.set(spoken, turns);
}

/** Snapshot now; the returned function counts the turns a bot has taken in this round since. */
export function turnsSince(spoken: Set<string>): (botId: string) => number {
  const before = new Map(roundTurns.get(spoken));
  return (botId) => (roundTurns.get(spoken)?.get(botId) ?? 0) - (before.get(botId) ?? 0);
}

export function roomTurnsPerMember(room: { turnsPerMember?: number } | undefined): number {
  const turns = room?.turnsPerMember;
  return Number.isInteger(turns) && turns! >= 1 && turns! <= MAX_TURNS_PER_MEMBER ? turns! : 1;
}

/** The room PATCH's `turnsPerMember` field, checked; empty when the body does not set it. */
export function turnsPerMemberPatch(body: Record<string, unknown>, room: { dm?: boolean }): { turnsPerMember?: number } {
  if (!Object.prototype.hasOwnProperty.call(body, "turnsPerMember")) return {};
  if (room.dm) throw Object.assign(new Error("direct-message channels cannot change turns per member"), { status: 400 });
  const turns = body.turnsPerMember;
  if (typeof turns !== "number" || !Number.isInteger(turns) || turns < 1 || turns > MAX_TURNS_PER_MEMBER) {
    throw Object.assign(new Error(`turnsPerMember must be a whole number from 1 to ${MAX_TURNS_PER_MEMBER}`), { status: 400 });
  }
  return { turnsPerMember: turns };
}

/**
 * Walks a room message's responders once per turn each member takes. Every pass after the first starts a fresh
 * `spoken` set and hands it to `onPass` before its first responder; the last pass of several is marked final.
 */
export function* roomRoundPasses<T>(round: readonly T[], turns: number, onPass: (spoken: Set<string>) => void): Generator<T> {
  for (let pass = 1; pass <= turns; pass++) {
    if (pass > 1) {
      const spoken = new Set<string>();
      if (pass === turns) finalPasses.set(spoken, turns);
      onPass(spoken);
    }
    yield* round;
  }
}

/** The line a member reads on its last turn of a multi-turn room message; empty on every other turn. */
export function finalTurnBlock(spoken: Set<string>): string {
  const turns = finalPasses.get(spoken);
  if (!turns) return "";
  return `\n\nThis is your final turn in this exchange (turn ${turns} of ${turns}). Wrap up now: if the room's instructions or the request say what to do at the end, do it; otherwise conclude with a short summary of where things stand.`;
}
