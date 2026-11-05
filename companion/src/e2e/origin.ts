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

export function createE2EOrigin(
  handle: (req: IncomingMessage, res: ServerResponse) => void,
  upgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => void,
): E2EOrigin {
  // Gzipped like the tunnel listener: the relay hop is the person's home upload too.
  const server = createServer(gzipTunnelReplies(handle));
  server.on("upgrade", upgrade);
  return {
    connect(context) {
      const [near, far] = duplexPair();
      const serverSide = socketLike(far);
      contexts.set(serverSide, context);
      server.emit("connection", serverSide);
      return Promise.resolve(near);
    },
    close() {
      server.closeAllConnections();
    },
  };
}
