// A user upgrading from the pre-rename data dir (~/.opengrokbot) must find
// everything in ~/.astra after the first boot. Anything that touches
// the new dir before ensureDirs() runs would make that rename a no-op and
// boot the user into an empty workspace — this test pins the order.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");

let home: string;
let child: ChildProcess;

/** Boots the server with `legacyName` pre-seeded in an isolated home. */
async function bootWithLegacyDir(legacyName: string) {
  const bootHome = mkdtempSync(join(tmpdir(), "omb-legacy-test-"));
  const legacy = join(bootHome, legacyName);
  mkdirSync(legacy, { recursive: true });
  // A non-product shadow keeps startup deterministic: an empty map selects
  // the user's full default engine fleet, whose installed CLI probes are not
  // part of this migration test.
  writeFileSync(join(legacy, "config.json"), JSON.stringify({
    instances: { fixture: { driver: "migration-test-shadow" } },
  }));
  writeFileSync(join(legacy, "keep-me.txt"), "carried over");
  // A bot's cwd is captured at creation and realpath()ed every turn, so a
  // rename that carried the directory but not the stored string would fail
  // the first turn with ENOENT. Seed one bot to pin the rebase — and a prose
  // field that merely mentions the path, which is the user's text, not a path.
  const workspaceId = "e2090318-e3e2-4d9c-94cd-2182caa8ed98";
  mkdirSync(join(legacy, "workspaces", workspaceId), { recursive: true });
  writeFileSync(join(legacy, "bots.json"), JSON.stringify([{
    id: "migrated-bot",
    threadId: "thread-1",
    cwd: join(legacy, "workspaces", workspaceId),
    soul: `Notes for this bot live in ${join(legacy, "workspaces", workspaceId)}.`,
  }], null, 2));
  // The provisioned Piper engine is the heaviest thing a rename has to carry:
  // it lives INSIDE the data dir, so losing it silently downgrades the user to
  // the robotic built-in voice with no error to explain why.
  mkdirSync(join(legacy, "piper", "voices"), { recursive: true });
  writeFileSync(join(legacy, "piper", "piper.exe"), "engine");
  writeFileSync(join(legacy, "piper", "voices", "en_US-ryan-high.onnx"), "voice");
  const port = 18800 + Math.floor(Math.random() * 10_000);
  const webhookPort = 39000 + Math.floor(Math.random() * 10_000);
  const booted = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: ROOT,
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: bootHome,
      USERPROFILE: bootHome,
      ASTRA_PORT: String(port),
      ASTRA_WEBHOOK_PORT: String(webhookPort),
      ASTRA_BROWSER_CONNECTION: join(bootHome, "browser-test-connection.json"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let bootedStderr = "";
  booted.stderr?.on("data", (chunk) => (bootedStderr += String(chunk)));
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return { home: bootHome, child: booted, stderr: bootedStderr };
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not start:\n${bootedStderr}`);
}

beforeAll(async () => {
  ({ home, child } = await bootWithLegacyDir(".opengrokbot"));
}, 30_000);

afterAll(async () => {
  await waitForExit(child, { signal: "SIGTERM" });
  await removeTempDir(home);
});

describe("legacy data dir", () => {
  it("is renamed to the new name on first boot, with its contents and a fresh environment id", () => {
    const fresh = join(home, ".astra");
    expect(existsSync(join(home, ".opengrokbot"))).toBe(false);
    expect(readFileSync(join(fresh, "keep-me.txt"), "utf8")).toBe("carried over");
    expect(readFileSync(join(fresh, "environment-id"), "utf8").trim()).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("carries the Piper engine into the new dir", () => {
    const fresh = join(home, ".astra");
    // The engine binary is platform-named, so assert the dir it lives in.
    expect(existsSync(join(fresh, "piper", "piper.exe"))).toBe(true);
    expect(existsSync(join(fresh, "piper", "voices", "en_US-ryan-high.onnx"))).toBe(true);
  });

  it("rebases a stored bot cwd onto the renamed dir and leaves prose alone", () => {
    const fresh = join(home, ".astra");
    const bots = JSON.parse(readFileSync(join(fresh, "bots.json"), "utf8")) as Array<Record<string, unknown>>;
    const rebased = join(fresh, "workspaces", "e2090318-e3e2-4d9c-94cd-2182caa8ed98");
    expect(bots[0].cwd).toBe(rebased);
    // The path the stored cwd now names must really exist — that realpath()
    // is what the failing turn ran.
    expect(existsSync(String(bots[0].cwd))).toBe(true);
    // The same path inside the bot's own prose is text, not a resolved path:
    // it still names the dir this boot migrated (`.opengrokbot`), untouched.
    expect(String(bots[0].soul)).toContain(join(home, ".opengrokbot", "workspaces"));
  });

  it("migrates the OpenMausBot data dir the same way", async () => {
    const { home: mausHome, child: mausChild } = await bootWithLegacyDir(".openmausbot");
    try {
      const fresh = join(mausHome, ".astra");
      expect(existsSync(join(mausHome, ".openmausbot"))).toBe(false);
      expect(readFileSync(join(fresh, "keep-me.txt"), "utf8")).toBe("carried over");
      expect(readFileSync(join(fresh, "environment-id"), "utf8").trim()).toMatch(/^[0-9a-f-]{36}$/);
    } finally {
      await waitForExit(mausChild, { signal: "SIGTERM" });
      await removeTempDir(mausHome);
    }
  }, 30_000);
});
