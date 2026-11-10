// `/<skill-name>` runs one of the bot's enabled skills for that turn, and one
// message can run several. The very start of a turn's text can call one, whoever
// wrote it; past that, only words a person typed themselves can, and code never
// does. Like /learn and /setup it is a turn-text rewrite on the server: the
// transcript keeps the raw message, and only the text the engine reads names each
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

const LEADING_COMMAND = /^\/([a-z0-9-]+)(?:[.,;:!?)]+(?=\s|$))?(?:\s+|$)([\s\S]*)$/;

/** `/name` or `/name request` where name is one of `skills`; punctuation right after the name (`/name.`) ends it. Anything else,
 * including an engine's own slash command, is ordinary text. */
export function parseSkillCommand(text: string, skills: Iterable<string>): SkillCommand | null {
  const match = LEADING_COMMAND.exec(text.trimStart());
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

/** `text` with fenced blocks, indented blocks and inline code blanked out, every offset kept. An unclosed fence runs to
 * the end, as it renders, and inline code ends with its paragraph. */
export function blankCode(text: string): string {
  let fence = "";
  return hideInlineCode(text.split("\n").map((line) => {
    const [, run = "", rest = ""] = FENCE.exec(line) ?? [];
    if (fence) {
      if (run[0] === fence[0] && run.length >= fence.length && !rest.trim()) fence = "";
      return hideCode(line);
    }
    if (!run || (run[0] === "`" && rest.includes("`"))) return /^(?: {4}|\t)/.test(line) ? hideCode(line) : line;
    fence = run;
    return hideCode(line);
  }).join("\n"));
}

/** Where a typed `/name` counts: the start of the text or after a space, ended by the end, a space, or punctuation with
 * one of those after it. */
const SKILL_CALL = /(?:^|\s)\/([a-z0-9-]+)(?=$|\s|[.,;:!?)]+(?:$|\s))/g;

/** Each `/name` in `text` outside code, in order and once each, never a built-in. A path or link such as "a/b" or
 * "https://x/y" names nothing. */
export function skillMentions(text: string): string[] {
  const found = new Set<string>();
  for (const match of blankCode(text).matchAll(SKILL_CALL)) {
    if (offersSkillCommand(match[1]!)) found.add(match[1]!);
  }
  return [...found];
}

/**
 * The skills a turn calls. Security invariant: `typed` holds only words a person wrote themselves, and it is the one place
 * past the very start of the text that can call a skill. A webhook's payload and another bot's message reach the engine
 * after a note saying who they are from. `ownStart`: whether the start of `text` is the person's own line or the owner's
 * routine; a relayed, outside or bot-written start names no skill.
 */
export function skillCalls(text: string, typed: string, ownStart = false): string[] {
  const leading = ownStart ? LEADING_COMMAND.exec(text.trimStart())?.[1] : undefined;
  return [...new Set([...(leading && offersSkillCommand(leading) ? [leading] : []), ...skillMentions(typed)])];
}

/** What the engine reads for a message that ran skills with `/name`: which SKILL.md to read and follow, then the
 * request. `files` maps each skill the bot has to its SKILL.md; any other `/word` stays plain text. */
export function skillCommandTurnText(text: string, files: ReadonlyMap<string, string>, typed = "", ownStart = false): string {
  const names = skillCalls(text, typed, ownStart).filter((name) => files.has(name));
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
