export type SpotlightId = "spot.composer" | "spot.model" | "spot.approval" | "spot.connector";

export const SPOTLIGHTS: SpotlightId[] = ["spot.composer", "spot.model", "spot.approval", "spot.connector"];

export interface ChatObservation {
  replyStarted: boolean;
  replyFinished: boolean;
  approvalVisible: boolean;
  connectorVisible: boolean;
}

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

export function cardAnswered(active: SpotlightId, observation: ChatObservation): boolean {
  if (active === "spot.approval") return !observation.approvalVisible;
  if (active === "spot.connector") return !observation.connectorVisible;
  return false;
}

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

export function placementFor(id: SpotlightId): "above" | "below" {
  return id === "spot.composer" ? "above" : "below";
}

export function tourComplete(seen: readonly string[]): boolean {
  return SPOTLIGHTS.every((id) => seen.includes(id));
}
