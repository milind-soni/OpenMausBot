import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { createCuaConnectionStore } = require("./cua-connection.cjs");
const { validateDriverCandidate } = require("./cua-linux.cjs");
const {
  cleanupStaleRuntimeDirectories,
  createLinuxCuaPreferenceStore,
  createLinuxCuaRuntime,
  createUnavailableLinuxRuntime,
  probePrivateDaemon,
  validateDaemonMetadata,
  validateToolSurface,
  validateWaylandHealthReport,
  writePrivateJson,
} = require("./cua-linux-runtime.cjs");

const temporaryDirectories = [];

function temporaryDirectory() {
  const base = process.platform === "win32" ? os.tmpdir() : fs.realpathSync("/tmp");
  const directory = fs.mkdtempSync(path.join(base, "omb-cua-runtime-"));
  temporaryDirectories.push(directory);
  return directory;
}

function executable(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const binary = path.join(directory, "cua-driver");
  fs.writeFileSync(binary, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  return binary;
}

function fakeChild(pid = 4321) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.stderr = new EventEmitter();
  child.stdin = {
    end: vi.fn(() => {
      if (child.exitCode !== null) return;
      child.exitCode = 0;
      queueMicrotask(() => child.emit("exit", 0, null));
    }),
  };
  child.kill = vi.fn((signal) => {
    if (child.exitCode !== null) return true;
    child.exitCode = signal === "SIGKILL" ? 137 : 0;
    queueMicrotask(() => child.emit("exit", child.exitCode, signal));
    return true;
  });
  child.crash = () => {
    child.exitCode = 1;
    child.emit("exit", 1, null);
  };
  return child;
}

function handshake(pid = 4321) {
  return {
    metadata: {
      driver_version: "0.19.3",
      contract_version: "0.6.0",
      tools_list_schema_version: "1",
      capability_version: "1",
      mcp_protocol_version: "2025-06-18",
      pid,
      embedded: true,
      host_bundle_id: "com.openmausbot.app",
    },
    tools: ["click", "get_window_state", "list_apps", "type_text"],
  };
}

function healthyWaylandHealth() {
  return {
    ok: true,
    result: {
      structuredContent: {
        schema_version: "1",
        platform: "linux",
        driver_version: "0.19.3",
        overall: "ok",
        checks: [
          { name: "binary_version", status: "pass", message: "cua-driver 0.19.3" },
          { name: "platform_supported", status: "pass", message: "Ubuntu 24.04" },
          { name: "session_active", status: "pass", message: "MCP session is active." },
          { name: "ax_capability", status: "pass", message: "AT-SPI is reachable." },
          {
            name: "screen_capture_capability",
            status: "pass",
            message: "Screenshot portal is reachable.",
          },
          {
            name: "wayland_backend",
            status: "pass",
            message: "Portal/libei and verified target activation are reachable.",
          },
        ],
      },
    },
  };
}

