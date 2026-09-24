// Integration test for PATCH /api/instances/:id — boots the real harness
// server against a throwaway home directory with one live Claude instance
// (pointed at the fake CLI, so no real credentials/network needed) plus one
// shadow (unknown-driver) instance, and exercises the auto-approve toggle
// end to end: response shape, disk persistence, and error paths.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const FAKE_CLI = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
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
  home = mkdtempSync(join(tmpdir(), "gbs-permission-test-"));
  mkdirSync(join(home, ".gbs"), { recursive: true });
  writeFileSync(
    join(home, ".gbs", "config.json"),
    JSON.stringify({
      instances: {
        claude: { driver: "claudeAgent", config: { cli: FAKE_CLI, permissionMode: "acceptEdits" } },
        ghost: { driver: "not-a-real-driver", displayName: "Ghost" },
      },
    }),
  );

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

describe("PATCH /api/instances/:id", () => {
  it("reports the current permission mode on GET /api/instances", async () => {
    const { body } = await api("GET", "/api/instances");
    const claude = body.instances.find((i: any) => i.instanceId === "claude");
    expect(claude.autoApprove).toBe(false);
    const ghost = body.instances.find((i: any) => i.instanceId === "ghost");
    expect(ghost.autoApprove).toBeNull();
  });

  it("flips the toggle, persists it to disk, and reloads the fleet", async () => {
    const patched = await api("PATCH", "/api/instances/claude", { autoApprove: true });
    if (process.getuid?.() === 0) {
      expect(patched.status).toBe(400);
      expect(patched.body.error).toMatch(/root/);
      expect(JSON.parse(readFileSync(join(home, ".gbs", "config.json"), "utf8")).instances.claude.config.permissionMode).toBe("acceptEdits");
      return;
    }
    expect(patched.status).toBe(200);
    const claude = patched.body.instances.find((i: any) => i.instanceId === "claude");
    expect(claude.autoApprove).toBe(true);

    const disk = JSON.parse(readFileSync(join(home, ".gbs", "config.json"), "utf8"));
    expect(disk.instances.claude.config.permissionMode).toBe("bypassPermissions");

    const refetched = await api("GET", "/api/instances");
    expect(refetched.body.instances.find((i: any) => i.instanceId === "claude").autoApprove).toBe(true);
  });

  it("400s on a non-boolean autoApprove", async () => {
    const res = await api("PATCH", "/api/instances/claude", { autoApprove: "yes" });
    expect(res.status).toBe(400);
  });

  it("404s on an unknown instance id", async () => {
    const res = await api("PATCH", "/api/instances/nope", { autoApprove: true });
    expect(res.status).toBe(404);
  });

  it("404s on a shadow instance (no live driver to reconfigure)", async () => {
    const res = await api("PATCH", "/api/instances/ghost", { autoApprove: true });
    expect(res.status).toBe(404);
  });
});
