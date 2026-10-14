// This client never logs a header value.
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";

import type { RemoteMcpSpec } from "./contracts.ts";

export type McpHttpFailure = "network" | "status" | "protocol";

export class McpHttpError extends Error {
  readonly kind: McpHttpFailure;
  readonly status: number | undefined;
  readonly wwwAuthenticate: string | undefined;

  constructor(kind: McpHttpFailure, message: string, status?: number, wwwAuthenticate?: string) {
    super(message);
    this.name = "McpHttpError";
    this.kind = kind;
    this.status = status;
    this.wwwAuthenticate = wwwAuthenticate;
  }
}

export class McpRpcError extends McpHttpError {
  readonly code: number | undefined;
  readonly detail: string;

  constructor(code: number | undefined, detail: string) {
    super("protocol", `MCP error: ${detail}`);
    this.name = "McpRpcError";
    this.code = code;
    this.detail = detail;
  }
}

/** Whop's official server lists 425 tools in 1.2 MB of JSON (one tool ~51 KB), so a 1 MB cap refused it. */
export const MAX_REMOTE_MCP_BYTES = 32 * 1024 * 1024;
const PROTOCOL_VERSION = "2025-06-18";

export const REMOTE_MCP_STARTUP_MS = 30_000;

/** Only this name reaches argv, never the address or a header value. */
export const REMOTE_MCP_CONFIG_ENV = /^OMB_REMOTE_MCP_CONFIG_[a-f0-9]{64}$/;

interface JsonRpcMessage {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Validate private proxy configuration without including secrets in errors. */
export function remoteMcpSpec(value: unknown): RemoteMcpSpec | undefined {
  if (!isRecord(value) || (value.type !== "http" && value.type !== "sse") || typeof value.url !== "string") return;
  try {
    const url = new URL(value.url);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return;
    const headers = value.headers ?? {};
    if (!isRecord(headers) || !Object.values(headers).every((header) => typeof header === "string")) return;
    new Headers(headers as Record<string, string>);
    return { type: value.type, url: value.url, headers: headers as Record<string, string> };
  } catch { return; }
}

function unwrap(message: JsonRpcMessage): unknown {
  if (message.error !== undefined) {
    const detail = isRecord(message.error) && typeof message.error.message === "string" ? message.error.message : "request failed";
    const code = isRecord(message.error) && Number.isSafeInteger(message.error.code) ? message.error.code as number : undefined;
    throw new McpRpcError(code, detail);
  }
  return message.result;
}

function parseMessage(text: string): JsonRpcMessage | JsonRpcMessage[] | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.filter(isRecord) as JsonRpcMessage[];
    return isRecord(parsed) ? (parsed as JsonRpcMessage) : null;
  } catch {
    return null;
  }
}

interface SseEvent {
  event: string;
  data: string;
}

function parseSseBlock(block: string): SseEvent | null {
  let event = "message";
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  return data.length ? { event, data: data.join("\n") } : null;
}

async function readSse(
  response: Response,
  signal: AbortSignal,
  onEvent: (event: SseEvent) => "stop" | undefined,
  maxBytes = MAX_REMOTE_MCP_BYTES,
): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) throw new McpHttpError("protocol", "empty event stream");
  const decoder = new TextDecoder();
  let buffer = "";
  let bytes = 0;
  const onAbort = () => void reader.cancel().catch(() => {});
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new McpHttpError("protocol", "event stream too large");
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/g, "\n");
      let separator: number;
      while ((separator = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        const event = parseSseBlock(block);
        if (event && onEvent(event) === "stop") {
          await reader.cancel().catch(() => {});
          return;
        }
      }
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function readBounded(response: Response, maxBytes = MAX_REMOTE_MCP_BYTES): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return text + decoder.decode();
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new McpHttpError("protocol", "response too large");
    }
    text += decoder.decode(value, { stream: true });
  }
}

function drain(response: Response): void {
  void response.body?.cancel().catch(() => {});
}

export class RemoteMcpClient {
  private readonly target: RemoteMcpSpec;
  private readonly fetchImpl: typeof fetch;
  private readonly maxBytes: number;
  private readonly onNotification: ((message: JsonRpcMessage) => void) | undefined;
  private sessionId: string | null = null;
  private protocolVersion: string | null = null;
  private nextId = 1;
  private closed = false;
  private readonly pending = new Map<number, Pending>();
  private sseEndpoint: Promise<string> | null = null;
  private readonly sseAbort = new AbortController();

