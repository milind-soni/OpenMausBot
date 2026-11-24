// Skills a person keeps on all of their bots on this server: one copy per person, read by each bot of theirs when it
// lists its skills, so a bot made later has them too and removing one takes it off every bot at once. The copy is kept in
// the skills library's own record format (skill-library.ts), one library root per person: the per-person form of the
// library's every-bot flag. Off a team that person is the server's one owner and every bot here is theirs; on a Team
// Cloud a member's root reaches only the bots that report to them (botOwner), never a bot nobody owns and never another
// member's. A bot can turn one off for itself only (all-bots-off.json beside its own skill state). Nothing here runs at
// server start: the store is read when a bot lists its skills, as its own skills are.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { botOwner, type OwnedBot } from "../shared/bot-owner.ts";
import { isSkillName } from "../shared/skill-md.ts";
import { librarySkillFilePath, listLibrarySkills, readLibrarySkillFile, type LibrarySkillListing } from "./skill-library.ts";

export const SKILLS_FOR_ALL_BOTS_DIR = "skills-for-all-bots";

/** A bot as far as whose it is: a stand-in (`home`) lives on another server and has its skills there. */
export type AllBotsBot = OwnedBot & { id: string; home?: unknown };

interface Wiring {
  team: boolean;
  bot(id: string): AllBotsBot | null | undefined;
  bots(): readonly AllBotsBot[];
}

let wiring: Wiring | null = null;

/** Set once by the server; unset (tests of one module, tools) there are no all-bots skills. */
export function wireSkillsForAllBots(next: Wiring | null): void {
  wiring = next;
}

export function skillsForAllBotsOnTeam(): boolean {
  return wiring?.team === true;
}

/** Whose store: "mine" off a team; on a Team Cloud the member's own, by a digest of their address. */
export function allBotsScopeOfPerson(email: string | null | undefined, team = skillsForAllBotsOnTeam()): string | null {
  if (!team) return "mine";
  const key = email?.trim().toLowerCase();
  return key ? `person-${createHash("sha256").update(key).digest("hex").slice(0, 32)}` : null;
}

/** Null for a bot that has no all-bots skills: a stand-in, or on a Team Cloud a bot nobody owns. */
export function allBotsScopeOfBot(bot: AllBotsBot | null | undefined, team = skillsForAllBotsOnTeam()): string | null {
  if (!bot || bot.home) return null;
  return team ? allBotsScopeOfPerson(botOwner(bot), true) : "mine";
}

export function allBotsRoot(scope: string, dataDir: string = DATA_DIR): string {
  return join(dataDir, SKILLS_FOR_ALL_BOTS_DIR, scope);
}

/** The bots a store reaches: every bot of that person here, the ones made later included. */
export function botsInAllBotsScope(scope: string): AllBotsBot[] {
  const team = skillsForAllBotsOnTeam();
  return (wiring?.bots() ?? []).filter((bot) => allBotsScopeOfBot(bot, team) === scope);
}

export function allBotsRootOfBot(botId: string): string | null {
  const scope = allBotsScopeOfBot(wiring?.bot(botId));
  return scope ? allBotsRoot(scope) : null;
}

export interface AllBotsSkillListing {
  name: string;
  description: string;
  enabled: boolean;
  editable: false;
  source: string;
  sha256: string;
  importedAt: string;
  warnings: string[];
  skippedFiles: string[];
  files?: string[];
  /** On all of the person's bots; `enabled` false here is this bot's own switch, or a copy that no longer verifies. */
  allBots: true;
}

function listing(skill: LibrarySkillListing, off: ReadonlySet<string>): AllBotsSkillListing {
  return {
    name: skill.name, description: skill.description, enabled: skill.enabled && !off.has(skill.name), editable: false,
    source: skill.source, sha256: skill.sha256, importedAt: skill.importedAt, warnings: skill.warnings, skippedFiles: skill.skippedFiles,
    ...(skill.files ? { files: skill.files } : {}), allBots: true,
  };
}

/** The person's all-bots skills as this bot has them. */
export function allBotsSkills(botId: string): AllBotsSkillListing[] {
  const root = allBotsRootOfBot(botId);
  if (!root) return [];
  const off = allBotsSkillOffs(botId);
  return listLibrarySkills(root).map((skill) => listing(skill, off));
}

/** The SKILL.md path the bot's index points at, when the person has a skill of this name on all their bots. */
export function allBotsSkillFile(botId: string, name: string): string | null {
  const root = allBotsRootOfBot(botId);
  return root && isSkillName(name) && listLibrarySkills(root).some((skill) => skill.name === name) ? librarySkillFilePath(name, root) : null;
}

/** Its SKILL.md while it still hashes as stored; null when there is none or it changed outside OpenMausBot. */
export function readAllBotsSkillFile(botId: string, name: string): string | null {
  const root = allBotsRootOfBot(botId);
  return root ? readLibrarySkillFile(name, root) : null;
}

const offSchema = z.array(z.string());

function offPath(botId: string): string | null {
  return /^[\w-]+$/.test(botId) ? join(DATA_DIR, "skill-state", botId, "all-bots-off.json") : null;
}

/** The all-bots skills this one bot has switched off. A list that cannot be read counts as none: every one stays on. */
export function allBotsSkillOffs(botId: string): ReadonlySet<string> {
  const path = offPath(botId);
  if (!path) return new Set();
  try {
    const parsed = offSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return new Set(parsed.success ? parsed.data.filter(isSkillName) : []);
  } catch {
    return new Set();
  }
}

export function setAllBotsSkillOff(botId: string, name: string, off: boolean): void {
  const path = offPath(botId);
  if (!path || !isSkillName(name)) return;
  const names = new Set(allBotsSkillOffs(botId));
  if (names.has(name) === off) return;
  if (off) names.add(name);
  else names.delete(name);
  mkdirSync(join(DATA_DIR, "skill-state", botId), { recursive: true, mode: 0o700 });
  writeFileAtomic(path, `${JSON.stringify([...names].sort(), null, 2)}\n`, { mode: 0o600 });
}
