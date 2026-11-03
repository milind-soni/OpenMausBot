// `/<skill-name>` runs one of the bot's enabled skills for that turn: at the very
// start of a message, or at the start of a later line of what a person typed
// themselves. Like /learn and /setup it is a turn-text rewrite on the server: the
// transcript keeps the raw message, and only the text the engine reads names the
// skill and its SKILL.md. Shared so the composer menu and the server agree on which
// names are commands.
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

const hideCode = (code: string): string => code.replace(/[^\n]/g, "\0");
const FENCE = /^ {0,3}(`{3,}|~{3,})([^\r]*)/;

/** A backtick run closes at the next run of its own length in the same paragraph. Paired from the far end, so that a person's
 * long message of odd runs cannot stall the server, which reads it on the turn path. */
function hideInlineCode(text: string): string {
  const tokens = [...text.matchAll(/`+|\n[ \t]*(?=\n)/g)];
  const closers = new Map<number, number>();
  const nextOfLength = new Map<number, number>();
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index]![0];
    if (token[0] !== "`") { nextOfLength.clear(); continue; }
    const closer = nextOfLength.get(token.length);
    if (closer !== undefined) closers.set(index, closer);
    nextOfLength.set(token.length, index);
  }
  let out = "";
  let at = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const closer = closers.get(index);
    if (closer === undefined) continue;
    const start = tokens[index]!.index;
    const end = tokens[closer]!.index + tokens[closer]![0].length;
    out += text.slice(at, start) + hideCode(text.slice(start, end));
    at = end;
    index = closer;
  }
  return out + text.slice(at);
}

/** `text` with fenced blocks and inline code blanked out, every offset kept. An unclosed fence runs to the end, as it
 * renders, and inline code ends with its paragraph. */
export function blankCode(text: string): string {
  let fence = "";
  return hideInlineCode(text.split("\n").map((line) => {
    const [, run = "", rest = ""] = FENCE.exec(line) ?? [];
    if (fence) {
      if (run[0] === fence[0] && run.length >= fence.length && !rest.trim()) fence = "";
      return hideCode(line);
    }
    if (!run || (run[0] === "`" && rest.includes("`"))) return line;
    fence = run;
    return hideCode(line);
  }).join("\n"));
}

/** A `/name` opening a line, at most three spaces in (four is an indented code block). Punctuation may end it only when
 * whitespace or the end follows, so `/standup.` is a call and `/standup.txt` is not. */
const LINE_CALL = /^ {0,3}\/([a-z0-9-]+)(?=[.,;:!?)]*(?:\s|$))/gm;

/** Each of `skills` that `text` calls at the start of a line, outside code. In order, once each. */
export function findSkillCommands(text: string, skills: Iterable<string>): string[] {
  const known = new Set([...skills].filter(offersSkillCommand));
  const found: string[] = [];
  for (const match of blankCode(text).matchAll(LINE_CALL)) {
    const name = match[1]!;
    if (known.has(name) && !found.includes(name)) found.push(name);
  }
  return found;
}

/** Whether a turn could call a skill at all, checked before the skills are listed. */
export function mayCallSkill(text: string, typed: string): boolean {
  return text.trimStart().startsWith("/") || /^ {0,3}\//m.test(typed);
}

/**
 * The text the engine reads for a turn that calls skills with `/name`. `text` is all the engine would read, and its very
 * start can call one skill whoever wrote it, which is why every other kind of turn opens with a note saying who it is
 * from. `typed` holds only the words a person wrote themselves: the one place a later line can call a skill. Those are
 * listed with their SKILL.md and the message follows as written. `fileOf` gives a skill's SKILL.md, or null. A turn that
 * calls no skill comes back unchanged.
 */
export function expandSkillCommands(text: string, skills: readonly string[], fileOf: (name: string) => string | null, typed = ""): string {
  const command = parseSkillCommand(text, skills);
  const leadFile = command ? fileOf(command.name) : null;
  const called = findSkillCommands(typed, skills)
    .filter((name) => !leadFile || name !== command?.name)
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
