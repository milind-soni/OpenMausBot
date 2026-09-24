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
};

/** One harness owns the data directory. Claims are synchronous and last for
 * the whole turn, not just a click: a screenshot and its following click
 * must see the same desktop. These coordinate app-managed resources; they
 * are not a sandbox for arbitrary shell commands. */
export class TurnResources {
  private readonly owners = new Map<string, TurnOwner>();

  blocker(resource: string, owner: TurnOwner): TurnOwner | undefined {
    for (const [key, current] of this.owners) {
      if (overlaps(key, resource) && !sameOwner(current, owner)) return current;
    }
    return undefined;
  }

  claim(resource: string, owner: TurnOwner): boolean {
    if (this.blocker(resource, owner)) return false;
    this.owners.set(resource, owner);
    return true;
  }

  owns(resource: string, owner: TurnOwner): boolean {
    const current = this.owners.get(resource);
    return Boolean(current && sameOwner(current, owner));
  }

  release(owner: TurnOwner): void {
    for (const [key, current] of this.owners) {
      if (sameOwner(current, owner)) this.owners.delete(key);
    }
  }

  /** Drop one of an owner's claims early, when the sequence that took it
   * could not finish. The owner's other claims stand until settle. */
  releaseOne(resource: string, owner: TurnOwner): void {
    if (this.owns(resource, owner)) this.owners.delete(resource);
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
