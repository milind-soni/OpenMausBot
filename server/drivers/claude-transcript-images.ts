// Anthropic-compatible endpoints take at most 20 images per request. Claude Code sends the whole conversation on every
// turn, so a long thread that keeps adding screenshots (a patent page per turn) crosses that line and every later turn,
// text-only or not, is refused with HTTP 400 "Total number of images exceeds the maximum allowed of 20" (seen
// 2026-11-13 on a patent-extraction thread: 81k tokens, page images from earlier turns).
//
// Before a resumed turn, keep the newest images and turn the older ones into a one-line note in the transcript Claude
// Code reads. A warm process holds the conversation in memory and never rereads that file, so once its next request
// would go over the limit it is not reused: the turn starts a process that resumes the folded transcript instead
// (transcriptImagesOver). The engine's own JSONL is the only place both sides share; nothing else about the conversation changes,
// and a folded image is still described by the text around it.
import { readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** What one request may carry (the endpoints' own limit). */
export const CLAUDE_IMAGE_LIMIT = 20;
/** How many the transcript keeps: room for this turn's new images under the limit. */
export const CLAUDE_IMAGE_KEEP = 16;
/** Under this size a transcript cannot hold 20 images; skip parsing it on every turn. */
const MIN_BYTES = 256 * 1024;

const lastSeen = new Map<string, string>();
const counted = new Map<string, { stamp: string; total: number }>();

export interface FoldResult {
  total: number;
  folded: number;
  /** Why nothing was done, when it was not a fold. */
  skipped?: "small" | "unchanged" | "missing" | "unreadable";
}

/** Where Claude Code keeps one session's transcript. The folder is the working directory with everything but letters
 * and digits turned into '-', as its own code does. */
export function transcriptPath(configDir: string, cwd: string, sessionId: string): string {
  return join(configDir, "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"), `${sessionId}.jsonl`);
}

type ImageSlot = { container: unknown[]; index: number };

/** Whether a warm process on this session would send more than the limit with `incoming` new images: its transcript
 * already holds everything it will resend. Counted once per version of the file; false when there is no transcript. */
export function transcriptImagesOver(options: { configDir: string; cwd: string; sessionId: string }, incoming = 0): boolean {
  const file = transcriptPath(options.configDir, options.cwd, options.sessionId);
  let stat;
  try {
    stat = statSync(file);
  } catch {
    return false;
  }
  const stamp = `${stat.size}:${stat.mtimeMs}`;
  let total = counted.get(file)?.stamp === stamp ? counted.get(file)!.total : -1;
  if (total < 0) {
    total = 0;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.includes('"image"')) continue;
      try {
        total += imageSlots(JSON.parse(line)).length;
      } catch { /* a half-written last line */ }
    }
    counted.set(file, { stamp, total });
  }
  return total + incoming > CLAUDE_IMAGE_LIMIT;
}

function imageSlots(row: unknown): ImageSlot[] {
  const slots: ImageSlot[] = [];
  const walk = (value: unknown, depth: number) => {
    if (!value || typeof value !== "object" || depth > 8) return;
    if (Array.isArray(value)) {
      value.forEach((entry, index) => {
        if (entry && typeof entry === "object" && (entry as { type?: unknown }).type === "image") slots.push({ container: value, index });
        else walk(entry, depth + 1);
      });
      return;
    }
    for (const entry of Object.values(value as Record<string, unknown>)) walk(entry, depth + 1);
  };
  walk(row, 0);
  return slots;
}

const note = (n: number) => ({ type: "text", text: `[Earlier image ${n} omitted: a request carries at most ${CLAUDE_IMAGE_LIMIT} images, so only the newest ${CLAUDE_IMAGE_KEEP} are kept]` });

/** Keep the newest `keep` images of one transcript, replacing older ones with a text note. Atomic: a new file is written
 * beside it and renamed over. Returns what it found; never throws: an unreadable transcript must not cost the turn. */
export function foldTranscriptImages(options: FoldOptions): FoldResult {
  try {
    return fold(options);
  } catch {
    return { total: 0, folded: 0, skipped: "unreadable" };
  }
}

interface FoldOptions {
  configDir: string;
  cwd: string;
  sessionId: string;
  keep?: number;
  /** The gate that skips small transcripts; 0 when the transcript is known to be over the limit. */
  minBytes?: number;
}

function fold(options: FoldOptions): FoldResult {
  const keep = Math.max(1, Math.min(options.keep ?? CLAUDE_IMAGE_KEEP, CLAUDE_IMAGE_LIMIT));
  const file = transcriptPath(options.configDir, options.cwd, options.sessionId);
  let stat;
  try {
    stat = statSync(file);
  } catch {
    return { total: 0, folded: 0, skipped: "missing" };
  }
  if (stat.size < (options.minBytes ?? MIN_BYTES)) return { total: 0, folded: 0, skipped: "small" };
  const stamp = `${stat.size}:${stat.mtimeMs}`;
  if (lastSeen.get(file) === stamp) return { total: 0, folded: 0, skipped: "unchanged" };

  const lines = readFileSync(file, "utf8").split("\n");
  const parsed: Array<{ line: string; row?: unknown }> = lines.map((line) => {
    if (!line.trim()) return { line };
    try {
      return { line, row: JSON.parse(line) as unknown };
    } catch {
      return { line };      // a half-written last line, or a format this code does not know: left as it was
    }
  });
  const slots: ImageSlot[] = [];
  for (const entry of parsed) if (entry.row !== undefined) slots.push(...imageSlots(entry.row));
  if (slots.length <= keep) {
    lastSeen.set(file, stamp);
    return { total: slots.length, folded: 0 };
  }
  const fold = slots.slice(0, slots.length - keep);
  fold.forEach((slot, index) => { slot.container[slot.index] = note(index + 1); });

  const out = parsed.map((entry) => (entry.row === undefined ? entry.line : JSON.stringify(entry.row))).join("\n");
  const temp = join(dirname(file), `.${options.sessionId}.images.tmp`);
  writeFileSync(temp, out, { mode: stat.mode });
  renameSync(temp, file);
  const after = statSync(file);
  lastSeen.set(file, `${after.size}:${after.mtimeMs}`);
  return { total: slots.length, folded: fold.length };
}
