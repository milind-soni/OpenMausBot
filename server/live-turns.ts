// The turn each thread is running: set by its turn.started, cleared by its turn.completed, and nothing once the
// thread is idle (a turn the harness retired, or one whose end was quarantined, never sends that end). Unlike the
// last turn id seen on any event, a late event of a finished turn never makes it live again.
import type { RuntimeEvent } from "./contracts.ts";

export class LiveTurns {
  readonly #byThread = new Map<string, string>();
  readonly #busy: (threadId: string) => boolean;

  /** `busy`: whether the thread is still working, as the harness's own records say. */
  constructor(busy: (threadId: string) => boolean) {
    this.#busy = busy;
  }

  onEvent(event: Pick<RuntimeEvent, "type" | "threadId" | "turnId">): void {
    if (!event.turnId) return;
    if (event.type === "turn.started") this.#byThread.set(event.threadId, event.turnId);
    else if (event.type === "turn.completed" && this.#byThread.get(event.threadId) === event.turnId) this.#byThread.delete(event.threadId);
  }

  /** A new turn is being dispatched on the thread: whatever turn it held before is over, its end lost or not. */
  dispatchStarted(threadId: string): void {
    this.#byThread.delete(threadId);
  }

  running(threadId: string): string | undefined {
    const turnId = this.#byThread.get(threadId);
    return turnId !== undefined && this.#busy(threadId) ? turnId : undefined;
  }
}
