// The Mac driver's watch as cua.mjs wires it: a real start, a socket that stops answering, and a real restart. Nothing here can
// start the operator's own driver: attachStandalone stops at the app it can't find, and no child process exists to launch.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ home: "", alive: true, hosts: [], failStarts: 0, granted: true }));
vi.mock("electron", () => ({ app: { isPackaged: false, getPath: () => fixture.home }, ipcMain: { handle: () => {} } }));
vi.mock("@trycua/cua-driver/embedded", () => ({
  EmbeddedCuaDriverHost: class {
    constructor() { fixture.hosts.push(this); }
    async start() {
      if (fixture.failStarts > 0) { fixture.failStarts -= 1; throw new Error("the driver could not start"); }
      return { socketPath: "/fixture/driver.sock" };
    }
    stop = vi.fn(async () => {});
    uniffiDestroy = vi.fn();
  },
}));
vi.mock("@trycua/cua-driver/electron", () => ({
  requestMacOSPermissions: () => ({ accessibility: fixture.granted, screenRecording: fixture.granted }),
  hasRequiredMacOSPermissions: () => fixture.granted,
}));
vi.mock("node:fs", async (original) => {
  const fs = await original();
  return { ...fs, default: { ...fs.default, existsSync: (file) => {
    if (String(file).endsWith(".sock")) return fixture.alive;
    if (String(file).includes("CuaDriver.app")) return false;
    return fs.existsSync(file);
  } } };
});
vi.mock("node:net", async (original) => {
  const net = await original();
  const { EventEmitter } = await import("node:events");
  return { ...net, default: { ...net.default, createConnection: () => {
    const socket = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    queueMicrotask(() => socket.emit("connect"));
    return socket;
  } } };
});
vi.mock("./cua-watch.mjs", async (original) => {
  const actual = await original();
  return { ...actual, DEAD_DRIVER_RETRY_MS: [5, 5], watchDriver: (options) => actual.watchDriver({ ...options, everyMs: 5, log: () => {} }) };
});

let cua;
beforeEach(async () => {
  Object.assign(fixture, { home: mkdtempSync(join(tmpdir(), "omb-cua-watch-")), alive: true, hosts: [], failStarts: 0, granted: true });
  vi.stubEnv("OPENMAUSBOT_CUA_EMBEDDED", "1");
  vi.stubEnv("CUA_DRIVER_PATH", "/fixture/cua-driver");
  vi.resetModules();
  cua = await import("./cua.mjs");
});
afterEach(async () => {
  await cua?.stopCua();
  vi.unstubAllEnvs();
  rmSync(fixture.home, { recursive: true, force: true });
});
const pause = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(process.platform !== "darwin")("the Mac driver dies after it started", () => {
  it("leaves a driver that answers alone", async () => {
    await cua.startCua();
    await pause();
    expect(fixture.hosts).toHaveLength(1);
  });

  it("starts it again, and watches the new one", async () => {
    await expect(cua.startCua()).resolves.toMatchObject({ mode: "embedded" });
    fixture.alive = false;
    await expect.poll(() => fixture.hosts.length).toBeGreaterThanOrEqual(2);
    expect(fixture.hosts[0].stop).toHaveBeenCalledOnce();
    fixture.alive = true;
    const settled = fixture.hosts.length;
    await pause();
    expect(fixture.hosts).toHaveLength(settled);
    fixture.alive = false;
    await expect.poll(() => fixture.hosts.length).toBeGreaterThan(settled);
  });

  it("tries again when the restart fails, and stops trying after a few", async () => {
    await cua.startCua();
    fixture.failStarts = 100;
    fixture.alive = false;
    await expect.poll(() => fixture.hosts.length).toBe(4);
    await pause(100);
    expect(fixture.hosts).toHaveLength(4);
  });

  it("recovers when a later try works", async () => {
    await cua.startCua();
    fixture.failStarts = 1;
    fixture.alive = false;
    await expect.poll(() => fixture.hosts.length).toBeGreaterThanOrEqual(3);
    fixture.alive = true;
    expect(JSON.parse((await import("node:fs")).readFileSync(join(fixture.home, "cua-connection.json"), "utf8")).mode).toBe("embedded");
  });

  it("doesn't keep asking when macOS permissions are what's missing", async () => {
    await cua.startCua();
    fixture.granted = false;
    fixture.alive = false;
    await expect.poll(() => fixture.hosts.length).toBe(1);
    await pause(100);
    expect(fixture.hosts).toHaveLength(1);
    expect(JSON.parse((await import("node:fs")).readFileSync(join(fixture.home, "cua-connection.json"), "utf8")).mode).toBe("unavailable");
  });

  it("stops watching on an explicit Stop", async () => {
    await cua.startCua();
    await cua.stopCua();
    fixture.alive = false;
    await pause();
    expect(fixture.hosts).toHaveLength(1);
  });
});
