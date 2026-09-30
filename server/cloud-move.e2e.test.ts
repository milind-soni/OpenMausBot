// Move to Cloud end to end (docs/cloud-pro.md): a desktop-like server and an
// OMB Cloud home, each a real server process over HTTP, driven by the
// desktop's own orchestrator (electron/cloud-move.mjs). The test plays the
// Admin (it signs the Cloud's pairing requests), Caddy (every Cloud request
// arrives forwarded, never as the loopback owner) and the launcher (it starts
// the Cloud's server again when it exits to install a restore). Disposable
// homes; no network; a synthetic Claude CLI.
import { createHash, randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createCloudMove } from "../electron/cloud-move.mjs";
import { CLOUD_HOME_RESTART_EXIT_CODE, cloudPairingSignature } from "./cloud-home.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { stageWorkspaceBackup } from "./workspace-backup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const HOST = "omb-t-0123456789ab.fly.dev";
const ORIGIN = `https://${HOST}`;
const bootstrapSecret = randomBytes(32).toString("base64url");
const unique = (label: string) => `${label}-${randomBytes(12).toString("hex")}`;
// What the desktop holds that must never reach the Cloud.
const SOURCE_SECRETS = {
  anthropic: unique("sk-ant-source"), tts: unique("source-voice-key"), box: unique("box_source"),
  env: unique("source-driver-env"), credential: unique("source-workspace-credential"), provider: unique("source-provider-login"),
};
const CLOUD_KEY = unique("sk-ant-cloud");
// The servers never reach the network.
const OFFLINE = `data:text/javascript,${encodeURIComponent('globalThis.fetch = async () => new Response("offline fixture", { status: 503 });')}`;

interface Fixture { name: string; home: string; dataDir: string; base: string; env: NodeJS.ProcessEnv; child?: ChildProcess; log: string; closing: boolean; boots: number }
let source: Fixture;
let cloud: Fixture;
let scratch: string;
let windowToken: string;
// The desktop's bots: its first-run starter bot and the one made below.
let desktopBots: string[];

async function boot(fixture: Fixture): Promise<void> {
  const child = spawn(process.execPath, ["--import", OFFLINE, join(SERVER_DIR, "index.ts")], { cwd: join(SERVER_DIR, ".."), env: fixture.env, stdio: ["ignore", "pipe", "pipe"] });
  fixture.child = child;
  fixture.boots++;
  child.stdout?.on("data", (chunk) => { fixture.log += chunk; });
  child.stderr?.on("data", (chunk) => { fixture.log += chunk; });
  // The Cloud home's launcher: start the server again when it asks to.
  child.once("exit", (code) => { if (code === CLOUD_HOME_RESTART_EXIT_CODE && !fixture.closing && fixture.child === child) void boot(fixture); });
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`the ${fixture.name} server exited:\n${fixture.log}`);
    try {
      const health = await (await fetch(`${fixture.base}/api/health`)).json() as { pid?: number };
      if (health.pid === child.pid) return;
    } catch { /* starting */ }
    if (Date.now() > deadline) throw new Error(`the ${fixture.name} server did not start:\n${fixture.log}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function launch(name: "desktop" | "cloud"): Promise<Fixture> {
  const home = mkdtempSync(join(tmpdir(), `omb-move-${name}-`));
  const dataDir = join(home, ".openmausbot");
  mkdirSync(dataDir, { recursive: true });
  const cli = join(home, "fixture-claude.mjs");
  writeFileSync(cli, `#!/usr/bin/env node
if (process.argv[2] === "auth") {
  console.log(JSON.stringify({ loggedIn: true, email: "person@example.test" }));
  process.exit(0);
}
await import(${JSON.stringify(pathToFileURL(join(SERVER_DIR, "testing", "fake-claude-cli.ts")).href)});
`, { mode: 0o755 });
  const instances: Record<string, unknown> = {
    ...Object.fromEntries(["codex", "cursor", "openaiCompat", "qwen", "hermes", "pi"].map((id) => [id, { driver: "not-a-real-driver" }])),
    claude: { driver: "claudeAgent", displayName: "Claude", config: { cli }, ...(name === "desktop" ? { environment: { FIXTURE_TOKEN: SOURCE_SECRETS.env } } : {}) },
  };
  writeFileSync(join(dataDir, "config.json"), JSON.stringify(name === "desktop"
    ? { instances, anthropic: { key: SOURCE_SECRETS.anthropic }, tts: { key: SOURCE_SECRETS.tts }, box: { token: SOURCE_SECRETS.box }, features: { sharedComputers: true } }
    : { instances, anthropic: { key: CLOUD_KEY } }));
  if (name === "desktop") {
    writeFileSync(join(dataDir, "workspace-credentials.json"), JSON.stringify({ fixture: SOURCE_SECRETS.credential }), { mode: 0o600 });
    mkdirSync(join(dataDir, "providers", "fixture"), { recursive: true });
    writeFileSync(join(dataDir, "providers", "fixture", ".credentials.json"), JSON.stringify({ token: SOURCE_SECRETS.provider }), { mode: 0o600 });
  }
  const port = await freePortBlock([0, 1]);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    ...(process.env.PATHEXT ? { PATHEXT: process.env.PATHEXT } : {}),
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    HOME: home, USERPROFILE: home, OMB_DATA_DIR: dataDir, OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1),
    ...(name === "cloud" ? {
      OMB_CLOUD_ROLE: "home", OMB_CLOUD_MACHINE_ID: "3f9c2a4e-8b1d-4c6e-9a7f-2d5e8c1b0a93", OMB_CLOUD_ADMIN_URL: "https://cloud.example.test",
      OMB_CLOUD_BOOTSTRAP_SECRET: bootstrapSecret, OMB_PUBLIC_URL: ORIGIN,
    } : {}),
  };
  const fixture: Fixture = { name, home, dataDir, base: `http://127.0.0.1:${port}`, env, log: "", closing: false, boots: 0 };
  await boot(fixture);
  return fixture;
}

