// A guest's turn on an OMB Cloud home gets no shell, and no process a bot
// runs finds the Cloud's secrets (docs/cloud-pro.md). Real server booted the
// way the image's launcher boots it (secrets over a pipe, never the
// environment: server/cloud-home-start.ts), synthetic engines. A Cloud home
// is personal (server/cloud-owner.ts), so no guest can connect: the guest
// gates are kept, fail-closed, for what a guest left behind before then (a
// conversation, room or routine that is nobody's), written into the server's
// records while it is stopped (testing/cloud-left-behind.ts), and the owner
// acts in it.
import { randomBytes, randomUUID } from "node:crypto";
import { connect } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { spawnWithSecrets } from "./cloud-home-start.ts";
import { cloudPairingSignature } from "./cloud-home.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { markLeftBehind } from "./testing/cloud-left-behind.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const HOST = "omb-t-0123456789ab.fly.dev";
const secret = randomBytes(32).toString("base64url");
const relayToken = `box_omb_${randomBytes(32).toString("base64url")}`;
let home = "";
let base = "";
let child: ChildProcess;
let log = "";
let owner = "";
let boot: () => Promise<void> = async () => {};
const proxies: ChildProcess[] = [];

async function api(method: string, path: string, options: { body?: unknown; token?: string } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      host: HOST, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https", origin: `https://${HOST}`,
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { status: response.status, body: await response.json().catch(() => null) as any };
}

/** The Admin's signed pairing: it only works when the server got the secret. */
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

const probeOf = (name: string) => join(home, `${name}-probe.json`);
/** A wrapper around a fake engine that first reads what an engine's shell
 * could: its own environment and its parent's (the server's) starting one. */
