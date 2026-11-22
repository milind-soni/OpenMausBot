// The full web app over the desktop's encrypted connection. A paired device that also holds a session of the web server
// (`omb_sess_…`, issued by the server's own pairing) reaches every route that session may use, not only the phone app's.
// The server decides what the session may do; the companion only carries the request, as a remote one.
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

import { bearerToken } from "./devices.ts";
import type { E2EContext } from "./e2e/registry.ts";

/** What a page sends to sign in with the server's pairing code; the reply is the session token it uses from then on. */
const SERVER_PAIRING = "POST /api/auth/pair";
const HOP_BY_HOP = ["connection", "keep-alive", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade"];
/** Hop-by-hop headers of one message (RFC 9110 section 7.6.1): the fixed ones and every name its Connection header lists. */
function hopByHop(headers: IncomingHttpHeaders): Set<string> {
  const names = new Set(HOP_BY_HOP);
  for (const name of String(headers.connection ?? "").split(",")) {
    const nominated = name.trim().toLowerCase();
    if (nominated) names.add(nominated);
  }
  return names;
}
/** Never forwarded besides the hop-by-hop headers: everything that names a client or carries this machine's trust. */
const DROPPED = new Set([
  "host", "origin", "cookie", "proxy-authorization",
  "x-forwarded-for", "x-forwarded-proto", "x-forwarded-host", "forwarded", "x-real-ip", "cf-connecting-ip",
  "true-client-ip", "x-client-ip",
]);
const HOST = "companion-relay.invalid";

/** The device whose request goes to the web server as a remote one, or null: the companion's own surface answers it. */
export function webSessionPeer(context: E2EContext | null, req: IncomingMessage): string | null {
  if (context?.peer.kind !== "device") return null;
  const token = bearerToken(req.headers.authorization);
  if (token) return token.startsWith("omb_sess_") ? context.peer.id : null;
  return `${req.method ?? "GET"} ${(req.url ?? "/").split("?")[0]}` === SERVER_PAIRING ? context.peer.id : null;
}

/** Security: the harness trusts a loopback request as the owner, so this one is marked as proxied (the server then needs
 * its session) and keeps nothing the device wrote that names a client, a cookie or the desktop's own credentials. */
export function webSessionHeaders(req: IncomingMessage, deviceId: string, upgrade = false): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  const hop = hopByHop(req.headers);
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || hop.has(name) || DROPPED.has(name) || name.startsWith("x-openmausbot-")) continue;
    out[name] = value;
  }
  out.host = HOST;
  out["x-forwarded-for"] = `relay-${deviceId.slice(0, 48)}`;
  if (upgrade && req.headers.upgrade) Object.assign(out, { connection: "Upgrade", upgrade: String(req.headers.upgrade) });
  return out;
}

/** `http.request` has no deadline of its own for the headers phase. */
function headersDeadline(upstream: ReturnType<typeof httpRequest>, ms: number) {
  let fired = false;
  const deadline = setTimeout(() => {
    fired = true;
    upstream.destroy(new Error("the harness sent no response headers"));
  }, ms);
  deadline.unref?.();
  return { deadline, timedOut: () => fired };
}

const reply = (res: ServerResponse, status: number, error: string) => {
  const body = JSON.stringify({ error });
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) }).end(body);
};

/** Where the harness listens, and how long it may take to answer (the proxy's own deadline for that path). */
export type WebSessionTarget = { harnessPort: number; headersTimeoutMs: number };

export function forwardWebSession(target: WebSessionTarget, deviceId: string, req: IncomingMessage, res: ServerResponse): void {
  const upstream = httpRequest(
    { hostname: "127.0.0.1", port: target.harnessPort, path: req.url, method: req.method, headers: webSessionHeaders(req, deviceId) },
    (harness) => {
      clearTimeout(deadline);
      const hop = hopByHop(harness.headers);
      const headers = Object.fromEntries(Object.entries(harness.headers).filter(([name]) => !hop.has(name)));
      res.writeHead(harness.statusCode ?? 502, harness.statusMessage, headers);
      harness.pipe(res);
      // pipe() ends the reply only on a complete body: a harness that drops mid-reply must not leave the device waiting.
      harness.once("close", () => { if (!harness.complete) res.destroy(); });
    },
  );
  const { deadline, timedOut } = headersDeadline(upstream, target.headersTimeoutMs);
  upstream.once("error", () => {
    clearTimeout(deadline);
    if (res.headersSent) res.destroy();
    else if (timedOut()) reply(res, 504, "OpenMausBot did not respond");
    else reply(res, 502, "OpenMausBot is not running on this computer");
  });
  // Also before the reply starts: a device that leaves must not keep a stream open on the server.
  res.once("close", () => upstream.destroy());
  req.pipe(upstream);
}

/** A raw response head; `skip` names headers (lower case) left out. */
function responseHead(status: number, message: string, rawHeaders: string[], skip: ReadonlySet<string> = new Set(), extra = ""): string {
  const lines = [`HTTP/1.1 ${status} ${message}`];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (!skip.has(rawHeaders[index].toLowerCase())) lines.push(`${rawHeaders[index]}: ${rawHeaders[index + 1]}`);
  }
  if (extra) lines.push(extra);
  return `${lines.join("\r\n")}\r\n\r\n`;
}

export function forwardWebSessionUpgrade(target: WebSessionTarget, deviceId: string, req: IncomingMessage, socket: Duplex, head: Buffer): void {
  const upstream = httpRequest({ hostname: "127.0.0.1", port: target.harnessPort, path: req.url, method: req.method, headers: webSessionHeaders(req, deviceId, true) });
  const { deadline, timedOut } = headersDeadline(upstream, target.headersTimeoutMs);
  let answered = false;
  upstream.once("upgrade", (harness, harnessSocket, harnessHead) => {
    clearTimeout(deadline);
    answered = true;
    if (socket.destroyed) return harnessSocket.destroy();
    const upgrade = `connection: Upgrade\r\nupgrade: ${String(harness.headers.upgrade ?? req.headers.upgrade)}`;
    socket.write(responseHead(harness.statusCode ?? 101, harness.statusMessage ?? "Switching Protocols", harness.rawHeaders, hopByHop(harness.headers), upgrade));
    if (harnessHead.length) socket.write(harnessHead);
    if (head.length) harnessSocket.write(head);
    harnessSocket.pipe(socket).pipe(harnessSocket);
    const close = () => {
      harnessSocket.destroy();
      socket.destroy();
    };
    harnessSocket.once("close", close);
    socket.once("close", close);
    harnessSocket.once("error", close);
    socket.once("error", close);
  });
  upstream.once("response", (harness) => {
    clearTimeout(deadline);
    answered = true;
    // Refused: the body is read to its end, then the socket closes (no chunked framing is passed on).
    socket.write(responseHead(harness.statusCode ?? 502, harness.statusMessage ?? "", harness.rawHeaders, hopByHop(harness.headers), "connection: close"));
    harness.pipe(socket);
    harness.once("close", () => { if (!harness.complete) socket.destroy(); });
  });
  upstream.once("error", () => {
    clearTimeout(deadline);
    if (!answered && socket.writable) socket.end(responseHead(timedOut() ? 504 : 502, timedOut() ? "Gateway Timeout" : "Bad Gateway", [], undefined, "connection: close"));
    else socket.destroy();
  });
  socket.once("close", () => upstream.destroy());
  upstream.end();
}
