// Anthropic-compatible endpoints take at most 20 images per request. Claude Code sends the whole conversation on every
// turn, so a long thread that keeps adding screenshots (a patent page per turn) crosses that line and every later turn,
// text-only or not, is refused with HTTP 400 "Total number of images exceeds the maximum allowed of 20" (seen
// 2026-11-13 on a patent-extraction thread: 81k tokens, page images from earlier turns).
//
// Before a resumed turn, keep the newest images that fit beside the turn's own and turn the older ones into a one-line
// note in the transcript Claude Code reads. A warm process holds the conversation in memory and never rereads that file,
// so once its next request would go over the limit it is not reused: the turn starts a process that resumes the folded
// transcript instead (transcriptImagesOver). The engine's own JSONL is the only place both sides share; nothing else
// about the conversation changes, and a folded image is still described by the text around it.
import { readFileSync, realpathSync, renameSync, statSync, writeFileSync, type Stats } from "node:fs";
import { dirname, join } from "node:path";

/** What one request may carry (the endpoints' own limit). */
export const CLAUDE_IMAGE_LIMIT = 20;
/** How many the transcript keeps at most: room for a few new images under the limit. */
export const CLAUDE_IMAGE_KEEP = 16;
/** Claude Code's cap on a project folder's name; a longer one is cut and given a hash of the full path. */
const PROJECT_DIR_MAX = 200;

const counted = new Map<string, { stamp: string; total: number }>();

export interface FoldResult {
  total: number;
  folded: number;
  /** Why nothing was read, when nothing was. */
  skipped?: "missing" | "unreadable";
}

interface TranscriptOptions {
  configDir: string;
  cwd: string;
  sessionId: string;
}

/** Where Claude Code keeps one session's transcript, as its own code names it: the working directory with everything but
 * letters and digits turned into '-', cut at 200 characters plus a hash of the full path when longer. */
export function transcriptPath(configDir: string, cwd: string, sessionId: string): string {
  let name = cwd.replace(/[^A-Za-z0-9]/g, "-");
  if (name.length > PROJECT_DIR_MAX) {
    let hash = 0;
    for (let i = 0; i < cwd.length; i++) hash = ((hash << 5) - hash + cwd.charCodeAt(i)) | 0;
    name = `${name.slice(0, PROJECT_DIR_MAX)}-${Math.abs(hash).toString(36)}`;
  }
  return join(configDir, "projects", name, `${sessionId}.jsonl`);
}

/** The transcript under the working directory as given, or as resolved when it is reached through a link. */
function findTranscript(options: TranscriptOptions): { file: string; stat: Stats } | undefined {
  const dirs = [options.cwd];
  try {
    const real = realpathSync(options.cwd);
    if (real !== options.cwd) dirs.push(real);
  } catch { /* a working directory that is gone: only the name given */ }
  for (const dir of dirs) {
    const file = transcriptPath(options.configDir, dir, options.sessionId);
    try {
      return { file, stat: statSync(file) };
    } catch { /* not under this name */ }
  }
  return undefined;
}

const stampOf = (stat: Stats) => `${stat.size}:${stat.mtimeMs}`;

/** Images in one version of a transcript, counted once per version; rows that never say "image" are not parsed. */
function imagesIn(file: string, stat: Stats): number {
  const stamp = stampOf(stat), seen = counted.get(file);
  if (seen?.stamp === stamp) return seen.total;
  let total = 0;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.includes('"image"')) continue;
    try {
      total += imageSlots(JSON.parse(line)).length;
    } catch { /* a half-written last line */ }
  }
  counted.set(file, { stamp, total });
  return total;
}

/** How many past images a request can keep beside the `incoming` new ones. */
export const imagesToKeep = (incoming = 0) => Math.max(0, Math.min(CLAUDE_IMAGE_KEEP, CLAUDE_IMAGE_LIMIT - incoming));

/** Whether a warm process on this session would send more than the limit with `incoming` new images: its transcript
 * already holds everything it will resend. False when there is no transcript, and when it cannot be read: the warm
 * process then keeps the turn, as it did before this check. */
export function transcriptImagesOver(options: TranscriptOptions, incoming = 0): boolean {
  try {
    const found = findTranscript(options);
    return !!found && imagesIn(found.file, found.stat) + incoming > CLAUDE_IMAGE_LIMIT;
  } catch {
    return false;
  }
}

type ImageSlot = { container: unknown[]; index: number };

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

const note = (n: number, keep: number) => ({ type: "text", text: `[Earlier image ${n} omitted: a request carries at most ${CLAUDE_IMAGE_LIMIT} images, so only the newest ${keep} are kept]` });

interface FoldOptions extends TranscriptOptions {
  /** Images the turn itself adds: the transcript keeps only what fits beside them. */
  incoming?: number;
}

/** Keep the newest images of one transcript that fit beside the turn's own, replacing older ones with a text note.
 * Atomic: a new file is written beside it and renamed over. Returns what it found; never throws: an unreadable
 * transcript must not cost the turn. */
export function foldTranscriptImages(options: FoldOptions): FoldResult {
  try {
    return fold(options);
  } catch {
    return { total: 0, folded: 0, skipped: "unreadable" };
  }
}

function fold(options: FoldOptions): FoldResult {
  const keep = imagesToKeep(options.incoming);
  const found = findTranscript(options);
  if (!found) return { total: 0, folded: 0, skipped: "missing" };
  const { file, stat } = found;
  const total = imagesIn(file, stat);
  if (total <= keep) return { total, folded: 0 };

  const parsed: Array<{ line: string; row?: unknown }> = readFileSync(file, "utf8").split("\n").map((line) => {
    if (!line.includes('"image"')) return { line };
    try {
      return { line, row: JSON.parse(line) as unknown };
    } catch {
      return { line };      // a half-written last line, or a format this code does not know: left as it was
    }
  });
  const slots: ImageSlot[] = [];
  for (const entry of parsed) if (entry.row !== undefined) slots.push(...imageSlots(entry.row));
  const folded = Math.max(0, slots.length - keep);
  if (!folded) return { total: slots.length, folded: 0 };
  slots.slice(0, folded).forEach((slot, index) => { slot.container[slot.index] = note(index + 1, keep); });

  const out = parsed.map((entry) => (entry.row === undefined ? entry.line : JSON.stringify(entry.row))).join("\n");
  const temp = join(dirname(file), `.${options.sessionId}.images.tmp`);
  writeFileSync(temp, out, { mode: stat.mode });
  renameSync(temp, file);
  counted.set(file, { stamp: stampOf(statSync(file)), total: slots.length - folded });
  return { total: slots.length, folded };
}