function harness({
  preferenceEnabled = false,
  afterIdentityCaptured,
  session = "x11",
  runtimeOptions = {},
} = {}) {
  const userData = temporaryDirectory();
  const runtimeRoot = path.join(userData, "session");
  fs.mkdirSync(runtimeRoot, { mode: 0o700 });
  const binary = executable(path.join(userData, "driver"));
  const connectionStore = createCuaConnectionStore({ getUserData: () => userData });
  const preferenceStore = createLinuxCuaPreferenceStore({ getUserData: () => userData });
  if (preferenceEnabled) preferenceStore.write(true);
  const child = fakeChild();
  const fileIdentity = validateDriverCandidate(binary).fileIdentity;
  const inspect = vi.fn(async () => {
    afterIdentityCaptured?.(binary);
    return {
      status: "ready",
      path: binary,
      fileIdentity,
      source: "environment",
      driverVersion: "0.19.3",
      manifestSchema: "1",
      mcp: { command: binary, args: ["mcp"] },
      doctor: { ok: true, probes: [], warnings: [] },
      session,
      ...(session === "wayland" ? { compositor: "gnome-mutter" } : {}),
    };
  });
  const spawnProcess = vi.fn(() => child);
  const probe = vi.fn(async () => handshake(child.pid));
  const changes = [];
  const runtime = createLinuxCuaRuntime({
    getUserData: () => userData,
    connectionStore,
    preferenceStore,
    platform: "linux",
    env: {
      HOME: userData,
      PATH: "/usr/bin",
      DISPLAY: ":0",
      XDG_SESSION_TYPE: session,
      ...(session === "wayland"
        ? {
            WAYLAND_DISPLAY: "wayland-0",
            XDG_CURRENT_DESKTOP: "ubuntu:GNOME",
            DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
          }
        : {}),
      XDG_RUNTIME_DIR: runtimeRoot,
      OPENAI_API_KEY: "must-not-leak",
    },
    inspect,
    spawnProcess,
    probe,
    healthCheckIntervalMs: 0,
    identifier: () => "01234567-89ab-cdef-0123-456789abcdef",
    processId: 1234,
    onChange: (connection) => changes.push(connection),
    ...runtimeOptions,
  });
  return {
    binary,
    changes,
    child,
    connectionStore,
    inspect,
    preferenceStore,
    probe,
    runtime,
    spawnProcess,
    userData,
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("unavailable Linux CUA runtime", () => {
  it("fails closed without rejecting any IPC-facing operation", async () => {
    const persisted = [];
    const changed = [];
    const runtime = createUnavailableLinuxRuntime({
      connectionStore: { persist: (connection) => persisted.push(connection) },
      onChange: (connection) => changed.push(connection),
      processId: 1234,
    });

    for (const operation of ["initialize", "enable", "retry", "disable", "shutdown"]) {
      await expect(runtime[operation]()).resolves.toMatchObject({
        mode: "unavailable",
        status: "unavailable",
        reasonCode: "bundled-driver-invalid",
      });
    }
    expect(runtime.getStatus()).toEqual({
      enabled: false,
      status: "unavailable",
      reasonCode: "bundled-driver-invalid",
      message: "The bundled Cua Driver failed integrity validation.",
      driverPath: undefined,
      driverVersion: undefined,
      driverSource: undefined,
      session: undefined,
      compositor: undefined,
      warnings: [],
    });
    expect(persisted).toHaveLength(1);
    expect(changed).toHaveLength(1);
  });

  it("still returns a typed status if persisting the failure is unavailable", () => {
    const runtime = createUnavailableLinuxRuntime({
      connectionStore: {
        persist() {
          throw new Error("read-only user data");
        },
      },
    });
    expect(runtime.getStatus()).toMatchObject({
      enabled: false,
      status: "unavailable",
      reasonCode: "bundled-driver-invalid",
    });
  });
});

// Windows does not provide the POSIX executable and Unix-socket semantics this
// lifecycle contract exercises. Canonical short temp paths keep it portable
// across Linux and macOS.
describe.skipIf(process.platform === "win32")("Linux CUA opt-in and lifecycle", () => {
  it("cleans only known private runtime files from a dead owner", () => {
    const root = temporaryDirectory();
    const stale = path.join(root, "99999999-01234567-89a");
    const suspicious = path.join(root, "99999998-01234567-89a");
    fs.mkdirSync(stale, { mode: 0o700 });
    fs.writeFileSync(path.join(stale, "driver.pid"), "99999999\n", { mode: 0o600 });
    fs.mkdirSync(suspicious, { mode: 0o700 });
    fs.writeFileSync(path.join(suspicious, "unexpected"), "preserve", { mode: 0o600 });

    expect(
      cleanupStaleRuntimeDirectories(root, { isProcessAlive: () => false }),
    ).toBe(1);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.readFileSync(path.join(suspicious, "unexpected"), "utf8")).toBe("preserve");
  });

  it("preserves a certified runtime directory while its owner is alive", () => {
    const root = temporaryDirectory();
    const live = path.join(root, "1234-01234567-89a");
    fs.mkdirSync(live, { mode: 0o700 });
    fs.writeFileSync(path.join(live, "driver.pid"), "1234\n", { mode: 0o600 });

    expect(cleanupStaleRuntimeDirectories(root, { isProcessAlive: () => true })).toBe(0);
    expect(fs.existsSync(path.join(live, "driver.pid"))).toBe(true);
  });

  it("does not inspect or execute a driver before explicit opt-in", async () => {
    const context = harness();
    await context.runtime.initialize();
    expect(context.inspect).not.toHaveBeenCalled();
    expect(context.spawnProcess).not.toHaveBeenCalled();
    expect(context.runtime.getStatus()).toMatchObject({
      enabled: false,
      status: "disabled",
      reasonCode: "opt-in-required",
    });
  });

  it("passes the exact packaged candidate and architecture into inspection", async () => {
    const bundledDriverPath = "/opt/OpenMausBot/resources/cua-linux-x64/cua-driver";
    const context = harness({
      runtimeOptions: { bundledDriverPath, arch: "x64" },
    });
    await context.runtime.enable();
    expect(context.inspect).toHaveBeenCalledWith(
      expect.objectContaining({
        platform: "linux",
        arch: "x64",
        bundledDriverPath,
      }),
    );
  });

  it("publishes a retryable error when driver inspection throws", async () => {
    const inspectError = Object.assign(new Error("probe failed"), {
      code: "driver-inspection-failed",
    });
    const context = harness({
      runtimeOptions: { inspect: vi.fn(async () => Promise.reject(inspectError)) },
    });

    await expect(context.runtime.enable()).resolves.toMatchObject({
      status: "error",
      reasonCode: "driver-inspection-failed",
    });
    expect(context.runtime.getStatus()).toMatchObject({
      status: "error",
      reasonCode: "driver-inspection-failed",
    });
    expect(context.spawnProcess).not.toHaveBeenCalled();
  });

  it("coalesces starts, verifies a private daemon, and publishes a strict ready descriptor", async () => {
    const context = harness();
    const [first, second] = await Promise.all([context.runtime.enable(), context.runtime.enable()]);
    expect(first).toEqual(second);
    expect(context.inspect).toHaveBeenCalledTimes(1);
    expect(context.spawnProcess).toHaveBeenCalledTimes(1);
    expect(context.spawnProcess).toHaveBeenCalledWith(
      context.binary,
      expect.arrayContaining(["serve", "--embedded", "--socket", "--permission-mode", "standard"]),
      expect.objectContaining({ shell: false, stdio: ["pipe", "ignore", "pipe"] }),
    );
    const spawnOptions = context.spawnProcess.mock.calls[0][2];
    expect(spawnOptions.env).toMatchObject({
      CUA_DRIVER_EMBEDDED: "1",
      CUA_DRIVER_PARENT_LIVENESS_STDIN: "1",
      CUA_DRIVER_HOST_BUNDLE_ID: "com.openmausbot.app",
      CUA_DRIVER_RS_UPDATE_CHECK: "false",
      CUA_DRIVER_RS_TELEMETRY_ENABLED: "false",
    });
    expect(spawnOptions.env.OPENAI_API_KEY).toBeUndefined();
    expect(context.probe).toHaveBeenCalledWith(expect.stringMatching(/driver\.sock$/), {
      childPid: context.child.pid,
      session: "x11",
    });
    expect(context.runtime.getConnection()).toMatchObject({
      schemaVersion: 1,
      mode: "linux-x11-supervised",
      platform: "linux",
      session: "x11",
      enabled: true,
      status: "ready",
      ownerPid: 1234,
      generation: "01234567-89ab-cdef-0123-456789abcdef",
      driver: {
        path: context.binary,
        version: "0.19.3",
        source: "environment",
        manifestSchema: "1",
        fileIdentity: validateDriverCandidate(context.binary).fileIdentity,
      },
      daemon: { pid: 4321, contractVersion: "0.6.0" },
      mcp: {
        command: context.binary,
        args: ["mcp", "--embedded", "--socket", expect.stringMatching(/driver\.sock$/)],
        env: {
          CUA_DRIVER_EMBEDDED: "1",
          CUA_DRIVER_HOST_BUNDLE_ID: "com.openmausbot.app",
          CUA_DRIVER_RS_UPDATE_CHECK: "false",
          CUA_DRIVER_RS_TELEMETRY_ENABLED: "false",
        },
      },
    });
    const descriptor = path.join(context.userData, "cua-connection.json");
    expect(fs.statSync(descriptor).mode & 0o777).toBe(0o600);
    expect(fs.statSync(context.userData).mode & 0o777).toBe(0o700);
    expect(JSON.parse(fs.readFileSync(descriptor, "utf8"))).toMatchObject({
      driver: { fileIdentity: validateDriverCandidate(context.binary).fileIdentity },
    });
    expect(context.runtime.getStatus()).not.toHaveProperty("fileIdentity");
    expect(context.runtime.getStatus()).not.toHaveProperty("driver.fileIdentity");
  });

  it("refuses to spawn when the inspected executable identity changes", async () => {
    const context = harness({
      afterIdentityCaptured(binary) {
        fs.appendFileSync(binary, "# changed after inspection\n");
      },
    });
    await context.runtime.enable();
    expect(context.spawnProcess).not.toHaveBeenCalled();
    expect(context.probe).not.toHaveBeenCalled();
    expect(context.runtime.getConnection()).toMatchObject({
      mode: "unavailable",
      status: "error",
      reasonCode: "driver-changed",
    });
    expect(fs.readFileSync(path.join(context.userData, "cua-connection.json"), "utf8")).not.toContain(
      "fileIdentity",
    );
  });

  it("invalidates readiness immediately when the owned daemon exits", async () => {
    const context = harness();
    await context.runtime.enable();
    context.child.crash();
    expect(context.runtime.getConnection()).toMatchObject({
      mode: "unavailable",
      status: "error",
      reasonCode: "daemon-exited",
      generation: "01234567-89ab-cdef-0123-456789abcdef",
    });
    expect(
      JSON.parse(fs.readFileSync(path.join(context.userData, "cua-connection.json"), "utf8")),
    ).toMatchObject({ mode: "unavailable", reasonCode: "daemon-exited" });
  });

  it("closes the parent-liveness pipe on shutdown without clearing durable opt-in", async () => {
    const context = harness();
    await context.runtime.enable();
    await context.runtime.shutdown();
    expect(context.child.stdin.end).toHaveBeenCalledOnce();
    expect(context.child.kill).not.toHaveBeenCalled();
    expect(context.preferenceStore.read()).toBe(true);
    expect(context.runtime.getConnection()).toMatchObject({
      mode: "unavailable",
      status: "stopped",
      reasonCode: "app-stopped",
    });
  });

  it("does not wait again for a child that was already reaped by a signal", async () => {
    const context = harness();
    await context.runtime.enable();
    context.child.signalCode = "SIGTERM";
    context.child.stdin.end = vi.fn();
    vi.useFakeTimers();
    try {
      const shutdown = context.runtime.shutdown();
      await vi.advanceTimersByTimeAsync(0);
      await expect(shutdown).resolves.toMatchObject({
        status: "stopped",
        reasonCode: "app-stopped",
      });
      expect(context.child.kill).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("serializes an in-flight start before retrying with a fresh runtime", async () => {
    let releaseFirstProbe;
    const firstProbeGate = new Promise((resolve) => {
      releaseFirstProbe = resolve;
    });
    const firstChild = fakeChild(4321);
    const children = [firstChild, fakeChild(4322)];
    const spawnProcess = vi.fn(() => children.shift());
    const probe = vi
      .fn()
      .mockImplementationOnce(async () => {
        await firstProbeGate;
        return handshake(4321);
      })
      .mockResolvedValueOnce(handshake(4322));
    const context = harness({ runtimeOptions: { spawnProcess, probe } });

    const firstStart = context.runtime.enable();
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1));
    const retry = context.runtime.retry();
    releaseFirstProbe();

    await expect(firstStart).resolves.toMatchObject({ status: "ready" });
    await expect(retry).resolves.toMatchObject({ status: "ready", daemon: { pid: 4322 } });
    expect(spawnProcess).toHaveBeenCalledTimes(2);
    expect(firstChild.exitCode !== null || firstChild.signalCode !== null).toBe(true);
  });

  it("starts on launch only after a durable prior opt-in and supports explicit disable", async () => {
    const context = harness({ preferenceEnabled: true });
    await context.runtime.initialize();
    expect(context.runtime.getConnection().mode).toBe("linux-x11-supervised");
    await context.runtime.disable();
    expect(context.preferenceStore.read()).toBe(false);
    expect(context.runtime.getStatus()).toMatchObject({ enabled: false, status: "disabled" });
  });

  it("publishes the distinct GNOME Wayland contract and propagates the opt-in environment", async () => {
    const context = harness({ session: "wayland" });
    await context.runtime.enable();
    expect(context.probe).toHaveBeenCalledWith(expect.stringMatching(/driver\.sock$/), {
      childPid: context.child.pid,
      session: "wayland",
    });
    expect(context.spawnProcess.mock.calls[0][2].env.CUA_DRIVER_RS_ENABLE_WAYLAND).toBe("1");
    expect(context.runtime.getConnection()).toMatchObject({
      mode: "linux-wayland-gnome-supervised",
      session: "wayland",
      compositor: "gnome-mutter",
      mcp: {
        env: {
          CUA_DRIVER_RS_ENABLE_WAYLAND: "1",
          CUA_DRIVER_RS_TELEMETRY_ENABLED: "false",
          CUA_DRIVER_RS_UPDATE_CHECK: "false",
        },
      },
    });
  });

  it("revokes Wayland readiness when a prompt-free health recheck fails", async () => {
    let healthTick = null;
    const timer = { unref: vi.fn() };
    const clearRecurring = vi.fn();
    const context = harness({
      session: "wayland",
      runtimeOptions: {
        healthCheckIntervalMs: 30_000,
        healthProbe: vi.fn(async () => {
          throw Object.assign(new Error("The Cua WinRects helper is no longer active."), {
            code: "wayland-helper-required",
          });
        }),
        setRecurring: vi.fn((callback) => {
          healthTick = callback;
          return timer;
        }),
        clearRecurring,
      },
    });
    await context.runtime.enable();
    expect(context.runtime.getConnection().status).toBe("ready");
    healthTick();
    await vi.waitFor(() => {
      expect(context.runtime.getConnection()).toMatchObject({
        mode: "unavailable",
        status: "error",
        reasonCode: "wayland-helper-required",
      });
    });
    expect(clearRecurring).toHaveBeenCalledWith(timer);
    expect(context.child.stdin.end).toHaveBeenCalledOnce();
  });
});

// POSIX modes and symlink guarantees are available on Linux and macOS.
describe.skipIf(process.platform === "win32")("Linux CUA private data", () => {
  it("uses strict preference schema and private atomic files", () => {
    const userData = temporaryDirectory();
    const store = createLinuxCuaPreferenceStore({ getUserData: () => userData });
    store.write(true);
    const file = path.join(userData, "cua-local-control.json");
    expect(store.read()).toBe(true);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, linuxLocalControlEnabled: true, extra: true }), {
      mode: 0o600,
    });
    expect(store.read()).toBe(false);
  });

  it("does not follow a symlink when creating private state", () => {
    const root = temporaryDirectory();
    const target = path.join(root, "target.json");
    const link = path.join(root, "state.json");
    fs.writeFileSync(target, "untouched", { mode: 0o600 });
    fs.symlinkSync(target, link);
    writePrivateJson(link, { ok: true });
    expect(fs.readFileSync(target, "utf8")).toBe("untouched");
    expect(JSON.parse(fs.readFileSync(link, "utf8"))).toEqual({ ok: true });
  });
});

