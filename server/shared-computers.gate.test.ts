import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { createComputerSharing } from "../electron/computer-sharing.mjs";

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

const api = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<ApiResult> => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { origin: BASE, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const parsed: unknown = await res.json().catch(() => ({}));
  return { status: res.status, body: (parsed ?? {}) as Record<string, unknown> };
};

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
    try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch {}
    if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
    await new Promise((wake) => setTimeout(wake, 150));
  }
  botId = String(((await api("POST", "/api/bots", { name: "Gate fixture bot" })).body.bot as { id: string }).id);
}, 60_000);

afterAll(async () => {
  await waitForExit(child, { signal: "SIGTERM" });
  await removeTempDir(home);
});

/** A session paired with these scopes: admin and client is the owner's "everything" code, client alone a narrower one. */
async function paired(scopes: string[]): Promise<{ token: string; id: string }> {
  const opened = await api("POST", "/api/auth/pairing", { label: `Desktop ${scopes.join("+")}`, scopes });
  expect(opened.status).toBe(200);
  const pair = (await api("POST", "/api/auth/pair", { code: opened.body.code })).body as { token: string; session: { id: string } };
  expect(pair.token).toMatch(/^omb_sess_/);
  return { token: pair.token, id: pair.session.id };
}
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const registration = async () => ({ id: randomUUID(), name: "Fixture Mac", environmentId: (await api("GET", "/.well-known/openmausbot/environment")).body.environmentId, folders: [], terminal: false, computer: true });
const connectAs = async (token: string) => api("POST", "/api/shared-computers/connect", await registration(), { ...bearer(token), "x-omb-computer-secret": "a".repeat(64) });

/** The desktop's own lending, signed in to this server with `token` as its pairing. */
function desktop(token: string) {
  const env = { id: "own-server", name: "Gate server", origin: BASE };
  const sharing = createComputerSharing({
    file: join(home, `desktop-${randomUUID()}`, "computer-sharing.json"), environments: () => [env], cuaConnection: async () => null, enabled: async () => false,
    fetch: (url: string, init: RequestInit) => fetch(url, { ...init, headers: { ...(init.headers as Record<string, string>), ...bearer(token) } }),
  });
  return { env, sharing };
}

it("a self-hosted server takes its owner's computer by default: the capability is there with no features block", async () => {
  expect(await descriptorCapabilities()).toMatchObject({ sharedComputers: true });
  const connect = await api("POST", "/api/shared-computers/connect", {});
  expect(connect.status).toBe(403);
  expect(connect.body).toEqual({ error: "Pair this desktop first" });
});

it("takes a computer only from an admin (owner) pairing, never from a narrower one", async () => {
  const member = await paired(["client"]);
  const refused = await connectAs(member.token);
  expect(refused.status).toBe(403);
  expect(String(refused.body.error)).toMatch(/Only this server's owner can share a computer/);
  const owner = await paired(["admin", "client"]);
  expect((await connectAs(owner.token)).status).toBe(200);
});

it("the desktop lends to a server of the person's own once they allow it, with no maintainer flag anywhere, and Stop ends it at once", async () => {
  const owner = await paired(["admin", "client"]);
  const { env, sharing } = desktop(owner.token);
  try {
    expect(await sharing.ownServer(env)).toMatchObject({ sessionId: owner.id });
    const offered = await sharing.ownOffer(env);
    expect(offered).toMatchObject({ sessionId: owner.id });
    const lent = await sharing.lendOwn(env, { computer: true });
    expect(lent).toMatchObject({ enabled: true, own: true, computer: true, terminal: false, folders: [] });
    const listed = async () => ((await api("GET", "/api/shared-computers", undefined, bearer(owner.token))).body.computers ?? []) as Array<{ online: boolean; scopes: { screen: boolean; terminal: boolean } }>;
    await vi.waitFor(async () => expect((await listed()).some((computer) => computer.online && computer.scopes.screen && !computer.scopes.terminal)).toBe(true), { timeout: 15_000 });
    expect(await sharing.ownOffer(env), "answered for this pairing: not asked again").toBeNull();
    sharing.revoke(env);
    await vi.waitFor(async () => expect((await listed()).some((computer) => computer.online)).toBe(false), { timeout: 15_000 });
  } finally { sharing.close(); }
});

it("a narrower pairing is never a server of the person's own: no popup, and nothing is lent", async () => {
  const member = await paired(["client"]);
  const { env, sharing } = desktop(member.token);
  try {
    expect(await sharing.ownServer(env)).toBeNull();
    expect(await sharing.ownOffer(env)).toBe(false);
    await expect(sharing.lendOwn(env, { computer: true })).rejects.toThrow(/Only your own server can use this computer/);
  } finally { sharing.close(); }
});

it("features.sharedComputers true brings the whole surface back, for every paired session", async () => {
  expect((await api("PATCH", "/api/config", { features: { sharedComputers: true } })).status).toBe(200);
  expect((await api("GET", "/api/config")).body.features).toMatchObject({ sharedComputers: true });

  const connect = await api("POST", "/api/shared-computers/connect", {});
  expect(connect.status).toBe(403);
  expect(connect.body).toEqual({ error: "Pair this desktop first" });

  const listed = await internal("GET", "/api/internal/shared-computers");
  expect(listed.status).toBe(200);
  expect(listed.body).toEqual({ computers: [] });
  expect(await api("GET", "/api/shared-computers")).toEqual({ status: 200, body: { computers: [], known: [] } });

  expect(await descriptorCapabilities()).toMatchObject({ sharedComputers: true });
  expect((await connectAs((await paired(["client"])).token)).status).toBe(200);
});

// Last: turning it off ends lending on this server until it restarts (routes/config.ts).
it("features.sharedComputers false turns it all off: every route answers the way a route this build never had answers", async () => {
  expect((await api("PATCH", "/api/config", { features: { sharedComputers: false } })).status).toBe(200);
  // The control: a path with no handler anywhere in the server.
  const absent = await api("POST", "/api/not-a-feature/connect");
  expect(absent.status).toBe(404);
  expect(absent.body).toEqual({ error: "no route: POST /api/not-a-feature/connect" });

  for (const path of PUBLIC_ROUTES) {
    const gated = await api("POST", path, {});
    expect(gated.status, path).toBe(404);
    expect(gated.body, path).toEqual({ error: `no route: POST ${path}` });
  }
  expect(await api("GET", "/api/shared-computers")).toEqual({ status: 404, body: { error: "no route: GET /api/shared-computers" } });
  expect(await descriptorCapabilities()).not.toHaveProperty("sharedComputers");
});

it("with it off, the bot-facing route hides behind the same unknown-endpoint answer", async () => {
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
