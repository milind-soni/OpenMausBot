// The home's end of a browser session on the bot's cloud computer: a loopback DevTools address the browser engine attaches
// to (as it does to a lent Chrome, browser/lent-chrome.ts), whose connection is carried as one held-open WebSocket to the
// computer's door through the provider's relay. Per action that adds one network round trip, never a provider API call.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { connect as netConnect, createServer, type Server, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";

const MAX_HEAD_BYTES = 16 * 1024;
const HEAD_MS = 10_000;
const PATH_PREFIX = "/devtools/browser/";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Where the computer's door is: the relay's URL (with its access token) and this open's secret path. */
export interface DoorTarget {
  url: URL;
  secret: string;
}

/** The relay URL, if it is one the home may dial: HTTPS, or plain HTTP to a loopback address (a test's computer). */
export function dialable(raw: string): URL | null {
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.username || url.password) return null;
  if (url.protocol === "https:") return url;
  return url.protocol === "http:" && LOOPBACK.has(url.hostname) ? url : null;
}

/** The request the computer's door gets: its secret path with the relay's token, the relay's host, and the engine's own
 * WebSocket headers. Origin is dropped: Chrome refuses a DevTools connection that names one it was not told to allow. */
export function rewrittenHead(head: Buffer, target: DoorTarget): Buffer {
  const lines = head.toString("latin1").split("\r\n").filter(Boolean);
  const kept = lines.slice(1).filter((line) => !/^(host|origin):/i.test(line));
  const query = target.url.search;
  return Buffer.from([`GET /${target.secret}${query} HTTP/1.1`, `Host: ${target.url.host}`, ...kept, "", ""].join("\r\n"), "latin1");
}

interface Door { server: Server; url: string; token: Buffer; target: DoorTarget; connections: Set<Socket>; lastActivity: number; dialed: number }

function answer(socket: Socket, status: string): void {
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () => socket.destroy());
}

function dial(url: URL): Socket {
  const port = Number(url.port) || (url.protocol === "https:" ? 443 : 80);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  return url.protocol === "https:" ? tlsConnect({ host, port, servername: host }) : netConnect({ host, port });
}

/** Proves a target answers a WebSocket upgrade with a 101 before a session is committed to it. */
export function probeDoor(target: DoorTarget, timeoutMs = 10_000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = dial(target.url);
    const ready = target.url.protocol === "https:" ? "secureConnect" : "connect";
    let seen = Buffer.alloc(0);
    const done = (ok: boolean) => { clearTimeout(timer); socket.destroy(); resolve(ok); };
    const timer = setTimeout(() => done(false), timeoutMs);
    timer.unref?.();
    socket.once("error", () => done(false));
    socket.on("data", (chunk: Buffer) => {
      seen = Buffer.concat([seen, chunk]);
      if (seen.length >= 12) done(seen.subarray(0, 12).toString("latin1") === "HTTP/1.1 101");
    });
    const key = randomBytes(16).toString("base64");
    socket.once(ready, () => socket.write(rewrittenHead(Buffer.from(`GET / HTTP/1.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`, "latin1"), target)));
  });
}

export class CloudBrowserDoors {
  readonly #doors = new Map<string, Door>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) { this.#now = now; }

  async open(session: string, target: DoorTarget): Promise<string> {
    this.close(session);
    const token = randomBytes(32);
    const connections = new Set<Socket>();
    const door: Door = { server: createServer(), url: "", token, target, connections, lastActivity: this.#now(), dialed: 0 };
    door.server.on("connection", (socket) => {
      connections.add(socket);
      socket.on("close", () => connections.delete(socket));
      socket.on("error", () => socket.destroy());
      this.#serve(door, socket);
    });
    await new Promise<void>((resolve, reject) => {
      door.server.once("error", reject);
      door.server.listen(0, "127.0.0.1", () => { door.server.off("error", reject); door.server.on("error", () => {}); resolve(); });
    });
    const address = door.server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    door.url = `ws://127.0.0.1:${port}${PATH_PREFIX}${token.toString("hex")}`;
    this.#doors.set(session, door);
    return door.url;
  }

  url(session: string): string | null { return this.#doors.get(session)?.url ?? null; }
  sessions(): string[] { return [...this.#doors.keys()]; }
  /** When bytes last crossed this session's door either way: its browser's last activity. */
  lastActivity(session: string): number | null { return this.#doors.get(session)?.lastActivity ?? null; }
  /** How many connections to the computer this session's door has made. */
  dialed(session: string): number { return this.#doors.get(session)?.dialed ?? 0; }

  close(session: string): void {
    const door = this.#doors.get(session);
    if (!door) return;
    this.#doors.delete(session);
    for (const socket of door.connections) socket.destroy();
    door.server.close();
  }

  closeAll(): void { for (const session of this.#doors.keys()) this.close(session); }

  #serve(door: Door, socket: Socket): void {
    let data = Buffer.alloc(0);
    const timer = setTimeout(() => socket.destroy(), HEAD_MS);
    timer.unref?.();
    socket.once("close", () => clearTimeout(timer));
    const onData = (chunk: Buffer) => {
      data = Buffer.concat([data, chunk]);
      const end = data.indexOf("\r\n\r\n");
      if (end === -1) { if (data.length > MAX_HEAD_BYTES) socket.destroy(); return; }
      socket.off("data", onData);
      clearTimeout(timer);
      const path = data.subarray(0, data.indexOf("\r\n")).toString("latin1").split(" ")[1] ?? "";
      const given = Buffer.from(path.startsWith(PATH_PREFIX) ? path.slice(PATH_PREFIX.length) : "", "latin1");
      const expected = Buffer.from(door.token.toString("hex"), "latin1");
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) return answer(socket, "404 Not Found");
      socket.pause();
      this.#join(door, socket, data.subarray(0, end + 4), data.subarray(end + 4));
    };
    socket.on("data", onData);
  }

  #join(door: Door, socket: Socket, head: Buffer, rest: Buffer): void {
    const upstream = dial(door.target.url);
    door.dialed += 1;
    door.connections.add(upstream);
    const touch = () => { door.lastActivity = this.#now(); };
    upstream.on("close", () => { door.connections.delete(upstream); socket.destroy(); });
    upstream.on("error", () => upstream.destroy());
    socket.on("close", () => upstream.destroy());
    upstream.once(door.target.url.protocol === "https:" ? "secureConnect" : "connect", () => {
      upstream.write(rewrittenHead(head, door.target));
      if (rest.length) upstream.write(rest);
      socket.on("data", touch);
      upstream.on("data", touch);
      socket.pipe(upstream);
      upstream.pipe(socket);
      socket.resume();
    });
  }
}
