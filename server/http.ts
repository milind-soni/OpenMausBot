// Static-file serving for the harness host. The built UI (OMB_STATIC_DIR:
// set by the desktop app and by the container image) is public by design:
// it is the same bundle anyone can download, holds no secrets, and a
// remote browser must be able to load /pair before it has a session. The
// factory returns a serve helper that answers false when there is nothing
// to serve so the caller can answer 404.
import { readFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { extname, join } from "node:path";

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

export function createServeStatic(staticDir: string | null) {
  return function serveStatic(res: ServerResponse, path: string): boolean {
    if (!staticDir) return false;
    const safe = path === "/" ? "/index.html" : path.replace(/\.\./g, "");
    const file = join(staticDir, safe);
    try {
      const data = readFileSync(file);
      res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
      res.end(data);
      return true;
    } catch {
      // SPA fallback
      try {
        const data = readFileSync(join(staticDir, "index.html"));
        res.writeHead(200, { "content-type": "text/html" });
        res.end(data);
        return true;
      } catch {
        return false;
      }
    }
  };
}