  constructor(target: RemoteMcpSpec, options: { fetch?: typeof fetch; maxBytes?: number; onNotification?: (message: JsonRpcMessage) => void } = {}) {
    this.target = target;
    this.fetchImpl = options.fetch ?? fetch;
    this.maxBytes = options.maxBytes ?? MAX_REMOTE_MCP_BYTES;
    this.onNotification = options.onNotification;
  }

  extensions: "ok" | "refused" | undefined;

  /** A strict server refuses an initialize field it does not know (HTTP 400 or a JSON-RPC error), so a
   * refused handshake with `extensions` is sent once more without them. */
  async initialize(clientName: string, signal: AbortSignal, options: { extensions?: Record<string, unknown> } = {}): Promise<unknown> {
    const params = { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: clientName, version: "1" } };
    let result: unknown;
    if (options.extensions && Object.keys(options.extensions).length) {
      try {
        result = await this.request("initialize", { ...params, capabilities: { extensions: options.extensions } }, signal);
        this.extensions = "ok";
      } catch (error) {
        if (signal.aborted || !(error instanceof McpRpcError || (error instanceof McpHttpError && error.status === 400))) throw error;
        this.sessionId = null;
        this.extensions = "refused";
        result = await this.request("initialize", params, signal);
      }
    } else {
      result = await this.request("initialize", params, signal);
    }
    if (isRecord(result) && typeof result.protocolVersion === "string") this.protocolVersion = result.protocolVersion;
    await this.notify("notifications/initialized", undefined, signal);
    return result;
  }

  request(method: string, params: unknown, signal: AbortSignal): Promise<unknown> {
    if (this.closed) return Promise.reject(new McpHttpError("protocol", "client closed"));
    if (signal.aborted) return Promise.reject(new McpHttpError("network", "aborted"));
    const id = this.nextId++;
    const frame = { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) };
    const onAbort = () => {
      void this.notify("notifications/cancelled", { requestId: id, reason: "Request cancelled" }, AbortSignal.timeout(2_000)).catch(() => {});
    };
    signal.addEventListener("abort", onAbort, { once: true });
    const reply = this.target.type === "sse" ? this.sseRequest(id, frame, signal) : this.streamableRequest(id, frame, signal);
    return reply.finally(() => signal.removeEventListener("abort", onAbort));
  }

  async notify(method: string, params: unknown, signal: AbortSignal): Promise<void> {
    if (this.closed) throw new McpHttpError("protocol", "client closed");
    const frame = { jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) };
    if (this.target.type === "sse") {
      await this.ssePost(frame, signal);
      return;
    }
    const response = await this.post(this.target.url, frame, signal);
    drain(response);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.sseAbort.abort();
    for (const entry of this.pending.values()) entry.reject(new McpHttpError("network", "client closed"));
    this.pending.clear();
    // Streamable HTTP: end the session. Many servers answer 405 here.
    if (this.sessionId && this.target.type !== "sse") {
      try {
        const headers = this.headers();
        headers.set("mcp-session-id", this.sessionId);
        const response = await this.fetchImpl(this.target.url, { method: "DELETE", headers, signal: AbortSignal.timeout(2_000) });
        drain(response);
      } catch {
      }
    }
  }

  private headers(): Headers {
    const headers = new Headers();
    for (const [name, value] of Object.entries(this.target.headers)) headers.set(name, value);
    headers.set("accept", "application/json, text/event-stream");
    if (this.sessionId) headers.set("mcp-session-id", this.sessionId);
    if (this.protocolVersion) headers.set("mcp-protocol-version", this.protocolVersion);
    return headers;
  }

  private async post(url: string, frame: unknown, signal: AbortSignal): Promise<Response> {
    const headers = this.headers();
    headers.set("content-type", "application/json");
    let response: Response;
    try {
      response = await this.fetchImpl(url, { method: "POST", headers, body: JSON.stringify(frame), signal });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new McpHttpError("network", "request failed");
    }
    if (!response.ok) {
      drain(response);
      throw new McpHttpError("status", `HTTP ${response.status}`, response.status, response.headers.get("www-authenticate") ?? undefined);
    }
    const session = response.headers.get("mcp-session-id");
    if (session) this.sessionId = session;
    return response;
  }

  private async streamableRequest(id: number, frame: unknown, signal: AbortSignal): Promise<unknown> {
    const response = await this.post(this.target.url, frame, signal);
    const type = (response.headers.get("content-type") ?? "").toLowerCase();
    if (type.startsWith("application/json")) {
      const parsed = parseMessage(await readBounded(response, this.maxBytes));
      this.deliverNotifications(parsed);
      const message = (Array.isArray(parsed) ? parsed : parsed ? [parsed] : []).find((entry) => entry.id === id);
      if (!message) throw new McpHttpError("protocol", "response did not answer the request");
      return unwrap(message);
    }
    if (type.startsWith("text/event-stream")) {
      let found: JsonRpcMessage | undefined;
      await readSse(response, signal, (event) => {
        if (event.event !== "message") return undefined;
        const parsed = parseMessage(event.data);
        this.deliverNotifications(parsed);
        const message = (Array.isArray(parsed) ? parsed : parsed ? [parsed] : []).find((entry) => entry.id === id);
        if (!message) return undefined;
        found = message;
        return "stop";
      }, this.maxBytes);
      if (signal.aborted) throw new McpHttpError("network", "aborted");
      if (!found) throw new McpHttpError("protocol", "event stream ended without the response");
      return unwrap(found);
    }
    drain(response);
    throw new McpHttpError("protocol", "unexpected content type");
  }

  private openSseStream(signal: AbortSignal): Promise<string> {
    if (this.sseEndpoint) return this.sseEndpoint;
    this.sseEndpoint = new Promise<string>((resolveEndpoint, rejectEndpoint) => {
      let settled = false;
      const fail = (error: Error) => {
        if (!settled) {
          settled = true;
          rejectEndpoint(error);
        }
        for (const entry of this.pending.values()) entry.reject(error);
        this.pending.clear();
      };
      const headers = this.headers();
      headers.set("accept", "text/event-stream");
      // The caller's signal covers only the opening: later requests are answered on this stream.
      const opening = AbortSignal.any([signal, this.sseAbort.signal]);
      this.fetchImpl(this.target.url, { method: "GET", headers, signal: opening })
        .then(async (response) => {
          if (!response.ok) {
            drain(response);
            throw new McpHttpError("status", `HTTP ${response.status}`, response.status, response.headers.get("www-authenticate") ?? undefined);
          }
          await readSse(response, this.sseAbort.signal, (event) => {
            if (event.event === "endpoint") {
              if (!settled) {
                settled = true;
                try {
                  resolveEndpoint(new URL(event.data, this.target.url).toString());
                } catch {
                  rejectEndpoint(new McpHttpError("protocol", "invalid endpoint event"));
                }
              }
              return undefined;
            }
            if (event.event !== "message") return undefined;
            const parsed = parseMessage(event.data);
            this.deliverNotifications(parsed);
            for (const message of Array.isArray(parsed) ? parsed : parsed ? [parsed] : []) {
              const entry = typeof message.id === "number" ? this.pending.get(message.id) : undefined;
              if (!entry) continue;
              this.pending.delete(message.id as number);
              try {
                entry.resolve(unwrap(message));
              } catch (error) {
                entry.reject(error instanceof Error ? error : new McpHttpError("protocol", String(error)));
              }
            }
            return undefined;
          }, this.maxBytes);
          fail(new McpHttpError("network", "event stream ended"));
        })
        .catch((error: unknown) => {
          fail(error instanceof McpHttpError ? error : new McpHttpError("network", "event stream failed"));
        });
    });
    return this.sseEndpoint;
  }

  private async ssePost(frame: unknown, signal: AbortSignal): Promise<void> {
    const endpoint = await this.openSseStream(signal);
    const response = await this.post(endpoint, frame, signal);
    drain(response);
  }

  private sseRequest(id: number, frame: unknown, signal: AbortSignal): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const onAbort = () => {
        this.pending.delete(id);
        reject(new McpHttpError("network", "aborted"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        resolve: (value) => {
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        reject: (error) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      });
      this.ssePost(frame, signal).catch((error: unknown) => {
        this.pending.delete(id);
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new McpHttpError("network", String(error)));
      });
    });
  }

  /** Every MCP party must answer ping; other server requests are refused at once, or the server holds its reply until timeout. */
  private deliverNotifications(parsed: JsonRpcMessage | JsonRpcMessage[] | null): void {
    for (const message of Array.isArray(parsed) ? parsed : parsed ? [parsed] : []) {
      if (typeof message.method !== "string") continue;
      if (message.id === undefined) this.onNotification?.(message);
      else if (typeof message.id === "string" || typeof message.id === "number") void this.answerRequest(message.id, message.method);
    }
  }

  private async answerRequest(id: string | number, method: string): Promise<void> {
    if (this.closed) return;
    const frame = method === "ping"
      ? { jsonrpc: "2.0", id, result: {} }
      : { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not supported by this client" } };
    try {
      if (this.target.type === "sse") await this.ssePost(frame, AbortSignal.timeout(10_000));
      else drain(await this.post(this.target.url, frame, AbortSignal.timeout(10_000)));
    } catch {
    }
  }
}

