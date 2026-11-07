// White-label: a brand.json next to the data dir, applied only with the `whitelabel` entitlement (an unlicensed server
// reports what it found and keeps the default). Read on every request, so an edit shows on the next reload.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { brandSchema, type Brand } from "./brand-schema.ts";
import { DATA_DIR } from "./config.ts";
import { entitled } from "./enterprise.ts";

export { BRAND_FIELDS, brandSchema, MAX_FAVICON_CHARS, MAX_LOGO_CHARS, type Brand, type BrandField } from "./brand-schema.ts";

export const DEFAULT_BRAND: Brand = { name: "OpenMausBot" };

export interface BrandStatus {
  brand: Brand;
  /** "file" when brand.json is applied; "default" otherwise (see notice for why). */
  source: "default" | "file";
  /** The path consulted, so an operator knows where to put the file. */
  file: string;
  /** Why the file was not applied, in terms of what to change. */
  notice?: string;
}

export function brandFile(): string {
  return process.env.OMB_BRAND_FILE || join(DATA_DIR, "brand.json");
}

/** Never throws. */
export function loadBrand(options: { file?: string; isEntitled?: (feature: string) => boolean } = {}): BrandStatus {
  const file = options.file ?? brandFile();
  const isEntitled = options.isEntitled ?? entitled;
  const fallback = (notice?: string): BrandStatus =>
    notice ? { brand: DEFAULT_BRAND, source: "default", file, notice } : { brand: DEFAULT_BRAND, source: "default", file };
  if (!existsSync(file)) return fallback();
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    return fallback(`${file} is not valid JSON (${error instanceof Error ? error.message : String(error)}); using the default brand`);
  }
  const parsed = brandSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
    return fallback(`${file}: ${where}${issue?.message ?? "invalid"}; using the default brand`);
  }
  if (!isEntitled("whitelabel")) {
    return fallback(`${file} found but this server is not licensed for whitelabel; using the default brand`);
  }
  return { brand: parsed.data, source: "file", file };
}

export function describeBrand(status: BrandStatus): string {
  if (status.source === "file") return `brand: ${status.brand.name} (from ${status.file})`;
  return `brand: default${status.notice ? ` (${status.notice})` : ""}`;
}
