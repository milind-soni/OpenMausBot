// WebSocket upgrades go through the same request handler as HTTP, so they pass the same authentication,
// hosted-workspace and maintenance gates; the route that owns the path then answers the handshake.
import { ServerResponse, type IncomingMessage, type Server } from "node:http";
import { Socket } from "node:net";

const HANDSHAKE_MS = 10_000;
const EARLY_BYTES = 64 * 1024;

export interface PendingUpgrade {
  readonly socket: Socket;
  /** Bytes the client sent before its handshake was answered. */
  head: Buffer;
  /** The route answers the handshake now: from here on it reads the socket itself. */
  release(): void;
}

export interface Upgrades {
  /** Upgrades to a path `owns` accepts reach the request handler; any other is answered 404. */
  route(owns: (path: string) => boolean): void;
  attach(server: Server, handle: (req: IncomingMessage, res: ServerResponse) => Promise<unknown>): void;
  pending(req: IncomingMessage): PendingUpgrade | undefined;
  /** Refuses new upgrades and drops every one not answered yet. */
  close(): void;
}

export function createUpgrades(): Upgrades {
  const owners: Array<(path: string) => boolean> = [];
  const pending = new Map<IncomingMessage, PendingUpgrade>();
  let stopped = false;

  return {
    route(owns) {
      owners.push(owns);
    },
    attach(server, handle) {
      server.on("upgrade", (req: IncomingMessage, socket, head: Buffer) => {
        if (stopped || !(socket instanceof Socket)) { socket.destroy(); return; }
        const res = new ServerResponse(req);
        res.assignSocket(socket);
        // Rejected upgrades end this socket; do not let HTTP clients pool it.
        res.setHeader("connection", "close");
        socket.on("error", () => socket.destroy());
        res.once("finish", () => socket.end(() => socket.destroy()));
        let path: string;
        try { path = new URL(req.url ?? "", "http://localhost").pathname; }
        catch { res.writeHead(400).end(); return; }
        if (!owners.some((owns) => owns(path))) { res.writeHead(404).end(); return; }
        // Keep reading while auth awaits, so a closed tab's FIN is observed; buffer any eagerly sent WebSocket bytes.
        const upgrade: PendingUpgrade = { socket, head, release: () => socket.off("data", buffer) };
        const buffer = (data: Buffer) => {
          if (upgrade.head.length + data.length > EARLY_BYTES) socket.destroy();
          else upgrade.head = Buffer.concat([upgrade.head, data]);
        };
        socket.on("data", buffer);
        socket.once("end", () => socket.destroy());
        socket.once("close", () => { upgrade.release(); pending.delete(req); });
        pending.set(req, upgrade);
        const timeout = setTimeout(() => socket.destroy(), HANDSHAKE_MS);
        timeout.unref();
        socket.once("close", () => clearTimeout(timeout));
        void handle(req, res).catch(() => {
          if (!res.headersSent) res.writeHead(500).end();
          else socket.destroy();
        }).finally(() => clearTimeout(timeout));
      });
    },
    pending(req) {
      return pending.get(req);
    },
    close() {
      stopped = true;
      for (const upgrade of pending.values()) upgrade.socket.destroy();
    },
  };
}
