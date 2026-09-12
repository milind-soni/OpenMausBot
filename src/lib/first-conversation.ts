// The guided first conversation's sequencing, kept pure: given what the
// chat is doing right now and which spotlights were already dismissed, which
// spotlight (if any) should be on screen. One at a time, each once, in an
// order that follows the turn: the composer when a reply starts, the model
// chip when it finishes, the approval and connect-app cards whenever they
// first appear. Persisted through the same `hintsSeen` list as the later
// first-sight hints, so the ids share a namespace.

export type SpotlightId = "spot.composer" | "spot.model" | "spot.approval" | "spot.connector";

export const SPOTLIGHTS: SpotlightId[] = ["spot.composer", "spot.model", "spot.approval", "spot.connector"];

export interface ChatObservation {
  /** The bot is producing a reply right now (busy or streaming). */
  replyStarted: boolean;
  /** At least one reply has completed in this session. */
  replyFinished: boolean;
  /** An unresolved approval card is on screen. */
  approvalVisible: boolean;
  /** An unresolved connect-app card is on screen. */
  connectorVisible: boolean;
}

/** The spotlight to show, or null. Cards win over chrome: a live approval
 * is the thing the user must act on, so it is explained first. The composer
 * and model spotlights only fire in order, and never while another is up. */
export function nextSpotlight(
  observation: ChatObservation,
  seen: readonly string[],
  active: SpotlightId | null,
): SpotlightId | null {
  if (active) return active;
  const unseen = (id: SpotlightId) => !seen.includes(id);
  if (observation.approvalVisible && unseen("spot.approval")) return "spot.approval";
  if (observation.connectorVisible && unseen("spot.connector")) return "spot.connector";
  if ((observation.replyStarted || observation.replyFinished) && unseen("spot.composer")) return "spot.composer";
  if (observation.replyFinished && !unseen("spot.composer") && unseen("spot.model")) return "spot.model";
  return null;
}

/** Which element each spotlight anchors to, by its `data-tour` id. */
export function anchorFor(id: SpotlightId): string {
  switch (id) {
    case "spot.composer":
      return "composer";
    case "spot.model":
      return "model";
    case "spot.approval":
      return "approval";
    case "spot.connector":
      return "connector";
  }
}

/** Where the card sits relative to its anchor. The composer is at the
 * bottom of the window, so its card goes above; everything else, below. */
export function placementFor(id: SpotlightId): "above" | "below" {
  return id === "spot.composer" ? "above" : "below";
}

/** All four dismissed: the tour is over and the watcher can unmount. */
export function tourComplete(seen: readonly string[]): boolean {
  return SPOTLIGHTS.every((id) => seen.includes(id));
}
