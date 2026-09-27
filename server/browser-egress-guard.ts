// The built-in browser's only way out of a member workspace.
//
// A member's browser runs on this machine, beside the founder desk and every
// other workspace server, each of which listens on loopback. Chrome is
// started with this proxy for every request, loopback included (see
// memberBrowserLaunch in index.ts), so a page, a script or the agent reaches
// public web servers and nothing else. This machine's own servers, private
// networks and cloud metadata are refused after DNS resolution, by the same
// rule as web_read (nation-web-tools.ts). A connection goes to the address
// that was checked, never to a second lookup, so a name that re-resolves to
// loopback between check and connect still cannot get through.
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { createServer, request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from "node:http";
import { connect, isIP, type AddressInfo, type Socket } from "node:net";

import { blockedAddress } from "./nation-web-tools.ts";

export const EGRESS_REFUSED = "NATION blocked this address. The browser reaches public websites only.";

/** Chrome flags that keep it on the proxy: loopback is proxied too (Chrome
 * otherwise sends it direct), and WebRTC may not open its own UDP paths. */
export const MEMBER_BROWSER_PROXY_BYPASS = "<-loopback>";
export const MEMBER_BROWSER_CHROME_ARGS = "--force-webrtc-ip-handling-policy=disable_non_proxied_udp";

const IDLE_MS = 120_000;

export interface EgressGuardOptions {
  /** Resolve a host name to every address it has (the system resolver by default). */
  lookup?: (host: string) => Promise<LookupAddress[]>;
  /** Tests only: exact `host:port` pairs that may be reached although private.
   * The server never passes it. */
  allow?: ReadonlySet<string>;
  log?: (line: string) => void;
}

export interface EgressGuard {
  /** `http://127.0.0.1:<port>` for Chrome's proxy setting. */
  url: string;
  close(): Promise<void>;
}

function systemLookup(host: string): Promise<LookupAddress[]> {
  return new Promise((resolve, reject) => {
    dnsLookup(host, { all: true, verbatim: true }, (error, addresses) => (error ? reject(error) : resolve(addresses)));
  });
}

/** Where a request for host:port may go: one checked address, or null. */
export async function egressTarget(
  host: string,
  port: number,
  options: Pick<EgressGuardOptions, "lookup" | "allow"> = {},
): Promise<{ address: string; family: 4 | 6 } | null> {
  const name = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (!name || !Number.isInteger(port) || port < 1 || port > 65_535) return null;
  const allowed = options.allow?.has(`${name}:${port}`) === true;
  const literal = isIP(name);
  if (literal) return allowed || !blockedAddress(name) ? { address: name, family: literal as 4 | 6 } : null;
  let addresses: LookupAddress[];
  try {
    addresses = await (options.lookup ?? systemLookup)(name);
  } catch {
    return null;
  }
  // Every address a name has must be public: a resolver may answer either.
  if (!addresses.length || (!allowed && addresses.some((entry) => blockedAddress(entry.address)))) return null;
  const first = addresses[0]!;
  return { address: first.address, family: first.family === 6 ? 6 : 4 };
}

function splitHostPort(authority: string): { host: string; port: number } | null {
  const match = /^(\[[^\]]+\]|[^:[\]]+):(\d{1,5})$/.exec(authority.trim());
  return match ? { host: match[1]!, port: Number(match[2]) } : null;
}

const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection",
  "te", "trailer", "transfer-encoding", "upgrade",
]);

function forwardedHeaders(headers: IncomingMessage["headers"]): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !HOP_BY_HOP.has(name.toLowerCase())) out[name] = value;
  }
  return out;
}

function refuse(res: ServerResponse, status = 403, message = EGRESS_REFUSED): void {
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", connection: "close" });
  res.end(message);
}

/** Start a guard on a loopback port of its own. */
export async function startEgressGuard(options: EgressGuardOptions = {}): Promise<EgressGuard> {
  const log = options.log ?? (() => {});
  const sockets = new Set<Socket>();
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.setTimeout(IDLE_MS, () => socket.destroy());
    socket.once("close", () => sockets.delete(socket));
  };

  const server = createServer(async (req, res) => {
    // A proxy request names its target in absolute form: http://host:port/path.
    let target: URL;
    try {
      target = new URL(req.url ?? "");
    } catch {
      return refuse(res, 400, "This proxy only forwards browser requests.");
    }
    if (target.protocol !== "http:" || target.username || target.password) return refuse(res, 400, "This proxy only forwards browser requests.");
    const port = target.port ? Number(target.port) : 80;
    const destination = await egressTarget(target.hostname, port, options);
    if (!destination) {
      log(`browser egress refused: http ${target.hostname}:${port}`);
      return refuse(res);
    }
    const upstream = httpRequest({
      host: destination.address,
      family: destination.family,
      port,
      method: req.method,
      path: `${target.pathname}${target.search}`,
      headers: forwardedHeaders(req.headers),
      setHost: false,
    }, (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.statusMessage, forwardedHeaders(answer.headers) as Record<string, string | string[]>);
      answer.pipe(res);
    });
    upstream.setTimeout(IDLE_MS, () => upstream.destroy(new Error("timeout")));
    upstream.on("error", () => refuse(res, 502, "The website could not be reached."));
    req.pipe(upstream);
  });
  server.on("connection", track);

  // HTTPS and WebSockets tunnel through CONNECT host:port.
  server.on("connect", async (req: IncomingMessage, client: Socket, head: Buffer) => {
    client.on("error", () => client.destroy());
    const authority = splitHostPort(req.url ?? "");
    const destination = authority ? await egressTarget(authority.host, authority.port, options) : null;
    if (!authority || !destination) {
      log(`browser egress refused: connect ${req.url ?? ""}`);
      client.end("HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\nconnection: close\r\n\r\n" + EGRESS_REFUSED);
      return;
    }
    const upstream = connect({ host: destination.address, port: authority.port, family: destination.family });
    track(upstream);
    upstream.once("connect", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on("error", () => {
      if (!client.destroyed) client.end("HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\n\r\n");
    });
    client.once("close", () => upstream.destroy());
  });

  // A WebSocket in absolute form would bypass CONNECT; browsers tunnel them.
  server.on("upgrade", (_req: IncomingMessage, socket: Socket) => {
    socket.end("HTTP/1.1 403 Forbidden\r\nconnection: close\r\n\r\n");
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    }),
  };
}
