// How long work for the person's Cloud waits on a computer while that Cloud cannot be reached (server/bot-link/link.ts).
// Work no person waits on (a routine's, a scheduled run's) never wakes a sleeping Cloud (dial.ts): it waits until the
// Cloud is awake for another reason, at most BACKGROUND_WAIT_MS, and is given up then while still unsent. Work a person
// waits on is never given up here: it may wake the Cloud, and otherwise waits until it can.
import type { HandoffView } from "../coordinator.ts";

/** On a computer: work no person waits on waits this long for a Cloud that cannot be reached, then fails. */
export const BACKGROUND_WAIT_MS = 6 * 60 * 60_000;

/** Never sent to the other place: not yet run here, and not a rerun of one that ran before a restart. */
export const neverSent = (node: Pick<HandoffView, "status" | "executions" | "restart" | "restarts">): boolean =>
  node.status === "queued" && node.executions === 0 && node.restart === undefined && node.restarts === 0;

/** What a bot is told when work no person waits on goes to a Cloud that cannot be reached now. */
export const backgroundWaitNote = (place: string, waitMs = BACKGROUND_WAIT_MS): string =>
  `${place} can't be reached now (asleep, off or not connected), and work no person waits on does not wake it, so this waits until it can be reached for another reason, at most ${Math.round(waitMs / 3_600_000)} hours, and is not sent if it can't be by then`;

/** Why work no person waits on, for a Cloud that could not be reached, is given up, or null while it may still wait.
 * `unsent`: the Cloud has not taken it yet. */
export function cloudUnreachableTooLong(node: HandoffView, place: string, unsent: boolean, now: number, waitMs = BACKGROUND_WAIT_MS): string | null {
  if (!unsent || node.restart !== undefined || now - node.createdAt < waitMs) return null;
  return `${place} could not be reached for ${Math.round(waitMs / 3_600_000)} hours (asleep, off or not connected), so this was not sent there. Work no person waits on does not wake it.`;
}

const armed = new Set<string>();
/** After a restart, waiting work's give-up is looked at again when its wait is over, not at the next unrelated kick:
 * `kick` once at each node's deadline (once per node per run). */
export function armBackground(nodes: readonly Pick<HandoffView, "id" | "createdAt">[], now: number, waitMs: number, kick: () => void): void {
  for (const node of nodes) {
    if (armed.has(node.id)) continue;
    armed.add(node.id);
    const timer = setTimeout(kick, Math.max(0, node.createdAt + waitMs - now) + 50);
    timer.unref?.();
  }
}
