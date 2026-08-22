const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CERTIFIED_DRIVER_VERSION = "0.19.3";
const CERTIFIED_MANIFEST_SCHEMA = "1";
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_OUTPUT_BYTES = 512 * 1024;
const GETENT_BINARY = "/usr/bin/getent";
const GETENT_TIMEOUT_MS = 1_500;
const GETENT_MAX_OUTPUT_BYTES = 256 * 1024;
// Keep this exact field set synchronized with DRIVER_FILE_IDENTITY_KEYS in
// server/local-computer.ts; Electron publishes it and the server revalidates it.
const DRIVER_FILE_IDENTITY_KEYS = Object.freeze([
  "dev",
  "ino",
  "uid",
  "gid",
  "mode",
  "size",
  "mtimeNs",
  "ctimeNs",
]);

const SESSION_ENV_KEYS = new Set([
  "AT_SPI_BUS",
  "DBUS_SESSION_BUS_ADDRESS",
  "DISPLAY",
  "HOME",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "PATH",
  "USER",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
  "XDG_CURRENT_DESKTOP",
  "XDG_RUNTIME_DIR",
  "XDG_SESSION_DESKTOP",
  "XDG_SESSION_TYPE",
]);

function unavailable(reasonCode, message, details = {}) {
  return { status: "unavailable", reasonCode, message, ...details };
}

function sanitizePath(value) {
  const seen = new Set();
  const entries = [];
  for (const entry of String(value ?? "").split(path.delimiter)) {
    if (!entry || !path.isAbsolute(entry)) continue;
    const normalized = path.normalize(entry);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    entries.push(normalized);
  }
  return entries.join(path.delimiter);
}

function desktopCommandEnvironment(source = process.env, additions = {}) {
  const env = {};
  for (const [key, value] of Object.entries(source)) {
    if (value == null) continue;
    if (SESSION_ENV_KEYS.has(key) || key.startsWith("LC_")) env[key] = String(value);
  }
  env.PATH = sanitizePath(source.PATH);
  // Keep every Cua child owned by OpenMausBot deterministic and local-only.
  // Bundled native code must not independently update itself or opt users into
  // upstream telemetry. This does not change the user's persisted preferences.
  env.CUA_DRIVER_RS_UPDATE_CHECK = "false";
  env.CUA_DRIVER_RS_TELEMETRY_ENABLED = "false";
  for (const [key, value] of Object.entries(additions)) {
    if (value != null) env[key] = String(value);
  }
  return env;
}

