// Antigravity's ACP server replaces the harness view_file with a text-only reader, so a bot that opens an mp4,
// png or mp3 from its tools gets raw bytes and the model sees nothing. A `resource_link` prompt block is read
// by the server itself (agy_acp_server types.from_file) and reaches the model as real video, image, audio or
// PDF. This finds existing local media files named in the turn text and returns those blocks plus a short note.
import { stat } from "node:fs/promises";
import { resolve } from "node:path";

import { productName } from "../../brand.ts";
import { INBOX_FOLDER, withinPath } from "../../host/handoff-inbox.ts";

export interface AcpResourceLink {
  type: "resource_link";
  uri: string;
  name: string;
}

export interface AcpMediaLinks {
  blocks: AcpResourceLink[];
  /** Appended to the prompt text: what was attached, and what was too large to be. Empty when nothing was named. */
  note: string;
}

const MEDIA_EXTENSIONS = "mp4|m4v|mov|webm|mpeg|mpg|avi|wmv|flv|3gp|mp3|wav|aac|ogg|oga|flac|opus|jpg|jpeg|png|webp|bmp|pdf";
// A name ends at the extension, before whitespace, a quote, closing punctuation or a sentence's full stop.
const MEDIA_END = new RegExp(`\\.(?:${MEDIA_EXTENSIONS})(?=$|[\\s"'\`)\\]>,;:!?]|\\.(?:\\s|$))`, "giu");
// A path starts at a drive letter, or at a slash after whitespace, a quote or an opening bracket.
const PATH_START = /[A-Za-z]:[\\/]|(?<=^|[\s"'`(<[=])\//gu;
// A file another bot passed is named `inbox/...` when the turn runs in its conversation's own folder (handoff-files.ts).
const INBOX_START = new RegExp(`(?<=^|[\\s"'\`(<[=])${INBOX_FOLDER}[\\\\/]`, "gu");

/** Measured against agy_acp_server 1.8: one 14.5 MB mp4 is answered; two in one prompt (29 MB) end the turn
 * with "trajectory converted to zero chat messages". */
export const ACP_MEDIA_MAX_BYTES = 19 * 1024 * 1024;
export const ACP_MEDIA_MAX_FILES = 8;

/** Google's server turns a link into a path with urlparse().path: on Windows `file:///D:/x` gives "/D:/x",
 * which does not open, while `file:D:/x` gives "D:/x". */
export function acpMediaUri(path: string, platform: NodeJS.Platform = process.platform): string {
  const encoded = path.replaceAll("\\", "/").split("/").map(encodeURIComponent).join("/");
  return platform === "win32" ? `file:${encoded.replace(/^([A-Za-z])%3A/u, "$1:")}` : `file://${encoded}`;
}

/** Existing local media files named in `text`, in order and without repeats (the same file named twice, by
 * file identity, so case-sensitive file systems keep distinct names). Spaces in a path are allowed: each
 * candidate start on the line is tried from the nearest, and the first that names a file wins. With `cwd`, the
 * turn's folder, an `inbox/...` path is read from there and returned whole. */
export async function findMediaPaths(text: string, cwd?: string): Promise<Array<{ path: string; size: number }>> {
  const found: Array<{ path: string; size: number }> = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(MEDIA_END)) {
    const end = match.index + match[0].length;
    const line = text.slice(text.lastIndexOf("\n", match.index) + 1, end);
    // Absolute names first, so an absolute path with an `inbox/` folder inside it is never read from `cwd` instead.
    const absolute = [...line.matchAll(PATH_START)].reverse().map((start) => line.slice(start.index).trim());
    for (const path of absolute.concat(inboxPaths(line, cwd))) {
      const info = await stat(path, { bigint: true }).catch(() => null);
      if (!info?.isFile()) continue;
      const key = `${info.dev}:${info.ino}`;
      if (!seen.has(key)) {
        seen.add(key);
        found.push({ path, size: Number(info.size) });
      }
      break;
    }
  }
  return found;
}

/** The `inbox/...` names on `line`, nearest first, read from `cwd` and kept only when they stay inside its inbox. */
function inboxPaths(line: string, cwd: string | undefined): string[] {
  if (cwd === undefined) return [];
  const root = resolve(cwd, INBOX_FOLDER);
  return [...line.matchAll(INBOX_START)]
    .reverse()
    .map((start) => resolve(cwd, line.slice(start.index).trim()))
    .filter((path) => withinPath(path, root));
}

/** Prompt blocks for the media named in `text`, within one prompt's budget, and a note saying what was and was
 * not attached. `usedBytes` is media the prompt already carries (composer images): it counts against the same
 * budget, so when it alone fills the budget every named file is left out and named in the note. */
export async function readAcpMediaLinks(text: string, usedBytes = 0, budget = ACP_MEDIA_MAX_BYTES, cwd?: string): Promise<AcpMediaLinks> {
  const blocks: AcpResourceLink[] = [];
  const attached: string[] = [];
  const skipped: Array<{ path: string; size: number }> = [];
  let total = usedBytes;
  for (const file of await findMediaPaths(text, cwd)) {
    if (attached.length < ACP_MEDIA_MAX_FILES && total + file.size <= budget) {
      total += file.size;
      attached.push(file.path);
      blocks.push({ type: "resource_link", uri: acpMediaUri(file.path), name: file.path.split(/[\\/]/u).pop() ?? file.path });
    } else {
      skipped.push(file);
    }
  }
  let note = "";
  if (attached.length) {
    note += `\n\n(${productName()} attached these files to this message so you can see and hear them directly; do not open them with a file tool: ${attached.join(" | ")})`;
  }
  if (skipped.length) {
    const limitMb = Math.floor(budget / 1048576);
    note += `\n\n(Not attached: ${skipped.map((file) => `${file.path} (${(file.size / 1048576).toFixed(1)} MB)`).join(" | ")}.` +
      ` One message carries at most ${limitMb} MB of media${usedBytes > 0 ? ", images attached to it included," : ""} and a file tool cannot show media, so you cannot see these.` +
      ` Say so plainly; to view one, shrink or split it into parts of ${limitMb} MB or less and ask to have each part sent in its own message.)`;
  }
  return { blocks, note };
}
