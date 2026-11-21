import { brandStatus } from "@/lib/brand";
import type { ManagedPolicySummary } from "@/state/config-status";

/** Everywhere but a branded build and a desktop whose organization refuses the provider. A Team Cloud's own rules are not that
 * organization's: its Owner and Admins still see the sponsor's card. */
export function modelgoOfferable(policy: ManagedPolicySummary | null | undefined): boolean {
  if (brandStatus().source === "file") return false;
  if (!policy || policy.team) return true;
  return !policy.companyModelsOnly && (policy.allowedEngines === "all" || policy.allowedEngines.includes("modelgo"));
}
