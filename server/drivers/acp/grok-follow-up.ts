// The one setting of Grok's config.toml the driver reads, `ui.follow_up_behavior`, read the way TOML spells it: bare or quoted
// keys, `[ui]` or dotted `ui.follow_up_behavior` or an inline `ui = { ... }`, basic or literal strings, comments after a value
// or a header. A line this reader cannot place ends the scan as "unclear", and the driver never writes then.

export interface GrokFollowUp {
  /** The key is set somewhere, whatever its value's type. */
  present: boolean;
  /** Its string value. */
  value?: string;
  /** Where a line goes to land inside an existing `[ui]` table: the end of its header line. */
  insertAt?: number;
  /** `ui` is defined by dotted keys or an inline table, so a `[ui]` table cannot be added. */
  uiElsewhere: boolean;
  /** The scan met something it cannot place. */
  unclear: boolean;
}

const BARE = "[A-Za-z0-9_-]+";
const KEY = `(?:${BARE}|"(?:[^"\\\\]|\\\\.)*"|'[^']*')`;
const PATH = `${KEY}(?:\\s*\\.\\s*${KEY})*`;
const HEADER = new RegExp(`^\\s*(\\[\\[?)\\s*(${PATH})\\s*\\]\\]?\\s*(?:#.*)?$`);
const ASSIGN = new RegExp(`^\\s*(${PATH})\\s*=\\s*(.*)$`);
const INLINE_KEY = /(?:^|[{,])\s*(?:follow_up_behavior|"follow_up_behavior"|'follow_up_behavior')\s*=\s*(.*)$/;

const unescape = (text: string) => text.replace(/\\(.)/g, "$1");
const unquote = (key: string) => key.startsWith('"') ? unescape(key.slice(1, -1)) : key.startsWith("'") ? key.slice(1, -1) : key;
const keyPath = (path: string): string[] => (path.match(new RegExp(KEY, "g")) ?? []).map(unquote);
const same = (a: string[], b: string[]) => a.length === b.length && a.every((part, i) => part === b[i]);

function basicStringEnd(text: string, open: number): number {
  for (let i = open + 1; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === '"') return i;
  }
  return -1;
}

/** A string value at the start of `text`, or undefined when it is another kind of value or does not close on this line. */
function stringValue(text: string): string | undefined {
  if (text[0] === "'") { const end = text.indexOf("'", 1); return end > 0 ? text.slice(1, end) : undefined; }
  if (text[0] !== '"') return undefined;
  const end = basicStringEnd(text, 0);
  return end > 0 ? unescape(text.slice(1, end)) : undefined;
}

/** `text` without a trailing `#` comment; a `#` inside a string is kept. */
function withoutComment(text: string): string {
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "#") return text.slice(0, i);
    if (c === '"' || c === "'") {
      const close = c === '"' ? basicStringEnd(text, i) : text.indexOf("'", i + 1);
      if (close < 0) return text;
      i = close;
    }
  }
  return text;
}

/** How many brackets and braces a value without comments leaves open, ignoring strings. */
function openDepth(text: string): number {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'") {
      const close = c === '"' ? basicStringEnd(text, i) : text.indexOf("'", i + 1);
      if (close < 0) return depth;
      i = close;
    } else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") depth--;
  }
  return depth;
}

export function readGrokFollowUp(text: string): GrokFollowUp {
  const result: GrokFollowUp = { present: false, uiElsewhere: false, unclear: false };
  const lines = text.split("\n");
  const ends: number[] = [];
  let at = 0;
  for (const raw of lines) { at += raw.length + 1; ends.push(Math.min(at, text.length)); }
  let table: string[] | null = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, "");
    if (/^\s*(#.*)?$/.test(line)) continue;
    const header = HEADER.exec(line);
    if (header) {
      const path = keyPath(header[2]);
      table = header[1] === "[[" ? null : path;
      if (header[1] === "[[" && same(path, ["ui"])) result.uiElsewhere = true;
      if (table && same(table, ["ui"]) && result.insertAt === undefined) result.insertAt = ends[i];
      continue;
    }
    const assign = ASSIGN.exec(line);
    if (!assign) { result.unclear = true; return result; }
    let rest = withoutComment(assign[2]).trim();
    if (rest.startsWith('"""') || rest.startsWith("'''")) { result.unclear = true; return result; }
    while (openDepth(rest) > 0 && i + 1 < lines.length) rest += " " + withoutComment(lines[++i].replace(/\r$/, "")).trim();
    if (table === null) continue;
    const path = [...table, ...keyPath(assign[1])];
    if (same(path, ["ui", "follow_up_behavior"])) {
      result.present = true;
      result.value = stringValue(rest);
      if (table.length === 0) result.uiElsewhere = true;
    } else if (same(path, ["ui"])) {
      result.uiElsewhere = true;
      const inner = rest.startsWith("{") ? INLINE_KEY.exec(rest) : null;
      if (inner) { result.present = true; result.value = stringValue(inner[1].trim()); }
    } else if (path[0] === "ui" && table.length === 0 && path.length > 1) {
      result.uiElsewhere = true;
    }
  }
  return result;
}
