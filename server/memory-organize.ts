// Organizing MEMORY.md into topic files, for a bot with Memory upkeep on.
// MEMORY.md loads into every turn, so it should hold only the core — who the
// person is, their standing preferences and decisions. The bot writes there
// with memory_update, the person by hand and capture for what it notices, so
// detail piles up whoever wrote it. One strict-JSON call names the entries
// that belong to a subject; each moves, line unchanged (date, source, until
// kept), to that subject's topic file, which is created with a header whose
// aliases recall matches. An entry judged core is remembered and not asked
// about again. Pure here: the caller reads, calls the model, writes and
// journals.
import { factIdentity, isExpired, parseMemoryEntries, type MemoryEntryLine } from "./memory-entries.ts";
import { topicFileName } from "./memory-capture.ts";

export const ORGANIZE_MARKER = "You are the ORGANIZE step of a memory system";
/** One pass moves at most this many entries. */
export const MAX_MOVES = 20;
const PROMPT_ENTRIES = 60;
/** Lines the model may not move, whatever it answers: a safety or health
 * fact must load into every turn. Seen live — a model moved "is vegetarian"
 * into a food topic despite being told diet is core. */
const ALWAYS_CORE = /\b(?:allerg\w*|anaphyla\w*|intoleran\w*|vegetarian|vegan|halal|kosher|gluten|lactose|diet\w*|diabet\w*|asthma\w*|epilep\w*|pregnan\w*|medicat\w*|medicine|medical|disabilit\w*|wheelchair|blind|deaf|health)\b/i;

export function alwaysCore(body: string): boolean {
  return ALWAYS_CORE.test(body);
}

export interface TopicMove {
  entry: MemoryEntryLine;
  /** `food.md` */
  topic: string;
  aliases: string[];
}

/** Live, unexpired entries not already judged core: what the call is asked about. */
export function organizeCandidates(text: string, today: string, core: ReadonlySet<string>): MemoryEntryLine[] {
  return parseMemoryEntries(text)
    .filter((e) => !e.struck && !isExpired(e, today) && !core.has(factIdentity(e.body)) && !alwaysCore(e.body))
    .slice(0, PROMPT_ENTRIES);
}

export function organizePrompt(candidates: readonly MemoryEntryLine[], topics: string): string {
  return [
    `${ORGANIZE_MARKER}. You have no tools. Read only what is below.`,
    "",
    "An assistant's core notebook, loaded into every conversation, holds these numbered lines:",
    candidates.map((e, index) => `[${index}] ${e.body}`).join("\n") || "(nothing)",
    "",
    `Topic files it already keeps:\n${topics.trim() || "(none yet)"}`,
    "",
    "Core, never moved: facts about the person themselves that matter in any conversation — their name, where they live now, their company and role, their diet, allergies and health needs, how they like to be spoken to, and standing decisions.",
    "Move a line only when it is detail about a particular subject: another person (\"asha\"), a project or client, a trip or a place, likes and dislikes in one domain (\"food\"). Reuse an existing topic name when one fits; otherwise name a new one in one or two words.",
    "When in doubt, keep the line in the notebook.",
    "For each line to move, give its number, the topic, and aliases: two to five other words someone might use when asking about that subject.",
    "Answer with one JSON object and nothing else:",
    '{"moves": [{"i": <number>, "topic": "name", "aliases": ["..."]}]}',
    'When every line is core, answer {"moves": []}.',
  ].join("\n");
}

export function parseMoves(text: string, candidates: readonly MemoryEntryLine[]): TopicMove[] | null {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  const body = (fenced ? fenced[1] : trimmed).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: { moves?: unknown };
  try {
    parsed = JSON.parse(body.slice(start, end + 1)) as { moves?: unknown };
  } catch {
    return null;
  }
  if (!parsed || !Array.isArray(parsed.moves)) return null;
  const out: TopicMove[] = [];
  const seen = new Set<number>();
  for (const move of parsed.moves) {
    if (!move || typeof move !== "object") return null;
    const { i, topic, aliases } = move as Record<string, unknown>;
    if (!Number.isInteger(i) || (i as number) < 0 || (i as number) >= candidates.length) return null;
    if (seen.has(i as number)) continue;
    const name = topicFileName(topic);
    if (!name) return null;
    seen.add(i as number);
    out.push({
      entry: candidates[i as number]!,
      topic: name,
      aliases: Array.isArray(aliases)
        ? aliases.filter((a): a is string => typeof a === "string").map((a) => a.replace(/[\r\n,[\]]+/g, " ").trim().slice(0, 40)).filter(Boolean).slice(0, 8)
        : [],
    });
  }
  return out;
}

/** MEMORY.md without the moved lines, and each topic's lines (unchanged). */
export function applyMoves(text: string, moves: readonly TopicMove[]): { text: string; byTopic: Map<string, { lines: string[]; aliases: string[] }> } {
  const drop = new Set(moves.map((move) => move.entry.line));
  const byTopic = new Map<string, { lines: string[]; aliases: string[] }>();
  for (const move of moves) {
    const group = byTopic.get(move.topic) ?? { lines: [], aliases: [] };
    group.lines.push(move.entry.raw);
    for (const alias of move.aliases) if (!group.aliases.includes(alias)) group.aliases.push(alias);
    byTopic.set(move.topic, group);
  }
  return { text: text.split("\n").filter((_, index) => !drop.has(index)).join("\n"), byTopic };
}
