import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import type { Stats } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

export const REQUIRED_LINUX_TOOLS = ["click", "get_window_state", "list_apps", "type_text"];
// Keep this exact field set synchronized with DRIVER_FILE_IDENTITY_KEYS in
// electron/cua-linux.cjs; Electron publishes it and the server revalidates it.
export const DRIVER_FILE_IDENTITY_KEYS = [
  "dev",
  "ino",
  "uid",
  "gid",
  "mode",
  "size",
  "mtimeNs",
  "ctimeNs",
] as const;

export type LocalComputerConnection = {
  command: string;
  args: string[];
  env: Record<string, string>;
  platform: "darwin" | "linux" | "win32";
  generation?: string;
  scope: "local-computer";
};

type LegacyConnectionDescriptor = {
  mode?: string;
  mcpCommand?: unknown;
  mcpArgs?: unknown;
  mcpEnv?: unknown;
};

type LinuxConnectionDescriptor = Record<string, unknown>;

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return Object.keys(value).length === expected.size && Object.keys(value).every((key) => expected.has(key));
}

function legacyPlatform(platform: NodeJS.Platform): "darwin" | "win32" | null {
  if (platform === "darwin" || platform === "win32") return platform;
  return null;
}

function validDriverFileIdentity(value: unknown): value is Record<string, string> {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    exactKeys(value as Record<string, unknown>, DRIVER_FILE_IDENTITY_KEYS) &&
    DRIVER_FILE_IDENTITY_KEYS.every(
      (key) => typeof (value as Record<string, unknown>)[key] === "string" && /^\d+$/.test((value as Record<string, string>)[key]),
    )
  );
}

function currentDriverFileIdentity(file: string): Record<string, string> {
  const stat = statSync(file, { bigint: true });
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    uid: String(stat.uid),
    gid: String(stat.gid),
    mode: String(stat.mode),
    size: String(stat.size),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs),
  };
}

function sameDriverFileIdentity(expected: unknown, actual: Record<string, string>): boolean {
  return (
    validDriverFileIdentity(expected) &&
    DRIVER_FILE_IDENTITY_KEYS.every((key) => expected[key] === actual[key])
  );
}

function decodeLegacyDescriptor(
  value: LegacyConnectionDescriptor,
  platform: NodeJS.Platform,
): LocalComputerConnection | null {
  const supportedPlatform = legacyPlatform(platform);
  if (!supportedPlatform || !value || value.mode === "unavailable" || typeof value.mcpCommand !== "string") {
    return null;
  }
  if (value.mcpArgs !== undefined && !Array.isArray(value.mcpArgs)) return null;
  if (
    value.mcpEnv !== undefined &&
    (!value.mcpEnv || typeof value.mcpEnv !== "object" || Array.isArray(value.mcpEnv))
  ) {
    return null;
  }
  const args = value.mcpArgs ?? ["mcp"];
  if (!args.every((arg) => typeof arg === "string")) return null;
  const env = value.mcpEnv ?? {};
  if (!Object.values(env).every((entry) => typeof entry === "string")) return null;
  return {
    command: value.mcpCommand,
    args,
    env: env as Record<string, string>,
    platform: supportedPlatform,
    scope: "local-computer",
  };
}

