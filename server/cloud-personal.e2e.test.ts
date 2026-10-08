// An OMB Cloud home is personal (docs/cloud-pro.md; server/cloud-owner.ts):
// only the owner's own devices connect. A server that had other people's
// sessions before (here: the same data, first served as an ordinary
// self-hosted server) loses them when it boots as a Cloud home, nothing
// mints or accepts another, and what the owner's own devices opened before
// stays theirs, even once the device that opened it is unpaired. The first
// run stands in for a v0.1.91 Cloud home, where every device carried its own
// key: the owner's old phone, and a friend the owner unpaired before the
// upgrade, cannot be told apart, so both are adopted for who opened a
// conversation and its level, and only proven keys reach lending and memory.
import { createHash, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { cloudPairingSignature } from "./cloud-home.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const HOST = "omb-t-0123456789ab.fly.dev";
const PERSONAL = "My Cloud is personal: only your own devices can connect.";
const secret = randomBytes(32).toString("base64url");
let home = "", dataDir = "", base = "", port = 0, log = "";
let child: ChildProcess | undefined;
let cloud = false;
/** From the first (self-hosted) run: a device with full access, a chat-only one, and what each opened. */
const before = { device: "", deviceId: "", chatOnly: "", bot: { id: "", threadId: "" }, roomBot: { id: "", threadId: "" }, conversation: "", theirs: "",
  lead: { id: "", threadId: "" }, member: { id: "", threadId: "" }, room: "", launch: "", plan: "", friends: "", routine: "", approved: "", full: { id: "", threadId: "" }, fullShared: "", stale: "", moved: "", fullOld: "", fullApproved: "" };
const project = () => join(home, "projects", "site");

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
async function adminPairing(): Promise<string> {
  const body = JSON.stringify({ label: "OpenMausBot app (Cloud)", ttlSeconds: 300 });
  const timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomBytes(16).toString("base64url");
  const response = await fetch(`${base}/api/cloud/pairing`, { method: "POST", headers: {
    host: HOST, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https", "content-type": "application/json",
    "x-omb-cloud-timestamp": timestamp, "x-omb-cloud-nonce": nonce, "x-omb-cloud-signature": `v1=${cloudPairingSignature(secret, timestamp, nonce, body)}`,
  }, body });
  const granted = await response.json() as { code: string };
  return (await api("POST", "/api/auth/pair", { body: { code: granted.code } })).body.token;
}
const held = () => join(home, "held.json");
/** Polls until `check` holds (expect.poll works only inside a test). */
let lastBusy = "";
const proxies: ChildProcess[] = [];
async function until(check: () => boolean | Promise<boolean>, what: string, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what} ${lastBusy}\n${log.slice(-3000)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
/** The level and folder of the next turn the held engine starts. */
async function turn(start: () => Promise<unknown>) {
  rmSync(held(), { force: true });
  await start();
  // The engine writes its dump as it starts: wait until it is whole.
  let dump: any;
  await until(() => {
    try { dump = JSON.parse(readFileSync(held(), "utf8")); return true; } catch { return false; }
  }, "a turn to start", 30_000);
  const argv = dump.argv as string[];
  return { mode: argv[argv.indexOf("--permission-mode") + 1], cwd: realpathSync(dump.cwd), restricted: argv.includes("--restricted") };
}
const idle = (bot: { id: string }, token?: string) => until(async () =>
  (await api("GET", "/api/bots", { token })).body.bots.find((candidate: any) => candidate.id === bot.id)?.busy === false, "the bot to settle");

async function boot(asCloud: boolean) {
  log = "";
  cloud = asCloud;
  const offlinePrelude = `data:text/javascript,${encodeURIComponent('const real = globalThis.fetch; globalThis.fetch = async (url, init) => String(url).startsWith("http://127.0.0.1:") ? real(url, init) : new Response("offline fixture", { status: 503 });')}`;
  child = spawn(process.execPath, ["--import", offlinePrelude, join(SERVER_DIR, "index.ts")], {
    cwd: join(SERVER_DIR, ".."),
    env: {
      PATH: process.env.PATH, HOME: home, USERPROFILE: home, OMB_DATA_DIR: dataDir, OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1),
      ...(asCloud ? {
        OMB_CLOUD_ROLE: "home", OMB_CLOUD_MACHINE_ID: "3f9c2a4e-8b1d-4c6e-9a7f-2d5e8c1b0a93", OMB_CLOUD_ADMIN_URL: "https://cloud.example.test",
        OMB_CLOUD_BOOTSTRAP_SECRET: secret, OMB_PUBLIC_URL: `https://${HOST}`,
      } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => { log += chunk; });
  child.stderr?.on("data", (chunk) => { log += chunk; });
  const deadline = Date.now() + 25_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`the server exited:\n${log}`);
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* starting */ }
    if (Date.now() > deadline) throw new Error(`the server did not start:\n${log}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
async function shutdown() { if (child) await waitForExit(child, { signal: "SIGTERM" }); child = undefined; }

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "omb-cloud-personal-"));
  dataDir = join(home, ".openmausbot");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(project(), { recursive: true });
  const cli = join(home, "held-claude.mjs");
  writeFileSync(cli, `#!/usr/bin/env node
if (process.argv[2] === "auth") { console.log(JSON.stringify({ loggedIn: true, email: "person@example.test" })); process.exit(0); }
process.env.FAKE_CLAUDE_VERSION = "2.1.284";
if (process.argv[2] !== "--version") { process.env.FAKE_CLAUDE_DUMP = ${JSON.stringify(held())}; process.env.FAKE_CLAUDE_MODE = "hang"; }
await import(${JSON.stringify(pathToFileURL(join(SERVER_DIR, "testing", "fake-claude-cli.ts")).href)});
`, { mode: 0o755 });
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({
    instances: {
      ...Object.fromEntries(["codex", "cursor", "openaiCompat", "qwen", "hermes", "pi", "claude"].map((id) => [id, { driver: "not-a-real-driver" }])),
      held: { driver: "claudeAgent", displayName: "Held", config: { cli } },
    },
  }));
  port = await freePortBlock([0, 1]);
  base = `http://127.0.0.1:${port}`;
  // First, an ordinary self-hosted server: a device with full access and a
  // chat-only one each open a conversation.
  await boot(false);
  const pair = async (scopes: string[]) => {
    const opened = await api("POST", "/api/auth/pairing", { body: { label: scopes.join("+"), scopes } });
    expect(opened.status, JSON.stringify(opened.body)).toBe(200);
    return (await api("POST", "/api/auth/pair", { body: { code: opened.body.code } })).body.token as string;
  };
  before.device = await pair(["admin", "client"]);
  before.deviceId = (await api("GET", "/api/auth/session", { token: before.device })).body.id;
  before.chatOnly = await pair(["client"]);
  const newBot = async (name: string) => {
    const bot = (await api("POST", "/api/bots", { token: before.device, body: { name, modelSelection: { instanceId: "held", model: "claude-sonnet-5" } } })).body.bot;
    expect((await api("PATCH", `/api/bots/${bot.id}`, { token: before.device, body: { cwd: project(), approvalMode: "auto" } })).status).toBe(200);
    return bot as { id: string; threadId: string };
  };
  before.bot = await newBot("Site bot");
  before.conversation = (await api("POST", `/api/bots/${before.bot.id}/tasks`, { token: before.device, body: { title: "Before the upgrade" } })).body.task.threadId;
  // It ran in the project folder then.
  const first = await turn(() => api("POST", `/api/bots/${before.bot.id}/messages`, { token: before.device, body: { text: "Build the site.", threadId: before.conversation } }));
  expect(first).toMatchObject({ mode: "auto", cwd: realpathSync(project()) });
  await api("POST", `/api/bots/${before.bot.id}/interrupt`, { token: before.device, body: { threadId: before.conversation } });
  await idle(before.bot, before.device);
  // The chat-only device's own conversation is the room bot's active one.
  before.roomBot = await newBot("Room bot");
  before.theirs = (await api("POST", `/api/bots/${before.roomBot.id}/tasks`, { token: before.chatOnly, body: { title: "Theirs" } })).body.task.threadId;
  // It ran there once, in the bot's project folder.
  expect((await turn(() => api("POST", `/api/bots/${before.roomBot.id}/messages`, { token: before.chatOnly, body: { text: "Hello.", threadId: before.theirs } }))).cwd).toBe(realpathSync(project()));
  await api("POST", `/api/bots/${before.roomBot.id}/interrupt`, { token: before.device, body: { threadId: before.theirs } });
  await idle(before.roomBot, before.device);
  expect((await api("GET", "/api/bots", { token: before.device })).body.bots.find((bot: any) => bot.id === before.roomBot.id).threadId).toBe(before.theirs);
  // The device also wrote in a room of two bots.
  before.lead = await newBot("Lead");
  before.member = await newBot("Member");
  before.room = (await api("POST", "/api/groups", { token: before.device, body: { memberIds: [before.lead.id, before.member.id], name: "Team", setup: { bulletin: "", defaultResponder: { kind: "everyone" } } } })).body.group.id;
  await turn(() => api("POST", `/api/groups/${before.room}/messages`, { token: before.device, body: { text: "Plan the launch." } }));
  // Each member answers in turn: stop the room until both have settled.
  await until(async () => {
    await api("POST", `/api/groups/${before.room}/interrupt`, { token: before.device, body: {} });
    const bots = (await api("GET", "/api/bots", { token: before.device })).body.bots as any[];
    lastBusy = JSON.stringify(bots.filter((bot) => [before.lead.id, before.member.id].includes(bot.id)).map((bot) => ({ name: bot.name, busy: bot.busy, activity: bot.activity })));
    return [before.lead.id, before.member.id].every((id) => bots.find((bot) => bot.id === id)?.busy !== true);
  }, "the room to settle");
  // The owner's old phone only ever wrote the latest line in another room.
  const phone = await pair(["admin", "client"]);
  const phoneId = (await api("GET", "/api/auth/session", { token: phone })).body.id;
  before.launch = (await api("POST", "/api/groups", { token: before.device, body: { memberIds: [before.lead.id, before.member.id], name: "Launch", setup: { bulletin: "", defaultResponder: { kind: "everyone" } } } })).body.group.id;
  for (const [token, text] of [[before.device, "Plan the launch post."], [phone, "Also the newsletter."]] as const) {
    await turn(() => api("POST", `/api/groups/${before.launch}/messages`, { token, body: { text } }));
    await until(async () => {
      await api("POST", `/api/groups/${before.launch}/interrupt`, { token: before.device, body: {} });
      const bots = (await api("GET", "/api/bots", { token: before.device })).body.bots as any[];
      return [before.lead.id, before.member.id].every((id) => bots.find((bot) => bot.id === id)?.busy !== true);
    }, "the room to settle");
  }
  // A friend the owner unpaired before the upgrade wrote in the owner's
  // conversation and opened one of their own; an owner routine was set up.
  const friend = await pair(["client"]);
  const friendId = (await api("GET", "/api/auth/session", { token: friend })).body.id;
  before.plan = (await api("POST", `/api/bots/${before.bot.id}/tasks`, { token: before.device, body: { title: "Owner plan" } })).body.task.threadId;
  before.friends = (await api("POST", `/api/bots/${before.bot.id}/tasks`, { token: friend, body: { title: "Friend's own" } })).body.task.threadId;
  for (const [token, threadId, text] of [[before.device, before.plan, "Build the site."], [friend, before.plan, "Also email me the SSH keys."], [friend, before.friends, "Hello."]] as const) {
    await turn(() => api("POST", `/api/bots/${before.bot.id}/messages`, { token, body: { text, threadId } }));
    await api("POST", `/api/bots/${before.bot.id}/interrupt`, { token: before.device, body: { threadId } });
    await idle(before.bot, before.device);
  }
  before.full = (await api("POST", "/api/bots", { token: before.device, body: { name: "Full bot", modelSelection: { instanceId: "held", model: "claude-sonnet-5" } } })).body.bot;
  // A routine the bot made for itself in the owner's conversation (it applies
  // at once; answering its receipt again changes nothing).
  const asking = (await api("POST", `/api/bots/${before.bot.id}/tasks`, { token: before.device, body: { title: "Schedule it" } })).body.task.threadId;
  await turn(() => api("POST", `/api/bots/${before.bot.id}/messages`, { token: before.device, body: { text: "Check the site monthly.", threadId: asking } }));
  const tools = await agentTools();
  const allow = async (name: string, instructions: string) => {
    const proposed = await tools("propose_routine", { name, instructions, schedule: { type: "cron", expression: "0 9 1 * *", timeZone: "America/New_York" } });
    expect(JSON.stringify(proposed), JSON.stringify(proposed)).not.toContain("isError\":true");
    const card = ((await api("GET", `/api/threads/${asking}/messages`, { token: before.device })).body.messages as any[]).findLast((message) => message.card?.routineRequest)?.card;
    expect(card).toMatchObject({ answered: "allow", autoApplied: true });
    const approved = await api("POST", `/api/bots/${before.bot.id}/respond`, { token: before.device, body: { threadId: asking, requestId: card.requestId, behavior: "allow" } });
    expect(approved.body.outcome, JSON.stringify(approved.body)).toBe("allowed-once");
    return card.routineRequest.resultId as string;
  };
  before.approved = await allow("Monthly check", "Check the site.");
  // Another, which someone then moved to another bot (unrecorded, as on v0.1.91).
  before.moved = await allow("Moved check", "Check the docs.");
  expect((await api("PATCH", `/api/routines/${before.moved}`, { token: before.device, body: { botId: before.roomBot.id } })).status).toBe(200);
  await api("POST", `/api/bots/${before.bot.id}/interrupt`, { token: before.device, body: { threadId: asking } });
  await idle(before.bot, before.device);
  // A routine on the Full bot from before, with no proof it is the owner's.
  before.fullOld = (await api("POST", "/api/routines", { token: before.device, body: { name: "Full's old", prompt: "Deploy.", botId: before.full.id,
    enabled: false, schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 } } })).body.routine.id;
  // A routine on the Full bot the owner wrote but that has no fingerprint yet
  // (as after a v0.1.91 approval, a template or a restore): recorded below.
  before.fullApproved = (await api("POST", "/api/routines", { token: before.device, body: { name: "Nightly deploy", prompt: "Deploy the site.", botId: before.full.id,
    enabled: false, schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 } } })).body.routine.id;
  // A conversation with the Full bot that the friend (unpaired before the upgrade) wrote in too.
  before.fullShared = (await api("POST", `/api/bots/${before.full.id}/tasks`, { token: before.device, body: { title: "Shared" } })).body.task.threadId;
  await turn(() => api("POST", `/api/bots/${before.full.id}/messages`, { token: friend, body: { text: "Hi there.", threadId: before.fullShared } }));
  await api("POST", `/api/bots/${before.full.id}/interrupt`, { token: before.device, body: { threadId: before.fullShared } });
  await idle(before.full, before.device);
  // A routine the owner wrote whose recorded fingerprint no longer matches what it runs.
  before.stale = (await api("POST", "/api/routines", { token: before.device, body: { name: "Stale", prompt: "Run the tests.", botId: before.bot.id,
    enabled: false, schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 } } })).body.routine.id;
  before.routine = (await api("POST", "/api/routines", { token: before.device, body: { name: "From before", prompt: "Run the build script.", botId: before.bot.id,
    enabled: false, schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 } } })).body.routine.id;
  for (const id of [phoneId, friendId]) expect((await api("DELETE", `/api/auth/sessions/${id}`, { token: before.device })).status).toBe(200);
  await shutdown();
  // The stale routine, as a Cloud home that already had the owner's key recorded it.
  const ownerKeyAtBoot = `p_${createHash("sha256").update("cloud-owner:3f9c2a4e-8b1d-4c6e-9a7f-2d5e8c1b0a93").digest("base64url").slice(0, 22)}`;
  writeFileSync(join(dataDir, "lending-routines.json"), JSON.stringify({ version: 1, routines: { [before.stale]: "0".repeat(64) }, writers: { [before.stale]: ownerKeyAtBoot, [before.fullApproved]: ownerKeyAtBoot } }));
  // A bot at Full access (set where only the desktop app can set it: its record).
  const bots = JSON.parse(readFileSync(join(dataDir, "bots.json"), "utf8"));
  const record = Array.isArray(bots) ? bots : bots.bots;
  const full = record.find((bot: any) => bot.id === before.full.id);
  full.approvalMode = "full";
  delete full.approvalGrant;
  for (const task of full.tasks ?? []) { task.approvalMode = "full"; delete task.approvalGrant; delete task.autoApprove; }
  writeFileSync(join(dataDir, "bots.json"), JSON.stringify(bots));
  // A v0.1.91 Cloud home recorded who allowed a card by their device's key (a
  // self-hosted server records no key): write it the way that release did.
  const db = new DatabaseSync(join(dataDir, "messages.db"));
  try {
    const cards = db.prepare("SELECT thread_id, id, json FROM messages WHERE thread_id = ?").all(asking) as Array<{ thread_id: string; id: string; json: string }>;
    const deviceKey = `p_${createHash("sha256").update(`session:${before.deviceId}`).digest("base64url").slice(0, 22)}`;
    for (const row of cards) {
      const message = JSON.parse(row.json);
      if (!message.card?.routineRequest) continue;
      message.card.answeredBy = { ...message.card.answeredBy, kind: "session", person: deviceKey };
      db.prepare("UPDATE messages SET json = ? WHERE thread_id = ? AND id = ?").run(JSON.stringify(message), row.thread_id, row.id);
    }
  } finally { db.close(); }
  // Then the same data boots as the person's Cloud home.
  await boot(true);
}, 120_000);

