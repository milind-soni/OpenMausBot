import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ home: "", hosts: [], start: null, handlers: new Map() }));
vi.mock("electron", () => ({
  app: { isPackaged: false, getPath: () => fixture.home, getAppPath: () => fixture.home },
  ipcMain: { handle: (name, handler) => fixture.handlers.set(name, handler) },
}));
vi.mock("@trycua/cua-driver/embedded", () => ({
  EmbeddedCuaDriverHost: class {
    constructor(binary, bundleId) { this.binary = binary; this.bundleId = bundleId; fixture.hosts.push(this); }
    start(options) { return fixture.start(options); }
    stop = vi.fn(async () => {});
    uniffiDestroy = vi.fn();
  },
}));
// Neither macOS permission imports nor ad-hoc daemon launches belong on Windows.
vi.mock("@trycua/cua-driver/electron", () => { throw new Error("macOS permissions loaded on Windows"); });
vi.mock("node:child_process", () => ({ execFile: vi.fn(() => { throw new Error("unowned launch"); }) }));
vi.mock("node:net", () => ({ default: { createConnection: vi.fn(() => { throw new Error("foreign pipe probed"); }) } }));

let cua;
const connection = { socketPath: "\\\\.\\pipe\\fixture-owned-cua" };
beforeEach(async () => {
  fixture.home = mkdtempSync(join(tmpdir(), "omb-cua-win-"));
  fixture.hosts = [];
  fixture.handlers.clear();
  fixture.start = vi.fn(async () => connection);
  vi.stubGlobal("process", new Proxy(process, {
    get(target, key) { return key === "platform" ? "win32" : Reflect.get(target, key); },
  }));
  vi.stubEnv("CUA_DRIVER_PATH", join(fixture.home, "cua-driver.exe"));
  vi.stubEnv("OPENMAUSBOT_CUA_EMBEDDED", "");
  vi.resetModules();
  cua = await import("./cua.mjs");
});
afterEach(async () => {
  await cua?.stopCua();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(fixture.home, { recursive: true, force: true });
});

describe("Windows owned CUA host", () => {
  it("uses embedded control even in dev, without a shared pipe or macOS permissions", async () => {
    await expect(cua.startCua()).resolves.toMatchObject({
      mode: "embedded", ...connection,
      mcpArgs: ["mcp", "--embedded", "--socket", connection.socketPath],
      mcpEnv: { CUA_DRIVER_EMBEDDED: "1", CUA_DRIVER_RS_TELEMETRY_ENABLED: "0" },
    });
    expect(fixture.start.mock.calls[0][0].signal).toBeInstanceOf(AbortSignal);
    expect(fixture.hosts[0].binary).toBe(process.env.CUA_DRIVER_PATH);
    await cua.stopCua();
    expect(fixture.hosts[0].stop).toHaveBeenCalledOnce();
    expect(fixture.hosts[0].uniffiDestroy).toHaveBeenCalledOnce();
  });

  it("reports a failed host instead of launching or attaching to an unowned daemon", async () => {
    fixture.start.mockRejectedValue(new Error("fixture start failed"));
    await expect(cua.startCua()).resolves.toMatchObject({
      mode: "unavailable", reason: "embedded host failed: fixture start failed",
    });
    expect(fixture.hosts[0].stop).toHaveBeenCalledOnce();
    expect(fixture.hosts[0].uniffiDestroy).toHaveBeenCalledOnce();
  });

  it("cancels a stalled start when the desktop stops", async () => {
    fixture.start.mockImplementation(({ signal }) => new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    const started = cua.startCua();
    const rejected = expect(started).rejects.toMatchObject({ name: "AbortError" });
    await expect.poll(() => fixture.hosts.length).toBe(1);
    await cua.stopCua();
    await rejected;
    expect(fixture.hosts[0].stop).toHaveBeenCalledOnce();
    expect(fixture.hosts[0].uniffiDestroy).toHaveBeenCalledOnce();
  });

  it("discards late startup without replacing or stopping the new host", async () => {
    let finish;
    fixture.start.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const first = cua.startCua();
    const rejected = expect(first).rejects.toMatchObject({ name: "AbortError" });
    await expect.poll(() => fixture.hosts.length).toBe(1);
    await cua.stopCua();
    await cua.startCua();
    finish({ socketPath: "stale-pipe" });
    await rejected;
    expect(fixture.hosts[0].stop).toHaveBeenCalledOnce();
    expect(fixture.hosts[1].stop).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(join(fixture.home, "cua-connection.json"), "utf8")).socketPath).toBe(connection.socketPath);
  });

  it("resolves the staged development executable without installing a foreign driver", () => {
    vi.stubEnv("CUA_DRIVER_PATH", "");
    const stage = join(fixture.home, "dist-native", "cua-win32-x64");
    mkdirSync(stage, { recursive: true });
    writeFileSync(join(stage, "cua-driver.exe"), "inert fixture");
    expect(cua.resolveDriverBinary()).toBe(join(stage, "cua-driver.exe"));
  });
});
