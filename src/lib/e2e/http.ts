// HTTP/1.1 over one E2E stream, the bytes the computer's origin listener reads (README section 8: the E2E layer never
// parses them). One request per stream with Connection: close: a stream costs one frame to open, so nothing is pooled.
import { concat, utf8 } from "./bytes.ts";
import type { E2EStream } from "./session.ts";

/** Status line plus headers of one reply, the same ceiling Node's HTTP server puts on a request head. */
export const MAX_HEAD = 16 * 1024;
const MAX_CHUNK_LINE = 1024;
export const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
/** Framing and connection headers this client writes itself; a caller's own would contradict them. */
const OWN = new Set(["host", "connection", "content-length", "transfer-encoding", "upgrade", "keep-alive", "te", "trailer", "accept-encoding"]);
/** Statuses whose Response must have a null body. */
const NULL_BODY = new Set([204, 205, 304]);
export const CRLF2 = [13, 10, 13, 10];

export class HttpError extends Error {
  constructor(message: string) {
    super(`e2e http: ${message}`);
    this.name = "HttpError";
  }
}

export interface StreamRequest {
  /** Default GET. */
  method?: string;
  /** Origin form: "/api/bots?x=1". */
  path: string;
  headers?: HeadersInit;
  body?: Uint8Array | string | null;
  signal?: AbortSignal;
}

/** The request line, Host and the caller's headers, refused before anything is sent when a part could split or reframe
 * the request. The caller adds its own framing and connection lines and the blank line. */
