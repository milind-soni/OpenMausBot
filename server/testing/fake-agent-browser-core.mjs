#!/usr/bin/env node
// Repository-owned stand-in for agent-browser 0.37.0's `mcp --tools core`, for
// hermetic tests of a member workspace's browser. It advertises a few real
// core tool names, plus upload (which the core profile does not offer), and
// records in its own HOME how it was launched and every call that reached it,
// so a test can see exactly what the harness let through.
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const log = (entry) => {
  try { appendFileSync(join(process.env.HOME ?? ".", "fake-agent-browser.jsonl"), JSON.stringify(entry) + "\n"); } catch { /* read-only home */ }
};
const LAUNCH = ["AGENT_BROWSER_SESSION", "AGENT_BROWSER_PROXY", "AGENT_BROWSER_PROXY_BYPASS", "AGENT_BROWSER_ARGS", "AGENT_BROWSER_SOCKET_DIR", "AGENT_BROWSER_CDP", "TMPDIR", "HOME"];
const args = process.argv.slice(2);
log({ args, launch: Object.fromEntries(LAUNCH.map((name) => [name, process.env[name] ?? null])) });
if (args[0] !== "mcp") {
  if (args[0] === "session" && args[1] === "list") process.stdout.write(JSON.stringify({ success: true, data: { sessions: [] } }));
  process.exit(0);
}
const schema = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const tools = [
  { name: "agent_browser_open", description: "Open a URL in the browser.", inputSchema: schema({ url: { type: "string" }, headed: { type: "boolean" }, webmcp: { type: "boolean" } }, ["url"]) },
  { name: "agent_browser_read", description: "Read the page as markdown.", inputSchema: schema({ url: { type: "string" }, outline: { type: "boolean" } }) },
  { name: "agent_browser_screenshot", description: "Take a screenshot of the page.", inputSchema: schema({ path: { type: "string" }, screenshotDir: { type: "string" }, fullPage: { type: "boolean" } }) },
  { name: "agent_browser_upload", description: "Upload files to an input.", inputSchema: schema({ selector: { type: "string" }, files: { type: "array", items: { type: "string" } } }, ["selector", "files"]) },
];
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const frame = JSON.parse(line);
  if (frame.id === undefined) return;
  if (frame.method === "initialize") return reply(frame.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fake-agent-browser-core", version: "1" } });
  if (frame.method === "tools/list") return reply(frame.id, { tools });
  if (frame.method === "tools/call") {
    log({ call: frame.params.name, arguments: frame.params.arguments ?? {} });
    return reply(frame.id, { content: [{ type: "text", text: `fixture browser ${frame.params.name} ok` }] });
  }
  reply(frame.id, {});
});
