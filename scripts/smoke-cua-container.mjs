// Live, non-destructive Cua sandbox smoke: official MCP handshake, tool
// discovery, desktop capture, and one pointer move inside an existing test VM.
import { spawn } from "node:child_process";

const runtime = process.env.OMB_CUA_RUNTIME || "docker";
const container = process.env.OMB_CUA_CONTAINER;
const socket = process.env.OMB_CUA_SOCKET || "/run/user/1000/openmausbot-cua.sock";
if (!container || !/^[a-zA-Z0-9_.-]+$/.test(container)) {
  throw new Error("set OMB_CUA_CONTAINER to the explicitly created smoke container name");
}
if (!['docker', 'podman', 'container'].includes(runtime)) throw new Error("unsupported container runtime");

const child = spawn(
  runtime,
  [
    "exec",
    "-i",
    "-u",
    "cua",
    "-e",
    "HOME=/home/cua",
    "-e",
    "DISPLAY=:1",
    "-e",
    "CUA_DRIVER_INSTALL_CHANNEL=python_package",
    "-e",
    "CUA_DRIVER_RS_TELEMETRY_ENABLED=0",
    container,
    "/usr/local/libexec/openmausbot/cua-driver",
    "mcp",
    "--socket",
    socket,
  ],
  { stdio: ["pipe", "pipe", "pipe"] },
);

const pending = new Map();
let buffer = "";
let stderr = "";
let nextId = 1;
child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
child.stdout.on("data", (chunk) => {
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
      reject(new Error(`${method} timed out${stderr ? `: ${stderr.trim()}` : ""}`));
    }, 30_000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });

function assertToolResult(result, name) {
  if (result?.isError) throw new Error(result.content?.[0]?.text || `${name} failed`);
  return result;
}

try {
  await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "openmausbot-container-smoke", version: "1" },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const listed = await rpc("tools/list");
  const names = new Set(listed.tools.map(({ name }) => name));
  for (const required of ["get_desktop_state", "list_apps", "move_cursor"]) {
    if (!names.has(required)) throw new Error(`Cua MCP did not expose ${required}`);
  }

  const captured = assertToolResult(
    await rpc("tools/call", { name: "get_desktop_state", arguments: {} }),
    "get_desktop_state",
  );
  const image = captured.content?.find((item) => item.type === "image");
  const bytes = image?.data ? Buffer.from(image.data, "base64") : Buffer.alloc(0);
  const png = bytes.length > 512 && bytes[0] === 0x89 && bytes[1] === 0x50;
  const jpeg = bytes.length > 512 && bytes[0] === 0xff && bytes[1] === 0xd8;
  if (!png && !jpeg) throw new Error("Cua returned no valid desktop image");

  assertToolResult(await rpc("tools/call", { name: "list_apps", arguments: {} }), "list_apps");
  assertToolResult(
    await rpc("tools/call", { name: "move_cursor", arguments: { x: 180, y: 140 } }),
    "move_cursor",
  );

  console.log(`Cua container smoke passed: ${listed.tools.length} tools, ${image.mimeType}, pointer input passed`);
} finally {
  child.stdin.end();
  const exited = new Promise((resolve) => child.once("close", resolve));
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2000))]);
  if (child.exitCode === null) child.kill("SIGTERM");
}
