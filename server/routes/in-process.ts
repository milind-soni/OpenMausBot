import { EventEmitter } from "node:events";
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "node:http";
import { Readable } from "node:stream";

import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import { dispatchRoutes, type RouteHandler } from "./table.ts";

/** Headers a route reads to tell where a request came from; a call made on a request's behalf carries them along. */
const CARRIED = ["origin", "user-agent", "x-forwarded-for", "x-openmausbot-companion", "x-openmausbot-companion-device", "x-openmausbot-cli", "x-openmausbot-cli-owner"];
const ANSWER_TIMEOUT_MS = 120_000;

class CapturedResponse extends EventEmitter {
  statusCode = 200;
  headersSent = false;
  writableEnded = false;
  private readonly headers = new Map<string, number | string | string[]>();
  private readonly chunks: Buffer[] = [];
  readonly req: IncomingMessage;
  constructor(req: IncomingMessage) {
    super();
    this.req = req;
  }
  setHeader(name: string, value: number | string | string[]) { this.headers.set(name.toLowerCase(), value); return this; }
  getHeader(name: string) { return this.headers.get(name.toLowerCase()); }
  hasHeader(name: string) { return this.headers.has(name.toLowerCase()); }
  removeHeader(name: string) { this.headers.delete(name.toLowerCase()); }
  writeHead(status: number, headers?: OutgoingHttpHeaders) {
    this.statusCode = status;
    for (const [name, value] of Object.entries(headers ?? {})) if (value !== undefined) this.setHeader(name, value);
    this.headersSent = true;
    return this;
  }
  write(chunk: string | Uint8Array) {
    this.headersSent = true;
    this.chunks.push(Buffer.from(chunk));
    return true;
  }
  end(chunk?: string | Uint8Array) {
    if (chunk !== undefined) this.write(chunk);
    this.headersSent = true;
    this.writableEnded = true;
    this.emit("finish");
    return this;
  }
  destroy() { this.end(); return this; }
  text() { return Buffer.concat(this.chunks).toString("utf8"); }
}

/** Calls `routes` in this process as `auth`, with the original request's origin headers, so the call meets every check
 * the same request over HTTP would meet inside the route modules. */
export async function callRoutes(routes: readonly RouteHandler[], original: IncomingMessage, auth: RequestAuth, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = Readable.from(payload) as unknown as IncomingMessage;
  const headers: Record<string, string | string[]> = { host: "127.0.0.1", ...(body === undefined ? {} : { "content-type": "application/json" }) };
  for (const name of CARRIED) {
    const value = original.headers[name];
    if (value !== undefined) headers[name] = value;
  }
  Object.assign(req, { method, url: path, headers, socket: original.socket, httpVersion: "1.1" });
  const res = new CapturedResponse(req);
  const url = new URL(path, "http://127.0.0.1");
  const answered = await dispatchRoutes(routes, { req, res: res as unknown as ServerResponse, url, path: url.pathname, method, auth, json, readBody });
  if (!answered) return { status: 404, body: { error: `no route for ${method} ${url.pathname}` } };
  if (!res.writableEnded) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} ${url.pathname} did not answer`)), ANSWER_TIMEOUT_MS);
      res.once("finish", () => { clearTimeout(timer); resolve(); });
    });
  }
  const text = res.text();
  let parsed: any = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { error: text };
  }
  return { status: res.statusCode, body: parsed };
}
