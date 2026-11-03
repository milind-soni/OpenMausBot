// `/<skill-name>` at the start of a message, or after a space anywhere in it,
// runs one of the bot's enabled skills for that turn, and one message can run
// several. Like /learn and /setup it is a turn-text rewrite on the server: the
// transcript keeps the person's raw message, and only the text the engine reads
// names each skill and its SKILL.md. Shared so the composer menu and the server
// agree on which names are commands.
import { isSkillName } from "./skill-md.ts";

/** Commands the app already owns. A skill with one of these names keeps
 * working through the prompt index, but `/name` stays the built-in. */
export const BUILT_IN_SLASH_COMMANDS: readonly string[] = ["goal", "learn", "setup"];

export interface SkillCommand {
  name: string;
  /** What followed the command, trimmed. Empty when the skill ran bare. */
  request: string;
}

/** `/name` or `/name request` where name is one of `skills`; punctuation right after the name (`/name.`) ends it. Anything else,
 * including an engine's own slash command, is ordinary text. */
export function parseSkillCommand(text: string, skills: Iterable<string>): SkillCommand | null {
  const match = /^\/([a-z0-9-]+)(?:[.,;:!?)]+(?=\s|$))?(?:\s+|$)([\s\S]*)$/.exec(text.trimStart());
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

/** Each `/name` that starts the message or follows a space, in order and once each, never a built-in. A path or link
 * such as "a/b" or "https://x/y" names nothing. */
export function skillMentions(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/(?:^|\s)\/([a-z0-9-]+)(?=$|\s|[.,;:!?)]+(?:$|\s))/g)) {
    if (offersSkillCommand(match[1]!)) found.add(match[1]!);
  }
  return [...found];
}

/** What the engine reads for a message that ran skills with `/name`: which SKILL.md to read and follow, then the
 * request. `files` maps each skill the bot has to its SKILL.md; any other `/word` stays plain text. */
export function skillCommandTurnText(text: string, files: ReadonlyMap<string, string>): string {
  const names = skillMentions(text).filter((name) => files.has(name));
  if (!names.length) return text;
  const read = (name: string) => JSON.stringify(files.get(name));
  const lead = names.length === 1
    ? `The user ran your ${names[0]} skill with /${names[0]}. Read ${read(names[0]!)} with your file tools and follow it for this turn.`
    : `The user ran ${names.length} of your skills with ${names.map((name) => `/${name}`).join(", ")}. Read ` +
      `${names.map((name) => `${read(name)} for /${name}`).join(", ")} with your file tools and follow each for this turn.`;
  const leading = names.length === 1 ? parseSkillCommand(text, names) : null;
  const request = leading ? leading.request : text.trim();
  return request
    ? `${lead} Where ${names.length === 1 ? "the" : "a"} skill says {input}, use the request.\n\nRequest: ${request}`
    : `${lead} There is no further request, so run it as the skill describes.`;
}