/** What the edge adds to every request it forwards: never the owner. */
const forwarded = { host: HOST, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https" };
async function api(fixture: Fixture, method: string, path: string, options: { body?: unknown; token?: string; remote?: boolean; raw?: Buffer } = {}) {
  const response = await fetch(`${fixture.base}${path}`, {
    method,
    headers: {
      ...(options.remote || options.token ? forwarded : {}),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...(options.raw ? { "content-type": "application/octet-stream" } : {}),
    },
    body: options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
  });
  return { status: response.status, body: await response.json().catch(() => null) as any };
}

/** The Admin's signed request: one single-use pairing window on the Cloud. */
async function cloudGrant(): Promise<{ origin: string; code: string; expiresAt: number }> {
  const body = JSON.stringify({ label: "OpenMausBot app (Cloud)", ttlSeconds: 300 });
  const timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomBytes(16).toString("base64url");
  const response = await fetch(`${cloud.base}/api/cloud/pairing`, { method: "POST", body, headers: {
    ...forwarded, "content-type": "application/json", "x-omb-cloud-timestamp": timestamp, "x-omb-cloud-nonce": nonce,
    "x-omb-cloud-signature": `v1=${cloudPairingSignature(bootstrapSecret, timestamp, nonce, body)}`,
  } });
  const granted = await response.json() as { code: string; expiresAt: number };
  expect(response.status, JSON.stringify(granted)).toBe(200);
  return { origin: ORIGIN, code: granted.code, expiresAt: granted.expiresAt };
}

function mover() {
  return createCloudMove({
    localRequest: (route, init) => fetch(`${source.base}${route}`, init),
    pairHome: cloudGrant,
    fetchImpl: ((url: string, init: RequestInit = {}) => fetch(String(url).replace(ORIGIN, cloud.base), {
      ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), ...forwarded },
    })) as typeof fetch,
    tempRoot: join(scratch, "move-temp"),
    availableBytes: async () => Number.MAX_SAFE_INTEGER,
    pollMs: 150, retryDelaysMs: [100, 300], restartTimeoutMs: 90_000,
  });
}

