// Per-bot switches for skills the engine loads by itself (Codex ~/.codex/skills and ~/.agents/skills, Claude project
// skills, …). Off stays off across restarts; personal skill folders are never deleted.
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { importedSkillsSwitchedOff, readImportedSkills, switchImportedSkillBackOn } from "./imported-skills.ts";
import { isSkillName } from "../shared/skill-md.ts";

const choicesPath = (botId: string) => join(DATA_DIR, "skill-state", botId, "native-skills.json");
const choicesSchema = z.object({ off: z.array(z.string()) });

/** The bot's switches exist but cannot be read. Nothing can tell which skills were off, so a turn on an engine that
 * loads skills by itself does not start, and no switch is written over the file, until the person fixes or deletes it. */
export class NativeSkillChoicesUnreadable extends Error {
  constructor(path: string) {
    super(`This bot's switches for the skills its AI loads by itself can't be read (${path}). Fix or delete that file, then try again.`);
  }
}

function readChoices(botId: string): string[] {
  const path = choicesPath(botId);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new NativeSkillChoicesUnreadable(path);
  }
  try {
    const parsed = choicesSchema.safeParse(JSON.parse(text));
    if (parsed.success) return parsed.data.off.filter(isSkillName).sort();
  } catch {}
  throw new NativeSkillChoicesUnreadable(path);
}

/** Native skills this bot has off: its own switches, plus each skill from this computer it switched off, with the
 * SKILL.md it was brought in from, which an engine loading that folder would still read. Throws
 * NativeSkillChoicesUnreadable. */
export function deniedNativeSkills(botId: string): { names: string[]; origins: string[] } {
  const own = readChoices(botId);
  const imported = importedSkillsSwitchedOff(botId);
  const index = readImportedSkills();
  const origins = imported.flatMap((name) => (index[name] ? [join(index[name].origin, "SKILL.md")] : []));
  return { names: [...new Set([...own, ...imported])].sort(), origins };
}

/** Names of the native skills this bot has off. Throws NativeSkillChoicesUnreadable. */
export function disabledNativeSkillNames(botId: string): string[] {
  return deniedNativeSkills(botId).names;
}

export function isNativeSkillEnabled(botId: string, name: string): boolean {
  try {
    return !deniedNativeSkills(botId).names.includes(name);
  } catch (error) {
    if (error instanceof NativeSkillChoicesUnreadable) return false;
    throw error;
  }
}

/** Persist one bot's native-skill switch. Does not create or delete skill files. */
export function setNativeSkillEnabled(botId: string, name: string, enabled: boolean): { off: string[] } | { error: string } {
  if (!isSkillName(name)) return { error: `invalid skill name "${name}"` };
  let off: string[];
  try {
    off = readChoices(botId).filter((other) => other !== name);
  } catch (error) {
    if (error instanceof NativeSkillChoicesUnreadable) return { error: error.message };
    throw error;
  }
  const next = enabled ? off : [...off, name].sort();
  mkdirSync(dirname(choicesPath(botId)), { recursive: true, mode: 0o700 });
  writeFileAtomic(choicesPath(botId), `${JSON.stringify({ off: next }, null, 2)}\n`, { mode: 0o600 });
  if (enabled) switchImportedSkillBackOn(botId, name);
  return { off: next };
}
