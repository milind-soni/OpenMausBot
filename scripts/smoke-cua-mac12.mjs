// Protocol smoke for the macOS 12.3–14 helper: the daemon serves one socket, the stdio proxy speaks MCP over it.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const binary = join(root, "electron", "resources", "cua-mac12", "cua-driver-mac12");
const tools = join(root, "electron", "resources", "cua-mac12", "tools.json");
const directory = mkdtempSync(join(tmpdir(), "cua-mac12-smoke-"));
const socketPath = join(directory, "cua.sock");
const daemon = [];
const proxy = [];

function start(command, args, stdio) {
  const child = spawn(command, args, { stdio });
  const tail = [];
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk) => {
    tail.push(chunk);
    while (tail.join("").length > 8_192) tail.shift();
  });
  child.stderrTail = () => tail.join("").trim();
  return child;
}

function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGKILL");
}

const waitFor = async (check, label) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
};

function frame(id, method, params) {
  return `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
}

function call(id, name, args = {}) {
  return frame(id, "tools/call", { name, arguments: args });
}

function parseLines(buffer, onLine) {
  let start = 0;
  for (let index = buffer.indexOf("\n", start); index >= 0; index = buffer.indexOf("\n", start)) {
    onLine(buffer.slice(start, index));
    start = index + 1;
  }
  return buffer.slice(start);
}

async function run() {
  const server = start(binary, ["serve", "--socket", socketPath, "--tools", tools], ["ignore", "ignore", "pipe"]);
  daemon.push(server);
  await waitFor(() => {
    try {
      return statSync(socketPath).isSocket();
    } catch {
      return false;
    }
  }, "the helper socket");
  if (server.exitCode !== null) throw new Error(`helper exited: ${server.stderrTail()}`);

  const client = start(binary, ["mcp", "--socket", socketPath], ["pipe", "pipe", "pipe"]);
  proxy.push(client);
  const responses = new Map();
  let pending = "";
  client.stdout.setEncoding("utf8");
  client.stdout.on("data", (chunk) => {
    pending = parseLines(pending + chunk, (line) => {
      if (!line.trim()) return;
      const message = JSON.parse(line);
      if (message.id) responses.set(message.id, message);
    });
  });

  const requests = [
    frame(1, "initialize", { protocolVersion: "2025-03-26" }),
    `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    frame(2, "tools/list", {}),
    call(3, "get_screen_size"),
    call(4, "list_apps"),
    call(5, "check_permissions"),
  ];
  for (const request of requests) client.stdin.write(request);

  await waitFor(() => responses.size >= 5, "five responses");
  const fail = (message) => {
    throw new Error(message);
  };
  const result = (id) => responses.get(id)?.result ?? fail(`no response ${id}`);

  if (result(1).serverInfo?.name !== "cua-driver-mac12") fail("initialize did not name cua-driver-mac12");
  const names = new Set(result(2).tools.map((tool) => tool.name));
  for (const required of ["get_window_state", "click", "type_text", "list_windows", "list_apps", "check_permissions"]) {
    if (!names.has(required)) fail(`tools/list is missing ${required}`);
  }
  const screen = JSON.parse(result(3).content[0].text);
  if (!(screen.width > 0 && screen.height > 0)) fail(`get_screen_size returned ${result(3).content[0].text}`);
  const apps = JSON.parse(result(4).content[0].text).apps;
  if (!Array.isArray(apps) || apps.length < 1) fail("list_apps returned no apps");
  const permissions = result(5).structuredContent;
  if (typeof permissions?.accessibility !== "boolean" || typeof permissions?.screen_recording !== "boolean") {
    fail("check_permissions did not return both booleans");
  }

  // A turn's proxy can outlive its turn: a second client must still be answered while the first sits idle.
  const second = start(binary, ["mcp", "--socket", socketPath], ["pipe", "pipe", "pipe"]);
  proxy.push(second);
  let secondAnswered = false;
  let secondPending = "";
  second.stdout.setEncoding("utf8");
  second.stdout.on("data", (chunk) => {
    secondPending = parseLines(secondPending + chunk, (line) => {
      if (line.includes('"id":11')) secondAnswered = true;
    });
  });
  second.stdin.write(frame(11, "initialize", { protocolVersion: "2025-03-26" }));
  await waitFor(() => secondAnswered, "a second client to be answered while the first is connected")
    .catch(() => fail("a second MCP client was not answered while the first stayed connected"));

  console.log(`cua-driver-mac12: ${result(1).serverInfo.name}, ${names.size} tools, ${apps.length} apps, ` +
    `screen ${screen.width}x${screen.height}, accessibility=${permissions.accessibility}, ` +
    `screen_recording=${permissions.screen_recording}, concurrent clients ok`);
}

let failure = null;
try {
  await run();
} catch (error) {
  failure = error;
} finally {
  // Reading the tails before the kill keeps the failure message useful.
  const tails = [...daemon, ...proxy].map((child) => child.stderrTail()).filter(Boolean).join("\n");
  for (const child of [...proxy, ...daemon]) stop(child);
  rmSync(directory, { recursive: true, force: true });
  if (failure) {
    console.error(`smoke failed: ${failure.message}`);
    if (tails) console.error(tails);
    process.exit(1);
  }
}
