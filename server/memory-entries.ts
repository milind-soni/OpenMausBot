// Typed memory entries over MEMORY.md — parse, render, select.
//
// The file stays plain markdown a person edits by hand and a bot edits with
// file tools. This module gives it structure without changing that: six
// known "## " headings, one entry per bullet, an optional leading marker
// "(YYYY-MM-DD, thread <id>, msg <id>, supersedes <date>, superseded <date>)".
// Anything the parser does not recognise — unknown headings, prose lines,
// fenced code, odd bullets — is kept in place, so render(parse(x)) gives x
// back and a hand-written section can never be lost.
//
// Selection is the other half: which entries ride the system prompt when
// the file is over budget. Today's cut is "the first 200 lines", which drops
// the newest note first because the bot appends. selectMemory keeps the
// profile (preferences, decisions) and takes everything else newest-first.
// It renders a labeled block, not the file — the prompt tells the model as
// much, so a model that writes the view back loses no more than it does now.

export type MemoryKind = "preference" | "decision" | "fact" | "procedure" | "episode" | "history";

/** Selection order. History is never selected. */
export const MEMORY_KINDS: readonly MemoryKind[] = ["preference", "decision", "fact", "procedure", "episode"];

/** Preferences and decisions together: the always-on profile. A cap so a
 * bot that files everything as a decision cannot starve facts. */
export const MEMORY_PROFILE_MAX_LINES = 100;

export interface MemoryEntry {
  kind: MemoryKind;
  /** bullet body without the marker; continuation lines joined with "\n" */
  text: string;
  bullet: "-" | "*" | "+";
  /** YYYY-MM-DD */
  date?: string;
  /** whole id, never truncated — a session_read argument */
  threadId?: string;
  messageId?: string;
  /** YYYY-MM-DD of the entry this one replaces */
  supersedes?: string;
  /** YYYY-MM-DD of the entry that replaced this one */
  supersededBy?: string;
}

/** Prose inside a known section, kept in place so the file round-trips. */
export interface UnknownLine {
  line: string;
}

export interface MemorySection {
  kind: MemoryKind;
  /** the heading line as written, or null for bullets before any heading */
  rawHeading: string | null;
  items: Array<MemoryEntry | UnknownLine>;
}

export interface UnknownSection {
  rawHeading: string;
  lines: string[];
}

export interface MemoryDocument {
  /** non-bullet prose before the first heading, verbatim */
  preamble: string[];
  /** file order */
  sections: Array<MemorySection | UnknownSection>;
}

