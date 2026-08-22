import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const wayland = process.env.OMB_SMOKE_WAYLAND === "1";
const hardDeath = process.env.OMB_SMOKE_HARD_DEATH === "1";
const bundled = process.env.OMB_SMOKE_BUNDLED_CUA === "1";
if (hardDeath && bundled) throw new Error("hard-death and bundled smoke modes are mutually exclusive");
const executable = path.resolve(
  process.env.OMB_SMOKE_EXECUTABLE ?? path.join(root, "release", "linux-unpacked", "openmausbot"),
);
if (!existsSync(executable)) throw new Error(`[smoke-linux-package] missing executable: ${executable}`);

const sandbox = mkdtempSync(path.join(tmpdir(), "omb-linux-smoke-"));
const home = path.join(sandbox, "home");
const xdgConfig = path.join(sandbox, "config");
const xdgRuntime = path.join(sandbox, "runtime");
const marker = path.join(sandbox, "cua-invocations.ndjson");
const fakeState = path.join(sandbox, "cua-serve-count");
const sentinel = path.join(sandbox, "cua-driver");
mkdirSync(path.join(home, ".openmausbot"), { recursive: true });
mkdirSync(xdgConfig, { recursive: true });
mkdirSync(xdgRuntime, { recursive: true, mode: 0o700 });
chmodSync(xdgRuntime, 0o700);
writeFileSync(
  path.join(home, ".openmausbot", "config.json"),
  JSON.stringify({ instances: { ghost: { driver: "not-a-real-driver", displayName: "Ghost" } } }),
);
for (const appName of ["openmausbot", "OpenMausBot"]) {
  const userData = path.join(xdgConfig, appName);
  mkdirSync(userData, { recursive: true, mode: 0o700 });
  chmodSync(userData, 0o700);
  writeFileSync(
    path.join(userData, "cua-local-control.json"),
    JSON.stringify({ schemaVersion: 1, linuxLocalControlEnabled: true }),
    { mode: 0o600 },
  );
}
writeFileSync(
  sentinel,
  `#!${process.execPath}
const { appendFileSync, chmodSync, existsSync, readFileSync, realpathSync, unlinkSync, writeFileSync } = require("node:fs");
const net = require("node:net");
const marker = ${JSON.stringify(marker)};
const state = ${JSON.stringify(fakeState)};
const wayland = ${JSON.stringify(wayland)};
const args = process.argv.slice(2);
appendFileSync(marker, JSON.stringify({
  pid: process.pid,
  args,
  telemetryEnabled: process.env.CUA_DRIVER_RS_TELEMETRY_ENABLED,
  updateCheck: process.env.CUA_DRIVER_RS_UPDATE_CHECK,
  waylandEnabled: process.env.CUA_DRIVER_RS_ENABLE_WAYLAND === "1",
}) + "\\n");
const after = (flag) => { const index = args.indexOf(flag); return index === -1 ? null : args[index + 1]; };
if (args.includes("--version")) {
  process.stdout.write("cua-driver 0.19.3\\n");
  process.exit(0);
}
if (args[0] === "manifest") {
  const binary = realpathSync(process.argv[1]);
  process.stdout.write(JSON.stringify({
    schema_version: "1",
    binary_version: "0.19.3",
    binary_path: binary,
    mcp_invocation: { command: binary, args: ["mcp"] },
  }) + "\\n");
  process.exit(0);
}
if (args[0] === "doctor" && args.includes("--json")) {
  process.stdout.write(JSON.stringify({ ok: true, probes: [
    { label: "binary", status: "ok", message: "cua-driver 0.19.3" },
    { label: "display server", status: "ok", message: wayland
      ? "Wayland+XWayland (WAYLAND_DISPLAY=wayland-smoke, DISPLAY=:99)"
      : "X11 (DISPLAY=:99)" },
    { label: "X11 connection", status: "warn", message: "no top-level windows in Xvfb" },
    { label: "AT-SPI", status: "ok", message: "fixture bus available" },
  ] }) + "\\n");
  process.exit(0);
}
if (args[0] !== "serve") process.exit(64);
const socketPath = after("--socket");
const pidFile = after("--pid-file");
if (!socketPath || !pidFile || !args.includes("--embedded") || after("--permission-mode") !== "standard") {
  process.exit(64);
}
if ((process.env.CUA_DRIVER_RS_ENABLE_WAYLAND === "1") !== wayland) process.exit(64);
const count = existsSync(state) ? Number(readFileSync(state, "utf8")) + 1 : 1;
writeFileSync(state, String(count));
writeFileSync(pidFile, String(process.pid), { mode: 0o600 });
const metadata = {
  driver_version: "0.19.3",
  contract_version: "0.6.0",
  tools_list_schema_version: "1",
  capability_version: "1",
  mcp_protocol_version: "2025-06-18",
  pid: process.pid,
  embedded: true,
  host_bundle_id: "com.openmausbot.app",
};
const tools = ["click", "get_window_state", "list_apps", "type_text"].map((name) => ({ name }));
const toolManifest = { schema_version: "1", capability_version: "1", tools };
const healthReport = {
  schema_version: "1",
  platform: "linux",
  driver_version: "0.19.3",
  overall: "ok",
  checks: [
    { name: "binary_version", status: "pass", message: "cua-driver 0.19.3" },
    { name: "platform_supported", status: "pass", message: "Ubuntu 24.04" },
    { name: "session_active", status: "pass", message: "MCP session is active." },
    { name: "ax_capability", status: "pass", message: "AT-SPI fixture is reachable." },
    { name: "screen_capture_capability", status: "pass", message: "Portal fixture is reachable." },
    { name: "wayland_backend", status: "pass", message: "WinRects and portal/libei fixtures are reachable." },
  ],
};
const server = net.createServer((socket) => {
  let input = "";
  socket.on("data", (chunk) => {
    input += chunk;
    const newline = input.indexOf("\\n");
    if (newline === -1) return;
    const request = JSON.parse(input.slice(0, newline));
    const result = request.method === "metadata"
      ? metadata
      : request.method === "list"
        ? toolManifest
        : request.method === "call" && request.name === "health_report" && wayland
          ? { structuredContent: healthReport }
          : null;
    socket.end(JSON.stringify(result ? { ok: true, result } : { ok: false, error: "unknown" }) + "\\n");
    if (count === 1 && request.method === "list") setTimeout(() => server.close(() => process.exit(17)), 5000);
  });
});
server.listen(socketPath, () => chmodSync(socketPath, 0o600));
const shutdown = () => server.close(() => {
  for (const file of [socketPath, pidFile]) { try { unlinkSync(file); } catch {} }
  process.exit(0);
});
process.stdin.on("end", shutdown);
process.on("SIGTERM", shutdown);
`,
);
chmodSync(sentinel, 0o755);

