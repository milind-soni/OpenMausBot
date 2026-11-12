// Regression test: instanceConfigs() falls back to the built-in default
// fleet (grok/claude/codex/antigravity/computer) ONLY when disk has no
// `instances` key at all. A naive PATCH /api/instances/:id handler that
// writes just the touched instance therefore replaces that fallback with a
// one-entry fleet, silently deleting every other provider on next load.
// This boots a server with NO `instances` key on disk (the default-fleet
// state most users start in) and asserts a single toggle preserves siblings.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;

let child: ChildProcess;
let home: string;
let stderr = "";

const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "gbs-default-fleet-test-"));
  mkdirSync(join(home, ".gbs"), { recursive: true });
  // no `instances` key at all — exactly how a fresh install's config.json
  // looks before anyone has hand-edited it or used the permission toggle.
  writeFileSync(join(home, ".gbs", "config.json"), JSON.stringify({}));

  child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: ROOT,
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home,
      USERPROFILE: home,
      GBS_PORT: String(PORT),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr!.on("data", (c) => (stderr += c));

  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}, 30_000);

afterAll(async () => {
  child?.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    child.on("close", () => resolve());
    setTimeout(() => (child.kill("SIGKILL"), resolve()), 5_000).unref?.();
  });
  rmSync(home, { recursive: true, force: true });
});

describe("PATCH /api/instances/:id against a default (unconfigured) fleet", () => {
  it("starts with the full four-instance default fleet", async () => {
    const { body } = await api("GET", "/api/instances");
    const ids = body.instances.map((i: any) => i.instanceId).sort();
    expect(ids).toEqual(["antigravity", "claude", "codex", "grok"]);
  });

  it("toggling one instance does not drop the others from disk or the API", async () => {
    const patched = await api("PATCH", "/api/instances/codex", { autoApprove: true });
    expect(patched.status).toBe(200);
    const patchedIds = patched.body.instances.map((i: any) => i.instanceId).sort();
    expect(patchedIds).toEqual(["antigravity", "claude", "codex", "grok"]);

    const disk = JSON.parse(readFileSync(join(home, ".gbs", "config.json"), "utf8"));
    expect(Object.keys(disk.instances).sort()).toEqual(["antigravity", "claude", "codex", "grok"]);

    const refetched = await api("GET", "/api/instances");
    expect(refetched.body.instances.map((i: any) => i.instanceId).sort()).toEqual([
      "antigravity",
      "claude",
      "codex",
      "grok",
    ]);
  });
});
