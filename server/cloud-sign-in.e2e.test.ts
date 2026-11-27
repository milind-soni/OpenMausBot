// A real Cloud home (the server as the Admin runs it, with a quarter-second power clock) whose owner is signing in to
// Claude: while the paste-code sign-in is open the home refuses the Admin's sleep request as `maintenance`, a code that is
// not a code keeps it open, the health report counts the attempt with no secret in it, and a stop in the middle (the
// process killed, as a stop for sleep does) is recorded as interrupted on the next boot, which the sign-in screen's next
// read hears. Cancelling lets it sleep. The engine is a stand-in CLI; nothing leaves loopback.
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { CLOUD_HEALTH_PATH, cloudPairingSignature, cloudRequestSignature } from "./cloud-home.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { hostTimeout } from "./testing/host-timeout.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = fileURLToPath(new URL("./", import.meta.url));
const HOST = "omb-t-5a4b3c2d1e0f.fly.dev";
const MACHINE = "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const TEAM = { id: "team-sign-in-1", name: "Quayside" };
const OWNER = { email: "owner@quayside.test", role: "owner" as const };
const EDGE = { host: HOST, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https", origin: `https://${HOST}` };
const PASTED = "SHORT#1", LINK_SECRET = "state-7c1d2e";
const secret = randomBytes(32).toString("base64url");
let home = "", base = "", log = "", owner = "", port = 0;
let child: ChildProcess | undefined;

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function as(method: string, path: string, body?: unknown) {
  const response = await fetch(`${base}${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { ...EDGE, authorization: `Bearer ${owner}`, ...(body === undefined ? {} : { "content-type": "application/json" }) } });
  return { status: response.status, body: await response.json().catch(() => null) as any };
}

/** The Admin's signed calls: its health and power reads and its sleep request. */
async function admin(method: "GET" | "POST", path: string, body = "") {
  const timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomBytes(16).toString("base64url");
  const response = await fetch(`${base}${path}`, { method, ...(method === "POST" ? { body } : {}), headers: {
    ...EDGE, ...(method === "POST" ? { "content-type": "application/json" } : {}),
    "x-omb-cloud-timestamp": timestamp, "x-omb-cloud-nonce": nonce, "x-omb-cloud-signature": `v1=${cloudRequestSignature(secret, timestamp, nonce, method, path, body)}`,
  } });
  return { status: response.status, body: await response.json().catch(() => null) as any };
}
const askToSleep = () => admin("POST", "/api/cloud/power/sleep", JSON.stringify({ v: 1 }));

async function pair() {
  const body = JSON.stringify({ label: "OpenMausBot app (Team Cloud)", ttlSeconds: 300, team: TEAM, member: OWNER });
  const timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomBytes(16).toString("base64url");
  const minted = await fetch(`${base}/api/cloud/pairing`, { method: "POST", body, headers: { ...EDGE, "content-type": "application/json",
    "x-omb-cloud-timestamp": timestamp, "x-omb-cloud-nonce": nonce, "x-omb-cloud-signature": `v1=${cloudPairingSignature(secret, timestamp, nonce, body)}` } });
  expect(minted.status, log.slice(-2000)).toBe(200);
  const { code } = await minted.json() as { code: string };
  const paired = await fetch(`${base}/api/auth/pair`, { method: "POST", headers: { ...EDGE, "content-type": "application/json" }, body: JSON.stringify({ code }) });
  return ((await paired.json()) as { token: string }).token;
}

async function boot() {
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
}

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
  home = mkdtempSync(join(tmpdir(), "omb-cloud-sign-in-"));
  const cli = join(home, "fixture-claude.mjs");
  // Claude signed out: `auth login` shows its link and waits for the pasted code; anything else is the synthetic engine.
  writeFileSync(cli, `#!/usr/bin/env node
const args = process.argv.slice(2).join(" ");
if (args === "auth status --json") { console.log(JSON.stringify({ loggedIn: false })); process.exit(1); }
if (args === "auth login") {
  process.stdout.write("If the browser did not open, visit: https://claude.com/cai/oauth/authorize?code=true&state=${LINK_SECRET}\\n");
  process.stdout.write("Paste code here if prompted > ");
  process.stdin.resume();
  setInterval(() => {}, 1000);
} else {
  process.env.FAKE_CLAUDE_VERSION = "2.1.284";
  await import(${JSON.stringify(pathToFileURL(join(SERVER_DIR, "testing", "fake-claude-cli.ts")).href)});
}
`, { mode: 0o755 });
  writeFileSync(join(home, "config.json"), JSON.stringify({ instances: { claude: { driver: "claudeAgent", displayName: "Fixture", config: { cli } } } }));
  port = await freePortBlock([0, 1]);
  base = `http://127.0.0.1:${port}`;
  await boot();
  owner = await pair();
}, hostTimeout(90_000));

afterAll(async () => {
  if (child) await waitForExit(child, { signal: "SIGTERM" });
  if (home) await removeTempDir(home);
});

it("keeps the home awake while a Claude sign-in is open, counts it with no secret, and calls a stop in the middle interrupted", async () => {
  const started = await as("POST", "/api/instances/claude/auth/start", {});
  expect(started, log.slice(-2000)).toMatchObject({ status: 200, body: { auth: { phase: "waiting" } } });
  const flowId = started.body.auth.flowId as string;
  await expect.poll(async () => (await admin("GET", "/api/cloud/power")).body.busy, { timeout: 10_000, interval: 250 }).toEqual(["maintenance"]);
  const refused = await askToSleep();
  expect(refused).toMatchObject({ status: 409, body: { ok: false, busy: ["maintenance"] } });

  // Too short to be a code: refused with its reason, and the sign-in stays open.
  const pasted = await as("POST", "/api/instances/claude/auth/complete", { flowId, code: PASTED });
  expect(pasted.status).toBeGreaterThanOrEqual(400);
  expect(pasted.body).toMatchObject({ reason: "wrong_code" });
  await sleep(500);
  expect((await askToSleep()).body.busy).toEqual(["maintenance"]);

  const health = await admin("GET", `${CLOUD_HEALTH_PATH}?after=0`);
  expect(health.status).toBe(200);
  expect(health.body.signIns).toMatchObject({ attempts: 1, open: 1, engines: [{ kind: "claudeAgent", attempts: 1, completed: 0, last: { outcome: "wrong_code" } }] });
  for (const text of [JSON.stringify(health.body), log]) {
    for (const hidden of [PASTED, LINK_SECRET, flowId, owner]) expect(text).not.toContain(hidden);
  }
  expect(log).toMatch(/sign-in: claudeAgent paste-code started/);
  expect(log).toMatch(/sign-in: claudeAgent paste-code wrong_code after (?:\d+m )?\d+s/);

  // The machine is stopped under the open sign-in (Fly's stop is a SIGTERM: the server shuts down), then boots again.
  await waitForExit(child!, { signal: "SIGTERM" });
  expect(JSON.parse(readFileSync(join(home, "sign-in-trace.json"), "utf8")).open, log.slice(-2000)).toHaveLength(1);
  log = "";
  await boot();
  expect(log).toMatch(/sign-in: claudeAgent paste-code interrupted after (?:\d+m )?\d+s \(the server restarted\)/);
  owner = await pair();
  const after = await admin("GET", `${CLOUD_HEALTH_PATH}?after=0`);
  expect(after.body.signIns).toMatchObject({ attempts: 1, open: 0, engines: [{ last: { outcome: "interrupted" } }] });
  // The screen's next poll of that flow hears why it is gone.
  const status = await as("GET", `/api/instances/claude/auth/status?flowId=${encodeURIComponent(flowId)}`);
  expect(status).toMatchObject({ status: 200, body: { auth: { phase: "failed", reason: "interrupted" } } });
  const resent = await as("POST", "/api/instances/claude/auth/complete", { flowId, code: PASTED });
  expect(resent).toMatchObject({ status: 404, body: { reason: "interrupted" } });

  // A new sign-in holds the home again; cancelling it lets the home sleep.
  const again = await as("POST", "/api/instances/claude/auth/start", {});
  expect(again.status, log.slice(-2000)).toBe(200);
  await expect.poll(async () => (await admin("GET", "/api/cloud/power")).body.busy, { timeout: 10_000, interval: 250 }).toContain("maintenance");
  expect((await as("POST", "/api/instances/claude/auth/cancel", { flowId: again.body.auth.flowId })).status).toBe(200);
  const slept = await sleepsWithin(30_000);
  expect(slept, log.slice(-2000)).toMatchObject({ status: 200, body: { ok: true } });
  const last = await admin("GET", `${CLOUD_HEALTH_PATH}?after=0`);
  expect(last.body.signIns).toMatchObject({ attempts: 2, open: 0, engines: [{ last: { outcome: "cancelled" } }] });
}, hostTimeout(150_000));
