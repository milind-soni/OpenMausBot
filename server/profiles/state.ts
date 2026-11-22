import { readFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { PROFILE_KEY } from "../../shared/profile-format.ts";
import type { ProfileSource } from "../../shared/wire.ts";
import { writeFileAtomic } from "../atomic.ts";

const hashes = z.record(z.string(), z.string());
const stateSchema = z.object({
  version: z.literal(1),
  folder: z.string().optional(),
  applied: z.object({ at: z.number(), commit: z.string().optional(), digest: z.string(), folder: z.string() }).optional(),
  areas: z.record(z.string(), z.object({ section: z.string(), hashes })).default({}),
});

/** `<data>/profiles.json`: the folder the person chose, what was last applied, and each applied area's department. */
export type ProfilesState = z.infer<typeof stateSchema>;

export const profilesStateFile = (dataDir: string) => join(dataDir, "profiles.json");

export function readProfilesState(dataDir: string): ProfilesState {
  let raw: string;
  try {
    raw = readFileSync(profilesStateFile(dataDir), "utf8");
  } catch {
    return { version: 1, areas: {} };
  }
  try {
    const parsed = stateSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
  } catch { /* falls through to the empty state */ }
  console.warn("profiles.json could not be read; starting with no applied profiles");
  return { version: 1, areas: {} };
}

export function writeProfilesState(dataDir: string, state: ProfilesState): void {
  writeFileAtomic(profilesStateFile(dataDir), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

/** `state` with every area on department `from` moved to `to`, as the app renamed it. */
export function withDepartmentRenamed(state: ProfilesState, from: string, to: string): ProfilesState {
  const fold = (name: string) => name.trim().toLowerCase();
  return { ...state, areas: Object.fromEntries(Object.entries(state.areas).map(([key, area]) => [key, fold(area.section) === fold(from) ? { ...area, section: to } : area])) };
}

/** A department was renamed in the app: the areas applied to it follow, so the next plan finds it. */
export function departmentRenamed(dataDir: string, from: string, to: string): void {
  const state = readProfilesState(dataDir);
  const next = withDepartmentRenamed(state, from, to);
  if (JSON.stringify(next) !== JSON.stringify(state)) writeProfilesState(dataDir, next);
}

const profileSourceSchema = z.object({
  area: z.string().regex(PROFILE_KEY),
  key: z.string().regex(PROFILE_KEY),
  file: z.string(),
  commit: z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/).optional(),
  appliedAt: z.number().finite(),
  hashes: z.record(z.string().max(300), z.string().regex(/^[0-9a-f]{16,64}$/)),
}).strict().refine((source) => source.file === `areas/${source.area}/bots/${source.key}.md`);

/** A bot's `profileSource` as a backup carries it: kept when it is one apply could have written, else dropped. */
export function restoredProfileSource(value: unknown): ProfileSource | undefined {
  const parsed = profileSourceSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
