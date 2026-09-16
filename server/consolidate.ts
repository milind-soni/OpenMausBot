// Phase 4 part 2 — freshness and consolidation of a bot's notebook.
//
// Captured facts are the first to go stale. This module reads the notebook
// (MEMORY.md, the grammar of #1040 and Phase 1 part 2), stamps a line
// "confirmed" when it is restated, and plans one bounded pass: exact
// duplicates merge onto the newest, contradictions found by one strict-JSON
// call are struck with a trace (never deleted), stale low-importance lines
// move to an archive file, and never more than a share of the entries
// change in one pass. Pure: the caller reads, calls the model, writes and
// journals.

export interface NotebookEntry {
  /** Zero-based line number in the file. */
  line: number;
  raw: string;
  prefix: string;
  body: string;
  date: string;
  importance: number;
  struck: boolean;
  confirmed: string | null;
}

const DATED = /^(- (\d{4}-\d{2}-\d{2}) · (?:from [^·\n]* · )?(?:importance ([1-5]) · )?)(.*)$/;
const CONFIRMED = / · confirmed (\d{4}-\d{2}-\d{2})$/;
const UPDATED = / · updated \d{4}-\d{2}-\d{2}$/;
export const DEFAULT_STALE_DAYS = 90;
export const DEFAULT_FLOOR_SHARE = 0.2;

export function confirmedDate(line: string): string | null {
  return CONFIRMED.exec(line)?.[1] ?? null;
}

export function stampConfirmed(line: string, today: string): string {
  return `${line.replace(CONFIRMED, "")} · confirmed ${today}`;
}

export function parseNotebook(text: string): NotebookEntry[] {
  const entries: NotebookEntry[] = [];
  text.split("\n").forEach((raw, line) => {
    const m = DATED.exec(raw);
    if (!m) return;
    const rest = m[4];
    const struck = rest.startsWith("~~");
    const body = rest.replace(CONFIRMED, "").replace(UPDATED, "").trim();
    entries.push({ line, raw, prefix: m[1], body, date: m[2], importance: m[3] ? Number(m[3]) : 3, struck, confirmed: confirmedDate(raw) });
  });
  return entries;
}

export function normaliseBody(body: string): string {
  return body.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();
}

export interface Contradiction {
  /** Indexes into the entries array. */
  a: number;
  b: number;
  keep: "a" | "b";
}

export interface ConsolidationPlan {
  /** Entry indexes whose line is removed (an older exact duplicate). */
  removeDuplicate: number[];
  /** The loser is struck through with a trace; the winner stays. */
  supersede: Array<{ loser: number; winner: number }>;
  /** Entry indexes moved to the archive file. */
  archive: number[];
  /** True when the floor cut the plan short. */
  overFloor: boolean;
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}

/** The older copies of every exact duplicate, so the contradiction call
 * can be asked over the deduplicated list — a model shown two identical
 * lines beside their correction tends to miss the correction. */
export function duplicateIndexes(entries: readonly NotebookEntry[]): Set<number> {
  const byKey = new Map<string, Array<{ e: NotebookEntry; index: number }>>();
  entries.forEach((e, index) => {
    if (e.struck) return;
    const key = normaliseBody(e.body);
    if (!key) return;
    byKey.set(key, [...(byKey.get(key) ?? []), { e, index }]);
  });
  const older = new Set<number>();
  for (const group of byKey.values()) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((x, y) => (x.e.date < y.e.date ? 1 : x.e.date > y.e.date ? -1 : y.index - x.index));
    for (const item of sorted.slice(1)) older.add(item.index);
  }
  return older;
}

