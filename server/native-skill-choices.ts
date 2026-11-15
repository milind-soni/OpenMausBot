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

const unreadableWarned = new Set<string>();

/** A file that is there but can't be read counts as nothing switched off, so the bot keeps working with every skill;
 * the server logs it once, and the next switch writes a good file over it. */
function readChoices(botId: string): string[] {
  const path = choicesPath(botId);
  let why = "not a list of skill names";
  try {
    const parsed = choicesSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    if (parsed.success) return parsed.data.off.filter(isSkillName).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    why = (error as NodeJS.ErrnoException).code ?? why;
  }
  if (!unreadableWarned.has(path)) {
    unreadableWarned.add(path);
    console.warn(`Native skill switches at ${path} can't be read (${why}); every native skill stays on for that bot until one is switched off again.`);
  }
  return [];
}

/** Native skills this bot has off: its own switches, plus each skill from this computer it switched off, with the
 * SKILL.md it was brought in from, which an engine loading that folder would still read. */
export function deniedNativeSkills(botId: string): { names: string[]; origins: string[] } {
  const own = readChoices(botId);
  const imported = importedSkillsSwitchedOff(botId);
  const index = readImportedSkills();
  const origins = imported.flatMap((name) => (index[name] ? [join(index[name].origin, "SKILL.md")] : []));
  return { names: [...new Set([...own, ...imported])].sort(), origins };
}

/** Names of the native skills this bot has off. */
export function disabledNativeSkillNames(botId: string): string[] {
  return deniedNativeSkills(botId).names;
}

export function isNativeSkillEnabled(botId: string, name: string): boolean {
  return !deniedNativeSkills(botId).names.includes(name);
}

/** Persist one bot's native-skill switch. Does not create or delete skill files. */
export function setNativeSkillEnabled(botId: string, name: string, enabled: boolean): { off: string[] } | { error: string } {
  if (!isSkillName(name)) return { error: `invalid skill name "${name}"` };
  const off = readChoices(botId).filter((other) => other !== name);
  const next = enabled ? off : [...off, name].sort();
  mkdirSync(dirname(choicesPath(botId)), { recursive: true, mode: 0o700 });
  writeFileAtomic(choicesPath(botId), `${JSON.stringify({ off: next }, null, 2)}\n`, { mode: 0o600 });
  if (enabled) switchImportedSkillBackOn(botId, name);
  return { off: next };
}