const desktopEnv = {
  ...process.env,
  HOME: home,
  XDG_CONFIG_HOME: xdgConfig,
  XDG_RUNTIME_DIR: xdgRuntime,
  XDG_SESSION_TYPE: wayland ? "wayland" : "x11",
  XDG_CURRENT_DESKTOP: "GNOME",
  CUA_DRIVER_PATH: sentinel,
  OMB_SMOKE_TEST: "1",
  OMB_SMOKE_CUA: hardDeath || bundled ? "0" : "1",
  OMB_SMOKE_BUNDLED_CUA: bundled ? "1" : "0",
  ...(hardDeath ? { OMB_SMOKE_KEEP_OPEN: "1" } : {}),
};
if (bundled) delete desktopEnv.CUA_DRIVER_PATH;
if (wayland) desktopEnv.WAYLAND_DISPLAY = "wayland-smoke";
else delete desktopEnv.WAYLAND_DISPLAY;

let output = "";
let smokeResult = null;
// The smoke runs with a disposable HOME and no interactive keyring. Keep
// Electron's credential backend inside that sandbox so a GNOME Keyring unlock
// prompt cannot block the headless renderer before did-finish-load.
const electronArgs = ["--password-store=basic"];
if (wayland) electronArgs.push("--ozone-platform=x11");
const child = spawn(executable, electronArgs, {
  cwd: root,
  detached: true,
  env: desktopEnv,
  stdio: ["ignore", "pipe", "pipe"],
});

