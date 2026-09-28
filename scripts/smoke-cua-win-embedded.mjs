// Windows CUA smoke: prove the staged win32 SDK bundle loads through the same
// env-var redirect the packaged app uses and that one embedded driver host can
// start and stop. Mirrors electron/cua.mjs startEmbedded(); run it after
// `pnpm build:cua:win`, which produces dist-native/cua-win32-x64/.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { execFile, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { createBackgroundExecutable } from "./cua-windows-background.mjs";

if (process.platform !== "win32") {
  console.error("smoke-cua-win-embedded is Windows-only");
  process.exit(1);
}

const stage = join(import.meta.dirname, "..", "dist-native", "cua-win32-x64");
const binary = join(stage, "cua-driver.exe");
const background = join(stage, "cua-driver-background.exe");
const bundle = join(stage, "cua-sdk", "cua-sdk.mjs");
const dll = join(stage, "cua-sdk", "native", "cua_driver_sdk.dll");

for (const [label, file] of [["cua-driver.exe", binary], ["background daemon", background], ["cua-sdk bundle", bundle], ["sdk dll", dll]]) {
  if (!existsSync(file)) {
    console.error(`staged ${label} is missing at ${file} — run pnpm build:cua:win first`);
    process.exit(1);
  }
}

if (!createBackgroundExecutable(readFileSync(binary)).equals(readFileSync(background))) {
  throw new Error("background daemon does not match the CLI's executable sections and derived PE headers");
}

// The bundled resolver patch (prepare-cua-win.mjs) redirects the SDK's native
// library lookup to exactly this path; verify the redirect is present, or the
// packaged app would fall back to node_modules paths that do not exist.
const bundledSource = readFileSync(bundle, "utf8");
if (!bundledSource.includes("OPENMAUSBOT_CUA_SDK_LIBRARY")) {
  console.error("staged cua-sdk.mjs lacks the OPENMAUSBOT_CUA_SDK_LIBRARY resolver patch — re-run pnpm build:cua:win");
  process.exit(1);
}

process.env.OPENMAUSBOT_CUA_SDK_LIBRARY = dll;
process.env.CUA_DRIVER_RS_TELEMETRY_ENABLED = "0";
const watchdog = setTimeout(() => {
  console.error("smoke:cua-win timed out");
  process.exit(1); // Closing the host also closes the daemon's parent-liveness pipe.
}, 30_000);

async function checkNoConsole(pid) {
  // Probe only this smoke's daemon from a separate, hidden process. An existing
  // process with no console makes AttachConsole fail with ERROR_INVALID_HANDLE.
  await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `
Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public static class ConsoleProbe {
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AttachConsole(uint pid);
}
'@
[ConsoleProbe]::FreeConsole() | Out-Null
$attached = [ConsoleProbe]::AttachConsole([uint32]$env:OMB_SMOKE_DAEMON_PID)
$failure = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
if ($attached) { [ConsoleProbe]::FreeConsole() | Out-Null; throw 'Background daemon has a console' }
if ($failure -ne 6) { throw "Console probe failed with unexpected Windows error $failure" }
`], { windowsHide: true, timeout: 10_000, env: { ...process.env, OMB_SMOKE_DAEMON_PID: String(pid) } });
  console.log("Windows confirms the background daemon has no console");
}

const sdk = await import(pathToFileURL(bundle).href);
if (typeof sdk.EmbeddedCuaDriverHost !== "function") {
  console.error("staged bundle does not export EmbeddedCuaDriverHost");
  process.exit(1);
}

// No screen capture or input: initialize the retained CLI's MCP connection to
// the GUI-subsystem daemon and enumerate its tool definitions, then stop both.
async function checkProxy(socketPath) {
  const child = spawn(binary, ["mcp", "--embedded", "--socket", socketPath], {
    windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, CUA_DRIVER_EMBEDDED: "1", CUA_DRIVER_HOST_BUNDLE_ID: "com.openmausbot.app" },
  });
  const lines = createInterface({ input: child.stdout });
  let stderr = "";
  child.stderr.on("data", bytes => { stderr = (stderr + bytes).slice(-4096); });
  const pending = new Map();
  const rejectAll = error => { for (const item of pending.values()) item.reject(error); pending.clear(); };
  child.on("error", rejectAll);
  child.on("exit", () => rejectAll(new Error(`MCP proxy exited: ${stderr}`)));
  lines.on("line", line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    if (message.error) item.reject(new Error(JSON.stringify(message.error)));
    else item.resolve(message.result);
  });
  const send = message => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
  const request = (id, method, params) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP ${method} timed out`)); }, 5000);
    pending.set(id, {
      resolve: result => { clearTimeout(timer); resolve(result); },
      reject: error => { clearTimeout(timer); reject(error); },
    });
    send({ id, method, params });
  });
  try {
    const initialized = await request(1, "initialize", {
      protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "openmausbot-smoke", version: "1" },
    });
    if (!initialized?.serverInfo) throw new Error("MCP initialization missing serverInfo");
    send({ method: "notifications/initialized" });
    const list = await request(2, "tools/list", {});
    if (!Array.isArray(list?.tools) || !list.tools.length) throw new Error("MCP proxy returned no tools");
    console.log(`CLI proxy connected to background daemon: ${list.tools.length} tools`);
  } finally {
    lines.close();
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) child.kill();
    rejectAll(new Error("MCP smoke ended"));
  }
}

const host = new sdk.EmbeddedCuaDriverHost(background, "com.openmausbot.app");
try {
  const conn = await host.start({ signal: AbortSignal.timeout(15_000) });
  if (!conn?.socketPath) throw new Error("embedded host reported no socketPath");
  console.log("embedded host started:", {
    pid: conn.pid,
    driverVersion: conn.driverVersion,
    contractVersion: conn.contractVersion,
    socketPath: conn.socketPath,
  });
  if (!Number.isInteger(conn.pid) || conn.pid <= 0) throw new Error("missing daemon PID");
  await checkNoConsole(conn.pid);
  await checkProxy(conn.socketPath);
  await host.stop();
  host.uniffiDestroy?.();
  if (!Number.isInteger(conn.pid) || conn.pid <= 0) throw new Error("missing daemon PID");
  const running = () => {
    try { process.kill(conn.pid, 0); return true; }
    catch (error) { if (error.code === "ESRCH") return false; throw error; }
  };
  for (let attempt = 0; attempt < 50 && running(); attempt++) await delay(100);
  if (running()) throw new Error("owned daemon survived host.stop()");
  clearTimeout(watchdog);
  console.log("smoke:cua-win OK — staged bundle drives a real embedded host");
} catch (err) {
  try {
    await host.stop();
  } catch {
    // startup already failed; stop is best-effort before destroy
  }
  host.uniffiDestroy?.();
  console.error("smoke:cua-win FAILED:", err);
  process.exit(1);
}