function commandFailure(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function runCuaCommand(binary, args, {
  env = desktopCommandEnvironment(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
} = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let overflowed = false;
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    const child = spawn(binary, args, {
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const stop = () => {
      try {
        child.kill("SIGKILL");
      } catch {}
    };
    const collect = (current, chunk) => {
      const next = Buffer.concat([current, chunk]);
      if (stdout.length + stderr.length + chunk.length > maxOutputBytes) {
        overflowed = true;
        stop();
      }
      return next.subarray(0, maxOutputBytes);
    };

    child.stdout?.on("data", (chunk) => {
      stdout = collect(stdout, chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = collect(stderr, chunk);
    });
    child.once("error", (error) =>
      finish(reject, commandFailure("spawn-failed", `Could not start Cua Driver: ${error.message}`)),
    );
    child.once("close", (exitCode, signal) => {
      if (timedOut) {
        finish(
          reject,
          commandFailure("command-timeout", "Cua Driver did not respond in time.", { timeoutMs }),
        );
        return;
      }
      if (overflowed) {
        finish(
          reject,
          commandFailure("output-too-large", "Cua Driver returned too much diagnostic output."),
        );
        return;
      }
      finish(resolve, {
        exitCode,
        signal,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
      });
    });

    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    timer.unref?.();
  });
}

function pathComponents(target) {
  const resolved = path.resolve(target);
  const root = path.parse(resolved).root;
  const relative = resolved.slice(root.length).split(path.sep).filter(Boolean);
  const components = [root];
  let current = root;
  for (const part of relative) {
    current = path.join(current, part);
    components.push(current);
  }
  return components;
}

function safeOwner(stat, currentUid) {
  const uid = Number(stat.uid);
  return uid === currentUid || uid === 0;
}

function driverFileIdentityFromStat(stat) {
  return Object.freeze({
    dev: String(stat.dev),
    ino: String(stat.ino),
    uid: String(stat.uid),
    gid: String(stat.gid),
    mode: String(stat.mode),
    size: String(stat.size),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs),
  });
}

function captureDriverFileIdentity(target, fileSystem = fs) {
  return driverFileIdentityFromStat(fileSystem.statSync(target, { bigint: true }));
}

function sameDriverFileIdentity(expected, actual) {
  if (!expected || !actual || typeof expected !== "object" || typeof actual !== "object") {
    return false;
  }
  const expectedKeys = Object.keys(expected).sort();
  const actualKeys = Object.keys(actual).sort();
  const requiredKeys = [...DRIVER_FILE_IDENTITY_KEYS].sort();
  if (
    expectedKeys.length !== requiredKeys.length ||
    actualKeys.length !== requiredKeys.length ||
    !requiredKeys.every((key, index) => expectedKeys[index] === key && actualKeys[index] === key)
  ) {
    return false;
  }
  return DRIVER_FILE_IDENTITY_KEYS.every(
    (key) => typeof expected[key] === "string" && expected[key] === actual[key],
  );
}

function runGetent(args, {
  spawnCommand = spawnSync,
  timeoutMs = GETENT_TIMEOUT_MS,
  maxOutputBytes = GETENT_MAX_OUTPUT_BYTES,
} = {}) {
  const result = spawnCommand(GETENT_BINARY, args, {
    encoding: "utf8",
    env: { LANG: "C", LC_ALL: "C" },
    maxBuffer: maxOutputBytes,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
    windowsHide: true,
  });
  if (result?.error || result?.status !== 0 || typeof result?.stdout !== "string") {
    return {
      ok: false,
      reason: result?.error?.code === "ETIMEDOUT" ? "lookup-timeout" : "lookup-failed",
    };
  }
  if (Buffer.byteLength(result.stdout) > maxOutputBytes) {
    return { ok: false, reason: "lookup-output-too-large" };
  }
  return { ok: true, stdout: result.stdout };
}

function privatePrimaryGroup(identity, { getent = runGetent } = {}) {
  if (
    !Number.isSafeInteger(identity?.uid) ||
    !Number.isSafeInteger(identity?.gid) ||
    typeof identity?.username !== "string" ||
    !identity.username
  ) {
    return { exclusive: false, reason: "identity-unavailable" };
  }

  const groupResult = getent(["group", String(identity.gid)]);
  if (!groupResult?.ok) {
    return { exclusive: false, reason: groupResult?.reason ?? "lookup-failed" };
  }

  const groupLines = groupResult.stdout.split(/\r?\n/).filter(Boolean);
  const groupRecords = groupLines.map((line) => line.split(":"));
  if (
    groupRecords.length !== 1 ||
    groupRecords[0].length !== 4 ||
    !/^\d+$/.test(groupRecords[0][2]) ||
    Number(groupRecords[0][2]) !== identity.gid ||
    groupRecords[0][0] !== identity.username
  ) {
    return { exclusive: false, reason: "primary-group-not-private" };
  }
  const explicitMembers = groupRecords[0][3].split(",").filter(Boolean);
  if (explicitMembers.some((member) => member !== identity.username)) {
    return { exclusive: false, reason: "primary-group-shared" };
  }

  const passwdResult = getent(["passwd"]);
  if (!passwdResult?.ok) {
    return { exclusive: false, reason: passwdResult?.reason ?? "lookup-failed" };
  }
  const passwdLines = passwdResult.stdout.split(/\r?\n/).filter(Boolean);
  const passwdRecords = passwdLines.map((line) => line.split(":"));
  if (
    passwdRecords.length === 0 ||
    passwdRecords.some(
      (fields) =>
        fields.length !== 7 || !/^\d+$/.test(fields[2]) || !/^\d+$/.test(fields[3]),
    )
  ) {
    return { exclusive: false, reason: "lookup-malformed" };
  }
  const primaryMembers = passwdRecords
    .filter((fields) => Number(fields[3]) === identity.gid)
    .map((fields) => ({ username: fields[0], uid: Number(fields[2]) }));
  if (
    primaryMembers.length !== 1 ||
    primaryMembers[0].username !== identity.username ||
    primaryMembers[0].uid !== identity.uid
  ) {
    return { exclusive: false, reason: "primary-group-shared" };
  }
  return { exclusive: true, gid: identity.gid, name: identity.username };
}

function driverIdentity({ currentUid, currentGid, currentUsername } = {}) {
  let info = {};
  try {
    info = os.userInfo();
  } catch {
    // Group-writable paths will fail closed when identity cannot be proven.
  }
  return {
    uid: currentUid ?? process.getuid?.() ?? info.uid,
    gid: currentGid ?? process.getgid?.() ?? info.gid,
    username: currentUsername ?? info.username,
  };
}

function createPermissionCheck(identity, lookupPrivateGroup) {
  let groupProof;
  const groupWriteAllowed = (stat) => {
    if (Number(stat.uid) !== identity.uid || Number(stat.gid) !== identity.gid) return false;
    if (groupProof === undefined) {
      try {
        groupProof = lookupPrivateGroup(identity);
      } catch {
        groupProof = { exclusive: false, reason: "lookup-failed" };
      }
    }
    return (
      groupProof?.exclusive === true &&
      groupProof.gid === identity.gid &&
      groupProof.name === identity.username
    );
  };
  const failure = (component, stat) => {
    const worldWritable = (Number(stat.mode) & 0o002) !== 0;
    return unavailable(
      "unsafe-driver-permissions",
      worldWritable
        ? `Cua Driver path is world-writable: ${component}`
        : `Cua Driver path is group-writable and its group could not be proven private: ${component}`,
      {
        affectedPaths: [component],
        ...(groupProof?.reason ? { permissionReason: groupProof.reason } : {}),
      },
    );
  };
  return { failure, groupWriteAllowed };
}

function writablePermissionError(component, stat, permissionCheck, { allowRootSticky = false } = {}) {
  const mode = Number(stat.mode);
  const rootOwnedStickyDirectory =
    allowRootSticky && stat.isDirectory() && Number(stat.uid) === 0 && (mode & 0o1000) !== 0;
  if (rootOwnedStickyDirectory) return null;
  if ((mode & 0o002) !== 0) return permissionCheck.failure(component, stat);
  if ((mode & 0o020) !== 0 && !permissionCheck.groupWriteAllowed(stat)) {
    return permissionCheck.failure(component, stat);
  }
  return null;
}

function validatePathComponents(target, currentUid, permissionCheck) {
  for (const component of pathComponents(path.dirname(target))) {
    const stat = fs.lstatSync(component);
    if (!safeOwner(stat, currentUid)) {
      return unavailable(
        "unsafe-driver-owner",
        `Cua Driver path component is owned by an unexpected user: ${component}`,
        { affectedPaths: [component] },
      );
    }
    const permissionError = writablePermissionError(component, stat, permissionCheck, {
      allowRootSticky: true,
    });
    if (permissionError) return permissionError;
  }
  return null;
}

function validateDriverCandidate(candidate, {
  currentUid,
  currentGid,
  currentUsername,
  lookupPrivateGroup = privatePrimaryGroup,
} = {}) {
  const identity = driverIdentity({ currentUid, currentGid, currentUsername });
  const permissionCheck = createPermissionCheck(identity, lookupPrivateGroup);
  if (!path.isAbsolute(candidate)) {
    return unavailable("driver-path-not-absolute", "Cua Driver path must be absolute.", {
      candidate,
    });
  }

  let linkStat;
  let canonicalPath;
  let targetStat;
  let fileIdentity;
  try {
    linkStat = fs.lstatSync(candidate);
    canonicalPath = fs.realpathSync(candidate);
    // This single stat is the authority for type, owner, mode, and the
    // identity later pinned by the runtime. A second stat at the end proves
    // the file did not change while parent permissions were being checked.
    targetStat = fs.statSync(canonicalPath, { bigint: true });
    fileIdentity = driverFileIdentityFromStat(targetStat);
  } catch (error) {
    return unavailable("driver-not-found", `Cua Driver was not found at ${candidate}.`, {
      candidate,
      cause: error?.code,
    });
  }

  if (!safeOwner(linkStat, identity.uid) || !safeOwner(targetStat, identity.uid)) {
    return unavailable(
      "unsafe-driver-owner",
      "Cua Driver must be owned by the current user or root.",
      { candidate, canonicalPath, affectedPaths: [canonicalPath] },
    );
  }
  if (!targetStat.isFile()) {
    return unavailable("driver-not-file", "Cua Driver must resolve to a regular file.", {
      candidate,
      canonicalPath,
    });
  }
  if ((Number(targetStat.mode) & 0o111) === 0) {
    return unavailable("driver-not-executable", "Cua Driver is not executable.", {
      candidate,
      canonicalPath,
    });
  }
  const targetPermissionError = writablePermissionError(canonicalPath, targetStat, permissionCheck);
  if (targetPermissionError) return { ...targetPermissionError, candidate, canonicalPath };

  try {
    const lexicalError = validatePathComponents(candidate, identity.uid, permissionCheck);
    if (lexicalError) return { ...lexicalError, candidate, canonicalPath };
    const canonicalError = validatePathComponents(canonicalPath, identity.uid, permissionCheck);
    if (canonicalError) return { ...canonicalError, candidate, canonicalPath };
    fs.accessSync(canonicalPath, fs.constants.X_OK);
  } catch (error) {
    return unavailable("driver-not-executable", "Cua Driver cannot be executed.", {
      candidate,
      canonicalPath,
      cause: error?.code,
    });
  }

  try {
    const finalIdentity = captureDriverFileIdentity(canonicalPath);
    if (!sameDriverFileIdentity(fileIdentity, finalIdentity)) {
      return unavailable("driver-changed", "Cua Driver changed while it was being validated.", {
        candidate,
        canonicalPath,
      });
    }
  } catch (error) {
    return unavailable("driver-not-found", "Cua Driver changed while it was being validated.", {
      candidate,
      canonicalPath,
      cause: error?.code,
    });
  }

  return { status: "found", path: canonicalPath, fileIdentity };
}

function discoverLinuxCuaDriver({
  env = process.env,
  homeDir = os.homedir(),
  bundledDriverPath,
  currentUid,
  currentGid,
  currentUsername,
  lookupPrivateGroup,
} = {}) {
  const validationOptions = { currentUid, currentGid, currentUsername, lookupPrivateGroup };
  const explicit = env.CUA_DRIVER_PATH;
  if (explicit) {
    const result = validateDriverCandidate(explicit, validationOptions);
    return result.status === "found" ? { ...result, source: "environment" } : result;
  }

  // A packaged build has one reviewed driver paired with the app release.
  // Never fall through to ambient user/PATH code when that bundle is missing
  // or unsafe: a damaged package must fail closed. CUA_DRIVER_PATH above is
  // the sole intentional override for development and incident response.
  if (bundledDriverPath) {
    const result = validateDriverCandidate(bundledDriverPath, validationOptions);
    return result.status === "found" ? { ...result, source: "bundled" } : result;
  }

  const localCandidate = path.join(homeDir, ".local", "bin", "cua-driver");
  if (fs.existsSync(localCandidate)) {
    const result = validateDriverCandidate(localCandidate, validationOptions);
    if (result.status === "found") return { ...result, source: "user-local" };
    return result;
  }

  let firstUnsafe = null;
  for (const directory of sanitizePath(env.PATH).split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, "cua-driver");
    if (!fs.existsSync(candidate)) continue;
    const result = validateDriverCandidate(candidate, validationOptions);
    if (result.status === "found") return { ...result, source: "path" };
    firstUnsafe ??= result;
  }
  return (
    firstUnsafe ??
    unavailable(
      "driver-not-found",
      "Cua Driver was not found. Install it, then try again.",
    )
  );
}

function parseJsonObject(value, label) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw commandFailure("invalid-json", `${label} returned invalid JSON.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw commandFailure("invalid-json", `${label} returned an invalid JSON object.`);
  }
  return parsed;
}

function parseVersion(stdout) {
  const match = String(stdout).trim().match(/(?:cua-driver\s+)?(\d+\.\d+\.\d+)/i);
  return match?.[1] ?? null;
}

function validateManifest(manifest, binaryPath) {
  if (manifest.schema_version !== CERTIFIED_MANIFEST_SCHEMA) {
    throw commandFailure(
      "unsupported-manifest",
      `Cua Driver manifest schema ${String(manifest.schema_version)} is not supported.`,
    );
  }
  if (manifest.binary_version !== CERTIFIED_DRIVER_VERSION) {
    throw commandFailure(
      "unsupported-driver-version",
      `Cua Driver ${String(manifest.binary_version)} is not supported; install ${CERTIFIED_DRIVER_VERSION}.`,
    );
  }
  const invocation = manifest.mcp_invocation;
  if (
    !invocation ||
    typeof invocation.command !== "string" ||
    !Array.isArray(invocation.args) ||
    invocation.args.length !== 1 ||
    invocation.args[0] !== "mcp"
  ) {
    throw commandFailure("unsupported-manifest", "Cua Driver returned an unsupported MCP contract.");
  }
  let invocationPath;
  try {
    invocationPath = fs.realpathSync(invocation.command);
  } catch {
    throw commandFailure("unsupported-manifest", "Cua Driver MCP command could not be verified.");
  }
  if (invocationPath !== binaryPath) {
    throw commandFailure("unsupported-manifest", "Cua Driver MCP command does not match the verified binary.");
  }
  return { command: binaryPath, args: ["mcp"] };
}

function validateDoctor(report, { session = "x11" } = {}) {
  if (typeof report.ok !== "boolean" || !Array.isArray(report.probes)) {
    throw commandFailure("invalid-doctor-report", "Cua Driver returned an invalid doctor report.");
  }
  const probes = report.probes.map((probe) => {
    if (
      !probe ||
      typeof probe.label !== "string" ||
      !["ok", "warn", "err"].includes(probe.status) ||
      typeof probe.message !== "string"
    ) {
      throw commandFailure("invalid-doctor-report", "Cua Driver returned an invalid doctor probe.");
    }
    return {
      label: probe.label,
      status: probe.status,
      message: probe.message,
      ...(typeof probe.detail === "string" ? { detail: probe.detail } : {}),
    };
  });
  const byLabel = new Map(probes.map((probe) => [probe.label, probe]));
  const display = byLabel.get("display server");
  const x11 = byLabel.get("X11 connection");
  const atSpi = byLabel.get("AT-SPI");
  if (!report.ok || probes.some((probe) => probe.status === "err")) {
    throw commandFailure("doctor-failed", "Cua Driver diagnostics reported an error.", { probes });
  }
  if (session === "wayland") {
    if (display?.status !== "ok" || !display.message.startsWith("Wayland")) {
      throw commandFailure(
        "wayland-session-unavailable",
        "Cua Driver did not confirm an active Wayland display.",
        { probes },
      );
    }
  } else {
    if (display?.status !== "ok" || !display.message.startsWith("X11 ")) {
      throw commandFailure("x11-unavailable", "Cua Driver did not confirm an Xorg display.", { probes });
    }
    if (!x11 || x11.status === "err") {
      throw commandFailure("x11-unavailable", "Cua Driver could not verify the Xorg session.", { probes });
    }
  }
  if (atSpi?.status !== "ok") {
    throw commandFailure("at-spi-unavailable", "Cua Driver could not reach the AT-SPI accessibility bus.", {
      probes,
    });
  }
  return { ok: true, probes, warnings: probes.filter((probe) => probe.status === "warn") };
}

async function inspectLinuxCuaDriver({
  platform = process.platform,
  arch = process.arch,
  env = process.env,
  homeDir = os.homedir(),
  bundledDriverPath,
  currentUid,
  currentGid,
  currentUsername,
  lookupPrivateGroup,
  run = runCuaCommand,
} = {}) {
  const declaredSession = String(env.XDG_SESSION_TYPE ?? "").toLowerCase();
  const session =
    declaredSession === "wayland" || env.WAYLAND_DISPLAY
      ? "wayland"
      : declaredSession === "x11" || declaredSession === "xorg"
        ? "x11"
        : "unknown";
  if (platform !== "linux") {
    return unavailable("unsupported-platform", "Linux local control is only available on Ubuntu.");
  }
  if (arch !== "x64") {
    return unavailable(
      "unsupported-architecture",
      "Bundled Linux local control is currently available only on x64 Ubuntu.",
    );
  }
  if (session === "wayland") {
    const desktops = [env.XDG_CURRENT_DESKTOP, env.XDG_SESSION_DESKTOP]
      .flatMap((value) => String(value ?? "").toLowerCase().split(":"))
      .filter(Boolean);
    if (!desktops.includes("gnome")) {
      return unavailable(
        "wayland-compositor-unsupported",
        "Wayland local control is currently limited to GNOME.",
      );
    }
    if (!env.WAYLAND_DISPLAY || !env.DBUS_SESSION_BUS_ADDRESS) {
      return unavailable(
        "wayland-session-unavailable",
        "Local control requires an active GNOME Wayland desktop session.",
      );
    }
  } else if (session !== "x11") {
    return unavailable(
      "desktop-session-required",
      "Local control requires an interactive GNOME desktop session.",
    );
  }
  if (session === "x11" && !env.DISPLAY) {
    return unavailable("display-unavailable", "Local control requires an active Xorg display.");
  }

  const discovered = discoverLinuxCuaDriver({
    env,
    homeDir,
    bundledDriverPath,
    currentUid,
    currentGid,
    currentUsername,
    lookupPrivateGroup,
  });
  if (discovered.status !== "found") return discovered;
  const commandEnv = desktopCommandEnvironment(
    env,
    session === "wayland" ? { CUA_DRIVER_RS_ENABLE_WAYLAND: "1" } : {},
  );

  try {
    const versionResult = await run(discovered.path, ["--version"], { env: commandEnv });
    const driverVersion = parseVersion(versionResult.stdout || versionResult.stderr);
    if (versionResult.exitCode !== 0 || driverVersion !== CERTIFIED_DRIVER_VERSION) {
      return unavailable(
        "unsupported-driver-version",
        `Cua Driver ${driverVersion ?? "unknown"} is not supported; install ${CERTIFIED_DRIVER_VERSION}.`,
        { path: discovered.path, source: discovered.source, driverVersion },
      );
    }

    const manifestResult = await run(discovered.path, ["manifest"], { env: commandEnv });
    if (manifestResult.exitCode !== 0) {
      return unavailable("manifest-failed", "Cua Driver manifest validation failed.", {
        path: discovered.path,
        source: discovered.source,
      });
    }
    const manifest = parseJsonObject(manifestResult.stdout, "Cua Driver manifest");
    const mcp = validateManifest(manifest, discovered.path);

    const doctorResult = await run(discovered.path, ["doctor", "--json"], { env: commandEnv });
    const doctorReport = parseJsonObject(doctorResult.stdout, "Cua Driver doctor");
    if (doctorResult.exitCode !== 0 && doctorReport.ok !== false) {
      return unavailable("doctor-failed", "Cua Driver diagnostics failed.", {
        path: discovered.path,
        source: discovered.source,
      });
    }
    const doctor = validateDoctor(doctorReport, { session });

    return {
      status: "ready",
      path: discovered.path,
      source: discovered.source,
      fileIdentity: discovered.fileIdentity,
      driverVersion,
      manifestSchema: manifest.schema_version,
      mcp,
      doctor,
      commandEnv,
      session,
      ...(session === "wayland" ? { compositor: "gnome-mutter" } : {}),
    };
  } catch (error) {
    return unavailable(error?.code ?? "diagnostics-failed", error?.message ?? String(error), {
      path: discovered.path,
      source: discovered.source,
      ...(error?.probes ? { probes: error.probes } : {}),
    });
  }
}

module.exports = {
  CERTIFIED_DRIVER_VERSION,
  CERTIFIED_MANIFEST_SCHEMA,
  DRIVER_FILE_IDENTITY_KEYS,
  captureDriverFileIdentity,
  desktopCommandEnvironment,
  discoverLinuxCuaDriver,
  inspectLinuxCuaDriver,
  parseVersion,
  privatePrimaryGroup,
  runGetent,
  runCuaCommand,
  sameDriverFileIdentity,
  sanitizePath,
  validateDoctor,
  validateDriverCandidate,
  validateManifest,
};