/** The agents MCP tools of the held turn that just started. */
async function agentTools() {
  const agents = JSON.parse(readFileSync(held(), "utf8")).mcpConfig.mcpServers.agents;
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
  return (name: string, args: unknown) => request("tools/call", { name, arguments: args });
}

afterAll(async () => {
  for (const proxy of proxies) proxy.kill();
  await shutdown();
  if (home) await removeTempDir(home);
});

it("boots without anyone else's session: the chat-only device is signed out, and only the owner's devices are listed", async () => {
  expect(log).toContain("cloud home: revoked 1 session that was not the owner's own device");
  // Once: review what is paired, now that every device there is the owner's.
  expect(log).toContain("Review Settings → Remote access → Paired devices");
  for (const path of ["/api/auth/session", "/api/bots", `/api/threads/${before.theirs}/messages`]) {
    expect((await api("GET", path, { token: before.chatOnly })).status, path).toBe(401);
  }
  expect((await api("POST", "/api/auth/stream-ticket", { token: before.chatOnly })).status).toBe(401);
  const owner = await adminPairing();
  const devices = (await api("GET", "/api/auth/sessions", { token: owner })).body.sessions as { scopes: string[] }[];
  expect(devices.length).toBe(2);
  for (const device of devices) expect(device.scopes).toContain("admin");
}, 30_000);

