// The full server as a Team Cloud: the Admin's signed Team admin read and removal, and the team's default language from
// the Admin. Disposable home; every request but the test's own is offline.
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { cloudPairingSignature, cloudRequestSignature } from "./cloud-home.ts";
import { CLOUD_TEAM_ADMIN_PATH } from "./cloud-team-admin.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const HOST = "omb-t-0123456789ab.fly.dev";
const secret = randomBytes(32).toString("base64url");
const TEAM = { id: "team-7f3a", name: "Acme" };
let home = "", dataDir = "", base = "", log = "";
let child: ChildProcess | null = null;

async function call(method: string, path: string, options: { body?: string; headers?: Record<string, string> } = {}) {
  const response = await fetch(`${base}${path}`, { method, headers: { host: HOST, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https", ...options.headers }, body: options.body });
  return { status: response.status, body: await response.json().catch(() => null) as any };
}
function signed(method: "GET" | "POST", path: string, body = "") {
  const timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomBytes(16).toString("base64url");
  return call(method, path, { ...(body ? { body } : {}), headers: { ...(body ? { "content-type": "application/json" } : {}), "x-omb-cloud-timestamp": timestamp, "x-omb-cloud-nonce": nonce,
    "x-omb-cloud-signature": `v1=${path === "/api/cloud/pairing" ? cloudPairingSignature(secret, timestamp, nonce, body) : cloudRequestSignature(secret, timestamp, nonce, method, path, body)}` } });
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "omb-team-admin-"));
  dataDir = join(home, ".openmausbot");
  mkdirSync(dataDir, { recursive: true });
  const cli = join(home, "fixture-claude.mjs");
  writeFileSync(cli, `#!/usr/bin/env node
if (process.argv[2] === "auth") {
  console.log(JSON.stringify({ loggedIn: true, email: "mira@gmail.com" }));
  process.exit(0);
}
await import(${JSON.stringify(pathToFileURL(join(SERVER_DIR, "testing", "fake-claude-cli.ts")).href)});
`, { mode: 0o755 });
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({
    instances: {
      ...Object.fromEntries(["codex", "cursor", "openaiCompat", "qwen", "hermes", "pi"].map((id) => [id, { driver: "not-a-real-driver" }])),
      claude: { driver: "claudeAgent", displayName: "Claude", config: { cli } },
    },
    treg: { key: "treg-key-never-shown" },
    mcpServers: { linear: { type: "http", url: "https://mcp.linear.app/sse?token=query-never-shown", headers: { Authorization: "Bearer header-never-shown" } } },
  }));
  mkdirSync(join(home, "web"));
  writeFileSync(join(home, "web", "index.html"), "<!doctype html><title>OpenMausBot</title>");
  const port = await freePortBlock([0, 1]);
  base = `http://127.0.0.1:${port}`;
  const prelude = `data:text/javascript,${encodeURIComponent("globalThis.fetch = async () => new Response(\"offline fixture\", { status: 503 });")}`;
  child = spawn(process.execPath, ["--import", prelude, join(SERVER_DIR, "index.ts")], {
    cwd: join(SERVER_DIR, ".."),
    env: {
      PATH: process.env.PATH, ...(process.env.PATHEXT ? { PATHEXT: process.env.PATHEXT } : {}), ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home, USERPROFILE: home, OMB_DATA_DIR: dataDir, OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1), OMB_STATIC_DIR: join(home, "web"),
      OMB_CLOUD_ROLE: "team", OMB_CLOUD_TEAM_ID: TEAM.id, OMB_CLOUD_TEAM_NAME: TEAM.name, OMB_CLOUD_TEAM_LANGUAGE: "de",
      OMB_CLOUD_MACHINE_ID: "3f9c2a4e-8b1d-4c6e-9a7f-2d5e8c1b0a93", OMB_CLOUD_ADMIN_URL: "https://cloud.example.test", OMB_CLOUD_BOOTSTRAP_SECRET: secret, OMB_PUBLIC_URL: `https://${HOST}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => { log += chunk; });
  child.stderr?.on("data", (chunk) => { log += chunk; });
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`the Team Cloud exited:\n${log}`);
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
    if (Date.now() > deadline) throw new Error(`the Team Cloud did not start:\n${log}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}, 45_000);

afterAll(async () => {
  if (child && child.exitCode === null) { child.kill("SIGTERM"); await waitForExit(child); }
  if (home) removeTempDir(home);
});

it("the Admin reads a Team Cloud's shared connections and AI by a signed request, with no key, header value or MCP address in the answer", async () => {
  let summary: any;
  await expect.poll(async () => {
    summary = (await signed("GET", CLOUD_TEAM_ADMIN_PATH)).body;
    return summary?.ai?.engines?.find((engine: { id: string }) => engine.id === "claude")?.authenticated;
  }, { timeout: 20_000, interval: 200 }).toBe(true);
  expect(summary.mcp).toEqual([{ name: "linear", transport: "http", host: "mcp.linear.app", enabled: true, signedIn: null, secrets: ["Authorization"] }]);
  expect(summary.keys.find((key: { id: string }) => key.id === "treg")).toEqual({ id: "treg", configured: true });
  expect(summary.ai.engines.find((engine: { id: string }) => engine.id === "claude")).toMatchObject({ name: "Claude", authenticated: true, account: { email: "mira@gmail.com" } });
  expect(JSON.stringify(summary)).not.toMatch(/never-shown|token=|Bearer/);
  // Unsigned, or with any other key: nothing.
  expect((await call("GET", CLOUD_TEAM_ADMIN_PATH)).status).toBe(401);
}, 30_000);

it("an Owner or Admin's paired session (as the Admin holds one) sets a team key and removes an MCP server through the app's own routes; a User's can't; the team's default language is the server's until it sets its own", async () => {
  const session = async (role: string) => {
    const granted = await signed("POST", "/api/cloud/pairing", JSON.stringify({ label: "Team admin (MausBot Cloud)", ttlSeconds: 300, team: TEAM, member: { email: `${role}@acme.test`, role } }));
    const token = (await call("POST", "/api/auth/pair", { body: JSON.stringify({ code: granted.body.code }), headers: { "content-type": "application/json" } })).body.token as string;
    return (method: string, path: string, body?: unknown) => call(method, path, { ...(body === undefined ? {} : { body: JSON.stringify(body) }), headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) } });
  };
  // Only admins so far: a Team Cloud keeps its admin activity anyway (it is shared by definition).
  const admin = await session("admin");
  expect((await admin("PATCH", "/api/config", { openai: { key: "sk-team-key-never-shown" } })).status).toBe(200);
  let activity: Awaited<ReturnType<typeof admin>> | undefined;
  await expect.poll(async () => {
    activity = await admin("GET", "/api/admin-activity?what=all");
    return activity.body.entries.some((entry: { type: string; who: string; action: string }) => entry.type === "admin" && entry.who.includes("admin@acme.test") && entry.action === "config.update");
  }, { timeout: 5_000, interval: 100 }).toBe(true);
  expect(JSON.stringify(activity!.body)).not.toContain("never-shown");
  const user = await session("member");
  expect((await user("PATCH", "/api/config", { openai: { key: "sk-user-never-saved" } })).status).toBe(403);
  expect((await user("DELETE", "/api/mcp/servers/linear")).status).toBe(403);
  expect((await admin("DELETE", "/api/mcp/servers/linear")).status).toBe(200);
  const summary = (await signed("GET", CLOUD_TEAM_ADMIN_PATH)).body;
  expect([summary.ai.keys.find((key: { id: string }) => key.id === "openai"), summary.mcp]).toEqual([{ id: "openai", configured: true }, []]);
  expect(JSON.stringify(summary)).not.toContain("never-shown");
  const saved = JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8"));
  expect([saved.openai?.key, saved.mcpServers, saved.language]).toEqual(["sk-team-key-never-shown", {}, undefined]);
  // The language is the team's (OMB_CLOUD_TEAM_LANGUAGE), though config.json sets none.
  const settings = await admin("GET", "/api/config");
  expect([settings.status, settings.body.language]).toEqual([200, "de"]);
}, 30_000);
