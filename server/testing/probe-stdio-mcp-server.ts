// A stdio MCP server listing the tools in the JSON file PROBE_MCP_TOOLS_FILE, answering every other request with an
// error, as a server must for the native Antigravity CLI, which asks `server/discover` before `initialize` and waits.
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const tools: unknown = JSON.parse(readFileSync(process.env.PROBE_MCP_TOOLS_FILE ?? "", "utf8"));
const reply = (frame: Record<string, unknown>) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...frame })}\n`);

createInterface({ input: process.stdin }).on("line", (line) => {
  let frame: { id?: unknown; method?: string; params?: { protocolVersion?: string } };
  try { frame = JSON.parse(line); } catch { return; }
  if (frame.id === undefined || frame.id === null) return;
  if (frame.method === "initialize") {
    reply({ id: frame.id, result: { protocolVersion: frame.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "probe", version: "1" } } });
  } else if (frame.method === "tools/list") reply({ id: frame.id, result: { tools } });
  else if (frame.method === "ping") reply({ id: frame.id, result: {} });
  else reply({ id: frame.id, error: { code: -32601, message: "Method not found" } });
});
