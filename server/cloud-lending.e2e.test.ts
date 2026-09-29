// "Let my Cloud use this Mac" on an OMB Cloud home (docs/cloud-pro.md): the
// real server booted as a Cloud home, with NO maintainer flag, over its real
// HTTP boundary. Lending is on there; only the person's own admin devices (the
// Admin's signed pairing) may lend; every turn on the home acts for that one
// person; the status API says what is lent and whether it is online. The Mac
// side is the real outbound connector. Disposable home, synthetic engine.
import { randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createComputerSharing } from "../electron/computer-sharing.mjs";
import { cloudPairingSignature } from "./cloud-home.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const HOST = "omb-t-0123456789ab.fly.dev";
const secret = randomBytes(32).toString("base64url");
let home = "";
let base = "";
let child: ChildProcess;
let log = "";
let owner = "";
let guest = "";
let connector: ReturnType<typeof createComputerSharing> | undefined;
const proxies: ChildProcess[] = [];

async function api(method: string, path: string, options: { body?: unknown; token?: string } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      // What the Caddy edge adds: every network request is remote.
      host: HOST, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https", origin: `https://${HOST}`,
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { status: response.status, body: await response.json().catch(() => null) as any };
}

async function adminPairing(): Promise<string> {
  const body = JSON.stringify({ label: "OpenMausBot app (Cloud)", ttlSeconds: 300 });
  const timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomBytes(16).toString("base64url");
  const response = await fetch(`${base}/api/cloud/pairing`, { method: "POST", headers: {
    host: HOST, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https", "content-type": "application/json",
    "x-omb-cloud-timestamp": timestamp, "x-omb-cloud-nonce": nonce, "x-omb-cloud-signature": `v1=${cloudPairingSignature(secret, timestamp, nonce, body)}`,
  }, body });
  const granted = await response.json() as { code: string };
  const paired = await api("POST", "/api/auth/pair", { body: { code: granted.code } });
  expect(paired.status, JSON.stringify(paired.body)).toBe(200);
  return paired.body.token;
}

