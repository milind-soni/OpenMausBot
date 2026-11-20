// A person's last look changes in history.json beside their themes, oldest first: what they wore before and after, and
// each theme file a change rewrote as it was before it, so any kept change can be gone back to.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { SKIN_IDS } from "../../shared/app-settings.ts";
import { LOOK_CHANGE_KINDS, LOOK_HISTORY_LIMIT, THEME_ASSET_NAME, THEME_ID, themeFileSchema, type LookChange } from "../../shared/theme.ts";
import { writeFileAtomic } from "../atomic.ts";

const skinSchema = z.enum([...SKIN_IDS, "system"]);
export type Skin = z.infer<typeof skinSchema>;

/** What a person wears: their saved theme, or none; and the built-in skin underneath when one is known. */
const lookSchema = z.object({ id: z.string().regex(THEME_ID).nullable(), skin: skinSchema.optional() }).strict();
export type Look = z.infer<typeof lookSchema>;

/** A theme file as it was; null when the theme did not exist yet. Its pictures and fonts stay in the theme's folder, so
 * only their names are kept. */
const snapshotSchema = z.object({ file: themeFileSchema.nullable(), assets: z.array(z.string().regex(THEME_ASSET_NAME)) }).strict();
export type Snapshot = z.infer<typeof snapshotSchema>;

const entrySchema = z.object({
  seq: z.number().int().positive(),
  at: z.string(),
  change: z.object({ kind: z.enum(LOOK_CHANGE_KINDS), name: z.string().max(60).optional(), count: z.number().int().positive().optional() }).strict(),
  before: lookSchema,
  after: lookSchema,
  themes: z.record(z.string().regex(THEME_ID), snapshotSchema).optional(),
}).strict();
export type LookEntry = z.infer<typeof entrySchema>;

const historySchema = z.object({ entries: z.array(entrySchema) }).strict();

const FILE = "history.json";

export function readHistory(folder: string): LookEntry[] {
  try {
    const parsed = historySchema.safeParse(JSON.parse(readFileSync(join(folder, FILE), "utf8")));
    return parsed.success ? parsed.data.entries : [];
  } catch {
    return [];
  }
}

export function appendHistory(folder: string, entry: Omit<LookEntry, "seq" | "at"> & { change: LookChange }, now = new Date()): void {
  const entries = readHistory(folder);
  const seq = (entries.at(-1)?.seq ?? 0) + 1;
  const kept = [...entries, { ...entry, seq, at: now.toISOString() }].slice(-LOOK_HISTORY_LIMIT);
  writeFileAtomic(join(folder, FILE), `${JSON.stringify({ entries: kept })}\n`);
}

/** How things looked right after change `seq`: what was worn, and every theme file changed since as it was then. Null
 * when that change is no longer kept; `undone` empty when it is the latest. */
export function lookAfter(entries: readonly LookEntry[], seq: number): { look: Look; themes: Record<string, Snapshot>; undone: LookEntry[] } | null {
  const first = entries[0];
  if (!first || seq < first.seq - 1 || seq > entries.at(-1)!.seq) return null;
  const undone = entries.filter((entry) => entry.seq > seq);
  const themes: Record<string, Snapshot> = {};
  for (const entry of undone) {
    for (const [id, snapshot] of Object.entries(entry.themes ?? {})) themes[id] ??= snapshot;
  }
  const look = undone[0]?.before ?? entries.at(-1)!.after;
  return { look, themes, undone };
}
