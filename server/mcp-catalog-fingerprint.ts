import { createHash } from "node:crypto";

/** Tool order remains significant for provider-name collision aliases. */
export function fingerprintCatalog(server: string, tools: readonly unknown[]): string {
  const canonical = JSON.stringify([server, tools], (_key, value: unknown) =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
      : value);
  return createHash("sha256").update(canonical).digest("hex");
}

export const CATALOG_FINGERPRINT_META = "openmausbot/catalogFingerprint";