async function newBot(fixture: Fixture, name: string, token?: string) {
  const created = await api(fixture, "POST", "/api/bots", { token, body: { name, modelSelection: { instanceId: "claude", model: "claude-sonnet-5" }, requireAvailableModel: true } });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body.bot as { id: string; threadId: string };
}
async function botNames(fixture: Fixture, token?: string): Promise<string[]> {
  const listed = await api(fixture, "GET", "/api/bots", { token });
  expect(listed.status, JSON.stringify(listed.body)).toBe(200);
  return listed.body.bots.map((bot: { name: string }) => bot.name);
}
/** Poll outside a test body too (beforeAll): expect.poll only works inside one. */
async function until(what: string, check: () => Promise<boolean>, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
const idle = (fixture: Fixture) => until("idle bots", async () => (await api(fixture, "GET", "/api/bots")).body.bots
  .every((bot: { activity?: string }) => bot.activity !== "working"));
function filesUnder(root: string): string[] {
  const found: string[] = [];
  const walk = (directory: string) => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name), stat = lstatSync(path);
      if (stat.isDirectory()) walk(path); else if (stat.isFile()) found.push(path);
    }
  };
  walk(root);
  return found;
}

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "omb-move-scratch-"));
  [source, cloud] = await Promise.all([launch("desktop"), launch("cloud")]);
  // The desktop window's own session on the Cloud, from Connect to my Cloud.
  const paired = await api(cloud, "POST", "/api/auth/pair", { remote: true, body: { code: (await cloudGrant()).code } });
  expect(paired.status, JSON.stringify(paired.body)).toBe(200);
  windowToken = paired.body.token;
  // The desktop's work: a bot with a real conversation, and a room.
  const planner = await newBot(source, "Moved Planner");
  expect((await api(source, "POST", `/api/bots/${planner.id}/messages`, { body: { text: "Plan the launch party" } })).status).toBe(202);
  await until("the bot's reply", async () => ((await api(source, "GET", `/api/threads/${planner.threadId}/messages`)).body?.messages ?? [])
    .filter((message: { role: string }) => message.role === "bot").length >= 2);
  await idle(source);
  const room = await api(source, "POST", "/api/groups", { body: { name: "Launch room", memberIds: [planner.id] } });
  expect(room.status, JSON.stringify(room.body)).toBe(201);
  desktopBots = (await botNames(source)).sort();
  expect(desktopBots).toHaveLength(2);
  // The secrets really are in the desktop's files, so their absence is proof.
  const saved = readFileSync(join(source.dataDir, "config.json"), "utf8");
  for (const value of [SOURCE_SECRETS.anthropic, SOURCE_SECRETS.tts, SOURCE_SECRETS.box, SOURCE_SECRETS.env]) expect(saved).toContain(value);
}, 90_000);

afterAll(async () => {
  for (const fixture of [source, cloud]) {
    if (!fixture) continue;
    fixture.closing = true;
    await waitForExit(fixture.child, { signal: "SIGTERM" });
  }
  for (const directory of [source?.home, cloud?.home, scratch]) if (directory) await removeTempDir(directory);
});

it("moves this computer's bots, chats and rooms to an empty Cloud, which keeps its own sign-ins, sessions and switches", async () => {
  const before = await api(cloud, "GET", "/api/cloud-move", { token: windowToken });
  expect(before.status, JSON.stringify(before.body)).toBe(200);
  expect(before.body).toMatchObject({ empty: true, previous: null });
  const boots = cloud.boots;

  const result = await mover().move();
  expect(result, cloud.log.slice(-2000)).toMatchObject({ phase: "done", action: "move", previous: false });
  expect(result.moved).toMatchObject({ bots: 2, rooms: 1, chats: 1 });
  expect(cloud.boots).toBe(boots + 1);

  // The window's session survived the restore and the restart.
  const session = await api(cloud, "GET", "/api/auth/session", { token: windowToken });
  expect(session.body).toMatchObject({ kind: "session", cloudHome: true, scopes: ["admin", "client"] });
  expect((await botNames(cloud, windowToken)).sort()).toEqual(desktopBots);
  const moved = (await api(cloud, "GET", "/api/bots", { token: windowToken })).body;
  const planner = moved.bots.find((bot: { name: string }) => bot.name === "Moved Planner");
  const transcript = await api(cloud, "GET", `/api/threads/${planner.threadId}/messages`, { token: windowToken });
  expect(JSON.stringify(transcript.body.messages)).toContain("Plan the launch party");
  // The move's own session was signed out; the window's is the one left.
  const sessions = (await api(cloud, "GET", "/api/auth/sessions", { token: windowToken })).body.sessions as Array<{ label: string }>;
  expect(sessions.map((entry) => entry.label)).not.toContain("Move to Cloud");

  // The Cloud keeps its own engine key and its own computer-sharing switch.
  const config = JSON.parse(readFileSync(join(cloud.dataDir, "config.json"), "utf8"));
  expect(config.anthropic).toEqual({ key: CLOUD_KEY });
  expect(config.features?.sharedComputers).toBeUndefined();
  // No desktop secret anywhere on the Cloud's volume.
  for (const file of filesUnder(cloud.home)) {
    const text = readFileSync(file).toString("latin1");
    for (const value of Object.values(SOURCE_SECRETS)) expect(text.includes(value), `${value} in ${file}`).toBe(false);
  }
  // What the restore replaced is not kept: no safety copy, no staged files.
  expect(readdirSync(join(cloud.dataDir, ".backups")).filter((name) => name.startsWith("safety-") || /^[0-9a-f-]{36}$/.test(name))).toEqual([]);
  // This computer is unchanged: a copy, not a move of its files.
  expect((await botNames(source)).sort()).toEqual(desktopBots);
  expect(readFileSync(join(source.dataDir, "config.json"), "utf8")).toContain(SOURCE_SECRETS.anthropic);
}, 150_000);

