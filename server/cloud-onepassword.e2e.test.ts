// A real server started the way a Cloud home's root supervisor starts it: the environment is what cloudHomeChildEnvironments
// hands the server from the image's ENV, and the secrets come over the launcher's pipe. The 1Password SDK is a fake kept
// where the image keeps the real one, in the native-module tree OMB_DUCKDB_DIR names. Disposable home; no network.
import { randomBytes } from "node:crypto";
import { type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { cloudHomeConfiguration, cloudPairingSignature } from "./cloud-home.ts";
import { cloudHomeChildEnvironments, spawnWithSecrets } from "./cloud-home-start.ts";
import { ONE_PASSWORD_REFUSED } from "./onepassword.ts";
import { LOGIN_ERRORS } from "./routes/logins.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { hostTimeout } from "./testing/host-timeout.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const HOST = "omb-t-0123456789ab.fly.dev";
// Obvious fakes only.
const TOKEN = `ops_fake-cloud-service-account-${randomBytes(12).toString("hex")}`;
const VAULT_PASSWORD = `fake-vault-Passw0rd-${randomBytes(6).toString("hex")}`;
const secret = randomBytes(32).toString("base64url");
let home = "";
let base = "";
let child: ChildProcess;
let log = "";
let owner = "";
const answers: string[] = [];
const proxies: ChildProcess[] = [];

async function api(method: string, path: string, body?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      // What the Caddy edge adds: every network request is remote.
      host: HOST, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https", origin: `https://${HOST}`,
      ...(owner ? { authorization: `Bearer ${owner}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  answers.push(text);
  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch {}
  return { status: response.status, body: parsed };
}

async function pairOwner(): Promise<string> {
  const body = JSON.stringify({ label: "OpenMausBot app (Cloud)", ttlSeconds: 300 });
  const timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomBytes(16).toString("base64url");
  const response = await fetch(`${base}/api/cloud/pairing`, { method: "POST", headers: {
    host: HOST, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https", "content-type": "application/json",
    "x-omb-cloud-timestamp": timestamp, "x-omb-cloud-nonce": nonce, "x-omb-cloud-signature": `v1=${cloudPairingSignature(secret, timestamp, nonce, body)}`,
  }, body });
  const granted = await response.json() as { code: string };
  const paired = await api("POST", "/api/auth/pair", { code: granted.code });
  expect(paired.status, JSON.stringify(paired.body)).toBe(200);
  return paired.body.token;
}

/** The image's native-module tree, holding a fake SDK that answers the way @1password/sdk 0.5.0 does. */
function imageTree(root: string): string {
  const sdk = join(root, "node_modules", "@1password", "sdk");
  mkdirSync(sdk, { recursive: true });
  writeFileSync(join(sdk, "package.json"), JSON.stringify({ name: "@1password/sdk", version: "0.5.0", main: "index.js" }));
  writeFileSync(join(sdk, "index.js"), `"use strict";
const TOKEN = ${JSON.stringify(TOKEN)};
const fields = [{ id: "username", title: "username", fieldType: "Text", value: "person@example.test" },
  { id: "password", title: "password", fieldType: "Concealed", value: ${JSON.stringify(VAULT_PASSWORD)} }];
exports.createClient = async ({ auth }) => {
  if (auth.length < 24) throw new Error("invalid user input: encountered the following errors: service account token had invalid format");
  if (auth !== TOKEN) throw new Error("error authenticating: invalid service account token");
  return {
    vaults: { list: async () => [{ id: "v1", title: "Shared with OpenMausBot" }] },
    items: {
      list: async () => [{ id: "i1", title: "CRM", category: "Login", websites: [{ url: "https://crm.example.test/login" }] }],
      getAll: async (vaultId, ids) => ({ individualResponses: ids.map((id) => ({ content: { id, fields } })) }),
    },
  };
};
`);
  return root;
}

async function proxyFor(start: () => Promise<void>) {
  const dump = join(home, "spawn.json");
  await start();
  let agents: { command: string; args: string[]; env: Record<string, string> } | undefined;
  await expect.poll(() => {
    try { agents = JSON.parse(readFileSync(dump, "utf8")).mcpConfig.mcpServers.agents; return true; } catch { return false; }
  }, { timeout: 15_000 }).toBe(true);
  const proxy = spawn(agents!.command, agents!.args, { env: { PATH: process.env.PATH, HOME: home, ...agents!.env }, stdio: ["pipe", "pipe", "pipe"] });
  proxies.push(proxy);
  const replies = new Map<number, (value: any) => void>();
  createInterface({ input: proxy.stdout! }).on("line", (line) => { const message = JSON.parse(line); replies.get(message.id)?.(message.result); replies.delete(message.id); });
  let next = 0;
  const request = (method: string, params: unknown): Promise<any> => new Promise((resolve) => {
    const id = ++next; replies.set(id, resolve);
    proxy.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  await request("initialize", { protocolVersion: "2024-11-05" });
  return { call: (name: string, args: unknown = {}) => request("tools/call", { name, arguments: args }), list: () => request("tools/list", {}) };
}

/** The server alone, as the supervisor starts it; resolves once it answers health. */
async function startCloudHome(at: string, tree: string, port: number, onLog: (chunk: string) => void): Promise<ChildProcess> {
  const contract = { OMB_CLOUD_ROLE: "home", OMB_CLOUD_MACHINE_ID: "3f9c2a4e-8b1d-4c6e-9a7f-2d5e8c1b0a93", OMB_CLOUD_ADMIN_URL: "https://cloud.example.test",
    OMB_CLOUD_BOOTSTRAP_SECRET: secret, OMB_PUBLIC_URL: `https://${HOST}` };
  // What the image's ENV sets for the native modules, then the supervisor's own allow-list and secrets pipe.
  const imageEnv = { PATH: process.env.PATH, OMB_DUCKDB_DIR: tree, ...contract };
  const { server, secrets } = cloudHomeChildEnvironments(cloudHomeConfiguration(imageEnv)!, imageEnv, at);
  const offline = `data:text/javascript,${encodeURIComponent('const real = globalThis.fetch; globalThis.fetch = async (url, init) => String(url).startsWith("http://127.0.0.1:") ? real(url, init) : new Response("offline fixture", { status: 503 });')}`;
  const started = spawnWithSecrets(process.execPath, ["--import", offline, join(SERVER_DIR, "index.ts")], {
    ...server, OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1), USERPROFILE: at,
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  }, secrets, null, true);
  let seen = "";
  const capture = (chunk: Buffer) => { seen += chunk; onLog(String(chunk)); };
  started.stdout?.on("data", capture);
  started.stderr?.on("data", capture);
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (started.exitCode !== null) throw new Error(`the Cloud home exited:\n${seen}`);
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return started; } catch {}
    if (Date.now() > deadline) throw new Error(`the Cloud home did not start:\n${seen}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "omb-cloud-1password-"));
  const dataDir = join(home, ".openmausbot");
  mkdirSync(dataDir, { recursive: true });
  const cli = join(home, "fixture-claude.mjs");
  writeFileSync(cli, `#!/usr/bin/env node
if (process.argv[2] === "auth") { console.log(JSON.stringify({ loggedIn: true, email: "person@example.test" })); process.exit(0); }
process.env.FAKE_CLAUDE_VERSION = "2.1.284";
if (process.argv[2] !== "--version") { process.env.FAKE_CLAUDE_DUMP = ${JSON.stringify(join(home, "spawn.json"))}; process.env.FAKE_CLAUDE_MODE = "hang"; }
await import(${JSON.stringify(pathToFileURL(join(SERVER_DIR, "testing", "fake-claude-cli.ts")).href)});
`, { mode: 0o755 });
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ instances: {
    ...Object.fromEntries(["codex", "cursor", "githubCopilot", "openaiCompat", "qwen", "hermes", "pi", "grok"].map((id) => [id, { driver: "not-a-real-driver" }])),
    claude: { driver: "claudeAgent", displayName: "Claude", config: { cli } },
  } }));
  const port = await freePortBlock([0, 1]);
  base = `http://127.0.0.1:${port}`;
  child = await startCloudHome(home, imageTree(join(home, "app-duckdb")), port, (chunk) => { log += chunk; });
  owner = await pairOwner();
}, hostTimeout(30_000));

afterAll(async () => {
  for (const proxy of proxies) proxy.kill();
  if (child) await waitForExit(child, { signal: "SIGTERM" });
  if (home) await removeTempDir(home);
});

it("when an image lacks the SDK, says so plainly and never blames the token", async () => {
  const other = mkdtempSync(join(tmpdir(), "omb-cloud-1password-missing-"));
  const port = await freePortBlock([0, 1]);
  let missingLog = "";
  const started = await startCloudHome(other, join(other, "empty-tree"), port, (chunk) => { missingLog += chunk; });
  const previous = { base, owner };
  try {
    base = `http://127.0.0.1:${port}`;
    owner = "";
    owner = await pairOwner();
    const refused = await api("POST", "/api/logins/1password", { token: TOKEN });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/^1Password could not start on this server, so your token was not checked/u);
    expect(missingLog).toContain("1Password: the SDK did not load: Cannot find module '@1password/sdk'");
    expect(missingLog).not.toContain(TOKEN);
  } finally {
    ({ base, owner } = previous);
    await waitForExit(started, { signal: "SIGTERM" });
    await removeTempDir(other);
  }
});

