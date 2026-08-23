import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { waitForExit } from "./testing/cleanup.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const PORT = 31_000 + Math.floor(Math.random() * 5_000);
const BASE = `http://127.0.0.1:${PORT}`;
let child: ChildProcess;
let home: string;
let staticDir: string;
let output = "";

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "omb-unattended-adapter-home-"));
  staticDir = join(home, "static");
  mkdirSync(staticDir, { recursive: true });
  writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>Hermes Work Queue</title>");
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    USERPROFILE: home,
    OMB_PORT: String(PORT),
    OMB_WEBHOOK_PORT: String(PORT + 1),
    OMB_STATIC_DIR: staticDir,
    OMB_UNATTENDED_ADAPTER_ONLY: "1",
    OMB_UNATTENDED_WORK_ENABLED: "0",
    OMB_UNATTENDED_WORK_URL: "http://127.0.0.1:8817",
  };
  if (process.env.PATH) env.PATH = process.env.PATH;
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => { output += String(chunk); });
  child.stderr?.on("data", (chunk) => { output += String(chunk); });

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`adapter server exited ${child.exitCode}: ${output}`);
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return;
    } catch {
      // Boot is still in progress.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`adapter server did not start: ${output}`);
});

afterAll(async () => {
  if (child?.exitCode === null) child.kill("SIGTERM");
  if (child) await waitForExit(child, 5_000).catch(() => child.kill("SIGKILL"));
  if (home) rmSync(home, { recursive: true, force: true });
});

describe("unattended adapter-only server mode", () => {
  it("serves only the standalone UI and narrow work-plane API", async () => {
    const appHealth = await (await fetch(`${BASE}/api/health`)).json();
    expect(appHealth).toMatchObject({ app: "openmausbot", mode: "unattended-adapter", static: true });

    const adapterHealth = await (await fetch(`${BASE}/api/unattended-work/health`)).json();
    expect(adapterHealth).toMatchObject({
      status: "disabled",
      adapter: { enabled: false, executor: "hermes", runs_repo_tools: false },
    });

    for (const path of ["/api/bots", "/api/instances", "/api/routines", "/api/internal/agents"]) {
      const response = await fetch(`${BASE}${path}`);
      expect(response.status, path).toBe(404);
      await expect(response.json()).resolves.toMatchObject({ error: "route unavailable in unattended adapter mode" });
    }

    const html = await (await fetch(`${BASE}/`)).text();
    expect(html).toContain("Hermes Work Queue");
  });

  it("starts no webhook listener and keeps submission disabled", async () => {
    await expect(fetch(`http://127.0.0.1:${PORT + 1}/health`)).rejects.toThrow();
    const response = await fetch(`${BASE}/api/unattended-work`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ schema: "aos.work-request.v1", ingress: "openmausbot" }),
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "OpenMausBot work ingress is disabled" });

    const encodedStatus = await fetch(`${BASE}/api/unattended-work/${encodeURIComponent("work:123")}`);
    expect(encodedStatus.status).toBe(403);
    await expect(encodedStatus.json()).resolves.toMatchObject({ error: "OpenMausBot work ingress is disabled" });

    const encodedSlash = await fetch(`${BASE}/api/unattended-work/work%2F123`);
    expect(encodedSlash.status).toBe(404);
  });
});
