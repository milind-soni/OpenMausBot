// A goal lead's own turns: their text is held back until the private envelope is stripped, in a room or a one-on-one chat.
import type { RuntimeEvent } from "../../shared/runtime-events.ts";

export type GoalLeadTurn = {
  token: symbol;
  turnId?: string;
  assistantItems: string[];
  /** A timed-out provider may still emit: keep swallowing until its real completion arrives. */
  discard: boolean;
  cleanupTimer?: ReturnType<typeof setTimeout>;
};

const GUARD_MS = 5 * 60_000;

export function createGoalTurns(deps: { retireProviderTurn(turnId: string): void }) {
  const turnsByThread = new Map<string, Set<GoalLeadTurn>>();

  function add(threadId: string, turn: GoalLeadTurn): void {
    const turns = turnsByThread.get(threadId) ?? new Set<GoalLeadTurn>();
    turns.add(turn);
    turnsByThread.set(threadId, turns);
  }

  function remove(threadId: string, turn: GoalLeadTurn): void {
    if (turn.cleanupTimer) clearTimeout(turn.cleanupTimer);
    const turns = turnsByThread.get(threadId);
    turns?.delete(turn);
    if (turns?.size === 0) turnsByThread.delete(threadId);
  }

  function hasUnboundDiscarded(threadId: string): boolean {
    return [...(turnsByThread.get(threadId) ?? [])]
      .some((turn) => turn.discard && !turn.turnId);
  }

  /** Per provider turn, never per room thread; most adapters emit turn.started before sendTurn resolves. */
  function forEvent(event: RuntimeEvent): GoalLeadTurn | undefined {
    const turns = turnsByThread.get(event.threadId);
    if (!turns?.size) return undefined;
    const candidates = [...turns];
    if (event.turnId) {
      const exact = candidates.find((turn) => turn.turnId === event.turnId);
      if (exact) return exact;
      // Until an interrupted handshake returns its own id, no new id can be attributed safely.
      const unboundDiscarded = candidates.filter((turn) => turn.discard && !turn.turnId);
      if (unboundDiscarded.length > 0) {
        // More than one unbound candidate is genuinely ambiguous and stays gated.
        if (candidates.length === 1) {
          unboundDiscarded[0]!.turnId = event.turnId;
          // Tombstone at once so no later event of this abandoned turn can settle a replacement.
          deps.retireProviderTurn(event.turnId);
          return unboundDiscarded[0];
        }
        return undefined;
      }
      const pending = candidates.findLast((turn) => !turn.turnId && !turn.discard);
      if (pending && !pending.turnId) {
        pending.turnId = event.turnId;
        return pending;
      }
      return undefined;
    }
    // An event without a turn id fails closed for private text.
    return candidates.length === 1 ? candidates[0] : undefined;
  }

  function begin(threadId: string): GoalLeadTurn {
    const turn: GoalLeadTurn = { token: Symbol("goal-coordinator-turn"), assistantItems: [], discard: false };
    add(threadId, turn);
    return turn;
  }

  function end(threadId: string, turn: GoalLeadTurn, outcome: string | undefined): void {
    if (!turnsByThread.get(threadId)?.has(turn)) return;
    if (outcome === "timed_out" || outcome === "stalled") {
      // interruptTurn is async: keep a discard-only guard so a late private envelope never reaches the room; the token check keeps an old timer off a newer turn.
      turn.discard = true;
      turn.assistantItems = [];
      const cleanupTimer = setTimeout(() => {
        remove(threadId, turn);
      }, GUARD_MS);
      cleanupTimer.unref?.();
      turn.cleanupTimer = cleanupTimer;
    } else {
      remove(threadId, turn);
    }
  }

  return {
    begin,
    end,
    remove,
    forEvent,
    hasUnboundDiscarded,
    count: (threadId: string): number => turnsByThread.get(threadId)?.size ?? 0,
  };
}

export type GoalTurns = ReturnType<typeof createGoalTurns>;
