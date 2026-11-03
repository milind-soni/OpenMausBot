// A folder page's files, served to its sandboxed frame at /api/page-files/<token>/<path>. The frame's requests carry no
// sign-in, so the route answers before the sign-in gate, and the token is the whole of its authority:
//
// - a token is made only for a document the person was allowed to fetch, names that one document (one version of one
//   page in one conversation), and is forgotten after a day unused;
// - only the files stored with that document are served, by their exact path. The one exception is a video the document
//   recorded when it was shown: it stays in the bot's folder, and is served only while the file that was checked then
//   is still the file on disk, compared on the open handle;
// - every answer is read-only, sandboxed if opened directly (no app origin, no cookies), and readable from the frame's
//   opaque origin.
import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname } from "node:path";
import { pipeline } from "node:stream";

import type { AppDocs } from "./app-docs.ts";
import type { PageVideo } from "./pages/bundle.ts";

export const PAGE_FILES_PREFIX = "/api/page-files/";
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const DAY_MS = 24 * 60 * 60_000;
const MAX_TOKENS = 5_000;

const TYPES: Readonly<Record<string, string>> = {
  html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8", css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8", json: "application/json; charset=utf-8", txt: "text/plain; charset=utf-8", csv: "text/csv; charset=utf-8",
  md: "text/markdown; charset=utf-8", parquet: "application/vnd.apache.parquet", arrow: "application/vnd.apache.arrow.file", svg: "image/svg+xml",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", ico: "image/x-icon",
  woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime",
};
// O_NOFOLLOW refuses a symlink swapped in at the last step, and O_NONBLOCK keeps a FIFO swapped in from hanging the open.
// Windows has neither; there the identity check on the open handle alone refuses a different file.
const VIDEO_OPEN_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);

const SHARED_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-expose-headers": "Content-Length, Content-Range, Accept-Ranges",
  "cross-origin-resource-policy": "cross-origin",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "private, no-store",
  "content-security-policy": "sandbox allow-scripts; default-src 'none'",
} as const;

export interface PageFilesTarget {
  threadId: string;
  messageId: string;
  /** The stored document whose files the token serves. */
  doc: string;
}

/** A path inside the folder, as stored: segments of the folder's own names, never "." or "..", no backslash or NUL.
 * null for anything else. */
export function pageFilePath(raw: string): string | null {
  if (!raw) return "index.html";
  const segments: string[] = [];
  for (const part of raw.split("/")) {
    let segment: string;
    try { segment = decodeURIComponent(part); } catch { return null; }
    if (!segment || segment === "." || segment === ".." || /[\\\0/]/.test(segment)) return null;
    segments.push(segment);
  }
  return segments.join("/");
}

/** The bytes a Range header asks of a file this size, or null when it can't be met. */
function rangeOf(header: string, size: number): { start: number; end: number } | null {
  const range = /^bytes=(\d*)-(\d*)$/.exec(header);
  const start = range?.[1] ? Number(range[1]) : range?.[2] ? Math.max(0, size - Number(range[2])) : NaN;
  const end = range?.[1] && range[2] ? Math.min(size - 1, Number(range[2])) : size - 1;
  return !range || !Number.isSafeInteger(start) || start >= size || end < start ? null : { start, end };
}

/** The open video, if it is still the regular file the page recorded. */
async function openRecordedVideo(video: PageVideo): Promise<FileHandle | null> {
  const handle = await open(video.file, VIDEO_OPEN_FLAGS).catch(() => null);
  if (!handle) return null;
  const now = await handle.stat({ bigint: true }).catch(() => null);
  if (now?.isFile() && String(now.dev) === video.dev && String(now.ino) === video.ino && Number(now.size) === video.bytes && String(now.mtimeNs) === video.mtimeNs) return handle;
  await handle.close().catch(() => {});
  return null;
}

