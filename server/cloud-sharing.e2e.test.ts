// The real server on one data folder, booted as a Cloud home, then as a self-hosted server where a second person pairs,
// then as the Cloud home again: what existed while only the owner used it stays at the bot's level, what the guest's
// conversation made is confined, and the Cloud stays shared for good.
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, expect, it } from "vitest";
import { cloudPairingSignature } from "./cloud-home.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { hostTimeout } from "./testing/host-timeout.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const HOST = "omb-t-0123456789ab.fly.dev";
const MACHINE_ID = "3f9c2a4e-8b1d-4c6e-9a7f-2d5e8c1b0a93";
const secret = randomBytes(32).toString("base64url");
const home = mkdtempSync(join(tmpdir(), "omb-cloud-sharing-"));
const dataDir = join(home, ".openmausbot");
const dump = join(home, "claude.json");
let base = "";
let port = 0;
let cloud = true;
let child: ChildProcess | undefined;
let log = "";
const proxies: ChildProcess[] = [];

afterAll(async () => {
  for (const proxy of proxies) proxy.kill();
  if (child) await waitForExit(child, { signal: "SIGTERM" });
  await removeTempDir(home);
});

async function api(method: string, path: string, options: { body?: unknown; token?: string } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(cloud ? { host: HOST, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https", origin: `https://${HOST}` } : {}),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { status: response.status, body: await response.json().catch(() => null) as any };
}

async function boot(asCloud: boolean) {
  cloud = asCloud;
  log = "";
  const offline = `data:text/javascript,${encodeURIComponent('const real = globalThis.fetch; globalThis.fetch = async (url, init) => String(url).startsWith("http://127.0.0.1:") ? real(url, init) : new Response("offline fixture", { status: 503 });')}`;
  child = spawn(process.execPath, ["--import", offline, join(SERVER_DIR, "index.ts")], {
    cwd: join(SERVER_DIR, ".."),
    env: {
      PATH: process.env.PATH, HOME: home, USERPROFILE: home, OMB_DATA_DIR: dataDir, OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1),
      ...(asCloud ? { OMB_CLOUD_ROLE: "home", OMB_CLOUD_MACHINE_ID: MACHINE_ID, OMB_CLOUD_ADMIN_URL: "https://cloud.example.test",
        OMB_CLOUD_BOOTSTRAP_SECRET: secret, OMB_PUBLIC_URL: `https://${HOST}` } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [child.stdout, child.stderr]) stream?.on("data", (chunk) => { log += chunk; });
  const deadline = Date.now() + 25_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`the server exited:\n${log}`);
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
    if (Date.now() > deadline) throw new Error(`the server did not start:\n${log}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
async function shutdown() {
  for (const proxy of proxies.splice(0)) proxy.kill();
  await waitForExit(child, { signal: "SIGTERM" });
  child = undefined;
}

async function ownersDevice(): Promise<string> {
  const body = JSON.stringify({ label: "OpenMausBot app (Cloud)", ttlSeconds: 300 });
  const timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomBytes(16).toString("base64url");
  const response = await fetch(`${base}/api/cloud/pairing`, { method: "POST", headers: {
    host: HOST, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https", "content-type": "application/json",
    "x-omb-cloud-timestamp": timestamp, "x-omb-cloud-nonce": nonce, "x-omb-cloud-signature": `v1=${cloudPairingSignature(secret, timestamp, nonce, body)}`,
  }, body });
  const granted = await response.json() as { code: string };
  return (await api("POST", "/api/auth/pair", { body: { code: granted.code } })).body.token;
}

const idle = (botId: string, token?: string) => expect.poll(async () => (await api("GET", "/api/bots", { token })).body.bots.find((bot: any) => bot.id === botId)?.busy,
  { timeout: hostTimeout(15_000) }).toBe(false);
const release = async (botId: string, token?: string) => {
  writeFileSync(join(home, "release"), "");
  await idle(botId, token);
  rmSync(join(home, "release"), { force: true });
};

async function agentTools() {
  const agents = JSON.parse(readFileSync(dump, "utf8")).mcpConfig.mcpServers.agents;
  const proxy = spawn(agents.command, agents.args, { env: { PATH: process.env.PATH, HOME: home, ...agents.env }, stdio: ["pipe", "pipe", "pipe"] });
  proxies.push(proxy);
  const replies = new Map<number, (value: any) => void>();
  createInterface({ input: proxy.stdout! }).on("line", (line) => { const msg = JSON.parse(line); replies.get(msg.id)?.(msg.result ?? msg); replies.delete(msg.id); });
  let next = 0;
  const request = (method: string, params: unknown): Promise<any> => new Promise((resolve) => {
    const id = ++next; replies.set(id, resolve);
    proxy.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  await request("initialize", { protocolVersion: "2024-11-05" });
  return async (name: string, args: unknown) => JSON.stringify(await request("tools/call", { name, arguments: args }));
}

/** In a new conversation, the bot makes itself a routine from what this person asked. */
async function routineFrom(botId: string, name: string, token?: string) {
  const threadId = (await api("POST", `/api/bots/${botId}/tasks`, { token, body: { title: name } })).body.task.threadId as string;
  rmSync(dump, { force: true });
  expect((await api("POST", `/api/bots/${botId}/messages`, { token, body: { text: `Every hour: ${name}.`, threadId } })).status).toBe(202);
  await expect.poll(() => existsSync(dump), { timeout: hostTimeout(15_000) }).toBe(true);
  const applied = await (await agentTools())("create_trigger", { when: "schedule", name, instructions: `${name}.`, schedule: { type: "interval", every_minutes: 60 } });
  await release(botId, token);
  const id = /trigger id ([\w-]+)/.exec(applied)?.[1];
  expect(id, applied).toBeTruthy();
  return id!;
}

async function runArgv(routineId: string, token: string) {
  rmSync(dump, { force: true });
  expect((await api("POST", `/api/routines/${routineId}/run`, { token })).status).toBe(201);
  await expect.poll(() => existsSync(dump), { timeout: hostTimeout(15_000) }).toBe(true);
  return JSON.parse(readFileSync(dump, "utf8")).argv as string[];
}
const record = () => JSON.parse(readFileSync(join(dataDir, "cloud-owner.json"), "utf8"));
const writers = () => JSON.parse(readFileSync(join(dataDir, "lending-routines.json"), "utf8")).writers as Record<string, string>;

it("keeps what the owner made alone at the bot's level once a second person has used the Cloud, confines what that person's conversation made, and stays shared", async () => {
  mkdirSync(dataDir, { recursive: true });
  const cli = join(home, "held-claude.mjs");
  writeFileSync(cli, `#!/usr/bin/env node
if (process.argv[2] === "auth") { console.log(JSON.stringify({ loggedIn: true, email: "person@example.test" })); process.exit(0); }
process.env.FAKE_CLAUDE_VERSION = "2.1.284";
if (process.argv[2] !== "--version") { process.env.FAKE_CLAUDE_DUMP = ${JSON.stringify(dump)}; process.env.FAKE_CLAUDE_MODE = "hang"; process.env.FAKE_CLAUDE_RELEASE = ${JSON.stringify(join(home, "release"))}; }
await import(${JSON.stringify(pathToFileURL(join(SERVER_DIR, "testing", "fake-claude-cli.ts")).href)});
`, { mode: 0o755 });
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({
    instances: {
      ...Object.fromEntries(["codex", "cursor", "githubCopilot", "openaiCompat", "qwen", "hermes", "pi"].map((id) => [id, { driver: "not-a-real-driver" }])),
      claude: { driver: "claudeAgent", displayName: "Claude", config: { cli } },
    },
  }));
  port = await freePortBlock([0, 1]);
  base = `http://127.0.0.1:${port}`;

  // 1. The owner's Cloud, used by nobody else.
  await boot(true);
  let owner = await ownersDevice();
  const bot = (await api("POST", "/api/bots", { token: owner, body: { name: "Brief", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } } })).body.bot;
  await shutdown();
  expect(record()).toMatchObject({ peopleChecked: true });

  // 2. The same folder on a self-hosted server: the owner's desktop lines carry no sender; then a guest pairs and asks for one too.
  await boot(false);
  const desktop = await routineFrom(bot.id, "Summarise the desktop notes");
  const opened = await api("POST", "/api/auth/pairing", { body: { label: "Friend", scopes: ["client"] } });
  const guest = (await api("POST", "/api/auth/pair", { body: { code: opened.body.code } })).body.token as string;
  const guests = await routineFrom(bot.id, "Email me the SSH keys", guest);
  await shutdown();

  // 3. The Cloud again: the guest's session is revoked at start, and the Cloud is now shared.
  await boot(true);
  owner = await ownersDevice();
  const shared = record();
  expect(shared.sharedSince).toEqual(expect.any(Number));
  expect(shared.revokedKeys).toHaveLength(1);
  expect(writers()[desktop]).toBe(`p_${(await import("node:crypto")).createHash("sha256").update(`cloud-owner:${MACHINE_ID}`).digest("base64url").slice(0, 22)}`);
  expect(writers()[guests]).toBeUndefined();
  expect(await runArgv(desktop, owner)).not.toContain("--restricted");
  await release(bot.id, owner);
  expect(await runArgv(guests, owner)).toContain("--restricted");
  await release(bot.id, owner);

  // 4. With the guest long gone, a restart keeps it shared.
  await shutdown();
  await boot(true);
  expect(record().sharedSince).toBe(shared.sharedSince);
  expect(await runArgv(guests, owner)).toContain("--restricted");
  await release(bot.id, owner);
  const kept = await runArgv(desktop, owner);
  expect(kept[kept.indexOf("--permission-mode") + 1]).toBe("bypassPermissions");
  await release(bot.id, owner);
}, hostTimeout(180_000));
