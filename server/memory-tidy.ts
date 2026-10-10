// The nightly tidy-up of MEMORY.md, for a bot with Memory upkeep on. Three
// steps, in order, each leaving a trace:
//   1. expired  — a live entry past its `until` day moves to memory/archive.md
//   2. duplicate — of two entries with the same fact identity (signs,
//      symbols and case kept), the newest stays and older copies go
//   3. contradicted — one strict-JSON model call over what is left names
//      pairs that cannot both be true; the loser is struck through with a
//      date, never deleted, and at most floor(live × 0.2) of them change in
//      one pass — none at all below five entries.
// Hand-written lines without a date are never touched. Pure here: the
// caller reads, calls the model, writes and journals.
import { factIdentity, isExpired, parseMemoryEntries, type MemoryEntryLine } from "./memory-entries.ts";

export const CONTRADICTION_SHARE = 0.2;
export const TIDY_MARKER = "You are the TIDY step of a memory system";
const PROMPT_ENTRIES = 200;

export interface Contradiction {
  /** Indexes into the entry list given to the prompt. */
  a: number;
  b: number;
  keep: "a" | "b";
  /** What in the losing line is still true, when it held more than one
   * fact ("lives in Pune and prefers short replies"): kept as its own entry. */
  remainder?: string;
}

export interface TidyPlan {
  expired: MemoryEntryLine[];
  duplicates: MemoryEntryLine[];
  superseded: Array<{ loser: MemoryEntryLine; winner: MemoryEntryLine; remainder?: string }>;
  /** Contradictions the share limit held back for another night. */
  deferred: number;
}

/** The newest-wins duplicates among live, unexpired entries. */
function duplicatesOf(live: readonly MemoryEntryLine[]): MemoryEntryLine[] {
  const byKey = new Map<string, MemoryEntryLine[]>();
  for (const entry of live) {
    const key = factIdentity(entry.body);
    if (!key) continue;
    byKey.set(key, [...(byKey.get(key) ?? []), entry]);
  }
  const older: MemoryEntryLine[] = [];
  for (const group of byKey.values()) {
    if (group.length < 2) continue;
    // newest date first; on the same day the later line wins
    const sorted = [...group].sort((x, y) => (x.date === y.date ? y.line - x.line : x.date < y.date ? 1 : -1));
    older.push(...sorted.slice(1));
  }
  return older;
}

/** What survives steps 1 and 2: the list the contradiction call is asked
 * about, so two copies of a fact beside its correction never confuse it. */
export function contradictionCandidates(text: string, today: string): MemoryEntryLine[] {
  const live = parseMemoryEntries(text).filter((e) => !e.struck && !isExpired(e, today));
  const dupes = new Set(duplicatesOf(live).map((e) => e.line));
  return live.filter((e) => !dupes.has(e.line));
}

/** How many contradictions one pass may act on. */
export function contradictionBudget(liveEntries: number): number {
  return Math.floor(liveEntries * CONTRADICTION_SHARE);
}

export function planTidy(text: string, today: string, contradictions: readonly Contradiction[] = []): TidyPlan {
  const entries = parseMemoryEntries(text);
  const expired = entries.filter((e) => isExpired(e, today));
  const live = entries.filter((e) => !e.struck && !isExpired(e, today));
  const duplicates = duplicatesOf(live);
  const candidates = contradictionCandidates(text, today);
  const budget = contradictionBudget(live.length);
  const touched = new Set<number>();
  const superseded: TidyPlan["superseded"] = [];
  let deferred = 0;
  for (const pair of contradictions) {
    const a = candidates[pair.a];
    const b = candidates[pair.b];
    if (!a || !b || a.line === b.line) continue;
    const [winner, loser] = pair.keep === "a" ? [a, b] : [b, a];
    if (touched.has(winner.line) || touched.has(loser.line)) continue;
    if (superseded.length >= budget) {
      deferred += 1;
      continue;
    }
    superseded.push({ loser, winner, ...(pair.remainder ? { remainder: pair.remainder } : {}) });
    touched.add(loser.line);
    touched.add(winner.line);
  }
  return { expired, duplicates, superseded, deferred };
}

export function planChanges(plan: TidyPlan): number {
  return plan.expired.length + plan.duplicates.length + plan.superseded.length;
}

/** MEMORY.md after the plan, and the lines the archive gains. */
export function applyTidy(text: string, plan: TidyPlan, today: string): { text: string; archived: string[] } {
  const lines = text.split("\n");
  const drop = new Set<number>([...plan.expired, ...plan.duplicates].map((e) => e.line));
  for (const { loser, remainder } of plan.superseded) {
    const struck = `${loser.prefix}~~${loser.body}~~ · superseded ${today}`;
    // the still-true part of a mixed line lives on as its own dated entry
    lines[loser.line] = remainder ? `${struck}\n- ${today} · from tidy-up · ${remainder}` : struck;
  }
  const archived = plan.expired.map((e) => `${e.raw} · expired ${today}`);
  return { text: lines.filter((_, index) => !drop.has(index)).join("\n"), archived };
}

export function contradictionPrompt(candidates: readonly MemoryEntryLine[]): string {
  const listed = candidates.slice(0, PROMPT_ENTRIES).map((e, index) => `[${index}] (${e.date}) ${e.body}`).join("\n");
  return [
    `${TIDY_MARKER}. You have no tools. Read only the numbered notebook lines below, each with the date it was written.`,
    "",
    listed || "(nothing)",
    "",
    "Find pairs of lines that cannot both be true now: a direct contradiction about the same thing (a changed number, a new city, a reversed preference) — not a refinement, not two different topics, not two facts that can both hold.",
    "Numbers, signs and symbols matter: \"balance is -10\" and \"balance is 10\" contradict; \"uses C\" and \"uses C++\" may both be true.",
    "For each pair say which to keep: the later line unless the earlier one is clearly the correction.",
    "When the line that loses also states other facts that are still true, give them as remainder, one sentence, worded as in the line; otherwise omit remainder.",
    "Answer with one JSON object and nothing else:",
    '{"pairs": [{"a": <index>, "b": <index>, "keep": "a"|"b", "remainder": "optional"}]}',
    'An empty list {"pairs": []} is the normal answer. Never invent a contradiction.',
  ].join("\n");
}

export function parseContradictions(text: string, count: number): Contradiction[] {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
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
    const { a, b, keep, remainder } = pair as Record<string, unknown>;
    if (!Number.isInteger(a) || !Number.isInteger(b) || a === b) continue;
    const ia = a as number;
    const ib = b as number;
    if (ia < 0 || ib < 0 || ia >= count || ib >= count) continue;
    if (keep !== "a" && keep !== "b") continue;
    const key = `${Math.min(ia, ib)}:${Math.max(ia, ib)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const rest = typeof remainder === "string" ? remainder.replace(/\s+/g, " ").replace(/~~/g, "").trim().slice(0, 300) : "";
    out.push({ a: ia, b: ib, keep, ...(rest ? { remainder: rest } : {}) });
  }
  return out;
}
