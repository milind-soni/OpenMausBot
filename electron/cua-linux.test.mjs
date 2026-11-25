import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  desktopCommandEnvironment,
  discoverLinuxCuaDriver,
  inspectLinuxCuaDriver,
  privatePrimaryGroup,
  runCuaCommand,
  runGetent,
  sameDriverFileIdentity,
  sanitizePath,
  validateDriverCandidate,
} = require("./cua-linux.cjs");

const temporaryDirectories = [];

function temporaryDirectory() {
  const base = process.platform === "win32" ? os.tmpdir() : fs.realpathSync("/tmp");
  const directory = fs.mkdtempSync(path.join(base, "omb-cua-linux-"));
  temporaryDirectories.push(directory);
  return directory;
}

function executable(directory, name = "cua-driver") {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, name);
  fs.writeFileSync(file, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  return file;
}

function healthyDoctor() {
  return {
    ok: true,
    probes: [
      { label: "binary", status: "ok", message: "cua-driver 0.41.3" },
      { label: "display server", status: "ok", message: "X11 (DISPLAY=:0)" },
      { label: "X11 connection", status: "ok", message: "connected, 1 visible top-level window" },
      { label: "AT-SPI", status: "ok", message: "org.a11y.Bus reachable via session bus" },
      { label: "telemetry", status: "warn", message: "test warning" },
    ],
  };
}

function healthyWaylandDoctor() {
  return {
    ok: true,
    probes: [
      { label: "binary", status: "ok", message: "cua-driver 0.41.3" },
      {
        label: "display server",
        status: "ok",
        message: "Wayland+XWayland (WAYLAND_DISPLAY=wayland-0, DISPLAY=:0)",
      },
      { label: "X11 connection", status: "warn", message: "no top-level windows returned" },
      { label: "AT-SPI", status: "ok", message: "org.a11y.Bus reachable via session bus" },
    ],
  };
}

function successfulRunner(binary, { doctor = healthyDoctor() } = {}) {
  return vi.fn(async (_command, args, options) => {
    expect(_command).toBe(binary);
    expect(options.env.OPENAI_API_KEY).toBeUndefined();
    if (args[0] === "--version") return { exitCode: 0, stdout: "cua-driver 0.41.3\n", stderr: "" };
    if (args[0] === "manifest") {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          schema_version: "1",
          binary_version: "0.41.3",
          binary_path: binary,
          mcp_invocation: { command: binary, args: ["mcp"] },
        }),
        stderr: "",
      };
    }
    return { exitCode: 0, stdout: JSON.stringify(doctor), stderr: "" };
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