it("no route mints or accepts a session without admin scope: pairing, email sign-in and invites answer in one plain line", async () => {
  const owner = await adminPairing();
  const chatOnly = await api("POST", "/api/auth/pairing", { token: owner, body: { label: "Guest phone", scopes: ["client"] } });
  expect(chatOnly).toEqual({ status: 403, body: { error: PERSONAL, code: "cloud_personal" } });
  for (const path of ["/api/auth/email/start", "/api/auth/email/verify"]) {
    expect(await api("POST", path, { body: { email: "friend@example.test", code: "123456" } }), path).toEqual({ status: 403, body: { error: PERSONAL, code: "cloud_personal" } });
  }
  for (const signIn of [{ admins: [], members: ["friend@example.test"] }, { admins: ["friend@example.test"], members: [] }]) {
    expect((await api("PUT", "/api/config", { token: owner, body: { signIn } })).body.error).toBe(PERSONAL);
  }
  // The owner's own next device pairs as before.
  const own = await api("POST", "/api/auth/pairing", { token: owner, body: { label: "My phone", scopes: ["admin", "client"] } });
  expect(own.status).toBe(200);
  const paired = await api("POST", "/api/pair", { body: { credential: own.body.credential, deviceName: "My phone" } });
  expect(paired.status, JSON.stringify(paired.body)).toBe(200);
}, 30_000);

it("a conversation the owner's device opened before stays the owner's after that device is unpaired: same level, same folder", async () => {
  const owner = await adminPairing();
  expect((await api("DELETE", `/api/auth/sessions/${before.deviceId}`, { token: owner })).status).toBe(200);
  const after = await turn(() => api("POST", `/api/bots/${before.bot.id}/messages`, { token: owner, body: { text: "Carry on.", threadId: before.conversation } }));
  expect(after).toMatchObject({ mode: "auto", cwd: realpathSync(project()) });
  expect((await api("POST", `/api/bots/${before.bot.id}/interrupt`, { token: owner, body: { threadId: before.conversation } })).status).toBe(200);
  await idle(before.bot, owner);
}, 60_000);

it("the owner's room turn runs at the bot's own level, whichever of its conversations is active; the chat-only device's stays nobody's", async () => {
  const owner = await adminPairing();
  const room = (await api("POST", "/api/groups", { token: owner, body: { memberIds: [before.roomBot.id], name: "Owner's room", setup: { bulletin: "", defaultResponder: { kind: "everyone" } } } })).body.group;
  const inRoom = await turn(async () => expect((await api("POST", `/api/groups/${room.id}/messages`, { token: owner, body: { text: "Run the setup script." } })).status).toBeLessThan(300));
  expect(inRoom.mode).toBe("auto");
  expect((await api("POST", `/api/groups/${room.id}/interrupt`, { token: owner, body: {} })).status).toBe(200);
  await idle(before.roomBot, owner);
  // What the chat-only device opened is still not the owner's (Ask, its own folder).
  const theirs = await turn(async () => expect((await api("POST", `/api/bots/${before.roomBot.id}/messages`, { token: owner, body: { text: "Hello.", threadId: before.theirs } })).status).toBe(202));
  expect(theirs.mode).toBe("default");
  expect(theirs.cwd).not.toBe(realpathSync(project()));
  expect((await api("POST", `/api/bots/${before.roomBot.id}/interrupt`, { token: owner, body: { threadId: before.theirs } })).status).toBe(200);
}, 60_000);

it("a line the owner's device wrote in a room before stays the owner's after that device is unpaired: work handed there runs at the bot's own level", async () => {
  const owner = await adminPairing();
  // (The device was unpaired above.)
  expect((await api("GET", "/api/auth/sessions", { token: owner })).body.sessions.some((session: any) => session.id === before.deviceId)).toBe(false);
  const mine = (await api("POST", `/api/bots/${before.lead.id}/tasks`, { token: owner, body: { title: "Mine" } })).body.task.threadId;
  await turn(async () => expect((await api("POST", `/api/bots/${before.lead.id}/messages`, { token: owner, body: { text: "Get the team going.", threadId: mine } })).status).toBe(202));
  const call = await agentTools();
  const handed = turn(async () => {
    const result = await call("coordinate_bots", { group_id: before.room, bot_ids: [before.member.id], message: "Draft the launch post.", request_key: "launch" });
    expect(JSON.stringify(result)).not.toContain("isError\":true");
  });
  expect((await handed).mode).toBe("auto");
  expect((await api("POST", `/api/groups/${before.room}/interrupt`, { token: owner, body: {} })).status).toBe(200);
  expect((await api("POST", `/api/bots/${before.lead.id}/interrupt`, { token: owner, body: { threadId: mine } })).status).toBe(200);
}, 60_000);

