import { track } from "@/lib/analytics";
import { brandStatus } from "@/lib/brand";
import type { ManagedPolicySummary } from "@/state/config-status";

export type ModelgoOfferAction = "shown" | "get_key" | "add_key" | "not_now" | "close";
export type ModelgoOfferPlace = "popup" | "onboarding" | "settings";

export function reportModelgoOffer(action: ModelgoOfferAction, place: ModelgoOfferPlace) {
  track("modelgo_offer", { action, place });
}

/** Everywhere but a branded build and a desktop whose organization refuses the provider. A Team Cloud's own rules are not that
 * organization's: its people still see the sponsor's card. */
export function modelgoOfferable(policy: ManagedPolicySummary | null | undefined): boolean {
  if (brandStatus().source === "file") return false;
  if (!policy || policy.team) return true;
  return !policy.companyModelsOnly && (policy.allowedEngines === "all" || policy.allowedEngines.includes("modelgo"));
}
