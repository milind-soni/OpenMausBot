import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupStaleManagedCompanionTokens,
  createManagedCompanionTunnel,
  MANAGED_COMPANION_ORIGIN_VERSION,
  MANAGED_COMPANION_ORIGIN_VERSION_FIELD,
  managedCompanionTunnelAccess,
  normalizeManagedCompanionEndpoint,
  resolveCloudflaredBinary,
  withManagedCompanionTunnelAccess,
  withoutManagedCompanionTunnelAccess,
} from "./managed-companion-tunnel.mjs";

const TOKEN = `eyJ${"a".repeat(120)}=`;
const ENDPOINT = "https://c-installation.openmausbot.com";
const BINARY = "/trusted/cloudflared";
const GUARDIAN = "/trusted/managed-companion-guardian.mjs";
const RUNTIME = "/trusted/electron";
const ORIGIN_TARGET =
  process.platform === "win32"
    ? {
        pid: 31337,
        socketPath:
          "\\\\.\\pipe\\openmausbot-companion-origin-31337-12345678-1234-1234-1234-123456789abc",
      }
    : { pid: 31337, socketPath: "/tmp/omb-companion-origin-test/origin.sock" };
const temporaryDirectories = [];

function temporaryDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "omb-managed-tunnel-"));
  temporaryDirectories.push(directory);
  return directory;
}

function fakeChild(pid = 4242) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.stdin = {
    end: vi.fn(() => {
      queueMicrotask(() => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.exitCode = 0;
        child.emit("exit", 0, null);
      });
    }),
  };
  child.kill = vi.fn((signal) => {
    if (child.exitCode !== null || child.signalCode !== null) return true;
    child.signalCode = signal;
    queueMicrotask(() => child.emit("exit", null, signal));
    return true;
  });
  child.crash = () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.exitCode = 1;
    child.emit("exit", 1, null);
  };
  return child;
}

function healthyResponse() {
  return {
    ok: true,
    text: async () => JSON.stringify({ app: "openmausbot" }),
  };
}

