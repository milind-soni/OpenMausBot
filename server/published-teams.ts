// What this installation has shared, per team: the package id and the
// release last exported, plus the key each bot, group chat and routine was
// published under.
//
// Keys are a package's identity across releases (Admin refuses a release
// that silently drops one, and later updates match on them). They must not
// come from names once they exist: renaming a bot, a room, a routine or the
// team would otherwise read as "everything removed, everything added". So
// the first export records them here, keyed by record id, and every later
// export of the same team reuses them. Teams are name strings in OMB, so the
// team entry is renamed with the section (section-context.ts calls
// renamePublishedTeam from the one function every rename goes through).
//
// Server-private: nothing here is on the wire, and nothing here is a secret.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";

export const PUBLISHED_TEAMS_FILE = join(DATA_DIR, "published-teams.json");

const keyMap = z.record(z.string(), z.string());
const publishedTeamSchema = z.object({
  packageId: z.string().min(1),
  lastRelease: z.string().min(1),
  keys: z.object({ bots: keyMap, rooms: keyMap, routines: keyMap }).default({ bots: {}, rooms: {}, routines: {} }),
});
const fileSchema = z.object({ version: z.literal(1), teams: z.record(z.string(), z.unknown()) });

export type PublishedTeam = z.output<typeof publishedTeamSchema>;

function load(): Map<string, PublishedTeam> {
  const teams = new Map<string, PublishedTeam>();
  if (!existsSync(PUBLISHED_TEAMS_FILE)) return teams;
  try {
    const file = fileSchema.parse(JSON.parse(readFileSync(PUBLISHED_TEAMS_FILE, "utf8")));
    // Own entries only: a team may be called anything, including __proto__.
    for (const [section, value] of Object.entries(file.teams)) {
      const entry = publishedTeamSchema.safeParse(value);
      if (entry.success) teams.set(section, entry.data);
    }
  } catch {
    // An unreadable record only costs key stability on the next export,
    // which then derives keys from names as a first export does.
  }
  return teams;
}

function save(teams: Map<string, PublishedTeam>): void {
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const out: Record<string, PublishedTeam> = Object.create(null);
  for (const [section, entry] of teams) out[section] = entry;
  writeFileAtomic(PUBLISHED_TEAMS_FILE, JSON.stringify({ version: 1, teams: out }, null, 2), { mode: 0o600 });
}

export function readPublishedTeam(section: string): PublishedTeam | null {
  return load().get(section) ?? null;
}

export function writePublishedTeam(section: string, entry: PublishedTeam): void {
  const teams = load();
  teams.set(section, entry);
  save(teams);
}

/** Follow a team rename; null forgets the team (it was deleted). */
export function renamePublishedTeam(name: string, nextName: string | null): void {
  const teams = load();
  const entry = teams.get(name);
  if (!entry || name === nextName) return;
  teams.delete(name);
  if (nextName !== null) teams.set(nextName, entry);
  save(teams);
}

/** "1.2.3" → "1.2.4"; nothing published yet (or unreadable) starts at 1.0.0. */
export function nextPatchRelease(release: string | undefined): string {
  const match = release?.match(/^(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/);
  if (!match) return "1.0.0";
  const [major, minor, patch] = match.slice(1).map(Number) as [number, number, number];
  return patch < 999_999 ? `${major}.${minor}.${patch + 1}` : `${major}.${minor + 1}.0`;
}
