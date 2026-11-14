import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { serveReadyLimitMs, serverNotReadyMessage, waitForServer } from "./serve-ready.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));

function fakeClock() {
  let time = 1_000;
  return { now: () => time, sleep: async (ms: number) => { time += ms; }, elapsed: () => time - 1_000 };
}

describe("serveReadyLimitMs", () => {
  it("defaults to five minutes", () => {
    expect(serveReadyLimitMs({})).toBe(300_000);
  });

  it("takes whole milliseconds and leaves the default for anything else", () => {
    expect(serveReadyLimitMs({ OMB_SERVE_READY_TIMEOUT_MS: "600000" })).toBe(600_000);
    for (const raw of ["", "5m", "0", "-1", "Infinity", "1e309"]) expect(serveReadyLimitMs({ OMB_SERVE_READY_TIMEOUT_MS: raw })).toBe(300_000);
  });
});

describe("waitForServer", () => {
  it("waits out a server that answers only after 130 seconds, and says it is still starting once", async () => {
    const clock = fakeClock();
    const stillStarting = vi.fn();
    await waitForServer({ limitMs: serveReadyLimitMs({}), up: async () => clock.elapsed() >= 130_000, stopped: () => false, stillStarting, ...clock });
    expect(clock.elapsed()).toBeGreaterThanOrEqual(130_000);
    expect(clock.elapsed()).toBeLessThan(131_000);
    expect(stillStarting).toHaveBeenCalledTimes(1);
  });

  it("says nothing about a server that answers within the first minute", async () => {
    const clock = fakeClock();
    const stillStarting = vi.fn();
    await waitForServer({ limitMs: 300_000, up: async () => clock.elapsed() >= 12_000, stopped: () => false, stillStarting, ...clock });
    expect(clock.elapsed()).toBeLessThan(13_000);
    expect(stillStarting).not.toHaveBeenCalled();
  });

  it("gives up at the limit when the server never answers", async () => {
    const clock = fakeClock();
    await waitForServer({ limitMs: 2_000, up: async () => false, stopped: () => false, stillStarting: () => undefined, ...clock });
    expect(clock.elapsed()).toBeGreaterThanOrEqual(2_000);
    expect(clock.elapsed()).toBeLessThan(3_000);
  });

  it("stops polling as soon as the server is stopped", async () => {
    const clock = fakeClock();
    const up = vi.fn(async () => false);
    await waitForServer({ limitMs: 300_000, up, stopped: () => clock.elapsed() >= 500, stillStarting: () => undefined, ...clock });
    expect(clock.elapsed()).toBeLessThan(1_000);
    expect(up).toHaveBeenCalledTimes(2);
  });
});

describe("serverNotReadyMessage", () => {
  it("names the limit, where to look and how to wait longer", () => {
    expect(serverNotReadyMessage(300_000)).toBe("OpenMausBot was still starting after 300 seconds, so it was stopped. Anything it printed is above. To wait longer, set OMB_SERVE_READY_TIMEOUT_MS (in milliseconds).");
    expect(serverNotReadyMessage(90_000, "/data/logs/server.log")).toContain("after 90 seconds, so it was stopped. Details: /data/logs/server.log.");
  });
});

describe.skipIf(process.platform === "win32")("openmausbot serve", () => {
  it("honours the configured limit, stops the server and explains how to wait longer", async () => {
    const home = mkdtempSync(join(tmpdir(), "omb-serve-ready-"));
    const dataDir = join(home, "data");
    mkdirSync(dataDir, { recursive: true });
    const port = await freePortBlock([0, 1]);
    const child = spawn(process.execPath, ["--experimental-strip-types", join(SERVER_DIR, "openmausbot.ts"), "serve", "--no-pair", "--port", String(port), "--data-dir", dataDir], {
      cwd: join(SERVER_DIR, ".."),
      env: { PATH: process.env.PATH ?? "", HOME: home, USERPROFILE: home, OMB_WEBHOOK_PORT: String(port + 1), OMB_BROWSER_CONNECTION: join(home, "browser-connection.json"), OMB_SERVE_READY_TIMEOUT_MS: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let err = "";
    child.stderr?.on("data", (chunk) => (err += String(chunk)));
    const code = new Promise<number | null>((done) => child.once("exit", done));
    try {
      expect(await code).toBe(1);
      expect(err).toContain(serverNotReadyMessage(1));
      await expect(fetch(`http://127.0.0.1:${port}/api/health`)).rejects.toThrow();
    } finally {
      child.kill("SIGKILL");
      await waitForExit(child);
      await removeTempDir(home);
    }
  }, 60_000);
});
