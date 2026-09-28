// The topic index: one line per memory/<topic>.md, so a bot knows what its
// longer notes cover without a pointer in MEMORY.md. A topic may begin with
// YAML frontmatter (`title`, `description`, `aliases`); aliases are the other
// words someone might search with, which matters because every lookup here
// is word matching, not meaning. Only the head of each file is read.
import { closeSync, openSync, readSync } from "node:fs";

/** How much of a topic file is read to find its frontmatter. */
const HEAD_BYTES = 2_048;
export const TOPIC_INDEX_MAX_TOPICS = 40;
export const TOPIC_INDEX_MAX_CHARS = 2_000;

export interface TopicHeader {
  title?: string;
  description?: string;
  aliases: string[];
}

function unquote(value: string): string {
  const v = value.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1).trim();
  return v;
}

/** The frontmatter fields the index uses. Anything else, or no frontmatter,
 * reads as an empty header — a hand-written topic is still listed by name. */
export function parseTopicHeader(text: string): TopicHeader {
  const header: TopicHeader = { aliases: [] };
  // People write a "# Title" first and the block under it (the panel's own
  // new-topic text used to), so a heading and blank lines may come before the
  // block; the heading is the title when the block names none.
  const lead = /^(?:\s*\r?\n|#{1,6}[ \t]+[^\r\n]*\r?\n)*/.exec(text)?.[0] ?? "";
  const heading = /^#{1,6}[ \t]+([^\r\n]+)/m.exec(lead)?.[1]?.trim();
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text.slice(lead.length));
  if (!m) {
    if (heading) header.title = heading.slice(0, 160);
    return header;
  }
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const field = /^(title|description|aliases|tags)\s*:\s*(.*)$/.exec(lines[i]);
    if (!field) continue;
    const [, key, value] = field;
    if (key === "title" || key === "description") {
      if (value.trim()) header[key] = unquote(value).slice(0, 160);
      continue;
    }
    // aliases (and tags, which people use the same way): [a, b] or a list below
    const items: string[] = [];
    if (value.trim().startsWith("[")) {
      items.push(...value.trim().replace(/^\[|\]$/g, "").split(","));
    } else if (value.trim()) {
      items.push(...value.split(","));
    } else {
      while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) items.push(lines[(i += 1)].replace(/^\s*-\s+/, ""));
    }
    for (const item of items.map(unquote).filter(Boolean)) {
      if (!header.aliases.includes(item)) header.aliases.push(item.slice(0, 40));
    }
  }
  header.aliases = header.aliases.slice(0, 12);
  if (!header.title && heading) header.title = heading.slice(0, 160);
  return header;
}

/** The words a topic answers to: its file name, title, description and
 * aliases, lower-cased, for matching a message against without a search. */
export function topicWords(name: string, header: TopicHeader): string[] {
  const text = [name.replace(/\.md$/i, "").replace(/[-_.]+/g, " "), header.title ?? "", header.description ?? "", ...header.aliases].join(" ");
  return [...new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 3))];
}

/** A topic's text without its header block, for a recalled passage. */
export function topicBody(text: string): string {
  const lead = /^(?:\s*\r?\n|#{1,6}[ \t]+[^\r\n]*\r?\n)*/.exec(text)?.[0] ?? "";
  const rest = text.slice(lead.length).replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
  return rest.trim();
}

export function readTopicHead(path: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(HEAD_BYTES);
    const read = readSync(fd, buffer, 0, HEAD_BYTES, 0);
    return buffer.subarray(0, read).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** One line per topic, capped by count and length. The archive the tidy-up
 * keeps is listed last and labelled, so it is not mistaken for current notes. */
export function renderTopicIndex(topics: ReadonlyArray<{ name: string; header: TopicHeader }>): string {
  if (!topics.length) return "";
  const ordered = [...topics].sort((a, b) => Number(a.name === "archive.md") - Number(b.name === "archive.md") || a.name.localeCompare(b.name));
  const lines: string[] = [];
  let length = 0;
  let omitted = 0;
  for (const { name, header } of ordered) {
    if (lines.length >= TOPIC_INDEX_MAX_TOPICS) {
      omitted += 1;
      continue;
    }
    const about = name === "archive.md" && !header.title && !header.description
      ? "expired and replaced notes, kept for the record"
      : [header.title, header.description].filter(Boolean).join(" — ");
    const also = header.aliases.length ? ` (also: ${header.aliases.join(", ")})` : "";
    const line = `- memory/${name}${about ? ` — ${about}` : ""}${also}`.replace(/\s+/g, " ");
    if (length + line.length + 1 > TOPIC_INDEX_MAX_CHARS) {
      omitted += 1;
      continue;
    }
    lines.push(line);
    length += line.length + 1;
  }
  if (omitted) lines.push(`- …and ${omitted} more in memory/`);
  return lines.join("\n");
}

const LEAD = /^(?:\s*\r?\n|#{1,6}[ \t]+[^\r\n]*\r?\n)*/;
const HEADER_BLOCK = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

function aliasList(aliases: readonly string[]): string {
  return `[${aliases.join(", ")}]`;
}

/** A topic file with new entry lines appended and new aliases merged into its
 * header — created, header first, when it does not exist yet. The header is
 * what the topic index and recall read, so a topic the bot files for itself
 * is found by the other words it was given. */
export function mergeTopicText(existing: string | null, input: { title: string; aliases: readonly string[]; lines: readonly string[] }): string {
  const lines = input.lines.join("\n");
  if (existing === null || !existing.trim()) {
    const aliases = [...new Set(input.aliases)].slice(0, 12);
    return `---\ntitle: ${input.title}\n${aliases.length ? `aliases: ${aliasList(aliases)}\n` : ""}---\n\n${lines}\n`;
  }
  const lead = LEAD.exec(existing)?.[0] ?? "";
  const rest = existing.slice(lead.length);
  const block = HEADER_BLOCK.exec(rest);
  let text: string;
  if (!block) {
    const aliases = [...new Set(input.aliases)].slice(0, 12);
    text = `---\ntitle: ${parseTopicHeader(existing).title ?? input.title}\n${aliases.length ? `aliases: ${aliasList(aliases)}\n` : ""}---\n\n${existing}`;
  } else {
    const known = parseTopicHeader(existing).aliases;
    const lower = new Set(known.map((alias) => alias.toLowerCase()));
    const added = input.aliases.filter((alias) => !lower.has(alias.toLowerCase()));
    if (!added.length) text = existing;
    else {
      const merged = [...known, ...added].slice(0, 12);
      const body = block[1].split(/\r?\n/);
      const at = body.findIndex((line) => /^aliases\s*:/.test(line));
      if (at === -1) body.push(`aliases: ${aliasList(merged)}`);
      else {
        // a multi-line list under aliases: is replaced by the one-line form
        let end = at + 1;
        while (end < body.length && /^\s*-\s+/.test(body[end]!)) end += 1;
        body.splice(at, end - at, `aliases: ${aliasList(merged)}`);
      }
      text = `${lead}---\n${body.join("\n")}\n---\n${rest.slice(block[0].length)}`;
    }
  }
  return `${text}${text.endsWith("\n") ? "" : "\n"}${lines}\n`;
}
