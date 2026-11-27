// Entry point core loads when this folder exists: the configured license key
// becomes entitlements, or a thrown message tells the operator what to fix.
import { verifyLicenseKey } from "./license.ts";
export { createWorkspaceAccess } from "./workspace-access.ts";

export interface RegisteredLayer {
  customer: string;
  features: string[];
  expiresAt: string | null;
}

/** The longest grace core may ask for; a larger number is clamped, never trusted. */
const MAX_GRACE_DAYS = 14;
const DAY_MS = 24 * 60 * 60_000;

export function register(options: { licenseKey: string | undefined; graceDays?: number; now?: number }): RegisteredLayer | null {
  if (!options.licenseKey) return null;
  // Core keeps a recently expired key working while the operator renews it;
  // only the expiry comparison moves that many days earlier.
  const graceDays = Math.min(MAX_GRACE_DAYS, Math.max(0, Number.isFinite(options.graceDays) ? options.graceDays! : 0));
  const claims = verifyLicenseKey(options.licenseKey, { now: new Date((options.now ?? Date.now()) - graceDays * DAY_MS) });
  return { customer: claims.customer, features: claims.features, expiresAt: claims.expires };
}
