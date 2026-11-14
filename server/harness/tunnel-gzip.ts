// Gzips large JSON replies on a phone tunnel listener, and nowhere else. That hop runs over the user's home upload to
// Cloudflare, uncompressed; Cloud and VPS routes already pass Caddy's `encode`, and loopback would only spend CPU.
// This file is both server/harness/tunnel-gzip.ts and companion/src/tunnel-gzip.ts, since the companion builds alone;
// a test keeps the two equal.
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "node:http";
import { gzip } from "node:zlib";

/** Below this, the gzip framing and a zlib pass cost more than they save. */
export const GZIP_MIN_BYTES = 1024;
const JSON_TYPE = /^application\/json\s*(;|$)/i;
const tunnelReplies = new WeakSet<ServerResponse>();

/** Wraps a tunnel listener's request handler. WebSocket upgrades are a separate server event and never pass here. */
export function gzipTunnelReplies<T>(handle: (req: IncomingMessage, res: ServerResponse) => T) {
  return (req: IncomingMessage, res: ServerResponse): T => {
    tunnelReplies.add(res);
    return handle(req, res);
  };
}

/** Whether Accept-Encoding takes gzip: named, or covered by `*`, with a q above 0. A named gzip outranks `*`. */
export function acceptsGzip(header: string | string[] | undefined): boolean {
  let named: number | undefined;
  let wildcard: number | undefined;
  for (const entry of [header ?? ""].flat().join(",").split(",")) {
    const [coding, ...params] = entry.split(";").map((part) => part.trim().toLowerCase());
    const q = params.find((param) => param.startsWith("q="));
    const weight = q === undefined ? 1 : Number(q.slice(2));
    if (coding === "gzip" || coding === "x-gzip") named = weight;
    else if (coding === "*") wildcard = weight;
  }
  return (named ?? wildcard ?? 0) > 0;
}

/** `vary` with Accept-Encoding added once; `*` already covers it. */
export function varyOnEncoding(vary: number | string | string[] | undefined): string {
  const names = [vary ?? ""].flat().join(",").split(",").map((name) => name.trim()).filter(Boolean);
  if (!names.some((name) => name === "*" || name.toLowerCase() === "accept-encoding")) names.push("Accept-Encoding");
  return names.join(", ");
}

/** A JSON body on a tunnel listener, with a body to send, that nothing has encoded yet. Other listeners stop at the
 * first check, before the body is measured. */
export function gzipCandidate(res: ServerResponse, status: number, headers: OutgoingHttpHeaders, body: string): boolean {
  return tunnelReplies.has(res) && res.req.method !== "HEAD" && status !== 204 && status !== 304
    && JSON_TYPE.test(String(headers["content-type"] ?? "")) && !headers["content-encoding"] && !res.hasHeader("content-encoding")
    // JSON.stringify(undefined) is undefined, whatever its type says.
    && typeof body === "string" && Buffer.byteLength(body) >= GZIP_MIN_BYTES;
}

/** Sends a whole JSON `body` (headers carry no Content-Length), gzipped when the client takes gzip. False means it is
 * not a candidate and nothing was sent: the caller replies exactly as it did before. */
export function sendTunnelJson(res: ServerResponse, status: number, headers: OutgoingHttpHeaders, body: string): boolean {
  if (!gzipCandidate(res, status, headers, body)) return false;
  const vary = varyOnEncoding(headers.vary ?? res.getHeader("vary"));
  if (!acceptsGzip(res.req.headers["accept-encoding"])) {
    res.writeHead(status, { ...headers, vary, "content-length": Buffer.byteLength(body) }).end(body);
    return true;
  }
  // Headers now, so the reply counts as answered at once; the body once zlib, off the event loop, is done.
  // Ending a response whose client already left is a no-op.
  res.writeHead(status, { ...headers, vary, "content-encoding": "gzip" });
  gzip(body, (error, zipped) => (error ? res.destroy() : res.end(zipped)));
  return true;
}
