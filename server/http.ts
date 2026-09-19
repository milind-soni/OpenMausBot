// The HTTP helpers the server surfaces kept re-rolling: the JSON reply
// writer, the bounded body reader, and the execFile stderr extractor.
// index.ts's variants are canonical (the most complete of the drifted
// copies); callers whose wire contract needs more, like webhook-ingress's
// no-store response headers, pass the extras instead of growing another
// local fork. The static-file serve factory for OMB_STATIC_DIR also lives
// here, over a module-private MIME extension map.
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join } from "node:path";

export function json(res: ServerResponse, status: number, body: unknown, headers?: Record<string, string>) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(data);
}

export function readBody(req: IncomingMessage, limit = 1_000_000): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = "";
    let bytes = 0;
    let done = false;
    const fail = (status: number, msg: string) => {
      if (done) return;
      done = true;
      const err = Object.assign(new Error(msg), { status });
      reject(err);
    };
    req.on("data", (c) => {
      if (done) return;
      bytes += typeof c === "string" ? Buffer.byteLength(c) : c.length;
      if (bytes > limit) {
        // Keep draining the socket, but stop retaining attacker-controlled
        // bytes. Destroying the request here prevents the caller from
        // receiving the useful 413 response.
        return fail(413, "body too large");
      }
      data += c;
    });
    req.on("end", () => {
      if (done) return;
      let body: any;
      try {
        body = data ? JSON.parse(data) : {};
      } catch {
        return fail(400, "invalid JSON body");
      }
      done = true;
      resolve(body);
    });
    req.on("error", (e) => fail(400, e instanceof Error ? e.message : String(e)));
  });
}

/** execFile's error carries the child's stderr in .stderr. */
export function stderrOf(err: unknown): string {
  const s = (err as { stderr?: unknown }).stderr;
  return typeof s === "string" ? s : Buffer.isBuffer(s) ? s.toString("utf8") : "";
}

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
