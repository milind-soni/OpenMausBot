// Where each encrypted stream lands: the same proxy handler as every other listener (allowlist, device-token auth,
// gzip, WebSocket upgrades), reached in memory. Nothing listens on a port or a path, so nothing else can connect.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { duplexPair, type Duplex } from "node:stream";

import { gzipTunnelReplies } from "../tunnel-gzip.ts";
import type { E2EContext } from "./registry.ts";

const contexts = new WeakMap<object, E2EContext>();

/** The session a request arrived through, or null for any other listener. */
export const e2eContextOf = (socket: object | null | undefined): E2EContext | null => (socket ? contexts.get(socket) ?? null : null);

/** The parts of net.Socket an http.Server and the proxy call. Idle time counts reads, which is what the server's
 * keep-alive timeout waits on. */
function socketLike(socket: Duplex): Duplex {
  let idleMs = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const arm = () => {
    if (timer) clearTimeout(timer);
    timer = idleMs > 0 ? setTimeout(() => socket.emit("timeout"), idleMs) : null;
    timer?.unref?.();
  };
  socket.on("data", arm);
  socket.on("close", () => {
    if (timer) clearTimeout(timer);
  });
  return Object.assign(socket, {
    setTimeout(ms: number, listener?: () => void) {
      idleMs = ms;
      if (listener) socket.once("timeout", listener);
      arm();
      return socket;
    },
    setNoDelay: () => socket,
    setKeepAlive: () => socket,
  });
}

export interface E2EOrigin {
  connect(context: E2EContext): Promise<Duplex>;
  close(): void;
}

/** How long a stream may take to send a request's headers, and then its whole body. Node's own headersTimeout and
 * requestTimeout are checked only by a server that listens, and this one never does. */
export interface E2EOriginDeadlines {
  headersMs: number;
  requestMs: number;
}

/** Each stream must send complete request headers within `headersMs` of opening or of its last response, and a request's
 * whole body within `requestMs`; otherwise the stream is destroyed. */
function enforceDeadlines(server: ReturnType<typeof createServer>, deadlines: E2EOriginDeadlines) {
  const timers = new WeakMap<object, { arm(): void; clear(): void }>();
  const onRequest = (req: IncomingMessage, res?: ServerResponse) => {
    const guard = timers.get(req.socket);
    if (!guard) return;
    guard.clear();
    // Only an unfinished request: a handler that never reads a GET (an event stream, a download) leaves it unconsumed.
    const body = setTimeout(() => {
      if (!req.complete) req.socket.destroy();
    }, deadlines.requestMs);
    body.unref?.();
    const done = () => clearTimeout(body);
    req.once("end", done);
    req.once("close", done);
    res?.once("finish", () => guard.arm());
  };
  server.on("request", onRequest);
  server.on("upgrade", (req: IncomingMessage) => {
    timers.get(req.socket)?.clear();
  });
  return (socket: Duplex) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const clear = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    const arm = () => {
      clear();
      timer = setTimeout(() => socket.destroy(), deadlines.headersMs);
      timer.unref?.();
    };
    socket.once("close", clear);
    timers.set(socket, { arm, clear });
    arm();
  };
}

export function createE2EOrigin(
  handle: (req: IncomingMessage, res: ServerResponse) => void,
  upgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => void,
  deadlines?: E2EOriginDeadlines,
): E2EOrigin {
  // Gzipped like the tunnel listener: the relay hop is the person's home upload too.
  const server = createServer(gzipTunnelReplies(handle));
  server.on("upgrade", upgrade);
  const guard = deadlines ? enforceDeadlines(server, deadlines) : null;
  return {
    connect(context) {
      const [near, far] = duplexPair();
      const serverSide = socketLike(far);
      contexts.set(serverSide, context);
      guard?.(serverSide);
      server.emit("connection", serverSide);
      return Promise.resolve(near);
    },
    close() {
      server.closeAllConnections();
    },
  };
}
