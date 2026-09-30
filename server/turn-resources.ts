import { realpathSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { IdleReleasePolicy } from "./claim-idle.ts";

export type TurnOwner = {
  threadId: string;
  generation: string;
  /** Set when a lazy computer-claim rejection was already reported for this
   * generation; the turn.completed fold checks it so that failure settles as
   * one incident, not two (Claude settles the follow-up interrupt as
   * exit_before_result, which reads there like a fresh failure). */
  lazyClaimFailureReported?: boolean;
};

/** Options at claim time (#1653): `idle` opts the claim into quiet-window
 * release; `now` pins the clock in tests. */
export interface ClaimOptions {
  now?: number;
  idle?: IdleReleasePolicy;
}

type ClaimRecord = {
  owner: TurnOwner;
  /** Clock of the last real screen call (#1653). Only claims taken with an
   * idle policy carry it; everything else keeps hold-until-settle. */
  activityAt?: number;
  idle?: IdleReleasePolicy;
};

type ReclaimRecord = { owner: TurnOwner; until: number };

/** One harness owns the data directory. Claims are synchronous and last for
 * the whole turn, not just a click: a screenshot and its following click
 * must see the same desktop. These coordinate app-managed resources; they
 * are not a sandbox for arbitrary shell commands. */
export class TurnResources {
  private readonly owners = new Map<string, ClaimRecord>();
  private readonly reclaims = new Map<string, ReclaimRecord>();

  blocker(resource: string, owner: TurnOwner, now = Date.now()): TurnOwner | undefined {
    this.expireIdle(resource, now);
    for (const [key, current] of this.owners) {
      if (overlaps(key, resource) && !sameOwner(current.owner, owner)) return current.owner;
    }
    return undefined;
  }

  claim(resource: string, owner: TurnOwner, options: ClaimOptions = {}): boolean {
    const now = options.now ?? Date.now();
    if (this.blocker(resource, owner, now)) return false;
    const existing = this.owners.get(resource);
    if (existing && sameOwner(existing.owner, owner)) {
      // A repeated claim by the sitting owner changes nothing: replacing
      // the record would restart activityAt, and re-claims alone would
      // hold the seat past every quiet window (#1653).
      return true;
    }
    const record: ClaimRecord = { owner };
    if (options.idle) {
      record.idle = options.idle;
      // Taking (or retaking) a seat is itself screen activity: the quiet
      // window of #1653 starts at the claim, not at the first later call.
      record.activityAt = now;
    }
    this.owners.set(resource, record);
    const reclaimed = this.reclaims.get(resource);
    // Seating an owner closes any idle-release record for this resource:
    // the previous holder re-claimed (its turn lives on), or another turn
    // took the free seat — an occupied seat is exactly where #1653 says
    // the old holder yields.
    if (reclaimed) this.reclaims.delete(resource);
    return true;
  }

  owns(resource: string, owner: TurnOwner, now = Date.now()): boolean {
    this.expireIdle(resource, now);
    const current = this.owners.get(resource);
    return Boolean(current && sameOwner(current.owner, owner));
  }

  /** A real screen call touched this claim (#1653): restart its quiet
   * window. Claims without an idle policy — and anything the screen
   * poller drives — are no-ops, so preview frames can never hold a seat. */
  activity(resource: string, owner: TurnOwner, now = Date.now()): void {
    // Expiry first: a straggler screen completion arriving at or past the
    // quiet boundary must release the seat and open the reclaim window,
    // not restart the clock on a claim that already lapsed.
    this.expireIdle(resource, now);
    const current = this.owners.get(resource);
    if (current?.idle && sameOwner(current.owner, owner)) current.activityAt = now;
  }

  /** Who may still re-claim `resource` directly after an idle release
   * (#1653): the mid-task turn that went quiet, until its reclaim window
   * ends or another turn seats itself. The direct re-claim itself is
   * just `claim`: a free seat answers the returning holder's next screen
   * call without the wait a new arrival would enter. */
  reclaimHolder(resource: string, now = Date.now()): TurnOwner | undefined {
    const reclaimed = this.reclaims.get(resource);
    if (!reclaimed) return undefined;
    if (reclaimed.until <= now) {
      this.reclaims.delete(resource);
      return undefined;
    }
    return reclaimed.owner;
  }

  release(owner: TurnOwner): void {
    for (const [key, current] of this.owners) {
      if (sameOwner(current.owner, owner)) this.owners.delete(key);
    }
    // A settling turn keeps no reclaim priority (#1653): only a live
    // mid-task turn may pick its seat back up.
    for (const [key, reclaimed] of this.reclaims) {
      if (sameOwner(reclaimed.owner, owner)) this.reclaims.delete(key);
    }
  }

  /** Drop one of an owner's claims early, when the sequence that took it
   * could not finish. The owner's other claims stand until settle. */
  releaseOne(resource: string, owner: TurnOwner, now = Date.now()): void {
    if (this.owns(resource, owner, now)) this.owners.delete(resource);
    // owns() may have just expired a quiet claim into a reclaim record
    // for this same owner: an early release keeps no reclaim priority.
    const reclaimed = this.reclaims.get(resource);
    if (reclaimed && sameOwner(reclaimed.owner, owner)) this.reclaims.delete(resource);
  }

  /** Quiet-window expiry (#1653), evaluated when the claim is touched: a
   * screen-quiet seat is released while its turn lives and remembered for
   * the reclaim window. Synchronous on purpose — the claim map decides
   * every transition on the server's single thread. */
  private expireIdle(resource: string, now: number): void {
    const current = this.owners.get(resource);
    if (!current?.idle || current.activityAt === undefined) return;
    if (!current.idle.quietElapsed(current.activityAt, now)) return;
    this.owners.delete(resource);
    this.reclaims.set(resource, { owner: current.owner, until: now + current.idle.reclaimMs });
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
