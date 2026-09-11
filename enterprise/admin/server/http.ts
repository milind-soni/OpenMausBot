import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { resolve, sep, extname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { isIP } from "node:net";

const mime: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".ico": "image/x-icon" };
const MAX_BODY = 8 * 1024 * 1024;

export function portalHttpServer(options: { url: string; webDir: string; handle: (request: Request) => Promise<Response> }) {
  const origin = new URL(options.url);
  const webDir = resolve(options.webDir);
  async function handle(req: IncomingMessage, res: ServerResponse) {
    const abort = new AbortController();
    req.once("aborted", () => abort.abort());
    res.once("close", () => { if (!res.writableEnded) abort.abort(); });
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("cache-control", "no-store");
    res.setHeader("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      if (req.headers.host !== origin.host) { res.writeHead(403); res.end("Unrecognized portal host."); return; }
      const url = new URL(req.url ?? "/", origin);
      if (!url.pathname.startsWith("/api/")) {
        if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); res.end(); return; }
        const file = resolve(webDir, `.${decodeURIComponent(url.pathname)}`);
        if (!file.startsWith(webDir + sep) && file !== webDir) { res.writeHead(404); res.end(); return; }
        const target = await stat(file).then((entry) => entry.isFile() ? file : null, () => null) ?? resolve(webDir, "index.html");
        const content = await readFile(target);
        res.setHeader("content-type", mime[extname(target)] ?? "application/octet-stream");
        res.writeHead(200); res.end(req.method === "HEAD" ? undefined : content); return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > MAX_BODY) { res.writeHead(413); res.end("Request too large."); return; }
        chunks.push(Buffer.from(chunk));
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      const proxyIp = req.headers["x-omb-client-ip"];
      headers.delete("x-omb-client-ip");
      // Production listens on a private Unix socket shared only with Caddy.
      // TCP is used by disposable fixtures; its caller cannot claim a forwarded IP.
      const clientIp = req.socket.remoteAddress === undefined && typeof proxyIp === "string" && isIP(proxyIp)
        ? proxyIp : req.socket.remoteAddress;
      if (clientIp) headers.set("x-omb-client-ip", clientIp);
      const request = new Request(url, { method: req.method, headers, signal: abort.signal, ...(bytes ? { body: Buffer.concat(chunks) } : {}) });
      const response = await options.handle(request);
      for (const [name, value] of response.headers) if (name !== "set-cookie") res.setHeader(name, value);
      const cookies = response.headers.getSetCookie();
      if (cookies.length) res.setHeader("set-cookie", cookies);
      res.writeHead(response.status);
      if (response.body) await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), res);
      else res.end();
    } catch {
      if (!res.headersSent) { res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "The portal could not complete this request." })); }
      else res.end();
    }
  }
  const server = createServer((req, res) => { void handle(req, res); });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  return server;
}
