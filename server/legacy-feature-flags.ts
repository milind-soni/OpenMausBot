import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import { parseJson, type JsonObject } from "./schema.ts";

const jsonObjectSchema = z.record(z.string(), z.json());

/** Renames `features.skillRecorder` to `features.skillAuthoring` in config.json, in place. */
export function migrateLegacyFeatureFlags(dataDir: string): void {
  const p = join(dataDir, "config.json");
  try {
    if (!existsSync(p)) return;
    const disk = jsonObjectSchema.safeParse(parseJson(readFileSync(p, "utf8")));
    if (!disk.success) return;
    const features = jsonObjectSchema.safeParse(disk.data.features);
    if (!features.success || !Object.hasOwn(features.data, "skillRecorder")) return;
    const next: JsonObject = { ...features.data };
    if (!Object.hasOwn(next, "skillAuthoring")) next.skillAuthoring = next.skillRecorder === true;
    delete next.skillRecorder;
    writeFileAtomic(p, JSON.stringify({ ...disk.data, features: next }, null, 2), { mode: 0o600 });
    console.log(`[config] features.skillRecorder renamed to features.skillAuthoring (${String(next.skillAuthoring)})`);
  } catch (error) {
    console.error(`[config] could not rename features.skillRecorder: ${error instanceof Error ? error.message : String(error)}`);
  }
}
