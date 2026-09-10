import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { environmentDescriptor, loadEnvironmentId, serverVersion } from "./environment.ts";

const dirs: string[] = [];

function loadEnvironmentIdInChild(dataDir: string): Promise<string> {
  const moduleUrl = new URL("./environment.ts", import.meta.url).href;
  const source = `import { loadEnvironmentId } from ${JSON.stringify(moduleUrl)}; process.stdout.write(loadEnvironmentId(process.argv[1]));`;
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", "--input-type=module", "--eval", source, dataDir],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`Environment identity child exited ${String(code)}: ${stderr}`));
    });
  });
}

function importComputerProvidersInChild(dataDir: string): Promise<void> {
  const boxUrl = new URL("./box.ts", import.meta.url).href;
  const vpsUrl = new URL("./vps-computer.ts", import.meta.url).href;
  const source = `await import(${JSON.stringify(boxUrl)}); await import(${JSON.stringify(vpsUrl)});`;
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", "--input-type=module", "--eval", source],
      {
        env: { ...process.env, OMB_DATA_DIR: dataDir },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Provider import child exited ${String(code)}: ${stderr}`));
    });
  });
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.OMB_APP_VERSION;
  delete process.env.OMB_ENVIRONMENT_LABEL;
});

describe("environment identity", () => {
  it("creates the id once, owner-only, and keeps it across restarts", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-env-"));
    dirs.push(dir);
    const id = loadEnvironmentId(dir);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    if (process.platform !== "win32") expect(statSync(join(dir, "environment-id")).mode & 0o777).toBe(0o600); // Windows has no POSIX modes
    expect(loadEnvironmentId(dir)).toBe(id);
  });

  it("publishes one complete id when independent processes start together", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-env-"));
    dirs.push(dir);

    const ids = await Promise.all(Array.from({ length: 12 }, () => loadEnvironmentIdInChild(dir)));
    expect(new Set(ids)).toEqual(new Set([ids[0]]));
    expect(ids[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(readFileSync(join(dir, "environment-id"), "utf8")).toBe(`${ids[0]}\n`);
    expect(readdirSync(dir)).toEqual(["environment-id"]);
  });

  it("fails closed instead of rotating a malformed existing identity", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-env-"));
    dirs.push(dir);
    const file = join(dir, "environment-id");
    writeFileSync(join(dir, "environment-id"), "garbage\n");
    expect(() => loadEnvironmentId(dir)).toThrow(/not a valid UUID; refusing to replace it/);
    expect(readFileSync(file, "utf8")).toBe("garbage\n");
  });

  it("rejects UUID-shaped garbage and an unreadable identity path", () => {
    const malformedDir = mkdtempSync(join(tmpdir(), "omb-env-"));
    dirs.push(malformedDir);
    writeFileSync(join(malformedDir, "environment-id"), "------------------------------------\n");
    expect(() => loadEnvironmentId(malformedDir)).toThrow(/not a valid UUID/);

    const unreadableDir = mkdtempSync(join(tmpdir(), "omb-env-"));
    dirs.push(unreadableDir);
    mkdirSync(join(unreadableDir, "environment-id"));
    expect(() => loadEnvironmentId(unreadableDir)).toThrow(/Cannot read the existing environment identity/);
  });

  it("does not create the data directory merely by importing computer providers", async () => {
    const parent = mkdtempSync(join(tmpdir(), "omb-provider-import-"));
    dirs.push(parent);
    const dataDir = join(parent, "not-created-yet");
    await importComputerProvidersInChild(dataDir);
    expect(existsSync(dataDir)).toBe(false);
  });

  it("describes the server for clients without leaking anything secret", () => {
    process.env.OMB_APP_VERSION = "0.1.99";
    process.env.OMB_ENVIRONMENT_LABEL = "cab mini";
    const d = environmentDescriptor({ environmentId: "abc", desktopManaged: true });
    expect(d).toEqual({
      environmentId: "abc",
      label: "cab mini",
      platform: process.platform,
      version: "0.1.99",
      capabilities: { remoteSessions: true, selfUpdate: "desktop-managed", emailSignIn: false },
    });
    expect(environmentDescriptor({ environmentId: "abc", desktopManaged: false }).capabilities.selfUpdate).toBe("operator");
  });

  it("falls back to the checkout's package.json version, then to unknown", () => {
    delete process.env.OMB_APP_VERSION;
    expect(serverVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
