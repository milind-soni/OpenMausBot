// Entry point core loads when this folder exists (see server/enterprise.ts).
// Turn the configured license key into entitlements, or throw a message that
// tells the operator what to fix; core degrades to the open-source edition.
import { verifyLicenseKey } from "./license.ts";

export interface RegisteredLayer {
  customer: string;
  features: string[];
  expiresAt: string | null;
}

export function register(options: { licenseKey: string | undefined }): RegisteredLayer | null {
  if (!options.licenseKey) return null;
  const claims = verifyLicenseKey(options.licenseKey);
  return { customer: claims.customer, features: claims.features, expiresAt: claims.expires };
}