it("connects a 1Password service account on a Cloud home, and says plainly what is wrong with a token that is not one", async () => {
  expect((await api("POST", "/api/logins/1password", { token: "eyJhbGciOiJFUzI1NiJ9.fake-connect-token" })).body.error).toBe(LOGIN_ERRORS.notServiceAccount);
  expect((await api("POST", "/api/logins/1password", { token: `ops_wrong-${"x".repeat(30)}` })).body.error).toBe(ONE_PASSWORD_REFUSED);
  expect((await api("POST", "/api/logins/1password", { token: "ops_short" })).body.error).toMatch(/^That is not a whole 1Password service account token/u);
  const connected = await api("POST", "/api/logins/1password", { token: TOKEN });
  expect(connected, log).toMatchObject({ status: 200, body: { onePassword: { connected: true, vaults: [{ id: "v1", title: "Shared with OpenMausBot", items: 1 }], items: 1 } } });
  expect((await api("GET", "/api/logins")).body.logins).toEqual([expect.objectContaining({ site: "example.test", username: "person@example.test", source: "1password" })]);
  expect(log).not.toContain("SDK did not load");
  expect(log).not.toContain("not available in this build");
  for (const where of [...answers, log]) {
    expect(where).not.toContain(TOKEN);
    expect(where).not.toContain(VAULT_PASSWORD);
  }
});

