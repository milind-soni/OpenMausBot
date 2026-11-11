// Per-bot switches for skills the engine loads by itself (Codex ~/.codex/skills, Claude project
// skills, …). Off stays off across restarts; personal skill folders are never deleted.
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { isSkillName } from "../shared/skill-md.ts";

const choicesPath = (botId: string) => join(DATA_DIR, "skill-state", botId, "native-skills.json");
const choicesSchema = z.object({ off: z.array(z.string()) });

function readChoices(botId: string): { off: string[] } {
  try {
    const parsed = choicesSchema.safeParse(JSON.parse(readFileSync(choicesPath(botId), "utf8")));
    if (parsed.success) {
      return { off: parsed.data.off.filter(isSkillName).sort() };
    }
  } catch { /* missing or unreadable → every native skill stays on */ }
  return { off: [] };
}

function writeChoices(botId: string, off: string[]): void {
  mkdirSync(dirname(choicesPath(botId)), { recursive: true, mode: 0o700 });
  writeFileAtomic(choicesPath(botId), `${JSON.stringify({ off }, null, 2)}\n`, { mode: 0o600 });
}

/** Names this bot has switched off; sorted, skill-name filtered. */
export function disabledNativeSkillNames(botId: string): string[] {
  return readChoices(botId).off;
}

export function isNativeSkillEnabled(botId: string, name: string): boolean {
  return !readChoices(botId).off.includes(name);
}

/** Persist one bot's native-skill switch. Does not create or delete skill files. */
export function setNativeSkillEnabled(botId: string, name: string, enabled: boolean): { off: string[] } | { error: string } {
  if (!isSkillName(name)) return { error: `invalid skill name "${name}"` };
  const off = readChoices(botId).off.filter((other) => other !== name);
  const next = enabled ? off : [...off, name].sort();
  writeChoices(botId, next);
  return { off: next };
}
