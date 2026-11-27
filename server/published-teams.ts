// Package keys never come from names once they exist: the first export records them and every later export reuses them.
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

export function renamePublishedTeam(name: string, nextName: string | null): void {
  const teams = load();
  const entry = teams.get(name);
  if (!entry || name === nextName) return;
  teams.delete(name);
  if (nextName !== null) teams.set(nextName, entry);
  save(teams);
}

export function nextPatchRelease(release: string | undefined): string {
  const match = release?.match(/^(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/);
  if (!match) return "1.0.0";
  const [major, minor, patch] = match.slice(1).map(Number) as [number, number, number];
  return patch < 999_999 ? `${major}.${minor}.${patch + 1}` : `${major}.${minor + 1}.0`;
}
