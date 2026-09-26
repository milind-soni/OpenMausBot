import { realpathSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

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
 * must see the same desktop. These coordinate app-managed resources; they
 * are not a sandbox for arbitrary shell commands. */
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
    for (const [key, current] of this.owners) {
      if (overlaps(key, resource) && !sameOwner(current, owner)) return current;
    }
    return undefined;
  }

  claim(resource: string, owner: TurnOwner): boolean {
    if (this.blocker(resource, owner)) return false;
    // The seat may be free with a waitlist: it is the front waiter's turn.
    // This is what makes a release grant position 1 deterministically — the
    // 100ms polls race, but only the front claim can land (#1652).
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
    for (const key of this.owners.keys()) {
      if (overlaps(key, resource)) return false;
    }
    return true;
  }
}

function sameOwner(a: TurnOwner, b: TurnOwner): boolean {
  return a.threadId === b.threadId && a.generation === b.generation;
}

export function workspaceResource(cwd: string): string {
  // Selected folders must exist before the engine starts. Resolve symlinks
  // and native filename casing so aliases cannot grant two writers to the
  // same project on case-insensitive volumes.
  const canonical = realpathSync.native(resolve(cwd));
  return `workspace:${process.platform === "win32" ? canonical.toLowerCase() : canonical}`;
}

function overlaps(a: string, b: string): boolean {
  if (a === b) return true;
  if (!a.startsWith("workspace:") || !b.startsWith("workspace:")) return false;
  const left = a.slice("workspace:".length);
  const right = b.slice("workspace:".length);
  const contains = (parent: string, child: string) => {
    const path = relative(parent, child);
    return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !path.startsWith(sep) && !/^[A-Za-z]:/.test(path));
  };
  return contains(left, right) || contains(right, left);
}
