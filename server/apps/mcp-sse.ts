// Affinity uses the original MCP HTTP+SSE transport: one persistent GET
// receives replies, and POSTs go to the endpoint advertised on that stream.
// Keep the session so SDK documentation reads apply to subsequent scripts.
import { McpError, checkStatus, rpcResult, type Json, type McpTarget } from "./mcp-common.ts";

const IDLE_MS = 10 * 60_000;
const MAX_FRAME = 16 * 1024 * 1024;
const sessions = new Map<string, Session>();

function failure(error: unknown): McpError {
  if (error instanceof McpError) return error;
  return new McpError("not_running", "The app connection closed. Reconnect and read the SDK preamble again before running a script.");
}

class Session {
  readonly ready: Promise<void>;
  private abort = new AbortController();
  private pending = new Map<number, { resolve: (msg: Json) => void; reject: (e: Error) => void }>();
  private nextId = 0;
  private postURL = "";
  private ended?: McpError;
  private idle?: ReturnType<typeof setTimeout>;
  private active = 0;
  private endpointReject?: (e: Error) => void;

  constructor(target: McpTarget, key: string) {
    this.target = target;
    this.key = key;
    this.ready = Promise.resolve().then(() => this.connect());
    // A failed connect may settle before the first request starts awaiting it.
    void this.ready.catch(() => {});
  }
  private readonly target: McpTarget;
  private readonly key: string;

  get endpoint() { return this.target.endpoint; }

  close(error = new McpError("not_running", "The app connection was reset. Read its SDK preamble again before running a script.")) {
    if (this.ended) return;
    this.ended = error;
    clearTimeout(this.idle);
    this.abort.abort();
    if (sessions.get(this.key) === this) sessions.delete(this.key);
    this.endpointReject?.(error);
    for (const p of this.pending.values()) p.reject(error);
    this.pending.clear();
  }

  private touch() {
    clearTimeout(this.idle);
    if (!this.active && !this.ended) {
      this.idle = setTimeout(() => this.close(), IDLE_MS);
      this.idle.unref?.();
    }
  }

  private async connect() {
    try {
      const source = new URL(this.target.endpoint);
      if (!["http:", "https:"].includes(source.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(source.hostname) || source.username || source.password) {
        throw new McpError("protocol", "Apps connect only to this computer.");
      }
      const response = await fetch(source, {
        headers: { accept: "text/event-stream", ...this.auth() },
        redirect: "error", signal: this.abort.signal,
      });
      checkStatus(response);
      if (!response.headers.get("content-type")?.includes("text/event-stream") || !response.body) {
        await response.body?.cancel();
        throw new McpError("protocol", "The app did not open an MCP event stream.");
      }
      const endpoint = new Promise<void>((resolve, reject) => {
        this.endpointReject = reject;
        void this.read(response.body!, source, resolve).catch(e => this.close(failure(e)));
      });
      await endpoint;
      this.endpointReject = undefined;
      const hello = await this.send("initialize", {
        protocolVersion: this.target.protocolVersion ?? "2025-11-25", capabilities: {},
        clientInfo: { name: "gerer-build-studio", version: "1" },
      });
      if (hello.protocolVersion !== (this.target.protocolVersion ?? "2025-11-25")) {
        throw new McpError("protocol", "The app uses an unsupported MCP version. Update the app or Studio.");
      }
      await this.post({ jsonrpc: "2.0", method: "notifications/initialized" });
    } catch (error) {
      this.close(failure(error));
      throw this.ended;
    }
  }

  private auth(): Record<string, string> {
    return this.target.token ? { authorization: `Bearer ${this.target.token}` } : {};
  }

  private async read(body: ReadableStream<Uint8Array>, source: URL, endpointReady: () => void) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) throw new McpError("not_running", "The app disconnected. Read its SDK preamble again after reconnecting.");
        buffer += decoder.decode(value, { stream: true });
        let cut: number;
        while ((cut = buffer.search(/\r?\n\r?\n/)) !== -1) {
          const frame = buffer.slice(0, cut);
          buffer = buffer.slice(cut).replace(/^\r?\n\r?\n/, "");
          if (frame.length > MAX_FRAME) throw new McpError("protocol", "The app reply was too large.");
          const lines = frame.split(/\r?\n/);
          const kind = lines.find(l => l.startsWith("event:"))?.slice(6).trim() ?? "message";
          const data = lines.filter(l => l.startsWith("data:")).map(l => l.slice(5).replace(/^ /, "")).join("\n");
          if (!data) continue;
          if (kind === "endpoint") {
            if (this.postURL) throw new McpError("protocol", "The app changed its message address unexpectedly.");
            const url = new URL(data, source);
            if (url.origin !== source.origin || url.username || url.password || url.hash) {
              throw new McpError("protocol", "The app advertised an unsafe message address.");
            }
            this.postURL = url.href;
            endpointReady();
          } else if (kind === "message") {
            let msg: Json;
            try { msg = JSON.parse(data) as Json; } catch { throw new McpError("protocol", "The app sent an invalid MCP message."); }
            if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0") throw new McpError("protocol", "The app sent an invalid MCP message.");
            if (typeof msg.id === "number") this.pending.get(msg.id)?.resolve(msg);
          }
        }
        if (buffer.length > MAX_FRAME) throw new McpError("protocol", "The app reply was too large.");
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  }

  private async post(body: Json) {
    if (this.ended) throw this.ended;
    const response = await fetch(this.postURL, {
      method: "POST", headers: { "content-type": "application/json", ...this.auth() },
      body: JSON.stringify(body), redirect: "error", signal: this.abort.signal,
    });
    checkStatus(response);
    await response.body?.cancel();
  }

  private async send(method: string, params: Json): Promise<Json> {
    const id = ++this.nextId;
    const reply = new Promise<Json>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    void reply.catch(() => {});
    try {
      try { await this.post({ jsonrpc: "2.0", id, method, params }); }
      catch (error) { this.close(failure(error)); throw error; }
      return rpcResult(await reply);
    } finally {
      this.pending.delete(id);
    }
  }

  async request(method: string, params: Json, timeoutMs: number): Promise<Json> {
    this.active++;
    clearTimeout(this.idle);
    const timer = setTimeout(() => this.close(new McpError("timeout", "The app didn't respond in time. A script may still have run; check the document before trying again.")), timeoutMs);
    try {
      await this.ready;
      if (this.ended) throw this.ended;
      return await this.send(method, params);
    } catch (error) {
      // Closing never retries a request: scripts may already have changed a document.
      // JSON-RPC tool errors leave a healthy session usable (e.g. preamble gate).
      if (!(error instanceof McpError) || error.kind !== "protocol") this.close(failure(error));
      throw failure(error);
    } finally {
      clearTimeout(timer);
      this.active--;
      this.touch();
    }
  }
}

export function closeSseSessions(endpoint?: string) {
  for (const session of sessions.values()) {
    if (!endpoint || session.endpoint === endpoint) session.close();
  }
}

export function sseRequest(target: McpTarget, method: string, params: Json): Promise<Json> {
  const key = JSON.stringify([target.endpoint, target.token ?? "", target.protocolVersion ?? "2025-11-25"]);
  let session = sessions.get(key);
  if (!session) {
    session = new Session(target, key);
    sessions.set(key, session);
  }
  return session.request(method, params, target.timeoutMs);
}
