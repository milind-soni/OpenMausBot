// The server half of RFC 6455, enough for /v1/e2e: one unfragmented message per frame, masked client frames,
// binary, text, ping, pong and close. No dependency: the sidecar builds and runs alone.
import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

const ACCEPT_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const OP = { continuation: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa } as const;
const CLOSE_WAIT_MS = 1_000;
/** RFC 6455 close codes this server sends on its own. */
export const WS_CLOSE = { protocol: 1002, unsupported: 1003, tooBig: 1009 } as const;

export interface WsHandlers {
  message(data: Buffer, binary: boolean): void;
  close(code: number): void;
}

export interface WsConnection {
  send(data: Uint8Array): void;
  close(code: number, reason?: string): void;
  readonly bufferedAmount: number;
  /** Runs once the kernel has taken what was buffered. */
  onceDrained(listener: () => void): void;
  ping(data?: Uint8Array): void;
}

export interface UpgradeOptions {
  /** Required subprotocol; null accepts a connection that asks for none. */
  protocol: string | null;
  maxPayload: number;
}

const refuse = (socket: Duplex, status: string): null => {
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  return null;
};

function header(req: IncomingMessage, name: string): string {
  const value = req.headers[name];
  return Array.isArray(value) ? value.join(",") : value ?? "";
}

/** Null when refused; the socket is already answered. A request with an `Origin` header is a browser and is
 * refused before anything else, as on every other sidecar listener. */
export function acceptWebSocket(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  options: UpgradeOptions,
  handlers: (connection: WsConnection) => WsHandlers,
): WsConnection | null {
  if (req.headers.origin !== undefined) return refuse(socket, "403 Forbidden");
  const key = header(req, "sec-websocket-key");
  const upgrade = header(req, "upgrade").toLowerCase();
  const connectionTokens = header(req, "connection").toLowerCase().split(",").map((token) => token.trim());
  if (req.method !== "GET" || upgrade !== "websocket" || !connectionTokens.includes("upgrade")) return refuse(socket, "400 Bad Request");
  if (header(req, "sec-websocket-version") !== "13") return refuse(socket, "426 Upgrade Required\r\nSec-WebSocket-Version: 13");
  if (!/^[A-Za-z0-9+/]{22}==$/.test(key)) return refuse(socket, "400 Bad Request");
  const offered = header(req, "sec-websocket-protocol").split(",").map((token) => token.trim()).filter(Boolean);
  if (options.protocol !== null && !offered.includes(options.protocol)) return refuse(socket, "400 Bad Request");
  const accept = createHash("sha1").update(key + ACCEPT_GUID).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n` +
      (options.protocol !== null ? `Sec-WebSocket-Protocol: ${options.protocol}\r\n` : "") +
      "\r\n",
  );
  return serveFrames(socket, head, options.maxPayload, handlers);
}

function frame(opcode: number, payload: Uint8Array): Buffer {
  const length = payload.length;
  const head = length < 126 ? Buffer.alloc(2) : length < 65_536 ? Buffer.alloc(4) : Buffer.alloc(10);
  head[0] = 0x80 | opcode;
  if (length < 126) head[1] = length;
  else if (length < 65_536) {
    head[1] = 126;
    head.writeUInt16BE(length, 2);
  } else {
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([head, payload]);
}

function closePayload(code: number, reason = ""): Buffer {
  const out = Buffer.alloc(2 + Buffer.byteLength(reason));
  out.writeUInt16BE(code, 0);
  out.write(reason, 2);
  return out.subarray(0, Math.min(out.length, 125));
}

function serveFrames(socket: Duplex, head: Buffer, maxPayload: number, handlers: (connection: WsConnection) => WsHandlers): WsConnection {
  let buffered: Buffer = head.length > 0 ? Buffer.from(head) : Buffer.alloc(0);
  let closing = false;
  let closed = false;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;
  let reported = false;

  const finish = (code: number) => {
    if (closeTimer) clearTimeout(closeTimer);
    closed = true;
    socket.destroy();
    if (!reported) {
      reported = true;
      events.close(code);
    }
  };

  const connection: WsConnection = {
    send(data) {
      if (!closing && !closed) socket.write(frame(OP.binary, data));
    },
    close(code, reason) {
      if (closing || closed) return;
      closing = true;
      socket.write(frame(OP.close, closePayload(code, reason)));
      closeTimer = setTimeout(() => finish(code), CLOSE_WAIT_MS);
      closeTimer.unref?.();
      if (!reported) {
        reported = true;
        events.close(code);
      }
    },
    get bufferedAmount() {
      return socket.writableLength;
    },
    onceDrained(listener) {
      if (socket.writableLength === 0 || closed) queueMicrotask(listener);
      else socket.once("drain", listener);
    },
    ping(data = Buffer.alloc(0)) {
      if (!closing && !closed) socket.write(frame(OP.ping, data));
    },
  };
  const events = handlers(connection);

  const fail = (code: number) => {
    connection.close(code);
  };

  const parse = () => {
    while (!closed) {
      if (buffered.length < 2) return;
      const first = buffered[0];
      const second = buffered[1];
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      if ((first & 0x70) !== 0) return fail(WS_CLOSE.protocol);
      if ((second & 0x80) === 0) return fail(WS_CLOSE.protocol);
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffered.length < 4) return;
        length = buffered.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffered.length < 10) return;
        const big = buffered.readBigUInt64BE(2);
        if (big > BigInt(maxPayload)) return fail(WS_CLOSE.tooBig);
        length = Number(big);
        offset = 10;
      }
      const control = opcode >= 0x8;
      if (control && (length > 125 || !fin)) return fail(WS_CLOSE.protocol);
      if (!fin || opcode === OP.continuation) return fail(WS_CLOSE.unsupported);
      if (length > maxPayload) return fail(WS_CLOSE.tooBig);
      if (buffered.length < offset + 4 + length) return;
      const mask = buffered.subarray(offset, offset + 4);
      const payload = Buffer.from(buffered.subarray(offset + 4, offset + 4 + length));
      for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index & 3];
      buffered = buffered.subarray(offset + 4 + length);
      if (opcode === OP.binary || opcode === OP.text) {
        if (!closing) events.message(payload, opcode === OP.binary);
      } else if (opcode === OP.ping) {
        if (!closing) socket.write(frame(OP.pong, payload));
      } else if (opcode === OP.close) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        if (!closing) {
          closing = true;
          socket.write(frame(OP.close, payload.subarray(0, 2)));
        }
        socket.end();
        return finish(code);
      } else if (opcode !== OP.pong) {
        return fail(WS_CLOSE.protocol);
      }
    }
  };

  socket.on("data", (chunk: Buffer) => {
    buffered = buffered.length ? Buffer.concat([buffered, chunk]) : chunk;
    parse();
  });
  socket.on("error", () => finish(1006));
  socket.on("close", () => finish(1006));
  queueMicrotask(parse);
  return connection;
}
