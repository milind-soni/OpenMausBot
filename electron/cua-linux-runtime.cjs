const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const {
  CERTIFIED_DRIVER_VERSION,
  CERTIFIED_MANIFEST_SCHEMA,
  desktopCommandEnvironment,
  inspectLinuxCuaDriver,
  sameDriverFileIdentity,
  validateDriverCandidate,
} = require("./cua-linux.cjs");

const CONNECTION_SCHEMA_VERSION = 1;
const SETTINGS_SCHEMA_VERSION = 1;
const HOST_BUNDLE_ID = "com.openmausbot.app";
const CERTIFIED_CONTRACT_VERSION = "0.6.0";
const CERTIFIED_TOOLS_LIST_SCHEMA_VERSION = "1";
const CERTIFIED_CAPABILITY_VERSION = "1";
const CERTIFIED_MCP_PROTOCOL_VERSION = "2025-06-18";
const REQUIRED_TOOLS = ["click", "get_window_state", "list_apps", "type_text"];
const REQUIRED_WAYLAND_HEALTH_CHECKS = [
  "ax_capability",
  "screen_capture_capability",
  "wayland_backend",
];

function ensurePrivateDirectory(directory, fileSystem = fs, currentUid = process.getuid?.() ?? os.userInfo().uid) {
  fileSystem.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fileSystem.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw Object.assign(new Error(`Private CUA path is not a directory: ${directory}`), {
      code: "unsafe-runtime-directory",
    });
  }
  if (stat.uid !== currentUid && stat.uid !== 0) {
    throw Object.assign(new Error(`Private CUA directory has an unexpected owner: ${directory}`), {
      code: "unsafe-runtime-directory",
    });
  }
  fileSystem.chmodSync(directory, 0o700);
  return directory;
}

function cleanupStaleRuntimeDirectories(root, {
  fileSystem = fs,
  currentUid = process.getuid?.() ?? os.userInfo().uid,
  isProcessAlive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error?.code !== "ESRCH";
    }
  },
} = {}) {
  let entries;
  try {
    entries = fileSystem.readdirSync(root, { withFileTypes: true });
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    const match = /^([1-9][0-9]*)-([0-9a-f]{8}-[0-9a-f]{3})$/.exec(entry.name);
    if (!match || !entry.isDirectory() || entry.isSymbolicLink()) continue;
    const ownerPid = Number(match[1]);
    if (!Number.isSafeInteger(ownerPid) || isProcessAlive(ownerPid)) continue;
    const directory = path.join(root, entry.name);
    try {
      const directoryStat = fileSystem.lstatSync(directory);
      if (
        !directoryStat.isDirectory() ||
        directoryStat.isSymbolicLink() ||
        directoryStat.uid !== currentUid ||
        (directoryStat.mode & 0o077) !== 0
      ) {
        continue;
      }
      const children = fileSystem.readdirSync(directory, { withFileTypes: true });
      if (children.some((child) => !["driver.pid", "driver.sock"].includes(child.name))) continue;
      const removable = [];
      let safe = true;
      for (const child of children) {
        const childPath = path.join(directory, child.name);
        const childStat = fileSystem.lstatSync(childPath);
        const expectedType =
          child.name === "driver.pid" ? childStat.isFile() : childStat.isSocket();
        if (childStat.isSymbolicLink() || childStat.uid !== currentUid || !expectedType) {
          safe = false;
          break;
        }
        removable.push(childPath);
      }
      if (!safe) continue;
      for (const childPath of removable) fileSystem.unlinkSync(childPath);
      fileSystem.rmdirSync(directory);
      removed += 1;
    } catch {
      // Runtime cleanup is best-effort and strictly scoped. A suspicious or
      // concurrently changing entry is left untouched for manual inspection.
    }
  }
  return removed;
}