it("the bundle a move sends carries no key, sign-in, credential or session of this computer", async () => {
  const password = "fixture bundle password";
  const exported = await api(source, "POST", "/api/workspace-backup/export", { body: { password, clientState: {} } });
  expect(exported.status, JSON.stringify(exported.body)).toBe(200);
  const archive = join(scratch, "bundle.ombbackup");
  writeFileSync(archive, Buffer.from(await (await fetch(`${source.base}/api/workspace-backup/download/${exported.body.id}`)).arrayBuffer()));
  const inspect = mkdtempSync(join(scratch, "bundle-"));
  const staged = await stageWorkspaceBackup(inspect, archive, { password });
  const data = join(inspect, ".backups", staged.id, "staged", "data");
  const config = JSON.parse(readFileSync(join(data, "config.json"), "utf8"));
  for (const field of ["anthropic", "tts", "box", "instances", "mcpServers", "signIn"]) expect(config).not.toHaveProperty(field);
  for (const path of ["workspace-credentials.json", "providers", "sessions.json", "sessions.json.open", "environment-id"]) expect(existsSync(join(data, path)), path).toBe(false);
  for (const file of filesUnder(data)) {
    const text = readFileSync(file).toString("latin1");
    for (const value of Object.values(SOURCE_SECRETS)) expect(text.includes(value), `${value} in ${file}`).toBe(false);
  }
  expect(readFileSync(join(data, "bots.json"), "utf8")).toContain("Moved Planner");
}, 60_000);

it("backs up a Cloud that has work before replacing it; swapping back keeps what it replaces, so it can be swapped again", async () => {
  await newBot(cloud, "Cloud-only bot", windowToken);
  const before = await api(cloud, "GET", "/api/cloud-move", { token: windowToken });
  expect(before.body).toMatchObject({ empty: false, previous: null });

  const result = await mover().move();
  expect(result, cloud.log.slice(-2000)).toMatchObject({ phase: "done", previous: true });
  expect((await botNames(cloud, windowToken)).sort()).toEqual(desktopBots);
  const status = await api(cloud, "GET", "/api/cloud-move", { token: windowToken });
  expect(status.body.previous).toMatchObject({ bots: 3, rooms: 1 });

  // Work done on the Cloud after the move is not lost by swapping back.
  await newBot(cloud, "Post-move work", windowToken);
  const swapped = await mover().restorePrevious();
  expect(swapped, cloud.log.slice(-2000)).toMatchObject({ phase: "done", action: "restore" });
  expect((await botNames(cloud, windowToken)).sort()).toEqual(["Cloud-only bot", ...desktopBots].sort());
  expect((await api(cloud, "GET", "/api/cloud-move", { token: windowToken })).body.previous).toMatchObject({ bots: 3, rooms: 1 });
  const again = await mover().restorePrevious();
  expect(again, cloud.log.slice(-2000)).toMatchObject({ phase: "done", action: "restore" });
  expect((await botNames(cloud, windowToken)).sort()).toEqual(["Post-move work", ...desktopBots].sort());

  // One undo point is all that stays: no safety copies, no staged files.
  const backups = join(cloud.dataDir, ".backups");
  expect(readdirSync(backups).filter((name) => name.startsWith("safety-") || /^[0-9a-f-]{36}$/.test(name) || name === "cloud-previous.next")).toEqual([]);
  const held = (await api(cloud, "GET", "/api/cloud-move", { token: windowToken })).body;
  const archive = lstatSync(join(backups, "cloud-previous", "workspace.ombbackup")).size;
  expect(held.previous.bytes).toBe(archive);
  expect(held.heldBytes).toBeLessThan(archive + 256 * 1024);
  const config = JSON.parse(readFileSync(join(cloud.dataDir, "config.json"), "utf8"));
  expect(config.anthropic).toEqual({ key: CLOUD_KEY });
  expect((await api(cloud, "GET", "/api/auth/session", { token: windowToken })).body).toMatchObject({ kind: "session", cloudHome: true });
}, 300_000);

