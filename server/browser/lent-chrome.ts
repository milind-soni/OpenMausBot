import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";

import type { ChromeRoute } from "../device-links.ts";

export type LentChromeProblem = "offline" | "not-lent" | "no-chrome" | "unreachable" | "not-allowed";
export type ChromeLender = { name: string; device: "PC" | "Mac" | "computer"; online: boolean };

export interface LentChromeDeps {
  route(): ChromeRoute | null;
  /** Whether the session's last holder may use the lent computer (lentDevice's rule). */
  allowed(session: string): boolean;
  idleMs(): number;
  /** For tests; real timers otherwise. */
  sweepMs?: number;
}

const MAX_HEAD_BYTES = 16 * 1024;
const HEAD_MS = 10_000;
const PATH_PREFIX = "/devtools/browser/";

interface Door { server: Server; url: string; token: Buffer; connections: Set<Socket> }
interface Joined { session: string; bytes: number; at: number }

function answer(socket: Socket, status: string): void {
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () => socket.destroy());
}

const UPGRADED = Buffer.from("HTTP/1.1 101");

/** Tells once whether the first bytes written to `socket` start a WebSocket upgrade; every byte is written as it came. */
function watchUpgrade(socket: Socket, answered: (upgraded: boolean) => void): void {
  const write = socket.write as (...args: unknown[]) => boolean;
  let seen = Buffer.alloc(0);
  socket.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    seen = Buffer.concat([seen, Buffer.from(chunk)]);
    const head = seen.subarray(0, UPGRADED.length);
    if (head.length === UPGRADED.length || !head.equals(UPGRADED.subarray(0, head.length))) {
      socket.write = write as Socket["write"];
      answered(head.equals(UPGRADED));
    }
    return write.call(socket, chunk, ...rest);
  }) as Socket["write"];
}

export class LentChromeDoors {
  readonly #deps: LentChromeDeps;
  readonly #doors = new Map<string, Promise<Door>>();
  readonly #problems = new Map<string, LentChromeProblem>();
  readonly #joined = new Map<Socket, Joined>();
  #sweep: NodeJS.Timeout | null = null;

