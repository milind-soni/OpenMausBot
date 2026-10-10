import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { acquireDataDirLease } from "./data-dir-lease.ts";

const MODULE_URL = pathToFileURL(join(process.cwd(), "server", "data-dir-lease.ts")).href;
const dirs: string[] = [];

function tempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "omb-data-dir-lease-"));
  dirs.push(dir);
  return dir;
}

function leaseWorker(source: string) {
  const child = spawn(process.execPath, [
    "--no-warnings",
    "--experimental-strip-types",
    "--input-type=module",
    "--eval",
    source,
  ], { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => (stderr += chunk));
  return {
    child,
    lines: createInterface({ input: child.stdout })[Symbol.asyncIterator](),
    exited: once(child, "exit"),
    stderr: () => stderr,
  };
}

async function workerLine(worker: ReturnType<typeof leaseWorker>): Promise<string> {
  const line = await worker.lines.next();
  if (line.done) throw new Error(`lease worker exited before replying: ${worker.stderr()}`);
  return line.value;
}

async function expectCleanExit(worker: ReturnType<typeof leaseWorker>): Promise<void> {
  const [code, signal] = await worker.exited;
  expect({ code, signal, stderr: worker.stderr() }).toEqual({ code: 0, signal: null, stderr: "" });
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("OpenMausBot data-directory lease", () => {
  it("holds one directory until its matching handle releases it", () => {
    const dir = tempDataDir();
    const lease = acquireDataDirLease(dir);
    const stored = JSON.parse(readFileSync(join(dir, "openmausbot-server.lease"), "utf8"));

    // boot/uptime identify which boot wrote the record, so a pid recycled
    // across a restart cannot be mistaken for a live owner. boot is null on
    // platforms that expose no boot id, so it is checked separately.
    const { boot, ...rest } = stored;
    expect(rest).toEqual({
      version: 1,
      pid: process.pid,
      host: hostname(),
      token: expect.stringMatching(/^[0-9a-f-]{36}$/),
      createdAt: expect.any(Number),
      uptime: expect.any(Number),
    });
    expect(boot === null || (typeof boot === "string" && boot.length > 0)).toBe(true);
    expect(Object.keys(stored).sort()).toEqual(
      ["boot", "createdAt", "host", "pid", "token", "uptime", "version"],
    );
    expect(() => acquireDataDirLease(dir)).toThrow(/already using this data directory/i);

    expect(lease.release()).toBe(true);
    expect(lease.release()).toBe(false);
    const replacement = acquireDataDirLease(dir);
    expect(replacement.release()).toBe(true);
  });

  it("will not release a lease whose owner token changed", () => {
    const dir = tempDataDir();
    const path = join(dir, "openmausbot-server.lease");
    const lease = acquireDataDirLease(dir);
    const original = JSON.parse(readFileSync(path, "utf8"));
    const replacement = { ...original, token: randomUUID() };
    unlinkSync(path);
    writeFileSync(path, `${JSON.stringify(replacement)}\n`, { mode: 0o600 });

    expect(() => lease.release()).toThrow(/will not release.*another process/i);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(replacement);
  });

  it("allows only one live child process to own a shared directory", async () => {
    const dir = tempDataDir();
    const holderSource = `
      const { acquireDataDirLease } = await import(${JSON.stringify(MODULE_URL)});
      const lease = acquireDataDirLease(${JSON.stringify(dir)});
      process.stdout.write("acquired\\n");
      process.stdin.once("data", () => {
        lease.release();
        process.stdout.write("released\\n");
      });
    `;
    const holder = leaseWorker(holderSource);
    try {
      expect(await workerLine(holder)).toBe("acquired");
      const contender = leaseWorker(`
        const { acquireDataDirLease } = await import(${JSON.stringify(MODULE_URL)});
        try {
          acquireDataDirLease(${JSON.stringify(dir)});
          process.stdout.write(JSON.stringify({ acquired: true }) + "\\n");
        } catch (error) {
          process.stdout.write(JSON.stringify({ error: String(error?.message ?? error) }) + "\\n");
        }
      `);
      const result = JSON.parse(await workerLine(contender));
      await expectCleanExit(contender);
      expect(result.error).toMatch(/already using this data directory.*process/i);

      holder.child.stdin.end("release\n");
      expect(await workerLine(holder)).toBe("released");
      await expectCleanExit(holder);
      const after = acquireDataDirLease(dir);
      expect(after.release()).toBe(true);
    } finally {
      if (holder.child.exitCode === null) holder.child.kill("SIGKILL");
    }
  });

  it("recovers the complete lease left by a crashed child", async () => {
    const dir = tempDataDir();
    const crashed = leaseWorker(`
      const { acquireDataDirLease } = await import(${JSON.stringify(MODULE_URL)});
      acquireDataDirLease(${JSON.stringify(dir)});
      process.stdout.write("acquired\\n");
      process.exit(0);
    `);
    expect(await workerLine(crashed)).toBe("acquired");
    await expectCleanExit(crashed);

    const recovered = acquireDataDirLease(dir);
    expect(recovered.ownerPid).toBe(process.pid);
    expect(recovered.release()).toBe(true);
  });

  it("fails closed on a corrupt owner record", () => {
    const dir = tempDataDir();
    const path = join(dir, "openmausbot-server.lease");
    writeFileSync(path, "not-json\n", { mode: 0o600 });

    expect(() => acquireDataDirLease(dir)).toThrow(/lease is invalid.*refusing to start/i);
    expect(readFileSync(path, "utf8")).toBe("not-json\n");
  });
});
