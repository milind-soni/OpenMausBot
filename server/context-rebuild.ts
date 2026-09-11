// Model-facing rebuild of the canonical store transcript.
//
// The display path is unbounded and never shrinks. Only this projection
// is sized: last compaction summary + messages from firstKeptId, including
// compact tool chips so a handed-over engine sees the work, not just talk.
import { isVectorBudgetPreset, VECTOR_BUDGET_AUTO_CAP } from "../shared/compact-around.ts";
import type { Message } from "./store.ts";
import { transcriptText } from "./replies.ts";
import { COMPACTION_RATIO, memoryPressure, type MemoryProbe } from "./context-ceiling.ts";

export interface FacingTurn {
  role: "user" | "assistant";
  text: string;
  id?: string;
}

export interface CompactionRecord {
  summary: string;
  firstKeptId: string;
  tokensBefore: number;
}

export interface ModelFacing {
  transcript: FacingTurn[];
  lastCompaction: CompactionRecord | null;
  compactionMessage: Message | null;
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export function estimateTranscriptTokens(turns: ReadonlyArray<{ text: string }>): number {
  let total = 0;
  for (const turn of turns) total += estimateTokens(turn.text);
  return total;
}

function activityLine(message: Message): string | null {
  const tool = message.tool;
  if (message.kind !== "activity" || !tool?.name) return null;
  const outcome = tool.ok === true ? "ok" : tool.ok === false ? "failed" : "running";
  return `[tool ${tool.name} → ${outcome}]`;
}

function asCompaction(message: Message): CompactionRecord | null {
  if (message.kind !== "compaction") return null;
  const payload = message.compaction;
  const summary = payload?.summary?.trim() || message.text?.trim() || "";
  const firstKeptId = payload?.firstKeptId;
  if (!summary || !firstKeptId) return null;
  return {
    summary,
    firstKeptId,
    tokensBefore: typeof payload?.tokensBefore === "number" ? payload.tokensBefore : 0,
  };
}

/** Walk the active branch and produce the model-facing turns. After a
 * compaction record, the tail starts at firstKeptId — history behind it
 * stays in the store and is not replayed. */
export function modelFacingTurns(
  path: Message[],
  skipIds: ReadonlySet<string>,
  messagesById: ReadonlyMap<string, Message>,
  userName: string,
): ModelFacing {
  let lastCompaction: CompactionRecord | null = null;
  let compactionMessage: Message | null = null;
  for (const message of path) {
    const record = asCompaction(message);
    if (record) {
      lastCompaction = record;
      compactionMessage = message;
    }
  }
  const startIndex = lastCompaction
    ? Math.max(0, path.findIndex((message) => message.id === lastCompaction!.firstKeptId))
    : 0;
  const transcript: FacingTurn[] = [];
  for (const message of path.slice(startIndex < 0 ? 0 : startIndex)) {
    if (skipIds.has(message.id)) continue;
    if (message.kind === "compaction") continue;
    if (message.kind === "text" && message.text) {
      transcript.push({
        role: message.role === "user" ? "user" : "assistant",
        text: transcriptText(message, messagesById, userName),
        id: message.id,
      });
      continue;
    }
    const toolLine = activityLine(message);
    if (toolLine) {
      transcript.push({ role: "assistant", text: toolLine, id: message.id });
    }
  }
  return { transcript, lastCompaction, compactionMessage };
}

/** Keep the newest turns that fit `maxTokens`. Walk newest → oldest.
 * Whole turns that fit are kept. An oversized newest turn (kept empty) is
 * retained whole. Later giants (text longer than ~2400 chars) may contribute
 * a head snippet when that head fits the remaining budget; otherwise their
 * body is skipped. Non-giant turns that do not fit are skipped. In both
 * skip cases the walk continues so older short facts can still be harvested
 * for compact. */
const GIANT_TURN_CHARS = 2400;
const GIANT_HEAD_CHARS = 1200;

export function clipFromTail(turns: FacingTurn[], maxTokens: number): FacingTurn[] {
  if (maxTokens <= 0 || turns.length === 0) return [];
  const kept: FacingTurn[] = [];
  let used = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i]!;
    const cost = estimateTokens(turn.text);
    if (used + cost <= maxTokens) {
      kept.push(turn);
      used += cost;
      continue;
    }
    // Does not fit in the remaining budget.
    if (kept.length === 0) {
      // Newest alone exceeds — keep whole (callers expect newest retained).
      kept.push(turn);
      used += cost;
      continue;
    }
    if (turn.text.length > GIANT_TURN_CHARS) {
      const headText = turn.text.slice(0, GIANT_HEAD_CHARS);
      const headCost = estimateTokens(headText);
      if (headCost > 0 && used + headCost <= maxTokens) {
        kept.push({ ...turn, text: headText });
        used += headCost;
      }
      // else skip body; keep walking older turns
      continue;
    }
    // Non-giant that does not fit: skip and keep walking.
  }
  kept.reverse();
  return kept;
}

export function shouldCompact(input: {
  fillTokens: number;
  ceilingTokens: number;
  turnCount: number;
  memory?: MemoryProbe | null;
  /**
   * User turns in the post-refresh tail *after* the compacting turn
   * (`firstKeptId`). 0 = we just recycled and have not taken another user
   * turn yet. Soft (80%) recycle waits for ≥1; the hard ceiling never waits.
   */
  turnsSinceCompact?: number;
}): boolean {
  if (input.ceilingTokens <= 0) return false;
  // Hard Compact around cap: at or over the budget, always recycle — even on
  // the first turn after a prior compact, and even on a one-turn thread.
  if (input.fillTokens >= input.ceilingTokens && input.turnCount >= 1) return true;
  if (input.turnCount < 2) return false;
  // Soft recycle: avoid an immediate second compact on the next keystroke.
  if (typeof input.turnsSinceCompact === "number" && input.turnsSinceCompact < 1) return false;
  if (input.fillTokens >= input.ceilingTokens * COMPACTION_RATIO) return true;
  if (input.memory && memoryPressure(input.memory) && input.fillTokens >= input.ceilingTokens * 0.5) {
    return true;
  }
  return false;
}

/** User turns in `transcript` after the compaction anchor (excludes firstKeptId). */
export function usersAfterCompaction(
  transcript: Array<{ role: string; id?: string }>,
  lastCompaction: { firstKeptId: string } | null | undefined,
): number | undefined {
  if (!lastCompaction) return undefined;
  const anchor = lastCompaction.firstKeptId;
  return transcript.filter((turn) => turn.role === "user" && turn.id !== anchor).length;
}

export { VECTOR_BUDGET_AUTO_CAP, VECTOR_BUDGET_MAX } from "../shared/compact-around.ts";

/** One-pager budget. Override is an Engines preset, clamped to the compact
 * ceiling so the vector cannot exceed the window it recycles. Auto is 15% of
 * that ceiling, capped at 6k. Next is never clipped regardless. */
export function vectorBudget(ceilingTokens: number, override?: number | null): number {
  const ceiling = Math.max(512, Math.floor(ceilingTokens));
  if (typeof override === "number" && isVectorBudgetPreset(override)) {
    return Math.max(512, Math.min(override, ceiling));
  }
  const scaled = Math.floor(ceiling * 0.15);
  return Math.min(VECTOR_BUDGET_AUTO_CAP, Math.max(512, scaled));
}
