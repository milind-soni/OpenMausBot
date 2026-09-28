// The entry grammar of MEMORY.md, read back: one dated line per fact,
// `- YYYY-MM-DD · from <source> · text[ · until YYYY-MM-DD]`, with a
// struck-through body for a superseded fact. Pure helpers shared by the
// prompt loader (which hides expired lines), background capture (which
// must not add a fact the notebook already holds) and the nightly tidy-up.

export const UNTIL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATED = /^(- (\d{4}-\d{2}-\d{2}) · (?:from [^·\n]* · )?)(.*)$/;
const UNTIL_MARK = / · until (\d{4}-\d{2}-\d{2})(?= · |$)/;
const TRAILING_MARKS = /(?: · (?:updated|confirmed|until|expired|superseded) \d{4}-\d{2}-\d{2})+$/;
const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+/;

export interface MemoryEntryLine {
  /** Zero-based line number in the file. */
  line: number;
  raw: string;
  /** `- 2026-09-25 · from chat "X" · ` */
  prefix: string;
  /** The fact alone: no prefix, no trailing date marks, no strike-through. */
  body: string;
  date: string;
  until: string | null;
  struck: boolean;
}

/** Whether `value` is a real calendar date in YYYY-MM-DD form. */
export function isMemoryDate(value: unknown): value is string {
  if (typeof value !== "string" || !UNTIL_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function untilMark(until: string | undefined): string {
  return until ? ` · until ${until}` : "";
}

/** Every dated entry in a MEMORY.md text, in file order. Hand-written lines
 * without a date are not entries and are never touched by upkeep. */
export function parseMemoryEntries(text: string): MemoryEntryLine[] {
  const out: MemoryEntryLine[] = [];
  text.split("\n").forEach((raw, line) => {
    const m = DATED.exec(raw);
    if (!m) return;
    const rest = m[3];
    const struck = rest.startsWith("~~");
    const until = UNTIL_MARK.exec(rest)?.[1] ?? null;
    const body = rest.replace(TRAILING_MARKS, "").replace(/^~~/, "").replace(/~~$/, "").trim();
    out.push({ line, raw, prefix: m[1], body, date: m[2], until, struck });
  });
  return out;
}

/** A live entry whose `until` day has passed. The until day itself still counts. */
export function isExpired(entry: Pick<MemoryEntryLine, "until" | "struck">, today: string): boolean {
  return !entry.struck && entry.until !== null && entry.until < today;
}

/** MEMORY.md with expired live entries left out: what a turn should see.
 * The file is untouched; the tidy-up moves them to the archive. */
export function withoutExpired(text: string, today: string): { text: string; hidden: number } {
  const expired = new Set(parseMemoryEntries(text).filter((e) => isExpired(e, today)).map((e) => e.line));
  if (!expired.size) return { text, hidden: 0 };
  return { text: text.split("\n").filter((_, index) => !expired.has(index)).join("\n"), hidden: expired.size };
}

/** The identity of a fact, for "is this already written down". Deliberately
 * narrow: whitespace collapses, a bullet marker and one trailing full stop
 * drop, and nothing else changes — `Balance is -10` and `Balance is 10`,
 * `C++` and `C`, `1.5` and `15`, `/tmp/a` and `/tmp/b`, `API_KEY` and
 * `api_key` stay different facts. A near-duplicate is left for a person
 * (or the contradiction pass) to judge; losing a distinct fact is worse
 * than keeping two phrasings of one. */
export function factIdentity(text: string): string {
  return text
    .normalize("NFC")
    .replace(BULLET, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.$/, "")
    .trim();
}

/** The body of a line as it would be compared: the grammar's prefix and
 * marks stripped when it is an entry, the bullet stripped otherwise. */
export function lineFactIdentity(line: string): string {
  const entry = parseMemoryEntries(line)[0];
  if (entry) return entry.struck ? "" : factIdentity(entry.body);
  return factIdentity(line.replace(/~~/g, ""));
}

/** Every live fact identity in a notebook, for dedupe against it. */
export function notebookIdentities(text: string): Set<string> {
  return new Set(text.split("\n").map(lineFactIdentity).filter(Boolean));
}