for (const stream of [child.stdout, child.stderr]) {
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    output += chunk;
    const match = output.match(/\[smoke\] renderer-ready (\{.*\})\r?\n/);
    if (match && !smokeResult) smokeResult = JSON.parse(match[1]);
  });
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const processRunning = (processHandle) =>
  processHandle.exitCode === null && processHandle.signalCode === null;
const childRunning = () => processRunning(child);
async function until(probe, description) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const value = await probe().catch(() => null);
    if (value) return value;
    if (!childRunning()) {
      throw new Error(
        `Electron exited ${child.exitCode ?? child.signalCode} while waiting for ${description}.\n${output}`,
      );
    }
    await delay(100);
  }
  throw new Error(`timed out waiting for ${description}.\n${output}`);
}

async function waitForExit() {
  const deadline = Date.now() + 10_000;
  while (childRunning() && Date.now() < deadline) await delay(50);
  if (childRunning()) throw new Error(`Electron did not exit after its window closed.\n${output}`);
}

async function stopDetached(processHandle) {
  if (!processRunning(processHandle)) return;
  try {
    process.kill(-processHandle.pid, "SIGTERM");
  } catch {}
  const stopDeadline = Date.now() + 5_000;
  while (processRunning(processHandle) && Date.now() < stopDeadline) await delay(50);
  if (processRunning(processHandle)) {
    try {
      process.kill(-processHandle.pid, "SIGKILL");
    } catch {}
  }
}

async function stopProcess() {
  await stopDetached(child);
}