function writePrivateJson(file, value, {
  fileSystem = fs,
  temporaryId = randomUUID,
  processId = process.pid,
} = {}) {
  const directory = ensurePrivateDirectory(path.dirname(file), fileSystem);
  const temporary = path.join(directory, `.${path.basename(file)}.${processId}.${temporaryId()}.tmp`);
  let descriptor;
  try {
    descriptor = fileSystem.openSync(temporary, "wx", 0o600);
    fileSystem.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fileSystem.fsyncSync(descriptor);
    fileSystem.closeSync(descriptor);
    descriptor = undefined;
    fileSystem.renameSync(temporary, file);
    fileSystem.chmodSync(file, 0o600);
    const directoryHandle = fileSystem.openSync(directory, "r");
    try {
      try {
        fileSystem.fsyncSync(directoryHandle);
      } catch {
        // The file itself is already flushed and atomically renamed. Some
        // otherwise-supported filesystems reject fsync on a directory.
      }
    } finally {
      fileSystem.closeSync(directoryHandle);
    }
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        fileSystem.closeSync(descriptor);
      } catch {}
    }
    try {
      fileSystem.unlinkSync(temporary);
    } catch {}
    throw error;
  }
}

function createLinuxCuaPreferenceStore({ getUserData, fileSystem = fs } = {}) {
  const preferencePath = () => path.join(getUserData(), "cua-local-control.json");
  return Object.freeze({
    read() {
      try {
        const stat = fileSystem.lstatSync(preferencePath());
        if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) return false;
        const value = JSON.parse(fileSystem.readFileSync(preferencePath(), "utf8"));
        return (
          value?.schemaVersion === SETTINGS_SCHEMA_VERSION &&
          value?.linuxLocalControlEnabled === true &&
          Object.keys(value).every((key) =>
            ["schemaVersion", "linuxLocalControlEnabled"].includes(key),
          )
        );
      } catch {
        return false;
      }
    },
    write(enabled) {
      writePrivateJson(
        preferencePath(),
        { schemaVersion: SETTINGS_SCHEMA_VERSION, linuxLocalControlEnabled: Boolean(enabled) },
        { fileSystem },
      );
    },
  });
}

function requestSocket(socketPath, request, { timeoutMs = 1_000, maxBytes = 256 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    let data = Buffer.alloc(0);
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      fn(value);
    };
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => {
      if (data.length + chunk.length > maxBytes) {
        finish(reject, Object.assign(new Error("Cua Driver handshake was too large."), { code: "handshake-too-large" }));
        return;
      }
      data = Buffer.concat([data, chunk]);
      const newline = data.indexOf(0x0a);
      if (newline === -1) return;
      try {
        finish(resolve, JSON.parse(data.subarray(0, newline).toString("utf8")));
      } catch {
        finish(reject, Object.assign(new Error("Cua Driver returned an invalid handshake."), { code: "invalid-handshake" }));
      }
    });
    socket.once("error", (error) => finish(reject, error));
    const timer = setTimeout(
      () => finish(reject, Object.assign(new Error("Cua Driver handshake timed out."), { code: "handshake-timeout" })),
      timeoutMs,
    );
    timer.unref?.();
  });
}

function validateDaemonMetadata(response, { childPid } = {}) {
  const metadata = response?.ok === true ? response.result : null;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw Object.assign(new Error("Cua Driver daemon identity could not be verified."), {
      code: "invalid-daemon-metadata",
    });
  }
  const expected = {
    driver_version: CERTIFIED_DRIVER_VERSION,
    contract_version: CERTIFIED_CONTRACT_VERSION,
    tools_list_schema_version: CERTIFIED_TOOLS_LIST_SCHEMA_VERSION,
    capability_version: CERTIFIED_CAPABILITY_VERSION,
    mcp_protocol_version: CERTIFIED_MCP_PROTOCOL_VERSION,
    embedded: true,
    host_bundle_id: HOST_BUNDLE_ID,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (metadata[key] !== value) {
      throw Object.assign(new Error(`Cua Driver daemon reported an incompatible ${key}.`), {
        code: "incompatible-daemon",
      });
    }
  }
  if (!Number.isInteger(metadata.pid) || metadata.pid <= 0 || (childPid && metadata.pid !== childPid)) {
    throw Object.assign(new Error("Cua Driver daemon PID does not match the owned process."), {
      code: "invalid-daemon-metadata",
    });
  }
  return metadata;
}

