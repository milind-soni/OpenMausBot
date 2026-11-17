// A teammate's hand-off may move only to the built-in browser with select_computer, never to another computer: no person
// watches a hand-off's Screen panel, and fill_login needs the bot's own browser. The turn that continues there owns the result.
export const HANDOFF_BROWSER_ONLY = "A teammate's hand-off can move only to the built-in browser: call select_computer with surface browser, or carry on with the computer already in use.";

export const HANDOFF_BROWSER_NOTE = " This is a teammate's hand-off: when it needs the built-in browser (for example to sign in with a saved login), call select_computer with surface browser and end this turn; the hand-off continues there and its result still returns. It cannot move to any other computer.";

/** The place a hand-off's select_computer asks for: auto means the built-in browser; any other computer is refused. */
export function handoffSurface(asked: unknown): "browser" | null {
  return asked === "auto" || asked === "browser" ? "browser" : null;
}

export const HANDOFF_BROWSER_STOPPED = "The hand-off stopped before it could continue in the built-in browser (a new message, a stop or another turn came first), so the request may be incomplete: check what was already done before relying on it.";

/** What a hand-off returns when its turn asked to move to the browser but the browser turn never ran: never the
 *  reply that only asked to move, as if the work were done. A failed turn keeps its own failure. */
export function stoppedHandoffResult<T extends { ok: boolean; text: string }>(kept: T): T | { ok: false; text: string } {
  return kept.ok ? { ok: false, text: HANDOFF_BROWSER_STOPPED } : kept;
}

/** Hand-offs given up before their turn's outcome arrived (an adapter can finish before dispatch returns): that late
 *  outcome is reported as stopped too, never as the move request. Bounded so ids that never settle cannot pile up. */
export class StoppedHandoffs {
  readonly #ids = new Set<string>();
  readonly limit: number;
  constructor(limit = 1_024) { this.limit = limit; }
  stop(generation: string): void {
    this.#ids.add(generation);
    while (this.#ids.size > this.limit) this.#ids.delete(this.#ids.values().next().value!);
  }
  /** The outcome to report for `generation`: as stopped when it was given up early (once), else unchanged. */
  settle<T extends { ok: boolean; text: string }>(generation: string, outcome: T): T | { ok: false; text: string } {
    return this.#ids.delete(generation) ? stoppedHandoffResult(outcome) : outcome;
  }
}