export function decodeLinuxDescriptor(value: LinuxConnectionDescriptor): LocalComputerConnection | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const x11 = value.mode === "linux-x11-supervised" && value.session === "x11";
  const wayland =
    value.mode === "linux-wayland-gnome-supervised" &&
    value.session === "wayland" &&
    value.compositor === "gnome-mutter";
  const descriptorKeys = [
    "schemaVersion",
    "mode",
    "platform",
    "session",
    "enabled",
    "status",
    "ownerPid",
    "generation",
    "driver",
    "daemon",
    "mcp",
    "toolNames",
    "doctorWarnings",
    ...(wayland ? ["compositor"] : []),
  ];
  if (
    (!x11 && !wayland) ||
    !exactKeys(value, descriptorKeys) ||
    value.schemaVersion !== 1 ||
    value.platform !== "linux" ||
    value.enabled !== true ||
    value.status !== "ready" ||
    !Number.isInteger(value.ownerPid) ||
    (value.ownerPid as number) <= 0 ||
    typeof value.generation !== "string" ||
    !/^[0-9a-f-]{32,64}$/i.test(value.generation)
  ) {
    return null;
  }

  const driver = value.driver as Record<string, unknown>;
  const daemon = value.daemon as Record<string, unknown>;
  const mcp = value.mcp as Record<string, unknown>;
  if (
    !driver ||
    !daemon ||
    !mcp ||
    Array.isArray(driver) ||
    Array.isArray(daemon) ||
    Array.isArray(mcp) ||
    !exactKeys(driver, ["path", "version", "source", "manifestSchema", "fileIdentity"]) ||
    !exactKeys(daemon, [
      "socketPath",
      "pid",
      "contractVersion",
      "toolsListSchemaVersion",
      "capabilityVersion",
      "mcpProtocolVersion",
    ]) ||
    !exactKeys(mcp, ["command", "args", "env"])
  ) {
    return null;
  }
  if (
    typeof driver.path !== "string" ||
    !isAbsolute(driver.path) ||
    driver.version !== "0.19.3" ||
    !["bundled", "environment", "user-local", "path"].includes(String(driver.source)) ||
    driver.manifestSchema !== "1" ||
    !validDriverFileIdentity(driver.fileIdentity) ||
    typeof daemon.socketPath !== "string" ||
    !isAbsolute(daemon.socketPath) ||
    !Number.isInteger(daemon.pid) ||
    (daemon.pid as number) <= 0 ||
    daemon.contractVersion !== "0.6.0" ||
    daemon.toolsListSchemaVersion !== "1" ||
    daemon.capabilityVersion !== "1" ||
    daemon.mcpProtocolVersion !== "2025-06-18" ||
    mcp.command !== driver.path ||
    !Array.isArray(mcp.args) ||
    mcp.args.length !== 4 ||
    mcp.args[0] !== "mcp" ||
    mcp.args[1] !== "--embedded" ||
    mcp.args[2] !== "--socket" ||
    mcp.args[3] !== daemon.socketPath ||
    !mcp.env ||
    typeof mcp.env !== "object" ||
    Array.isArray(mcp.env) ||
    !exactKeys(mcp.env as Record<string, unknown>, [
      "CUA_DRIVER_EMBEDDED",
      "CUA_DRIVER_HOST_BUNDLE_ID",
      "CUA_DRIVER_RS_UPDATE_CHECK",
      "CUA_DRIVER_RS_TELEMETRY_ENABLED",
      ...(wayland ? ["CUA_DRIVER_RS_ENABLE_WAYLAND"] : []),
    ]) ||
    (mcp.env as Record<string, unknown>).CUA_DRIVER_EMBEDDED !== "1" ||
    (mcp.env as Record<string, unknown>).CUA_DRIVER_HOST_BUNDLE_ID !== "com.openmausbot.app" ||
    (mcp.env as Record<string, unknown>).CUA_DRIVER_RS_UPDATE_CHECK !== "false" ||
    (mcp.env as Record<string, unknown>).CUA_DRIVER_RS_TELEMETRY_ENABLED !== "false" ||
    (wayland && (mcp.env as Record<string, unknown>).CUA_DRIVER_RS_ENABLE_WAYLAND !== "1")
  ) {
    return null;
  }

  if (
    !Array.isArray(value.toolNames) ||
    value.toolNames.some((name) => typeof name !== "string") ||
    REQUIRED_LINUX_TOOLS.some((name) => !(value.toolNames as string[]).includes(name)) ||
    !Array.isArray(value.doctorWarnings)
  ) {
    return null;
  }
  for (const warning of value.doctorWarnings) {
    if (
      !warning ||
      typeof warning !== "object" ||
      Array.isArray(warning) ||
      ![3, 4].includes(Object.keys(warning).length) ||
      !Object.keys(warning).every((key) => ["label", "status", "message", "detail"].includes(key)) ||
      typeof warning.label !== "string" ||
      warning.status !== "warn" ||
      typeof warning.message !== "string" ||
      (warning.detail !== undefined && typeof warning.detail !== "string")
    ) {
      return null;
    }
  }

  return {
    command: driver.path,
    args: [...(mcp.args as string[])],
    env: { ...(mcp.env as Record<string, string>) },
    platform: "linux",
    generation: value.generation,
    scope: "local-computer",
  };
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function ownedPrivate(stat: Stats, uid: number): boolean {
  return (stat.uid === uid || stat.uid === 0) && (stat.mode & 0o077) === 0;
}