export function headStart(method: string, path: string, headers: Headers): string {
  if (!TOKEN.test(method)) throw new TypeError(`e2e http: bad method ${JSON.stringify(method)}`);
  if (!path.startsWith("/") || [...path].some((char) => char <= " " || char === "\x7f" || char === "#")) {
    throw new TypeError("e2e http: path must be origin-form with no spaces, controls or fragment");
  }
  // A path's non-ASCII goes out percent-encoded UTF-8, as fetch's URL parser sends it.
  const target = path.replace(/[\u0080-\uffff]+/g, (run) => Array.from(utf8(run), (byte) => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`).join(""));
  let head = `${method} ${target} HTTP/1.1\r\nHost: companion\r\n`;
  // Headers already refuses names that are not tokens and values with CR, LF or NUL.
  for (const [name, value] of headers) {
    if (OWN.has(name) || name.startsWith("sec-websocket-")) throw new TypeError(`e2e http: ${name} is set by the stream client`);
    head += `${name}: ${value}\r\n`;
  }
  return head;
}

/** The whole head of a plain request. */
export function requestHead(method: string, path: string, headers: Headers, length: number | null): string {
  const head = headStart(method, path, headers);
  return `${head}${length !== null ? `Content-Length: ${length}\r\n` : ""}Connection: close\r\n\r\n`;
}

/** Reads a stream's bytes with the leftover of the last read kept for the next parse. */
export class ByteReader {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  #held: Uint8Array = new Uint8Array(0);

  constructor(readable: ReadableStream<Uint8Array>) {
    this.#reader = readable.getReader();
  }

  /** False at the end of the stream. */
  async #more(): Promise<boolean> {
    const { done, value } = await this.#reader.read();
    if (done) return false;
    this.#held = this.#held.length ? concat(this.#held, value) : value;
    return true;
  }

  /** Bytes up to and without the delimiter, which is consumed. */
  async until(delimiter: number[], max: number, what: string): Promise<Uint8Array> {
    let from = 0;
    for (;;) {
      const at = indexOf(this.#held, delimiter, from);
      if (at !== -1 && at <= max) {
        const line = this.#held.subarray(0, at);
        this.#held = this.#held.subarray(at + delimiter.length);
        return line;
      }
      if (this.#held.length >= max + delimiter.length) throw new HttpError(`${what} is over ${max} bytes`);
      from = Math.max(0, this.#held.length - delimiter.length + 1);
      if (!(await this.#more())) throw new HttpError(`the stream ended inside the ${what}`);
    }
  }

  /** Up to `max` bytes, or null at the end of the stream. */
  async some(max: number): Promise<Uint8Array | null> {
    if (!this.#held.length && !(await this.#more())) return null;
    const part = this.#held.subarray(0, max);
    this.#held = this.#held.subarray(part.length);
    return part;
  }

  /** Exactly `count` bytes as a copy, or null when the stream ends first. */
  async exact(count: number): Promise<Uint8Array | null> {
    while (this.#held.length < count) if (!(await this.#more())) return null;
    const part = this.#held.slice(0, count);
    this.#held = this.#held.subarray(count);
    return part;
  }

  release(): void {
    this.#reader.releaseLock();
  }
}

function indexOf(bytes: Uint8Array, delimiter: number[], from: number): number {
  outer: for (let i = from; i + delimiter.length <= bytes.length; i++) {
    for (let j = 0; j < delimiter.length; j++) if (bytes[i + j] !== delimiter[j]) continue outer;
    return i;
  }
  return -1;
}

/** Head characters as bytes, the way fetch writes header values: one character, one byte (Headers holds only 0-255). */
export const latin1 = (text: string): Uint8Array => Uint8Array.from(text, (char) => char.charCodeAt(0));

/** Header bytes as fetch reads them: one byte, one character. */
const byteString = (bytes: Uint8Array): string => {
  let text = "";
  for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return text;
};

export interface Head {
  status: number;
  statusText: string;
  headers: Headers;
}

/** Strips the optional whitespace HTTP allows around a field value: spaces and tabs only, never other bytes. */
const ows = (value: string) => value.replace(/^[ \t]+|[ \t]+$/g, "");

/** One `name: value` line of a head or the trailers. */
function appendField(headers: Headers, line: string): void {
  const colon = line.indexOf(":");
  const name = line.slice(0, colon);
  if (colon < 1 || !TOKEN.test(name)) throw new HttpError("bad header line");
  try {
    headers.append(name, ows(line.slice(colon + 1)));
  } catch {
    throw new HttpError(`bad value for ${name}`);
  }
}

export function parseHead(bytes: Uint8Array): Head {
  const [statusLine, ...lines] = byteString(bytes).split("\r\n");
  // The reason phrase as Response takes it: tab, space, visible and obs-text bytes.
  const status = /^HTTP\/1\.[01] ([1-5]\d\d)(?: ([\t\x20-\x7e\x80-\xff]*))?$/.exec(statusLine);
  if (!status) throw new HttpError("bad status line");
  const headers = new Headers();
  for (const line of lines) appendField(headers, line);
  return { status: Number(status[1]), statusText: status[2] ?? "", headers };
}

type Framing = { kind: "none" } | { kind: "length"; left: number } | { kind: "chunked" } | { kind: "close" };

function framing(method: string, head: Head): Framing {
  if (method === "HEAD" || NULL_BODY.has(head.status)) return { kind: "none" };
  // Checked even beside chunked: lengths that disagree mean the reply's framing can't be trusted.
  const length = head.headers.get("content-length");
  const values = new Set(length?.split(",").map(ows));
  const [only] = values;
  if (length !== null && (values.size !== 1 || !/^\d{1,15}$/.test(only))) throw new HttpError("bad content-length");
  const coding = head.headers.get("transfer-encoding");
  if (coding !== null) {
    if (ows(coding).toLowerCase() !== "chunked") throw new HttpError(`unsupported transfer-encoding ${coding}`);
    return { kind: "chunked" };
  }
  return length === null ? { kind: "close" } : { kind: "length", left: Number(only) };
}

async function chunkSize(reader: ByteReader): Promise<number> {
  const line = byteString(await reader.until([13, 10], MAX_CHUNK_LINE, "chunk size line"));
  const size = /^([0-9A-Fa-f]{1,12})[ \t]*(?:;.*)?$/.exec(line);
  if (!size) throw new HttpError("bad chunk size");
  return parseInt(size[1], 16);
}

/** One request on a fresh stream from `open`. Resolves with the reply once its head is in; the body streams after. */
export async function streamFetch(open: () => E2EStream, request: StreamRequest): Promise<Response> {
  const method = (request.method ?? "GET").toUpperCase();
  const body = typeof request.body === "string" ? utf8(request.body) : request.body ?? null;
  const head = requestHead(method, request.path, new Headers(request.headers), body ? body.length : method === "POST" || method === "PUT" || method === "PATCH" ? 0 : null);
  const signal = request.signal;
  signal?.throwIfAborted();

  const stream = open();
  const reader = new ByteReader(stream.readable);
  let finished = false;
  /** Set once the whole request is written; a reply that ends before that resets the stream, as fetch drops an upload. */
  let uploaded = false;
  /** The reply body's controller, once the head is in. */
  let output: ReadableStreamDefaultController<Uint8Array> | null = null;
  const done = () => {
    finished = true;
    signal?.removeEventListener("abort", abort);
    reader.release();
    if (uploaded) stream.end();
    else stream.reset();
  };
  const failed = (error: unknown): unknown => {
    finished = true;
    signal?.removeEventListener("abort", abort);
    stream.reset();
    return signal?.aborted ? signal.reason : error;
  };
  /** Resets the stream; a body already given out errors at once, bytes held for it or not. */
  const fail = (error: unknown) => {
    if (finished) return;
    const reason = failed(error);
    output?.error(reason);
  };
  const abort = () => fail(null);
  signal?.addEventListener("abort", abort, { once: true });

  // No FIN after the request: Node's HTTP server cuts a reply short when the client half-closes first.
  const sent = Promise.all([stream.write(latin1(head)), body?.length ? stream.write(Uint8Array.from(body)) : undefined]);
  void sent.then(
    () => (uploaded = true),
    () => {},
  );
  try {
    const received = (async () => {
      for (;;) {
        const next = parseHead(await reader.until(CRLF2, MAX_HEAD, "reply head"));
        if (next.status === 101) throw new HttpError("the computer switched protocols on a plain request");
        if (next.status >= 200) return next;
      }
    })();
    // The reply is given once its head is in, upload or not: a computer that answers as it reads (an echo) waits on
    // this side reading. An upload that fails before the head fails the request; one that fails after errors the body.
    const reply = await Promise.race([received, sent.then(() => received)]);
    sent.catch(fail);
    let frame = framing(method, reply);
    if (frame.kind === "none") {
      const response = new Response(null, reply);
      done();
      return response;
    }
    let chunkLeft = 0;
    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        output = controller;
      },
      async pull(controller) {
        try {
          for (;;) {
            if (frame.kind === "length") {
              if (frame.left === 0) break;
              const part = await reader.some(frame.left);
              if (!part) throw new HttpError("the reply ended before its content-length");
              frame.left -= part.length;
              return controller.enqueue(Uint8Array.from(part));
            }
            if (frame.kind === "close") {
              const part = await reader.some(64 * 1024);
              if (!part) break;
              return controller.enqueue(Uint8Array.from(part));
            }
            if (chunkLeft === 0) {
              chunkLeft = await chunkSize(reader);
              if (chunkLeft === 0) {
                // Trailers are checked and dropped, up to the blank line that ends the reply; all of them fit in MAX_HEAD.
                const trailers = new Headers();
                let room = MAX_HEAD;
                for (;;) {
                  const line = await reader.until([13, 10], room, "rest of the trailer section");
                  if (!line.length) break;
                  room = Math.max(0, room - line.length - 2);
                  appendField(trailers, byteString(line));
                }
                break;
              }
            }
            const part = await reader.some(chunkLeft);
            if (!part) throw new HttpError("the reply ended inside a chunk");
            chunkLeft -= part.length;
            if (chunkLeft === 0 && (await reader.until([13, 10], 0, "chunk end")).length) throw new HttpError("bad chunk end");
            return controller.enqueue(Uint8Array.from(part));
          }
          frame = { kind: "none" };
          done();
          controller.close();
        } catch (error) {
          controller.error(failed(error));
        }
      },
      cancel() {
        failed(null);
      },
    });
    return new Response(readable, reply);
  } catch (error) {
    throw failed(error);
  }
}
