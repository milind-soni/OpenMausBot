// The full server as an OMB Cloud home machine, over its real HTTP boundary,
// with the settings an Admin from before Cloud Pro dropped included AI still
// sent (OMB_HOSTED_*). Cloud Pro includes no AI: the machine boots, says once
// that it ignores them, serves no gateway models, never hands them (or its
// signing secret) to an engine, and tells the app it pairs that its first run
// is the engine sign-in. Disposable home; no network; a synthetic Claude CLI.
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { CLOUD_IGNORED_KEYS, cloudPairingSignature } from "./cloud-home.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const HOST = "omb-t-0123456789ab.fly.dev";
const secret = randomBytes(32).toString("base64url");
const token = `omb_cloudai_${randomBytes(32).toString("base64url")}`;
const gateway = {
  OMB_HOSTED_MODEL_URL: "https://cloud.example.test/api/cloud/gateway/g0123456789abcdef0123456789abcd",
  OMB_HOSTED_MODEL_TOKEN: token,
  OMB_HOSTED_MODELS: JSON.stringify({ anthropic: [], openai: ["gpt-fixture"], openrouter: ["anthropic/claude-fixture"] }),
};
let home: string;
let base: string;
let child: ChildProcess;
let log = "";

async function api(method: string, path: string, options: { body?: unknown; remote?: boolean; headers?: Record<string, string> } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      // What the Caddy edge adds to every request it forwards: never the owner.
      ...(options.remote ? { host: HOST, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https" } : {}),
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...options.headers,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { status: response.status, body: await response.json().catch(() => null) as any };
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "omb-cloud-home-server-"));
  const dataDir = join(home, ".openmausbot");
  mkdirSync(dataDir, { recursive: true });
  // A signed-in Claude Code whose turns record the environment they were given.
  const cli = join(home, "fixture-claude.mjs");
  writeFileSync(cli, `#!/usr/bin/env node
if (process.argv[2] === "auth") {
  console.log(JSON.stringify({ loggedIn: true, email: "person@example.test" }));
  process.exit(0);
}
if (process.argv[2] !== "--version") process.env.FAKE_CLAUDE_DUMP = ${JSON.stringify(join(home, "spawn.json"))};
await import(${JSON.stringify(pathToFileURL(join(SERVER_DIR, "testing", "fake-claude-cli.ts")).href)});
`, { mode: 0o755 });
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({
    instances: {
      // Pin the fleet's other defaults so this never probes an installed CLI.
      ...Object.fromEntries(["codex", "cursor", "openaiCompat", "qwen", "hermes", "pi"].map((id) => [id, { driver: "not-a-real-driver" }])),
      claude: { driver: "claudeAgent", displayName: "Claude", config: { cli } },
    },
  }));
  const port = await freePortBlock([0, 1]);
  base = `http://127.0.0.1:${port}`;
  const offlinePrelude = `data:text/javascript,${encodeURIComponent('globalThis.fetch = async () => new Response("offline fixture", { status: 503 });')}`;
  child = spawn(process.execPath, ["--import", offlinePrelude, join(SERVER_DIR, "index.ts")], {
    cwd: join(SERVER_DIR, ".."),
    env: {
      PATH: process.env.PATH,
      ...(process.env.PATHEXT ? { PATHEXT: process.env.PATHEXT } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home, USERPROFILE: home, OMB_DATA_DIR: dataDir, OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1),
      OMB_CLOUD_ROLE: "home", OMB_CLOUD_MACHINE_ID: "3f9c2a4e-8b1d-4c6e-9a7f-2d5e8c1b0a93", OMB_CLOUD_ADMIN_URL: "https://cloud.example.test",
      OMB_CLOUD_BOOTSTRAP_SECRET: secret, OMB_PUBLIC_URL: `https://${HOST}`,
      ...gateway,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => { log += chunk; });
  child.stderr?.on("data", (chunk) => { log += chunk; });
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`the Cloud home exited:\n${log}`);
    try { if ((await api("GET", "/api/health")).body?.pid === child.pid) break; } catch { /* starting */ }
    if (Date.now() > deadline) throw new Error(`the Cloud home did not start:\n${log}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}, 30_000);

afterAll(async () => {
  if (child) await waitForExit(child, { signal: "SIGTERM" });
  if (home) await removeTempDir(home);
});

it("boots with a gateway's settings, says once that it ignores them, and never logs them", () => {
  expect(log.match(/cloud home: ignoring OMB_HOSTED_MODEL_URL, OMB_HOSTED_MODEL_TOKEN, OMB_HOSTED_MODELS: Cloud Pro includes no AI/g)).toHaveLength(1);
  expect(log).not.toContain(token);
  expect(log).not.toContain(secret);
});

it("pairs the app on a signed request and tells it its first run is the engine sign-in; no gateway models are served", async () => {
  const body = JSON.stringify({ label: "OpenMausBot app (Cloud)", ttlSeconds: 300 });
  const timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomBytes(16).toString("base64url");
  const granted = await api("POST", "/api/cloud/pairing", { remote: true, headers: {
    "content-type": "application/json", "x-omb-cloud-timestamp": timestamp, "x-omb-cloud-nonce": nonce,
    "x-omb-cloud-signature": `v1=${cloudPairingSignature(secret, timestamp, nonce, body)}`,
  }, body: JSON.parse(body) });
  expect(granted.status, JSON.stringify(granted.body)).toBe(200);
  const paired = await api("POST", "/api/auth/pair", { remote: true, body: { code: granted.body.code } });
  expect(paired.status, JSON.stringify(paired.body)).toBe(200);
  const auth = { authorization: `Bearer ${paired.body.token}` };
  const session = await api("GET", "/api/auth/session", { remote: true, headers: auth });
  expect(session.body).toMatchObject({ kind: "session", scopes: ["admin", "client"], cloudHome: true });
  expect(session.body).not.toHaveProperty("hosted");
  const { instances } = (await api("GET", "/api/instances", { remote: true, headers: auth })).body;
  expect(instances.map((instance: any) => instance.instanceId)).toContain("claude");
  expect(instances.filter((instance: any) => instance.instanceId.startsWith("included.") || "included" in instance || instance.readOnly)).toEqual([]);
  expect(JSON.stringify(instances)).not.toContain("cloud.example.test");
});

it("never hands a gateway's settings or the signing secret to an engine", async () => {
  const created = await api("POST", "/api/bots", { body: {
    name: "Cloud fixture", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" }, requireAvailableModel: true,
  } });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  expect((await api("POST", `/api/bots/${created.body.bot.id}/messages`, { body: { text: "hello" } })).status).toBe(202);
  const dump = join(home, "spawn.json");
  await expect.poll(() => existsSync(dump), { timeout: 15_000 }).toBe(true);
  const { env } = JSON.parse(readFileSync(dump, "utf8"));
  expect(env.HOME).toBe(home);
  for (const key of [...CLOUD_IGNORED_KEYS, "OMB_CLOUD_BOOTSTRAP_SECRET"]) expect(env).not.toHaveProperty(key);
  expect(JSON.stringify(env)).not.toContain(token);
  expect(JSON.stringify(env)).not.toContain(secret);
});
