// A relay for tests, following README section 9: host control and data sockets, phone sockets, admission sets,
// splicing, and the close codes. `tamper` lets a test play a malicious relay on spliced bytes.
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";

import { b64u, fromB64u, verifyRelayToken } from "../../src/e2e/credentials.ts";

export type Direction = "toHost" | "toPhone";

interface Host {
  control: WebSocket;
  set: Set<string>;
  pending: Map<string, { phone: WebSocket; admHash: string; timer: ReturnType<typeof setTimeout> }>;
  sessions: Set<{ phone: WebSocket; data: WebSocket; admHash: string }>;
}

export interface FakeRelayOptions {
  keys: Map<string, Uint8Array>;
  port?: number;
  /** Return the bytes to pass on, or null to drop them. */
  tamper?: (direction: Direction, data: Buffer, index: number) => Buffer | null;
}

export interface FakeRelay {
  port: number;
  url: string;
  hosts: Map<string, Host>;
  /** Close codes sent, in order, for assertions. */
  closes: Array<{ kind: string; code: number }>;
  /** Token refreshes accepted on a live control socket. */
  refreshes: number;
  /** Plays a malicious relay on every session spliced from now on; null passes bytes through. */
  tamper: FakeRelayOptions["tamper"] | null;
  admitted(hid: string): Set<string>;
  restart(): void;
  /** Closes every spliced phone socket with `code`, as a malicious relay would, outside the encryption. */
  forgeClose(code: number): void;
  /** Drops every socket without a close frame, as a crashed process would. */
  kill(): Promise<void>;
  close(): Promise<void>;
}

const PROTOCOL = "omb-relay.v1";
const toBuffer = (data: RawData): Buffer => (Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer));