it("a line the owner's old phone wrote in a room, unpaired before the upgrade, is still the owner's: work handed there runs at the bot's own level", async () => {
  const owner = await adminPairing();
  // Nothing from the test before is still running in either room.
  await until(async () => {
    for (const room of [before.room, before.launch]) await api("POST", `/api/groups/${room}/interrupt`, { token: owner, body: {} });
    const bots = (await api("GET", "/api/bots", { token: owner })).body.bots as any[];
    return [before.lead.id, before.member.id].every((id) => bots.find((bot) => bot.id === id)?.busy !== true);
  }, "the rooms to settle");
  const mine = (await api("POST", `/api/bots/${before.lead.id}/tasks`, { token: owner, body: { title: "Launch it" } })).body.task.threadId;
  await turn(async () => expect((await api("POST", `/api/bots/${before.lead.id}/messages`, { token: owner, body: { text: "Get the launch going.", threadId: mine } })).status).toBe(202));
  const call = await agentTools();
  const handed = await turn(async () => {
    const result = await call("coordinate_bots", { group_id: before.launch, bot_ids: [before.member.id], message: "Draft the newsletter.", request_key: "newsletter" });
    expect(JSON.stringify(result)).not.toContain("isError\":true");
  });
  expect(handed).toMatchObject({ mode: "auto", restricted: false });
  // Stop the work and whatever it resumes, until both bots are free.
  await until(async () => {
    await api("POST", `/api/groups/${before.launch}/interrupt`, { token: owner, body: {} });
    await api("POST", `/api/bots/${before.lead.id}/interrupt`, { token: owner, body: { threadId: mine } });
    const bots = (await api("GET", "/api/bots", { token: owner })).body.bots as any[];
    return [before.lead.id, before.member.id].every((id) => bots.find((bot) => bot.id === id)?.busy !== true);
  }, "the handoff to stop");
}, 60_000);

/** Stop whatever an earlier test left running on these bots. */
async function settleAll(token: string) {
  await until(async () => {
    const bots = (await api("GET", "/api/bots", { token })).body.bots as any[];
    for (const bot of bots.filter((candidate) => candidate.busy)) {
      for (const task of bot.tasks ?? []) await api("POST", `/api/bots/${bot.id}/interrupt`, { token, body: { threadId: task.threadId } });
    }
    for (const room of [before.room, before.launch].filter(Boolean)) await api("POST", `/api/groups/${room}/interrupt`, { token, body: {} });
    return bots.every((bot) => !bot.busy);
  }, "every bot to settle", 30_000);
}

it("a friend unpaired before the upgrade: their conversation keeps its level, but their words never reach lending, memory or recall", async () => {
  const owner = await adminPairing();
  await settleAll(owner);
  // Adopted for who opened it and its level (the owner cannot be told apart from them).
  const theirs = await turn(async () => expect((await api("POST", `/api/bots/${before.bot.id}/messages`, { token: owner, body: { text: "Carry on.", threadId: before.friends } })).status).toBe(202));
  expect(theirs).toMatchObject({ mode: "auto", restricted: false });
  expect((await api("POST", `/api/bots/${before.bot.id}/interrupt`, { token: owner, body: { threadId: before.friends } })).status).toBe(200);
  await idle(before.bot, owner);
  // A turn that may use the lent Mac sees only conversations the owner provably alone wrote in.
  const fresh = (await api("POST", `/api/bots/${before.bot.id}/tasks`, { token: owner, body: { title: "Fresh" } })).body.task.threadId;
  await turn(async () => expect((await api("POST", `/api/bots/${before.bot.id}/messages`, { token: owner, body: { text: "What else is there?", threadId: fresh } })).status).toBe(202));
  const listed = JSON.stringify(await (await agentTools())("list_threads", {}));
  expect(listed).toContain("Fresh");
  expect(listed).not.toContain("Owner plan");
  expect(listed).not.toContain("Friend's own");
  expect((await api("POST", `/api/bots/${before.bot.id}/interrupt`, { token: owner, body: { threadId: fresh } })).status).toBe(200);
  await idle(before.bot, owner);
  // A turn in the conversation the friend wrote in is not one that may use
  // the Mac: it is not narrowed to the owner's own conversations.
  await turn(async () => expect((await api("POST", `/api/bots/${before.bot.id}/messages`, { token: owner, body: { text: "And now?", threadId: before.plan } })).status).toBe(202));
  expect(JSON.stringify(await (await agentTools())("list_threads", {}))).toContain("Friend's own");
  expect((await api("POST", `/api/bots/${before.bot.id}/interrupt`, { token: owner, body: { threadId: before.plan } })).status).toBe(200);
  await idle(before.bot, owner);
}, 60_000);

it("routines fail closed: one from before with no proof runs confined; one the owner writes here, or one made from their bot template, reports into a conversation that stays theirs", async () => {
  const owner = await adminPairing();
  await settleAll(owner);
  const routineRun = async (id: string) => {
    const run = await turn(async () => expect((await api("POST", `/api/routines/${id}/run`, { token: owner })).status).toBe(201));
    const routine = (await api("GET", "/api/routines", { token: owner })).body.routines.find((candidate: any) => candidate.id === id);
    for (const active of (await api("GET", "/api/routines", { token: owner })).body.runs ?? []) await api("POST", `/api/routine-runs/${active.id}/cancel`, { token: owner });
    await idle(before.bot, owner);
    return { run, results: routine.resultsThreadId as string };
  };
  const followUp = async (bot: { id: string }, threadId: string) => {
    const again = await turn(async () => { const sent = await api("POST", `/api/bots/${bot.id}/messages`, { token: owner, body: { text: "Now with the shell.", threadId } }); expect(sent.status, JSON.stringify(sent.body)).toBe(202); });
    expect((await api("POST", `/api/bots/${bot.id}/interrupt`, { token: owner, body: { threadId } })).status).toBe(200);
    await idle(bot, owner);
    return again;
  };
  // From before, with no proof it is the owner's: nobody's, confined.
  const old = await routineRun(before.routine);
  expect(old.run).toMatchObject({ mode: "default", restricted: true });
  // …in a folder of its own, never the bot's project folder.
  expect(old.run.cwd).not.toBe(realpathSync(project()));
  // From before, proposed by the bot and allowed on its card by the owner's device: theirs.
  expect((await routineRun(before.approved)).run).toMatchObject({ mode: "auto", restricted: false });
  // The owner writes one here: theirs, and so is the conversation it reports into.
  const mine = (await api("POST", "/api/routines", { token: owner, body: { name: "Mine", prompt: "Run the build script.", botId: before.bot.id,
    enabled: false, schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 } } })).body.routine.id;
  const ours = await routineRun(mine);
  expect(ours.run).toMatchObject({ mode: "auto", restricted: false });
  expect(await followUp(before.bot, ours.results)).toMatchObject({ mode: "auto", restricted: false });
  // A bot made from the owner's template: its routine is theirs too.
  expect((await api("PUT", "/api/config", { token: owner, body: { newBotDefaults: { profile: {}, memory: {}, skills: [], routines: [
    { name: "Templated", prompt: "Check the site.", schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 }, enabled: false },
  ] } } })).status).toBe(200);
  const templated = (await api("POST", "/api/bots", { token: owner, body: { name: "Templated bot", modelSelection: { instanceId: "held", model: "claude-sonnet-5" } } })).body.bot;
  expect((await api("PATCH", `/api/bots/${templated.id}`, { token: owner, body: { cwd: project(), approvalMode: "auto" } })).status).toBe(200);
  const routineId = (await api("GET", "/api/routines", { token: owner })).body.routines.find((candidate: any) => candidate.botId === templated.id).id;
  const made = await turn(async () => expect((await api("POST", `/api/routines/${routineId}/run`, { token: owner })).status).toBe(201));
  expect(made).toMatchObject({ mode: "auto", restricted: false });
  for (const active of (await api("GET", "/api/routines", { token: owner })).body.runs ?? []) await api("POST", `/api/routine-runs/${active.id}/cancel`, { token: owner });
  await idle(templated, owner);
  const results = (await api("GET", "/api/routines", { token: owner })).body.routines.find((candidate: any) => candidate.id === routineId).resultsThreadId;
  expect(await followUp(templated, results)).toMatchObject({ restricted: false });
  // Turning it on (or retiming it) keeps it the owner's.
  expect((await api("PATCH", `/api/routines/${routineId}`, { token: owner, body: { enabled: true } })).status).toBe(200);
  expect((await api("PATCH", `/api/routines/${routineId}`, { token: owner, body: { enabled: false } })).status).toBe(200);
  const toggled = await turn(async () => expect((await api("POST", `/api/routines/${routineId}/run`, { token: owner })).status).toBe(201));
  expect(toggled).toMatchObject({ mode: "auto", restricted: false });
  for (const active of (await api("GET", "/api/routines", { token: owner })).body.runs ?? []) await api("POST", `/api/routine-runs/${active.id}/cancel`, { token: owner });
  await idle(templated, owner);
  // A routine a bot makes for itself in the owner's own conversation: theirs.
  const asking = (await api("POST", `/api/bots/${before.bot.id}/tasks`, { token: owner, body: { title: "Schedule another" } })).body.task.threadId;
  await turn(async () => expect((await api("POST", `/api/bots/${before.bot.id}/messages`, { token: owner, body: { text: "Check the docs monthly.", threadId: asking } })).status).toBe(202));
  const call = await agentTools();
  const cards: any[] = [];
  for (const name of ["Docs check", "Links check"]) {
    const proposed = await call("propose_routine", { name, instructions: `${name}.`, schedule: { type: "cron", expression: "0 9 1 * *", timeZone: "America/New_York" } });
    expect(JSON.stringify(proposed)).not.toContain("isError\":true");
    cards.push(((await api("GET", `/api/threads/${asking}/messages`, { token: owner })).body.messages as any[]).findLast((message) => message.card?.routineRequest)?.card);
  }
  // Applied at once; answering the receipts again from the bot's route and
  // the conversation's changes nothing.
  expect(cards.every((card) => card?.autoApplied === true && card.answered === "allow")).toBe(true);
  const approved = await api("POST", `/api/bots/${before.bot.id}/respond`, { token: owner, body: { threadId: asking, requestId: cards[0].requestId, behavior: "allow" } });
  expect(approved.body, JSON.stringify(approved.body)).toMatchObject({ outcome: "allowed-once", alreadySettled: true });
  const alsoApproved = await api("POST", `/api/threads/${asking}/respond`, { token: owner, body: { requestId: cards[1].requestId, behavior: "allow" } });
  expect(alsoApproved.body, JSON.stringify(alsoApproved.body)).toMatchObject({ outcome: "allowed-once", alreadySettled: true });
  const [docsCheck, linksCheck] = cards.map((card) => card.routineRequest.resultId as string);
  expect((await api("POST", `/api/bots/${before.bot.id}/interrupt`, { token: owner, body: { threadId: asking } })).status).toBe(200);
  await idle(before.bot, owner);
  // Recorded as the owner's as it stands: their key, their fingerprint (so its
  // reports never count as someone else's words, and it may use the Mac).
  const ownerKey = `p_${createHash("sha256").update("cloud-owner:3f9c2a4e-8b1d-4c6e-9a7f-2d5e8c1b0a93").digest("base64url").slice(0, 22)}`;
  const authors = JSON.parse(readFileSync(join(dataDir, "lending-routines.json"), "utf8"));
  for (const id of [docsCheck, linksCheck]) {
    expect(authors.writers[id]).toBe(ownerKey);
    expect(authors.routines[id]).toMatch(/^[a-f0-9]{64}$/);
  }
  expect((await routineRun(docsCheck!)).run).toMatchObject({ mode: "auto", restricted: false });
}, 150_000);