/** A turn's agents MCP proxy, for a turn this test starts. */
async function proxyFor(start: () => Promise<void>) {
  const dump = join(home, "spawn.json");
  rmSync(dump, { force: true });
  await start();
  await expect.poll(() => existsSync(dump), { timeout: 15_000 }).toBe(true);
  const agents = JSON.parse(readFileSync(dump, "utf8")).mcpConfig.mcpServers.agents;
  const proxy = spawn(agents.command, agents.args, { env: { PATH: process.env.PATH, HOME: home, ...agents.env }, stdio: ["pipe", "pipe", "pipe"] });
  proxies.push(proxy);
  const replies = new Map<number, (value: any) => void>();
  createInterface({ input: proxy.stdout! }).on("line", line => { const msg = JSON.parse(line); replies.get(msg.id)?.(msg.result); replies.delete(msg.id); });
  let next = 0;
  const request = (method: string, params: unknown): Promise<any> => new Promise(resolve => {
    const id = ++next; replies.set(id, resolve);
    proxy.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  await request("initialize", { protocolVersion: "2024-11-05" });
  return (name: string, args: unknown = {}) => request("tools/call", { name, arguments: args });
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "omb-cloud-lending-"));
  const dataDir = join(home, ".openmausbot");
  mkdirSync(dataDir, { recursive: true });
  const cli = join(home, "fixture-claude.mjs");
  writeFileSync(cli, `#!/usr/bin/env node
if (process.argv[2] === "auth") { console.log(JSON.stringify({ loggedIn: true, email: "person@example.test" })); process.exit(0); }
if (process.argv[2] !== "--version") { process.env.FAKE_CLAUDE_DUMP = ${JSON.stringify(join(home, "spawn.json"))}; process.env.FAKE_CLAUDE_MODE = "hang"; }
await import(${JSON.stringify(pathToFileURL(join(SERVER_DIR, "testing", "fake-claude-cli.ts")).href)});
`, { mode: 0o755 });
  // No `features` block: the maintainer flag is off, as on every Cloud home.
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ instances: {
    ...Object.fromEntries(["codex", "cursor", "openaiCompat", "qwen", "hermes", "pi"].map((id) => [id, { driver: "not-a-real-driver" }])),
    claude: { driver: "claudeAgent", displayName: "Claude", config: { cli } },
  } }));
  const port = await freePortBlock([0, 1]);
  base = `http://127.0.0.1:${port}`;
  const offlinePrelude = `data:text/javascript,${encodeURIComponent('const real = globalThis.fetch; globalThis.fetch = async (url, init) => String(url).startsWith("http://127.0.0.1:") ? real(url, init) : new Response("offline fixture", { status: 503 });')}`;
  child = spawn(process.execPath, ["--import", offlinePrelude, join(SERVER_DIR, "index.ts")], {
    cwd: join(SERVER_DIR, ".."),
    env: {
      PATH: process.env.PATH, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home, USERPROFILE: home, OMB_DATA_DIR: dataDir, OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1),
      OMB_CLOUD_ROLE: "home", OMB_CLOUD_MACHINE_ID: "3f9c2a4e-8b1d-4c6e-9a7f-2d5e8c1b0a93", OMB_CLOUD_ADMIN_URL: "https://cloud.example.test",
      OMB_CLOUD_BOOTSTRAP_SECRET: secret, OMB_PUBLIC_URL: `https://${HOST}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => { log += chunk; });
  child.stderr?.on("data", (chunk) => { log += chunk; });
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`the Cloud home exited:\n${log}`);
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* starting */ }
    if (Date.now() > deadline) throw new Error(`the Cloud home did not start:\n${log}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  owner = await adminPairing();
  // A guest the owner paired with chat-only access.
  const opened = await api("POST", "/api/auth/pairing", { token: owner, body: { label: "Guest phone", scopes: ["client"] } });
  expect(opened.status, JSON.stringify(opened.body)).toBe(200);
  guest = (await api("POST", "/api/auth/pair", { body: { code: opened.body.code } })).body.token;
}, 30_000);

afterAll(async () => {
  connector?.close();
  for (const proxy of proxies) proxy.kill();
  if (child) await waitForExit(child, { signal: "SIGTERM" });
  if (home) await removeTempDir(home);
});

it("offers lending on a Cloud home with the maintainer flag still off", async () => {
  expect((await api("GET", "/.well-known/openmausbot/environment")).body.capabilities).toMatchObject({ sharedComputers: true });
  expect((await api("GET", "/api/config", { token: owner })).body.features.sharedComputers).toBe(false);
  expect(await api("GET", "/api/shared-computers", { token: owner })).toEqual({ status: 200, body: { computers: [] } });
});

it("only the person's own admin device can lend; a chat-only guest cannot", async () => {
  const registration = { id: randomUUID(), name: "Guest laptop", environmentId: (await api("GET", "/.well-known/openmausbot/environment")).body.environmentId, folders: [], terminal: false, computer: true };
  const refused = await fetch(`${base}/api/shared-computers/connect`, { method: "POST", headers: {
    host: HOST, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https", origin: `https://${HOST}`,
    authorization: `Bearer ${guest}`, "content-type": "application/json", "x-omb-computer-secret": "c".repeat(64),
  }, body: JSON.stringify(registration) });
  expect(refused.status).toBe(403);
  expect(await refused.json()).toMatchObject({ error: expect.stringContaining("Only your own computers") });
  expect((await api("GET", "/api/shared-computers", { token: owner })).body.computers).toEqual([]);
});

