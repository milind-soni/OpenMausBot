import { track } from "@/lib/analytics";
import { brandStatus } from "@/lib/brand";
import type { ManagedPolicySummary } from "@/state/config-status";

export type ModelgoOfferAction = "shown" | "get_key" | "add_key" | "not_now" | "close";
export type ModelgoOfferPlace = "popup" | "onboarding" | "settings";

export function reportModelgoOffer(action: ModelgoOfferAction, place: ModelgoOfferPlace, campaign?: string) {
  track("modelgo_offer", { action, place, ...(campaign ? { campaign } : {}) });
}

/** Everywhere but a branded build and a desktop whose organization refuses the provider. A Team Cloud's own rules are not that
 * organization's: its Owner and Admins still see the sponsor's card. */
export function modelgoOfferable(policy: ManagedPolicySummary | null | undefined): boolean {
  if (brandStatus().source === "file") return false;
  if (!policy || policy.team) return true;
  return !policy.companyModelsOnly && (policy.allowedEngines === "all" || policy.allowedEngines.includes("modelgo"));
}

/** The sponsor's row moves up to third place, or higher to stand directly above the first row `under` picks; a row
 * already higher keeps its place, and the other rows keep their order. */
export function sponsorRowRaised<T>(rows: readonly T[], sponsor: T | undefined, under: (row: T) => boolean): T[] {
  const from = sponsor === undefined ? -1 : rows.indexOf(sponsor);
  if (from < 0) return [...rows];
  const rest = rows.filter((_, index) => index !== from);
  const above = rest.findIndex(under);
  const at = Math.min(from, 2, above < 0 ? 2 : above);
  return [...rest.slice(0, at), rows[from], ...rest.slice(at)];
}
