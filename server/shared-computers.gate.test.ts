// The opt-in computer-sharing feature ships OFF (features.sharedComputers,
// server/config.ts). This file proves what "off" means on the wire: every
// route of the family answers exactly the way a route this build never had
// answers, so a probe cannot tell a disabled feature from an absent one —
// and that turning the flag on brings the same routes back.
//
// Same harness as the other shared-computer tests: a real server on a
// throwaway home, a scripted fake CLI, and the test-only capability mint the
// bot-facing /api/internal routes need.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE_CLI = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const TEST_CAPABILITY_KEY = "shared-computer-gate-fixture-capability";

let PORT = 0;
let WEBHOOK_PORT = 0;
let BASE = "";
let home = "";
let child: ChildProcess;
let stderr = "";
let botId = "";

interface ApiResult { status: number; body: Record<string, unknown> }

const api = async (method: string, path: string, body?: unknown): Promise<ApiResult> => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { origin: BASE, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const parsed: unknown = await res.json().catch(() => ({}));
  return { status: res.status, body: (parsed ?? {}) as Record<string, unknown> };
};

/** A bot's own agent process, spoken for by the test-only capability mint. */
const internal = async (method: string, path: string, body?: unknown): Promise<ApiResult> => {
  const minted = await fetch(`${BASE}/api/testing/internal-capability`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-openmausbot-test-capability": TEST_CAPABILITY_KEY },
    body: JSON.stringify({ botId, threadId: botId, kind: "agents" }),
  });
  const { token } = await minted.json() as { token: string };
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const parsed: unknown = await res.json().catch(() => ({}));
  return { status: res.status, body: (parsed ?? {}) as Record<string, unknown> };
};

const descriptorCapabilities = async (): Promise<Record<string, unknown>> =>
  ((await api("GET", "/.well-known/openmausbot/environment")).body.capabilities ?? {}) as Record<string, unknown>;

/** Every public route of the family, plus a path this build genuinely has no
 * handler for — the control the disabled routes must be identical to. */
const PUBLIC_ROUTES = [
  "/api/shared-computers/connect",
  "/api/shared-computers/11111111-1111-4111-8111-111111111111/poll",
  "/api/shared-computers/11111111-1111-4111-8111-111111111111/lease",
  "/api/shared-computers/11111111-1111-4111-8111-111111111111/result",
  "/api/shared-computers/11111111-1111-4111-8111-111111111111/disconnect",
  "/api/desktop/shared-computer-control",
];

beforeAll(async () => {
  const base = await freePortBlock([0, 1]);
  PORT = base;
  WEBHOOK_PORT = base + 1;
  BASE = `http://127.0.0.1:${PORT}`;
  home = mkdtempSync(join(tmpdir(), "omb-shared-computer-gate-"));
  mkdirSync(join(home, ".openmausbot"), { recursive: true });
  // No `features` block at all: the shipped default.
  writeFileSync(join(home, ".openmausbot", "config.json"), JSON.stringify({
    instances: { claude: { driver: "claudeAgent", displayName: "Gate fixture", config: { cli: FAKE_CLAUDE_CLI } } },
  }));
  child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: join(SERVER_DIR, ".."),
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home,
      USERPROFILE: home,
      OMB_PORT: String(PORT),
      OMB_WEBHOOK_PORT: String(WEBHOOK_PORT),
      OMB_TEST_INTERNAL_CAPABILITY_KEY: TEST_CAPABILITY_KEY,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr?.on("data", (chunk) => (stderr += String(chunk)));
  const deadline = Date.now() + 20_000;
  for (;;) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
    await new Promise((wake) => setTimeout(wake, 150));
  }
  botId = String(((await api("POST", "/api/bots", { name: "Gate fixture bot" })).body.bot as { id: string }).id);
}, 60_000);

afterAll(async () => {
  await waitForExit(child, { signal: "SIGTERM" });
  await removeTempDir(home);
});

it("answers every shared-computer route the way a route this build never had answers", async () => {
  // The control: a path with no handler anywhere in the server.
  const absent = await api("POST", "/api/not-a-feature/connect");
  expect(absent.status).toBe(404);
  expect(absent.body).toEqual({ error: "no route: POST /api/not-a-feature/connect" });

  for (const path of PUBLIC_ROUTES) {
    const gated = await api("POST", path, {});
    expect(gated.status, path).toBe(404);
    // Byte-identical, down to the echoed method and path: nothing here says
    // "disabled", "not enabled", or "pair this desktop first".
    expect(gated.body, path).toEqual({ error: `no route: POST ${path}` });
  }
});

it("hides the bot-facing route behind the same unknown-endpoint answer", async () => {
  const control = await internal("GET", "/api/internal/not-a-feature");
  expect(control.status).toBe(404);
  expect(control.body).toEqual({ error: "unknown internal endpoint" });

  const listed = await internal("GET", "/api/internal/shared-computers");
  expect(listed.status).toBe(404);
  expect(listed.body).toEqual({ error: "unknown internal endpoint" });

  const used = await internal("POST", "/api/internal/shared-computers", { computer_id: "x", action: "list_files" });
  expect(used.status).toBe(404);
  expect(used.body).toEqual({ error: "unknown internal endpoint" });
});

it("advertises no sharedComputers capability while the gate is off", async () => {
  expect(await descriptorCapabilities()).not.toHaveProperty("sharedComputers");
});

it("brings the whole surface back when features.sharedComputers is turned on", async () => {
  expect((await api("PATCH", "/api/config", { features: { sharedComputers: true } })).status).toBe(200);
  expect((await api("GET", "/api/config")).body.features).toMatchObject({ sharedComputers: true });

  // The route exists again: loopback is not a paired desktop session, so it
  // is refused on authority — a different answer from "no such route".
  const connect = await api("POST", "/api/shared-computers/connect", {});
  expect(connect.status).toBe(403);
  expect(connect.body).toEqual({ error: "Pair this desktop first" });

  const listed = await internal("GET", "/api/internal/shared-computers");
  expect(listed.status).toBe(200);
  expect(listed.body).toEqual({ computers: [] });

  expect(await descriptorCapabilities()).toMatchObject({ sharedComputers: true });
});
