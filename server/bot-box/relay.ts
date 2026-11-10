// How the server reaches a port an engine listens on inside a box with its own network, such as a sign-in's callback
// listener: the box dials out to a host unix socket and keeps one connection waiting, and the server writes the port and
// a newline on it before talking to that port. The server never connects to a path the box could have swapped.
import { rmSync } from "node:fs";
import { connect, createServer, type Socket } from "node:net";

/** Connections the box may keep waiting; any more are closed. */
const MAX_WAITING = 4;
const MAX_PORT_LINE = 6;
const RELAY_TIMEOUT_MS = 10_000;

export interface BoxRelay {
  /** The host socket to bind into the box. */
  readonly socketPath: string;
  /** A connection to `port` on the box's own loopback, once the box has dialed in. */
  connect(port: number, timeoutMs?: number): Promise<Socket>;
  close(): void;
}

export async function openBoxRelay(socketPath: string): Promise<BoxRelay> {
  rmSync(socketPath, { force: true });
  const waiting: Socket[] = [];
  const takers: Array<(socket: Socket) => void> = [];
  const server = createServer((socket) => {
    socket.on("error", () => {});
    const taker = takers.shift();
    if (taker) return taker(socket);
    if (waiting.length >= MAX_WAITING) return void socket.destroy();
    waiting.push(socket);
    socket.once("close", () => {
      const at = waiting.indexOf(socket);
      if (at >= 0) waiting.splice(at, 1);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    socketPath,
    async connect(port, timeoutMs = RELAY_TIMEOUT_MS) {
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Not a port: ${port}`);
      const socket = waiting.shift() ?? await new Promise<Socket>((resolve, reject) => {
        const take = (dialed: Socket) => {
          clearTimeout(timer);
          resolve(dialed);
        };
        const timer = setTimeout(() => {
          takers.splice(takers.indexOf(take), 1);
          reject(new Error("The sign-in's box did not answer."));
        }, timeoutMs);
        takers.push(take);
      });
      socket.write(`${port}\n`);
      return socket;
    },
    close() {
      if (!server.listening) return;
      server.close();
      for (const socket of waiting.splice(0)) socket.destroy();
      rmSync(socketPath, { force: true });
    },
  };
}

/** Inside the box: keeps one connection to the host's relay socket waiting, and carries each one the host takes to the
 * loopback port it names. Nothing here keeps the process alive. */
export function dialRelay(socketPath: string, retryMs = 1_000): { close(): void } {
  let closed = false;
  let waiting: Socket | null = null;
  let retry: NodeJS.Timeout | undefined;
  const dial = () => {
    if (closed) return;
    const host = connect(socketPath);
    host.unref();
    waiting = host;
    let head = "";
    let taken = false;
    host.on("error", () => {});
    host.once("close", () => {
      if (taken || waiting !== host) return;
      waiting = null;
      if (closed) return;
      retry = setTimeout(dial, retryMs);
      retry.unref();
    });
    const onData = (chunk: Buffer) => {
      head += chunk.toString("latin1");
      const newline = head.indexOf("\n");
      if (newline < 0) {
        if (head.length > MAX_PORT_LINE) host.destroy();
        return;
      }
      host.off("data", onData);
      host.pause();
      taken = true;
      waiting = null;
      dial();
      const line = head.slice(0, newline);
      const port = Number(line);
      if (!/^[1-9]\d{0,4}$/.test(line) || port > 65535) return void host.destroy();
      const rest = Buffer.from(head.slice(newline + 1), "latin1");
      const local = connect({ host: "127.0.0.1", port });
      local.unref();
      local.on("error", () => host.destroy());
      host.on("error", () => local.destroy());
      local.once("connect", () => {
        if (rest.length) local.write(rest);
        host.pipe(local);
        local.pipe(host);
      });
      local.once("close", () => host.destroy());
      host.once("close", () => local.destroy());
    };
    host.on("data", onData);
  };
  dial();
  return {
    close() {
      closed = true;
      clearTimeout(retry);
      waiting?.destroy();
    },
  };
}
