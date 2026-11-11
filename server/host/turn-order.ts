import type { TurnKind } from "../agents-turn.ts";
import type { HandoffView } from "../coordinator.ts";

export interface TurnOrderDeps {
  /** What started the direct turn this thread runs or is about to run, and whether it goes on from a person's own line. */
  turn(threadId: string): { kind?: TurnKind; personLine?: true } | undefined;
  /** Bot-driven work carries on as a continuation too. */
  unattended(threadId: string): boolean;
  /** Assignments this thread is running, one of them perhaps going on from an answer. */
  running(threadId: string): HandoffView[];
  /** A room's turn this thread runs because of a person's own line. */
  roomLine(threadId: string): boolean;
}

/** A person's own work: their line, or a turn going on from what they just answered or chose. Answers from a bot or a default are bot work. */
export function createTurnOrder(deps: TurnOrderDeps) {
  return (threadId: string): boolean => {
    const turn = deps.turn(threadId);
    if (turn?.kind === "person") return true;
    if (turn?.kind === "continuation" && turn.personLine && !deps.unattended(threadId)) return true;
    return deps.roomLine(threadId) || deps.running(threadId).some((node) => node.answer !== undefined && !node.answeredBy);
  };
}