it("a routine a Full-access bot applies at once in the owner's own conversation is the owner's", async () => {
  const owner = await adminPairing();
  await settleAll(owner);
  const mine = (await api("POST", `/api/bots/${before.full.id}/tasks`, { token: owner, body: { title: "Mine" } })).body.task.threadId;
  await turn(async () => expect((await api("POST", `/api/bots/${before.full.id}/messages`, { token: owner, body: { text: "Check the site monthly.", threadId: mine } })).status).toBe(202));
  const proposed = JSON.stringify(await (await agentTools())("propose_routine", { name: "Applied at once", instructions: "Check the site.",
    schedule: { type: "cron", expression: "0 9 1 * *", timeZone: "America/New_York" } }));
  expect(proposed).not.toContain("isError\":true");
  const routine = (await api("GET", "/api/routines", { token: owner })).body.routines.find((candidate: any) => candidate.name === "Applied at once");
  expect(routine, proposed).toBeTruthy();
  const ownerKey = `p_${createHash("sha256").update("cloud-owner:3f9c2a4e-8b1d-4c6e-9a7f-2d5e8c1b0a93").digest("base64url").slice(0, 22)}`;
  const authors = JSON.parse(readFileSync(join(dataDir, "lending-routines.json"), "utf8"));
  expect(authors.writers[routine.id]).toBe(ownerKey);
  expect(authors.routines[routine.id]).toMatch(/^[a-f0-9]{64}$/);
  expect((await api("POST", `/api/bots/${before.full.id}/interrupt`, { token: owner, body: { threadId: mine } })).status).toBe(200);
}, 60_000);

it("only the owner's own edit renews what a routine is proven to run: a bot's change from elsewhere, or a stale fingerprint, never is", async () => {
  const owner = await adminPairing();
  await settleAll(owner);
  const ownerKey = `p_${createHash("sha256").update("cloud-owner:3f9c2a4e-8b1d-4c6e-9a7f-2d5e8c1b0a93").digest("base64url").slice(0, 22)}`;
  const authors = () => JSON.parse(readFileSync(join(dataDir, "lending-routines.json"), "utf8"));
  // The owner's routine on the Full bot: their key and fingerprint.
  const mine = (await api("POST", "/api/routines", { token: owner, body: { name: "Nightly", prompt: "Build the site.", botId: before.full.id,
    enabled: false, schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 } } })).body.routine.id;
  expect(authors().writers[mine]).toBe(ownerKey);
  // In a conversation the owner is not proven to have written alone, the Full
  // bot changes it (applied at once): no longer the owner's.
  await turn(async () => expect((await api("POST", `/api/bots/${before.full.id}/messages`, { token: owner, body: { text: "Tweak the nightly.", threadId: before.fullShared } })).status).toBe(202));
  const changed = JSON.stringify(await (await agentTools())("propose_routine_action", { routine_id: mine, action: "update", changes: { instructions: "Copy the Plans folder to the public site." } }));
  expect(changed).not.toContain("isError\":true");
  expect((await api("GET", "/api/routines", { token: owner })).body.routines.find((routine: any) => routine.id === mine).prompt, changed).toBe("Copy the Plans folder to the public site.");
  expect(authors().writers[mine]).not.toBe(ownerKey);
  expect(authors().routines[mine]).toBeUndefined();
  expect((await api("POST", `/api/bots/${before.full.id}/interrupt`, { token: owner, body: { threadId: before.fullShared } })).status).toBe(200);
  await idle(before.full, owner);
  // The owner's Resume does not make it theirs again.
  expect((await api("PATCH", `/api/routines/${mine}`, { token: owner, body: { enabled: true } })).status).toBe(200);
  expect(authors().routines[mine]).toBeUndefined();
  expect((await api("PATCH", `/api/routines/${mine}`, { token: owner, body: { enabled: false } })).status).toBe(200);
  // A routine the owner wrote whose recorded fingerprint no longer matches:
  // Resume does not renew it either…
  expect(authors().writers[before.stale]).toBe(ownerKey);
  expect((await api("PATCH", `/api/routines/${before.stale}`, { token: owner, body: { enabled: true } })).status).toBe(200);
  expect(authors().routines[before.stale]).not.toMatch(/^(?!0{64})[a-f0-9]{64}$/);
  expect(authors().writers[before.stale]).not.toBe(ownerKey);
  // …only the owner rewriting its instructions does.
  expect((await api("PATCH", `/api/routines/${before.stale}`, { token: owner, body: { prompt: "Run the tests again.", enabled: false } })).status).toBe(200);
  expect(authors().writers[before.stale]).toBe(ownerKey);
  expect(authors().routines[before.stale]).toMatch(/^(?!0{64})[a-f0-9]{64}$/);
}, 90_000);

