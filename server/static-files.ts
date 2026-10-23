// The desktop bundle served from OMB_STATIC_DIR: content types, cache rules and the SPA fallback.
import { readFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { extname, join } from "node:path";

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
};

/** Never framed (a hidden frame could act on a pair or sign-in page unseen), and no Referer. */
const PAGE_HEADERS = { "content-security-policy": "frame-ancestors 'none'", "x-frame-options": "DENY", "referrer-policy": "no-referrer" } as const;

/** Public by design: the same bundle anyone can download, with no secrets, and /pair must load before a session exists. */
export function serveStatic(res: ServerResponse, path: string, staticDir: string | null): boolean {
  if (!staticDir) return false;
  const safe = path === "/" ? "/index.html" : path.replace(/\.\./g, "");
  const file = join(staticDir, safe);
  try {
    const data = readFileSync(file);
    const type = MIME[extname(file)] ?? "application/octet-stream";
    // Vite content-hashes every file under /assets/, so those URLs are immutable while public/ has no assets/ dir.
    const cache = type === "text/html" ? "no-cache" : safe.startsWith("/assets/") ? "public, max-age=31536000, immutable" : null;
    res.writeHead(200, { "content-type": type, ...(type === "text/html" ? PAGE_HEADERS : {}), ...(cache ? { "cache-control": cache } : {}) });
    res.end(data);
    return true;
  } catch {
      // SPA fallback, never immutable: a missing chunk answered with the page must not stay cached under the chunk's URL.
    try {
      const data = readFileSync(join(staticDir, "index.html"));
      res.writeHead(200, { "content-type": "text/html", "cache-control": "no-cache", ...PAGE_HEADERS });
      res.end(data);
      return true;
    } catch {
      return false;
    }
  }
}