function probing(name: string, fake: string, extra: string): string {
  const cli = join(home, `${name}-cli.mjs`);
  writeFileSync(cli, `#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
const environ = (pid) => { try {
  return process.platform === "linux" ? readFileSync("/proc/" + pid + "/environ", "utf8")
    : execFileSync("ps", ["eww", "-p", String(pid), "-o", "command="]).toString();
} catch (error) { return "unreadable: " + error.message; } };
if (process.argv[2] !== "--version" && process.argv[2] !== "auth") {
  writeFileSync(${JSON.stringify(probeOf(name))}, JSON.stringify({ parent: environ(process.ppid), own: JSON.stringify(process.env) }));
}
${extra}
await import(${JSON.stringify(pathToFileURL(join(SERVER_DIR, "testing", fake)).href)});
`, { mode: 0o755 });
  return cli;
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "omb-cloud-guest-shell-"));
  const dataDir = join(home, ".openmausbot");
  mkdirSync(dataDir, { recursive: true });
  const codex = probing("codex", "fake-codex-app-server.ts", `process.env.FAKE_CODEX_DUMP = ${JSON.stringify(join(home, "codex.json"))};`);
  // A Claude whose turns hold until the test writes the release file; each
  // engine dumps its latest start to <name>.json.
  const held = (name: string) => probing(name, "fake-claude-cli.ts", `if (process.argv[2] === "auth") { console.log(JSON.stringify({ loggedIn: true, email: "person@example.test" })); process.exit(0); }
process.env.FAKE_CLAUDE_VERSION = "2.1.284";
if (process.argv[2] !== "--version") { process.env.FAKE_CLAUDE_DUMP = ${JSON.stringify(home)} + "/${name}.json"; process.env.FAKE_CLAUDE_MODE = "hang"; process.env.FAKE_CLAUDE_RELEASE = ${JSON.stringify(join(home, "release"))}; }`);
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({
    instances: {
      ...Object.fromEntries(["cursor", "openaiCompat", "qwen", "hermes", "pi", "omp", "claude"].map((id) => [id, { driver: "not-a-real-driver" }])),
      codex: { driver: "codex", displayName: "Codex", config: { cli: codex } },
      held: { driver: "claudeAgent", displayName: "Held", config: { cli: held("claude") } },
      teammate: { driver: "claudeAgent", displayName: "Teammate", config: { cli: held("teammate") } },
      // An engine that cannot run a turn without its own shell (ACP).
      shelled: { driver: "grokAgent", displayName: "Shelled", config: { cli: join(SERVER_DIR, "testing", "fake-acp-cli.ts") } },
    },
  }));
  const port = await freePortBlock([0, 1]);
  base = `http://127.0.0.1:${port}`;
  const offlinePrelude = `data:text/javascript,${encodeURIComponent('const real = globalThis.fetch; globalThis.fetch = async (url, init) => String(url).startsWith("http://127.0.0.1:") ? real(url, init) : new Response("offline fixture", { status: 503 });')}`;
  // As the launcher starts it: the contract in the environment, the secrets on the pipe.
  // Every process the server starts, and whether the secrets' pipe was still
  // its descriptor 3 then (it must be read and closed before anything starts).
  const spawnWatch = join(home, "spawn-watch.mjs");
  writeFileSync(spawnWatch, `import { createRequire, syncBuiltinESMExports } from "node:module";
import { appendFileSync, fstatSync } from "node:fs";
const cp = createRequire(import.meta.url)("node:child_process");
let pipe; try { pipe = fstatSync(3).ino; } catch {}
for (const name of ["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync", "fork"]) {
  const original = cp[name];
  cp[name] = function (...args) {
    let open = false; try { open = pipe !== undefined && fstatSync(3).ino === pipe; } catch {}
    appendFileSync(${JSON.stringify(join(home, "spawns.log"))}, name + " " + String(args[0]).slice(0, 60) + (open ? " PIPE-OPEN" : "") + "\\n");
    return original.apply(this, args);
  };
}
syncBuiltinESMExports();
`);
  boot = async () => {
    child = spawnWithSecrets(process.execPath, ["--import", offlinePrelude, "--import", pathToFileURL(spawnWatch).href, join(SERVER_DIR, "index.ts")], {
      PATH: process.env.PATH, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home, USERPROFILE: home, OMB_DATA_DIR: dataDir, OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1),
      OMB_CLOUD_ROLE: "home", OMB_CLOUD_MACHINE_ID: "3f9c2a4e-8b1d-4c6e-9a7f-2d5e8c1b0a93", OMB_CLOUD_ADMIN_URL: "https://cloud.example.test",
      OMB_PUBLIC_URL: `https://${HOST}`, OMB_CLOUD_BOAT_URL: "https://cloud.example.test/api/cloud/services/boat/api/box/v1",
      OMB_CLOUD_SECRETS_FD: "3",
    }, { OMB_CLOUD_BOOTSTRAP_SECRET: secret, OMB_CLOUD_BOAT_TOKEN: relayToken });
    (child.stdout as NodeJS.ReadableStream | null)?.on("data", (chunk) => { log += chunk; });
    const deadline = Date.now() + 20_000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`the Cloud home exited:\n${log}`);
      try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* starting */ }
      if (Date.now() > deadline) throw new Error(`the Cloud home did not start:\n${log}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };
  await boot();
  owner = await adminPairing();
}, 40_000);

afterAll(async () => {
  for (const proxy of proxies) proxy.kill();
  if (child) await waitForExit(child, { signal: "SIGTERM" });
  if (home) await removeTempDir(home);
});

const newBot = async (name: string, instanceId: string) =>
  (await api("POST", "/api/bots", { token: owner, body: { name, modelSelection: { instanceId, model: instanceId === "codex" ? "gpt-5.5" : "claude-sonnet-5" } } })).body.bot as { id: string; threadId: string };
/** What a guest left behind (a conversation, room or routine), as nobody's:
 * written into the server's records while it is stopped. */
async function leftBehind(of: { threadId?: string; routineId?: string }) {
  for (const proxy of proxies.splice(0)) proxy.kill();
  await waitForExit(child, { signal: "SIGTERM" });
  markLeftBehind(join(home, ".openmausbot"), { threadIds: of.threadId ? [of.threadId] : [], routineIds: of.routineId ? [of.routineId] : [] });
  await boot();
}
/** A conversation a guest opened with a bot before the Cloud was personal. */
const guestThread = async (bot: { id: string }) => {
  const threadId = (await api("POST", `/api/bots/${bot.id}/tasks`, { token: owner, body: { title: "Guest's" } })).body.task.threadId as string;
  await leftBehind({ threadId });
  return threadId;
};
const ownThread = async (bot: { id: string }) => (await api("POST", `/api/bots/${bot.id}/tasks`, { token: owner, body: { title: "Mine" } })).body.task.threadId as string;
/** The agents MCP tools of the turn whose Claude dump is at `dump`. */
async function agentTools(dump: string) {
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
  return (name: string, args: unknown) => request("tools/call", { name, arguments: args });
}
const say = (token: string, bot: { id: string }, text: string, threadId: string) =>
  api("POST", `/api/bots/${bot.id}/messages`, { token, body: { text, threadId } });

it("boots with its secrets from the launcher's pipe: the Admin's signed pairing works", () => {
  expect(owner).toMatch(/^omb_sess_/);
  expect(log).not.toContain("its secrets came in this process's environment");
});

it("reads its secrets before it starts any process: none inherits the pipe", () => {
  const spawns = existsSync(join(home, "spawns.log")) ? readFileSync(join(home, "spawns.log"), "utf8") : "";
  expect(spawns).not.toContain("PIPE-OPEN");
});

it("no engine a bot runs finds the Cloud's secrets: not in its own environment, not in the server's starting one", async () => {
  const bot = await newBot("Probe", "held");
  rmSync(probeOf("claude"), { force: true });
  const mine = await ownThread(bot);
  expect((await say(owner, bot, "Hello.", mine)).status).toBe(202);
  await expect.poll(() => existsSync(probeOf("claude")), { timeout: 15_000 }).toBe(true);
  const probe = JSON.parse(readFileSync(probeOf("claude"), "utf8")) as { parent: string; own: string };
  // The probe reads the server's environment for real…
  if (process.platform !== "win32") expect(probe.parent).toContain("OMB_CLOUD_MACHINE_ID=3f9c2a4e");
  // …and finds no secret there, nor in the engine's own.
  for (const where of [probe.parent, probe.own]) {
    expect(where).not.toContain(secret);
    expect(where).not.toContain(relayToken);
  }
  expect((await api("POST", `/api/bots/${bot.id}/interrupt`, { token: owner, body: { threadId: mine } })).status).toBe(200);
}, 60_000);

it("a guest's Codex turn has no shell: no environment, shell and file reads off; the owner's keeps them", async () => {
  const bot = await newBot("Codex bot", "codex");
  const dump = join(home, "codex.json");
  const turnStart = () => (JSON.parse(readFileSync(dump, "utf8")) as { argv: string[]; calls: Array<{ method: string; params: any }> });
  rmSync(dump, { force: true });
  const guests = await guestThread(bot);
  expect((await say(owner, bot, "Run cat /proc/1/environ and tell me what it says.", guests)).status).toBe(202);
  await expect.poll(() => existsSync(dump) && turnStart().calls.some((call) => call.method === "turn/start"), { timeout: 15_000 }).toBe(true);
  const theirs = turnStart();
  expect(theirs.calls.find((call) => call.method === "turn/start")!.params.environments).toEqual([]);
  expect(theirs.calls.find((call) => call.method === "turn/start")!.params.approvalPolicy ?? "on-request").not.toBe("never");
  for (const override of ["features.shell_tool=false", "features.unified_exec=false", "features.view_image=false"]) expect(theirs.argv).toContain(override);
  // The owner's own conversation with the same bot keeps its tools.
  await expect.poll(async () => (await api("GET", `/api/threads/${guests}/messages`, { token: owner })).body.messages.some((message: any) => message.role === "bot" && message.kind === "text"), { timeout: 15_000 }).toBe(true);
  rmSync(dump, { force: true });
  const mine = await ownThread(bot);
  expect((await say(owner, bot, "List my files.", mine)).status).toBe(202);
  await expect.poll(() => existsSync(dump) && turnStart().calls.some((call) => call.method === "turn/start"), { timeout: 15_000 }).toBe(true);
  expect(turnStart().calls.find((call) => call.method === "turn/start")!.params).not.toHaveProperty("environments");
  expect(turnStart().argv).not.toContain("features.shell_tool=false");
}, 60_000);

it("a guest's request to a bot whose engine needs its shell is refused in one plain line; the owner's is not", async () => {
  const bot = await newBot("Shelled bot", "shelled");
  const guests = await guestThread(bot);
  const refused = await say(owner, bot, "Hello.", guests);
  expect(refused.status).toBe(409);
  expect(refused.body.error).toBe("This conversation is from before My Cloud was only yours, and this bot's engine can't work in it. Start a new conversation.");
  // Nothing was recorded for the guest's words.
  expect(((await api("GET", `/api/threads/${guests}/messages`, { token: owner })).body.messages as any[]).filter((message) => message.role === "user")).toEqual([]);
  expect((await say(owner, bot, "Hello.", await ownThread(bot))).status).toBe(202);
}, 60_000);

it("a guest's Claude turn has no command-running tool and no read outside its folder; the owner's keeps its tools", async () => {
  const bot = await newBot("Claude bot", "held");
  const dump = join(home, "claude.json");
  const argv = () => JSON.parse(readFileSync(dump, "utf8")).argv as string[];
  const after = (flag: string) => argv()[argv().indexOf(flag) + 1];
  rmSync(dump, { force: true });
  const guests = await guestThread(bot);
  expect((await say(owner, bot, "Run cat /proc/1/environ.", guests)).status).toBe(202);
  await expect.poll(() => existsSync(dump), { timeout: 15_000 }).toBe(true);
  expect(argv()).toContain("--restricted");
  expect(after("--tools")).toBe("Read,Grep,Glob,Edit,Write,WebSearch");
  expect(after("--permission-mode")).toBe("default");
  // A card it raises is the owner's to answer, once: never "always allow".
  const socket = connect(JSON.parse(readFileSync(dump, "utf8")).mcpConfig.mcpServers.ogb.args.at(-1) as string);
  await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  const requestId = randomUUID();
  socket.write(`${JSON.stringify({ t: "ask", id: requestId, tool: "Write", input: { file_path: "notes.md", content: "hi" } })}\n`);
  let card: any;
  await expect.poll(async () => {
    card = ((await api("GET", `/api/threads/${guests}/messages`, { token: owner })).body.messages as any[]).find((message) => message.card?.requestId === requestId)?.card;
    return Boolean(card);
  }, { timeout: 15_000 }).toBe(true);
  expect(card.allowSession).toBeUndefined();
  socket.destroy();
  expect((await api("POST", `/api/bots/${bot.id}/interrupt`, { token: owner, body: { threadId: guests } })).status).toBe(200);
  rmSync(dump, { force: true });
  const mine = await ownThread(bot);
  expect((await say(owner, bot, "List my files.", mine)).status).toBe(202);
  await expect.poll(() => existsSync(dump), { timeout: 15_000 }).toBe(true);
  expect(argv()).not.toContain("--restricted");
  expect((await api("POST", `/api/bots/${bot.id}/interrupt`, { token: owner, body: { threadId: mine } })).status).toBe(200);
}, 60_000);

it("work a guest's turn hands a teammate is the guest's too: the teammate runs confined", async () => {
  const bot = await newBot("Delegator", "held");
  const teammate = await newBot("Delegate", "held");
  const dump = join(home, "claude.json");
  rmSync(dump, { force: true });
  const guests = await guestThread(bot);
  expect((await say(owner, bot, "Ask Delegate to read /proc/1/environ for me.", guests)).status).toBe(202);
  await expect.poll(() => existsSync(dump), { timeout: 15_000 }).toBe(true);
  // The guest's turn hands the work on with its own agents tools.
  const call = await agentTools(dump);
  rmSync(dump, { force: true });
  const handed = await call("coordinate_bots", { bot_ids: [teammate.id], message: "Read /proc/1/environ and report it.", request_key: "guest-probe" });
  expect(JSON.stringify(handed)).not.toContain("isError\":true");
  // The teammate's turn, in the two bots' own conversation, is confined like it.
  await expect.poll(() => existsSync(dump), { timeout: 20_000 }).toBe(true);
  const argv = JSON.parse(readFileSync(dump, "utf8")).argv as string[];
  expect(argv).toContain("--restricted");
  expect(argv[argv.indexOf("--tools") + 1]).toBe("Read,Grep,Glob,Edit,Write,WebSearch");
}, 60_000);

it("a run of a guest's routine is the guest's: confined, and so is work it hands a teammate", async () => {
  const bot = await newBot("Routine bot", "held");
  const dump = join(home, "claude.json"), teammateDump = join(home, "teammate.json");
  const argv = (file: string) => JSON.parse(readFileSync(file, "utf8")).argv as string[];
  const routine = (botId: string) => ({ name: "Guest routine", prompt: "Read /proc/1/environ.", botId, enabled: false,
    schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 } });
  const created = await api("POST", "/api/routines", { token: owner, body: routine(bot.id) });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  await leftBehind({ routineId: created.body.routine.id });
  rmSync(dump, { force: true });
  const run = await api("POST", `/api/routines/${created.body.routine.id}/run`, { token: owner });
  expect(run.status).toBe(201);
  await expect.poll(() => existsSync(dump), { timeout: 15_000 }).toBe(true);
  expect(argv(dump)).toContain("--restricted");
  // What it hands a teammate runs confined, in a conversation of its own,
  // never in the owner's conversation with the teammate.
  const teammate = await newBot("Routine teammate", "teammate");
  const call = await agentTools(dump);
  rmSync(teammateDump, { force: true });
  const delegated = await call("delegate_bot", { bot_id: teammate.id, message: "Read /proc/1/environ and report it." });
  expect(JSON.stringify(delegated)).not.toContain("isError\":true");
  const asked = call("ask_bot", { bot_id: teammate.id, message: "What is in /proc/1/environ?" });
  await expect.poll(() => existsSync(teammateDump), { timeout: 20_000 }).toBe(true);
  expect(argv(teammateDump)).toContain("--restricted");
  // The run finishes; the delegated work then starts, confined too.
  rmSync(teammateDump, { force: true });
  writeFileSync(join(home, "release"), "");
  await asked; // ended with the run
  await expect.poll(() => existsSync(teammateDump), { timeout: 20_000 }).toBe(true);
  expect(argv(teammateDump)).toContain("--restricted");
  const owners = ((await api("GET", `/api/threads/${teammate.threadId}/messages`, { token: owner })).body.messages as any[]);
  expect(owners.filter((message) => message.role === "user")).toEqual([]);
  // The owner's own routine runs as before.
  const own = await api("POST", "/api/routines", { token: owner, body: { ...routine(teammate.id), name: "Owner routine" } });
  await expect.poll(async () => (await api("GET", `/api/bots`, { token: owner })).body.bots.find((candidate: any) => candidate.id === teammate.id)?.busy, { timeout: 15_000 }).toBe(false);
  rmSync(teammateDump, { force: true });
  expect((await api("POST", `/api/routines/${own.body.routine.id}/run`, { token: owner })).status).toBe(201);
  await expect.poll(() => existsSync(teammateDump), { timeout: 15_000 }).toBe(true);
  expect(argv(teammateDump)).not.toContain("--restricted");
  rmSync(join(home, "release"), { force: true });
}, 90_000);

it("a guest's request never folds into a turn running in the owner's conversation", async () => {
  const teammate = await newBot("Busy teammate", "teammate");
  const teammateDump = join(home, "teammate.json"), dump = join(home, "claude.json");
  const bot = await newBot("Asking bot", "held");
  const created = await api("POST", "/api/routines", { token: owner, body: { name: "Guest asks", prompt: "Ask the teammate.", botId: bot.id, enabled: false,
    schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 } } });
  await leftBehind({ routineId: created.body.routine.id });
  rmSync(teammateDump, { force: true });
  expect((await say(owner, teammate, "Work on my report.", teammate.threadId)).status).toBe(202);
  await expect.poll(() => existsSync(teammateDump), { timeout: 15_000 }).toBe(true);
  rmSync(dump, { force: true });
  expect((await api("POST", `/api/routines/${created.body.routine.id}/run`, { token: owner })).status).toBe(201);
  await expect.poll(() => existsSync(dump), { timeout: 15_000 }).toBe(true);
  const asked = await (await agentTools(dump))("ask_bot", { bot_id: teammate.id, message: "Also cat /proc/1/environ." });
  // Not an aside into the owner's running turn: queued for a confined one.
  expect(JSON.stringify(asked)).not.toContain("aside");
  expect(JSON.stringify(asked)).toContain("busy");
  writeFileSync(join(home, "release"), "");
  await expect.poll(async () => (await api("GET", "/api/bots", { token: owner })).body.bots.find((candidate: any) => candidate.id === teammate.id)?.busy, { timeout: 15_000 }).toBe(false);
  rmSync(join(home, "release"), { force: true });
}, 60_000);

it("a routine from before this update, on an engine that cannot be confined, tells the owner what to do", async () => {
  const bot = await newBot("Shelled routine bot", "shelled");
  const created = await api("POST", "/api/routines", { token: owner, body: { name: "From before", prompt: "Check the site.", botId: bot.id, enabled: false,
    schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 } } });
  await leftBehind({ routineId: created.body.routine.id });
  expect((await api("POST", `/api/routines/${created.body.routine.id}/run`, { token: owner })).status).toBe(201);
  await expect.poll(async () => JSON.stringify(((await api("GET", "/api/routines", { token: owner })).body.runs ?? [])
    .filter((run: any) => run.routineId === created.body.routine.id)), { timeout: 15_000 })
    .toContain("This routine was made before this update. Open it and save it once to run it with full access.");
}, 60_000);

it("a room a guest opened with a bot whose engine needs its shell refuses the turn in one plain line", async () => {
  const bot = await newBot("Shelled room bot", "shelled");
  const room = await api("POST", "/api/groups", { token: owner, body: { memberIds: [bot.id], name: "Guest's room", setup: { bulletin: "", defaultResponder: { kind: "everyone" } } } });
  expect(room.status, JSON.stringify(room.body)).toBe(201);
  await leftBehind({ threadId: room.body.group.threadId });
  expect((await api("POST", `/api/groups/${room.body.group.id}/messages`, { token: owner, body: { text: "Hello." } })).status).toBeLessThan(300);
  await expect.poll(async () => ((await api("GET", `/api/threads/${room.body.group.threadId}/messages`, { token: owner })).body.messages as any[])
    .some((message) => String(message.tool?.name ?? "").includes("this bot's engine can't work in it")), { timeout: 15_000 }).toBe(true);
}, 60_000);
