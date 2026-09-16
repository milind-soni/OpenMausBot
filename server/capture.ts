// Phase 4 part 1 — fact capture at the end of a turn.
//
// A fact said in passing lives in one thread until that thread is archived
// or compacted. With capture on for a bot, the harness reads each attended
// turn — the person's words and the bot's words separately, with different
// rules — and appends what is worth keeping to the bot's notebook, marked
// as captured so a reader knows it was not asked for. Pure here: prompts,
// parsing, filters, dedupe and the buffer. Wiring lives with the server.

export type CaptureSpeaker = "person" | "bot";
export type CandidateKind = "preference" | "fact" | "instruction" | "decision" | "outcome";
export const CANDIDATE_KINDS: readonly CandidateKind[] = ["preference", "fact", "instruction", "decision", "outcome"];

export interface Candidate {
  text: string;
  kind: CandidateKind;
  /** 0..1 */
  confidence: number;
  /** 1..5, the notebook's importance grammar */
  importance: number;
}

export const MIN_CONFIDENCE = 0.4;
export const MAX_PER_FLUSH = 8;
const TEXT_MAX = 300;
const NOTEBOOK_CAP = 6_000;

const PERSON_RULES =
  "Keep what a careful assistant would want to remember about this person for later: preferences, facts, standing instructions, and decisions they stated. Not questions, not pleasantries, not things about the assistant's own work in this thread.";
const BOT_RULES =
  "Keep only what the assistant itself stated as an explicit decision, a verified outcome, or a stable fact it established — never speculation, suggestions, plans, secrets, or unverified claims that an action happened. When in doubt, leave it out.";

export function capturePrompt(input: { speaker: CaptureSpeaker; lines: readonly string[]; notebook: string }): string {
  const spoken = input.lines.map((line) => `- ${line.replace(/\s+/g, " ").trim().slice(0, 1_500)}`).join("\n");
  const notebook = input.notebook.trim() ? input.notebook.trim().slice(-NOTEBOOK_CAP) : "(empty)";
  return [
    `You are the CAPTURE step of a memory system. You have no tools. Read only what is below.`,
    "",
    input.speaker === "person" ? `What the person said, oldest first:\n${spoken}` : `What the assistant said, oldest first:\n${spoken}`,
    "",
    input.speaker === "person" ? PERSON_RULES : BOT_RULES,
    "",
    `The notebook already holds these lines; do not propose anything already there:\n${notebook}`,
    "",
    "Answer with a JSON list and nothing else, at most 8 items, empty list when nothing qualifies:",
    '[{"text": "one self-contained sentence, third person", "kind": "preference|fact|instruction|decision|outcome", "confidence": 0..1, "importance": 1..5}]',
  ].join("\n");
}

export function parseCandidates(text: string): Candidate[] {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : trimmed).trim();
  const start = Math.min(...["[", "{"].map((c) => candidate.indexOf(c)).filter((i) => i >= 0));
  if (!Number.isFinite(start)) return [];
  const end = Math.max(candidate.lastIndexOf("]"), candidate.lastIndexOf("}"));
  if (end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return [];
  }
  const list = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" && Array.isArray((parsed as { candidates?: unknown }).candidates) ? (parsed as { candidates: unknown[] }).candidates : [];
  const out: Candidate[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const { text: rawText, kind, confidence, importance } = item as Record<string, unknown>;
    if (typeof rawText !== "string" || !rawText.trim()) continue;
    if (typeof kind !== "string" || !CANDIDATE_KINDS.includes(kind as CandidateKind)) continue;
    const conf = typeof confidence === "number" && Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0;
    if (conf < MIN_CONFIDENCE) continue;
    const imp = typeof importance === "number" && Number.isFinite(importance) ? Math.min(5, Math.max(1, Math.round(importance))) : 3;
    // a model that echoes a notebook line back keeps only its body
    const text = notebookBody(rawText.trim().replace(/\s+/g, " ")).trim().slice(0, TEXT_MAX);
    if (!text) continue;
    out.push({ text, kind: kind as CandidateKind, confidence: conf, importance: imp });
    if (out.length >= MAX_PER_FLUSH) break;
  }
  return out;
}

export function normaliseFact(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();
}

/** The body of a notebook line, with the dated prefix and any strike-through stripped. */
function notebookBody(line: string): string {
  return line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").replace(/^\d{4}-\d{2}-\d{2} · (?:from [^·\n]* · )?(?:importance [1-5] · )?/, "").replace(/~~/g, "");
}

export function dedupeCandidates(candidates: readonly Candidate[], notebook: string): Candidate[] {
  const seen = new Set(notebook.split("\n").map((line) => normaliseFact(notebookBody(line))).filter(Boolean));
  const out: Candidate[] = [];
  for (const candidate of candidates) {
    const key = normaliseFact(candidate.text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
  }
  return out;
}

export interface CaptureTurn {
  person: string;
  bot: string;
}

export interface CaptureBatch {
  botId: string;
  threadId: string;
  turns: CaptureTurn[];
}

/** Turns wait in a buffer per thread and go out together after a quiet
 * spell, or at once at the count — one pair of calls per batch, never per
 * turn, and never on the turn path. */
export class CaptureBuffer {
  private readonly pending = new Map<string, { botId: string; turns: CaptureTurn[]; timer: ReturnType<typeof setTimeout> | null }>();
  private readonly opts: { quietMs: number; maxTurns: number; onFlush: (batch: CaptureBatch) => void };
  // no parameter properties: Node runs this file in strip-only mode
  constructor(opts: { quietMs: number; maxTurns: number; onFlush: (batch: CaptureBatch) => void }) {
    this.opts = opts;
  }

  add(botId: string, threadId: string, turn: CaptureTurn): void {
    const entry = this.pending.get(threadId) ?? { botId, turns: [], timer: null };
    entry.turns.push(turn);
    if (entry.timer) clearTimeout(entry.timer);
    this.pending.set(threadId, entry);
    if (entry.turns.length >= this.opts.maxTurns) {
      this.flush(threadId);
      return;
    }
    entry.timer = setTimeout(() => this.flush(threadId), this.opts.quietMs);
    entry.timer.unref?.();
  }

  flush(threadId: string): void {
    const entry = this.pending.get(threadId);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    this.pending.delete(threadId);
    if (entry.turns.length) this.opts.onFlush({ botId: entry.botId, threadId, turns: entry.turns });
  }

  flushAll(): void {
    // flush() deletes from the map, so walk a copy of the keys
    for (const threadId of Array.from(this.pending.keys())) this.flush(threadId);
  }

  size(): number {
    return this.pending.size;
  }
}
