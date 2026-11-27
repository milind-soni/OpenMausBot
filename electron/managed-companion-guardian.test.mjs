import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import {
  minimalCloudflaredEnvironment,
  minimalGuardianEnvironment,
  runManagedCompanionGuardian,
} from "./managed-companion-guardian.mjs";

const TARGET =
  process.platform === "win32"
    ? {
        pid: 31337,
        socketPath:
          "\\\\.\\pipe\\openmausbot-companion-origin-31337-12345678-1234-1234-1234-123456789abc",
      }
    : { pid: 31337, socketPath: "/tmp/omb-companion-origin-guardian/origin.sock" };

function owner() {
  const input = new EventEmitter();
  input.resume = vi.fn();
  return input;
}

function connector(events) {
  const child = new EventEmitter();
  child.pid = 4242;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = vi.fn((signal) => {
    events.push(`kill:${signal}`);
    queueMicrotask(() => {
      child.signalCode = signal;
      events.push("connector-exit");
      child.emit("exit", null, signal);
    });
    return true;
  });
  return child;
}

function fixture(events, child = connector(events)) {
  const gateway = {
    start: vi.fn(async () => events.push("gateway-start")),
    invalidate: vi.fn(() => events.push("gateway-invalidate")),
    close: vi.fn(async () => events.push("gateway-close")),
  };
  return {
    child,
    gateway,
    createGateway: vi.fn(() => gateway),
    spawnProcess: vi.fn((_binary, _args, options) => {
      events.push("connector-spawn");
      expect(options).toMatchObject({ shell: false, windowsHide: true });
      return child;
    }),
  };
}

describe("managed Companion guardian", () => {
  it("holds the gateway until cloudflared is confirmed dead after owner EOF", async () => {
    const events = [];
    const input = owner();
    const { child, createGateway, spawnProcess } = fixture(events);
    const running = runManagedCompanionGuardian({
      cloudflaredBinary: "/trusted/cloudflared",
      tokenFile: "/private/token",
      target: TARGET,
      ownerInput: input,
      signalSource: new EventEmitter(),
      createGateway,
      spawnProcess,
    });
    await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledOnce());
    input.emit("end");
    await expect(running).resolves.toBe(0);

    expect(events).toEqual([
      "gateway-start",
      "connector-spawn",
      "gateway-invalidate",
      "kill:SIGTERM",
      "connector-exit",
      "gateway-close",
    ]);
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it("invalidates and closes the gateway when cloudflared exits unexpectedly", async () => {
    const events = [];
    const input = owner();
    const { child, createGateway, spawnProcess } = fixture(events);
    const running = runManagedCompanionGuardian({
      cloudflaredBinary: "/trusted/cloudflared",
      tokenFile: "/private/token",
      target: TARGET,
      ownerInput: input,
      signalSource: new EventEmitter(),
      createGateway,
      spawnProcess,
    });
    await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledOnce());
    child.exitCode = 9;
    child.emit("exit", 9, null);
    await expect(running).resolves.toBe(9);
    expect(events).toEqual([
      "gateway-start",
      "connector-spawn",
      "gateway-invalidate",
      "gateway-close",
    ]);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("closes an already-bound gateway when connector spawn throws", async () => {
    const events = [];
    const gateway = {
      start: vi.fn(async () => events.push("gateway-start")),
      invalidate: vi.fn(() => events.push("gateway-invalidate")),
      close: vi.fn(async () => events.push("gateway-close")),
    };
    await expect(
      runManagedCompanionGuardian({
        cloudflaredBinary: "/trusted/cloudflared",
        tokenFile: "/private/token",
        target: TARGET,
        ownerInput: owner(),
        signalSource: new EventEmitter(),
        createGateway: () => gateway,
        spawnProcess: () => {
          throw new Error("spawn failed");
        },
      }),
    ).rejects.toThrow("spawn failed");
    expect(events).toEqual(["gateway-start", "gateway-invalidate", "gateway-close"]);
  });
});

describe("connector environment", () => {
  it("uses an allowlist that strips Cloudflare behavior variables, proxies, and secrets", () => {
    const inherited = {
      PATH: "/usr/bin",
      HOME: "/private/home",
      TUNNEL_TOKEN: "secret",
      tunnel_loglevel: "debug",
      CLOUDFLARED_CONFIG: "/attacker/config",
      CF_TUNNEL_TOKEN: "secret",
      HTTP_PROXY: "http://attacker.invalid",
      AWS_SECRET_ACCESS_KEY: "secret",
    };
    expect(minimalCloudflaredEnvironment(inherited, "linux")).toEqual({ PATH: "/usr/bin" });
    expect(minimalGuardianEnvironment(inherited, "linux")).toEqual({
      PATH: "/usr/bin",
      ELECTRON_RUN_AS_NODE: "1",
    });
    expect(
      minimalCloudflaredEnvironment(
        { ...inherited, SystemRoot: "C:\\Windows", TEMP: "C:\\Temp" },
        "win32",
      ),
    ).toEqual({ PATH: "/usr/bin", SystemRoot: "C:\\Windows", TEMP: "C:\\Temp" });
  });
});
