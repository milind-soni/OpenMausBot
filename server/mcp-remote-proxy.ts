// A stdio facade for selected HTTP/SSE MCP servers. Configuration stays in
// private environment data; stdout contains only protocol frames.
import { createInterface } from "node:readline";
import { RemoteMcpClient, remoteMcpSpec } from "./mcp-http.ts";

type Json = Record<string, unknown>;
function isRecord(value: unknown): value is Json {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function requestKey(id: unknown): string | undefined {
  return typeof id === "string" || (typeof id === "number" && Number.isFinite(id)) ? `${typeof id}:${id}` : undefined;
}
function send(frame: unknown): void { process.stdout.write(`${JSON.stringify(frame)}\n`); }
function error(id: unknown, code: number, message: string): void {
  send({ jsonrpc: "2.0", id: requestKey(id) ? id : null, error: { code, message } });
}

let spec;
try { spec = remoteMcpSpec(JSON.parse(process.env.OMB_REMOTE_MCP_SERVER ?? "")); } catch { /* invalid private config */ }
delete process.env.OMB_REMOTE_MCP_SERVER;
if (!spec) {
  process.stderr.write("mcp-remote-proxy: invalid remote MCP configuration\n");
  process.exit(1);
}
const client = new RemoteMcpClient(spec, { maxBytes: 32 * 1024 * 1024, onNotification: send });
const pending = new Map<string, AbortController>();
const tasks = new Set<Promise<void>>();
let initialized = false;
let closing = false;

async function handle(message: Json): Promise<void> {
  const id = requestKey(message.id);
  if (typeof message.method !== "string" || message.jsonrpc !== "2.0") {
    error(message.id, -32600, "Invalid JSON-RPC request");
    return;
  }
  if (message.method === "notifications/cancelled") {
    const key = isRecord(message.params) ? requestKey(message.params.requestId) : undefined;
    if (key) pending.get(key)?.abort();
    return;
  }
  if (!id) {
    // initialize() has already sent this once with its negotiated version.
    if (message.method === "notifications/initialized" && initialized) return;
    try { await client.notify(message.method, message.params, AbortSignal.timeout(30_000)); }
    catch { /* notifications have no reply and must not print remote details */ }
    return;
  }
  if (pending.has(id)) { error(message.id, -32600, "Duplicate request ID"); return; }
  const controller = new AbortController();
  pending.set(id, controller);
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(message.method === "tools/call" ? 120_000 : 30_000)]);
  try {
    const result = message.method === "initialize"
      ? await client.initialize("OpenMausBot tool proxy", signal)
      : await client.request(message.method, message.params, signal);
    if (message.method === "initialize") initialized = true;
    send({ jsonrpc: "2.0", id: message.id, result });
  } catch {
    // Remote errors may contain URLs or header values. Do not relay their text.
    error(message.id, signal.aborted ? -32800 : -32603, signal.aborted ? "MCP request cancelled" : "Remote MCP request failed");
  } finally { pending.delete(id); }
}

const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  if (closing || !line.trim()) return;
  let value: unknown;
  try { value = JSON.parse(line); } catch { error(null, -32700, "Invalid JSON-RPC frame"); return; }
  if (!isRecord(value)) { error(null, -32600, "Invalid JSON-RPC frame"); return; }
  const task = handle(value);
  tasks.add(task);
  void task.finally(() => tasks.delete(task));
});
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  input.close();
  for (const controller of pending.values()) controller.abort();
  await Promise.allSettled(tasks);
  await client.close();
  process.exit(0);
}
input.on("close", () => { void shutdown(); });
process.on("SIGTERM", () => { void shutdown(); });
process.on("SIGINT", () => { void shutdown(); });
