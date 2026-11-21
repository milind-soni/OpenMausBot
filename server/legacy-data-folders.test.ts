import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { workerPort } from "./testing/worker-port.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const PORT = workerPort(18800, 10_000);
const WEBHOOK_PORT = workerPort(39000, 10_000);

let home: string;
let child: ChildProcess;
let stderr = "";

const LEGACY_FOLDERS = [".openmausbot", ".opengrokbot"];
// A non-product shadow: an empty map would select the full default fleet, whose CLI probes are not part of this test.
const SHADOW_CONFIG = JSON.stringify({ instances: { fixture: { driver: "migration-test-shadow" } } });

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "omb-legacy-test-"));
  for (const name of LEGACY_FOLDERS) {
    mkdirSync(join(home, name), { recursive: true });
    writeFileSync(join(home, name, "config.json"), SHADOW_CONFIG);
    writeFileSync(join(home, name, "keep-me.txt"), `left alone in ${name}`);
  }
  child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: ROOT,
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home,
      USERPROFILE: home,
      OMB_PORT: String(PORT),
      OMB_WEBHOOK_PORT: String(WEBHOOK_PORT),
      OMB_BROWSER_CONNECTION: join(home, "browser-test-connection.json"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr?.on("data", (chunk) => (stderr += String(chunk)));
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/health`);
      if (res.ok) return;
    } catch {
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not start:\n${stderr}`);
}, 30_000);

afterAll(async () => {
  await waitForExit(child, { signal: "SIGTERM" });
  await removeTempDir(home);
});

describe("legacy data folders", () => {
  it("start a fresh data folder and leave an older app's folders exactly as they were", () => {
    const fresh = join(home, ".edubot");
    expect(readFileSync(join(fresh, "environment-id"), "utf8").trim()).toMatch(/^[0-9a-f-]{36}$/);
    expect(existsSync(join(fresh, "keep-me.txt"))).toBe(false);
    for (const name of LEGACY_FOLDERS) {
      expect(readdirSync(join(home, name)).sort()).toEqual(["config.json", "keep-me.txt"]);
      expect(readFileSync(join(home, name, "keep-me.txt"), "utf8")).toBe(`left alone in ${name}`);
      expect(readFileSync(join(home, name, "config.json"), "utf8")).toBe(SHADOW_CONFIG);
    }
  });
});
