// A WebSocket client (RFC 6455) over one E2E stream. The app's live sockets reach the computer's origin the same way its
// HTTP requests do: the upgrade request and the frames are plain stream bytes (README section 8), so the browser's own
// WebSocket, which can only dial a URL, cannot be used here.
import { concat, utf8 } from "./bytes.ts";
import { ByteReader, CRLF2, HttpError, MAX_HEAD, TOKEN, headStart, latin1, parseHead } from "./http.ts";
import type { E2EStream } from "./session.ts";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
/** Largest message put together when the caller sets no maxMessage. */
export const MAX_MESSAGE = 16 * 1024 * 1024;
/** How long close() waits for the computer's close before resetting the stream, as the ws package waits. */
export const CLOSE_TIMEOUT_MS = 30_000;
const OP = { continuation: 0, text: 1, binary: 2, close: 8, ping: 9, pong: 10 } as const;
const OPCODES = new Set<number>(Object.values(OP));
const EMPTY = new Uint8Array(0);

export interface StreamSocketClose {
  /** 1005 when the computer's close frame had no code, 1006 when the socket ended without a closing handshake. */
  code: number;
  reason: string;
  wasClean: boolean;
}

export interface StreamSocketOptions {
  /** Origin form: "/ws?x=1". */
  path: string;
  headers?: HeadersInit;
  protocols?: readonly string[];
  /** Aborts the opening handshake; close() ends an open socket. */
  signal?: AbortSignal;
  maxMessage?: number;
  /** Default CLOSE_TIMEOUT_MS. */
  closeTimeoutMs?: number;
  /** Each whole message: text as a string, binary as bytes. Given up front so no message can arrive before it is set. */
  onMessage(data: string | Uint8Array): void;
  /** Called once, however the socket ends. */
  onClose(event: StreamSocketClose): void;
}

/** A protocol error from the computer: the socket is failed with this close code. */
class Failure extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

const base64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));

/** The close codes a peer may put on the wire (RFC 6455 section 7.4). */
const wireCode = (code: number): boolean => (code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006) || (code >= 3000 && code <= 4999);

/** One masked, unfragmented client frame. */
export function clientFrame(op: number, payload: Uint8Array): Uint8Array {
  const size = payload.length;
  const extra = size < 126 ? 0 : size < 65_536 ? 2 : 8;
  const out = new Uint8Array(2 + extra + 4 + size);
  out[0] = 0x80 | op;
  out[1] = 0x80 | (extra === 0 ? size : extra === 2 ? 126 : 127);
  const view = new DataView(out.buffer);
  if (extra === 2) view.setUint16(2, size);
  if (extra === 8) view.setBigUint64(2, BigInt(size));
  const mask = crypto.getRandomValues(new Uint8Array(4));
  out.set(mask, 2 + extra);
  const start = 2 + extra + 4;
  for (let i = 0; i < size; i++) out[start + i] = payload[i] ^ mask[i & 3];
  return out;
}

const closePayload = (code: number, reason: Uint8Array): Uint8Array => concat(Uint8Array.of(code >> 8, code & 0xff), reason);

const strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

const decodeText = (bytes: Uint8Array, what: string): string => {
  try {
    return strict.decode(bytes);
  } catch {
    throw new Failure(1007, `${what} is not UTF-8`);
  }
};

