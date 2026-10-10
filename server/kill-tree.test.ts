// The drivers spawn their CLI detached so that stopping a turn also stops
// whatever the CLI started (its MCP servers). That guarantee is the whole
// contract of killCliTree, so it is what gets tested: a grandchild must not
// survive the kill on either platform.
import { spawn } from "node:child_process";
import { once } from "node:events";
import type { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { killCliTree, spawnCli } from "./procs.ts";

const IDLE = "setInterval(() => {}, 1000)";
const STUBBORN = `process.on('SIGTERM', () => {}); console.log(process.pid); ${IDLE}`;

function reportedPid(stdout: Readable): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("process did not report its pid")), 5_000);
    stdout.once("data", (chunk) => {
      clearTimeout(timer);
      resolve(Number(String(chunk).trim()));
    });
  });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("killCliTree", () => {
  it("owns stdin pipe errors before a CLI can be force-stopped", async () => {
    const child = spawnCli(process.execPath, ["-e", IDLE], { stdio: ["pipe", "pipe", "pipe"] });
    try {
      expect(child.stdin.listenerCount("error")).toBeGreaterThan(0);
    } finally {
      await expect(killCliTree(child)).resolves.toBe(true);
    }
  });

  it("reaps a grandchild, not just the process it was handed", async () => {
    // a stand-in CLI: spawns one helper, reports its pid, then idles
    const parent = spawnCli(
      process.execPath,
      [
        "-e",
        `const c = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(IDLE)}], { stdio: "ignore" });` +
          `console.log(c.pid); ${IDLE}`,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let grandchild = 0;
    try {
      grandchild = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("helper did not report its pid")), 5_000);
        parent.stdout!.once("data", (chunk) => {
          clearTimeout(timer);
          resolve(Number(String(chunk).trim()));
        });
      });
      expect(grandchild).toBeGreaterThan(0);
      expect(alive(grandchild)).toBe(true);

      await expect(killCliTree(parent)).resolves.toBe(true);

      // Read the parent's death off the child object: a POSIX parent stays a
      // live pid as a zombie until Node reaps it. The grandchild has no Child
      // object here, so wait until its pid disappears as the observable proof.
      const exited = () => parent.exitCode !== null || parent.signalCode !== null;
      const deadline = Date.now() + 10_000;
      while ((alive(grandchild) || !exited()) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(alive(grandchild)).toBe(false);
      expect(exited()).toBe(true);
    } finally {
      await killCliTree(parent);
      if (grandchild && alive(grandchild)) {
        try {
          process.kill(grandchild, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }
  }, 20_000);

  it.skipIf(process.platform === "win32")("escalates ignored TERM and shares concurrent stop attempts", async () => {
    const child = spawnCli(process.execPath, ["-e", STUBBORN], { stdio: ["pipe", "pipe", "pipe"] });
    try {
      await reportedPid(child.stdout);
      const started = Date.now();
      const stopped = killCliTree(child, 80);
      expect(killCliTree(child, 80)).toBe(stopped);
      await expect(stopped).resolves.toBe(true);
      expect(Date.now() - started).toBeGreaterThanOrEqual(75);
      expect(Date.now() - started).toBeLessThan(1_500);
      expect(child.signalCode).toBe("SIGKILL");
      expect(alive(child.pid!)).toBe(false);
      expect(killCliTree(child)).toBe(stopped);
    } finally {
      await killCliTree(child, 0);
    }
  });

  it.skipIf(process.platform === "win32").each([false, true])("waits for stubborn same-group helpers when the root exits first (already exited: %s)", async (exitFirst) => {
    const parent = spawnCli(process.execPath, ["-e", `
      const c = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(STUBBORN)}], { stdio: ['ignore', 'pipe', 'ignore'] });
      c.stdout.once('data', (pid) => { process.stdout.write(pid); ${exitFirst ? "process.exit(0);" : ""} });
      ${IDLE};
    `], { stdio: ["pipe", "pipe", "pipe"] });
    const rootClosed = once(parent, "close");
    let helper = 0;
    try {
      helper = await reportedPid(parent.stdout);
      if (exitFirst) await rootClosed;
      expect(alive(helper)).toBe(true);
      await expect(killCliTree(parent, 80)).resolves.toBe(true);
      expect(alive(helper)).toBe(false);
      expect(parent.exitCode !== null || parent.signalCode !== null).toBe(true);
    } finally {
      await killCliTree(parent, 0);
      if (helper && alive(helper)) process.kill(helper, "SIGKILL");
    }
  });

  it.skipIf(process.platform === "win32")("does not signal an unowned process group or an unrelated child", async () => {
    const child = spawn(process.execPath, ["-e", STUBBORN], { stdio: ["ignore", "pipe", "ignore"] });
    const unrelated = spawnCli(process.execPath, ["-e", STUBBORN], { stdio: ["pipe", "pipe", "pipe"] });
    const signals = vi.spyOn(process, "kill");
    try {
      await Promise.all([reportedPid(child.stdout!), reportedPid(unrelated.stdout)]);
      await expect(killCliTree(child, 80)).resolves.toBe(true);
      expect(signals.mock.calls.some(([pid]) => Number(pid) < 0)).toBe(false);
      expect(alive(unrelated.pid!)).toBe(true);
      expect(alive(process.pid)).toBe(true);
    } finally {
      signals.mockRestore();
      await Promise.all([killCliTree(child, 0), killCliTree(unrelated, 0)]);
    }
  });

  it.skipIf(process.platform === "win32")("returns false after bounded failed signaling and permits a retry", async () => {
    const child = spawnCli(process.execPath, ["-e", STUBBORN], { stdio: ["pipe", "pipe", "pipe"] });
    await reportedPid(child.stdout);
    const kill = process.kill.bind(process);
    const signals = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid === -child.pid! && signal !== 0) throw Object.assign(new Error("denied"), { code: "EPERM" });
      return kill(pid, signal);
    });
    const direct = vi.spyOn(child, "kill").mockReturnValue(false);
    try {
      const started = Date.now();
      await expect(killCliTree(child, 30)).resolves.toBe(false);
      expect(Date.now() - started).toBeLessThan(1_500);
      expect(alive(child.pid!)).toBe(true);
      expect(direct.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
    } finally {
      signals.mockRestore();
      direct.mockRestore();
      await expect(killCliTree(child, 0)).resolves.toBe(true);
    }
  });
});
