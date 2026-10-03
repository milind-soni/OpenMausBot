// Per-turn MCP bridge. Account secrets and the exact computer lease arrive in
// the child environment, never on argv or in tool descriptions/logs.
import readline from "node:readline";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createControlClient, CONTROL_REFUSAL_PLAIN } from "./control-client.ts";
import { leasedComputerAction, ORGO_TOOLS, redactOrgo, type OrgoLease } from "./orgo.ts";

export function createOrgoComputerProxy(lease: OrgoLease, control = createControlClient()) {
  return {
    async call(name: string, args: unknown, signal?: AbortSignal) {
      try {
        if (!control.configured) throw new Error("Orgo computer control gate missing");
        const held = await control.state(true);
        signal?.throwIfAborted();
        if (held.held || held.blockedReason) return { isError: true, content: [{ type: "text", text: held.blockedReason || CONTROL_REFUSAL_PLAIN }] };
        return await leasedComputerAction(lease, name, args, signal);
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: redactOrgo(error instanceof Error ? error.message : "Orgo computer operation failed", [lease.apiKey]) }] };
      }
    },
  };
}
function startProxy(): void {
  const lease: OrgoLease = {
    apiKey: process.env.ORGO_API_KEY ?? "", workspaceId: process.env.ORGO_WORKSPACE_ID ?? "",
    computerId: process.env.ORGO_COMPUTER_ID ?? "", computerName: process.env.ORGO_COMPUTER_NAME ?? "",
  };
  const proxy = createOrgoComputerProxy(lease);
  const pending = new Map<unknown, AbortController>();
  const send = (id: unknown, result: unknown) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
  const rpcError = (id: unknown, code: number, message: string) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on("line", (line) => {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(line); if (!msg || typeof msg !== "object" || Array.isArray(msg)) throw new Error(); }
    catch { rpcError(null, -32700, "Invalid JSON-RPC request"); return; }
    const params = (msg.params ?? {}) as Record<string, unknown>;
    if (msg.method === "notifications/cancelled") { pending.get(params.requestId)?.abort(); return; }
    if (msg.id === undefined) return;
    switch (msg.method) {
      case "initialize": send(msg.id, { protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "openmausbot-orgo", version: "1.0.0" } }); break;
      case "ping": send(msg.id, {}); break;
      case "tools/list": send(msg.id, { tools: ORGO_TOOLS }); break;
      case "tools/call": {
        if (pending.has(msg.id) || typeof params.name !== "string") { rpcError(msg.id, -32602, "Invalid tool request"); break; }
        const controller = new AbortController();
        pending.set(msg.id, controller);
        void proxy.call(params.name, params.arguments ?? {}, controller.signal).then((result) => send(msg.id, result)).finally(() => pending.delete(msg.id));
        break;
      }
      default: rpcError(msg.id, -32601, "Method not found");
    }
  });
  const close = () => { for (const controller of pending.values()) controller.abort(); lines.close(); };
  lines.on("close", () => { for (const controller of pending.values()) controller.abort(); });
  process.once("SIGTERM", close);
  process.once("SIGINT", close);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) startProxy();
