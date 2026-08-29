const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const net = require("node:net");

const HOST_BUNDLE_ID = "com.openmausbot.app";
const DRIVER_VERSION = "0.22.1";
const CONTRACT_VERSION = "0.7.0";
const TOOLS_LIST_SCHEMA_VERSION = "1";
const CAPABILITY_VERSION = "1";
const MCP_PROTOCOL_VERSION = "2025-06-18";
const SAFE_ENVIRONMENT_NAMES = new Set([
  "APPDATA",
  "COMSPEC",
  "HOME",
  "LANG",
  "LOCALAPPDATA",
  "LOGNAME",
  "PATH",
  "PATHEXT",
  "PROGRAMDATA",
  "SHELL",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USER",
  "USERPROFILE",
  "WINDIR",
]);

function safeWindowsEnvironment(environment) {
  const safe = {};
  for (const [name, value] of Object.entries(environment)) {
    if (SAFE_ENVIRONMENT_NAMES.has(name.toUpperCase()) && value !== undefined) {
      safe[name] = value;
    }
  }
  safe.CUA_DRIVER_RS_TELEMETRY_ENABLED = "0";
  safe.CUA_DRIVER_RS_UPDATE_CHECK = "false";
  return safe;
}

function requestPipe(socketPath, request, timeoutMs = 1_000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    let data = Buffer.alloc(0);
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      callback(value);
    };
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => {
      data = Buffer.concat([data, chunk]);
      const newline = data.indexOf(0x0a);
      if (newline === -1) return;
      try {
        finish(resolve, JSON.parse(data.subarray(0, newline).toString("utf8")));
      } catch {
        finish(reject, new Error("Cua Driver returned invalid startup metadata."));
      }
    });
    socket.once("error", (error) => finish(reject, error));
    const timer = setTimeout(
      () => finish(reject, new Error("Cua Driver startup metadata timed out.")),
      timeoutMs,
    );
    timer.unref?.();
  });
}

function validateMetadata(response, childPid) {
  const metadata = response?.ok === true ? response.result : null;
  const expected = {
    driver_version: DRIVER_VERSION,
    contract_version: CONTRACT_VERSION,
    tools_list_schema_version: TOOLS_LIST_SCHEMA_VERSION,
    capability_version: CAPABILITY_VERSION,
    mcp_protocol_version: MCP_PROTOCOL_VERSION,
    pid: childPid,
    embedded: true,
    host_bundle_id: HOST_BUNDLE_ID,
  };
  if (!metadata || Array.isArray(metadata)) {
    throw new Error("Cua Driver daemon identity could not be verified.");
  }
  for (const [name, value] of Object.entries(expected)) {
    if (metadata[name] !== value) {
      throw new Error(`Cua Driver daemon reported an incompatible ${name}.`);
    }
  }
  return metadata;
}

async function probeWindowsCuaDaemon(socketPath, { childPid, timeoutMs = 10_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return validateMetadata(await requestPipe(socketPath, { method: "metadata" }), childPid);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 75));
    }
  }
  throw new Error(lastError?.message ?? "Cua Driver daemon did not become ready.");
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    child.once("exit", () => finish(true));
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
  });
}

async function stopChild(child) {
  if (!child) return;
  try {
    child.stdin?.end();
  } catch {}
  if (await waitForExit(child, 2_000)) return;
  try {
    child.kill("SIGTERM");
  } catch {}
  if (await waitForExit(child, 1_000)) return;
  try {
    child.kill("SIGKILL");
  } catch {}
  await waitForExit(child, 500);
}

function createWindowsCuaRuntime({
  spawnProcess = spawn,
  probe = probeWindowsCuaDaemon,
  identifier = randomUUID,
  processId = process.pid,
  env = process.env,
} = {}) {
  let child = null;

  return Object.freeze({
    async start(binary) {
      if (child) throw new Error("Cua Driver is already running.");
      const generation = identifier();
      const socketPath = `\\\\.\\pipe\\cua-${processId}-${generation.replaceAll("-", "").slice(0, 12)}`;
      const args = [
        "serve",
        "--embedded",
        "--parent-liveness-stdio",
        "--no-permissions-gate",
        "--socket",
        socketPath,
        "--host-bundle-id",
        HOST_BUNDLE_ID,
        "--permission-mode",
        "standard",
        // OpenMausBot is the trusted embedding host. Pre-authorize only the
        // existing Chromium-profile attachment capability so a task-scoped
        // MCP session can use the user's already signed-in browser. All
        // clicks, typing, navigation, and other computer actions keep the
        // standard per-action approval semantics.
        "--grant",
        "existing-profile",
      ];
      const owned = spawnProcess(binary, args, {
        env: safeWindowsEnvironment(env),
        shell: false,
        stdio: ["pipe", "ignore", "ignore"],
        windowsHide: true,
      });
      child = owned;
      try {
        await probe(socketPath, { childPid: owned.pid, timeoutMs: 10_000 });
      } catch (error) {
        await stopChild(owned);
        if (child === owned) child = null;
        throw error;
      }
      return {
        mode: "embedded",
        socketPath,
        generation,
        mcpCommand: binary,
        mcpArgs: [
          "mcp",
          "--embedded",
          "--socket",
          socketPath,
          "--host-bundle-id",
          HOST_BUNDLE_ID,
        ],
        mcpEnv: { CUA_DRIVER_RS_TELEMETRY_ENABLED: "0" },
      };
    },

    async stop() {
      const owned = child;
      child = null;
      await stopChild(owned);
    },
  });
}

module.exports = {
  createWindowsCuaRuntime,
  probeWindowsCuaDaemon,
  safeWindowsEnvironment,
  validateMetadata,
};
