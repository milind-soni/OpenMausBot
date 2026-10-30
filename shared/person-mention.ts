import { isMentionBoundary, isMentionNameContinuation } from "./mention-boundary.ts";

export const PERSON_TAG = "you";

const RESERVED = new Set(["everyone", "all"]);

export function personTagNames(profileName?: string | null): string[] {
  const name = profileName?.replace(/^@+/, "").replace(/\s+/g, " ").trim() ?? "";
  const folded = name.toLowerCase();
  return name && folded !== PERSON_TAG && !RESERVED.has(folded) ? [PERSON_TAG, name] : [PERSON_TAG];
}

function tagMatches(rest: string, name: string): boolean {
  return rest.slice(0, name.length).toLowerCase() === name.toLowerCase()
    && !isMentionNameContinuation(rest.slice(name.length));
}

export function personTagAt(rest: string, personNames: readonly string[], botNames: readonly string[]): number | undefined {
  const bot = Math.max(0, ...botNames.filter((name) => name.trim() && tagMatches(rest, name)).map((name) => name.length));
  const person = Math.max(0, ...personNames.filter((name) => tagMatches(rest, name)).map((name) => name.length));
  return person > bot ? person : undefined;
}

export interface PersonTagOptions {
  profileName?: string | null;
  botNames?: readonly string[];
}

export function personMentionRanges(text: string, options: PersonTagOptions = {}): { start: number; end: number }[] {
  const personNames = personTagNames(options.profileName);
  const botNames = options.botNames ?? [];
  const ranges: { start: number; end: number }[] = [];
  let at = -1;
  while ((at = text.indexOf("@", at + 1)) !== -1) {
    if (!isMentionBoundary(text, at)) continue;
    const length = personTagAt(text.slice(at + 1), personNames, botNames);
    if (length === undefined) continue;
    ranges.push({ start: at, end: at + length + 1 });
    at += length;
  }
  return ranges;
}

/** CommonMark: a fence closes only on the same character at least as long; an unclosed fence runs to the end. */
function maskFences(text: string): string {
  let open: { char: string; length: number } | null = null;
  return text.split("\n").map((line) => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (!open) {
      if (!marker || (marker[0] === "`" && line.slice(line.indexOf(marker) + marker.length).includes("`"))) return line;
      open = { char: marker[0]!, length: marker.length };
    } else if (marker && marker[0] === open.char && marker.length >= open.length && !line.trim().slice(marker.length).trim()) {
      open = null;
    }
    return " ".repeat(line.length);
  }).join("\n");
}

/** The text with every code block and code span blanked, offsets kept. CommonMark code spans close on a backtick run
 * of the opening length and may cross line endings. */
export function proseOnly(text: string): string {
  return maskFences(text).replace(/(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g, (code) => code.replace(/[^\n]/g, " "));
}

export function personMentionExcerpt(text: string, options: PersonTagOptions = {}): string | null {
  const hit = personMentionRanges(proseOnly(text), options)[0];
  return hit ? excerptAround(text, hit) : null;
}

function excerptAround(text: string, hit: { start: number; end: number }): string {
  const lineStart = text.lastIndexOf("\n", hit.start) + 1;
  const lineEnd = text.indexOf("\n", hit.end);
  const line = text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim();
  const withoutTag = line.replace(text.slice(hit.start, hit.end), "").replace(/[\s\p{P}]+/gu, "");
  if (withoutTag.length >= 12) return line;
  const before = text.slice(0, hit.start).search(/\n\s*\n(?![\s\S]*\n\s*\n)/);
  const paraStart = before === -1 ? 0 : before;
  const after = text.slice(hit.end).search(/\n\s*\n/);
  return text.slice(paraStart, after === -1 ? undefined : hit.end + after).trim();
}

/** A teammate on a Team Cloud as a tag can name them: `key` is their person key. */
export interface MentionablePerson { key: string; names: readonly string[] }

/** Each teammate's tags: their whole name, and their first name too when no other teammate shares it. */
export function mentionablePeople(people: ReadonlyArray<{ key: string; name: string }>): MentionablePerson[] {
  const clean = (name: string) => name.replace(/^@+/, "").replace(/\s+/g, " ").trim();
  const usable = (name: string) => name.length > 0 && name.toLowerCase() !== PERSON_TAG && !RESERVED.has(name.toLowerCase());
  const first = (name: string) => clean(name).split(" ")[0] ?? "";
  const sharing = new Map<string, number>();
  for (const person of people) {
    const short = first(person.name).toLowerCase();
    sharing.set(short, (sharing.get(short) ?? 0) + 1);
  }
  return people.map((person) => {
    const whole = clean(person.name);
    const short = first(person.name);
    const names = [whole, ...(short !== whole && sharing.get(short.toLowerCase()) === 1 ? [short] : [])].filter(usable);
    return { key: person.key, names };
  }).filter((person) => person.names.length > 0);
}

/** The teammates a text tags, in prose only (never inside code), each once with the line or paragraph that tags them.
 * A bot's name of the same length or longer wins, as for the person's own tag. */
export function teammateMentions(text: string, people: readonly MentionablePerson[], botNames: readonly string[] = []): Array<{ key: string; excerpt: string }> {
  const prose = proseOnly(text);
  const found = new Map<string, string>();
  let at = -1;
  while ((at = prose.indexOf("@", at + 1)) !== -1) {
    if (!isMentionBoundary(prose, at)) continue;
    const rest = prose.slice(at + 1);
    let best: { key: string; length: number } | null = null;
    for (const person of people) {
      const length = personTagAt(rest, person.names, botNames);
      if (length !== undefined && (!best || length > best.length)) best = { key: person.key, length };
    }
    if (!best) continue;
    if (!found.has(best.key)) found.set(best.key, excerptAround(text, { start: at, end: at + best.length + 1 }));
    at += best.length;
  }
  return [...found].map(([key, excerpt]) => ({ key, excerpt }));
}