afterEach(() => {
  vi.useRealTimers();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("managed companion credentials", () => {
  it("accepts only complete HTTPS-origin credentials", () => {
    expect(normalizeManagedCompanionEndpoint(" https://C-Test.Example/ ")).toBe(
      "https://c-test.example",
    );
    for (const value of [
      "http://c-test.example",
      "https://user:secret@c-test.example",
      "https://c-test.example/path",
      "https://c-test.example?query=yes",
    ]) {
      expect(normalizeManagedCompanionEndpoint(value)).toBe("");
    }

    expect(
      managedCompanionTunnelAccess({
        managedCompanionEndpointUrl: ENDPOINT,
        managedCompanionConnectorToken: TOKEN,
        [MANAGED_COMPANION_ORIGIN_VERSION_FIELD]: MANAGED_COMPANION_ORIGIN_VERSION,
      }),
    ).toEqual({ endpoint: ENDPOINT, token: TOKEN });
    expect(
      managedCompanionTunnelAccess({
        managedCompanionEndpointUrl: ENDPOINT,
        managedCompanionConnectorToken: "short",
        [MANAGED_COMPANION_ORIGIN_VERSION_FIELD]: MANAGED_COMPANION_ORIGIN_VERSION,
      }),
    ).toBeNull();
    expect(
      managedCompanionTunnelAccess({
        managedCompanionEndpointUrl: ENDPOINT,
        managedCompanionConnectorToken: TOKEN,
      }),
    ).toBeNull();
  });

  it("copies a valid provision response into and out of the encrypted credential shape", () => {
    const credentials = { composioApiKey: "keep-me" };
    const provisioned = withManagedCompanionTunnelAccess(credentials, {
      endpoint: { url: `${ENDPOINT}/` },
      connectorToken: TOKEN,
    });
    expect(provisioned).toEqual({
      composioApiKey: "keep-me",
      managedCompanionEndpointUrl: ENDPOINT,
      managedCompanionConnectorToken: TOKEN,
      [MANAGED_COMPANION_ORIGIN_VERSION_FIELD]: MANAGED_COMPANION_ORIGIN_VERSION,
    });
    expect(withoutManagedCompanionTunnelAccess(provisioned)).toEqual(credentials);
    expect(() =>
      withManagedCompanionTunnelAccess(credentials, {
        endpoint: { url: "http://insecure.example" },
        connectorToken: TOKEN,
      }),
    ).toThrow(/invalid managed endpoint/);
  });
});

describe("cloudflared binary resolution", () => {
  it.each(["x64", "arm64"])("resolves the staged Linux %s connector for self-hosting", (arch) => {
    const appPath = temporaryDirectory();
    const staged = path.join(appPath, "dist-native", "cloudflared", `linux-${arch}`, "cloudflared");
    expect(
      resolveCloudflaredBinary({
        isPackaged: false,
        appPath,
        platform: "linux",
        arch,
        environment: {},
        exists: (candidate) => candidate === staged,
      }),
    ).toBe(staged);
  });

  it("requires the bundled Resources binary in production", () => {
    const resourcesPath = path.join(
      path.parse(process.cwd()).root,
      "Applications",
      "OpenMausBot",
      "Contents",
      "Resources",
    );
    const bundledBinary = path.join(resourcesPath, "cloudflared", "cloudflared");
    expect(
      resolveCloudflaredBinary({
        isPackaged: true,
        resourcesPath,
        platform: "darwin",
        exists: (candidate) => candidate === bundledBinary,
      }),
    ).toBe(bundledBinary);
    expect(
      resolveCloudflaredBinary({
        isPackaged: true,
        resourcesPath,
        platform: "darwin",
        exists: () => false,
      }),
    ).toBeNull();
  });

  it("rejects a relative development override instead of searching it on PATH", () => {
    expect(
      resolveCloudflaredBinary({
        isPackaged: false,
        resourcesPath: "/resources",
        appPath: "/checkout",
        platform: "linux",
        arch: "x64",
        environment: { OMB_CLOUDFLARED_PATH: "./untrusted-cloudflared" },
        exists: () => true,
      }),
    ).toBeNull();
  });
});

describe("managed connector lifecycle", () => {
  it("uses a private token file, sanitized environment, and advertises only after verification", async () => {
    const runtimeRoot = path.join(temporaryDirectory(), "runtime");
    const child = fakeChild();
    let capturedToken;
    let capturedMode;
    const spawnProcess = vi.fn((binary, args, options) => {
      const tokenFile = args[2];
      capturedToken = fs.readFileSync(tokenFile, "utf8");
      capturedMode = fs.statSync(tokenFile).mode & 0o777;
      expect(binary).toBe(RUNTIME);
      expect(args).toEqual([
        GUARDIAN,
        BINARY,
        tokenFile,
        ORIGIN_TARGET.socketPath,
        String(ORIGIN_TARGET.pid),
        "8812",
      ]);
      expect(JSON.stringify(args)).not.toContain(TOKEN);
      expect(options).toMatchObject({ shell: false, windowsHide: true });
      expect(options.env).toEqual({ PATH: "/usr/bin", ELECTRON_RUN_AS_NODE: "1" });
      return child;
    });
    const states = [];
    const manager = createManagedCompanionTunnel({
      binaryPath: BINARY,
      guardianEntry: GUARDIAN,
      runtimeExecutable: RUNTIME,
      runtimeRoot,
      environment: {
        PATH: "/usr/bin",
        TUNNEL_TOKEN: "must-not-leak",
        TUNNEL_TOKEN_FILE: "/attacker/file",
        CLOUDFLARED_TOKEN: "must-not-leak",
        CF_TUNNEL_TOKEN: "must-not-leak",
        TUNNEL_LOGLEVEL: "debug",
        TUNNEL_TRANSPORT_PROTOCOL: "quic",
        HTTP_PROXY: "http://attacker.invalid",
        AWS_SECRET_ACCESS_KEY: "must-not-leak",
      },
      spawnProcess,
      fetchImpl: vi.fn(async (_url, options) => {
        expect(options).toMatchObject({ redirect: "error" });
        return healthyResponse();
      }),
      onChange: (state) => states.push(state),
    });

    await expect(
      manager.start({ endpoint: ENDPOINT, token: TOKEN, originTarget: ORIGIN_TARGET }),
    ).resolves.toMatchObject({
      status: "ready",
      ready: true,
      configured: true,
      endpoint: ENDPOINT,
    });
    expect(capturedToken).toBe(TOKEN);
    if (process.platform !== "win32") expect(capturedMode).toBe(0o600);
    expect(fs.readdirSync(runtimeRoot)).toEqual([]);
    expect(states.map((state) => state.status)).toEqual(["starting", "ready"]);

    await manager.stop();
    expect(child.stdin.end).toHaveBeenCalledOnce();
    expect(child.kill).not.toHaveBeenCalled();
    expect(manager.getStatus()).toEqual({
      configured: true,
      endpoint: ENDPOINT,
      ready: false,
      status: "stopped",
    });
  });

  it("keeps retry state secret-free when hosted verification fails", async () => {
    const child = fakeChild();
    const manager = createManagedCompanionTunnel({
      binaryPath: BINARY,
      guardianEntry: GUARDIAN,
      runtimeExecutable: RUNTIME,
      runtimeRoot: path.join(temporaryDirectory(), "runtime"),
      spawnProcess: vi.fn(() => child),
      fetchImpl: vi.fn(async () => ({ ok: false, text: async () => "" })),
      verifyTimeoutMs: 0,
      maxRetryMs: 60_000,
    });

    const state = await manager.start({
      endpoint: ENDPOINT,
      token: TOKEN,
      originTarget: ORIGIN_TARGET,
    });
    expect(state).toMatchObject({
      status: "retrying",
      ready: false,
      endpoint: ENDPOINT,
      retryInMs: 1_000,
    });
    expect(JSON.stringify(state)).not.toContain(TOKEN);
    await manager.stop();
  });

  it("preempts a hanging startup probe by closing the guardian owner pipe", async () => {
    const child = fakeChild();
    const spawnProcess = vi.fn(() => child);
    const states = [];
    const manager = createManagedCompanionTunnel({
      binaryPath: BINARY,
      guardianEntry: GUARDIAN,
      runtimeExecutable: RUNTIME,
      runtimeRoot: path.join(temporaryDirectory(), "runtime"),
      spawnProcess,
      // Deliberately ignore AbortSignal: cancellation must wake the lifecycle
      // even if a fetch implementation or network stack never settles.
      fetchImpl: vi.fn(() => new Promise(() => {})),
      onChange: (state) => states.push(state),
    });

    const starting = manager.start({ endpoint: ENDPOINT, token: TOKEN, originTarget: ORIGIN_TARGET });
    await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledOnce());

    const stopping = manager.stop();
    // This assertion is intentionally before either lifecycle promise is
    // awaited: stop intent must signal the owned process synchronously rather
    // than sitting behind the 15-second verification transition.
    expect(child.stdin.end).toHaveBeenCalledOnce();
    expect(child.kill).not.toHaveBeenCalled();
    await expect(stopping).resolves.toMatchObject({ status: "stopped", ready: false });
    await expect(starting).resolves.toBeDefined();
    await new Promise((resolve) => setImmediate(resolve));

    expect(manager.getStatus()).toMatchObject({ status: "stopped", ready: false });
    expect(states.map((state) => state.status)).toEqual(["starting", "stopped"]);
    expect(spawnProcess).toHaveBeenCalledOnce();
  });

  it("lets stop supersede a queued start before it can spawn", async () => {
    const spawnProcess = vi.fn(() => fakeChild());
    const manager = createManagedCompanionTunnel({
      binaryPath: BINARY,
      guardianEntry: GUARDIAN,
      runtimeExecutable: RUNTIME,
      runtimeRoot: path.join(temporaryDirectory(), "runtime"),
      spawnProcess,
      fetchImpl: vi.fn(async () => healthyResponse()),
    });

    const starting = manager.start({ endpoint: ENDPOINT, token: TOKEN, originTarget: ORIGIN_TARGET });
    const stopping = manager.stop();
    await Promise.all([starting, stopping]);

    expect(spawnProcess).not.toHaveBeenCalled();
    expect(manager.getStatus()).toMatchObject({ status: "stopped", ready: false });
  });

  it("backs off after an unexpected exit, restarts, and cancels future work on stop", async () => {
    vi.useFakeTimers();
    const children = [fakeChild(1), fakeChild(2)];
    const spawnProcess = vi.fn(() => children[spawnProcess.mock.calls.length - 1]);
    const manager = createManagedCompanionTunnel({
      binaryPath: BINARY,
      guardianEntry: GUARDIAN,
      runtimeExecutable: RUNTIME,
      runtimeRoot: path.join(temporaryDirectory(), "runtime"),
      spawnProcess,
      fetchImpl: vi.fn(async () => healthyResponse()),
    });

    await manager.start({ endpoint: ENDPOINT, token: TOKEN, originTarget: ORIGIN_TARGET });
    children[0].crash();
    expect(manager.getStatus()).toMatchObject({ status: "retrying", retryInMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.runAllTicks();
    expect(spawnProcess).toHaveBeenCalledTimes(2);
    expect(manager.getStatus()).toMatchObject({ status: "ready", ready: true });

    children[1].crash();
    await manager.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(spawnProcess).toHaveBeenCalledTimes(2);
  });

  it("cleans only private token files whose owner process is dead", () => {
    const runtimeRoot = path.join(temporaryDirectory(), "runtime");
    fs.mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
    const stale = path.join(runtimeRoot, "connector-1234-12345678-1234-1234-1234-123456789abc.token");
    const live = path.join(runtimeRoot, "connector-5678-12345678-1234-1234-1234-123456789abc.token");
    const unrelated = path.join(runtimeRoot, "keep-me.txt");
    fs.writeFileSync(stale, TOKEN, { mode: 0o600 });
    fs.writeFileSync(live, TOKEN, { mode: 0o600 });
    fs.writeFileSync(unrelated, "keep", { mode: 0o600 });

    expect(
      cleanupStaleManagedCompanionTokens(runtimeRoot, {
        isProcessAlive: (pid) => pid === 5678,
      }),
    ).toBe(1);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(live)).toBe(true);
    expect(fs.existsSync(unrelated)).toBe(true);
  });
});
