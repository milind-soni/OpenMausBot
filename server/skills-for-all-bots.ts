// Skills a person keeps on all of their bots on this server. The person's record is the source of truth: one copy per
// person, kept in the skills library's own record format (skill-library.ts) under a root of its own, the per-person form
// of the library's every-bot flag. Each bot of theirs holds a managed copy of it among its own skills, marked as shared,
// so everything that reads a bot's own skills (its prompt index, its engine's skill folders, a bot box, a move, a
// template) reads it with no new path. A bot's copy is brought up to date as its skills are listed, so a bot made later
// gets it, an update rewrites it and a removal takes it away; the bot's own switch for it stays its own.
// Whose bots: off a team, every bot on the server; on a Team Cloud only the bots that report to the member (botOwner),
// never a bot nobody owns and never another member's. A server several people share without a team has none.
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { botOwner, type OwnedBot } from "../shared/bot-owner.ts";
import { readLibrarySkillFile, readSkillLibraryIndex, type SkillLibraryEntry } from "./skill-library.ts";
import type { SharedSkillMark } from "./skills.ts";

export const SKILLS_FOR_ALL_BOTS_DIR = "skills-for-all-bots";

/** A bot as far as whose it is: a stand-in (`home`) lives on another server and has its skills there. */
export type AllBotsBot = OwnedBot & { id: string; home?: unknown };

interface Wiring {
  team: boolean;
  /** Several people sign in to this server without it being a Team Cloud: nobody's "all my bots" is known here. */
  sharedWithoutTeam?(): boolean;
  bot(id: string): AllBotsBot | null | undefined;
  bots(): readonly AllBotsBot[];
}

let wiring: Wiring | null = null;

/** Set once by the server; unset (tests of one module, tools) there are no all-bots skills. */
export function wireSkillsForAllBots(next: Wiring | null): void {
  wiring = next;
  stores.clear();
}

export function skillsForAllBotsOnTeam(): boolean {
  return wiring?.team === true;
}

export const SHARED_WITHOUT_TEAM = "Several people use this server without it being a Team Cloud, so \"all my bots\" is not available here.";

export function allBotsUnavailable(): boolean {
  return !wiring || (!wiring.team && wiring.sharedWithoutTeam?.() === true);
}

/** Whose store: "mine" off a team; on a Team Cloud the member's own, by a digest of their address. */
export function allBotsScopeOfPerson(email: string | null | undefined, team = skillsForAllBotsOnTeam()): string | null {
  if (!team) return "mine";
  const key = email?.trim().toLowerCase();
  return key ? `person-${createHash("sha256").update(key).digest("hex").slice(0, 32)}` : null;
}

/** Null for a bot that has no all-bots skills: a stand-in, on a Team Cloud a bot nobody owns, or any bot of a server
 * several people share without a team. */
export function allBotsScopeOfBot(bot: AllBotsBot | null | undefined, team = skillsForAllBotsOnTeam()): string | null {
  if (!bot || bot.home || allBotsUnavailable()) return null;
  return team ? allBotsScopeOfPerson(botOwner(bot), true) : "mine";
}

export function allBotsRoot(scope: string, dataDir: string = DATA_DIR): string {
  return join(dataDir, SKILLS_FOR_ALL_BOTS_DIR, scope);
}

/** The bots a store reaches: every bot of that person here, the ones made later included. */
export function botsInAllBotsScope(scope: string): AllBotsBot[] {
  return (wiring?.bots() ?? []).filter((bot) => allBotsScopeOfBot(bot) === scope);
}

/** What a bot's copy is checked against: the store's SKILL.md and the files beside it. */
export const entryKey = (entry: Pick<SkillLibraryEntry, "sha256" | "filesSha256">): string => `${entry.sha256}:${entry.filesSha256 ?? ""}`;

const idSchema = z.object({ id: z.string().regex(/^[a-f0-9-]{36}$/) });
interface StoreState { id: string | null; entries: Record<string, SkillLibraryEntry> }
/** Each store as last read, so a person with no all-bots skills costs a listing no file reads; dropped on every write. */
const stores = new Map<string, StoreState>();

export function allBotsStore(scope: string): StoreState {
  let state = stores.get(scope);
  if (!state) {
    let id: string | null = null;
    try {
      const parsed = idSchema.safeParse(JSON.parse(readFileSync(join(allBotsRoot(scope), "store.json"), "utf8")));
      if (parsed.success) id = parsed.data.id;
    } catch {}
    state = { id, entries: id ? readSkillLibraryIndex(allBotsRoot(scope)) : {} };
    stores.set(scope, state);
  }
  return state;
}

/** The store's id, made on its first write: a bot's copy names it, so a copy that came from another server's store (a
 * moved bot) is that bot's own skill here, never taken away for being missing from this store. */
export function ensureAllBotsStore(scope: string): string {
  const current = allBotsStore(scope).id;
  if (current) return current;
  const id = randomUUID();
  mkdirSync(allBotsRoot(scope), { recursive: true, mode: 0o700 });
  writeFileAtomic(join(allBotsRoot(scope), "store.json"), `${JSON.stringify({ id })}\n`, { mode: 0o600 });
  stores.delete(scope);
  return id;
}

export function forgetAllBotsStore(scope: string): void {
  stores.delete(scope);
}

/** Whether a bot's copy belongs to the store of the bot's person here. A listing brings copies up to date first, so a
 * current copy is of a skill the store still has. */
export function sharedMarkCurrent(botId: string, mark: SharedSkillMark): boolean {
  const scope = allBotsScopeOfBot(wiring?.bot(botId));
  return Boolean(scope && allBotsStore(scope).id === mark.store);
}

/** The store's SKILL.md while it still hashes as stored. */
export function readAllBotsSkill(scope: string, name: string): string | null {
  return readLibrarySkillFile(name, allBotsRoot(scope));
}