try {
  const result = await until(async () => smokeResult, "the packaged renderer smoke result");
  const {
    capabilities,
    cuaRuntime,
    cuaCrashReason,
    cuaRetryStatus,
    displayMediaRequests,
    health,
    initialCapabilities,
    location,
    title,
  } = result;
  if (health?.app !== "openmausbot" || health.static !== true) {
    throw new Error(`unexpected embedded health response: ${JSON.stringify(health)}`);
  }
  if (!String(title).includes("OpenMausBot")) throw new Error(`unexpected renderer title: ${title}`);
  if (capabilities.host.platform !== "linux") throw new Error("renderer did not report Linux");
  if (capabilities.host.session !== (wayland ? "wayland" : "x11")) {
    throw new Error(`renderer did not report the ${wayland ? "Wayland" : "X11"} contract`);
  }
  const expectedPreview = wayland ? "portal-picker" : "direct";
  if (!capabilities.screenPreview.available || capabilities.screenPreview.interaction !== expectedPreview) {
    throw new Error(`${wayland ? "Wayland" : "X11"} screen preview capability was not available`);
  }
  if (capabilities.dictation.available) throw new Error("dictation must be unavailable on Linux");
  if (!initialCapabilities.localComputer.available) throw new Error("initial Linux CUA runtime was not ready");
  if (initialCapabilities.localComputer.support !== "limited") throw new Error("Linux CUA was not marked beta/limited");
  if (wayland && (
    initialCapabilities.localComputer.session !== "wayland" ||
    initialCapabilities.localComputer.compositor !== "gnome-mutter"
  )) {
    throw new Error("initial Linux CUA runtime did not publish the guarded GNOME Wayland contract");
  }
  if (!bundled && !hardDeath) {
    if (cuaCrashReason !== "daemon-exited") {
      throw new Error("daemon crash did not invalidate local control");
    }
    if (cuaRetryStatus?.status !== "ready" || !capabilities.localComputer.available) {
      throw new Error("explicit CUA retry did not create a ready generation");
    }
  }
  if (displayMediaRequests !== 0) throw new Error("launch triggered display capture without user intent");
  if (bundled) {
    await waitForExit();
    const staleHealth = await fetch(new URL("/api/health", location)).catch(() => null);
    if (staleHealth?.ok) throw new Error("embedded harness remained reachable after Electron quit");
    const appImage = executable.endsWith(".AppImage");
    if (cuaCrashReason !== null || cuaRetryStatus !== null) {
      throw new Error("bundled smoke unexpectedly entered the fake crash/retry lane");
    }
    if (
      cuaRuntime?.driverSource !== "bundled" ||
      cuaRuntime.driverVersion !== "0.19.3" ||
      (appImage
        ? cuaRuntime.appImagePrivateStage !== true || cuaRuntime.exactBundledPath !== false
        : cuaRuntime.exactBundledPath !== true ||
          !String(cuaRuntime.driverPath).endsWith("/resources/cua-linux-x64/cua-driver"))
    ) {
      throw new Error(`packaged Electron did not select its bundled driver: ${JSON.stringify(cuaRuntime)}`);
    }
    if (
      cuaRuntime.mcpEnv?.CUA_DRIVER_RS_UPDATE_CHECK !== "false" ||
      cuaRuntime.mcpEnv?.CUA_DRIVER_RS_TELEMETRY_ENABLED !== "false"
    ) {
      throw new Error("packaged MCP descriptor did not disable update checks and telemetry");
    }
    if (existsSync(cuaRuntime.socketPath) || existsSync(cuaRuntime.pidFile)) {
      throw new Error("packaged CUA runtime files remained after Electron quit");
    }
    if (appImage && existsSync(path.dirname(cuaRuntime.driverPath))) {
      throw new Error("AppImage private CUA stage remained after Electron quit");
    }
    if (existsSync(marker)) {
      throw new Error(`packaged app invoked the ambient driver:\n${readFileSync(marker, "utf8")}`);
    }
    try {
      process.kill(cuaRuntime.daemonPid, 0);
      throw new Error(`packaged CUA daemon remained alive after quit: ${cuaRuntime.daemonPid}`);
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
    console.log(
      `[smoke-linux-package] OK (bundled ${path.basename(executable)}): packaged resolver, descriptor, harness, and cleanup`,
    );
  } else {
    const invocations = readFileSync(marker, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const commands = invocations.map((entry) => entry.args.join(" "));
  for (const expected of ["--version", "manifest", "doctor --json"]) {
    if (!commands.some((command) => command === expected)) throw new Error(`missing CUA probe: ${expected}`);
  }
  if (invocations.some((entry) => entry.waylandEnabled !== wayland)) {
    throw new Error("CUA Wayland opt-in escaped its certified smoke lane");
  }
  if (
    invocations.some(
      (entry) => entry.updateCheck !== "false" || entry.telemetryEnabled !== "false",
    )
  ) {
    throw new Error("a CUA child escaped the local-only update/telemetry environment");
  }
  const daemons = invocations.filter((entry) => entry.args[0] === "serve");
  const expectedDaemonCount = hardDeath ? 1 : 2;
  if (daemons.length !== expectedDaemonCount) {
    throw new Error(`expected ${expectedDaemonCount} daemon generation(s), found ${daemons.length}`);
  }

  if (hardDeath) {
    child.kill("SIGKILL");
    await waitForExit();
    const cleanupDeadline = Date.now() + 10_000;
    while (Date.now() < cleanupDeadline) {
      const stillAlive = daemons.some((daemon) => {
        try {
          process.kill(daemon.pid, 0);
          return true;
        } catch (error) {
          return error?.code !== "ESRCH";
        }
      });
      const runtimeFilesRemain = daemons.some((daemon) => {
        const socketIndex = daemon.args.indexOf("--socket");
        const pidFileIndex = daemon.args.indexOf("--pid-file");
        return (
          (socketIndex !== -1 && existsSync(daemon.args[socketIndex + 1])) ||
          (pidFileIndex !== -1 && existsSync(daemon.args[pidFileIndex + 1]))
        );
      });
      if (!stillAlive && !runtimeFilesRemain) break;
      await delay(50);
    }
    for (const daemon of daemons) {
      try {
        process.kill(daemon.pid, 0);
        throw new Error(`owned CUA daemon survived hard Electron death: ${daemon.pid}`);
      } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
    }
    const serverDeadline = Date.now() + 10_000;
    let staleHealth = null;
    while (Date.now() < serverDeadline) {
      staleHealth = await fetch(new URL("/api/health", location)).catch(() => null);
      if (!staleHealth?.ok) break;
      await delay(50);
    }
    if (staleHealth?.ok) throw new Error("embedded harness survived hard Electron death");
    const userData = ["openmausbot", "OpenMausBot"]
      .map((name) => path.join(xdgConfig, name))
      .find((directory) => existsSync(path.join(directory, "cua-connection.json")));
    if (!userData) throw new Error("hard-death smoke could not locate the CUA descriptor");
    const { readCuaConnection } = await import(
      new URL("../dist-server/local-computer.js", import.meta.url)
    );
    if (readCuaConnection({ platform: "linux", userData }) !== null) {
      throw new Error("stale hard-death CUA descriptor remained usable");
    }

    let restartOutput = "";
    let restartResult = null;
    const restart = spawn(executable, wayland ? ["--ozone-platform=x11"] : [], {
      cwd: root,
      detached: true,
      env: { ...desktopEnv, OMB_SMOKE_KEEP_OPEN: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      for (const stream of [restart.stdout, restart.stderr]) {
        stream.setEncoding("utf8");
        stream.on("data", (chunk) => {
          restartOutput += chunk;
          const match = restartOutput.match(/\[smoke\] renderer-ready (\{.*\})\r?\n/);
          if (match && !restartResult) restartResult = JSON.parse(match[1]);
        });
      }
      const restartDeadline = Date.now() + 30_000;
      while (!restartResult && Date.now() < restartDeadline) {
        if (restart.exitCode !== null || restart.signalCode !== null) {
          throw new Error(`Electron restart exited before renderer readiness.\n${restartOutput}`);
        }
        await delay(100);
      }
      if (!restartResult?.initialCapabilities?.localComputer?.available) {
        throw new Error(`Electron restart did not create a ready CUA generation.\n${restartOutput}`);
      }
      const restartExitDeadline = Date.now() + 10_000;
      while (
        restart.exitCode === null &&
        restart.signalCode === null &&
        Date.now() < restartExitDeadline
      ) {
        await delay(50);
      }
      if (restart.exitCode === null && restart.signalCode === null) {
        throw new Error(`Electron restart did not close normally.\n${restartOutput}`);
      }
      if (restart.exitCode !== 0) {
        throw new Error(
          `Electron restart exited with ${restart.exitCode ?? restart.signalCode}.\n${restartOutput}`,
        );
      }

      const allDaemons = readFileSync(marker, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .filter((entry) => entry.args[0] === "serve");
      const restartedDaemons = allDaemons;
      if (restartedDaemons.length !== 2) {
        throw new Error(
          `hard-death restart expected two cumulative generations (pre-kill and restart), found ${restartedDaemons.length}`,
        );
      }
      const socketPaths = new Set(
        restartedDaemons.map((daemon) => daemon.args[daemon.args.indexOf("--socket") + 1]),
      );
      if (socketPaths.size !== 2) throw new Error("hard-death restart reused a stale CUA generation");
      for (const daemon of restartedDaemons) {
        try {
          process.kill(daemon.pid, 0);
          throw new Error(`CUA daemon survived restart shutdown: ${daemon.pid}`);
        } catch (error) {
          if (error?.code !== "ESRCH") throw error;
        }
        for (const flag of ["--socket", "--pid-file"]) {
          const index = daemon.args.indexOf(flag);
          if (index !== -1 && existsSync(daemon.args[index + 1])) {
            throw new Error(`stale CUA runtime file survived restart: ${daemon.args[index + 1]}`);
          }
        }
      }
      if (readCuaConnection({ platform: "linux", userData }) !== null) {
        throw new Error("CUA descriptor remained usable after restart shutdown");
      }
    } finally {
      await stopDetached(restart);
    }
    console.log(`[smoke-linux-package] OK (${wayland ? "GNOME/Wayland" : "GNOME/X11"} hard death): restart replaced the generation and left no daemon, runtime file, server, or usable descriptor`);
  } else {
    await waitForExit();
    const staleHealth = await fetch(new URL("/api/health", location)).catch(() => null);
    if (staleHealth?.ok) throw new Error("embedded harness remained reachable after Electron quit");
  }

    for (const daemon of daemons) {
      try {
        process.kill(daemon.pid, 0);
        throw new Error(`owned CUA daemon remained alive after quit: ${daemon.pid}`);
      } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
    }
    if (!hardDeath) {
      console.log(`[smoke-linux-package] OK (${wayland ? "GNOME/Wayland" : "GNOME/X11"}): renderer, private CUA crash/retry, harness, and shutdown`);
    }
  }
} finally {
  await stopProcess();
  if (process.env.OMB_KEEP_SMOKE_DIR !== "1") rmSync(sandbox, { recursive: true, force: true });
  else console.log(`[smoke-linux-package] kept ${sandbox}`);
}