  constructor(deps: LentChromeDeps) { this.#deps = deps; }

  door(session: string): Promise<string> {
    let door = this.#doors.get(session);
    if (!door) {
      door = this.#start(session);
      this.#doors.set(session, door);
      door.catch(() => this.#doors.delete(session));
    }
    return door.then((opened) => opened.url);
  }

  owns(session: string): boolean { return this.#doors.has(session); }

  /** Ends every open connection of that session; the next one is checked afresh. */
  drop(session: string): void {
    void this.#doors.get(session)?.then((door) => { for (const socket of door.connections) socket.destroy(); }, () => {});
  }

  problem(session: string): LentChromeProblem | null { return this.#problems.get(session) ?? null; }

  close(): void {
    if (this.#sweep) clearInterval(this.#sweep);
    this.#sweep = null;
    for (const door of this.#doors.values()) {
      void door.then((opened) => {
        for (const socket of opened.connections) socket.destroy();
        opened.server.close();
      }, () => {});
    }
    this.#doors.clear();
    this.#joined.clear();
  }

  async #start(session: string): Promise<Door> {
    const token = randomBytes(32);
    const connections = new Set<Socket>();
    const server = createServer((socket) => {
      connections.add(socket);
      socket.on("close", () => { connections.delete(socket); this.#joined.delete(socket); });
      socket.on("error", () => socket.destroy());
      this.#serve(session, token, socket);
    });
    await new Promise<void>((done, fail) => {
      server.once("error", fail);
      server.listen(0, "127.0.0.1", () => { server.off("error", fail); server.on("error", () => {}); done(); });
    });
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    this.#sweepIdle();
    return { server, token, connections, url: `ws://127.0.0.1:${port}${PATH_PREFIX}${token.toString("hex")}` };
  }

  #sweepIdle(): void {
    if (this.#sweep) return;
    this.#sweep = setInterval(() => {
      const now = Date.now();
      const limit = this.#deps.idleMs();
      for (const [socket, seen] of this.#joined) {
        if (socket.bytesRead !== seen.bytes) { seen.bytes = socket.bytesRead; seen.at = now; }
        else if (now - seen.at >= limit) socket.destroy();
      }
    }, this.#deps.sweepMs ?? 30_000);
    this.#sweep.unref();
  }

  #serve(session: string, token: Buffer, socket: Socket): void {
    let data = Buffer.alloc(0);
    const timer = setTimeout(() => socket.destroy(), HEAD_MS);
    timer.unref();
    socket.once("close", () => clearTimeout(timer));
    const onData = (chunk: Buffer) => {
      data = Buffer.concat([data, chunk]);
      const end = data.indexOf("\r\n\r\n");
      if (end === -1) {
        if (data.length > MAX_HEAD_BYTES) socket.destroy();
        return;
      }
      if (end + 4 > MAX_HEAD_BYTES) return void socket.destroy();
      socket.off("data", onData);
      clearTimeout(timer);
      socket.pause();
      void this.#connect(session, token, socket, data).catch(() => socket.destroy());
    };
    socket.on("data", onData);
  }

  async #connect(session: string, token: Buffer, socket: Socket, data: Buffer): Promise<void> {
    const requestLine = data.subarray(0, data.indexOf("\r\n")).toString("latin1");
    const path = requestLine.split(" ")[1] ?? "";
    const given = Buffer.from(path.startsWith(PATH_PREFIX) ? path.slice(PATH_PREFIX.length) : "", "latin1");
    const expected = Buffer.from(token.toString("hex"), "latin1");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return answer(socket, "404 Not Found");
    if (!this.#deps.allowed(session)) {
      this.#problems.set(session, "not-allowed");
      return answer(socket, "403 Forbidden");
    }
    const route = this.#deps.route();
    if (!route) {
      this.#problems.set(session, "offline");
      return answer(socket, "503 Service Unavailable");
    }
    const opened = await route.open().catch((): { gone: true } => ({ gone: true }));
    if (socket.destroyed) return void ("cancel" in opened && opened.cancel());
    if ("join" in opened) {
      // Chrome holds its answer until the person clicks Allow and answers 403 on Deny, so only its 101 means it let us in.
      this.#problems.set(session, "unreachable");
      watchUpgrade(socket, (upgraded) => { if (upgraded) this.#problems.delete(session); });
      this.#joined.set(socket, { session, bytes: socket.bytesRead, at: Date.now() });
      opened.join(socket, [data]);
      return;
    }
    this.#problems.set(session, "refused" in opened
      ? (opened.refused === "not-lent" ? "not-lent" : "unreachable")
      : "failed" in opened
        ? (opened.failed === "no-chrome" ? "no-chrome" : "unreachable")
        : "offline");
    answer(socket, "502 Bad Gateway");
  }
}

export function lentChromeGuidance(problem: LentChromeProblem | "memory-changed", lender: ChromeLender | null): string {
  const name = lender?.name ?? "your computer";
  const device = lender?.device ?? "computer";
  switch (problem) {
    case "offline":
      return `${name} is lent but offline: OpenMausBot on it is closed or the ${device} is asleep. Tell the person in one sentence to open OpenMausBot on that ${device}. Do not switch to another browser.`;
    case "not-lent":
      return "No computer lends its Chrome to My Cloud now. Tell the person in one sentence to turn on Your Chrome under Settings → MausBot Cloud in OpenMausBot on their Mac or PC (updating OpenMausBot there if the switch is missing), or to switch this profile to Built-in under Settings → Browser profiles.";
    case "no-chrome":
      return `Chrome on ${name} isn't open with remote debugging on. Tell the person in one sentence to open Chrome on that ${device}, turn on remote debugging at chrome://inspect/#remote-debugging, and allow the connection when Chrome asks.`;
    case "unreachable":
      return `Chrome on ${name} did not accept the connection; it may be waiting for the person to click Allow. Tell them in one sentence to check Chrome on that ${device}.`;
    case "not-allowed":
      return "Someone else wrote in this conversation, so it can't use your Chrome. Start a new conversation to use it.";
    case "memory-changed":
      return "This bot's memory was changed in a conversation you didn't write. Review it in Memory to use your Chrome again.";
  }
}
