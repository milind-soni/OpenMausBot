// Waking a bot that has already finished.
//
// The harness has always had exactly one of these: the connector-resume path,
// which re-entered a settled bot with a synthetic prompt after the user
// completed a connection card. It worked, and everything it learned the hard
// way is preserved here — a busy bot's wake is HELD rather than raced against
// the turn it is already running, a group member's wake is serialized on that
// room's queue, and a wake whose bot/thread pairing has gone is dropped
// instead of retried forever.
//
// What changes is that there is now more than one reason to wake a bot: an
// app event matched a routine's listener, or a background executor finished.
// Those are wake PRODUCERS; none of them re-implements dispatch.
//
// The queue owns the policy and nothing else. Running a turn needs startTurn,
// runGroupMemberTurn and the group queues, all of which live in index.ts, so
// they arrive as an injected runtime — the same shape ApprovalBus and CommsBus
// use to stay testable without a whole server.

export type WakeSource = "connector" | "listener" | "executor";

export interface Wake {
  /** Dedupe key. A second wake with the same key replaces the first: two
   * events about one paused task are one reason to wake up, not two. */
  key: string;
  source: WakeSource;
  botId: string;
  threadId: string;
  /** Control-plane context, not a message authored by the user. */
  prompt: string;
  /** The wake could not be delivered at all. Whatever surfaced the pause
   * (a connector card, a routine run) marks itself failed. */
  onFailure?: (message: string) => void;
}

export interface WakeOwner {
  busy: boolean;
  /** Set when this thread is a room the bot is a member of. */
  groupId?: string;
}

export interface WakeRuntime {
  /** The bot behind this wake, or null when the bot/thread pairing is gone
   * (the bot was deleted, or removed from the room). */
  owner(botId: string, threadId: string): WakeOwner | null;
  /** Run the wake as a room turn. The implementation serializes on that
   * room's queue and calls `requeue` if the bot went busy while it waited. */
  runGroupTurn(groupId: string, wake: Wake, requeue: () => void): void;
  /** Run the wake as an ordinary 1:1 turn. Rejects the way startTurn does. */
  runSoloTurn(wake: Wake): Promise<void>;
}

/** startTurn's own words for "this bot is mid-turn". Matched rather than
 * typed because it reaches us as a rejected Error from an HTTP-shaped path
 * that predates any error code. */
const ALREADY_WORKING = /already working/i;

function messageOf(error: Error | { message?: unknown } | string): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export class WakeQueue {
  readonly #pending = new Map<string, Wake>();
  // Declared and assigned, not a constructor parameter property: the server
  // runs under `node --experimental-strip-types`, which strips annotations
  // without synthesizing the field a parameter property implies.
  readonly #runtime: WakeRuntime;

  constructor(runtime: WakeRuntime) {
    this.#runtime = runtime;
  }

  get size(): number {
    return this.#pending.size;
  }

  /** Hold a wake until its bot is next idle. */
  requeue(wake: Wake): void {
    this.#pending.set(wake.key, wake);
  }

  dispatch(wake: Wake): void {
    const owner = this.#runtime.owner(wake.botId, wake.threadId);
    // no owner: the bot or its place in this thread is gone. Nothing to wake,
    // and nothing to report — the surface that would show the failure went
    // with it.
    if (!owner) return;
    if (owner.busy) return this.requeue(wake);
    if (owner.groupId !== undefined) {
      this.#runtime.runGroupTurn(owner.groupId, wake, () => this.requeue(wake));
      return;
    }
    void this.#runtime.runSoloTurn(wake).catch((error) => {
      const message = messageOf(error);
      // the bot became busy between the idle check and the dispatch — that is
      // a race, not a failure, and the next drain will pick it up
      if (ALREADY_WORKING.test(message)) return this.requeue(wake);
      wake.onFailure?.(message);
    });
  }

  /** Re-dispatch everything whose bot has since gone idle. Called when a turn
   * settles, which is the only moment a held wake can become runnable. */
  drain(): void {
    // Collected before any dispatch: dispatch can call requeue, which writes
    // back into #pending, and a key re-added mid-iteration would be walked
    // again in the same pass.
    const runnable: Wake[] = [];
    for (const wake of this.#pending.values()) {
      if (this.#runtime.owner(wake.botId, wake.threadId)?.busy) continue;
      runnable.push(wake);
    }
    for (const wake of runnable) {
      this.#pending.delete(wake.key);
      this.dispatch(wake);
    }
  }
}
