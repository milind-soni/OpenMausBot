// App events on a Cloud home: the Cloud registers its own connected-apps installation, presents the Admin's grant so
// the service gives it a paid Cloud's 2,000 events a day, and the same long-poll turns an event into an owner run.
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { cloudPairingSignature } from "./cloud-home.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";
import { startBrokerFake, type BrokerFake } from "./testing/broker-fake.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const HOST = "omb-t-0a1b2c3d4e5f.fly.dev";
const MACHINE = "4b8d2c1e-9a7f-4e6d-8c5b-1a2b3c4d5e6f";
const secret = randomBytes(32).toString("base64url");
let home = "", base = "", log = "", token = "";
let child: ChildProcess | undefined;
let broker: BrokerFake;

async function api(method: string, path: string, body?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      host: HOST, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https", origin: `https://${HOST}`,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => null) as any };
}

async function ownerToken(): Promise<string> {
  const body = JSON.stringify({ label: "OpenMausBot app (Cloud)", ttlSeconds: 300 });
  const timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomBytes(16).toString("base64url");
  const response = await fetch(`${base}/api/cloud/pairing`, { method: "POST", headers: {
    host: HOST, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https", "content-type": "application/json",
    "x-omb-cloud-timestamp": timestamp, "x-omb-cloud-nonce": nonce, "x-omb-cloud-signature": `v1=${cloudPairingSignature(secret, timestamp, nonce, body)}`,
  }, body });
  const granted = await response.json() as { code: string };
  return (await api("POST", "/api/auth/pair", { code: granted.code })).body.token;
}

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  broker = await startBrokerFake();
  home = mkdtempSync(join(tmpdir(), "omb-app-events-cloud-"));
  const dataDir = join(home, ".openmausbot");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({
    instances: { claude: { driver: "claudeAgent", displayName: "Fixture", config: { cli: join(SERVER_DIR, "testing", "fake-claude-cli.ts") } } },
  }));
  const port = await freePortBlock([0, 1]);
  base = `http://127.0.0.1:${port}`;
  // Anything but loopback fails here, so the Cloud reaches only the fake service.
  const offline = `data:text/javascript,${encodeURIComponent('const real = globalThis.fetch; globalThis.fetch = async (url, init) => String(url).startsWith("http://127.0.0.1:") ? real(url, init) : new Response("offline fixture", { status: 503 });')}`;
  child = spawn(process.execPath, ["--import", offline, join(SERVER_DIR, "index.ts")], {
    cwd: join(SERVER_DIR, ".."),
    env: {
      PATH: process.env.PATH, HOME: home, USERPROFILE: home, OMB_DATA_DIR: dataDir, OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1),
      OMB_CLOUD_ROLE: "home", OMB_CLOUD_MACHINE_ID: MACHINE, OMB_CLOUD_ADMIN_URL: "https://cloud.example.test",
      OMB_CLOUD_BOOTSTRAP_SECRET: secret, OMB_PUBLIC_URL: `https://${HOST}`, FAKE_CLAUDE_MODE: "happy",
      OMB_COMPOSIO_BROKER_URL: broker.url, OMB_CLOUD_CONNECTED_APPS_GRANT: broker.cloudGrant(MACHINE),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => { log += chunk; });
  child.stderr?.on("data", (chunk) => { log += chunk; });
  const deadline = Date.now() + 25_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`the server exited:\n${log}`);
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
    if (Date.now() > deadline) throw new Error(`the server did not start:\n${log}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  token = await ownerToken();
}, 60_000);

afterAll(async () => {
  if (child) await waitForExit(child, { signal: "SIGTERM" });
  await broker?.close();
  if (home) await removeTempDir(home);
  vi.restoreAllMocks();
});

it("registers the Cloud, holds the paid limit from the Admin's grant, and runs an owner automation from an app event", async () => {
  // The Cloud registers its own installation and presents its grant.
  await expect.poll(() => broker.installationIds().find((id) => broker.cloudMachine(id) === MACHINE), { timeout: 20_000 }).toBeTruthy();
  const installation = broker.installationIds().find((id) => broker.cloudMachine(id) === MACHINE)!;
  const gmail = broker.account(broker.userFor(installation), "gmail");
  const bot = (await api("POST", "/api/bots", { name: "Ledger", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } })).body.bot;
  expect(bot?.id, log.slice(-2000)).toBeTruthy();

  const created = await api("POST", "/api/app-triggers", { botId: bot.id, name: "Invoices", prompt: "File the invoice in the event data.", app: "gmail", event: "GMAIL_NEW_GMAIL_MESSAGE", filter: { subject: "invoice" } });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  expect(created.body.trigger).toMatchObject({ accountId: gmail, remote: { state: "active" }, config: { query: "subject:(invoice)" } });
  const synced = await api("POST", "/api/app-triggers/sync");
  expect(synced.body.service).toMatchObject({ available: true, plan: "cloud", eventsPerDay: 2000 });

  await broker.deliver(created.body.trigger.remote.triggerId, { sender: "billing@globex.test", subject: "Invoice 88" }, "msg_cloud_1");
  await expect.poll(async () => (await api("GET", "/api/app-triggers")).body.triggers[0]?.received, { timeout: 30_000 }).toBe(1);
  const runId = (await api("GET", "/api/app-triggers")).body.triggers[0].lastRunId;
  await expect.poll(async () => (await api("GET", "/api/routines")).body.runs.find((run: any) => run.id === runId)?.status, { timeout: 30_000 }).toBe("completed");

  // Deleting it from the page removes the service's copy too.
  expect((await api("DELETE", `/api/app-triggers/${created.body.trigger.id}`)).status).toBe(200);
  expect(broker.harness.composio.instances.size).toBe(0);
}, 120_000);