const HEADING = /^##\s+(.+?)\s*$/;
const BULLET = /^([-*+])\s+(.*)$/;
const CONTINUATION = /^ {2}(.*)$/;
const FENCE = /^\s*```/;
const DATE = "\\d{4}-\\d{2}-\\d{2}";
// Fields in one fixed order so the marker renders back byte-for-byte.
const MARKER = new RegExp(
  `^\\((${DATE})(?:, thread ([^,)\\s]+))?(?:, msg ([^,)\\s]+))?(?:, supersedes (${DATE}))?(?:, superseded (${DATE}))?\\) ?`,
);

const KIND_BY_HEADING: Record<string, MemoryKind> = {
  preference: "preference",
  preferences: "preference",
  decision: "decision",
  decisions: "decision",
  fact: "fact",
  facts: "fact",
  procedure: "procedure",
  procedures: "procedure",
  episode: "episode",
  episodes: "episode",
  history: "history",
};

export function isMemoryEntry(item: MemoryEntry | UnknownLine): item is MemoryEntry {
  return "kind" in item;
}

export function isMemorySection(section: MemorySection | UnknownSection): section is MemorySection {
  return "kind" in section;
}

function parseBullet(bullet: "-" | "*" | "+", body: string, kind: MemoryKind): MemoryEntry {
  const marker = MARKER.exec(body);
  if (!marker) return { kind, text: body, bullet };
  const entry: MemoryEntry = { kind, text: body.slice(marker[0].length), bullet, date: marker[1] };
  if (marker[2]) entry.threadId = marker[2];
  if (marker[3]) entry.messageId = marker[3];
  if (marker[4]) entry.supersedes = marker[4];
  if (marker[5]) entry.supersededBy = marker[5];
  return entry;
}

export function parseMemory(markdown: string): MemoryDocument {
  const doc: MemoryDocument = { preamble: [], sections: [] };
  let current: MemorySection | UnknownSection | null = null;
  // the entry an indented line continues; reset by any other line
  let entry: MemoryEntry | null = null;
  let inFence = false;

  const container = (): MemorySection => {
    if (current && isMemorySection(current)) return current;
    // bullets before the first heading are facts, not preamble
    const implicit: MemorySection = { kind: "fact", rawHeading: null, items: [] };
    doc.sections.push(implicit);
    current = implicit;
    return implicit;
  };

  for (const line of markdown.split("\n")) {
    const fenceLine = FENCE.test(line);
    const heading = inFence || fenceLine ? null : HEADING.exec(line);
    const bullet = inFence || fenceLine ? null : BULLET.exec(line);

    if (heading) {
      const kind = KIND_BY_HEADING[heading[1].toLowerCase()];
      current = kind ? { kind, rawHeading: line, items: [] } : { rawHeading: line, lines: [] };
      doc.sections.push(current);
      entry = null;
      continue;
    }
    if (current && !isMemorySection(current)) {
      current.lines.push(line);
      if (fenceLine) inFence = !inFence;
      continue;
    }
    if (bullet && (!current || isMemorySection(current))) {
      const section = container();
      entry = parseBullet(bullet[1] as "-" | "*" | "+", bullet[2], section.kind);
      section.items.push(entry);
      continue;
    }
    const continuation = entry ? CONTINUATION.exec(line) : null;
    if (continuation && entry) {
      entry.text += `\n${continuation[1]}`;
      if (fenceLine) inFence = !inFence;
      continue;
    }
    entry = null;
    if (fenceLine) inFence = !inFence;
    if (!current) doc.preamble.push(line);
    else (current as MemorySection).items.push({ line });
  }
  return doc;
}

function renderMarker(entry: MemoryEntry): string {
  if (!entry.date) return "";
  let marker = `(${entry.date}`;
  if (entry.threadId) marker += `, thread ${entry.threadId}`;
  if (entry.messageId) marker += `, msg ${entry.messageId}`;
  if (entry.supersedes) marker += `, supersedes ${entry.supersedes}`;
  if (entry.supersededBy) marker += `, superseded ${entry.supersededBy}`;
  return `${marker}) `;
}

export function renderEntry(entry: MemoryEntry): string {
  const [first, ...rest] = entry.text.split("\n");
  const lines = [`${entry.bullet} ${renderMarker(entry)}${first ?? ""}`];
  for (const line of rest) lines.push(`  ${line}`);
  return lines.join("\n");
}

function renderSection(section: MemorySection | UnknownSection): string[] {
  if (!isMemorySection(section)) return [section.rawHeading, ...section.lines];
  const lines: string[] = [];
  if (section.rawHeading !== null) lines.push(section.rawHeading);
  for (const item of section.items) lines.push(isMemoryEntry(item) ? renderEntry(item) : item.line);
  return lines;
}

export function renderMemory(doc: MemoryDocument): string {
  return [...doc.preamble, ...doc.sections.flatMap(renderSection)].join("\n");
}

/** Every typed entry, file order. */
export function entriesOf(doc: MemoryDocument): MemoryEntry[] {
  return doc.sections.flatMap((section) => (isMemorySection(section) ? section.items.filter(isMemoryEntry) : []));
}

export interface MemoryBudget {
  maxLines: number;
  maxBytes: number;
}

export interface MemorySelection {
  /** the rendered block for the prompt */
  text: string;
  lines: number;
  bytes: number;
  /** every selectable entry made it in */
  complete: boolean;
  dropped: Partial<Record<MemoryKind | "other", number>>;
}

const KIND_HEADINGS: Record<MemoryKind, string> = {
  preference: "Preferences",
  decision: "Decisions",
  fact: "Facts",
  procedure: "Procedures",
  episode: "Episodes",
  history: "History",
};

const lineCount = (text: string) => text.split("\n").length;

/** Newest first; undated entries last, in file order. Stable. */
function newestFirst(entries: MemoryEntry[]): MemoryEntry[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      if (a.entry.date && b.entry.date) return b.entry.date.localeCompare(a.entry.date) || a.index - b.index;
      if (a.entry.date) return -1;
      if (b.entry.date) return 1;
      return a.index - b.index;
    })
    .map((item) => item.entry);
}

export function selectMemory(doc: MemoryDocument, budget: MemoryBudget): MemorySelection {
  const dropped: Partial<Record<MemoryKind | "other", number>> = {};
  const drop = (kind: MemoryKind | "other", count = 1) => {
    if (count > 0) dropped[kind] = (dropped[kind] ?? 0) + count;
  };
  const byKind = new Map<MemoryKind, MemoryEntry[]>();
  for (const entry of entriesOf(doc)) {
    if (entry.kind === "history") continue;
    byKind.set(entry.kind, [...(byKind.get(entry.kind) ?? []), entry]);
  }

  // Profile first: preferences and decisions share one cap, decisions cut
  // before preferences. Trailing blank preamble lines are noise in a prompt.
  const preamble = [...doc.preamble];
  while (preamble.length && !preamble[preamble.length - 1]!.trim()) preamble.pop();
  let used = preamble.length;
  const chosen = new Map<MemoryKind, MemoryEntry[]>();
  const take = (kind: MemoryKind, cap: number): number => {
    const entries = newestFirst(byKind.get(kind) ?? []);
    if (!entries.length) return 0;
    const picked: MemoryEntry[] = [];
    let lines = 1; // the heading
    for (const entry of entries) {
      const cost = lineCount(entry.text);
      if (lines + cost > cap) {
        drop(kind);
        continue;
      }
      picked.push(entry);
      lines += cost;
    }
    if (!picked.length) return 0;
    chosen.set(kind, picked);
    return lines;
  };
  const profileCap = Math.min(MEMORY_PROFILE_MAX_LINES, budget.maxLines - used);
  const preferenceLines = take("preference", profileCap);
  used += preferenceLines;
  used += take("decision", profileCap - preferenceLines);
  for (const kind of ["fact", "procedure", "episode"] as const) used += take(kind, budget.maxLines - used);

  // Unknown sections last, cut last, by line.
  const others: string[][] = [];
  for (const section of doc.sections) {
    if (isMemorySection(section)) continue;
    const lines = [section.rawHeading, ...section.lines];
    while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
    if (used + lines.length <= budget.maxLines) {
      others.push(lines);
      used += lines.length;
    } else drop("other", lines.length);
  }

  const complete = () => Object.keys(dropped).length === 0;
  const render = (): string => {
    const out = [...preamble];
    for (const kind of MEMORY_KINDS) {
      const picked = chosen.get(kind);
      if (!picked) continue;
      const missing = dropped[kind] ?? 0;
      const note = complete() ? "" : missing ? ` (newest first; ${missing} older not shown)` : " (newest first)";
      out.push(`## ${KIND_HEADINGS[kind]}${note}`);
      for (const entry of picked) out.push(renderEntry(entry));
    }
    for (const lines of others) out.push(...lines);
    return out.join("\n");
  };

  let text = render();
  // The byte cap comes after the line cap and cuts the rendered block from
  // its end — the least valuable end by construction.
  if (Buffer.byteLength(text, "utf8") > budget.maxBytes) {
    const lines = text.split("\n");
    let cut = 0;
    while (lines.length && Buffer.byteLength(lines.join("\n"), "utf8") > budget.maxBytes) {
      lines.pop();
      cut++;
    }
    drop("other", cut);
    text = lines.join("\n");
  }
  return { text, lines: text ? lineCount(text) : 0, bytes: Buffer.byteLength(text, "utf8"), complete: complete(), dropped };
}
