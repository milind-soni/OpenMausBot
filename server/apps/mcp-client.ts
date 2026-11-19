// Minimal MCP client for streamable-HTTP servers (no SDK — house style).
// One short-lived session per operation: initialize → initialized →
// request. Responses may be plain JSON or an SSE stream; for SSE we stop at
// the first message answering our id instead of waiting for the server to
// close the stream (a held-open stream must never stall a Buddy's turn).

export type McpFailureKind = "not_running" | "unauthorized" | "timeout" | "protocol";

export class McpError extends Error {
  // explicit field: `node --experimental-strip-types` rejects parameter properties
  readonly kind: McpFailureKind;
  constructor(kind: McpFailureKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

interface Target {
  endpoint: string;
  token?: string;
  timeoutMs: number;
}

type Json = Record<string, unknown>;

async function readMessage(res: Response, id: number): Promise<Json> {
  const type = res.headers.get("content-type") ?? "";
  if (!type.includes("text/event-stream")) {
    const body = (await res.json().catch(() => null)) as Json | Json[] | null;
    const msg = Array.isArray(body) ? body.find((m) => m.id === id) : body;
    if (!msg) throw new McpError("protocol", "The app sent a reply it doesn't understand.");
    return msg;
  }
  if (!res.body) throw new McpError("protocol", "The app sent an empty reply.");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let cut: number;
      // SSE events are separated by a blank line; collect each event's data lines
      while ((cut = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const event = buffer.slice(0, cut);
        buffer = buffer.slice(cut).replace(/^\r?\n\r?\n/, "");
        const data = event
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!data) continue;
        try {
          const msg = JSON.parse(data) as Json;
          if (msg.id === id) return msg;
        } catch {
          /* not JSON — keep reading */
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  throw new McpError("protocol", "The app closed the connection without answering.");
}

async function post(target: Target, sessionId: string | undefined, body: Json, signal: AbortSignal) {
  try {
    return await fetch(target.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(target.token ? { authorization: `Bearer ${target.token}` } : {}),
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw new McpError("timeout", "The app didn't respond in time.");
    const code = (error as { cause?: { code?: string } }).cause?.code;
    if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "EHOSTUNREACH") {
      throw new McpError("not_running", "The app isn't running, or its automation server is off.");
    }
    throw new McpError("not_running", "Couldn't reach the app on this computer.");
  }
}

function checkStatus(res: Response) {
  if (res.status === 401 || res.status === 403) {
    throw new McpError("unauthorized", "The app refused the access token. Copy it again from the app.");
  }
  if (!res.ok && res.status !== 202) throw new McpError("protocol", `The app answered with an error (HTTP ${res.status}).`);
}

/** Open a session, run one request in it, return its JSON-RPC result. */
export async function mcpRequest(target: Target, method: string, params: Json): Promise<Json> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), target.timeoutMs);
  try {
    const init = await post(target, undefined, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "gerer-build-studio", version: "1" } },
    }, controller.signal);
    checkStatus(init);
    const sessionId = init.headers.get("mcp-session-id") ?? undefined;
    const hello = await readMessage(init, 1);
    if (hello.error) throw new McpError("protocol", "The app rejected the connection.");
    const initialized = await post(target, sessionId, { jsonrpc: "2.0", method: "notifications/initialized" }, controller.signal);
    checkStatus(initialized);
    await initialized.body?.cancel().catch(() => {});
    const res = await post(target, sessionId, { jsonrpc: "2.0", id: 2, method, params }, controller.signal);
    checkStatus(res);
    const msg = await readMessage(res, 2);
    if (msg.error) {
      const err = msg.error as { message?: string };
      throw new McpError("protocol", err.message ? `The app reported: ${err.message}` : "The app reported an error.");
    }
    return (msg.result ?? {}) as Json;
  } catch (error) {
    // an abort mid-read surfaces as a plain AbortError
    if (controller.signal.aborted && !(error instanceof McpError)) throw new McpError("timeout", "The app didn't respond in time.");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function listTools(target: Target): Promise<McpTool[]> {
  const result = await mcpRequest(target, "tools/list", {});
  const tools = Array.isArray(result.tools) ? (result.tools as McpTool[]) : [];
  return tools.filter((t) => typeof t?.name === "string");
}

export async function callTool(target: Target, name: string, args: Json): Promise<Json> {
  return mcpRequest(target, "tools/call", { name, arguments: args });
}
