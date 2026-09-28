// A small MCP client for servers OpenMausBot does not start itself: the
// current streamable HTTP transport and the older SSE one. The engines
// speak to these servers natively; this client exists for the Test button
// (prove the handshake, list the tools) and for anything else the harness
// itself must ask a remote server. It never logs a header value.
import type { RemoteMcpSpec } from "./contracts.ts";

export type McpHttpFailure = "network" | "status" | "protocol";

export class McpHttpError extends Error {
  readonly kind: McpHttpFailure;
  readonly status: number | undefined;

  constructor(kind: McpHttpFailure, message: string, status?: number) {
    super(message);
    this.name = "McpHttpError";
    this.kind = kind;
    this.status = status;
  }
}

/** Bytes of one response (or one SSE stream) a probe is willing to read. */
const MAX_BODY_BYTES = 1_048_576;
const PROTOCOL_VERSION = "2025-06-18";

interface JsonRpcMessage {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
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

function unwrap(message: JsonRpcMessage): unknown {
  if (message.error !== undefined) {
    const detail = isRecord(message.error) && typeof message.error.message === "string" ? message.error.message : "request failed";
    throw new McpHttpError("protocol", `MCP error: ${detail}`);
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

/** One SSE event: its type (default "message") and joined data lines. */
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

/** Read an event stream until the handler says stop, the server ends it,
 * or the signal fires. Bounded, so a chatty server cannot fill memory. */
async function readSse(
  response: Response,
  signal: AbortSignal,
  onEvent: (event: SseEvent) => "stop" | undefined,
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
      if (bytes > MAX_BODY_BYTES) throw new McpHttpError("protocol", "event stream too large");
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

async function readBounded(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return text + decoder.decode();
    bytes += value.byteLength;
    if (bytes > MAX_BODY_BYTES) {
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
  private sessionId: string | null = null;
  private protocolVersion: string | null = null;
  private nextId = 1;
  private closed = false;
  /** Legacy SSE: one long GET stream carries every response. */
  private readonly pending = new Map<number, Pending>();
  private sseEndpoint: Promise<string> | null = null;
  private readonly sseAbort = new AbortController();

  constructor(target: RemoteMcpSpec, options: { fetch?: typeof fetch } = {}) {
    this.target = target;
    this.fetchImpl = options.fetch ?? fetch;
  }

  /** The MCP handshake: initialize, then the initialized notification. */
  async initialize(clientName: string, signal: AbortSignal): Promise<unknown> {
    const result = await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: clientName, version: "1" },
    }, signal);
    if (isRecord(result) && typeof result.protocolVersion === "string") this.protocolVersion = result.protocolVersion;
    await this.notify("notifications/initialized", undefined, signal);
    return result;
  }

  request(method: string, params: unknown, signal: AbortSignal): Promise<unknown> {
    if (this.closed) return Promise.reject(new McpHttpError("protocol", "client closed"));
    const id = this.nextId++;
    const frame = { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) };
    return this.target.type === "sse" ? this.sseRequest(id, frame, signal) : this.streamableRequest(id, frame, signal);
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
    // Streamable HTTP: tell the server its session is over. Best effort —
    // many servers answer 405 here, and a probe has nothing left to lose.
    if (this.sessionId && this.target.type !== "sse") {
      try {
        const headers = this.headers();
        headers.set("mcp-session-id", this.sessionId);
        const response = await this.fetchImpl(this.target.url, { method: "DELETE", headers, signal: AbortSignal.timeout(2_000) });
        drain(response);
      } catch {
        // the session lapses on its own
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
      throw new McpHttpError("status", `HTTP ${response.status}`, response.status);
    }
    const session = response.headers.get("mcp-session-id");
    if (session) this.sessionId = session;
    return response;
  }

  // ── streamable HTTP: each request is one POST; the answer is JSON or a
  //    short event stream that carries the response among server messages ──
  private async streamableRequest(id: number, frame: unknown, signal: AbortSignal): Promise<unknown> {
    const response = await this.post(this.target.url, frame, signal);
    const type = (response.headers.get("content-type") ?? "").toLowerCase();
    if (type.startsWith("application/json")) {
      const parsed = parseMessage(await readBounded(response));
      const message = (Array.isArray(parsed) ? parsed : parsed ? [parsed] : []).find((entry) => entry.id === id);
      if (!message) throw new McpHttpError("protocol", "response did not answer the request");
      return unwrap(message);
    }
    if (type.startsWith("text/event-stream")) {
      let found: JsonRpcMessage | undefined;
      await readSse(response, signal, (event) => {
        if (event.event !== "message") return undefined;
        const parsed = parseMessage(event.data);
        const message = (Array.isArray(parsed) ? parsed : parsed ? [parsed] : []).find((entry) => entry.id === id);
        if (!message) return undefined;
        found = message;
        return "stop";
      });
      if (signal.aborted) throw new McpHttpError("network", "aborted");
      if (!found) throw new McpHttpError("protocol", "event stream ended without the response");
      return unwrap(found);
    }
    drain(response);
    throw new McpHttpError("protocol", "unexpected content type");
  }

  // ── legacy SSE: a GET opens the stream, its first event names where to
  //    POST, and every response comes back over the stream ──
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
      // the caller's signal covers the opening; once open, the stream lives
      // until close(), because later requests are answered on it
      const opening = AbortSignal.any([signal, this.sseAbort.signal]);
      this.fetchImpl(this.target.url, { method: "GET", headers, signal: opening })
        .then(async (response) => {
          if (!response.ok) {
            drain(response);
            throw new McpHttpError("status", `HTTP ${response.status}`, response.status);
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
          });
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
}