it("a bot asks for the 1Password token through request_credential's own slot, and the card's save through Logins counts", async () => {
  expect((await api("DELETE", "/api/logins/1password")).body.onePassword).toEqual({ connected: false });
  const bot = (await api("POST", "/api/bots", { name: "Ledger", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } })).body.bot;
  const tools = await proxyFor(async () => {
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "Sign in to the CRM with my 1Password." })).status).toBe(202);
  });
  const listed = (await tools.list()).tools.find((tool: any) => tool.name === "request_credential");
  expect(listed.inputSchema.properties.credential_id.enum).toContain("onePasswordToken");
  const asked = await tools.call("request_credential", { credential_id: "onePasswordToken", reason: "To sign in to the CRM." });
  expect(asked.isError).toBeFalsy();
  expect(asked.content[0].text).toMatch(/^A secure 1Password service account token request is ready/u);
  expect(asked.content[0].text).toContain("Never ask them to paste the token into chat");
  const card = (await api("GET", `/api/threads/${bot.threadId}/messages`)).body.messages.find((message: any) => message.kind === "secret");
  expect(card.secret).toMatchObject({ target: "onePasswordToken", label: "1Password service account token", placeholder: "ops_…" });
  const provided = () => api("POST", `/api/bots/${bot.id}/secret-cards/${card.id}/provided`, { threadId: bot.threadId });
  expect(await provided()).toMatchObject({ status: 409, body: { error: "1Password service account token was not saved yet" } });
  // What the card sends: the token goes to Logins, never the settings file or the chat.
  expect((await api("POST", "/api/logins/1password", { token: TOKEN })).status).toBe(200);
  expect(await provided()).toMatchObject({ status: 200, body: { provided: true } });
  expect((await tools.call("request_credential", { credential_id: "onePasswordToken" })).content[0].text).toBe("1Password service account token is already configured. Continue the task.");
  expect(readFileSync(join(home, ".openmausbot", "config.json"), "utf8")).not.toContain(TOKEN);
  for (const where of [...answers, log]) expect(where).not.toContain(TOKEN);
});
