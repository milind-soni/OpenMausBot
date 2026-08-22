import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  DRIVER_FILE_IDENTITY_KEYS,
  REQUIRED_LINUX_TOOLS,
  decodeLinuxDescriptor,
  readCuaConnection,
  validateLinuxDescriptorRuntime,
} from "./local-computer.ts";

const require = createRequire(import.meta.url);
const { DRIVER_FILE_IDENTITY_KEYS: ELECTRON_DRIVER_FILE_IDENTITY_KEYS } = require(
  "../electron/cua-linux.cjs",
);
const { REQUIRED_TOOLS: ELECTRON_REQUIRED_TOOLS } = require("../electron/cua-linux-runtime.cjs");

function linuxDescriptor(userData: string, { session = "x11" }: { session?: "x11" | "wayland" } = {}) {
  const binary = join(userData, "cua-driver");
  const socket = join(userData, "runtime", "driver.sock");
  writeFileSync(binary, "fake", { mode: 0o700 });
  const stat = statSync(binary, { bigint: true });
  const fileIdentity = {
    dev: String(stat.dev),
    ino: String(stat.ino),
    uid: String(stat.uid),
    gid: String(stat.gid),
    mode: String(stat.mode),
    size: String(stat.size),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs),
  };
  return {
    schemaVersion: 1,
    mode: session === "wayland" ? "linux-wayland-gnome-supervised" : "linux-x11-supervised",
    platform: "linux",
    session,
    ...(session === "wayland" ? { compositor: "gnome-mutter" } : {}),
    enabled: true,
    status: "ready",
    ownerPid: process.pid,
    generation: "01234567-89ab-cdef-0123-456789abcdef",
    driver: {
      path: binary,
      version: "0.19.3",
      source: "environment",
      manifestSchema: "1",
      fileIdentity,
    },
    daemon: {
      socketPath: socket,
      pid: process.pid,
      contractVersion: "0.6.0",
      toolsListSchemaVersion: "1",
      capabilityVersion: "1",
      mcpProtocolVersion: "2025-06-18",
    },
    mcp: {
      command: binary,
      args: ["mcp", "--embedded", "--socket", socket],
      env: {
        CUA_DRIVER_EMBEDDED: "1",
        CUA_DRIVER_HOST_BUNDLE_ID: "com.openmausbot.app",
        CUA_DRIVER_RS_UPDATE_CHECK: "false",
        CUA_DRIVER_RS_TELEMETRY_ENABLED: "false",
        ...(session === "wayland" ? { CUA_DRIVER_RS_ENABLE_WAYLAND: "1" } : {}),
      },
    },
    toolNames: ["click", "get_window_state", "list_apps", "type_text"],
    doctorWarnings: [],
  };
}

describe("local computer descriptor contract", () => {
  it("stays synchronized with the Electron producer", () => {
    expect(DRIVER_FILE_IDENTITY_KEYS).toEqual([...ELECTRON_DRIVER_FILE_IDENTITY_KEYS]);
    expect(REQUIRED_LINUX_TOOLS).toEqual([...ELECTRON_REQUIRED_TOOLS]);
  });
});

const temporaryDirectories: string[] = [];

