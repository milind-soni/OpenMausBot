import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Duplex } from "node:stream";

import type { LinkOpened, LinkStream } from "../electron/device-link-protocol.mjs";
import { createLineSplitter } from "./mcp-bridge.ts";

// Node 24's `duplexPair` holds each write until the other end reads it and drops the held ones when destroyed, and the
// link writes a stream's last frames, ends and destroys it in one tick: so a write here goes through while the reader
// keeps up, and a destroyed end leaves the other end what it already holds.
export class LinkEnd extends Duplex {
  #peer!: LinkEnd;
  #written: (() => void) | null = null;

  static pair(): [LinkEnd, LinkEnd] {
    const [a, b] = [new LinkEnd(), new LinkEnd()];
    [a.#peer, b.#peer] = [b, a];
    return [a, b];
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, done: () => void): void {
    if (this.#peer.push(chunk)) done();
    else this.#written = done;
  }

  override _read(): void {
    const done = this.#peer.#written;
    this.#peer.#written = null;
    done?.();
  }

  override _final(done: () => void): void { this.#peer.push(null); done(); }

  override _destroy(error: Error | null, done: (error: Error | null) => void): void { this.#peer.push(null); done(error); }
}

const MAX_BODY = 4 * 1024 * 1024;

export interface StdioSessionsDeps { open(): Promise<LinkOpened>; idleMs: number; now?: () => number; sweepMs?: number; onEmpty?: () => void }
type Message = { id?: unknown; method?: unknown };
interface Waiter { res: ServerResponse; answers: Map<string, string | null>; array: boolean; headers: Record<string, string> }
interface Session { id: string; stream: LinkEnd; stop(): void; pending: Map<string, Waiter>; sse: ServerResponse | null; lastAt: number; heard: boolean }

const isMessage = (value: unknown): value is Message => typeof value === "object" && value !== null;

/** The whole body, or null past `MAX_BODY`. */
function readBody(req: IncomingMessage): Promise<Buffer | null> {
  return new Promise((done, fail) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => { size += chunk.length; if (size <= MAX_BODY) chunks.push(chunk); });
    req.on("end", () => done(size <= MAX_BODY ? Buffer.concat(chunks) : null));
    req.on("error", fail);
  });
}

/** One command server on a lent computer, served as MCP Streamable HTTP: each session is one link stream, which is one
 * child on the computer, spoken to in stdio MCP's one JSON message per line.
 * Security: a session ends its stream (and so the child) on DELETE, on `idleMs` without a byte either way while no call
 * waits on it, and on `drop()`; nothing from the child reaches anyone but the session that started it. */
export class StdioSessions {
  readonly #deps: StdioSessionsDeps;
  readonly #now: () => number;
  readonly #sessions = new Map<string, Session>();
  readonly #sweep: NodeJS.Timeout;
  #closed = false;

  constructor(deps: StdioSessionsDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
    this.#sweep = setInterval(() => {
      for (const session of this.#sessions.values()) if (this.#now() - session.lastAt >= deps.idleMs && !session.pending.size) this.#end(session, 504);
    }, deps.sweepMs ?? 30_000);
    this.#sweep.unref();
  }

  get size(): number { return this.#sessions.size; }

  /** Answers the request itself, except an initialize the computer refused, or whose child ended before its first byte
   * (`spawn-failed`), which is returned with its parsed body for the caller to answer. */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<"opened" | { refused: Exclude<LinkOpened, LinkStream>; body: unknown } | void> {
    const id = req.headers["mcp-session-id"];
    const known = () => (typeof id === "string" ? this.#sessions.get(id) : undefined);
    if (req.method === "GET" || req.method === "DELETE") {
      const session = known();
      if (!session) return void res.writeHead(id === undefined ? 400 : 404).end();
      if (req.method === "DELETE") { this.#end(session, 502); return void res.writeHead(200).end(); }
      session.sse?.end();
      session.sse = res;
      res.once("close", () => { if (session.sse === res) session.sse = null; });
      return void res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" }).flushHeaders();
    }
    if (req.method !== "POST") return void res.writeHead(405, { allow: "GET, POST, DELETE" }).end();

    const body = await readBody(req);
    if (!body) return void res.writeHead(413).end();
    let parsed: unknown;
    try { parsed = JSON.parse(body.toString("utf8")); } catch { return void res.writeHead(400).end(); }
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    if (!messages.length || !messages.every(isMessage)) return void res.writeHead(400).end();
    // Looked up once the body is in: the session may have ended while it arrived.
    const session = known();
    if (id !== undefined && !session) return void res.writeHead(404).end();
    const requests = messages.filter((message) => message.id !== undefined && message.method !== undefined);
    if (!session && !requests.some((message) => message.method === "initialize")) return void res.writeHead(400).end();

    let target = session;
    if (!target) {
      const opened = await this.#deps.open().catch((): { gone: true } => ({ gone: true }));
      if (res.destroyed) return void ("join" in opened && opened.cancel());
      if (!("join" in opened)) return { refused: opened, body: parsed };
      target = this.#start(opened);
      if (this.#closed) { this.#end(target, 502); return void res.writeHead(502).end(); }
    }
    if (requests.length) this.#wait(target, { res, answers: new Map(requests.map((message) => [JSON.stringify(message.id), null])), array: Array.isArray(parsed), headers: session ? {} : { "mcp-session-id": target.id } });
    else res.writeHead(202).end();
    target.lastAt = this.#now();
    target.stream.write(messages.map((message) => `${JSON.stringify(message)}\n`).join(""));
    if (session) return undefined;
    return (await this.#heard(target)) || res.headersSent ? "opened" : { refused: { failed: "spawn-failed" }, body: parsed };
  }

  /** Ends every session, and with each its child on the computer. */
  drop(): void {
    for (const session of this.#sessions.values()) this.#end(session, 502);
  }

  /** Ends every session, and any that opens later at once. */
  close(): void {
    this.#closed = true;
    clearInterval(this.#sweep);
    this.drop();
  }

  #start(opened: LinkStream): Session {
    const [ours, theirs] = LinkEnd.pair();
    opened.join(theirs);
    const session: Session = { id: randomUUID(), stream: ours, stop: () => { ours.destroy(); theirs.destroy(); }, pending: new Map(), sse: null, lastAt: this.#now(), heard: false };
    this.#sessions.set(session.id, session);
    const lines = createLineSplitter((line) => this.#line(session, line));
    ours.on("data", (chunk: Buffer) => { session.heard = true; session.lastAt = this.#now(); lines.push(chunk); });
    // The request that opened a session whose child never said a byte is answered by `handle`'s caller.
    ours.on("end", () => { lines.flush(); if (!session.heard) session.pending.clear(); this.#end(session, 502); });
    return session;
  }

  /** False when the stream ended before the child's first byte. */
  #heard(session: Session): Promise<boolean> {
    return new Promise((done) => {
      if (session.heard) return done(true);
      session.stream.once("data", () => done(true)).once("close", () => done(session.heard));
    });
  }

  /** A waiter whose caller gave up leaves nothing pending, so a dead engine can't keep its session from idling out. */
  #wait(session: Session, waiter: Waiter): void {
    for (const key of waiter.answers.keys()) session.pending.set(key, waiter);
    waiter.res.once("close", () => { for (const key of waiter.answers.keys()) if (session.pending.get(key) === waiter) session.pending.delete(key); });
  }

  #line(session: Session, line: string): void {
    let message: unknown;
    try { message = JSON.parse(line); } catch { return; }
    if (!isMessage(message)) return;
    // A request from the server may carry an id the client also used: only a response answers a POST.
    const key = message.method === undefined && message.id !== undefined ? JSON.stringify(message.id) : undefined;
    const waiter = key === undefined ? undefined : session.pending.get(key);
    if (!waiter) return void session.sse?.write(`event: message\ndata: ${line}\n\n`);
    session.pending.delete(key!);
    waiter.answers.set(key!, line);
    const lines = [...waiter.answers.values()];
    if (lines.every((each) => each !== null)) {
      waiter.res.writeHead(200, { "content-type": "application/json", ...waiter.headers }).end(waiter.array ? `[${lines.join(",")}]` : lines[0]);
    }
  }

  #end(session: Session, status: number): void {
    if (this.#sessions.get(session.id) !== session) return;
    this.#sessions.delete(session.id);
    session.stop();
    for (const { res } of session.pending.values()) if (!res.headersSent) res.writeHead(status).end();
    session.sse?.end();
    if (!this.#sessions.size) this.#deps.onEmpty?.();
  }
}