it("the person's Mac, lent through the real connector, is usable by any turn on their Cloud and shows in the status API", async () => {
  const folderPath = realpathSync(mkdtempSync(join(tmpdir(), "omb-cloud-lent-folder-")));
  writeFileSync(join(folderPath, "plan.md"), "from the Mac");
  const env = { id: "my-cloud", name: "My Cloud", origin: base };
  let maintainerChecks = 0;
  connector = createComputerSharing({
    file: join(home, "desktop-profile", "computer-sharing.json"), environments: () => [env], cuaConnection: async () => null,
    // The Mac's own maintainer flag is off; its verified Cloud sign-in is what lets it lend.
    enabled: async () => { maintainerChecks++; return false; },
    cloud: () => ({ status: "connected", accountId: "acct_fixture", origin: base }),
    home: join(home, "mac-home"),
    // The desktop's cookie for its Cloud, as a bearer; the edge headers as Caddy adds them.
    fetch: (url: string, init: RequestInit) => fetch(url, { ...init, headers: { ...init.headers as Record<string, string>, authorization: `Bearer ${owner}`, host: HOST, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https", origin: `https://${HOST}` } }),
  });
  const folder = { id: randomUUID(), name: "Plans", path: folderPath, write: false };
  await connector.saveCloud(env, { folders: [folder], screen: false });
  await expect.poll(() => connector!.cloudState(env).connected, { timeout: 8000 }).toBe(true);
  expect(maintainerChecks).toBe(0);

  const status = (await api("GET", "/api/shared-computers", { token: owner })).body.computers;
  expect(status).toHaveLength(1);
  expect(status[0]).toMatchObject({ online: true, busy: false, scopes: { folders: [{ id: folder.id, name: expect.any(String), write: false }], terminal: false, screen: false } });
  expect(JSON.stringify(status)).not.toContain(folderPath);
  expect(JSON.stringify(status)).not.toMatch(/[a-f0-9]{64}/);

  // A conversation and a routine on the Cloud both act for its one person.
  const bot = (await api("POST", "/api/bots", { token: owner, body: { name: "Cloud bot", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } } })).body.bot;
  const call = await proxyFor(async () => {
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { token: owner, body: { text: "Read plan.md from my Mac." } })).status).toBe(202);
  });
  const listed = JSON.parse((await call("list_shared_computers")).content[0].text).computers;
  expect(listed.map((entry: any) => entry.id)).toEqual([status[0].id]);
  const read = await call("shared_computer", { computer_id: status[0].id, folder_id: folder.id, action: "read_file", path: "plan.md" });
  expect(JSON.parse(read.content[0].text).content).toBe("from the Mac");
  // What was lent is all there is: no terminal, no screen, no write.
  expect((await call("shared_computer", { computer_id: status[0].id, action: "run_command", command: "id" })).isError).toBe(true);
  expect((await call("shared_computer", { computer_id: status[0].id, folder_id: folder.id, action: "write_file", path: "x.md", content: "y" })).isError).toBe(true);
  expect(existsSync(join(folderPath, "x.md"))).toBe(false);
  expect(connector.activity(env.id).map((entry) => [entry.action, entry.ok])).toEqual([["read_file", true]]);

  const routineBot = (await api("POST", "/api/bots", { token: owner, body: { name: "Routine bot", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } } })).body.bot;
  const routine = await proxyFor(async () => {
    const created = await api("POST", "/api/routines", { token: owner, body: {
      name: "Nightly", prompt: "Read plan.md from my Mac.", botId: routineBot.id, enabled: false,
      schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 },
    } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect((await api("POST", `/api/routines/${created.body.routine.id}/run`, { token: owner })).status).toBe(201);
  });
  expect(JSON.parse((await routine("list_shared_computers")).content[0].text).computers).toHaveLength(1);

  // Stop lending: the status API and the bots see it gone at once.
  connector.revoke(env);
  await expect.poll(async () => (await api("GET", "/api/shared-computers", { token: owner })).body.computers, { timeout: 5000 }).toEqual([]);
  expect((await call("shared_computer", { computer_id: status[0].id, folder_id: folder.id, action: "read_file", path: "plan.md" })).isError).toBe(true);
  rmSync(folderPath, { recursive: true, force: true });
}, 60_000);
