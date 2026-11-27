// The Admin's HTTP requests to the home, one per stream it opens: each is read up to its end, written to the audit log
// with the home's answer, and passed to the home's edge on this server's loopback, the only place a stream can reach.
// A second request on the same stream, a protocol upgrade or a chunked body is refused, so nothing passes unrecorded.
import { Transform, type Duplex, type TransformCallback } from "node:stream";

import { auditRequest, type AuditEvent } from "./audit.ts";

const MAX_HEAD_BYTES = 16 * 1024;
/** The body of a pairing request is read for the audit log (the member it opens a session for); it is small JSON. */
const MAX_RECORDED_BODY = 64 * 1024;
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
const PAIRING = "/api/cloud/pairing";

export interface RequestHead {
  method: string;
  target: string;
  length: number;
}

/** The request line and the headers that matter here, or why the request is refused. */
export function parseHead(head: string): { ok: true; head: RequestHead } | { ok: false; why: string } {
  const lines = head.split("\r\n");
  const match = /^([A-Z]{3,7}) (\/[^\s]*) HTTP\/1\.1$/.exec(lines[0] ?? "");
  if (!match || !METHODS.has(match[1]!)) return { ok: false, why: "not an HTTP/1.1 request MausBot may send" };
  let length = 0;
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(":");
    if (colon <= 0) return { ok: false, why: "a malformed header" };
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (name === "upgrade") return { ok: false, why: "a protocol upgrade" };
    if (name === "transfer-encoding") return { ok: false, why: "a chunked body" };
    if (name === "content-length") {
      if (!/^\d{1,15}$/.test(value)) return { ok: false, why: "a malformed content-length" };
      length = Number(value);
    }
  }
  return { ok: true, head: { method: match[1]!, target: match[2]!, length } };
}

/** Passes exactly one request through, then refuses anything more. */
export class RequestGate extends Transform {
  #head: Buffer = Buffer.alloc(0);
  #parsed: RequestHead | null = null;
  #remaining = 0;
  #body: Buffer[] | null = null;
  #bodyBytes = 0;
  readonly #onHead: (head: RequestHead) => void;
  readonly #onBody: (body: string | null) => void;

  constructor(onHead: (head: RequestHead) => void, onBody: (body: string | null) => void) {
    super();
    this.#onHead = onHead;
    this.#onBody = onBody;
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    let rest = chunk;
    if (!this.#parsed) {
      this.#head = Buffer.concat([this.#head, rest]);
      const end = this.#head.indexOf("\r\n\r\n");
      if (end < 0) return done(this.#head.length > MAX_HEAD_BYTES ? new Error("the request head is too large") : null);
      const parsed = parseHead(this.#head.subarray(0, end).toString("latin1"));
      if (!parsed.ok) return done(new Error(parsed.why));
      this.#parsed = parsed.head;
      this.#remaining = parsed.head.length;
      if (parsed.head.method === "POST" && parsed.head.target.split("?")[0] === PAIRING) this.#body = [];
      this.push(this.#head.subarray(0, end + 4));
      rest = this.#head.subarray(end + 4);
      this.#head = Buffer.alloc(0);
      this.#onHead(parsed.head);
      if (this.#remaining === 0) this.#ended();
    }
    if (rest.length > this.#remaining) return done(new Error("a second request on one stream"));
    if (rest.length > 0) {
      this.#remaining -= rest.length;
      if (this.#body && this.#bodyBytes + rest.length <= MAX_RECORDED_BODY) {
        this.#body.push(rest);
        this.#bodyBytes += rest.length;
      }
      this.push(rest);
      if (this.#remaining === 0) this.#ended();
    }
    done();
  }

  #ended(): void {
    this.#onBody(this.#body && this.#bodyBytes <= MAX_RECORDED_BODY ? Buffer.concat(this.#body).toString("utf8") : null);
    this.#body = null;
  }
}

/** Reads the status code off the first bytes of the home's answer and passes everything on. */
export class StatusTap extends Transform {
  #seen: Buffer | null = Buffer.alloc(0);
  readonly #onStatus: (status: number) => void;

  constructor(onStatus: (status: number) => void) {
    super();
    this.#onStatus = onStatus;
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    if (this.#seen) {
      this.#seen = Buffer.concat([this.#seen, chunk]);
      const line = /^HTTP\/1\.[01] (\d{3})/.exec(this.#seen.subarray(0, 32).toString("latin1"));
      if (line || this.#seen.length >= 32) {
        this.#onStatus(line ? Number(line[1]) : 0);
        this.#seen = null;
      }
    }
    done(null, chunk);
  }
}

const reply = (status: number, words: string) => `HTTP/1.1 ${status} ${words}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n`;

/** Serves one stream the Admin opened: the request it carries goes to the home, its answer comes back, both recorded. */
export function serveRequest(stream: Duplex, accept: () => void, options: { connectHome: () => Promise<Duplex>; record: (event: AuditEvent) => void }): void {
  let head: RequestHead | null = null;
  let body: string | null = null;
  let piped = false;
  let refused = false;
  let recorded = false;
  // A pairing's body has passed the gate before the home can answer it, so it is known when the status is.
  const record = (status: number) => {
    if (recorded || !head) return;
    recorded = true;
    options.record(auditRequest(head.method, head.target, status, body));
  };
  const gate = new RequestGate((parsed) => {
    head = parsed;
    options.connectHome().then((home) => {
      if (stream.destroyed || refused) return void home.destroy();
      piped = true;
      home.on("error", () => stream.destroy());
      home.on("close", () => {
        record(0);
        if (!stream.writableEnded) stream.end();
      });
      stream.on("close", () => home.destroy());
      gate.pipe(home);
      home.pipe(new StatusTap(record)).pipe(stream);
    }, () => {
      record(502);
      stream.end(reply(502, "Bad Gateway"));
    });
  }, (read) => {
    body = read;
  });
  gate.on("error", () => {
    refused = true;
    record(400);
    if (piped) stream.destroy();
    else if (!stream.destroyed) stream.end(reply(400, "Bad Request"));
  });
  accept();
  stream.pipe(gate);
}