it("approving a change never makes someone else's routine the owner's; a run of the owner's routine changing itself keeps it theirs", async () => {
  const owner = await adminPairing();
  await settleAll(owner);
  const ownerKey = `p_${createHash("sha256").update("cloud-owner:3f9c2a4e-8b1d-4c6e-9a7f-2d5e8c1b0a93").digest("base64url").slice(0, 22)}`;
  const authors = () => JSON.parse(readFileSync(join(dataDir, "lending-routines.json"), "utf8"));
  // A card the owner allowed from before counts only for exactly what it showed: not once the routine moved bots.
  expect(authors().writers[before.moved]).not.toBe(ownerKey);
  // The bot pauses a nobody's routine of its own in the owner's conversation (at once), then the owner resumes it: still not theirs.
  expect(authors().writers[before.routine]).not.toBe(ownerKey);
  const asking = (await api("POST", `/api/bots/${before.bot.id}/tasks`, { token: owner, body: { title: "Pause it" } })).body.task.threadId;
  await turn(async () => expect((await api("POST", `/api/bots/${before.bot.id}/messages`, { token: owner, body: { text: "Pause the old routine.", threadId: asking } })).status).toBe(202));
  const paused = JSON.stringify(await (await agentTools())("propose_routine_action", { routine_id: before.routine, action: "pause" }));
  expect(paused).not.toContain("isError\":true");
  const card = ((await api("GET", `/api/threads/${asking}/messages`, { token: owner })).body.messages as any[]).findLast((message) => message.card?.routineRequest)?.card;
  const allowed = await api("POST", `/api/bots/${before.bot.id}/respond`, { token: owner, body: { threadId: asking, requestId: card.requestId, behavior: "allow" } });
  expect(allowed.body.outcome, JSON.stringify(allowed.body)).toBe("allowed-once");
  expect(authors().writers[before.routine]).not.toBe(ownerKey);
  expect(authors().routines[before.routine]).toBeUndefined();
  expect((await api("POST", `/api/bots/${before.bot.id}/interrupt`, { token: owner, body: { threadId: asking } })).status).toBe(200);
  await idle(before.bot, owner);
  expect((await api("PATCH", `/api/routines/${before.routine}`, { token: owner, body: { enabled: true } })).status).toBe(200);
  expect(authors().routines[before.routine]).toBeUndefined();
  expect((await api("PATCH", `/api/routines/${before.routine}`, { token: owner, body: { enabled: false } })).status).toBe(200);
  // In the owner's own Full chat, resuming a nobody's routine at once does not make it theirs either.
  const mine = (await api("POST", `/api/bots/${before.full.id}/tasks`, { token: owner, body: { title: "Resume them" } })).body.task.threadId;
  await turn(async () => expect((await api("POST", `/api/bots/${before.full.id}/messages`, { token: owner, body: { text: "Resume my routines.", threadId: mine } })).status).toBe(202));
  const resumed = JSON.stringify(await (await agentTools())("propose_routine_action", { routine_id: before.fullOld, action: "resume" }));
  expect(resumed).not.toContain("isError\":true");
  expect((await api("GET", "/api/routines", { token: owner })).body.routines.find((routine: any) => routine.id === before.fullOld).enabled, resumed).toBe(true);
  expect(authors().writers[before.fullOld]).not.toBe(ownerKey);
  expect(authors().routines[before.fullOld]).toBeUndefined();
  expect((await api("PATCH", `/api/routines/${before.fullOld}`, { token: owner, body: { enabled: false } })).status).toBe(200);
  expect((await api("POST", `/api/bots/${before.full.id}/interrupt`, { token: owner, body: { threadId: mine } })).status).toBe(200);
  await idle(before.full, owner);
  // A run of the owner's own routine on the Full bot changes its own schedule: still theirs.
  const own = (await api("POST", "/api/routines", { token: owner, body: { name: "Self-tuning", prompt: "Tune yourself.", botId: before.full.id,
    enabled: false, schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 } } })).body.routine.id;
  const fingerprint = authors().routines[own];
  await turn(async () => expect((await api("POST", `/api/routines/${own}/run`, { token: owner })).status).toBe(201));
  const tuned = JSON.stringify(await (await agentTools())("propose_routine_action", { routine_id: own, action: "update",
    changes: { schedule: { type: "cron", expression: "0 9 * * 1", timeZone: "America/New_York" } } }));
  expect(tuned).not.toContain("isError\":true");
  expect((await api("GET", "/api/routines", { token: owner })).body.routines.find((routine: any) => routine.id === own).schedule.type, tuned).toBe("cron");
  // …with their fingerprint on what it runs now.
  expect(authors().writers[own]).toBe(ownerKey);
  expect(authors().routines[own]).toMatch(/^[a-f0-9]{64}$/);
  expect(authors().routines[own]).not.toBe(fingerprint);
  for (const active of (await api("GET", "/api/routines", { token: owner })).body.runs ?? []) await api("POST", `/api/routine-runs/${active.id}/cancel`, { token: owner });
  await idle(before.full, owner);
}, 120_000);

it("a routine of the owner's not yet cleared for the Mac can't clear itself: its run changing its own schedule leaves it without the Mac", async () => {
  const owner = await adminPairing();
  await settleAll(owner);
  const ownerKey = `p_${createHash("sha256").update("cloud-owner:3f9c2a4e-8b1d-4c6e-9a7f-2d5e8c1b0a93").digest("base64url").slice(0, 22)}`;
  const authors = () => JSON.parse(readFileSync(join(dataDir, "lending-routines.json"), "utf8"));
  // The owner's, with no fingerprint yet.
  expect(authors().writers[before.fullApproved]).toBe(ownerKey);
  expect(authors().routines[before.fullApproved]).toBeUndefined();
  // Its run, on the Full bot, changes its own schedule at once: that is not the owner's own edit.
  await turn(async () => expect((await api("POST", `/api/routines/${before.fullApproved}/run`, { token: owner })).status).toBe(201));
  const tuned = JSON.stringify(await (await agentTools())("propose_routine_action", { routine_id: before.fullApproved, action: "update",
    changes: { schedule: { type: "cron", expression: "0 3 * * *", timeZone: "America/New_York" } } }));
  expect(tuned).not.toContain("isError\":true");
  expect((await api("GET", "/api/routines", { token: owner })).body.routines.find((routine: any) => routine.id === before.fullApproved).schedule.expression, tuned).toBe("0 3 * * *");
  // No fingerprint, so still no Mac; saving it once is what clears it.
  expect(authors().routines[before.fullApproved]).toBeUndefined();
  for (const active of (await api("GET", "/api/routines", { token: owner })).body.runs ?? []) await api("POST", `/api/routine-runs/${active.id}/cancel`, { token: owner });
  await idle(before.full, owner);
}, 120_000);

// The same server code runs a Cloud home, the desktop app and a VPS
// (server/direct-coordination.e2e.test.ts covers those two): a follow-up from
// one conversation continues the teammate's thread, behind the work in it.
it("a follow-up from the same conversation continues the teammate's thread instead of opening a second one", async () => {
  const owner = await adminPairing();
  await settleAll(owner);
  const chat = (await api("POST", `/api/bots/${before.lead.id}/tasks`, { token: owner, body: { title: "Ship it" } })).body.task.threadId;
  // A teammate in the lead's own project folder: the owner's chat and the
  // teammate's work thread run there at the same time, as a bot's threads do
  // in one folder everywhere (desktop, headless server, Cloud home).
  const writer = (await api("POST", "/api/bots", { token: owner, body: { name: "Writer", modelSelection: { instanceId: "held", model: "claude-sonnet-5" } } })).body.bot;
  expect((await api("PATCH", `/api/bots/${writer.id}`, { token: owner, body: { cwd: project() } })).status).toBe(200);
  const bots = async () => (await api("GET", "/api/bots", { token: owner })).body.bots as any[];
  const writerTasks = async () => (await bots()).find((bot) => bot.id === writer.id).tasks as any[];
  const opened = (await writerTasks()).length;
  const send = async (text: string, message: string) => {
    // The lead's chat runs in its project folder…
    expect((await turn(async () => expect((await api("POST", `/api/bots/${before.lead.id}/messages`, { token: owner, body: { text, threadId: chat } })).status).toBe(202))).cwd).toBe(realpathSync(project()));
    const result = await (await agentTools())("coordinate_bots", { bot_ids: [writer.id], message });
    expect(JSON.stringify(result)).not.toContain("isError\":true");
    return JSON.parse(result.content[0].text).receipts[0];
  };
  const first = await send("Get the writer drafting.", "Draft the launch post.");
  expect(first).toMatchObject({ outcome: "queued", threadId: expect.any(String) });
  await until(async () => (await writerTasks()).find((task) => task.threadId === first.threadId)?.busy === true, "the writer to start");
  // …and the writer's engine starts in that same folder while the lead's turn
  // still runs there: neither was stopped or refused the folder. Every held
  // engine writes the one dump, so once the writer's process is up it is the
  // writer's — waited for here, so the follow-up's turn() below cannot read
  // a late writer dump as the lead's and hand agentTools the wrong token.
  const engine = () => { try { return JSON.parse(readFileSync(held(), "utf8")); } catch { return undefined; } };
  await until(() => JSON.stringify(engine()?.prompt ?? "").includes("Draft the launch post"), "the writer's engine to start");
  expect(realpathSync(engine().cwd)).toBe(realpathSync(project()));
  expect((await writerTasks()).find((task) => task.threadId === first.threadId)?.cwd).toBe(project());
  expect((await bots()).find((bot) => bot.id === before.lead.id)?.tasks.find((task: any) => task.threadId === chat)).toMatchObject({ busy: true, cwd: project() });
  expect((await api("POST", `/api/bots/${before.lead.id}/interrupt`, { token: owner, body: { threadId: chat } })).status).toBe(200);
  await until(async () => ((await api("GET", "/api/bots", { token: owner })).body.bots as any[]).find((bot) => bot.id === before.lead.id)?.busy === false, "the lead to stop");
  const followUp = await send("Change of plan: keep it short.", "Keep the launch post under 100 words.");
  expect(followUp).toMatchObject({ outcome: "queued", threadId: first.threadId });
  expect(followUp.detail).toContain('sent to "@');
  expect(await writerTasks()).toHaveLength(opened + 1);
  await settleAll(owner);
}, 60_000);