export async function startFakeRelay(options: FakeRelayOptions): Promise<FakeRelay> {
  const hosts = new Map<string, Host>();
  const relay = { refreshes: 0, tamper: options.tamper ?? null } as FakeRelay;
  const closes: FakeRelay["closes"] = [];
  const server = createServer((_req, res) => res.writeHead(404).end());
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 70_000,
    handleProtocols: (protocols) => (protocols.has(PROTOCOL) ? PROTOCOL : false),
  });
  const close = (socket: WebSocket, kind: string, code: number, reason = "") => {
    closes.push({ kind, code });
    if (socket.readyState === WebSocket.OPEN) socket.close(code, reason);
  };
  const now = () => Math.floor(Date.now() / 1000);

  const splice = (host: Host, phone: WebSocket, data: WebSocket, admHash: string) => {
    const session = { phone, data, admHash };
    host.sessions.add(session);
    let toHost = 0;
    let toPhone = 0;
    phone.on("message", (raw, isBinary) => {
      if (!isBinary) return close(phone, "phone", 4400);
      const out = relay.tamper ? relay.tamper("toHost", toBuffer(raw), toHost++) : toBuffer(raw);
      if (out && data.readyState === WebSocket.OPEN) data.send(out);
    });
    data.on("message", (raw, isBinary) => {
      if (!isBinary) return close(data, "data", 4400);
      const out = relay.tamper ? relay.tamper("toPhone", toBuffer(raw), toPhone++) : toBuffer(raw);
      if (out && phone.readyState === WebSocket.OPEN) phone.send(out);
    });
    const end = (other: WebSocket) => (code: number) => {
      host.sessions.delete(session);
      if (other.readyState === WebSocket.OPEN) other.close(code >= 3000 && code <= 4999 ? code : 1000);
    };
    phone.on("close", end(data));
    data.on("close", end(phone));
    phone.send(JSON.stringify({ t: "ready" }));
  };

  const onFirst = (socket: WebSocket, kind: string, handle: (message: Record<string, unknown>) => void) => {
    const timer = setTimeout(() => close(socket, kind, 4400), 5_000);
    socket.once("message", (raw, isBinary) => {
      clearTimeout(timer);
      if (isBinary || toBuffer(raw).length > 4096) return close(socket, kind, 4400);
      try {
        handle(JSON.parse(toBuffer(raw).toString("utf8")) as Record<string, unknown>);
      } catch {
        close(socket, kind, 4400);
      }
    });
  };

  const hostControl = (socket: WebSocket) =>
    onFirst(socket, "host", (message) => {
      if (message.t !== "auth" || typeof message.token !== "string") return close(socket, "host", 4400);
      const verified = verifyRelayToken(message.token, options.keys, now());
      if (!verified.ok) return close(socket, "host", 4401);
      const hid = verified.claims.hid;
      const previous = hosts.get(hid);
      if (previous) close(previous.control, "host", 4409);
      const host: Host = { control: socket, set: new Set(), pending: new Map(), sessions: previous?.sessions ?? new Set() };
      hosts.set(hid, host);
      socket.send(JSON.stringify({ t: "hello", v: 1, node: "relay1", sessionsMax: 16 }));
      socket.on("message", (raw, isBinary) => {
        if (isBinary) return close(socket, "host", 4400);
        const next = JSON.parse(toBuffer(raw).toString("utf8")) as Record<string, unknown>;
        if (next.t === "auth") {
          const refreshed = typeof next.token === "string" ? verifyRelayToken(next.token, options.keys, now(), hid) : null;
          if (!refreshed?.ok) close(socket, "host", 4401);
          else relay.refreshes += 1;
        } else if (next.t === "admit" && Array.isArray(next.set) && next.set.length <= 32) {
          host.set = new Set(next.set as string[]);
          for (const session of host.sessions) {
            if (!host.set.has(session.admHash)) close(session.phone, "phone", 4404);
          }
        } else {
          close(socket, "host", 4400);
        }
      });
      socket.on("close", () => {
        if (hosts.get(hid) === host) hosts.delete(hid);
      });
    });

  const hostData = (socket: WebSocket) =>
    onFirst(socket, "data", (message) => {
      const verified = typeof message.token === "string" ? verifyRelayToken(message.token, options.keys, now()) : null;
      if (message.t !== "data" || !verified?.ok || typeof message.sid !== "string") return close(socket, "data", 4401);
      const host = hosts.get(verified.claims.hid);
      const pending = host?.pending.get(message.sid);
      if (!host || !pending) return close(socket, "data", 4404);
      host.pending.delete(message.sid);
      clearTimeout(pending.timer);
      splice(host, pending.phone, socket, pending.admHash);
    });

  const phoneSocket = (socket: WebSocket) =>
    onFirst(socket, "phone", (message) => {
      const adm = typeof message.adm === "string" ? fromB64u(message.adm) : null;
      const host = typeof message.hid === "string" ? hosts.get(message.hid) : undefined;
      const admHash = adm ? b64u(createHash("sha256").update(adm).digest()) : "";
      if (message.t !== "phone" || message.v !== 1 || !host || !host.set.has(admHash)) return close(socket, "phone", 4404);
      const sid = b64u(randomBytes(16));
      const timer = setTimeout(() => {
        host.pending.delete(sid);
        close(socket, "phone", 4408);
      }, 10_000);
      host.pending.set(sid, { phone: socket, admHash, timer });
      socket.on("message", (_raw, isBinary) => {
        if (host.pending.has(sid) && isBinary) close(socket, "phone", 4400);
      });
      host.control.send(JSON.stringify({ t: "open", sid }));
    });

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = new URL(req.url ?? "/", "http://relay").pathname;
    const handler = { "/v1/host": hostControl, "/v1/host/data": hostData, "/v1/phone": phoneSocket }[path];
    if (!handler) return void socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => handler(ws));
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  Object.assign(relay, {
    port,
    url: `ws://127.0.0.1:${port}`,
    hosts,
    closes,
    admitted: (hid: string) => hosts.get(hid)?.set ?? new Set<string>(),
    restart() {
      for (const host of hosts.values()) host.control.send(JSON.stringify({ t: "restarting", reconnectInMs: 0, tryForMs: 200 }));
    },
    forgeClose(code: number) {
      for (const host of hosts.values()) for (const session of host.sessions) session.phone.close(code);
    },
    async kill() {
      for (const client of wss.clients) client.terminate();
      hosts.clear();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    async close() {
      for (const client of wss.clients) client.terminate();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  });
  return relay;
}
