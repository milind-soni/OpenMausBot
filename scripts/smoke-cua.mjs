// Read-only end-to-end smoke for the staged, packaged CUA path: native SDK
// host -> private embedded daemon -> official stdio MCP proxy -> desktop frame.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// staging is per-arch since the Intel build (dist-native/<arch>/…); default to
// the host arch, which is the only one whose native SDK can load in-process
const hostArch = process.arch === "arm64" ? "arm64" : "x64";
const resources = process.env.OMB_CUA_RESOURCES ?? join(root, "dist-native", hostArch);
process.env.OPENMAUSBOT_CUA_SDK_LIBRARY = join(resources, "cua-sdk/native/libcua_driver_sdk.dylib");
process.env.CUA_DRIVER_RS_TELEMETRY_ENABLED = "0";
const sdk = pathToFileURL(join(resources, "cua-sdk/cua-sdk.mjs")).href;
const binary = join(resources, "cua-driver");
const { EmbeddedCuaDriverHost } = await import(sdk);
const host = new EmbeddedCuaDriverHost(binary, "com.openmausbot.app");
let proxy;

try {
  const connection = await host.start();
  proxy = spawn(connection.mcp.command, connection.mcp.args, {
    env: {
      ...process.env,
      ...Object.fromEntries(connection.mcp.environment.map(({ name, value }) => [name, value])),
      CUA_DRIVER_EMBEDDED: "1",
      CUA_DRIVER_HOST_BUNDLE_ID: "com.openmausbot.app",
      CUA_DRIVER_RS_TELEMETRY_ENABLED: "0",
    },
    stdio: ["pipe", "pipe", "pipe"],
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
  const rpc = (method, params = {}) =>
    new Promise((resolve, reject) => {
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
      proxy.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });

  await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "openmausbot-package-smoke", version: "1" },
  });
  proxy.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const listed = await rpc("tools/list");
  const tool = listed.tools.find(({ name }) => name === "get_desktop_state");
  if (!tool) throw new Error("CUA MCP did not expose get_desktop_state");
  const captured = await rpc("tools/call", { name: tool.name, arguments: {} });
  if (captured.isError) throw new Error(captured.content?.[0]?.text ?? "CUA capture failed");
  const images = (captured.content ?? []).filter((item) => item.type === "image");
  if (!images.length || !images[0].data) throw new Error("CUA returned no desktop image");
  console.log(`CUA package smoke passed: ${listed.tools.length} tools, ${images[0].mimeType}`);
} finally {
  proxy?.kill();
  await host.stop().catch(() => {});
  host.uniffiDestroy();
}
