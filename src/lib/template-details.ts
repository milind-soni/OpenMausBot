import type { TemplateDetails } from "../../shared/share-card";
import { parsePackageDocument } from "../../shared/package-format";
import { manifestDetails, packageDetails } from "../../shared/share-details";
import { t } from "./i18n";

export { packageDetails };

/** A gallery team as the Details sheet shows it: a package (any version) or a legacy team file. Throws a sentence when it
 * is neither. Client-side preview only; the server stays the trust boundary. */
export function templateDetailsOf(value: unknown): TemplateDetails {
  if (typeof value === "string" || (value && typeof value === "object" && (value as { format?: unknown }).format === "openmaus.package")) {
    return packageDetails(parsePackageDocument(value));
  }
  const details = manifestDetails(value);
  if (!details) throw new Error(t("templateImport.notATemplate"));
  return details;
}