export function createPageFiles(deps: { docs: AppDocs; now?: () => number }) {
  const now = deps.now ?? Date.now;
  const tokens = new Map<string, PageFilesTarget & { used: number }>();
  const byTarget = new Map<string, string>();
  const keyOf = (target: PageFilesTarget) => `${target.threadId}\n${target.messageId}\n${target.doc}`;
  const forget = (token: string) => {
    const known = tokens.get(token);
    tokens.delete(token);
    if (known) byTarget.delete(keyOf(known));
  };

  const answer = (res: ServerResponse, status: number, text: string) => {
    res.writeHead(status, { ...SHARED_HEADERS, "content-type": "text/plain; charset=utf-8" });
    res.end(text);
  };

  const sendVideo = async (req: IncomingMessage, res: ServerResponse, video: PageVideo, type: string, method: string) => {
    const handle = await openRecordedVideo(video);
    if (!handle) return answer(res, 404, "Not found.");
    const size = video.bytes, headers = { ...SHARED_HEADERS, "content-type": type, "accept-ranges": "bytes" };
    const part = req.headers.range === undefined ? null : rangeOf(String(req.headers.range), size);
    if (req.headers.range !== undefined && !part) {
      await handle.close().catch(() => {});
      res.writeHead(416, { ...headers, "content-range": `bytes */${size}` });
      res.end();
      return;
    }
    const start = part?.start ?? 0, end = part?.end ?? size - 1;
    res.writeHead(part ? 206 : 200, { ...headers, "content-length": String(end - start + 1), ...(part ? { "content-range": `bytes ${start}-${end}/${size}` } : {}) });
    if (method === "HEAD" || size === 0) {
      await handle.close().catch(() => {});
      res.end();
      return;
    }
    pipeline(handle.createReadStream({ start, end }), res, () => {});
  };

  return {
    /** The folder URL path a document's files load from: the same token while it is in use. */
    folder(target: PageFilesTarget): string {
      const at = now();
      for (const [token, known] of tokens) if (at - known.used > DAY_MS) forget(token);
      let token = byTarget.get(keyOf(target));
      if (!token) {
        while (tokens.size >= MAX_TOKENS) forget(tokens.keys().next().value!);
        token = randomBytes(32).toString("base64url");
        byTarget.set(keyOf(target), token);
      }
      tokens.set(token, { ...target, used: at });
      return `${PAGE_FILES_PREFIX}${token}/`;
    },

    /** True when the request was this route's. */
    serve(req: IncomingMessage, res: ServerResponse, path: string, method: string): boolean {
      if (!path.startsWith(PAGE_FILES_PREFIX)) return false;
      const rest = path.slice(PAGE_FILES_PREFIX.length);
      const slash = rest.indexOf("/");
      const token = slash === -1 ? rest : rest.slice(0, slash);
      if (method === "OPTIONS") {
        res.writeHead(204, { ...SHARED_HEADERS, "access-control-allow-methods": "GET, HEAD, OPTIONS", "access-control-allow-headers": "Range", "access-control-max-age": "600" });
        res.end();
        return true;
      }
      if (method !== "GET" && method !== "HEAD") {
        answer(res, 405, "Read only.");
        return true;
      }
      const target = TOKEN.test(token) ? tokens.get(token) : undefined;
      if (!target || now() - target.used > DAY_MS || slash === -1) {
        answer(res, 404, "Not found.");
        return true;
      }
      const file = pageFilePath(rest.slice(slash + 1));
      if (file === null) {
        answer(res, 400, "Not a file of this page.");
        return true;
      }
      target.used = now();
      const type = TYPES[extname(file).slice(1).toLowerCase()] ?? "application/octet-stream";
      const video = deps.docs.video(target.doc, file);
      if (video) {
        void sendVideo(req, res, video, type, method).catch(() => res.destroy());
        return true;
      }
      const stored = file === "index.html" ? deps.docs.read(target.doc) : null;
      const body = stored ? Buffer.from(stored.html) : deps.docs.readFile(target.doc, file);
      if (!body) {
        answer(res, 404, "Not found.");
        return true;
      }
      const headers = { ...SHARED_HEADERS, "content-type": type, "accept-ranges": "bytes" };
      if (req.headers.range !== undefined) {
        const size = body.byteLength;
        const part = rangeOf(String(req.headers.range), size);
        if (!part) {
          res.writeHead(416, { ...headers, "content-range": `bytes */${size}` });
          res.end();
          return true;
        }
        const { start, end } = part;
        const slice = body.subarray(start, end + 1);
        res.writeHead(206, { ...headers, "content-range": `bytes ${start}-${end}/${size}`, "content-length": String(slice.byteLength) });
        res.end(method === "HEAD" ? undefined : slice);
        return true;
      }
      res.writeHead(200, { ...headers, "content-length": String(body.byteLength) });
      res.end(method === "HEAD" ? undefined : body);
      return true;
    },
  };
}
export type PageFiles = ReturnType<typeof createPageFiles>;
