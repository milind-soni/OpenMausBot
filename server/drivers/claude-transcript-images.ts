// Some Anthropic-compatible endpoints take at most 20 images per request. Claude Code sends the whole conversation on
// every turn, so a long thread that keeps adding screenshots (a patent page per turn) crosses that line and every later
// turn, text-only or not, is refused with HTTP 400 "Total number of images exceeds the maximum allowed of 20" (seen
// 2026-11-13 on a patent-extraction thread: 81k tokens, page images from earlier turns).
//
// Only for a custom Anthropic-compatible endpoint (imageFoldTarget): first-party Anthropic takes far more images per
// request, so its threads keep every image and its warm processes are reused as before. For such an endpoint, before a
// resumed turn, keep the newest images that fit beside the turn's own and turn the older ones into a one-line note in
// the transcript Claude Code reads. A warm process holds the conversation in memory and never rereads that file, so
// once its next request would go over the limit it is not reused: the turn starts a process that resumes the folded
// transcript instead (transcriptImagesOver). The engine's own JSONL is the only place both sides share; nothing else
// about the conversation changes, and a folded image is still described by the text around it.
//
// The rewrite is careful: the file as it was is first copied beside it (`<session>.jsonl.before-image-fold`, which the
// CLI never reads as a session), only the rows that held a folded image are written anew, the new file is synced and
// renamed over the old one, and nothing is replaced when the transcript changed while it was being read.
import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
import { dirname, join } from "node:path";

/** What one request may carry (the endpoints' own limit). */
export const CLAUDE_IMAGE_LIMIT = 20;
/** How many the transcript keeps at most: room for a few new images under the limit. */
export const CLAUDE_IMAGE_KEEP = 16;
/** Claude Code's cap on a project folder's name; a longer one is cut and given a hash of the full path. */
const PROJECT_DIR_MAX = 200;
/** The copy of a transcript as it was before its latest fold. */
export const FOLD_BACKUP_SUFFIX = ".before-image-fold";

const counted = new Map<string, { stamp: string; total: number }>();

export interface FoldResult {
  total: number;
  folded: number;
  /** Why nothing was read or replaced, when nothing was. */
  skipped?: "missing" | "unreadable" | "changed";
}

interface TranscriptOptions {
  configDir: string;
  cwd: string;
  sessionId: string;
}

/** Whether a base URL points at a host other than Anthropic's own. */
function customHost(url: string | undefined): boolean {
  if (!url?.trim()) return false;
  try {
    const host = new URL(url.trim()).hostname.toLowerCase().replace(/\.$/u, "");
    return host !== "anthropic.com" && !host.endsWith(".anthropic.com");
  } catch {
    return false;
  }
}

/** Where to fold images, or undefined to leave the thread alone: only a custom endpoint instance (Settings > Custom
 * endpoint: not Bedrock, not company model access, not a Claude account) pointed at a host that isn't Anthropic's,
 * whose transcripts live in that endpoint's own config folder. */
export function imageFoldTarget(
  config: { endpointModels?: unknown; bedrock?: boolean; managed?: boolean; configDir?: string },
  env: { ANTHROPIC_BASE_URL?: string; CLAUDE_CONFIG_DIR?: string },
  cwd: string,
): { configDir: string; cwd: string } | undefined {
  if (!Array.isArray(config.endpointModels) || config.bedrock === true || config.managed === true || !config.configDir) return undefined;
  const configDir = env.CLAUDE_CONFIG_DIR?.trim();
  return configDir && customHost(env.ANTHROPIC_BASE_URL) ? { configDir, cwd } : undefined;
}

/** Where Claude Code keeps one session's transcript, as its own code names it: the resolved working directory with
 * everything but letters and digits turned into '-', cut at 200 characters plus a base-36 hash of the resolved path
 * when longer (checked against the installed CLI: the hash runs over the path as resolved, not as given). */
export function transcriptPath(configDir: string, cwd: string, sessionId: string): string {
  let dir = cwd, resolved = false;
  try {
    dir = realpathSync.native(cwd).normalize("NFC");
    resolved = true;
  } catch { /* a working directory that is gone: only the name given */ }
  let name = dir.replace(/[^A-Za-z0-9]/g, "-");
  if (name.length > PROJECT_DIR_MAX) name = `${name.slice(0, PROJECT_DIR_MAX)}-${folderHash(resolved ? dir : cwd)}`;
  return join(configDir, "projects", name, `${sessionId}.jsonl`);
}

/** The suffix the CLI appends to a project folder over 200 characters: a rolling hash of the path, in base-36. */
const folderHash = (path: string) => {
  let hash = 0;
  for (let i = 0; i < path.length; i++) hash = ((hash << 5) - hash + path.charCodeAt(i)) | 0;
  return Math.abs(hash).toString(36);
};