// Windows lacks the POSIX executable and ownership semantics discovery uses.
describe.skipIf(process.platform === "win32")("Linux CUA discovery", () => {
  it("rejects an invalid explicit override without falling through", () => {
    const root = temporaryDirectory();
    const fallback = executable(path.join(root, "bin"));
    const result = discoverLinuxCuaDriver({
      env: { CUA_DRIVER_PATH: path.join(root, "missing"), PATH: path.dirname(fallback) },
      homeDir: root,
    });
    expect(result).toMatchObject({ status: "unavailable", reasonCode: "driver-not-found" });
  });

  it("keeps an explicit valid override ahead of the packaged driver", () => {
    const root = temporaryDirectory();
    const explicit = executable(path.join(root, "explicit"));
    const bundled = executable(path.join(root, "resources"));
    expect(
      discoverLinuxCuaDriver({
        env: { CUA_DRIVER_PATH: explicit, PATH: "" },
        homeDir: root,
        bundledDriverPath: bundled,
      }),
    ).toMatchObject({ status: "found", path: explicit, source: "environment" });
  });

  it("uses the packaged driver ahead of user-local and PATH candidates", () => {
    const root = temporaryDirectory();
    const bundled = executable(path.join(root, "resources"));
    executable(path.join(root, ".local", "bin"));
    const pathCandidate = executable(path.join(root, "path"));
    expect(
      discoverLinuxCuaDriver({
        env: { PATH: path.dirname(pathCandidate) },
        homeDir: root,
        bundledDriverPath: bundled,
      }),
    ).toMatchObject({ status: "found", path: bundled, source: "bundled" });
  });

  it("fails closed when a packaged driver is missing instead of using ambient code", () => {
    const root = temporaryDirectory();
    executable(path.join(root, ".local", "bin"));
    const pathCandidate = executable(path.join(root, "path"));
    const missingBundle = path.join(root, "resources", "cua-driver");
    expect(
      discoverLinuxCuaDriver({
        env: { PATH: path.dirname(pathCandidate) },
        homeDir: root,
        bundledDriverPath: missingBundle,
      }),
    ).toMatchObject({
      status: "unavailable",
      reasonCode: "driver-not-found",
      candidate: missingBundle,
    });
  });

  it("resolves the official user-local symlink to its canonical executable", () => {
    const root = temporaryDirectory();
    const release = executable(path.join(root, ".cua-driver", "packages", "releases", "0.41.3"));
    const localBin = path.join(root, ".local", "bin");
    fs.mkdirSync(localBin, { recursive: true, mode: 0o700 });
    fs.symlinkSync(release, path.join(localBin, "cua-driver"));

    expect(discoverLinuxCuaDriver({ env: { PATH: "" }, homeDir: root })).toMatchObject({
      status: "found",
      path: release,
      source: "user-local",
      fileIdentity: expect.objectContaining({
        dev: expect.any(String),
        ino: expect.any(String),
        mtimeNs: expect.any(String),
        ctimeNs: expect.any(String),
      }),
    });
  });

  it("ignores empty and relative PATH entries and preserves literal metacharacters", () => {
    const root = temporaryDirectory();
    const safeDirectory = path.join(root, "driver $; directory");
    const binary = executable(safeDirectory);
    const value = ["", ".", "relative/bin", safeDirectory, safeDirectory].join(path.delimiter);
    expect(sanitizePath(value)).toBe(safeDirectory);
    expect(discoverLinuxCuaDriver({ env: { PATH: value }, homeDir: path.join(root, "home") })).toMatchObject({
      status: "found",
      path: binary,
      source: "path",
    });
  });

  it.skipIf(process.platform !== "linux")(
    "accepts the official 0775 layout only for a proven user-private primary group",
    () => {
      const root = temporaryDirectory();
      const releaseDirectory = path.join(root, ".cua-driver", "packages", "releases", "0.41.3");
      const release = executable(releaseDirectory);
      const localBin = path.join(root, ".local", "bin");
      fs.mkdirSync(localBin, { recursive: true, mode: 0o775 });
      fs.symlinkSync(release, path.join(localBin, "cua-driver"));
      for (const component of [
        path.join(root, ".local"),
        localBin,
        path.join(root, ".cua-driver"),
        path.join(root, ".cua-driver", "packages"),
        path.join(root, ".cua-driver", "packages", "releases"),
        releaseDirectory,
        release,
      ]) {
        fs.chmodSync(component, 0o775);
      }
      const identity = os.userInfo();
      const lookupPrivateGroup = vi.fn(() => ({
        exclusive: true,
        gid: identity.gid,
        name: identity.username,
      }));

      expect(
        discoverLinuxCuaDriver({
          env: { PATH: "" },
          homeDir: root,
          currentUid: identity.uid,
          currentGid: identity.gid,
          currentUsername: identity.username,
          lookupPrivateGroup,
        }),
      ).toMatchObject({ status: "found", path: release, source: "user-local" });
      expect(lookupPrivateGroup).toHaveBeenCalledTimes(1);
    },
  );

  it.skipIf(process.platform !== "linux")(
    "rejects a group-writable executable when the group is shared or unverifiable",
    () => {
      const root = temporaryDirectory();
      const binary = executable(path.join(root, "bin"));
      fs.chmodSync(binary, 0o720);
      expect(
        validateDriverCandidate(binary, {
          lookupPrivateGroup: () => ({ exclusive: false, reason: "primary-group-shared" }),
        }),
      ).toMatchObject({
        status: "unavailable",
        reasonCode: "unsafe-driver-permissions",
        affectedPaths: [binary],
        permissionReason: "primary-group-shared",
      });
    },
  );

  it.skipIf(process.platform !== "linux")(
    "contains a failed group lookup and keeps the exact affected path",
    () => {
      const root = temporaryDirectory();
      const binary = executable(path.join(root, "bin"));
      fs.chmodSync(binary, 0o720);
      expect(
        validateDriverCandidate(binary, {
          lookupPrivateGroup: () => {
            throw new Error("NSS unavailable");
          },
        }),
      ).toMatchObject({
        status: "unavailable",
        reasonCode: "unsafe-driver-permissions",
        affectedPaths: [binary],
        permissionReason: "lookup-failed",
      });
    },
  );

  it("always rejects world-writable paths and reports the exact component", () => {
    const root = temporaryDirectory();
    const directory = path.join(root, "world-writable");
    const binary = executable(directory);
    fs.chmodSync(directory, 0o707);
    expect(
      validateDriverCandidate(binary, {
        lookupPrivateGroup: () => {
          throw new Error("world-write must not query group membership");
        },
      }),
    ).toMatchObject({
      status: "unavailable",
      reasonCode: "unsafe-driver-permissions",
      affectedPaths: [directory],
    });
  });

  it("does not need group lookup for ordinary 0755 paths", () => {
    const root = temporaryDirectory();
    const binary = executable(path.join(root, "bin"));
    fs.chmodSync(path.dirname(binary), 0o755);
    fs.chmodSync(binary, 0o755);
    const lookupPrivateGroup = vi.fn(() => ({ exclusive: false, reason: "lookup-failed" }));
    expect(validateDriverCandidate(binary, { lookupPrivateGroup })).toMatchObject({
      status: "found",
      path: binary,
    });
    expect(lookupPrivateGroup).not.toHaveBeenCalled();
  });

  it("rejects a non-x64 Linux runtime before executing diagnostics", async () => {
    const run = vi.fn();
    await expect(
      inspectLinuxCuaDriver({
        platform: "linux",
        arch: "arm64",
        env: { DISPLAY: ":0", XDG_SESSION_TYPE: "x11" },
        run,
      }),
    ).resolves.toMatchObject({
      status: "unavailable",
      reasonCode: "unsupported-architecture",
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("captures a strict file identity and detects metadata or content changes", () => {
    const root = temporaryDirectory();
    const binary = executable(path.join(root, "bin"));
    const first = validateDriverCandidate(binary);
    const unchanged = validateDriverCandidate(binary);
    expect(first).toMatchObject({ status: "found", fileIdentity: expect.any(Object) });
    expect(sameDriverFileIdentity(first.fileIdentity, unchanged.fileIdentity)).toBe(true);

    fs.appendFileSync(binary, "# replacement\n");
    const changed = validateDriverCandidate(binary);
    expect(changed.status).toBe("found");
    expect(sameDriverFileIdentity(first.fileIdentity, changed.fileIdentity)).toBe(false);
    expect(sameDriverFileIdentity({}, {})).toBe(false);
  });
});

describe("Linux private primary group proof", () => {
  const identity = { uid: 1000, gid: 1000, username: "kesleydev" };
  const getent = ({ group = "kesleydev:x:1000:", passwd = "kesleydev:x:1000:1000::/home/kesleydev:/bin/bash" } = {}) =>
    vi.fn((args) => ({
      ok: true,
      stdout: args[0] === "group" ? `${group}\n` : `${passwd}\n`,
    }));

  it("accepts an exclusive user-private primary group", () => {
    expect(privatePrimaryGroup(identity, { getent: getent() })).toEqual({
      exclusive: true,
      gid: 1000,
      name: "kesleydev",
    });
  });

  it("rejects explicit supplementary members and another primary-GID account", () => {
    expect(
      privatePrimaryGroup(identity, {
        getent: getent({ group: "kesleydev:x:1000:other" }),
      }),
    ).toMatchObject({ exclusive: false, reason: "primary-group-shared" });
    expect(
      privatePrimaryGroup(identity, {
        getent: getent({
          passwd: [
            "kesleydev:x:1000:1000::/home/kesleydev:/bin/bash",
            "other:x:1001:1000::/home/other:/bin/bash",
          ].join("\n"),
        }),
      }),
    ).toMatchObject({ exclusive: false, reason: "primary-group-shared" });
  });

  it("fails closed when NSS lookup cannot prove membership", () => {
    expect(
      privatePrimaryGroup(identity, {
        getent: vi.fn(() => ({ ok: false, reason: "lookup-timeout" })),
      }),
    ).toEqual({ exclusive: false, reason: "lookup-timeout" });
  });

  it("fails closed on malformed NSS enumeration", () => {
    expect(
      privatePrimaryGroup(identity, {
        getent: getent({
          passwd: [
            "kesleydev:x:1000:1000::/home/kesleydev:/bin/bash",
            "malformed-entry",
          ].join("\n"),
        }),
      }),
    ).toEqual({ exclusive: false, reason: "lookup-malformed" });
  });

  it("uses absolute getent argv without a shell and with bounded resources", () => {
    const spawnCommand = vi.fn(() => ({ status: 0, stdout: "kesleydev:x:1000:\n", stderr: "" }));
    expect(runGetent(["group", "1000"], { spawnCommand })).toEqual({
      ok: true,
      stdout: "kesleydev:x:1000:\n",
    });
    expect(spawnCommand).toHaveBeenCalledWith(
      "/usr/bin/getent",
      ["group", "1000"],
      expect.objectContaining({
        maxBuffer: expect.any(Number),
        shell: false,
        timeout: expect.any(Number),
      }),
    );
  });
});

describe.skipIf(process.platform === "win32")("Linux CUA diagnostics", () => {
  it("passes only the minimal desktop environment and returns a certified contract", async () => {
    const root = temporaryDirectory();
    const binary = executable(path.join(root, "bin"));
    const run = successfulRunner(binary);
    const result = await inspectLinuxCuaDriver({
      platform: "linux",
      arch: "x64",
      homeDir: path.join(root, "home"),
      env: {
        CUA_DRIVER_PATH: binary,
        XDG_SESSION_TYPE: "x11",
        DISPLAY: ":0",
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
        PATH: "/usr/bin",
        HOME: root,
        OPENAI_API_KEY: "must-not-leak",
      },
      run,
    });

    expect(result).toMatchObject({
      status: "ready",
      path: binary,
      fileIdentity: validateDriverCandidate(binary).fileIdentity,
      driverVersion: "0.41.3",
      manifestSchema: "1",
      mcp: { command: binary, args: ["mcp"] },
    });
    expect(result.doctor.warnings).toHaveLength(1);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("fails before discovery or execution on a non-GNOME Wayland compositor", async () => {
    const run = vi.fn();
    const result = await inspectLinuxCuaDriver({
      platform: "linux",
      arch: "x64",
      env: { XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" },
      run,
    });
    expect(result).toMatchObject({
      status: "unavailable",
      reasonCode: "wayland-compositor-unsupported",
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("does not infer a supported local-control session from DISPLAY alone", async () => {
    const run = vi.fn();
    const result = await inspectLinuxCuaDriver({
      platform: "linux",
      arch: "x64",
      env: { DISPLAY: ":0" },
      run,
    });
    expect(result).toMatchObject({
      status: "unavailable",
      reasonCode: "desktop-session-required",
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("certifies GNOME Wayland diagnostics with the native backend explicitly enabled", async () => {
    const root = temporaryDirectory();
    const binary = executable(path.join(root, "bin"));
    const run = successfulRunner(binary, { doctor: healthyWaylandDoctor() });
    const result = await inspectLinuxCuaDriver({
      platform: "linux",
      arch: "x64",
      homeDir: root,
      env: {
        CUA_DRIVER_PATH: binary,
        XDG_SESSION_TYPE: "wayland",
        XDG_CURRENT_DESKTOP: "ubuntu:GNOME",
        WAYLAND_DISPLAY: "wayland-0",
        DISPLAY: ":0",
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
      },
      run,
    });

    expect(result).toMatchObject({
      status: "ready",
      session: "wayland",
      compositor: "gnome-mutter",
      commandEnv: { CUA_DRIVER_RS_ENABLE_WAYLAND: "1" },
    });
    for (const call of run.mock.calls) {
      expect(call[2].env.CUA_DRIVER_RS_ENABLE_WAYLAND).toBe("1");
    }
  });

  it("rejects version and manifest drift", async () => {
    const root = temporaryDirectory();
    const binary = executable(path.join(root, "bin"));
    const run = vi.fn(async (_command, args) => {
      if (args[0] === "--version") return { exitCode: 0, stdout: "cua-driver 0.20.0", stderr: "" };
      throw new Error("should not continue");
    });
    const result = await inspectLinuxCuaDriver({
      platform: "linux",
      arch: "x64",
      homeDir: root,
      env: { CUA_DRIVER_PATH: binary, XDG_SESSION_TYPE: "x11", DISPLAY: ":0" },
      run,
    });
    expect(result).toMatchObject({ status: "unavailable", reasonCode: "unsupported-driver-version" });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("requires healthy X11 and AT-SPI probes", async () => {
    const root = temporaryDirectory();
    const binary = executable(path.join(root, "bin"));
    const run = successfulRunner(binary);
    run.mockImplementationOnce(async () => ({ exitCode: 0, stdout: "cua-driver 0.41.3", stderr: "" }));
    run.mockImplementationOnce(async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        schema_version: "1",
        binary_version: "0.41.3",
        mcp_invocation: { command: binary, args: ["mcp"] },
      }),
      stderr: "",
    }));
    run.mockImplementationOnce(async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        ...healthyDoctor(),
        probes: healthyDoctor().probes.map((probe) =>
          probe.label === "AT-SPI" ? { ...probe, status: "warn" } : probe,
        ),
      }),
      stderr: "",
    }));
    const result = await inspectLinuxCuaDriver({
      platform: "linux",
      arch: "x64",
      homeDir: root,
      env: { CUA_DRIVER_PATH: binary, XDG_SESSION_TYPE: "x11", DISPLAY: ":0" },
      run,
    });
    expect(result).toMatchObject({ status: "unavailable", reasonCode: "at-spi-unavailable" });
  });
});

describe("bounded command execution", () => {
  it("times out and bounds output", async () => {
    await expect(
      runCuaCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 20 }),
    ).rejects.toMatchObject({ code: "command-timeout" });

    await expect(
      runCuaCommand(process.execPath, ["-e", "process.stdout.write('x'.repeat(10000))"], {
        maxOutputBytes: 64,
      }),
    ).rejects.toMatchObject({ code: "output-too-large" });
  });
});

describe.skipIf(process.platform === "win32")("minimal child environment", () => {
  it("keeps desktop session values but drops application secrets", () => {
    expect(
      desktopCommandEnvironment({
        HOME: "/home/test",
        DISPLAY: ":0",
        PATH: ":relative:/usr/bin:/usr/bin",
        OPENAI_API_KEY: "secret",
      }),
    ).toEqual({
      HOME: "/home/test",
      DISPLAY: ":0",
      PATH: "/usr/bin",
      CUA_DRIVER_RS_UPDATE_CHECK: "false",
      CUA_DRIVER_RS_TELEMETRY_ENABLED: "false",
    });
  });
});

const HYPRLAND_ENV = {
  XDG_SESSION_TYPE: "wayland",
  XDG_CURRENT_DESKTOP: "Hyprland",
  HYPRLAND_INSTANCE_SIGNATURE: "6f2a0c1e_1762560000_123456789",
  WAYLAND_DISPLAY: "wayland-1",
  DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
  PATH: "/usr/bin",
};

/** Answers version, manifest and doctor for each fake binary, each reporting its own version. */
function versionedRunner(versions) {
  return vi.fn(async (command, args) => {
    const version = versions.get(command);
    if (!version) throw new Error(`unexpected binary ${command}`);
    if (args[0] === "--version") return { exitCode: 0, stdout: `cua-driver ${version}\n`, stderr: "" };
    if (args[0] === "manifest") {
      return {
        exitCode: 0,
        stdout: JSON.stringify({ schema_version: "1", binary_version: version, mcp_invocation: { command, args: ["mcp"] } }),
        stderr: "",
      };
    }
    return { exitCode: 0, stdout: JSON.stringify(healthyWaylandDoctor()), stderr: "" };
  });
}

describe.skipIf(process.platform === "win32")("Omarchy (Hyprland) local control", () => {
  const {
    compatibleSystemDriverVersion,
    discoverSystemPackageDriver,
  } = require("./cua-linux.cjs");

  function omarchy({ systemVersion = "0.41.3", packageVersion = `${systemVersion}-1`, system = "found", plugin = "active" } = {}) {
    const root = temporaryDirectory();
    const bundled = executable(path.join(root, "resources"));
    const systemBinary = executable(path.join(root, "usr-bin"));
    const run = versionedRunner(new Map([[bundled, "0.41.3"], [systemBinary, systemVersion]]));
    const discoverSystemDriver = vi.fn(async () =>
      system === "found"
        ? { ...validateDriverCandidate(systemBinary), source: "system-package", packageVersion }
        : { status: "unavailable", reasonCode: system });
    const probePlugin = vi.fn(async () => plugin);
    const inspect = (env = HYPRLAND_ENV) =>
      inspectLinuxCuaDriver({ platform: "linux", arch: "x64", homeDir: root, env, bundledDriverPath: bundled, run, probePlugin, discoverSystemDriver });
    return { bundled, systemBinary, run, discoverSystemDriver, probePlugin, inspect };
  }

  it("prefers Omarchy's package-owned driver while the plugin is active", async () => {
    const context = omarchy({ systemVersion: "0.41.5" });
    const result = await context.inspect();
    expect(result).toMatchObject({
      status: "ready",
      source: "system-package",
      path: context.systemBinary,
      driverVersion: "0.41.5",
      packageVersion: "0.41.5-1",
      session: "wayland",
      compositor: "hyprland",
      commandEnv: { CUA_DRIVER_RS_ENABLE_WAYLAND: "1", HYPRLAND_INSTANCE_SIGNATURE: HYPRLAND_ENV.HYPRLAND_INSTANCE_SIGNATURE },
    });
    expect(context.run.mock.calls.every(([command]) => command === context.systemBinary)).toBe(true);
  });

  it("gives plain plugin guidance and runs nothing when the plugin is off", async () => {
    const context = omarchy({ plugin: "inactive" });
    await expect(context.inspect()).resolves.toMatchObject({
      status: "unavailable",
      reasonCode: "linux-hyprland-plugin-required",
      compositor: "hyprland",
      message: expect.stringContaining("cua-hyprland-plugin"),
    });
    expect(context.run).not.toHaveBeenCalled();
    expect(context.discoverSystemDriver).not.toHaveBeenCalled();
  });

  it.each([
    ["no package-owned driver", { system: "system-driver-unowned" }],
    ["a driver from another minor line", { systemVersion: "0.42.0" }],
    ["a driver older than the bundled patch release", { systemVersion: "0.41.2" }],
    ["a binary that is not the version pacman installed", { systemVersion: "0.41.5", packageVersion: "0.41.4-1" }],
  ])("falls back to the bundled driver with the native backend on for %s", async (_label, options) => {
    const context = omarchy(options);
    const result = await context.inspect();
    expect(result).toMatchObject({ status: "ready", source: "bundled", path: context.bundled, driverVersion: "0.41.3", compositor: "hyprland" });
    expect(result.commandEnv.CUA_DRIVER_RS_ENABLE_WAYLAND).toBe("1");
  });

  it("keeps an explicit CUA_DRIVER_PATH ahead of the system driver", async () => {
    const context = omarchy();
    const explicit = context.bundled;
    const result = await context.inspect({ ...HYPRLAND_ENV, CUA_DRIVER_PATH: explicit });
    expect(result).toMatchObject({ status: "ready", source: "environment" });
    expect(context.discoverSystemDriver).not.toHaveBeenCalled();
  });

  it("never applies the system-driver exception outside Hyprland", async () => {
    const context = omarchy();
    const gnome = { ...HYPRLAND_ENV, XDG_CURRENT_DESKTOP: "ubuntu:GNOME", HYPRLAND_INSTANCE_SIGNATURE: "" };
    await expect(context.inspect(gnome)).resolves.toMatchObject({ status: "ready", source: "bundled", compositor: "gnome-mutter" });
    expect(context.discoverSystemDriver).not.toHaveBeenCalled();
    expect(context.probePlugin).not.toHaveBeenCalled();
    const sway = { ...HYPRLAND_ENV, XDG_CURRENT_DESKTOP: "sway", HYPRLAND_INSTANCE_SIGNATURE: "" };
    await expect(context.inspect(sway)).resolves.toMatchObject({ status: "unavailable", reasonCode: "wayland-compositor-unsupported" });
  });

  it("accepts only the bundled minor line at or above the bundled patch release", () => {
    expect(compatibleSystemDriverVersion("0.41.3")).toBe(true);
    expect(compatibleSystemDriverVersion("0.41.12")).toBe(true);
    for (const version of ["0.41.2", "0.42.0", "1.41.3", "0.41", "0.41.3-rc1", "", undefined]) {
      expect(compatibleSystemDriverVersion(version), String(version)).toBe(false);
    }
  });

  describe("the package-owned driver trust exception", () => {
    const found = (file) => ({ status: "found", path: file, fileIdentity: {} });

    it("trusts /usr/bin/cua-driver only when root owns it and pacman says cua-driver-bin installed it", async () => {
      const packageVersion = vi.fn(async () => "0.41.3-1");
      await expect(discoverSystemPackageDriver({ statFile: () => ({ uid: 0 }), validate: found, packageVersion })).resolves.toMatchObject({
        status: "found",
        path: "/usr/bin/cua-driver",
        source: "system-package",
        packageVersion: "0.41.3-1",
      });
      expect(packageVersion).toHaveBeenCalledWith("/usr/bin/cua-driver");
    });

    it("refuses a missing file, a non-root owner, a failed path check, or a file pacman does not attribute to the package", async () => {
      const packageVersion = async () => "0.41.3-1";
      await expect(discoverSystemPackageDriver({ statFile: () => { throw new Error("ENOENT"); }, validate: found, packageVersion }))
        .resolves.toMatchObject({ reasonCode: "system-driver-missing" });
      await expect(discoverSystemPackageDriver({ statFile: () => ({ uid: 1000 }), validate: found, packageVersion }))
        .resolves.toMatchObject({ reasonCode: "system-driver-untrusted" });
      await expect(discoverSystemPackageDriver({ statFile: () => ({ uid: 0 }), validate: () => ({ status: "unavailable" }), packageVersion }))
        .resolves.toMatchObject({ reasonCode: "system-driver-untrusted" });
      await expect(discoverSystemPackageDriver({ statFile: () => ({ uid: 0 }), validate: found, packageVersion: async () => null }))
        .resolves.toMatchObject({ reasonCode: "system-driver-unowned" });
    });

    it("follows a packaged symlink only into a file the same package owns", async () => {
      const target = "/opt/cua-driver/cua-driver";
      const owners = new Map([["/usr/bin/cua-driver", "0.41.3-1"], [target, "0.41.3-1"]]);
      const packageVersion = async (file) => owners.get(file) ?? null;
      await expect(discoverSystemPackageDriver({ statFile: () => ({ uid: 0 }), validate: () => found(target), packageVersion }))
        .resolves.toMatchObject({ status: "found", path: target });
      owners.delete(target);
      await expect(discoverSystemPackageDriver({ statFile: () => ({ uid: 0 }), validate: () => found(target), packageVersion }))
        .resolves.toMatchObject({ reasonCode: "system-driver-unowned" });
    });
  });
});
