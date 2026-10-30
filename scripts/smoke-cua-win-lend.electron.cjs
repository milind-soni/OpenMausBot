// Electron main for scripts/smoke-cua-win-lend.mjs, which starts it under a copy of Electron named like the installed app.
const { app } = require("electron");
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const { createInterface } = require("node:readline");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");

const root = resolve(__dirname, "..");
app.setPath("userData", process.env.OMB_SMOKE_USER_DATA);
const report = { packaged: app.isPackaged, resourcesPath: process.resourcesPath };
const say = (line) => console.log(`[lend smoke] ${line}`);
const load = (file) => import(pathToFileURL(join(root, "electron", file)).href);
const firstText = (result) => String(result?.content?.find?.((part) => part?.type === "text")?.text ?? "");

/** The driver's own tool list over its stdio MCP proxy, started with this process's whole environment. */
async function driverTools(mcp) {
  const child = spawn(mcp.mcpCommand, mcp.mcpArgs, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...mcp.mcpEnv } });
  const lines = createInterface({ input: child.stdout });
  let stderr = "";
  child.stderr.on("data", (bytes) => { stderr = (stderr + bytes).slice(-2000); });
  const pending = new Map();
  lines.on("line", (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    pending.get(message.id)?.(message);
  });
  const request = (id, method, params) => new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`${method} timed out; stderr: ${stderr}`)), 15_000);
    child.once("exit", (code) => fail(new Error(`proxy exited ${code}; stderr: ${stderr}`)));
    pending.set(id, (message) => { clearTimeout(timer); message.error ? fail(new Error(JSON.stringify(message.error))) : done(message.result); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  try {
    await request(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "omb-lend-smoke", version: "1" } });
    child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    return (await request(2, "tools/list", {}))?.tools ?? [];
  } finally {
    lines.close();
    child.stdin.end();
    child.kill();
  }
}

async function smoke() {
  const cua = await load("cua.mjs");
  const { localComputerReady } = require(join(root, "electron", "capabilities.cjs"));
  const { sharedCuaConnection } = await load("shared-cua-connection.mjs");
  const { createSharedCua, executeSharedOperation } = await load("shared-computer-access.mjs");
  const { LENT_SCREEN_ARGUMENTS } = await load("lent-screen-tools.mjs");
  say(`packaged: ${app.isPackaged}; resources: ${process.resourcesPath}`);
  if (!app.isPackaged) throw new Error("Electron did not take this copy for the installed app");

  try {
    return await lend(cua, { localComputerReady, sharedCuaConnection, createSharedCua, executeSharedOperation, LENT_SCREEN_ARGUMENTS });
  } finally {
    await cua.stopCua();
  }
}

async function lend(cua, { localComputerReady, sharedCuaConnection, createSharedCua, executeSharedOperation, LENT_SCREEN_ARGUMENTS }) {
  const started = Date.now();
  const connection = await cua.startCua();
  Object.assign(report, { mode: connection?.mode ?? null, reason: connection?.reason ?? null, startMs: Date.now() - started });
  say(`computer control mode: ${report.mode} after ${report.startMs} ms${report.reason ? `: ${report.reason}` : ""}`);
  const mcp = sharedCuaConnection(connection);
  report.lendsScreen = mcp !== null && localComputerReady("win32", connection);
  say(`apps and screen lent to the Cloud: ${report.lendsScreen ? "yes" : "no"}`);
  if (!report.lendsScreen) return false;

  try {
    const tools = await driverTools(mcp);
    report.driverTools = tools.length;
    report.droppedRequired = tools.filter((tool) => Object.hasOwn(LENT_SCREEN_ARGUMENTS, tool.name)).flatMap((tool) =>
      (tool.inputSchema?.required ?? []).filter((key) => !Object.hasOwn(LENT_SCREEN_ARGUMENTS[tool.name], key)).map((key) => `${tool.name}.${key}`));
    report.unlent = tools.map((tool) => tool.name).filter((name) => !Object.hasOwn(LENT_SCREEN_ARGUMENTS, name));
    say(`driver tools over the full environment: ${tools.length}; required arguments a lent screen drops: ${report.droppedRequired.join(", ") || "none"}`);
  } catch (error) {
    report.driverToolsError = String(error?.message ?? error);
    say(`driver tools over the full environment failed: ${report.driverToolsError}`);
  }

  const grant = { enabled: true, computer: true, folders: [] };
  let shared = null;
  const open = async () => (shared ??= createSharedCua(mcp));
  try {
    const listed = await executeSharedOperation(grant, { action: "computer_tools" }, AbortSignal.timeout(45_000), open);
    report.lentTools = JSON.parse(firstText(listed)).tools?.length ?? 0;
    say(`lend path computer_tools: ${report.lentTools} tools`);
    for (const tool_name of ["get_screen_size", "list_apps"]) {
      const result = await executeSharedOperation(grant, { action: "computer_call", tool_name, arguments: {} }, AbortSignal.timeout(45_000), open);
      report[tool_name] = { isError: result?.isError === true, text: firstText(result).slice(0, 300) };
      say(`lend path ${tool_name}: ${result?.isError === true ? "error" : "ok"}: ${report[tool_name].text.slice(0, 160)}`);
    }
  } catch (error) {
    report.lendError = String(error?.message ?? error);
    say(`lend path failed: ${report.lendError}`);
  } finally {
    shared?.close();
  }
  return report.lentTools > 0 && report.get_screen_size?.isError === false && report.list_apps?.isError === false;
}

app.whenReady().then(async () => {
  let ok = false;
  try {
    ok = await smoke();
  } catch (error) {
    report.error = String(error?.stack ?? error);
    say(`failed: ${report.error}`);
  }
  report.ok = ok;
  writeFileSync(process.env.OMB_SMOKE_REPORT, JSON.stringify(report, null, 2));
  say(ok ? "smoke:cua-win-lend OK" : "smoke:cua-win-lend FAILED");
  app.exit(ok ? 0 : 1);
});
