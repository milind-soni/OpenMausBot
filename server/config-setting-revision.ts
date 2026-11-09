import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import { dataHome } from "./data-dir.ts";
import { parseJson, type JsonObject } from "./schema.ts";

const mutationSettings = ["language", "computerName"] as const;
type MutationSetting = (typeof mutationSettings)[number];
const settingRevisionsSchema = z.object({ language: z.string().uuid().optional(), computerName: z.string().uuid().optional() }).strict().default({});
const jsonObjectSchema = z.record(z.string(), z.json());
const defaultDataDir = process.env.OMB_DATA_DIR || join(dataHome(), ".openmausbot");

export function configSettingRevision(setting: MutationSetting, dataDir = defaultDataDir): string {
  const file = join(dataDir, "config.json");
  if (!existsSync(file)) return "none";
  const disk = jsonObjectSchema.parse(parseJson(readFileSync(file, "utf8")));
  return settingRevisionsSchema.parse(disk._settingRevisions)[setting] ?? "none";
}

export function writeConfigWithSettingRevisions(file: string, disk: JsonObject, patch: Partial<Record<MutationSetting, string>>, unsetSettings: MutationSetting[] = []): void {
  const mutated = mutationSettings.filter(setting => patch[setting] !== undefined || unsetSettings.includes(setting));
  if (mutated.length) {
    const revisions = settingRevisionsSchema.parse(disk._settingRevisions);
    for (const setting of mutated) {
      if (unsetSettings.includes(setting)) delete disk[setting];
      revisions[setting] = randomUUID();
    }
    disk._settingRevisions = revisions;
  }
  writeFileAtomic(file, JSON.stringify(disk, null, 2), { mode: 0o600 });
}