export function planConsolidation(entries: readonly NotebookEntry[], opts: { today: string; staleDays: number; floorShare: number; contradictions: readonly Contradiction[] }): ConsolidationPlan {
  const live = entries.map((e, index) => ({ e, index })).filter(({ e }) => !e.struck);
  const touched = new Set<number>();
  const plan: ConsolidationPlan = { removeDuplicate: [], supersede: [], archive: [], overFloor: false };
  const budget = Math.max(1, Math.floor(live.length * opts.floorShare));
  const changes = () => plan.removeDuplicate.length + plan.supersede.length + plan.archive.length;
  const room = () => changes() < budget;
  // 1. exact duplicates: keep the newest, remove the rest
  const byKey = new Map<string, Array<{ e: NotebookEntry; index: number }>>();
  for (const item of live) {
    const key = normaliseBody(item.e.body);
    if (!key) continue;
    byKey.set(key, [...(byKey.get(key) ?? []), item]);
  }
  for (const group of byKey.values()) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((x, y) => (x.e.date < y.e.date ? 1 : x.e.date > y.e.date ? -1 : y.index - x.index));
    // the survivor's text is unchanged, so it may still lose a contradiction below
    for (const older of sorted.slice(1)) {
      if (!room()) { plan.overFloor = true; break; }
      plan.removeDuplicate.push(older.index);
      touched.add(older.index);
    }
  }
  // 2. contradictions: strike the loser, keep the winner
  for (const pair of opts.contradictions) {
    const winner = pair.keep === "a" ? pair.a : pair.b;
    const loser = pair.keep === "a" ? pair.b : pair.a;
    if (touched.has(loser) || touched.has(winner)) continue;
    if (!entries[loser] || !entries[winner] || entries[loser].struck || entries[winner].struck) continue;
    if (!room()) { plan.overFloor = true; break; }
    plan.supersede.push({ loser, winner });
    touched.add(loser);
    touched.add(winner);
  }
  // 3. stale: old, low importance, never confirmed — to the archive
  for (const { e, index } of live) {
    if (touched.has(index)) continue;
    if (e.importance >= 4 || e.confirmed) continue;
    const anchor = e.confirmed ?? e.date;
    if (daysBetween(anchor, opts.today) < opts.staleDays) continue;
    if (e.importance > 2) continue;
    if (!room()) { plan.overFloor = true; break; }
    plan.archive.push(index);
    touched.add(index);
  }
  plan.removeDuplicate.sort((a, b) => a - b);
  plan.archive.sort((a, b) => a - b);
  return plan;
}

export function applyPlan(text: string, entries: readonly NotebookEntry[], plan: ConsolidationPlan, today: string): { text: string; archived: string[] } {
  const lines = text.split("\n");
  const drop = new Set<number>();
  const archived: string[] = [];
  for (const index of plan.removeDuplicate) drop.add(entries[index].line);
  for (const index of plan.archive) {
    const e = entries[index];
    drop.add(e.line);
    archived.push(`${e.raw.replace(CONFIRMED, "")} · archived ${today}`);
  }
  for (const { loser } of plan.supersede) {
    const e = entries[loser];
    lines[e.line] = `${e.prefix}~~${e.body}~~ · superseded ${today}`;
  }
  const next = lines.filter((_, index) => !drop.has(index)).join("\n");
  return { text: next, archived };
}

const PROMPT_CAP = 200;

export function consolidatorPrompt(entries: readonly NotebookEntry[], exclude: ReadonlySet<number> = new Set()): string {
  const listed = entries.slice(0, PROMPT_CAP).map((e, index) => (e.struck || exclude.has(index) ? null : `[${index}] ${e.body}`)).filter(Boolean).join("\n");
  return [
    "You are the CONSOLIDATOR of a personal notebook. You have no tools. Read only the numbered lines below.",
    "",
    listed || "(nothing)",
    "",
    "Find pairs of lines that cannot both be true at the same time (a direct contradiction, not a refinement, not two different topics). For each pair say which one to keep: the later or more specific statement, unless the other is clearly the correction.",
    "Answer with one JSON object and nothing else:",
    '{"pairs": [{"a": <index>, "b": <index>, "keep": "a"|"b"}]}',
    "An empty list is the normal answer. Never invent a contradiction to have something to report.",
  ].join("\n");
}

export function parseContradictions(text: string, count: number): Contradiction[] {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : trimmed).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  let parsed: { pairs?: unknown };
  try {
    parsed = JSON.parse(candidate.slice(start, end + 1)) as { pairs?: unknown };
  } catch {
    return [];
  }
  if (!Array.isArray(parsed.pairs)) return [];
  const out: Contradiction[] = [];
  const seen = new Set<string>();
  for (const pair of parsed.pairs) {
    if (!pair || typeof pair !== "object") continue;
    const { a, b, keep } = pair as Record<string, unknown>;
    if (!Number.isInteger(a) || !Number.isInteger(b) || a === b) continue;
    if ((a as number) < 0 || (b as number) < 0 || (a as number) >= count || (b as number) >= count) continue;
    if (keep !== "a" && keep !== "b") continue;
    const key = [Math.min(a as number, b as number), Math.max(a as number, b as number)].join(":");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ a: a as number, b: b as number, keep });
  }
  return out;
}
