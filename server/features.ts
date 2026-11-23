import { z } from "zod";

/** Optional capabilities an operator turns on for this server. Nothing here is on by default. */
export const FEATURE_IDS = ["admin", "billing", "branding", "budgets"] as const;
export type FeatureId = (typeof FEATURE_IDS)[number];

/** Comma-separated feature ids; when set, it alone decides and `edition.features` in config.json is ignored. */
export const FEATURES_ENV = "APP_FEATURES";

/** `edition` in config.json. Not part of the settings patch, so only the operator can change it. */
export const editionConfigSchema = z.object({
  features: z.array(z.enum(FEATURE_IDS)).max(FEATURE_IDS.length).optional(),
}).strict();

export interface EditionStatus {
  edition: "oss";
  /** Enabled feature ids, sorted. */
  features: FeatureId[];
}

export interface FeatureResolution {
  features: FeatureId[];
  source: "env" | "config" | "none";
  /** Ids in APP_FEATURES this build does not know; they enable nothing. */
  unknown: string[];
}

function isFeatureId(id: string): id is FeatureId {
  return (FEATURE_IDS as readonly string[]).includes(id);
}

export function resolveFeatures(env: NodeJS.ProcessEnv, configured: readonly FeatureId[] | undefined): FeatureResolution {
  const raw = env[FEATURES_ENV];
  if (raw !== undefined) {
    const ids = raw.split(",").map((id) => id.trim()).filter(Boolean);
    return {
      features: [...new Set(ids.filter(isFeatureId))].sort(),
      source: "env",
      unknown: [...new Set(ids.filter((id) => !isFeatureId(id)))],
    };
  }
  if (configured?.length) return { features: [...new Set(configured)].sort(), source: "config", unknown: [] };
  return { features: [], source: "none", unknown: [] };
}

let enabled: readonly FeatureId[] = [];

/** Read once at startup; a change to APP_FEATURES or config.json takes effect on the next start. */
export function configureFeatures(env: NodeJS.ProcessEnv, configured: readonly FeatureId[] | undefined): FeatureResolution {
  const resolution = resolveFeatures(env, configured);
  enabled = resolution.features;
  return resolution;
}

export function featureEnabled(id: FeatureId): boolean {
  return enabled.includes(id);
}

export function editionStatus(): EditionStatus {
  return { edition: "oss", features: [...enabled] };
}

export function describeFeatures(resolution: FeatureResolution): string {
  const list = resolution.features.length ? resolution.features.join(", ") : "none";
  const from = resolution.source === "none" ? "" : ` (from ${resolution.source === "env" ? FEATURES_ENV : "config.json edition.features"})`;
  return `openmausbot features: ${list}${from}`;
}

/** Throws on an id this build does not know, so a typo never silently turns nothing on. */
export function parseFeatureList(raw: string): FeatureId[] {
  const { features, unknown } = resolveFeatures({ [FEATURES_ENV]: raw }, undefined);
  if (unknown.length) throw new Error(`unknown feature ids: ${unknown.join(", ")} (known: ${FEATURE_IDS.join(", ")})`);
  return features;
}