describe("Linux CUA handshake validation", () => {
  it("pins metadata to the certified child and contract", () => {
    const valid = { ok: true, result: handshake(99).metadata };
    expect(validateDaemonMetadata(valid, { childPid: 99 })).toEqual(valid.result);
    expect(() => validateDaemonMetadata(valid, { childPid: 100 })).toThrow(/PID/);
    expect(() =>
      validateDaemonMetadata({ ok: true, result: { ...valid.result, contract_version: "9" } }),
    ).toThrow(/contract_version/);
  });

  it("requires the inspect and mutation tool surface", () => {
    const tools = handshake().tools.map((name) => ({ name }));
    const manifest = { schema_version: "1", capability_version: "1", tools };
    expect(validateToolSurface({ ok: true, result: manifest })).toEqual([...handshake().tools].sort());
    expect(() =>
      validateToolSurface({
        ok: true,
        result: {
          ...manifest,
          tools: tools.filter((tool) => tool.name !== "type_text"),
        },
      }),
    ).toThrow(/type_text/);
    expect(() =>
      validateToolSurface({ ok: true, result: { ...manifest, capability_version: "2" } }),
    ).toThrow(/could not be verified/);
  });

  it("accepts only a healthy certified Wayland report", () => {
    expect(validateWaylandHealthReport(healthyWaylandHealth())).toEqual({
      schemaVersion: "1",
      overall: "ok",
      requiredChecks: ["ax_capability", "screen_capture_capability", "wayland_backend"],
    });
    const unhealthy = healthyWaylandHealth();
    const check = unhealthy.result.structuredContent.checks.find(
      (entry) => entry.name === "wayland_backend",
    );
    check.status = "fail";
    check.message = "The compositor has no verified target-activation adapter.";
    check.hint = "Install and enable the bundled WinRects Shell helper.";
    unhealthy.result.structuredContent.overall = "degraded";
    expect(() => validateWaylandHealthReport(unhealthy)).toThrowError(
      expect.objectContaining({ code: "wayland-helper-required" }),
    );
    expect(() =>
      validateWaylandHealthReport({
        ...healthyWaylandHealth(),
        result: {
          structuredContent: {
            ...healthyWaylandHealth().result.structuredContent,
            schema_version: "2",
          },
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid-health-report" }));
  });

  it("calls health_report during the private daemon handshake only on Wayland", async () => {
    const calls = [];
    const request = vi.fn(async (_socket, payload) => {
      calls.push(payload);
      if (payload.method === "metadata") return { ok: true, result: handshake(99).metadata };
      if (payload.method === "list") {
        return {
          ok: true,
          result: {
            schema_version: "1",
            capability_version: "1",
            tools: handshake().tools.map((name) => ({ name })),
          },
        };
      }
      return healthyWaylandHealth();
    });

    await expect(
      probePrivateDaemon("/tmp/cua.sock", {
        childPid: 99,
        session: "wayland",
        request,
        timeoutMs: 100,
      }),
    ).resolves.toMatchObject({ health: { overall: "ok" } });
    expect(calls.at(-1)).toEqual({ method: "call", name: "health_report", args: {} });
  });
});
