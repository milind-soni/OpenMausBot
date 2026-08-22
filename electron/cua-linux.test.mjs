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
      { label: "binary", status: "ok", message: "cua-driver 0.19.3" },
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
      { label: "binary", status: "ok", message: "cua-driver 0.19.3" },
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
    if (args[0] === "--version") return { exitCode: 0, stdout: "cua-driver 0.19.3\n", stderr: "" };
    if (args[0] === "manifest") {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          schema_version: "1",
          binary_version: "0.19.3",
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

// Windows does not expose the POSIX executable and ownership semantics used by
// discovery. Canonical temp paths make the same contract useful on macOS.
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
    const release = executable(path.join(root, ".cua-driver", "packages", "releases", "0.19.3"));
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
      const releaseDirectory = path.join(root, ".cua-driver", "packages", "releases", "0.19.3");
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
      driverVersion: "0.19.3",
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
    run.mockImplementationOnce(async () => ({ exitCode: 0, stdout: "cua-driver 0.19.3", stderr: "" }));
    run.mockImplementationOnce(async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        schema_version: "1",
        binary_version: "0.19.3",
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
