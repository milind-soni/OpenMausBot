// The Mac driver's watch as cua.mjs wires it: a real start, a socket that stops answering, and a real restart. Nothing here can
// start the operator's own driver: attachStandalone stops at the app it can't find, and no child process exists to launch.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ home: "", alive: true, dead: new Set(), hosts: [], failStarts: 0, granted: true }));
vi.mock("electron", () => ({ app: { isPackaged: false, getPath: () => fixture.home }, ipcMain: { handle: () => {} } }));
vi.mock("@trycua/cua-driver/embedded", () => ({
  EmbeddedCuaDriverHost: class {
    static withOptions() { return new this(); }
    // Each start answers on its own socket, so one driver can stop answering while the next one works.
    constructor() { fixture.hosts.push(this); this.socket = `/fixture/driver-${fixture.hosts.length}.sock`; }
    async start() {
      if (fixture.failStarts > 0) { fixture.failStarts -= 1; throw new Error("the driver could not start"); }
      return { socketPath: this.socket };
    }
    // Main's exit watch (cua.mjs watchEmbeddedHost): this driver never exits, it only stops answering.
    waitForExit() { return new Promise(() => {}); }
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
    if (String(file).endsWith(".sock")) return fixture.alive && !fixture.dead.has(String(file));
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
  return { ...actual, watchDriver: (options) => actual.watchDriver({ ...options, everyMs: 5, log: () => {} }) };
});
// The helper's own bounded restarts (three tries), quickly.
vi.mock("./cua-restart.mjs", async (original) => {
  const actual = await original();
  return { ...actual, createHelperRestarts: (options) => actual.createHelperRestarts({ ...options, waitsMs: [5, 5, 5], log: () => {} }) };
});

let cua;
beforeEach(async () => {
  Object.assign(fixture, { home: mkdtempSync(join(tmpdir(), "omb-cua-watch-")), alive: true, dead: new Set(), hosts: [], failStarts: 0, granted: true });
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
    fixture.dead.add(fixture.hosts[0].socket);
    await expect.poll(() => fixture.hosts.length).toBe(2);
    expect(fixture.hosts[0].stop).toHaveBeenCalledOnce();
    await pause();
    expect(fixture.hosts).toHaveLength(2);
    fixture.dead.add(fixture.hosts[1].socket);
    await expect.poll(() => fixture.hosts.length).toBe(3);
    await pause();
    expect(fixture.hosts).toHaveLength(3);
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
    const { readFileSync } = await import("node:fs");
    await expect.poll(() => JSON.parse(readFileSync(join(fixture.home, "cua-connection.json"), "utf8")).mode).toBe("embedded");
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