/** The transcript for one session: the folder the CLI names after the resolved working directory. */
function findTranscript(options: TranscriptOptions): { file: string; stat: Stats } | undefined {
  if (!/^[A-Za-z0-9-]+$/u.test(options.sessionId)) return undefined;
  const file = transcriptPath(options.configDir, options.cwd, options.sessionId);
  try {
    const stat = statSync(file);
    return stat.isFile() ? { file, stat } : undefined;
  } catch { /* no transcript under the resolved name, or the name as given when the directory is gone */ }
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
 * process then keeps the turn. */
export function transcriptImagesOver(options: TranscriptOptions, incoming = 0): boolean {
  try {
    const found = findTranscript(options);
    return !!found && imagesIn(found.file, found.stat) + incoming > CLAUDE_IMAGE_LIMIT;
  } catch {
    return false;
  }
}

type ImageSlot = { container: unknown[]; index: number };

/** The image blocks a row sends: only its `message.content`, never the copies the CLI keeps beside it for itself. */
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
  const content = (row as { message?: { content?: unknown } } | null)?.message?.content;
  if (Array.isArray(content)) walk(content, 0);
  return slots;
}

const note = (n: number, keep: number) => ({ type: "text", text: `[Earlier image ${n} omitted: a request carries at most ${CLAUDE_IMAGE_LIMIT} images, so only the newest ${keep} are kept]` });

interface FoldOptions extends TranscriptOptions {
  /** Images the turn itself adds: the transcript keeps only what fits beside them. */
  incoming?: number;
}

/** Keep the newest images of one transcript that fit beside the turn's own, replacing older ones with a text note.
 * Returns what it found; never throws: an unreadable transcript must not cost the turn, and a failed rewrite leaves the
 * transcript as it was. */
export function foldTranscriptImages(options: FoldOptions): FoldResult {
  try {
    return fold(options);
  } catch {
    return { total: 0, folded: 0, skipped: "unreadable" };
  }
}

/** Writes `text` to a new file beside `file`, synced to disk, and returns its path. */
function writeBeside(file: string, text: string, mode: number): string {
  const temp = join(dirname(file), `.${randomUUID()}.image-fold.tmp`);
  const fd = openSync(temp, "wx", mode & 0o777);
  try {
    writeFileSync(fd, text);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    try { unlinkSync(temp); } catch { /* already gone */ }
    throw error;
  }
  closeSync(fd);
  return temp;
}

function fold(options: FoldOptions): FoldResult {
  const keep = imagesToKeep(options.incoming);
  const found = findTranscript(options);
  if (!found) return { total: 0, folded: 0, skipped: "missing" };
  const { file, stat } = found;
  const total = imagesIn(file, stat);
  if (total <= keep) return { total, folded: 0 };

  const original = readFileSync(file, "utf8");
  const parsed: Array<{ line: string; row?: unknown; slots: ImageSlot[] }> = original.split("\n").map((line) => {
    if (!line.includes('"image"')) return { line, slots: [] };
    try {
      const row = JSON.parse(line) as unknown;
      return { line, row, slots: imageSlots(row) };
    } catch {
      return { line, slots: [] };      // a half-written last line, or a format this code does not know: left as it was
    }
  });
  const slots = parsed.flatMap((entry) => entry.slots);
  const folded = Math.max(0, slots.length - keep);
  if (!folded) return { total: slots.length, folded: 0 };
  const changed = new Set(slots.slice(0, folded));
  slots.slice(0, folded).forEach((slot, index) => { slot.container[slot.index] = note(index + 1, keep); });
  // Only a row that lost an image is written anew; every other line stays byte for byte as the CLI wrote it.
  const out = parsed.map((entry) => (entry.slots.some((slot) => changed.has(slot)) ? JSON.stringify(entry.row) : entry.line)).join("\n");

  const temps: string[] = [];
  try {
    const temp = writeBeside(file, out, stat.mode);
    temps.push(temp);
    const backup = writeBeside(file, original, stat.mode);
    temps.push(backup);
    // The CLI may have written while this ran: then nothing is replaced, not even the last backup, and the next resume
    // looks again.
    const now = statSync(file);
    if (now.size !== Buffer.byteLength(original) || stampOf(now) !== stampOf(stat)) return { total: slots.length, folded: 0, skipped: "changed" };
    renameSync(backup, `${file}${FOLD_BACKUP_SUFFIX}`);
    renameSync(temp, file);
  } finally {
    for (const left of temps) try { unlinkSync(left); } catch { /* renamed into place, or already gone */ }
  }
  counted.set(file, { stamp: stampOf(statSync(file)), total: slots.length - folded });
  return { total: slots.length, folded };
}