function privateUserData(name: string) {
  const base = process.platform === "win32" ? tmpdir() : realpathSync("/tmp");
  const root = mkdtempSync(join(base, "omb-local-computer-"));
  temporaryDirectories.push(root);
  const userData = join(root, name);
  mkdirSync(userData, { recursive: true, mode: 0o700 });
  chmodSync(userData, 0o700);
  return userData;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("local computer descriptor", () => {
  it("accepts only the exact certified Linux X11 descriptor", () => {
    const userData = privateUserData("linux-user-data");
    const descriptor = linuxDescriptor(userData);
    writeFileSync(join(userData, "cua-connection.json"), JSON.stringify(descriptor), { mode: 0o600 });

    expect(
      readCuaConnection({
        platform: "linux",
        userData,
        validateLinuxRuntime: () => true,
      }),
    ).toEqual({
      command: descriptor.driver.path,
      args: descriptor.mcp.args,
      env: descriptor.mcp.env,
      platform: "linux",
      generation: descriptor.generation,
      scope: "local-computer",
    });
  });

  it("accepts the exact GNOME Wayland descriptor without weakening the X11 contract", () => {
    const userData = privateUserData("linux-wayland-user-data");
    const descriptor = linuxDescriptor(userData, { session: "wayland" });
    expect(decodeLinuxDescriptor(descriptor)).toEqual({
      command: descriptor.driver.path,
      args: descriptor.mcp.args,
      env: descriptor.mcp.env,
      platform: "linux",
      generation: descriptor.generation,
      scope: "local-computer",
    });
    expect(decodeLinuxDescriptor({ ...descriptor, compositor: "kde-kwin" })).toBeNull();
    const { CUA_DRIVER_RS_ENABLE_WAYLAND: _missing, ...x11OnlyEnv } = descriptor.mcp.env;
    expect(
      decodeLinuxDescriptor({ ...descriptor, mcp: { ...descriptor.mcp, env: x11OnlyEnv } }),
    ).toBeNull();
    const x11Descriptor = linuxDescriptor(userData);
    expect(
      decodeLinuxDescriptor({
        ...x11Descriptor,
        mcp: {
          ...x11Descriptor.mcp,
          env: { ...x11Descriptor.mcp.env, CUA_DRIVER_RS_ENABLE_WAYLAND: "1" },
        },
      }),
    ).toBeNull();
  });

  it("rejects unknown fields, stale modes, arbitrary argv, and incomplete tool surfaces", () => {
    const userData = privateUserData("linux-invalid-user-data");
    const descriptor = linuxDescriptor(userData);
    expect(decodeLinuxDescriptor({ ...descriptor, unexpected: true })).toBeNull();
    expect(decodeLinuxDescriptor({ ...descriptor, status: "starting" })).toBeNull();
    const { CUA_DRIVER_RS_TELEMETRY_ENABLED: _telemetry, ...telemetryMissing } =
      descriptor.mcp.env;
    expect(
      decodeLinuxDescriptor({
        ...descriptor,
        mcp: { ...descriptor.mcp, env: telemetryMissing },
      }),
    ).toBeNull();
    expect(
      decodeLinuxDescriptor({
        ...descriptor,
        mcp: { ...descriptor.mcp, args: ["mcp", "--socket", descriptor.daemon.socketPath, "--evil"] },
      }),
    ).toBeNull();
    expect(decodeLinuxDescriptor({ ...descriptor, toolNames: ["list_apps"] })).toBeNull();
    expect(
      decodeLinuxDescriptor({
        ...descriptor,
        mcp: {
          ...descriptor.mcp,
          env: { ...descriptor.mcp.env, CUA_DRIVER_RS_TELEMETRY_ENABLED: "true" },
        },
      }),
    ).toBeNull();
    expect(
      decodeLinuxDescriptor({
        ...descriptor,
        driver: { ...descriptor.driver, fileIdentity: { ...descriptor.driver.fileIdentity, extra: "1" } },
      }),
    ).toBeNull();
    const { fileIdentity: _missingIdentity, ...driverWithoutIdentity } = descriptor.driver;
    expect(decodeLinuxDescriptor({ ...descriptor, driver: driverWithoutIdentity })).toBeNull();
  });

  it("fails closed when runtime ownership or liveness validation fails", () => {
    const userData = privateUserData("linux-stale-user-data");
    const descriptor = linuxDescriptor(userData);
    writeFileSync(join(userData, "cua-connection.json"), JSON.stringify(descriptor), { mode: 0o600 });
    expect(
      readCuaConnection({ platform: "linux", userData, validateLinuxRuntime: () => false }),
    ).toBeNull();
  });

  // Runtime ownership includes a real Linux Unix-domain socket and POSIX
  // permission checks. Keep the schema/decoder cases above cross-platform,
  // but run this host-filesystem proof only on the authoritative Linux lane.
  it.skipIf(process.platform !== "linux")(
    "validates private descriptor, executable, socket, and live owned processes",
    async () => {
      const userData = privateUserData("linux-runtime-security");
      const runtimeDirectory = join(userData, "runtime");
      mkdirSync(runtimeDirectory, { mode: 0o700 });
      const descriptor = linuxDescriptor(userData);
      const file = join(userData, "cua-connection.json");
      writeFileSync(file, JSON.stringify(descriptor), { mode: 0o600 });
      const server = createServer();
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(descriptor.daemon.socketPath, resolve);
      });
      try {
        chmodSync(descriptor.daemon.socketPath, 0o600);
        expect(validateLinuxDescriptorRuntime(file, descriptor)).toBe(true);
        expect(readCuaConnection({ platform: "linux", userData })).not.toBeNull();
        chmodSync(file, 0o644);
        expect(validateLinuxDescriptorRuntime(file, descriptor)).toBe(false);
        chmodSync(file, 0o600);
        expect(validateLinuxDescriptorRuntime(file, descriptor)).toBe(true);
        appendFileSync(descriptor.driver.path, "changed after descriptor publication");
        expect(validateLinuxDescriptorRuntime(file, descriptor)).toBe(false);
        expect(readCuaConnection({ platform: "linux", userData })).toBeNull();
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );

  it("still rejects an old embedded-looking Linux descriptor", () => {
    const userData = privateUserData("linux-forged-user-data");
    writeFileSync(
      join(userData, "cua-connection.json"),
      JSON.stringify({
        mode: "embedded",
        mcpCommand: "/tmp/cua-driver",
        mcpArgs: ["mcp", "--embedded"],
        mcpEnv: { CUA_DRIVER_EMBEDDED: "1" },
      }),
      { mode: 0o600 },
    );
    expect(readCuaConnection({ platform: "linux", userData })).toBeNull();
  });

  it("preserves the selected Windows descriptor contract", () => {
    const userData = privateUserData("windows-user-data");
    writeFileSync(
      join(userData, "cua-connection.json"),
      JSON.stringify({
        mode: "embedded",
        mcpCommand: "C:\\cua-driver.exe",
        mcpArgs: ["mcp"],
        mcpEnv: { CUA_DRIVER_EMBEDDED: "1" },
      }),
    );
    expect(readCuaConnection({ platform: "win32", userData })).toEqual({
      command: "C:\\cua-driver.exe",
      args: ["mcp"],
      env: { CUA_DRIVER_EMBEDDED: "1" },
      platform: "win32",
      scope: "local-computer",
    });
  });

  it("rejects malformed legacy argv and environment values", () => {
    const userData = privateUserData("invalid-user-data");
    writeFileSync(
      join(userData, "cua-connection.json"),
      JSON.stringify({ mode: "embedded", mcpCommand: "cua-driver", mcpArgs: "mcp" }),
    );
    expect(readCuaConnection({ platform: "win32", userData })).toBeNull();
  });
});
