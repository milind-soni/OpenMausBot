// Three threads of one bot, each with a turn held open by a gate only the test releases, as a desktop, personal Cloud and Team Cloud server.
import { randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { cloudPairingSignature, cloudRequestSignature } from "./cloud-home.ts";
import { CONTROL_BUSY } from "./control-client.ts";
import { BROWSER_HANDED_OVER, browserBusyText } from "./host/browser-seats.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const HOST = "omb-t-0123456789ab.fly.dev";
type Role = "desktop" | "home" | "team";
const TEAM = { id: "team-7f3a", name: "Acme" };

class Fixture {
  home = mkdtempSync(join(tmpdir(), "omb-parallel-"));
  dataDir = join(this.home, ".openmausbot");
  gates = join(this.home, "gates");
  base = "";
  log = "";
  token = "";
  secret = randomBytes(32).toString("base64url");
  child: ChildProcess | null = null;
  chat: Server | null = null;
  chatInFlight: { thread: string; release: () => void }[] = [];
  extraEnv: Record<string, string> = {};
  readonly role: Role;
  constructor(role: Role) {
    this.role = role;
    mkdirSync(this.dataDir, { recursive: true });
    mkdirSync(this.gates, { recursive: true });
  }
  cloud() { return this.role !== "desktop"; }
  headers(extra: Record<string, string> = {}) {
    return {
      ...(this.cloud() ? { host: HOST, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https", origin: `https://${HOST}` } : { origin: this.base }),
      ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      ...extra,
    };
  }
  async api(method: string, path: string, body?: unknown) {
    const response = await fetch(`${this.base}${path}`, {
      method,
      headers: this.headers(body === undefined ? {} : { "content-type": "application/json" }),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json().catch(() => null) as any };
  }
  async start() {
    const claude = join(this.home, "held-claude.mjs");
    writeFileSync(claude, `#!/usr/bin/env node
import { join } from "node:path";
if (process.argv[2] === "auth") { console.log(JSON.stringify({ loggedIn: true, email: "person@example.test" })); process.exit(0); }
process.env.FAKE_CLAUDE_VERSION = "2.1.284";
if (process.argv[2] !== "--version") {
  process.env.FAKE_CLAUDE_MODE = "slow";
  process.env.FAKE_CLAUDE_SLOW_FINISH_GATE = join(${JSON.stringify(this.gates)}, "release-" + process.pid);
  process.env.FAKE_CLAUDE_DUMP = join(${JSON.stringify(this.gates)}, "claude-" + process.pid + ".json");
}
await import(${JSON.stringify(pathToFileURL(join(SERVER_DIR, "testing", "fake-claude-cli.ts")).href)});
`, { mode: 0o755 });
    const acp = join(this.home, "held-acp.mjs");
    writeFileSync(acp, `#!/usr/bin/env node
process.env.FAKE_ACP_MODE = "echo-gated";
process.env.FAKE_ACP_GATE_FILE = ${JSON.stringify(join(this.gates, "release"))};
process.env.FAKE_ACP_RPC_APPEND_FILE = ${JSON.stringify(join(this.gates, "acp-rpc.jsonl"))};
process.env.FAKE_ACP_MODELS = "fixture-fast";
await import(${JSON.stringify(pathToFileURL(join(SERVER_DIR, "testing", "fake-acp-cli.ts")).href)});
`, { mode: 0o755 });
    this.chat = createServer((req, res) => {
      if (req.method !== "POST") { res.writeHead(404).end("{}"); return; }
      let raw = "";
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => {
        const body = JSON.parse(raw) as { messages?: { role: string; content: unknown }[]; stream?: boolean };
        const last = JSON.stringify(body.messages?.findLast((m) => m.role === "user")?.content ?? "");
        const entry = { thread: last, release: () => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ id: "c", object: "chat.completion", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "done" } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
        } };
        this.chatInFlight.push(entry);
      });
    });
    await new Promise<void>((resolve) => this.chat!.listen(0, "127.0.0.1", resolve));
    const chatUrl = `http://127.0.0.1:${(this.chat.address() as AddressInfo).port}/v1`;
    writeFileSync(join(this.dataDir, "config.json"), JSON.stringify({
      features: { smartSetupChoices: false },
      instances: {
        ...Object.fromEntries(["codex", "cursor", "githubCopilot", "qwen", "hermes", "pi"].map((id) => [id, { driver: "not-a-real-driver" }])),
        claude: { driver: "claudeAgent", displayName: "Claude", config: { cli: claude } },
        heldAcp: { driver: "customAcp", displayName: "Held ACP", config: { cli: acp } },
      },
      openaiCompat: { key: "synthetic-fixture-key", url: chatUrl, model: "fixture-model" },
    }));
    const port = await freePortBlock([0, 1]);
    this.base = `http://127.0.0.1:${port}`;
    const prelude = `data:text/javascript,${encodeURIComponent('const real = globalThis.fetch; globalThis.fetch = async (url, init) => String(url).startsWith("http://127.0.0.1:") ? real(url, init) : new Response("offline fixture", { status: 503 });')}`;
    const roleEnv = this.role === "desktop" ? {} : {
      OMB_CLOUD_ROLE: this.role, OMB_CLOUD_MACHINE_ID: "3f9c2a4e-8b1d-4c6e-9a7f-2d5e8c1b0a93", OMB_CLOUD_ADMIN_URL: "https://cloud.example.test",
      OMB_CLOUD_BOOTSTRAP_SECRET: this.secret, OMB_PUBLIC_URL: `https://${HOST}`,
      ...(this.role === "team" ? { OMB_CLOUD_TEAM_ID: TEAM.id, OMB_CLOUD_TEAM_NAME: TEAM.name } : {}),
    };
    this.child = spawn(process.execPath, ["--import", prelude, join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: { PATH: process.env.PATH, HOME: this.home, USERPROFILE: this.home, OMB_DATA_DIR: this.dataDir, OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1), ...roleEnv, ...this.extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child.stdout?.on("data", (chunk) => { this.log += chunk; });
    this.child.stderr?.on("data", (chunk) => { this.log += chunk; });
    await expect.poll(async () => {
      if (this.child!.exitCode !== null) throw new Error(`the server exited:\n${this.log}`);
      return fetch(`${this.base}/api/health`).then((r) => r.ok).catch(() => false);
    }, { timeout: 30_000, interval: 100 }).toBe(true);
    if (this.cloud()) this.token = await this.pair();
  }
  async pair() {
    const body = JSON.stringify({ label: "OpenMausBot app (Cloud)", ttlSeconds: 300, ...(this.role === "team" ? { team: TEAM, member: { email: "owner@acme.test", role: "admin" } } : {}) });
    const timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomBytes(16).toString("base64url");
    const response = await fetch(`${this.base}/api/cloud/pairing`, { method: "POST", headers: {
      host: HOST, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https", "content-type": "application/json",
      "x-omb-cloud-timestamp": timestamp, "x-omb-cloud-nonce": nonce, "x-omb-cloud-signature": `v1=${cloudPairingSignature(this.secret, timestamp, nonce, body)}`,
    }, body });
    const granted = await response.json() as { code: string };
    return (await this.api("POST", "/api/auth/pair", { code: granted.code })).body.token as string;
  }
  release() {
    writeFileSync(join(this.gates, "release"), "finish");
    for (const held of this.chatInFlight.splice(0)) held.release();
    for (const name of this.claudeDumps()) writeFileSync(join(this.gates, `release-${name.slice("claude-".length, -".json".length)}`), "finish");
  }
  private turnDump(threadId: string) {
    const name = this.claudeDumps().find((file) => basename(this.dump(file).cwd) === threadId);
    if (!name) throw new Error(`no turn is running in ${threadId}`);
    return name;
  }
  /** Finishes only this thread's Claude turn. */
  finish(threadId: string) {
    writeFileSync(join(this.gates, `release-${this.turnDump(threadId).slice("claude-".length, -".json".length)}`), "finish");
  }
  /** The MCP servers this thread's Claude turn was launched with. */
  servers(threadId: string) { return this.dump(this.turnDump(threadId)).mcpConfig.mcpServers; }
  dump(file: string) { return JSON.parse(readFileSync(join(this.gates, file), "utf8")); }
  claudeDumps() {
    return readdirSync(this.gates).filter((name) => {
      if (!name.startsWith("claude-") || !name.endsWith(".json")) return false;
      try { this.dump(name); return true; } catch { return false; }
    });
  }
  async stop() {
    if (this.child && this.child.exitCode === null) { this.child.kill("SIGTERM"); await waitForExit(this.child); }
    await new Promise<void>((resolve) => this.chat ? this.chat.close(() => resolve()) : resolve());
    await removeTempDir(this.home);
  }
  claudeTurnsStarted() { return this.claudeDumps().length; }
  acpPrompts() {
    const file = join(this.gates, "acp-rpc.jsonl");
    return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((row) => row.method === "session/prompt") : [];
  }
}

const roles: Role[] = ["desktop", "home", "team"];
const CLAUDE = { instanceId: "claude", model: "claude-sonnet-5" };
const engines = [
  { name: "the Claude CLI", selection: CLAUDE, running: (f: Fixture) => f.claudeTurnsStarted() },
  { name: "an ACP agent", selection: { instanceId: "heldAcp", model: "fixture-fast" }, running: (f: Fixture) => f.acpPrompts().length },
  { name: "an OpenAI-compatible model", selection: { instanceId: "openaiCompat", model: "fixture-model" }, running: (f: Fixture) => f.chatInFlight.length },
];

async function botWithThreads(f: Fixture, selection: { instanceId: string; model: string }, count: number, name = "Scout") {
  const created = await f.api("POST", "/api/bots", { name, modelSelection: selection });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const bot = created.body.bot as { id: string; threadId: string };
  const threads = [bot.threadId];
  while (threads.length < count) {
    const made = await f.api("POST", `/api/bots/${bot.id}/tasks`, { title: `Thread ${threads.length + 1}` });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    threads.push(made.body.task.threadId);
  }
  return { botId: bot.id, threads };
}
const botRow = async (f: Fixture, botId: string) => (await f.api("GET", "/api/bots?messages=0")).body.bots.find((row: any) => row.id === botId);
const busyThreads = async (f: Fixture, botId: string) => (await botRow(f, botId)).tasks.filter((task: any) => task.busy).map((task: any) => task.threadId as string);
const send = async (f: Fixture, botId: string, threadId: string, text: string) => {
  const sent = await f.api("POST", `/api/bots/${botId}/messages`, { threadId, text });
  expect(sent.status, JSON.stringify(sent.body)).toBe(202);
  expect(sent.body.queued, JSON.stringify(sent.body)).toBeUndefined();
};
const rows = async (f: Fixture, threadId: string) => ((await f.api("GET", `/api/threads/${threadId}/messages?limit=30`)).body.messages as any[])
  .map((message) => message.tool?.name).filter((name): name is string => typeof name === "string");
const internal = async (f: Fixture, path: string, token: string, body: unknown) => {
  const response = await fetch(`${f.base}${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
};

describe.each(roles)("one bot's threads on a %s server", (role) => {
  let f: Fixture;
  afterEach(async () => { await f?.stop(); });

  it.each(engines)("are all running at once on $name", async ({ selection, running }) => {
    f = new Fixture(role);
    await f.start();
    const { botId, threads } = await botWithThreads(f, selection, 3);
    await Promise.all(threads.map((threadId, i) => send(f, botId, threadId, `Long job ${i}`)));
    await expect.poll(() => running(f), { timeout: 20_000, interval: 50 }).toBe(3);
    expect((await busyThreads(f, botId)).sort()).toEqual([...threads].sort());
    f.release();
    await expect.poll(async () => (await botRow(f, botId)).busy, { timeout: 20_000, interval: 100 }).toBe(false);
  }, 90_000);

  it("still count as busy while one finishes and another runs, so a Cloud does not sleep under the other", async () => {
    f = new Fixture(role);
    await f.start();
    const { botId, threads } = await botWithThreads(f, CLAUDE, 2);
    await send(f, botId, threads[0]!, "Long job 0");
    await send(f, botId, threads[1]!, "Long job 1");
    await expect.poll(() => f.claudeTurnsStarted(), { timeout: 20_000, interval: 50 }).toBe(2);
    f.finish(threads[0]!);
    await expect.poll(() => busyThreads(f, botId), { timeout: 20_000, interval: 100 }).toEqual([threads[1]]);
    expect((await botRow(f, botId)).busy).toBe(true);
    f.release();
    await expect.poll(async () => (await botRow(f, botId)).busy, { timeout: 20_000, interval: 100 }).toBe(false);
  }, 90_000);
});

/** An agent-browser stand-in answering MCP: no Chrome, no page. */
function inertBrowser(dir: string) {
  const browser = join(dir, "agent-browser");
  writeFileSync(browser, [
    "#!/usr/bin/env node",
    'import { createInterface } from "node:readline";',
    'if (process.argv[2] === "mcp") {',
    '  createInterface({ input: process.stdin }).on("line", (line) => {',
    '    const message = JSON.parse(line); if (message.id === undefined) return;',
    '    const result = message.method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "inert-browser", version: "1" } }',
    '      : message.method === "tools/list" ? { tools: [{ name: "agent_browser_snapshot", inputSchema: { type: "object" } }] }',
    '      : { content: [{ type: "text", text: "inert browser action" }] };',
    '    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");',
    '  });',
    '} else { if (process.argv[2] === "session") console.log(JSON.stringify({ success: true, data: { sessions: [] } })); process.exit(0); }',
  ].join("\n"), { mode: 0o755 });
  return browser;
}
const browse = (f: Fixture, threadId: string) => internal(f, "/api/internal/browser/mcp", f.servers(threadId).browser.env.OMB_MCP_TOKEN_BROWSER, {
  method: "tools/call", params: { name: "agent_browser_snapshot", arguments: {} },
});

// The stand-in is a script with a shebang, which Windows cannot run as a program.
describe.skipIf(process.platform === "win32").each(["desktop", "home"] as const)("two threads wanting one bot's browser on a %s server", (role) => {
  let f: Fixture;
  afterEach(async () => { await f?.stop(); });
  const running = async (env: Record<string, string>) => {
    f = new Fixture(role);
    f.extraEnv = { OMB_AGENT_BROWSER_PATH: inertBrowser(f.home), OMB_COMPUTER_CALL_WAIT_MS: "500", ...env };
    await f.start();
    const { botId, threads } = await botWithThreads(f, CLAUDE, 2);
    await send(f, botId, threads[0]!, "First job");
    await send(f, botId, threads[1]!, "Second job");
    await expect.poll(() => f.claudeTurnsStarted(), { timeout: 20_000, interval: 50 }).toBe(2);
    return { botId, threads };
  };

  it("wait in plain sight while both keep working, and the second gets it when the first finishes", async () => {
    const { botId, threads } = await running({});
    expect((await browse(f, threads[0]!)).body.result.isError).toBeFalsy();
    const waiting = await browse(f, threads[1]!);
    expect(waiting.status, "the second thread's call is answered, not refused").toBe(200);
    expect(waiting.body.result).toEqual({ isError: true, content: [{ type: "text", text: browserBusyText(500) }] });
    expect((await rows(f, threads[1]!)).find((name) => name.startsWith("Waiting for the browser")), "the person sees why").toContain("Scout is using it");
    expect((await busyThreads(f, botId)).sort(), "both threads run at once").toEqual([...threads].sort());
    f.finish(threads[0]!);
    await expect.poll(async () => (await browse(f, threads[1]!)).body.result.isError, { timeout: 20_000, interval: 100 }).toBeFalsy();
    await expect.poll(() => rows(f, threads[1]!), { timeout: 10_000, interval: 50 }).toContain("The browser is free. Continuing.");
    f.release();
    await expect.poll(async () => (await botRow(f, botId)).busy, { timeout: 20_000, interval: 100 }).toBe(false);
  }, 90_000);

  it("hand the browser over once its holder has stopped using it, and the holder does not act on a page it did not open", async () => {
    const { botId, threads } = await running({ OMB_BROWSER_IDLE_HANDOVER_MS: "200", OMB_COMPUTER_CALL_WAIT_MS: "5000" });
    expect((await browse(f, threads[0]!)).body.result.isError).toBeFalsy();
    expect((await browse(f, threads[1]!)).body.result.isError, "taken from a holder that went quiet, with both turns still running").toBeFalsy();
    expect((await busyThreads(f, botId)).sort()).toEqual([...threads].sort());
    expect((await browse(f, threads[0]!)).body.result.content[0].text).toBe(BROWSER_HANDED_OVER);
    expect((await browse(f, threads[0]!)).body.result.isError).toBeFalsy();
    f.release();
    await expect.poll(async () => (await botRow(f, botId)).busy, { timeout: 20_000, interval: 100 }).toBe(false);
  }, 90_000);
});

// One relay stands in for the Admin's Boat proxy; a picture stands in for the desktop.
const FRAME = Buffer.from("/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==", "base64");
describe.each(["desktop", "team"] as const)("two threads of a bot on the team's shared computer on a %s server", (role) => {
  let f: Fixture;
  const servers: Server[] = [];
  afterEach(async () => {
    await f?.stop();
    for (const server of servers.splice(0)) { server.closeAllConnections(); server.close(); }
  });

  it("both run from the start, and only the one that reaches for the screen second waits, saying so", async () => {
    const boxes: Array<{ id: string; state: string; name?: string }> = [];
    const relay = createServer((req, res) => {
      const path = new URL(req.url ?? "/", "http://relay.test").pathname.replace(/^\/relay\/api\/box\/v1/, "");
      let raw = "";
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => {
        const answer = (status: number, payload: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(payload)); };
        if (path === "/boxes" && req.method === "GET") return answer(200, { ok: true, boxes, pageInfo: { nextCursor: null } });
        if (path === "/boxes" && req.method === "POST") { const box = { id: "bx_23456789", state: "ready" }; boxes.push(box); return answer(201, { ok: true, box }); }
        const [, id = "", verb = ""] = /^\/boxes\/([^/]+)(?:\/(.+))?$/.exec(path) ?? [];
        const box = boxes.find((candidate) => candidate.id === id);
        if (!box) return answer(404, { ok: false, code: "not_found", message: "Not found" });
        if (!verb && req.method === "PATCH") { box.name = JSON.parse(raw).name; return answer(200, { ok: true, box }); }
        if (!verb && req.method === "GET") return answer(200, { ok: true, box });
        if (verb === "desktop") return answer(200, { desktopUrl: `https://desktop.invalid/${box.id}` });
        if (verb === "commands") return answer(200, { exitCode: 0, stdout: "captured", stderr: "" });
        if (verb === "artifacts") { res.writeHead(200, { "content-type": "image/jpeg", "content-length": String(FRAME.length) }); return res.end(FRAME); }
        return answer(404, { ok: false, code: "not_found", message: "Not found" });
      });
    });
    servers.push(relay);
    await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
    const relayBase = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`;
    f = new Fixture(role);
    f.extraEnv = { OMB_BOAT_API: `${relayBase}/own-key-must-not-be-used`, OMB_CLOUD_BOAT_URL: `${relayBase}/relay/api/box/v1`, OMB_CLOUD_BOAT_TOKEN: "box_omb_fixture", OMB_COMPUTER_CALL_WAIT_MS: "500" };
    await f.start();
    const requestId = randomUUID();
    const made = await f.api("POST", "/api/team-computers", { requestId, name: "Ops desktop", acknowledgeCost: true });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const { botId, threads } = await botWithThreads(f, CLAUDE, 2);
    expect((await f.api("PATCH", `/api/bots/${botId}`, { section: "Ops" })).status).toBe(200);
    const assigned = await f.api("PATCH", `/api/team-computers/${requestId}`, { section: "Ops", acknowledgeSharedAccess: true });
    expect(assigned.status, JSON.stringify(assigned.body)).toBe(200);

    await send(f, botId, threads[0]!, "First job");
    await send(f, botId, threads[1]!, "Second job");
    await expect.poll(() => f.claudeTurnsStarted(), { timeout: 20_000, interval: 50 }).toBe(2);
    expect((await busyThreads(f, botId)).sort(), "neither has touched the computer, so neither waited for it").toEqual([...threads].sort());
    expect((await rows(f, threads[1]!)).filter((name) => name.startsWith("Waiting for its turn"))).toEqual([]);

    const screenshot = (threadId: string) => {
      const env = f.servers(threadId).computer.env;
      return internal(f, "/api/internal/computer/mcp", env.OMB_MCP_TOKEN_COMPUTER, { method: "tools/call", params: { name: "screenshot", arguments: {} } });
    };
    let first = await screenshot(threads[0]!);
    for (let attempt = 0; attempt < 40 && first.body.result?.isError; attempt++) first = await screenshot(threads[0]!);
    expect(first.body.result.isError, JSON.stringify(first.body)).toBeFalsy();
    const second = await screenshot(threads[1]!);
    expect(second.body.result).toEqual({ isError: true, content: [{ type: "text", text: CONTROL_BUSY }] });
    expect((await rows(f, threads[1]!)).find((name) => name.startsWith("Waiting for its turn on this computer")), "the person sees why").toContain("Scout is running");
    expect((await busyThreads(f, botId)).sort()).toEqual([...threads].sort());

    f.finish(threads[0]!);
    await expect.poll(async () => (await screenshot(threads[1]!)).body.result.isError, { timeout: 30_000, interval: 200 }).toBeFalsy();
    f.release();
    await expect.poll(async () => (await botRow(f, botId)).busy, { timeout: 20_000, interval: 100 }).toBe(false);
  }, 120_000);
});

describe("a Starter Cloud", () => {
  let f: Fixture;
  const started = (threadId: string) => f.claudeDumps().some((file) => basename(f.dump(file).cwd) === threadId);
  const whenStarted = (threadId: string) => expect.poll(() => started(threadId), { timeout: 20_000, interval: 50 }).toBe(true);
  /** What the bot's own turn calls as start_thread, on the turn's own capability. */
  const startThread = async (fromThread: string, title: string, toBotId?: string) => {
    const agents = f.servers(fromThread).agents;
    const env = agents.env.OMB_GATE_UPSTREAM ? JSON.parse(agents.env.OMB_GATE_UPSTREAM).env : agents.env;
    return internal(f, "/api/internal/threads", env.OMB_COMMS_TOKEN, { title, message: `Work on ${title}`, ...(toBotId ? { toBotId } : {}) });
  };
  const ownThread = async (botId: string, title: string) => {
    await expect.poll(async () => (await botRow(f, botId)).tasks.find((task: any) => task.title === title)?.threadId, { timeout: 20_000, interval: 50 }).toBeTruthy();
    return (await botRow(f, botId)).tasks.find((task: any) => task.title === title).threadId as string;
  };
  /** What the Admin says, signed as it signs: which plan this Cloud is on. */
  const tellPlan = async (tier: string) => {
    const body = JSON.stringify({ v: 1, tier }), timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomBytes(16).toString("base64url");
    const response = await fetch(`${f.base}/api/cloud/plan`, { method: "POST", body, headers: { host: HOST, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https", "content-type": "application/json",
      "x-omb-cloud-timestamp": timestamp, "x-omb-cloud-nonce": nonce, "x-omb-cloud-signature": `v1=${cloudRequestSignature(f.secret, timestamp, nonce, "POST", "/api/cloud/plan", body)}` } });
    expect(response.status).toBe(200);
  };
  const starter = async () => {
    f = new Fixture("home");
    await f.start();
    await tellPlan("starter");
  };
  afterEach(async () => { f?.release(); await f?.stop(); });

  it("runs one thread per bot whatever is saved, queues the next in plain words, and starts it by itself when the slot frees", async () => {
    await starter();
    const saved = await f.api("PATCH", "/api/config", { threads: { maxConcurrentPerBot: 8 } });
    expect(saved.status).toBe(200);
    expect(saved.body.threads).toEqual({ maxConcurrentPerBot: 1 });
    expect(saved.body.cloudStarter).toBe(true);
    const { botId, threads } = await botWithThreads(f, CLAUDE, 3);
    await send(f, botId, threads[1]!, "First separate job");
    await whenStarted(threads[1]!);
    const queued = await f.api("POST", `/api/bots/${botId}/messages`, { threadId: threads[2], text: "Second separate job" });
    expect(queued.body).toMatchObject({ queued: true, reason: "capacity" });
    expect(started(threads[2]!)).toBe(false);
    // Per bot, not per machine: another bot's own thread runs beside it.
    const other = await botWithThreads(f, CLAUDE, 1, "Other");
    await send(f, other.botId, other.threads[0]!, "Another bot's job");
    await whenStarted(other.threads[0]!);
    f.finish(threads[1]!);
    await whenStarted(threads[2]!);
  }, 90_000);

  it("always starts the main chat the person last asked in, beside a routine, and the thread behind them starts once both are done", async () => {
    await starter();
    const { botId, threads: [main, other] } = await botWithThreads(f, CLAUDE, 2);
    await send(f, botId, main!, "The chat the person is in");
    await whenStarted(main!);
    f.finish(main!);
    await expect.poll(() => busyThreads(f, botId), { timeout: 20_000, interval: 100 }).toEqual([]);
    const created = await f.api("POST", "/api/routines", { name: "Slot holder", prompt: "Write the digest.", target: "bot", botId, runOn: "maus", enabled: true, schedule: { type: "daily", time: "23:00" } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const run = (await f.api("POST", `/api/routines/${created.body.routine.id}/run`)).body.run;
    await expect.poll(async () => (await f.api("GET", "/api/routines")).body.runs.find((candidate: any) => candidate.id === run.id)?.status, { timeout: 20_000, interval: 100 }).toBe("running");
    const routineThread = (await f.api("GET", "/api/routines")).body.runs.find((candidate: any) => candidate.id === run.id).threadId as string;
    await whenStarted(routineThread);
    expect((await f.api("POST", `/api/bots/${botId}/messages`, { threadId: other, text: "Waits for the slot" })).body).toMatchObject({ queued: true, reason: "capacity" });
    await send(f, botId, main!, "Never queued");
    f.release();
    await whenStarted(other!);
  }, 90_000);

  it("lets a running turn's own thread through, so a turn waiting on its child never hangs behind itself", async () => {
    await starter();
    const { botId, threads: [main] } = await botWithThreads(f, CLAUDE, 1);
    await send(f, botId, main!, "Parent job");
    await whenStarted(main!);
    const opened = await startThread(main!, "Own child");
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    expect(opened.body.state).toBe("running");
    await whenStarted(opened.body.threadId);
    expect((await busyThreads(f, botId)).sort(), "parent and child run at once").toEqual([main, opened.body.threadId].sort());
    // A job the bot opened on itself opens no more (self-threads.e2e): only the person's own request does.
    const grandchild = await startThread(opened.body.threadId, "Own grandchild");
    expect(grandchild.status, JSON.stringify(grandchild.body)).toBe(409);
  }, 90_000);

  it("lets a hand-off through to a busy bot, and one to a bot whose own turn is still running", async () => {
    await starter();
    const a = await botWithThreads(f, CLAUDE, 1, "Ada");
    const b = await botWithThreads(f, CLAUDE, 1, "Ben");
    const c = await botWithThreads(f, CLAUDE, 1, "Cyd");
    await send(f, a.botId, a.threads[0]!, "Ada's job");
    await whenStarted(a.threads[0]!);
    await send(f, b.botId, b.threads[0]!, "Ben's own job");
    await whenStarted(b.threads[0]!);
    await send(f, c.botId, c.threads[0]!, "Cyd's own job");
    await whenStarted(c.threads[0]!);
    const toBen = await startThread(a.threads[0]!, "For Ben", b.botId);
    expect(toBen.status, JSON.stringify(toBen.body)).toBeLessThan(300);
    await whenStarted(await ownThread(b.botId, "For Ben"));
    // From a third bot: Ben asking Ada back while Ada waits on Ben would be refused as a loop (crossed-handoffs.e2e).
    const toAda = await startThread(c.threads[0]!, "For Ada", a.botId);
    expect(toAda.status, JSON.stringify(toAda.body)).toBeLessThan(300);
    await whenStarted(await ownThread(a.botId, "For Ada"));
    expect(await busyThreads(f, a.botId), "Ada's first turn never had to end for it").toContain(a.threads[0]);
  }, 90_000);

  it("keeps a teammate's hand-off out of the person's slot, and the person's own threads still run one at a time", async () => {
    await starter();
    const a = await botWithThreads(f, CLAUDE, 1, "Ada");
    const b = await botWithThreads(f, CLAUDE, 3, "Ben");
    await send(f, a.botId, a.threads[0]!, "Ada's job");
    await whenStarted(a.threads[0]!);
    const toBen = await startThread(a.threads[0]!, "For Ben", b.botId);
    expect(toBen.status, JSON.stringify(toBen.body)).toBeLessThan(300);
    await whenStarted(await ownThread(b.botId, "For Ben"));
    const own = await f.api("POST", `/api/bots/${b.botId}/messages`, { threadId: b.threads[1], text: "The person's own job" });
    expect(own.body.queued, JSON.stringify(own.body)).toBeUndefined();
    await whenStarted(b.threads[1]!);
    expect((await f.api("POST", `/api/bots/${b.botId}/messages`, { threadId: b.threads[2], text: "Their next job" })).body).toMatchObject({ queued: true, reason: "capacity" });
  }, 90_000);

  it("brings a teammate's result back into the thread that asked, while another thread of that bot holds the slot", async () => {
    await starter();
    const a = await botWithThreads(f, CLAUDE, 2, "Ada");
    const b = await botWithThreads(f, CLAUDE, 1, "Ben");
    const [job, busy] = a.threads;
    await send(f, a.botId, job!, "Ask Ben");
    await whenStarted(job!);
    const toBen = await startThread(job!, "For Ben", b.botId);
    expect(toBen.status, JSON.stringify(toBen.body)).toBeLessThan(300);
    const benThread = await ownThread(b.botId, "For Ben");
    await whenStarted(benThread);
    f.finish(job!);
    await expect.poll(() => busyThreads(f, a.botId), { timeout: 20_000, interval: 100 }).toEqual([]);
    await send(f, a.botId, busy!, "Holds the slot");
    await whenStarted(busy!);
    f.finish(benThread);
    const replies = async () => ((await f.api("GET", `/api/threads/${job}/messages?limit=30`)).body.messages as any[]).filter((line) => line.role === "bot" && line.kind === "text").length;
    await expect.poll(replies, { timeout: 30_000, interval: 200 }).toBeGreaterThanOrEqual(2);
    expect(await busyThreads(f, a.botId), "the other thread never had to end for it").toContain(busy);
  }, 90_000);

  it("holds a routine behind the running thread, starts it by itself when the slot frees, and refuses a guarded send at the cap", async () => {
    await starter();
    const { botId, threads } = await botWithThreads(f, CLAUDE, 2);
    await send(f, botId, threads[1]!, "Busy thread");
    await whenStarted(threads[1]!);
    const refused = await f.api("POST", `/api/bots/${botId}/messages/guarded`, { threadId: threads[0], sendId: randomUUID(), text: "From a script", expectedActiveLeafId: null, expectedApprovalMode: "ask" });
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    const created = await f.api("POST", "/api/routines", { name: "Digest", prompt: "Write the digest.", target: "bot", botId, runOn: "maus", enabled: true, schedule: { type: "daily", time: "23:00" } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const run = (await f.api("POST", `/api/routines/${created.body.routine.id}/run`)).body.run;
    const state = async () => (await f.api("GET", "/api/routines")).body.runs.find((candidate: any) => candidate.id === run.id);
    expect((await state())?.status).toBe("queued");
    f.finish(threads[1]!);
    await expect.poll(async () => (await state())?.status, { timeout: 30_000, interval: 200 }).toBe("running");
  }, 90_000);

  it.each([[undefined, "an older Admin says nothing"], ["personal", "Personal is not Starter"], ["pro", "a bigger plan"]])("has no such limit on %s: %s", async (tier, _why) => {
    f = new Fixture("home");
    await f.start();
    if (tier) await tellPlan(tier);
    const { botId, threads } = await botWithThreads(f, CLAUDE, 2);
    await send(f, botId, threads[0]!, "One");
    await send(f, botId, threads[1]!, "Two");
    await expect.poll(() => f.claudeTurnsStarted(), { timeout: 20_000, interval: 50 }).toBe(2);
    expect((await f.api("GET", "/api/config")).body.cloudStarter).toBe(false);
  }, 90_000);

  it("runs more as soon as the Admin says the plan is bigger", async () => {
    await starter();
    const { botId, threads } = await botWithThreads(f, CLAUDE, 3);
    await send(f, botId, threads[0]!, "One");
    await whenStarted(threads[0]!);
    expect((await f.api("POST", `/api/bots/${botId}/messages`, { threadId: threads[1], text: "Two" })).body).toMatchObject({ queued: true, reason: "capacity" });
    await tellPlan("pro");
    await send(f, botId, threads[2]!, "Three");
    await whenStarted(threads[2]!);
    f.finish(threads[0]!);
    await whenStarted(threads[1]!);
  }, 90_000);
});
