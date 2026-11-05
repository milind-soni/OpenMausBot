// A real server as a personal Cloud, told its plan as the Admin tells it, with the fake engine driving a real Chief turn.
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { cloudPairingSignature, cloudRequestSignature } from "./cloud-home.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const HOST = "omb-t-0123456789ab.fly.dev";
const FORWARDED = { host: HOST, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https" };
const CLAUDE = { instanceId: "claude", model: "claude-sonnet-5" };
const PACKAGE = JSON.parse(readFileSync(join(SERVER_DIR, "..", "shared", "package-fixtures", "full-team.v2.json"), "utf8"));
const manifest = (name: string) => ({ format: "openmaus.team", version: 2, team: { name, members: [{ key: "helper", name: `${name} helper`, appearance: { color: "blue" } }] } });

class Cloud {
  home = mkdtempSync(join(tmpdir(), "omb-bot-limit-"));
  dataDir = join(this.home, ".openmausbot");
  gate = join(this.home, "finish");
  dump = join(this.home, "claude.json");
  secret = randomBytes(32).toString("base64url");
  base = "";
  token = "";
  log = "";
  child: ChildProcess | null = null;
  port = 0;

  headers(extra: Record<string, string> = {}) {
    return { ...FORWARDED, origin: `https://${HOST}`, ...(this.token ? { authorization: `Bearer ${this.token}` } : {}), ...extra };
  }
  async api(method: string, path: string, body?: unknown) {
    const response = await fetch(`${this.base}${path}`, { method, headers: this.headers(body === undefined ? {} : { "content-type": "application/json" }),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json().catch(() => null) as any };
  }
  async start() {
    mkdirSync(this.dataDir, { recursive: true });
    const claude = join(this.home, "held-claude.mjs");
    writeFileSync(claude, `#!/usr/bin/env node
if (process.argv[2] === "auth") { console.log(JSON.stringify({ loggedIn: true, email: "person@example.test" })); process.exit(0); }
process.env.FAKE_CLAUDE_VERSION = "2.1.284";
if (process.argv[2] !== "--version") {
  process.env.FAKE_CLAUDE_MODE = "slow";
  process.env.FAKE_CLAUDE_SLOW_FINISH_GATE = ${JSON.stringify(this.gate)};
  process.env.FAKE_CLAUDE_DUMP = ${JSON.stringify(this.dump)};
}
await import(${JSON.stringify(pathToFileURL(join(SERVER_DIR, "testing", "fake-claude-cli.ts")).href)});
`, { mode: 0o755 });
    writeFileSync(join(this.dataDir, "config.json"), JSON.stringify({
      features: { smartSetupChoices: false },
      instances: {
        ...Object.fromEntries(["codex", "cursor", "githubCopilot", "qwen", "hermes", "pi"].map((id) => [id, { driver: "not-a-real-driver" }])),
        claude: { driver: "claudeAgent", displayName: "Claude", config: { cli: claude } },
      },
    }));
    this.port = await freePortBlock([0, 1]);
    this.base = `http://127.0.0.1:${this.port}`;
    await this.run();
  }
  async run() {
    const prelude = `data:text/javascript,${encodeURIComponent('const real = globalThis.fetch; globalThis.fetch = async (url, init) => String(url).startsWith("http://127.0.0.1:") ? real(url, init) : new Response("{}", { status: 503 });')}`;
    this.child = spawn(process.execPath, ["--import", prelude, join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: { PATH: process.env.PATH, HOME: this.home, USERPROFILE: this.home, OMB_DATA_DIR: this.dataDir, OMB_PORT: String(this.port), OMB_WEBHOOK_PORT: String(this.port + 1),
        OMB_CLOUD_ROLE: "home", OMB_CLOUD_MACHINE_ID: "3f9c2a4e-8b1d-4c6e-9a7f-2d5e8c1b0a93", OMB_CLOUD_ADMIN_URL: "https://cloud.example.test",
        OMB_CLOUD_BOOTSTRAP_SECRET: this.secret, OMB_PUBLIC_URL: `https://${HOST}` },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child.stdout?.on("data", (chunk) => { this.log += chunk; });
    this.child.stderr?.on("data", (chunk) => { this.log += chunk; });
    await expect.poll(async () => {
      if (this.child!.exitCode !== null) throw new Error(`the server exited:\n${this.log}`);
      return fetch(`${this.base}/api/health`).then((r) => r.ok).catch(() => false);
    }, { timeout: 30_000, interval: 100 }).toBe(true);
    if (!this.token) await this.pair();
  }
  async pair() {
    const body = JSON.stringify({ label: "OpenMausBot app (Cloud)", ttlSeconds: 300 });
    const timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomBytes(16).toString("base64url");
    const response = await fetch(`${this.base}/api/cloud/pairing`, { method: "POST", headers: { ...FORWARDED, "content-type": "application/json",
      "x-omb-cloud-timestamp": timestamp, "x-omb-cloud-nonce": nonce, "x-omb-cloud-signature": `v1=${cloudPairingSignature(this.secret, timestamp, nonce, body)}` }, body });
    const granted = await response.json() as { code: string };
    this.token = (await this.api("POST", "/api/auth/pair", { code: granted.code })).body.token;
  }
  /** What the Admin says, signed as it signs: which plan this Cloud is on. */
  async tellPlan(tier: string) {
    const body = JSON.stringify({ v: 1, tier }), timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomBytes(16).toString("base64url");
    const response = await fetch(`${this.base}/api/cloud/plan`, { method: "POST", body, headers: { ...FORWARDED, "content-type": "application/json",
      "x-omb-cloud-timestamp": timestamp, "x-omb-cloud-nonce": nonce, "x-omb-cloud-signature": `v1=${cloudRequestSignature(this.secret, timestamp, nonce, "POST", "/api/cloud/plan", body)}` } });
    expect(response.status).toBe(200);
  }
  async bots() { return (await this.api("GET", "/api/bots?messages=0")).body.bots as any[]; }
  async config() { return (await this.api("GET", "/api/config")).body; }
  create(name: string) { return this.api("POST", "/api/bots", { name, modelSelection: CLAUDE, useDefaults: false }); }
  async fill(count: number, prefix = "Bot") {
    for (let i = 0; i < count; i++) {
      const made = await this.create(`${prefix} ${i + 1}`);
      expect(made.status, JSON.stringify(made.body)).toBe(201);
    }
  }
  /** The capability of a real turn of this Cloud's Chief, for what the bot's own tools call. */
  async chiefTurn() {
    const chief = (await this.bots()).find((bot) => bot.chiefOfStaff);
    expect(chief, "a new Cloud's MausBot is its Chief").toBeTruthy();
    const sent = await this.api("POST", `/api/bots/${chief.id}/messages`, { text: "Add a specialist." });
    expect(sent.status, JSON.stringify(sent.body)).toBe(202);
    await expect.poll(() => existsSync(this.dump), { timeout: 20_000 }).toBe(true);
    const agents = JSON.parse(readFileSync(this.dump, "utf8")).mcpConfig.mcpServers.agents;
    const env = agents.env.OMB_GATE_UPSTREAM ? JSON.parse(agents.env.OMB_GATE_UPSTREAM).env : agents.env;
    return { chief, token: env.OMB_COMMS_TOKEN as string };
  }
  async internal(path: string, token: string, body: unknown) {
    const response = await fetch(`${this.base}${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  }
  finishTurn() { writeFileSync(this.gate, "finish"); }
  async restart() {
    this.child!.kill("SIGTERM");
    await waitForExit(this.child!);
    await this.run();
  }
  async stop() {
    this.finishTurn();
    if (this.child && this.child.exitCode === null) { this.child.kill("SIGTERM"); await waitForExit(this.child); }
    await removeTempDir(this.home);
  }
}

const REFUSED = { status: 409, body: { code: "bot_limit" } };

describe("a Starter Cloud's bots, on a real server", () => {
  let cloud: Cloud;
  afterEach(async () => { await cloud?.stop(); });
  const starter = async (tier = "starter") => {
    cloud = new Cloud();
    await cloud.start();
    await cloud.tellPlan(tier);
  };

  it("makes five beside its MausBot, says so in config, then refuses each way of making one and writes nothing", async () => {
    await starter();
    expect(await cloud.config()).toMatchObject({ cloudStarter: true, botLimit: 5 });
    const mausBot = (await cloud.bots()).filter((bot) => bot.defaultBot);
    expect(mausBot).toHaveLength(1);
    await cloud.fill(5);
    const held = (await cloud.bots()).map((bot) => bot.id).sort();
    expect(held).toHaveLength(6);

    const refused = await cloud.create("Sixth");
    expect(refused).toMatchObject(REFUSED);
    expect(refused.body.error).toBe("You've reached the 5 bots Starter includes. To create more, upgrade this Cloud.");
    // What Duplicate and a paired device's New bot send.
    expect(await cloud.api("POST", "/api/bots", {})).toMatchObject(REFUSED);
    expect(await cloud.api("POST", "/api/teams/import?mode=add", manifest("Desk"))).toMatchObject(REFUSED);
    expect(await cloud.api("POST", "/api/teams/import?mode=add", PACKAGE)).toMatchObject(REFUSED);

    const { token, chief } = await cloud.chiefTurn();
    const tool = await cloud.internal("/api/internal/create-bot", token, { fromBotId: chief.id, fromThreadId: chief.threadId, name: "Scout", role: "Specialist", instructions: "Work." });
    expect(tool).toMatchObject(REFUSED);
    expect(tool.body.error).toContain("Explain this to the person");
    expect(tool.body.error).toContain("Do not retry");
    const setup = await cloud.internal("/api/internal/team-setup-requests", token, { plan: { reason: "Add a specialist", newTeams: [],
      operations: [{ action: "create", key: "scout", fields: { name: "Scout", title: "Specialist", soul: "Work.", modelSelection: CLAUDE } }] } });
    expect(setup).toMatchObject(REFUSED);
    expect(setup.body.error).toContain("Do not retry");

    expect((await cloud.bots()).map((bot) => bot.id).sort()).toEqual(held);
  }, 120_000);

  it("takes a move and a restore at the limit, and a bot moved in keeps its id and conversation", async () => {
    await starter();
    await cloud.fill(5);
    const backup = await cloud.api("POST", "/api/teams/export", { format: "backup", name: "Saved" });
    expect(backup.status, JSON.stringify(backup.body)).toBe(200);

    const moved = await cloud.api("POST", "/api/bots", { id: "from-the-laptop-1", threadId: "laptop-thread-1", name: "From the laptop", useDefaults: false });
    expect(moved.status, JSON.stringify(moved.body)).toBe(201);
    expect(moved.body.bot).toMatchObject({ id: "from-the-laptop-1", threadId: "laptop-thread-1" });
    const after = (await cloud.bots()).length;

    const restored = await cloud.api("POST", "/api/teams/import?mode=add", backup.body);
    expect(restored.status, JSON.stringify(restored.body)).toBe(201);
    expect(restored.body.bots.length).toBeGreaterThanOrEqual(6);
    expect((await cloud.bots()).length).toBe(after + restored.body.bots.length);

    // Over the limit now: every one stays, and a new one is still refused.
    expect(await cloud.create("One more")).toMatchObject(REFUSED);
  }, 120_000);

  it("keeps every bot of a downgraded Cloud, across a restart, and lifts the limit the moment it upgrades, with no restart", async () => {
    await starter("pro");
    expect((await cloud.config()).botLimit).toBeUndefined();
    await cloud.fill(7);
    const seven = (await cloud.bots()).map((bot) => bot.id).sort();

    await cloud.tellPlan("starter");
    expect(await cloud.config()).toMatchObject({ cloudStarter: true, botLimit: 5 });
    expect((await cloud.bots()).map((bot) => bot.id).sort()).toEqual(seven);
    expect(await cloud.create("New")).toMatchObject(REFUSED);

    await cloud.restart();
    expect((await cloud.bots()).map((bot) => bot.id).sort()).toEqual(seven);
    expect(await cloud.create("New")).toMatchObject(REFUSED);

    const pid = cloud.child!.pid;
    await cloud.tellPlan("pro");
    expect((await cloud.config()).botLimit).toBeUndefined();
    expect((await cloud.create("New")).status).toBe(201);
    expect(cloud.child!.pid).toBe(pid);
  }, 120_000);

  it("makes room when a bot is archived, and the MausBot never takes any", async () => {
    await starter();
    await cloud.fill(5);
    const one = (await cloud.bots()).find((bot) => !bot.defaultBot);
    expect((await cloud.api("PATCH", `/api/bots/${one.id}`, { hidden: true })).status).toBe(200);
    expect((await cloud.create("In its place")).status).toBe(201);
    expect(await cloud.create("And another")).toMatchObject(REFUSED);
    expect((await cloud.bots()).filter((bot) => !bot.hidden)).toHaveLength(6);
  }, 120_000);

  it.each([["max"], ["personal"], ["team"]])("has no such limit on %s", async (tier) => {
    await starter(tier);
    expect((await cloud.config()).botLimit).toBeUndefined();
    await cloud.fill(6);
    expect((await cloud.api("POST", "/api/teams/import?mode=add", manifest("Desk"))).status).toBe(201);
  }, 120_000);

  it("has no limit when the Admin never said a plan, whatever the machine", async () => {
    cloud = new Cloud();
    await cloud.start();
    expect(await cloud.config()).toMatchObject({ cloudStarter: false });
    expect((await cloud.config()).botLimit).toBeUndefined();
    await cloud.fill(6);
    expect(existsSync(join(cloud.dataDir, "cloud-plan-tier.json"))).toBe(false);
  }, 120_000);

  it("a Chief's create_bot works while there's room, up to the limit", async () => {
    await starter();
    await cloud.fill(4);
    if (existsSync(cloud.dump)) unlinkSync(cloud.dump);
    const { token, chief } = await cloud.chiefTurn();
    const made = await cloud.internal("/api/internal/create-bot", token, { fromBotId: chief.id, fromThreadId: chief.threadId, name: "Fifth", role: "Specialist", instructions: "Work." });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.body).toMatchObject({ state: "applied", name: "Fifth" });
    const refused = await cloud.internal("/api/internal/create-bot", token, { fromBotId: chief.id, fromThreadId: chief.threadId, name: "Sixth", role: "Specialist", instructions: "Work." });
    expect(refused).toMatchObject(REFUSED);
  }, 120_000);
});
