// A command MCP server for tests: one JSON-RPC message per line on stdin and stdout. Its stderr carries a secret, as a
// careless server's does. A tools/call with `notify` first sends a notification.
import { createInterface } from "node:readline";

process.stderr.write(`secret-in-stderr ${process.env.FAKE_SECRET ?? ""}\n`);
const reply = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  const { id, method, params } = message ?? {};
  if (id === undefined || method === undefined) return;
  if (method === "initialize") reply({ id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fake-stdio" } } });
  else if (method === "tools/list") reply({ id, result: { tools: [{ name: "echo", description: "Says the text back", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] } });
  else if (method === "tools/call") {
    if (params?.arguments?.notify) reply({ method: "notifications/message", params: { level: "info", data: "from the child" } });
    reply({ id, result: { content: [{ type: "text", text: params?.arguments?.text }] } });
  } else reply({ id, error: { code: -32601, message: "Method not found" } });
});
lines.on("close", () => process.exit(0));