export class StreamWebSocket {
  readonly protocol: string;
  readonly #stream: E2EStream;
  readonly #reader: ByteReader;
  readonly #options: StreamSocketOptions;
  readonly #maxMessage: number;
  #state: "open" | "closing" | "closed" = "open";
  #sending: Promise<void> = Promise.resolve();
  #closeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(stream: E2EStream, reader: ByteReader, protocol: string, options: StreamSocketOptions) {
    this.#stream = stream;
    this.#reader = reader;
    this.protocol = protocol;
    this.#options = options;
    this.#maxMessage = options.maxMessage ?? MAX_MESSAGE;
    void this.#read();
  }

  get readyState(): "open" | "closing" | "closed" {
    return this.#state;
  }

  /** Resolves once the frame is handed to the session. Refused once close() was called or the socket ended. */
  send(data: string | Uint8Array): Promise<void> {
    if (this.#state !== "open") return Promise.reject(new Error(`e2e websocket: the socket is ${this.#state}`));
    return typeof data === "string" ? this.#send(OP.text, utf8(data)) : this.#send(OP.binary, data);
  }

  /** Starts the closing handshake, as the browser's close(): no code, 1000 or 3000-4999, reason up to 123 bytes. */
  close(code?: number, reason = ""): void {
    if (code !== undefined && code !== 1000 && !(Number.isInteger(code) && code >= 3000 && code <= 4999)) throw new TypeError(`e2e websocket: close code ${code} cannot be sent`);
    const why = utf8(reason);
    if (why.length > 123) throw new TypeError("e2e websocket: close reason is over 123 bytes");
    if (why.length && code === undefined) throw new TypeError("e2e websocket: a close reason needs a code");
    if (this.#state !== "open") return;
    this.#state = "closing";
    this.#control(OP.close, code === undefined ? EMPTY : closePayload(code, why));
    // A computer that never answers would hold the stream: reset it, and the read loop reports 1006.
    this.#closeTimer ??= this.#deadline();
  }

  /** Resets the stream after the close deadline; a reset rejects any write still waiting, so nothing waits past it. */
  #deadline(): ReturnType<typeof setTimeout> {
    return setTimeout(() => this.#stream.reset(), this.#options.closeTimeoutMs ?? CLOSE_TIMEOUT_MS);
  }

  /** Frames go out in call order; a failed write leaves the chain rejected, so later sends fail too. */
  #send(op: number, payload: Uint8Array): Promise<void> {
    const frame = clientFrame(op, payload);
    this.#sending = this.#sending.then(() => this.#stream.write(frame));
    return this.#sending;
  }

  /** A frame nobody waits on: a failed write shows up as the stream's end instead. */
  #control(op: number, payload: Uint8Array): void {
    this.#send(op, payload).catch(() => {});
  }

  async #read(): Promise<void> {
    try {
      await this.#frames();
    } catch (error) {
      if (!(error instanceof Failure)) {
        this.#stream.reset();
        return this.#finish({ code: 1006, reason: "", wasClean: false });
      }
      // Fail the connection: tell the computer why, then end the stream. The page sees 1006, as a browser reports it.
      // Once this side's close is out there is nothing left to say or wait for: reset at once.
      if (this.#state === "open") {
        this.#control(OP.close, closePayload(error.code, utf8(error.message.slice(0, 123))));
        this.#end();
      } else {
        this.#stream.reset();
      }
      this.#finish({ code: 1006, reason: "", wasClean: false });
    }
    // Read on to the end of the stream so it is not reset under the computer.
    try {
      while (await this.#reader.some(64 * 1024)) { /* after the close frame */ }
    } catch {
      /* the stream ended either way */
    }
  }

  /** FIN once every queued frame is handed to the session, so the closing frame goes before it; reset at the deadline. */
  #end(): void {
    const deadline = this.#deadline();
    void this.#sending
      .then(
        () => this.#stream.end(),
        () => this.#stream.reset(),
      )
      .finally(() => clearTimeout(deadline));
  }

  /** Reads frames until the closing handshake; throws a Failure for a protocol error, anything else when the stream ends. */
  async #frames(): Promise<void> {
    let kind: number = OP.continuation;
    /** The fragments so far, copied into one buffer that grows by doubling; empty ones take no room. */
    let buffer = EMPTY;
    let size = 0;
    for (;;) {
      const head = await this.#need(2);
      const fin = (head[0] & 0x80) !== 0;
      const op = head[0] & 0x0f;
      if (head[0] & 0x70) throw new Failure(1002, "reserved bits are set");
      if (head[1] & 0x80) throw new Failure(1002, "the computer masked a frame");
      if (!OPCODES.has(op)) throw new Failure(1002, `unknown opcode ${op}`);
      let length = head[1] & 0x7f;
      if (length === 126) {
        length = new DataView((await this.#need(2)).buffer).getUint16(0);
        if (length < 126) throw new Failure(1002, "a length that is not in its shortest form");
      } else if (length === 127) {
        const long = new DataView((await this.#need(8)).buffer).getBigUint64(0);
        if (long < 65_536n || long > BigInt(Number.MAX_SAFE_INTEGER)) throw new Failure(1002, "a length that is not in its shortest form or too large");
        length = Number(long);
      }
      const control = op >= OP.close;
      if (control && (!fin || length > 125)) throw new Failure(1002, "a control frame that is fragmented or over 125 bytes");
      if (!control && size + length > this.#maxMessage) throw new Failure(1009, `a message over ${this.#maxMessage} bytes`);
      const payload = length ? await this.#need(length) : EMPTY;

      if (op === OP.ping) {
        // Answered while closing too: only a close from the computer ends the need for a pong (RFC 6455 section 5.5.2).
        this.#control(OP.pong, payload);
        continue;
      }
      if (op === OP.pong) continue;
      if (op === OP.close) return await this.#closeFrame(payload);

      if (op === OP.continuation ? kind === OP.continuation : kind !== OP.continuation) throw new Failure(1002, op === OP.continuation ? "a continuation with no message" : "a new message inside a fragmented one");
      if (op !== OP.continuation) kind = op;
      if (!fin || size) {
        if (size + length > buffer.length) {
          const grown = new Uint8Array(Math.min(this.#maxMessage, Math.max(size + length, buffer.length * 2)));
          grown.set(buffer.subarray(0, size));
          buffer = grown;
        }
        buffer.set(payload, size);
        size += length;
        if (!fin) continue;
      }
      const whole = size === 0 ? payload : size === buffer.length ? buffer : buffer.slice(0, size);
      const message = kind === OP.text ? decodeText(whole, "a text message") : whole;
      kind = OP.continuation;
      buffer = EMPTY;
      size = 0;
      try {
        this.#options.onMessage(message);
      } catch (error) {
        // A throwing handler is the page's bug, not the computer's: report it and keep the socket, as a browser does.
        queueMicrotask(() => {
          throw error;
        });
      }
    }
  }

  async #need(count: number): Promise<Uint8Array> {
    const bytes = await this.#reader.exact(count);
    if (!bytes) throw new Error("the stream ended without a closing handshake");
    return bytes;
  }

  async #closeFrame(payload: Uint8Array): Promise<void> {
    if (payload.length === 1) throw new Failure(1002, "a close frame with a one-byte body");
    const code = payload.length ? (payload[0] << 8) | payload[1] : 1005;
    if (payload.length && !wireCode(code)) throw new Failure(1002, `close code ${code} is not allowed on the wire`);
    const reason = decodeText(payload.subarray(2), "the close reason");
    // Answer the computer's close with its code, unless this side already sent one.
    if (this.#state === "open") this.#control(OP.close, payload.length ? closePayload(code, EMPTY) : EMPTY);
    this.#state = "closing";
    // A computer that stops reading would hold the answer forever: the close deadline covers this side too.
    this.#closeTimer ??= this.#deadline();
    // Clean only once every frame, the answer included, is handed to the session; a reset meanwhile is a 1006.
    try {
      await this.#sending;
    } catch {
      this.#stream.reset();
      return this.#finish({ code: 1006, reason: "", wasClean: false });
    }
    this.#stream.end();
    this.#finish({ code, reason, wasClean: true });
  }

  #finish(event: StreamSocketClose): void {
    if (this.#state === "closed") return;
    this.#state = "closed";
    clearTimeout(this.#closeTimer);
    this.#options.onClose(event);
  }
}

/** Opens a WebSocket on a fresh stream from `open`. Resolves once the computer switched protocols. */
export async function streamWebSocket(open: () => E2EStream, options: StreamSocketOptions): Promise<StreamWebSocket> {
  // A copy: the reply is checked against the list that was sent, whatever the caller does to its array meanwhile.
  const protocols = [...(options.protocols ?? [])];
  if (protocols.some((protocol) => !TOKEN.test(protocol)) || new Set(protocols).size !== protocols.length) throw new TypeError("e2e websocket: bad subprotocol list");
  const key = base64(crypto.getRandomValues(new Uint8Array(16)));
  let head = headStart("GET", options.path, new Headers(options.headers));
  head += `Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${key}\r\n`;
  if (protocols.length) head += `Sec-WebSocket-Protocol: ${protocols.join(", ")}\r\n`;
  head += "\r\n";
  const accept = base64(new Uint8Array(await crypto.subtle.digest("SHA-1", utf8(key + GUID))));
  const signal = options.signal;
  signal?.throwIfAborted();

  const stream = open();
  const reader = new ByteReader(stream.readable);
  const abort = () => stream.reset();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const [, reply] = await Promise.all([stream.write(latin1(head)), reader.until(CRLF2, MAX_HEAD, "reply head").then(parseHead)]);
    if (reply.status !== 101) throw new HttpError(`the computer answered ${reply.status} instead of switching to WebSocket`);
    const connection = (reply.headers.get("connection") ?? "").toLowerCase().split(",");
    if (reply.headers.get("upgrade")?.toLowerCase() !== "websocket" || !connection.some((token) => token.trim() === "upgrade")) throw new HttpError("the switch is not to WebSocket");
    if (reply.headers.get("sec-websocket-accept") !== accept) throw new HttpError("wrong Sec-WebSocket-Accept");
    if (reply.headers.has("sec-websocket-extensions")) throw new HttpError("the computer chose an extension that was not offered");
    const chosen = reply.headers.get("sec-websocket-protocol");
    if (chosen !== null && !protocols.includes(chosen)) throw new HttpError(`the computer chose subprotocol ${JSON.stringify(chosen)}, which was not offered`);
    return new StreamWebSocket(stream, reader, chosen ?? "", options);
  } catch (error) {
    stream.reset();
    throw signal?.aborted ? signal.reason : error;
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}