function validateToolSurface(response) {
  const manifest = response?.ok === true ? response.result : null;
  if (
    !manifest ||
    typeof manifest !== "object" ||
    Array.isArray(manifest) ||
    manifest.schema_version !== CERTIFIED_TOOLS_LIST_SCHEMA_VERSION ||
    manifest.capability_version !== CERTIFIED_CAPABILITY_VERSION ||
    !Array.isArray(manifest.tools)
  ) {
    throw Object.assign(new Error("Cua Driver tool surface could not be verified."), {
      code: "invalid-tool-surface",
    });
  }
  const tools = manifest.tools;
  const names = new Set(tools.map((tool) => tool?.name).filter((name) => typeof name === "string"));
  const missing = REQUIRED_TOOLS.filter((name) => !names.has(name));
  if (missing.length) {
    throw Object.assign(new Error(`Cua Driver is missing required tools: ${missing.join(", ")}.`), {
      code: "incompatible-tool-surface",
    });
  }
  return [...names].sort();
}

function healthFailure(check) {
  const detail = `${check?.message ?? ""} ${check?.hint ?? ""}`.toLowerCase();
  if (check?.name === "ax_capability") {
    return Object.assign(
      new Error("Cua Driver could not reach the AT-SPI accessibility bus in this Wayland session."),
      { code: "at-spi-unavailable" },
    );
  }
  if (check?.name === "screen_capture_capability") {
    return Object.assign(
      new Error("Cua Driver could not reach a supported screen capture backend in this Wayland session."),
      { code: "wayland-capture-unavailable" },
    );
  }
  if (detail.includes("winrects") || detail.includes("target-activation")) {
    return Object.assign(
      new Error("The Cua WinRects helper is not active. Install it, then sign out and back in once."),
      { code: "wayland-helper-required" },
    );
  }
  if (detail.includes("portal")) {
    return Object.assign(
      new Error("The GNOME Remote Desktop portal is not available for local control."),
      { code: "wayland-portal-unavailable" },
    );
  }
  return Object.assign(
    new Error("Cua Driver could not verify the GNOME Wayland control backend."),
    { code: "wayland-health-failed" },
  );
}

function validateWaylandHealthReport(response) {
  const result = response?.ok === true ? response.result : null;
  const report = result?.structuredContent ?? result?.structured_content;
  if (
    !report ||
    typeof report !== "object" ||
    Array.isArray(report) ||
    report.schema_version !== "1" ||
    report.platform !== "linux" ||
    report.driver_version !== CERTIFIED_DRIVER_VERSION ||
    !["ok", "degraded", "failed"].includes(report.overall) ||
    !Array.isArray(report.checks)
  ) {
    throw Object.assign(new Error("Cua Driver returned an invalid Wayland health report."), {
      code: "invalid-health-report",
    });
  }
  const checks = new Map();
  for (const check of report.checks) {
    if (
      !check ||
      typeof check !== "object" ||
      Array.isArray(check) ||
      typeof check.name !== "string" ||
      !["pass", "fail", "skip"].includes(check.status) ||
      typeof check.message !== "string" ||
      (check.status === "fail" && typeof check.hint !== "string") ||
      checks.has(check.name)
    ) {
      throw Object.assign(new Error("Cua Driver returned an invalid Wayland health check."), {
        code: "invalid-health-report",
      });
    }
    checks.set(check.name, check);
  }
  for (const name of REQUIRED_WAYLAND_HEALTH_CHECKS) {
    const check = checks.get(name);
    if (check?.status !== "pass") throw healthFailure(check ?? { name });
  }
  if (report.overall !== "ok") {
    const failed = [...checks.values()].find((check) => check.status === "fail");
    throw healthFailure(failed);
  }
  return Object.freeze({
    schemaVersion: report.schema_version,
    overall: report.overall,
    requiredChecks: Object.freeze([...REQUIRED_WAYLAND_HEALTH_CHECKS]),
  });
}

async function probeWaylandHealth(socketPath, { request = requestSocket } = {}) {
  return validateWaylandHealthReport(
    await request(socketPath, { method: "call", name: "health_report", args: {} }),
  );
}