it("refuses a move too big for a Cloud, an upload that is not a backup, and anyone but the owner's app", async () => {
  const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  const tooBig = await api(cloud, "POST", "/api/cloud-move/upload", { token: windowToken, body: { sha256: "a".repeat(64), bytes: 11 * 1024 ** 3 } });
  expect(tooBig.status).toBe(413);
  const tooMany = await api(cloud, "POST", "/api/cloud-move/upload", { token: windowToken, body: { sha256: "a".repeat(64), bytes: 4096, files: 100_001 } });
  expect(tooMany.status).toBe(413);

  const garbage = randomBytes(4096);
  const begun = await api(cloud, "POST", "/api/cloud-move/upload", { token: windowToken, body: { sha256: sha256(garbage), bytes: garbage.length } });
  expect(begun.body).toMatchObject({ received: 0 });
  const beyond = await api(cloud, "PUT", `/api/cloud-move/upload/${sha256(garbage)}?offset=0`, { token: windowToken, raw: Buffer.concat([garbage, Buffer.alloc(1)]) });
  expect(beyond.status).toBe(413);
  expect((await api(cloud, "PUT", `/api/cloud-move/upload/${sha256(garbage)}?offset=0`, { token: windowToken, raw: garbage })).body).toEqual({ received: 4096 });
  expect((await api(cloud, "POST", "/api/cloud-move/preview", { token: windowToken, body: { sha256: sha256(garbage), password: "fixture password 123" } })).status).toBe(202);
  await expect.poll(async () => (await api(cloud, "GET", "/api/cloud-move", { token: windowToken })).body.job?.state, { timeout: 15_000 }).toBe("failed");
  const refused = (await api(cloud, "GET", "/api/cloud-move", { token: windowToken })).body;
  expect(refused.job.error).toMatch(/not a supported encrypted workspace backup/);
  expect(refused.upload).toBeNull();

  // A client device cannot, and the machine's own loopback is refused directly.
  expect((await api(cloud, "GET", "/api/cloud-move")).status).toBe(403);
  expect((await api(cloud, "POST", "/api/cloud-move/undo", { body: {} })).status).toBe(403);
  const invite = await api(cloud, "POST", "/api/auth/pairing", { token: windowToken, body: { scopes: ["client"], label: "Phone" } });
  const phone = (await api(cloud, "POST", "/api/auth/pair", { remote: true, body: { code: invite.body.code } })).body.token;
  expect((await api(cloud, "GET", "/api/cloud-move", { token: phone })).status).toBe(403);
  expect((await api(cloud, "POST", "/api/cloud-move/restore", { token: phone, body: { id: "3f9c2a4e-8b1d-4c6e-9a7f-2d5e8c1b0a93" } })).status).toBe(403);
  expect([401, 403]).toContain((await api(cloud, "GET", "/api/cloud-move", { remote: true })).status);
  // A desktop is not a Cloud home: it never receives a workspace.
  expect((await api(source, "GET", "/api/cloud-move")).status).toBe(404);
  expect((await api(source, "GET", "/api/cloud-move/estimate")).body).toMatchObject({ bots: 2, rooms: 1, chats: 1 });
}, 60_000);

it("a process on the machine (a bot's shell, bare loopback) cannot pair itself as the owner or reach any owner route", async () => {
  // On a Cloud home a request without a session from the machine itself is
  // only ever a service: it may not open a pairing window of any scope, nor
  // use the move, the settings, a bot's instructions or a memory review.
  for (const scopes of [["admin", "client"], ["client"]]) {
    const minted = await api(cloud, "POST", "/api/auth/pairing", { body: { scopes, label: "bot shell" } });
    expect(minted.status, JSON.stringify(minted.body)).toBe(403);
  }
  for (const [method, path, body] of [
    ["GET", "/api/cloud-move", undefined], ["GET", "/api/config", undefined], ["GET", "/api/auth/sessions", undefined],
    ["PATCH", "/api/config", { profile: { name: "Shell" } }],
  ] as const) {
    expect((await api(cloud, method, path, body === undefined ? {} : { body })).status, `${method} ${path}`).toBe(403);
  }
  // Its health check and the turn capability routes still answer.
  expect((await api(cloud, "GET", "/api/health")).status).toBe(200);
}, 60_000);
