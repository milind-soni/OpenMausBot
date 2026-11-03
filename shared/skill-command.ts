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

/** Each `/name` in `text` that is one of `skills` and stands as its own word: at the start or after a space or
 * line break, and followed by a space, the end, or punctuation. In order, once each. A path such as `src/standup`
 * or a longer word such as `/standupnow` is not a call. */
export function findSkillCommands(text: string, skills: Iterable<string>): string[] {
  const known = new Set([...skills].filter(offersSkillCommand));
  const found: string[] = [];
  for (const match of text.matchAll(/(?<=^|\s)\/([a-z0-9-]+)(?=$|\s|[.,;:!?)])/g)) {
    const name = match[1]!;
    if (known.has(name) && !found.includes(name)) found.push(name);
  }
  return found;
}

/** Whether `text` has a `/` that could start a skill call, checked before the skills are listed. */
export function mayCallSkill(text: string): boolean {
  return /(?:^|\s)\//.test(text);
}

/**
 * The text the engine reads for a message that calls skills with `/name`. A message that starts with one keeps
 * the single-skill wording; skills called later in it, or anywhere in a message that starts with plain text, are
 * listed with their SKILL.md and the message follows as written. `fileOf` gives an enabled skill's SKILL.md, or
 * null. A message that calls no enabled skill comes back unchanged.
 */
export function expandSkillCommands(text: string, skills: readonly string[], fileOf: (name: string) => string | null): string {
  const command = parseSkillCommand(text, skills);
  const leadFile = command ? fileOf(command.name) : null;
  const called = findSkillCommands(command && leadFile ? command.request : text, skills)
    .filter((name) => name !== command?.name || !leadFile)
    .flatMap((name) => {
      const file = fileOf(name);
      return file ? [{ name, file }] : [];
    });
  const reads = called.map(({ name, file }) => `your ${name} skill with /${name} (read ${JSON.stringify(file)})`).join(", ");
  if (command && leadFile) {
    const lead = `The user ran your ${command.name} skill with /${command.name}. Read ${JSON.stringify(leadFile)} with your file tools and follow it for this turn.`;
    const also = called.length > 0 ? `\n\nThe request also calls ${reads}. Read each with your file tools and follow it where the request calls it.` : "";
    return command.request
      ? `${lead} Where the skill says {input}, use the request.\n\nRequest: ${command.request}${also}`
      : `${lead} There is no further request, so run it as the skill describes.`;
  }
  if (called.length === 0) return text;
  return `The user called ${reads} in their message. Read each with your file tools and follow it where the message calls it, for this turn. Where a skill says {input}, use what the message asks of it.\n\nMessage: ${text}`;
}