export function validateLinuxDescriptorRuntime(
  descriptorFile: string,
  raw: LinuxConnectionDescriptor,
  {
    uid = process.getuid?.() ?? -1,
    isProcessAlive = processAlive,
  }: { uid?: number; isProcessAlive?: (pid: number) => boolean } = {},
): boolean {
  try {
    const descriptorStat = lstatSync(descriptorFile);
    const descriptorDirectoryStat = lstatSync(dirname(descriptorFile));
    if (
      !descriptorStat.isFile() ||
      descriptorStat.isSymbolicLink() ||
      !ownedPrivate(descriptorStat, uid) ||
      !descriptorDirectoryStat.isDirectory() ||
      descriptorDirectoryStat.isSymbolicLink() ||
      !ownedPrivate(descriptorDirectoryStat, uid)
    ) {
      return false;
    }

    const driver = raw.driver as Record<string, unknown>;
    const daemon = raw.daemon as Record<string, unknown>;
    const binaryPath = driver.path as string;
    const socketPath = daemon.socketPath as string;
    const binaryStat = statSync(binaryPath);
    const currentFileIdentity = currentDriverFileIdentity(binaryPath);
    const socketStat = lstatSync(socketPath);
    const socketDirectoryStat = lstatSync(dirname(socketPath));
    if (
      realpathSync(binaryPath) !== binaryPath ||
      !sameDriverFileIdentity(driver.fileIdentity, currentFileIdentity) ||
      !binaryStat.isFile() ||
      (binaryStat.uid !== uid && binaryStat.uid !== 0) ||
      (binaryStat.mode & 0o111) === 0 ||
      (binaryStat.mode & 0o022) !== 0 ||
      !socketStat.isSocket() ||
      socketStat.isSymbolicLink() ||
      !ownedPrivate(socketStat, uid) ||
      !socketDirectoryStat.isDirectory() ||
      socketDirectoryStat.isSymbolicLink() ||
      !ownedPrivate(socketDirectoryStat, uid) ||
      !isProcessAlive(raw.ownerPid as number) ||
      !isProcessAlive(daemon.pid as number)
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function readCuaConnection({
  platform = process.platform,
  userData = process.env.OMB_USER_DATA,
  home = homedir(),
  validateLinuxRuntime = validateLinuxDescriptorRuntime,
}: {
  platform?: NodeJS.Platform;
  userData?: string;
  home?: string;
  validateLinuxRuntime?: (file: string, raw: LinuxConnectionDescriptor) => boolean;
} = {}): LocalComputerConnection | null {
  const candidates = userData ? [join(userData, "cua-connection.json")] : [];
  if (platform === "darwin") {
    // Legacy/dev fallback. Packaged Electron passes its exact userData path.
    for (const directory of ["OpenMausBot", "openmausbot", "OpenGrokBot", "opengrokbot"]) {
      candidates.push(join(home, "Library", "Application Support", directory, "cua-connection.json"));
    }
  }

  for (const file of [...new Set(candidates)]) {
    try {
      const raw = JSON.parse(readFileSync(file, "utf8"));
      if (platform === "linux") {
        const decoded = decodeLinuxDescriptor(raw);
        if (decoded && validateLinuxRuntime(file, raw)) return decoded;
      } else {
        const decoded = decodeLegacyDescriptor(raw, platform);
        if (decoded) return decoded;
      }
    } catch {
      // Missing, invalid, tampered, or stale descriptors are unavailable.
    }
  }
  return null;
}
