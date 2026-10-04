export type TurnOwner = {
  threadId: string;
  generation: string;
  /** Set when a lazy computer-claim rejection was already reported for this
   * generation; the turn.completed fold checks it so that failure settles as
   * one incident, not two (Claude settles the follow-up interrupt as
   * exit_before_result, which reads there like a fresh failure). */
  lazyClaimFailureReported?: boolean;
  /** The computer resource this turn parked waiting for (#1651). Set at the
   * wait ceiling: the lazy-claim rejection path registers the resume from
   * it, and the completion fold settles the turn as parked, not failed. */
  computerParkedOn?: string;
};

/** One harness owns the data directory. Claims are synchronous and last for
 * the whole turn, not just a click: a screenshot and its following click
 * must see the same desktop. These coordinate app-managed resources — a
 * desktop, a browser session, a phone — that only one turn can drive at a
 * time. A project folder is not one: a bot's threads work in one folder
 * side by side, as several agent sessions do in one repo. They are not a
 * sandbox for arbitrary shell commands. */
export class TurnResources {
  private readonly owners = new Map<string, TurnOwner>();
  /** Arrival-ordered waiters per requested resource (#1652). Entries exist
   * only while a turn is genuinely waiting (the exclusive bind's poll loop):
   * a lazy claim that failed once and moved on must not sit at the front and
   * block an actively waiting turn behind it from being granted the seat. */
  private readonly waiters = new Map<string, TurnOwner[]>();
  /** Exponentially weighted moving average of recent wait durations per
   * resource, recorded when a waiting turn finally acquires. No history,
   * no estimate: the chip shows one only once this map has an entry. */
  private readonly waitStats = new Map<string, { ewmaMs: number; samples: number }>();

  /** Join the waitlist for a resource and return the stable position: where
   * this turn sits among the waiters, in arrival order. Joining twice keeps
   * the original place; positions only improve (a waiter ahead leaving),
   * never jitter. */
  startWaiting(resource: string, owner: TurnOwner): number {
    const queue = this.waiters.get(resource);
    if (!queue) {
      this.waiters.set(resource, [owner]);
      return 1;
    }
    const index = queue.findIndex(waiting => sameOwner(waiting, owner));
    if (index >= 0) return index + 1;
    queue.push(owner);
    return queue.length;
  }

  /** Leave the waitlist without claiming: the wait stopped, parked, or was
   * cancelled. Idempotent, and safe for an owner who never joined. */
  stopWaiting(resource: string, owner: TurnOwner): void {
    const queue = this.waiters.get(resource);
    if (!queue) return;
    const next = queue.filter(waiting => !sameOwner(waiting, owner));
    if (next.length) this.waiters.set(resource, next);
    else this.waiters.delete(resource);
  }

  /** This owner's current position in a resource's waitlist, or undefined
   * when they are not waiting for it. */
  waitPosition(resource: string, owner: TurnOwner): number | undefined {
    const queue = this.waiters.get(resource);
    if (!queue) return undefined;
    const index = queue.findIndex(waiting => sameOwner(waiting, owner));
    return index < 0 ? undefined : index + 1;
  }

  /** Record how long a wait lasted once it ended in acquisition, feeding the
   * per-resource estimate. Clamped to sane values so a clock skew cannot
   * poison the average. */
  noteWait(resource: string, waitedMs: number): void {
    if (!Number.isFinite(waitedMs) || waitedMs < 0) return;
    const sample = Math.min(waitedMs, 24 * 60 * 60_000);
    const stats = this.waitStats.get(resource);
    // Weight 1/4: recent waits dominate, one outlier does not rewrite the
    // estimate, and the very first wait seeds the history on its own.
    this.waitStats.set(resource, stats
      ? { ewmaMs: stats.ewmaMs + 0.25 * (sample - stats.ewmaMs), samples: stats.samples + 1 }
      : { ewmaMs: sample, samples: 1 });
  }

  /** The smoothed recent wait for a resource, or undefined until at least one
   * wait has completed — the chip's estimate condition (#1652). */
  waitEstimateMs(resource: string): number | undefined {
    return this.waitStats.get(resource)?.ewmaMs;
  }

  blocker(resource: string, owner: TurnOwner): TurnOwner | undefined {
    const current = this.owners.get(resource);
    return current && !sameOwner(current, owner) ? current : undefined;
  }

  claim(resource: string, owner: TurnOwner): boolean {
    if (this.blocker(resource, owner)) return false;
    const existing = this.owners.get(resource);
    if (existing && sameOwner(existing, owner)) return true;
    // The free seat belongs to the front waiter; a current holder's
    // revalidation above never loses its own claim to this queue.
    const queue = this.waiters.get(resource);
    if (queue?.length && !sameOwner(queue[0]!, owner)) return false;
    if (queue?.length) {
      queue.shift();
      if (!queue.length) this.waiters.delete(resource);
    }
    this.owners.set(resource, owner);
    return true;
  }

  owns(resource: string, owner: TurnOwner): boolean {
    const current = this.owners.get(resource);
    return Boolean(current && sameOwner(current, owner));
  }

  release(owner: TurnOwner): void {
    for (const [key, queue] of this.waiters) {
      const next = queue.filter(waiting => !sameOwner(waiting, owner));
      if (next.length) this.waiters.set(key, next);
      else this.waiters.delete(key);
    }
    for (const [key, current] of this.owners) {
      if (sameOwner(current, owner)) this.owners.delete(key);
    }
  }

  /** Drop one of an owner's claims early, when the sequence that took it
   * could not finish. The owner's other claims stand until settle. */
  releaseOne(resource: string, owner: TurnOwner): void {
    if (this.owns(resource, owner)) this.owners.delete(resource);
    this.stopWaiting(resource, owner);
  }

  /** Whether any live owner holds this resource: the parked-resume drain's
   * gate (#1651) — a resume fires only when the seat it queued on is free. */
  free(resource: string): boolean {
    return !this.owners.has(resource);
  }
}

function sameOwner(a: TurnOwner, b: TurnOwner): boolean {
  return a.threadId === b.threadId && a.generation === b.generation;
}