async function probePrivateDaemon(socketPath, {
  childPid,
  session = "x11",
  timeoutMs = 10_000,
  request = requestSocket,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const metadata = validateDaemonMetadata(
        await request(socketPath, { method: "metadata" }),
        { childPid },
      );
      const tools = validateToolSurface(await request(socketPath, { method: "list" }));
      const health =
        session === "wayland" ? await probeWaylandHealth(socketPath, { request }) : undefined;
      return { metadata, tools, ...(health ? { health } : {}) };
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 75));
    }
  }
  throw Object.assign(new Error(lastError?.message ?? "Cua Driver daemon did not become ready."), {
    code: lastError?.code ?? "daemon-start-timeout",
  });
}

function waitForChildExit(child, timeoutMs) {
  const exited =
    (child.exitCode !== null && child.exitCode !== undefined) ||
    (child.signalCode !== null && child.signalCode !== undefined);
  if (exited) return Promise.resolve(true);
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

async function stopOwnedChild(child) {
  if (!child) return;
  try {
    child.stdin?.end();
  } catch {}
  if (await waitForChildExit(child, 2_000)) return;
  try {
    child.kill("SIGTERM");
  } catch {}
  if (await waitForChildExit(child, 1_000)) return;
  try {
    child.kill("SIGKILL");
  } catch {}
  await waitForChildExit(child, 500);
}

function publicRuntimeStatus(connection) {
  return {
    enabled: connection.enabled === true,
    status:
      connection.status ??
      (["linux-x11-supervised", "linux-wayland-gnome-supervised"].includes(connection.mode)
        ? "ready"
        : "unavailable"),
    reasonCode: connection.reasonCode,
    message: connection.message ?? connection.reason,
    driverPath: connection.driver?.path,
    driverVersion: connection.driver?.version,
    driverSource: connection.driver?.source,
    session: connection.session,
    compositor: connection.compositor,
    warnings: connection.doctorWarnings ?? [],
  };
}

function createUnavailableLinuxRuntime({
  connectionStore,
  onChange = () => {},
  processId = process.pid,
  reasonCode = "bundled-driver-invalid",
  message = "The bundled Cua Driver failed integrity validation.",
} = {}) {
  const connection = {
    schemaVersion: CONNECTION_SCHEMA_VERSION,
    mode: "unavailable",
    platform: "linux",
    enabled: false,
    status: "unavailable",
    reasonCode,
    message,
    ownerPid: processId,
  };
  try {
    connectionStore?.persist(connection);
  } catch (error) {
    console.error("[cua] Failed to persist unavailable Linux runtime state:", error);
  }
  onChange(connection);

  return Object.freeze({
    async initialize() {
      return connection;
    },
    async enable() {
      return connection;
    },
    async retry() {
      return connection;
    },
    async disable() {
      return connection;
    },
    async shutdown() {
      return connection;
    },
    getConnection() {
      return connection;
    },
    getStatus() {
      return publicRuntimeStatus(connection);
    },
  });
}

function createLinuxCuaRuntime({
  getUserData,
  connectionStore,
  preferenceStore = createLinuxCuaPreferenceStore({ getUserData }),
  platform = process.platform,
  arch = process.arch,
  env = process.env,
  bundledDriverPath,
  inspect = inspectLinuxCuaDriver,
  spawnProcess = spawn,
  probe = probePrivateDaemon,
  healthProbe = probeWaylandHealth,
  healthCheckIntervalMs = 30_000,
  setRecurring = setInterval,
  clearRecurring = clearInterval,
  identifier = randomUUID,
  processId = process.pid,
  onChange = () => {},
} = {}) {
  let active = null;
  let startPromise = null;
  let enabled = false;
  let quitting = false;
  let connection = {
    schemaVersion: CONNECTION_SCHEMA_VERSION,
    mode: "unavailable",
    platform: "linux",
    session: String(env.XDG_SESSION_TYPE ?? "unknown").toLowerCase(),
    enabled: false,
    status: "disabled",
    reasonCode: "opt-in-required",
    message: "Local control is off until you enable the beta.",
    ownerPid: processId,
  };

  const publish = (next) => {
    connection = connectionStore.persist(next);
    onChange(connection);
    return connection;
  };

  const unavailable = (status, reasonCode, message, extra = {}) =>
    publish({
      schemaVersion: CONNECTION_SCHEMA_VERSION,
      mode: "unavailable",
      platform: "linux",
      session: String(env.XDG_SESSION_TYPE ?? "unknown").toLowerCase(),
      enabled,
      status,
      reasonCode,
      message,
      ownerPid: processId,
      ...extra,
    });

  const runtimeRoot = () => {
    const configured = env.XDG_RUNTIME_DIR;
    if (configured && path.isAbsolute(configured)) {
      try {
        const stat = fs.lstatSync(configured);
        const currentUid = process.getuid?.() ?? os.userInfo().uid;
        if (
          stat.isDirectory() &&
          !stat.isSymbolicLink() &&
          stat.uid === currentUid &&
          (stat.mode & 0o077) === 0
        ) {
          const root = ensurePrivateDirectory(path.join(configured, "openmausbot-cua"));
          cleanupStaleRuntimeDirectories(root);
          return root;
        }
      } catch {}
    }
    // Unix sockets have a short path limit. A private, uid-scoped directory
    // directly under the system temp root keeps the fallback deterministic
    // and short when XDG_RUNTIME_DIR is missing or unsafe.
    const currentUid = process.getuid?.() ?? os.userInfo().uid;
    const root = ensurePrivateDirectory(path.join(os.tmpdir(), `openmausbot-cua-${currentUid}`));
    cleanupStaleRuntimeDirectories(root);
    return root;
  };

  const cleanupRuntimeFiles = (owned) => {
    if (owned?.healthTimer) {
      clearRecurring(owned.healthTimer);
      owned.healthTimer = null;
    }
    if (!owned?.runtimeDirectory) return;
    for (const file of [owned.socketPath, owned.pidFile]) {
      try {
        fs.unlinkSync(file);
      } catch {
        // A failure for one owned path must not prevent cleanup of the other.
      }
    }
    try {
      fs.rmdirSync(owned.runtimeDirectory);
    } catch {}
  };

  const markUnexpectedExit = (owned, code, signal) => {
    if (active !== owned || owned.stopping || quitting) return;
    active = null;
    cleanupRuntimeFiles(owned);
    unavailable(
      "error",
      "daemon-exited",
      "Cua Driver stopped unexpectedly. Try again before using this computer.",
      { generation: owned.generation, exitCode: code, exitSignal: signal },
    );
  };

  const markWaylandHealthLost = (owned, error) => {
    if (active !== owned || owned.stopping || quitting) return;
    owned.stopping = true;
    active = null;
    if (owned.healthTimer) {
      clearRecurring(owned.healthTimer);
      owned.healthTimer = null;
    }
    unavailable(
      "error",
      error?.code ?? "wayland-health-lost",
      error?.message ?? "The GNOME Wayland control backend is no longer available.",
      { generation: owned.generation },
    );
    void stopOwnedChild(owned.child).finally(() => cleanupRuntimeFiles(owned));
  };

  const startWaylandHealthMonitor = (owned) => {
    if (!Number.isFinite(healthCheckIntervalMs) || healthCheckIntervalMs <= 0) return;
    owned.healthTimer = setRecurring(() => {
      if (active !== owned || owned.stopping || owned.healthChecking) return;
      owned.healthChecking = true;
      void healthProbe(owned.socketPath)
        .catch((error) => markWaylandHealthLost(owned, error))
        .finally(() => {
          owned.healthChecking = false;
        });
    }, healthCheckIntervalMs);
    owned.healthTimer.unref?.();
  };

  const start = async () => {
    if (platform !== "linux") return connection;
    if (!enabled) {
      return unavailable(
        "disabled",
        "opt-in-required",
        "Local control is off until you enable the beta.",
      );
    }
    if (active?.ready) return connection;
    if (startPromise) return startPromise;

    startPromise = (async () => {
      unavailable("checking", "checking-driver", "Checking Cua Driver and the desktop session…");
      let inspected;
      try {
        inspected = await inspect({ platform, arch, env, bundledDriverPath });
      } catch (error) {
        return unavailable(
          "error",
          error?.code ?? "driver-inspection-failed",
          "Cua Driver could not be inspected. Check the installation and try again.",
        );
      }
      if (inspected.status !== "ready") {
        return unavailable("error", inspected.reasonCode, inspected.message, {
          ...(inspected.path
            ? { driver: { path: inspected.path, version: inspected.driverVersion } }
            : {}),
          doctorProbes: inspected.probes ?? [],
        });
      }
      if (!enabled || quitting) return connection;
      const runtimeSession = inspected.session === "wayland" ? "wayland" : "x11";

      const generation = identifier();
      const root = runtimeRoot();
      const runtimeDirectory = path.join(root, `${processId}-${generation.slice(0, 12)}`);
      ensurePrivateDirectory(runtimeDirectory);
      const socketPath = path.join(runtimeDirectory, "driver.sock");
      const pidFile = path.join(runtimeDirectory, "driver.pid");
      if (Buffer.byteLength(socketPath) > 100) {
        cleanupRuntimeFiles({ runtimeDirectory, socketPath, pidFile });
        return unavailable(
          "error",
          "socket-path-too-long",
          "The private Cua Driver socket path is too long for this Linux installation.",
        );
      }

      const childEnv = desktopCommandEnvironment(env, {
        CUA_DRIVER_EMBEDDED: "1",
        CUA_DRIVER_HOST_BUNDLE_ID: HOST_BUNDLE_ID,
        CUA_DRIVER_PARENT_LIVENESS_STDIN: "1",
        ...(runtimeSession === "wayland" ? { CUA_DRIVER_RS_ENABLE_WAYLAND: "1" } : {}),
      });
      const args = [
        "serve",
        "--embedded",
        "--socket",
        socketPath,
        "--pid-file",
        pidFile,
        "--permission-mode",
        "standard",
      ];
      // Pin the exact file inspected above, not merely its path. Keep this
      // directly adjacent to spawn so an update/replacement during doctor or
      // runtime preparation fails closed instead of launching uninspected code.
      const revalidated = validateDriverCandidate(inspected.path);
      if (
        revalidated.status !== "found" ||
        revalidated.path !== inspected.path ||
        !sameDriverFileIdentity(inspected.fileIdentity, revalidated.fileIdentity)
      ) {
        cleanupRuntimeFiles({ runtimeDirectory, socketPath, pidFile });
        return unavailable(
          "error",
          "driver-changed",
          "Cua Driver changed after validation. Check the installation and try again.",
        );
      }
      const child = spawnProcess(inspected.path, args, {
        env: childEnv,
        shell: false,
        stdio: ["pipe", "ignore", "pipe"],
        windowsHide: true,
      });
      const owned = {
        child,
        generation,
        runtimeDirectory,
        socketPath,
        pidFile,
        ready: false,
        stopping: false,
        healthTimer: null,
        healthChecking: false,
      };
      active = owned;
      child.stderr?.on("data", () => {});
      child.once("exit", (code, signal) => markUnexpectedExit(owned, code, signal));
      child.once("error", (error) => markUnexpectedExit(owned, null, error?.code ?? "spawn-error"));
      unavailable("starting", "starting-daemon", "Starting the private Cua Driver runtime…", {
        generation,
        driver: { path: inspected.path, version: inspected.driverVersion },
      });

      try {
        const handshake = await probe(socketPath, {
          childPid: child.pid,
          session: runtimeSession,
        });
        if (active !== owned || owned.stopping || !enabled) {
          await stopOwnedChild(child);
          cleanupRuntimeFiles(owned);
          return connection;
        }
        owned.ready = true;
        const readyConnection = publish({
          schemaVersion: CONNECTION_SCHEMA_VERSION,
          mode:
            runtimeSession === "wayland"
              ? "linux-wayland-gnome-supervised"
              : "linux-x11-supervised",
          platform: "linux",
          session: runtimeSession,
          ...(inspected.compositor ? { compositor: inspected.compositor } : {}),
          enabled: true,
          status: "ready",
          ownerPid: processId,
          generation,
          driver: {
            path: inspected.path,
            version: inspected.driverVersion,
            source: inspected.source,
            manifestSchema: inspected.manifestSchema,
            // Private descriptor-only pin. The renderer consumes getStatus(),
            // which deliberately omits this internal file identity.
            fileIdentity: inspected.fileIdentity,
          },
          daemon: {
            socketPath,
            pid: handshake.metadata.pid,
            contractVersion: handshake.metadata.contract_version,
            toolsListSchemaVersion: handshake.metadata.tools_list_schema_version,
            capabilityVersion: handshake.metadata.capability_version,
            mcpProtocolVersion: handshake.metadata.mcp_protocol_version,
          },
          mcp: {
            command: inspected.path,
            args: ["mcp", "--embedded", "--socket", socketPath],
            env: {
              CUA_DRIVER_EMBEDDED: "1",
              CUA_DRIVER_HOST_BUNDLE_ID: HOST_BUNDLE_ID,
              CUA_DRIVER_RS_UPDATE_CHECK: "false",
              CUA_DRIVER_RS_TELEMETRY_ENABLED: "false",
              ...(runtimeSession === "wayland"
                ? { CUA_DRIVER_RS_ENABLE_WAYLAND: "1" }
                : {}),
            },
          },
          toolNames: handshake.tools,
          doctorWarnings: inspected.doctor.warnings,
        });
        if (runtimeSession === "wayland") startWaylandHealthMonitor(owned);
        return readyConnection;
      } catch (error) {
        owned.stopping = true;
        const stillOwned = active === owned;
        if (stillOwned) active = null;
        await stopOwnedChild(child);
        cleanupRuntimeFiles(owned);
        if (!stillOwned || !enabled || quitting) return connection;
        return unavailable(
          "error",
          error?.code ?? "daemon-start-failed",
          error?.message ?? "Cua Driver could not start.",
          { generation, driver: { path: inspected.path, version: inspected.driverVersion } },
        );
      }
    })()
      .catch((error) => {
        if (!enabled || quitting) return connection;
        return unavailable(
          "error",
          error?.code ?? "runtime-start-failed",
          "The private Cua Driver runtime could not start. Check the installation and try again.",
        );
      })
      .finally(() => {
        startPromise = null;
      });
    return startPromise;
  };

  const stop = async ({ disable = false, quit = false } = {}) => {
    if (disable) {
      enabled = false;
      preferenceStore.write(false);
    }
    if (quit) quitting = true;
    unavailable(
      disable ? "disabled" : "stopped",
      disable ? "opt-in-required" : quit ? "app-stopped" : "runtime-stopped",
      disable ? "Local control is disabled." : "Local control is not running.",
      active ? { generation: active.generation } : {},
    );
    const owned = active;
    if (owned) {
      owned.stopping = true;
      active = null;
      await stopOwnedChild(owned.child);
      cleanupRuntimeFiles(owned);
    }
    return connection;
  };

  return Object.freeze({
    async initialize() {
      enabled = preferenceStore.read();
      return enabled
        ? start()
        : unavailable(
            "disabled",
            "opt-in-required",
            "Local control is off until you enable the beta.",
          );
    },
    async enable() {
      enabled = true;
      preferenceStore.write(true);
      return start();
    },
    async retry() {
      if (!enabled) return connection;
      if (startPromise) await startPromise;
      await stop();
      return start();
    },
    async disable() {
      return stop({ disable: true });
    },
    async shutdown() {
      return stop({ quit: true });
    },
    getConnection() {
      return connection;
    },
    getStatus() {
      return publicRuntimeStatus(connection);
    },
  });
}

module.exports = {
  CERTIFIED_CAPABILITY_VERSION,
  CERTIFIED_CONTRACT_VERSION,
  CERTIFIED_MCP_PROTOCOL_VERSION,
  CERTIFIED_TOOLS_LIST_SCHEMA_VERSION,
  CONNECTION_SCHEMA_VERSION,
  HOST_BUNDLE_ID,
  REQUIRED_TOOLS,
  REQUIRED_WAYLAND_HEALTH_CHECKS,
  cleanupStaleRuntimeDirectories,
  createLinuxCuaPreferenceStore,
  createLinuxCuaRuntime,
  createUnavailableLinuxRuntime,
  ensurePrivateDirectory,
  probePrivateDaemon,
  probeWaylandHealth,
  publicRuntimeStatus,
  requestSocket,
  stopOwnedChild,
  validateDaemonMetadata,
  validateToolSurface,
  validateWaylandHealthReport,
  writePrivateJson,
};