// Node 24's fetch hangs on plain http:// through its env proxy, so such a request goes to HTTP_PROXY in absolute form, as curl does.

function isLoopback(host: string): boolean {
  return host === "localhost" || host.endsWith(".localhost") || host === "::1" || /^127\.\d+\.\d+\.\d+$/.test(host);
}

/** NO_PROXY by curl's rules: a name matches itself and subdomains, a leading dot or `*.` is ignored, `*` matches all, a port must match. */
export function bypassesProxy(target: URL, noProxy: string): boolean {
  const host = target.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (isLoopback(host)) return true;
  const port = target.port || (target.protocol === "https:" ? "443" : "80");
  for (const raw of noProxy.split(/[\s,]+/)) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry === "*") return true;
    const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(entry);
    const hostPort = !bracketed && entry.split(":").length === 2 ? entry.split(":") : undefined;
    const name = (bracketed?.[1] ?? hostPort?.[0] ?? entry).replace(/^\*?\./, "");
    const entryPort = bracketed?.[2] ?? hostPort?.[1];
    if (entryPort && entryPort !== port) continue;
    if (name && (host === name || host.endsWith(`.${name}`))) return true;
  }
  return false;
}

export function plainHttpProxyFetch(env: Record<string, string | undefined>, fallback: typeof fetch = fetch): typeof fetch | undefined {
  const configured = env.http_proxy || env.HTTP_PROXY;
  if (!configured) return undefined;
  let proxy: URL;
  try {
    proxy = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(configured) ? configured : `http://${configured}`);
    if (proxy.protocol !== "http:" && proxy.protocol !== "https:") return undefined;
  } catch { return undefined; }
  const noProxy = [env.no_proxy, env.NO_PROXY].filter(Boolean).join(",");
  const authorization = proxy.username
    ? `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}`
    : undefined;
  const proxied = (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const target = new URL(input instanceof Request ? input.url : String(input));
    const body = init.body;
    if (input instanceof Request || target.protocol !== "http:" || bypassesProxy(target, noProxy) || (body != null && typeof body !== "string")) {
      return fallback(input, init);
    }
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, name) => { headers[name] = value; });
    headers.host = target.host;
    if (authorization) headers["proxy-authorization"] = authorization;
    if (typeof body === "string") headers["content-length"] = String(Buffer.byteLength(body));
    return new Promise<Response>((resolve, reject) => {
      const send = proxy.protocol === "https:" ? httpsRequest : httpRequest;
      const request = send({
        host: proxy.hostname.replace(/^\[|\]$/g, ""),
        port: proxy.port || (proxy.protocol === "https:" ? 443 : 80),
        method: init.method ?? "GET",
        path: target.href,
        headers,
        ...(init.signal ? { signal: init.signal } : {}),
      });
      request.on("response", (response: IncomingMessage) => {
        const status = response.statusCode ?? 502;
        const received = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          for (const entry of Array.isArray(value) ? value : value === undefined ? [] : [value]) received.append(name, entry);
        }
        const empty = status === 204 || status === 205 || status === 304;
        if (empty) response.resume();
        try {
          resolve(new Response(empty ? null : Readable.toWeb(response) as ReadableStream<Uint8Array>, { status, statusText: response.statusMessage, headers: received }));
        } catch (error) {
          response.destroy();
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
      request.on("error", reject);
      request.end(body ?? undefined);
    });
  };
  return proxied as typeof fetch;
}