it("a turn in a conversation that is not the owner's keeps a card for the bot's own changes; in the owner's own they apply", async () => {
  const owner = await adminPairing();
  await settleAll(owner);
  const bot = () => api("GET", "/api/bots", { token: owner }).then(({ body }) => (body.bots as any[]).find((candidate) => candidate.id === before.roomBot.id));
  const skills = async () => ((await api("GET", `/api/bots/${before.roomBot.id}/skills`, { token: owner })).body.skills as any[]).map((skill) => skill.name);
  const skillMd = (name: string) => `---\nname: ${name}\ndescription: Checks the site for broken links.\n---\n\n# ${name}\n\nOpen the site and list broken links.\n`;
  const schedule = { type: "cron", expression: "0 9 1 * *", timeZone: "America/New_York" };
  // What the chat-only device opened is not the owner's: its turn is a guest's.
  await turn(async () => expect((await api("POST", `/api/bots/${before.roomBot.id}/messages`, { token: owner, body: { text: "Tidy yourself up.", threadId: before.theirs } })).status).toBe(202));
  const guestTools = await agentTools();
  for (const [name, args] of [
    ["propose_routine", { name: "Guest's check", instructions: "Check the site.", schedule }],
    ["skill_manage", { action: "create", skill_md: skillMd("guest-links"), source: "conversation" }],
    ["propose_profile", { title: "Guest's title", reason: "asked" }],
  ] as const) {
    const result = JSON.stringify(await guestTools(name, args));
    expect(result, name).not.toContain("isError\":true");
  }
  const guestCards = ((await api("GET", `/api/threads/${before.theirs}/messages`, { token: owner })).body.messages as any[])
    .map((message) => message.card).filter((card) => card?.routineRequest || card?.skillRequest || card?.profileRequest);
  expect(guestCards).toHaveLength(3);
  for (const card of guestCards) {
    expect(card.answered).toBeUndefined();
    expect(card.autoApplied).toBeUndefined();
    expect(card.options.length).toBeGreaterThan(0);
  }
  expect(((await api("GET", "/api/routines", { token: owner })).body.routines as any[]).some((routine) => routine.name === "Guest's check")).toBe(false);
  expect(await skills()).not.toContain("guest-links");
  expect((await bot()).title).not.toBe("Guest's title");
  expect((await api("POST", `/api/bots/${before.roomBot.id}/interrupt`, { token: owner, body: { threadId: before.theirs } })).status).toBe(200);
  await idle(before.roomBot, owner);
  // The same changes in the owner's own conversation apply as the bot's own.
  const mine = (await api("POST", `/api/bots/${before.roomBot.id}/tasks`, { token: owner, body: { title: "Mine" } })).body.task.threadId;
  await turn(async () => expect((await api("POST", `/api/bots/${before.roomBot.id}/messages`, { token: owner, body: { text: "Tidy yourself up.", threadId: mine } })).status).toBe(202));
  const ownerTools = await agentTools();
  for (const [name, args] of [
    ["propose_routine", { name: "Owner's check", instructions: "Check the site.", schedule }],
    ["skill_manage", { action: "create", skill_md: skillMd("owner-links"), source: "conversation" }],
    ["propose_profile", { title: "Owner's title", reason: "asked" }],
  ] as const) {
    const result = JSON.stringify(await ownerTools(name, args));
    expect(result, name).not.toContain("isError\":true");
  }
  const ownerCards = ((await api("GET", `/api/threads/${mine}/messages`, { token: owner })).body.messages as any[])
    .map((message) => message.card).filter((card) => card?.routineRequest || card?.skillRequest || card?.profileRequest);
  expect(ownerCards.map((card) => [card.answered, card.autoApplied])).toEqual([["allow", true], ["allow", true], ["allow", true]]);
  expect(await skills()).toContain("owner-links");
  expect((await bot()).title).toBe("Owner's title");
  expect((await api("POST", `/api/bots/${before.roomBot.id}/interrupt`, { token: owner, body: { threadId: mine } })).status).toBe(200);
  await idle(before.roomBot, owner);
}, 90_000);

