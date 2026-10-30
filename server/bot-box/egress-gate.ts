// The box's way to the internet: an HTTP proxy (CONNECT for TLS, absolute-URI for plain HTTP) on a unix socket that a
// loopback port inside the box is bridged to. Like the browser's SOCKS gate (server/browser/egress/gate.ts) it resolves
// names itself and connects only to public addresses, so a bot's shell reaches neither this server's loopback routes,
// the local network, the cloud metadata service nor Fly's private network, whatever name it uses.
import { createServer, request as httpRequest, type ClientRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect, type Socket } from "node:net";
import type { Duplex } from "node:stream";

import { resolveTarget, type ResolvedAddress } from "../browser/egress/gate.ts";
import { refusalFor, type EgressRules } from "../browser/egress/policy.ts";

export interface EgressGateOptions {
  socketPath: string;
  /** Why `target` is refused, or null; the default is the Cloud policy: public addresses only. */
  decide?(target: { host: string; port: number }, addresses: readonly ResolvedAddress[]): Promise<string | null>;
  resolve?(host: string): Promise<ResolvedAddress[]>;
  onRefusal?(target: { host: string; port: number }, reason: string): void;
}

export interface BoxEgressGate {
  socketPath: string;
  refused: number;
  close(): Promise<void>;
}

/** The box's rules: nothing on this machine, nothing private, nothing reserved; only the public internet. */
export const BOX_EGRESS_RULES: EgressRules = {
  host: "cloud",
  ownPort: () => true,
  botPort: async () => false,
  localNetwork: false,
  allowed: () => false,
};

export const boxRefusal = (target: { host: string; port: number }, addresses: readonly ResolvedAddress[]) => refusalFor(target, addresses, BOX_EGRESS_RULES);

const HOP_BY_HOP = new Set(["proxy-connection", "proxy-authorization", "connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade"]);

function parseConnectTarget(raw: string | undefined): { host: string; port: number } | null {
  if (!raw) return null;
  const match = /^\[([^\]]+)\]:(\d{1,5})$/.exec(raw) ?? /^([^:]+):(\d{1,5})$/.exec(raw);
  if (!match) return null;
  const port = Number(match[2]);
  return port >= 1 && port <= 65_535 ? { host: match[1]!, port } : null;
}

export function openBoxEgressGate(options: EgressGateOptions): Promise<BoxEgressGate> {
  const decide = options.decide ?? boxRefusal;
  const resolve = options.resolve ?? resolveTarget;
  const sockets = new Set<Socket | Duplex | ClientRequest>();
  const track = <T extends Socket | Duplex | ClientRequest>(socket: T): T => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    return socket;
  };
  const gate = { socketPath: options.socketPath, refused: 0 } as BoxEgressGate;
  const refuse = (target: { host: string; port: number }, reason: string) => {
    gate.refused += 1;
    options.onRefusal?.(target, reason);
  };
  const check = async (target: { host: string; port: number }): Promise<{ addresses: ResolvedAddress[] } | { refused: string } | { unresolved: true }> => {
    const addresses = await resolve(target.host);
    if (!addresses.length) return { unresolved: true };
    const refusal = await decide(target, addresses).catch(() => "error");
    if (refusal !== null) { refuse(target, refusal); return { refused: refusal }; }
    return { addresses };
  };
  const pinnedLookup = (addresses: ResolvedAddress[]) => (_host: string, lookupOptions: { all?: boolean }, callback: (...args: any[]) => void) =>
    lookupOptions.all ? callback(null, addresses) : callback(null, addresses[0]!.address, addresses[0]!.family);

  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    track(req.socket);
    let url: URL;
    try {
      url = new URL(req.url ?? "");
      if (url.protocol !== "http:") throw new Error();
    } catch {
      res.writeHead(400, { "content-type": "text/plain" }).end("The box's network gate takes absolute http:// URLs or CONNECT.\n");
      return;
    }
    const target = { host: url.hostname.replace(/^\[|\]$/g, ""), port: Number(url.port || 80) };
    const verdict = await check(target);
    if (req.socket.destroyed) return;
    if ("refused" in verdict) { res.writeHead(403, { "content-type": "text/plain" }).end(`Blocked by the box's network gate: ${verdict.refused}.\n`); return; }
    if ("unresolved" in verdict) { res.writeHead(502, { "content-type": "text/plain" }).end("The name could not be resolved.\n"); return; }
    const headers: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(req.headers)) if (value !== undefined && !HOP_BY_HOP.has(name)) headers[name] = value;
    const upstream = track(httpRequest({
      host: target.host, port: target.port, method: req.method, path: `${url.pathname}${url.search}`, headers,
      lookup: pinnedLookup(verdict.addresses) as never,
    }, (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(res);
    }));
    res.on("close", () => { if (!res.writableFinished) upstream.destroy(); });
    upstream.on("error", () => { if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" }).end("The connection failed.\n"); else res.destroy(); });
    req.pipe(upstream);
  });
  server.on("connect", async (req: IncomingMessage, client: Duplex, head: Buffer) => {
    track(client);
    const target = parseConnectTarget(req.url);
    if (!target) { client.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"); return; }
    const verdict = await check(target);
    if (client.destroyed) return;
    if ("refused" in verdict) { client.end(`HTTP/1.1 403 Forbidden\r\nX-Omb-Blocked: ${verdict.refused}\r\nConnection: close\r\n\r\n`); return; }
    if ("unresolved" in verdict) { client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n"); return; }
    const upstream = track(connect({ host: target.host, port: target.port, autoSelectFamily: true, lookup: pinnedLookup(verdict.addresses) as never }));
    let connected = false;
    upstream.once("connect", () => {
      connected = true;
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.once("error", () => { if (!connected && !client.destroyed) client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n"); });
    upstream.on("close", () => client.destroy());
    client.on("close", () => upstream.destroy());
  });
  return new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(options.socketPath, () => {
      server.off("error", fail);
      server.on("error", () => {});
      gate.close = () => new Promise<void>((closed) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => closed());
      });
      done(gate);
    });
  });
}
