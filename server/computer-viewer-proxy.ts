// computer-viewer-proxy — transparent HTTP+WS reverse proxy from
// /api/computer-viewer/:port/* to the loopback-only noVNC/websockify
// endpoint a Local VM container publishes (see container-computer.ts,
// INTERNAL_VIEWER_PORT). This is what lets the viewer work over Tailscale
// (or any remote client of the main server) without the container itself
// ever leaving 127.0.0.1 — the container's own "loopback only" hardening
// check is untouched, the proxy just rides inside the already-authenticated
// main server process.
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { connect as netConnect } from "node:net";
import type { Duplex } from "node:stream";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** Ports the server has actually handed out as a viewer_url this process
 * lifetime. Proxying is refused for anything else, so an authenticated
 * session can't turn this into a generic localhost port scanner. */
export const knownViewerPorts = new Set<number>();

function filteredHeaders(headers: IncomingMessage["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP.has(key.toLowerCase())) continue;
    out[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

export function proxyViewerRequest(req: IncomingMessage, res: ServerResponse, port: number, subPath: string): void {
  const upstream = httpRequest(
    { host: "127.0.0.1", port, path: subPath, method: req.method, headers: filteredHeaders(req.headers) },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end("computer viewer unreachable");
  });
  req.pipe(upstream);
}

export function proxyViewerUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, port: number, subPath: string): void {
  const upstream = netConnect(port, "127.0.0.1", () => {
    const lines = [`${req.method} ${subPath} HTTP/1.1`];
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      for (const one of Array.isArray(value) ? value : [value]) lines.push(`${key}: ${one}`);
    }
    upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head?.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
}
