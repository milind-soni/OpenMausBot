// A real Team Cloud home (OMB_CLOUD_ROLE=team) whose idle windows are a quarter second (the power clock): it agrees to
// the Admin's sleep request once nobody uses it, waits while a member does, and waits for work one bot handed another
// until it is done. The engine is the synthetic Claude CLI with each bot's tool calls scripted; nothing leaves loopback.
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { cloudPairingSignature, cloudRequestSignature } from "./cloud-home.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { hostTimeout } from "./testing/host-timeout.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = fileURLToPath(new URL("./", import.meta.url));
const HOST = "omb-t-3f2e1d0c9b8a.fly.dev";
const MACHINE = "8e2f4a6b-1c3d-4e5f-8a7b-9c0d1e2f3a4b";
const TEAM = { id: "team-sleep-1", name: "Harbor" };
const OWNER = { email: "olive@harbor.test", role: "owner" as const }, MEMBER = { email: "ada@harbor.test", role: "member" as const };
const EDGE = { host: HOST, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https", origin: `https://${HOST}` };
const secret = randomBytes(32).toString("base64url");
type Bot = { id: string; threadId: string };
let home = "", base = "", log = "", owner = "", member = "";
let child: ChildProcess | undefined;
let lead: Bot, helper: Bot;

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function as(token: string, method: string, path: string, body?: unknown) {
  const response = await fetch(`${base}${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { ...EDGE, authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) } });
  return { status: response.status, body: await response.json().catch(() => null) as any };
}

/** The Admin's signed calls: its power read and its sleep request. */
async function admin(method: "GET" | "POST", path: string, body = "") {
  const timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomBytes(16).toString("base64url");
  const response = await fetch(`${base}${path}`, { method, ...(method === "POST" ? { body } : {}), headers: {
    ...EDGE, ...(method === "POST" ? { "content-type": "application/json" } : {}),
    "x-omb-cloud-timestamp": timestamp, "x-omb-cloud-nonce": nonce, "x-omb-cloud-signature": `v1=${cloudRequestSignature(secret, timestamp, nonce, method, path, body)}`,
  } });
  return { status: response.status, body: await response.json().catch(() => null) as any };
}
const askToSleep = (idleMinutes?: number) => admin("POST", "/api/cloud/power/sleep", JSON.stringify({ v: 1, ...(idleMinutes === undefined ? {} : { idleMinutes }) }));

/** The Admin's signed pairing with a member claim, redeemed into that member's bearer. */
async function pair(person: { email: string; role: "owner" | "member" }) {
  const body = JSON.stringify({ label: "OpenMausBot app (Team Cloud)", ttlSeconds: 300, team: TEAM, member: person });
  const timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomBytes(16).toString("base64url");
  const minted = await fetch(`${base}/api/cloud/pairing`, { method: "POST", body, headers: { ...EDGE, "content-type": "application/json",
    "x-omb-cloud-timestamp": timestamp, "x-omb-cloud-nonce": nonce, "x-omb-cloud-signature": `v1=${cloudPairingSignature(secret, timestamp, nonce, body)}` } });
  expect(minted.status, log.slice(-2000)).toBe(200);
  const { code } = await minted.json() as { code: string };
  const paired = await fetch(`${base}/api/auth/pair`, { method: "POST", headers: { ...EDGE, "content-type": "application/json" }, body: JSON.stringify({ code }) });
  return ((await paired.json()) as { token: string }).token;
}

/** Each bot's engine reads its own scripted tool calls (its working folder names the bot); a held call ends with `release`. */
const script = (bot: Bot, calls: unknown[] | null) => {
  const file = join(home, `tools-${bot.id}.json`);
  if (calls) writeFileSync(file, JSON.stringify(calls)); else rmSync(file, { force: true });
};

/** Asks until the home agrees (the power clock's windows are a quarter second), or gives up after `ms`. */
async function sleepsWithin(ms: number) {
  let answer = await askToSleep();
  for (const deadline = Date.now() + ms; answer.status !== 200 && Date.now() < deadline;) {
    await sleep(250);
    answer = await askToSleep();
  }
  return answer;
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "omb-cloud-team-sleep-"));
  const cli = join(home, "fixture-claude.mjs");
  writeFileSync(cli, `#!/usr/bin/env node
import { readdirSync } from "node:fs";
if (process.argv[2] === "auth") { console.log(JSON.stringify({ loggedIn: true, email: "person@example.test" })); process.exit(0); }
process.env.FAKE_CLAUDE_VERSION = "2.1.284";
process.env.FAKE_CLAUDE_RELEASE = ${JSON.stringify(join(home, "release"))};
const own = readdirSync(${JSON.stringify(home)}).map((name) => /^tools-(.+)\\.json$/.exec(name)?.[1]).find((id) => id && process.cwd().includes(id));
if (own) process.env.FAKE_CLAUDE_TOOL_CALLS_FILE = ${JSON.stringify(home)} + "/tools-" + own + ".json";
await import(${JSON.stringify(pathToFileURL(join(SERVER_DIR, "testing", "fake-claude-cli.ts")).href)});
`, { mode: 0o755 });
  writeFileSync(join(home, "config.json"), JSON.stringify({ instances: { claude: { driver: "claudeAgent", displayName: "Fixture", config: { cli } } } }));
  const port = await freePortBlock([0, 1]);
  base = `http://127.0.0.1:${port}`;
  const offline = `data:text/javascript,${encodeURIComponent('const real = globalThis.fetch; globalThis.fetch = async (url, init) => String(url).startsWith("http://127.0.0.1:") ? real(url, init) : new Response("offline fixture", { status: 503 });')}`;
  child = spawn(process.execPath, ["--import", offline, "--import", new URL("./testing/power-clock-hooks.mjs", import.meta.url).href, join(SERVER_DIR, "index.ts")], {
    cwd: join(SERVER_DIR, ".."),
    env: {
      PATH: process.env.PATH, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), HOME: home, USERPROFILE: home, OMB_DATA_DIR: home,
      OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1), OMB_CLOUD_ROLE: "team", OMB_CLOUD_TEAM_ID: TEAM.id, OMB_CLOUD_TEAM_NAME: TEAM.name,
      OMB_CLOUD_MACHINE_ID: MACHINE, OMB_CLOUD_ADMIN_URL: "https://cloud.example.test", OMB_CLOUD_BOOTSTRAP_SECRET: secret, OMB_PUBLIC_URL: `https://${HOST}`,
      OMB_TEST_POWER_CLOCK: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => { log += chunk; });
  child.stderr?.on("data", (chunk) => { log += chunk; });
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`the server exited:\n${log}`);
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
    if (Date.now() > deadline) throw new Error(`the server did not start:\n${log}`);
    await sleep(100);
  }
  owner = await pair(OWNER);
  member = await pair(MEMBER);
  const make = async (name: string) => {
    const made = await as(owner, "POST", "/api/bots", { name, modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    return made.body.bot as Bot;
  };
  lead = await make("Lead");
  helper = await make("Helper");
}, hostTimeout(90_000));

afterAll(async () => {
  if (child) await waitForExit(child, { signal: "SIGTERM" });
  if (home) await removeTempDir(home);
});

it("with nobody using it, reports idle and agrees to sleep: no hold for being a team's", async () => {
  const answer = await sleepsWithin(20_000);
  expect(answer, log.slice(-2000)).toMatchObject({ status: 200, body: { ok: true } });
  expect((await admin("GET", "/api/cloud/power")).body).toMatchObject({ sleeping: true });
  // A member opening it ends the sleep the Admin had not carried out yet.
  expect((await as(member, "GET", "/api/auth/session")).status).toBe(200);
  expect((await admin("GET", "/api/cloud/power")).body.sleeping).toBe(false);
}, hostTimeout(60_000));

it("waits while a member uses it", async () => {
  expect((await as(member, "GET", "/api/bots")).status).toBe(200);
  const read = await admin("GET", "/api/cloud/power?idleMinutes=10");
  expect(read.body).toMatchObject({ idle: false });
  expect(read.body.busy).toContain("recent-activity");
  const refused = await askToSleep(10);
  expect(refused.status).toBe(409);
  expect(refused.body.busy).toContain("recent-activity");
  expect(refused.body.busy).not.toContain("team");
}, hostTimeout(30_000));

it("waits for a hand-off between two bots until it is done, then sleeps", async () => {
  script(lead, [{ name: "coordinate_bots", server: "agents", input: { bot_ids: [helper.id], message: "Count the rooms on floor two." } }]);
  script(helper, [{ name: "Bash", input: { command: "echo counting" }, hold: true }]);
  const sent = await as(owner, "POST", `/api/bots/${lead.id}/messages`, { text: "Ask Helper to count the rooms.", threadId: lead.threadId });
  expect(sent.status, JSON.stringify(sent.body)).toBe(202);
  await expect.poll(async () => (await admin("GET", "/api/cloud/power")).body.busy, { timeout: 45_000, interval: 250 }).toContain("handoff");
  const refused = await askToSleep();
  expect(refused.status).toBe(409);
  expect(refused.body.busy).toContain("handoff");
  script(lead, null);
  writeFileSync(join(home, "release"), "");
  await expect.poll(async () => (await admin("GET", "/api/cloud/power")).body.busy, { timeout: 60_000, interval: 250 }).not.toContain("handoff");
  const answer = await sleepsWithin(30_000);
  expect(answer, log.slice(-2000)).toMatchObject({ status: 200, body: { ok: true } });
}, hostTimeout(150_000));
