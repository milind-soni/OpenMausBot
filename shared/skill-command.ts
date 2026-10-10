// `/<skill-name>` at the start of a message runs one of the bot's enabled
// skills for that turn. Like /learn and /setup it is a turn-text rewrite on
// the server: the transcript keeps the person's raw "/name …" message, and
// only the text the engine reads names the skill and its SKILL.md. Shared so
// the composer menu and the server agree on which names are commands.
import { isSkillName } from "./skill-md.ts";

/** Commands the app already owns. A skill with one of these names keeps
 * working through the prompt index, but `/name` stays the built-in. */
export const BUILT_IN_SLASH_COMMANDS: readonly string[] = ["goal", "learn", "setup"];

export interface SkillCommand {
  name: string;
  /** What followed the command, trimmed. Empty when the skill ran bare. */
  request: string;
}

/** `/name` or `/name request` where name is one of `skills`. Anything else,
 * including an engine's own slash command, is ordinary text. */
export function parseSkillCommand(text: string, skills: Iterable<string>): SkillCommand | null {
  const match = /^\/([a-z0-9-]+)(?:\s+|$)([\s\S]*)$/.exec(text.trimStart());
  if (!match) return null;
  const name = match[1]!;
  if (!isSkillName(name) || BUILT_IN_SLASH_COMMANDS.includes(name)) return null;
  for (const skill of skills) if (skill === name) return { name, request: match[2]!.trim() };
  return null;
}

/** Whether a skill can be offered as `/name` without shadowing a built-in. */
export function offersSkillCommand(name: string): boolean {
  return isSkillName(name) && !BUILT_IN_SLASH_COMMANDS.includes(name);
}