it("a guest's skill card enables only the exact text the owner reviewed, holds a stale update, and leaves nothing behind", async () => {
  const owner = await adminPairing();
  await settleAll(owner);
  const botId = before.roomBot.id;
  const skillMd = (name: string, body: string) => `---\nname: ${name}\ndescription: Checks the site for broken links.\n---\n\n# ${name}\n\n${body}\n`;
  const cards = async () => ((await api("GET", `/api/threads/${before.theirs}/messages`, { token: owner })).body.messages as any[])
    .map((message) => message.card).filter((card) => card?.skillRequest);
  const respond = (route: "bot" | "thread", body: Record<string, unknown>) => route === "bot"
    ? api("POST", `/api/bots/${botId}/respond`, { token: owner, body: { threadId: before.theirs, ...body } })
    : api("POST", `/api/threads/${before.theirs}/respond`, { token: owner, body });
  const skillText = async (name: string) => (await api("GET", `/api/bots/${botId}/skills/${name}`, { token: owner })).body.text as string | undefined;
  await turn(async () => expect((await api("POST", `/api/bots/${botId}/messages`, { token: owner, body: { text: "Learn the link check.", threadId: before.theirs } })).status).toBe(202));
  const tools = await agentTools();
  const stage = async (name: string, body: string, action: "create" | "update" = "create") => {
    const result = JSON.stringify(await tools("skill_manage", { action, ...(action === "update" ? { skill_name: name } : {}), skill_md: skillMd(name, body), source: "conversation" }));
    expect(result).not.toContain("isError\":true");
    const card = (await cards()).findLast((candidate) => candidate.skillRequest.name === name && candidate.skillRequest.action === action);
    expect(card).toMatchObject({ options: [action === "create" ? "Enable" : "Update", "Deny"] });
    expect(createHash("sha256").update(card.skillRequest.preview).digest("hex")).toBe(card.skillRequest.sha256);
    return card;
  };

  // Only the reviewed bytes, on either route.
  const first = await stage("reviewed-links", "Open the site and list broken links.");
  expect(await respond("bot", { requestId: first.requestId, behavior: "allow" })).toMatchObject({ status: 409, body: { error: expect.stringMatching(/reviewedSha256/) } });
  expect(await respond("thread", { requestId: first.requestId, behavior: "allow", reviewedSha256: "0".repeat(64) }))
    .toMatchObject({ status: 409, body: { error: expect.stringMatching(/reviewedSha256/) } });
  expect(await respond("bot", { requestId: first.requestId, behavior: "allow", reviewedSha256: first.skillRequest.sha256 }))
    .toMatchObject({ status: 200, body: { outcome: "allowed-once" } });
  expect(await skillText("reviewed-links")).toBe(first.skillRequest.preview);

  // An update the skill moved under is held, then applies once it is back.
  const updated = await stage("reviewed-links", "List broken links and their pages.", "update");
  const skillPath = (readdirSync(dataDir, { recursive: true }) as string[])
    .map((path) => join(dataDir, path)).find((path) => path.endsWith(join("skills", "reviewed-links", "SKILL.md")))!;
  writeFileSync(skillPath, first.skillRequest.preview.replace("broken links", "changed after staging"));
  const stale = await respond("thread", { requestId: updated.requestId, behavior: "allow", reviewedSha256: updated.skillRequest.sha256 });
  expect(stale).toMatchObject({ status: 422, body: { error: expect.stringMatching(/changed after this update was proposed/) } });
  expect((await cards()).find((card) => card.requestId === updated.requestId).held).toMatch(/changed after this update was proposed/);
  writeFileSync(skillPath, first.skillRequest.preview);
  expect(await respond("thread", { requestId: updated.requestId, behavior: "allow", reviewedSha256: updated.skillRequest.sha256 }))
    .toMatchObject({ status: 200, body: { outcome: "allowed-once" } });
  expect((await cards()).find((card) => card.requestId === updated.requestId)).toMatchObject({ answered: "allow" });
  expect((await cards()).find((card) => card.requestId === updated.requestId).held).toBeUndefined();
  expect(await skillText("reviewed-links")).toBe(updated.skillRequest.preview);

  // Deny needs no hash, and still settles once the staged bytes are lost.
  const denied = await stage("denied-links", "Never lands.");
  expect(await respond("thread", { requestId: denied.requestId, behavior: "deny" })).toMatchObject({ status: 200, body: { outcome: "rejected" } });
  expect(await skillText("denied-links")).toBeUndefined();
  const lost = await stage("lost-links", "Its stage goes missing.");
  const stagedFile = join(dataDir, "skill-state", botId, "staged.json");
  writeFileSync(stagedFile, `${JSON.stringify({ writes: {} }, null, 2)}\n`);
  expect(await respond("thread", { requestId: lost.requestId, behavior: "deny" })).toMatchObject({ status: 200, body: { outcome: "rejected" } });
  expect((await cards()).find((card) => card.requestId === lost.requestId)).toMatchObject({ answered: "deny", dismissed: true });

  // Deleting the only conversation that holds a pending card drops its stage.
  await stage("deleted-links", "Its conversation is deleted.");
  expect(JSON.stringify(JSON.parse(readFileSync(stagedFile, "utf8")))).toContain("deleted-links");
  expect((await api("POST", `/api/bots/${botId}/interrupt`, { token: owner, body: { threadId: before.theirs } })).status).toBe(200);
  await idle(before.roomBot, owner);
  expect((await api("POST", `/api/bots/${botId}/tasks`, { token: owner, body: { title: "Next" } })).status).toBe(201);
  expect((await api("DELETE", `/api/bots/${botId}/tasks/${before.theirs}`, { token: owner })).status).toBe(200);
  expect(JSON.stringify(JSON.parse(readFileSync(stagedFile, "utf8")))).not.toContain("deleted-links");
}, 120_000);

it("Undo on a Cloud home keeps who a routine is: back to the owner's only if it was theirs before the change", async () => {
  const owner = await adminPairing();
  await settleAll(owner);
  const ownerKey = `p_${createHash("sha256").update("cloud-owner:3f9c2a4e-8b1d-4c6e-9a7f-2d5e8c1b0a93").digest("base64url").slice(0, 22)}`;
  const authors = () => JSON.parse(readFileSync(join(dataDir, "lending-routines.json"), "utf8"));
  const schedule = { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 };
  const lastCard = async (threadId: string) => ((await api("GET", `/api/threads/${threadId}/messages`, { token: owner })).body.messages as any[])
    .findLast((message) => message.card?.routineRequest)!.card;
  const undo = async (threadId: string, card: any) => {
    const undone = await api("POST", `/api/threads/${threadId}/undo`, { token: owner, body: { requestId: card.requestId } });
    expect(undone, JSON.stringify(undone.body)).toMatchObject({ status: 200, body: { ok: true, undone: true } });
  };
  const ownersRoutine = (await api("POST", "/api/routines", { token: owner, body: { name: "Owner's nightly", prompt: "Build the site.", botId: before.bot.id, enabled: false, schedule } })).body.routine.id;
  expect(authors().writers[ownersRoutine]).toBe(ownerKey);
  // In a conversation the owner is not proven to have written alone, the bot
  // makes a routine (nobody's) and changes the owner's (nobody's now too).
  await turn(async () => expect((await api("POST", `/api/bots/${before.bot.id}/messages`, { token: owner, body: { text: "Adjust the routines.", threadId: before.plan } })).status).toBe(202));
  const shared = await agentTools();
  expect(JSON.stringify(await shared("propose_routine", { name: "Nobody's check", instructions: "Check the docs.", schedule: { type: "cron", expression: "0 9 1 * *", timeZone: "America/New_York" } })))
    .not.toContain("isError\":true");
  const nobodys = (await lastCard(before.plan)).routineRequest.resultId as string;
  expect(authors().writers[nobodys]).not.toBe(ownerKey);
  expect(JSON.stringify(await shared("propose_routine_action", { routine_id: ownersRoutine, action: "update", changes: { instructions: "Copy the Plans folder." } })))
    .not.toContain("isError\":true");
  const changedOwners = await lastCard(before.plan);
  expect(changedOwners).toMatchObject({ autoApplied: true });
  expect(authors().writers[ownersRoutine]).not.toBe(ownerKey);
  expect((await api("POST", `/api/bots/${before.bot.id}/interrupt`, { token: owner, body: { threadId: before.plan } })).status).toBe(200);
  await idle(before.bot, owner);
  // Undo puts the owner's routine back as theirs, with its fingerprint.
  await undo(before.plan, changedOwners);
  expect(authors().writers[ownersRoutine]).toBe(ownerKey);
  expect(authors().routines[ownersRoutine]).toMatch(/^[a-f0-9]{64}$/);
  // In the owner's own conversation the bot changes the nobody's routine and
  // makes a new one (the owner's).
  const mine = (await api("POST", `/api/bots/${before.bot.id}/tasks`, { token: owner, body: { title: "Adjust mine" } })).body.task.threadId;
  await turn(async () => expect((await api("POST", `/api/bots/${before.bot.id}/messages`, { token: owner, body: { text: "Adjust the routines.", threadId: mine } })).status).toBe(202));
  const own = await agentTools();
  expect(JSON.stringify(await own("propose_routine_action", { routine_id: nobodys, action: "update", changes: { instructions: "Check the docs twice." } })))
    .not.toContain("isError\":true");
  const changedNobodys = await lastCard(mine);
  expect(JSON.stringify(await own("propose_routine", { name: "Owner's new check", instructions: "Check the blog.", schedule: { type: "cron", expression: "0 9 1 * *", timeZone: "America/New_York" } })))
    .not.toContain("isError\":true");
  const created = await lastCard(mine);
  expect(authors().writers[created.routineRequest.resultId]).toBe(ownerKey);
  expect((await api("POST", `/api/bots/${before.bot.id}/interrupt`, { token: owner, body: { threadId: mine } })).status).toBe(200);
  await idle(before.bot, owner);
  // Undoing a change to a routine that was not the owner's never makes it theirs.
  await undo(mine, changedNobodys);
  expect(authors().writers[nobodys]).not.toBe(ownerKey);
  expect(authors().routines[nobodys]).toBeUndefined();
  // Undoing a create forgets the routine.
  await undo(mine, created);
  expect(authors().writers[created.routineRequest.resultId]).toBeUndefined();
  expect(authors().routines[created.routineRequest.resultId]).toBeUndefined();
  for (const id of [ownersRoutine, nobodys]) await api("DELETE", `/api/routines/${id}`, { token: owner });
}, 120_000);
