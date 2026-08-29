// Read-only end-to-end smoke for the staged Windows CUA path. The returned
// frame is validated in memory and is never written to disk or printed.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") throw new Error("smoke-cua-win is Windows-only");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const resources = process.env.OMB_CUA_RESOURCES ?? join(root, "dist-native", "win32-x64");
const binary = join(resources, "cua-driver.exe");
const require = createRequire(import.meta.url);
const { createWindowsCuaRuntime } = require("../electron/cua-windows-runtime.cjs");
const runtime = createWindowsCuaRuntime();
let proxy;

try {
  const connection = await runtime.start(binary);
  proxy = spawn(connection.mcpCommand, connection.mcpArgs, {
    env: { ...process.env, ...connection.mcpEnv },
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const pending = new Map();
  let buffer = "";
  let nextId = 1;
  proxy.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      const settle = pending.get(message.id);
      if (settle) {
        pending.delete(message.id);
        settle(message);
      }
    }
  });
  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out`));
    }, 20_000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    });
    proxy.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });

  await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "agent-centipede-windows-package-smoke", version: "1" },
  });
  proxy.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const listed = await rpc("tools/list");
  const tool = listed.tools.find(({ name }) => name === "get_desktop_state");
  if (!tool) throw new Error("CUA MCP did not expose get_desktop_state");
  const captured = await rpc("tools/call", { name: tool.name, arguments: {} });
  if (captured.isError) throw new Error(captured.content?.[0]?.text ?? "CUA capture failed");
  const image = (captured.content ?? []).find((item) => item.type === "image" && item.data);
  if (!image) throw new Error("CUA returned no desktop image");
  console.log(`Windows CUA package smoke passed: ${listed.tools.length} tools, ${image.mimeType}`);
} finally {
  proxy?.kill();
  await runtime.stop().catch(() => {});
}
