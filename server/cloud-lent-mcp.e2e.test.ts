// A real server booted as a Cloud home, the real outbound connector on the Mac side, and two MCP servers on the Mac: one
// a program, one at a loopback address. Each runs only where the Mac lends it and its person allows it, and a bot's turn
// on My Cloud reaches it as any other MCP server.
import { randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createComputerSharing } from "../electron/computer-sharing.mjs";
import { createMcpDoor } from "../electron/device-mcp.mjs";
import { cloudPairingSignature } from "./cloud-home.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { hostTimeout } from "./testing/host-timeout.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const HOST = "omb-t-0123456789ab.fly.dev";
const MAC_INSTALL = randomUUID();
const secret = randomBytes(32).toString("base64url");
let home = "";
let base = "";
let port = 0;
let child: ChildProcess;
let log = "";
let owner = "";
let connector: ReturnType<typeof createComputerSharing> | undefined;
let macServer: Server | undefined;
const macRequests: Array<{ authorization?: string; method?: string }> = [];
const engines: ChildProcess[] = [];

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

type Spec = { url?: string; headers?: Record<string, string>; command?: string; args?: string[]; env?: Record<string, string> };
type Turn = { systemPrompt?: string; mcpConfig: { mcpServers: Record<string, Spec & { env?: Record<string, string> }> } };
const turnDumps = () => join(home, "turns");
const readTurns = () => new Map(readdirSync(turnDumps()).filter((name) => name.endsWith(".json")).flatMap((name) => {
  try { return [[name, readFileSync(join(turnDumps(), name), "utf8")] as const]; } catch { return []; }
}));

/** The turn a message to a new bot starts, as its engine was given it. */
async function turnOf(name: string): Promise<Turn> {
  const bot = (await api("POST", "/api/bots", { token: owner, body: { name, modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } } })).body.bot;
  const before = readTurns();
  expect((await api("POST", `/api/bots/${bot.id}/messages`, { token: owner, body: { text: "Search my notes on my Mac." } })).status).toBe(202);
  let turn: Turn | undefined;
  await expect.poll(() => {
    for (const [file, text] of readTurns()) {
      if (before.get(file) === text) continue;
      try { const found = JSON.parse(text) as Turn; if (found.mcpConfig?.mcpServers?.agents?.env?.OMB_BOT_ID === bot.id) { turn = found; return true; } } catch {}
    }
    return false;
  }, { timeout: 15_000 }).toBe(true);
  return turn!;
}

/** Talks to one MCP server of a turn as its engine would: over HTTP at its address, or through the stdio gate it runs. */
function engineFor(spec: Spec): (method: string, params?: unknown) => Promise<any> {
  if (spec.url) {
    let id = 0;
    let session: string | null = null;
    return async (method, params = {}) => {
      const response = await fetch(spec.url!, { method: "POST", headers: { ...spec.headers, "content-type": "application/json", accept: "application/json, text/event-stream", ...(session ? { "mcp-session-id": session } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
      session = response.headers.get("mcp-session-id") ?? session;
      return (await response.json()) as any;
    };
  }
  const engine = spawn(spec.command!, spec.args ?? [], { env: { PATH: process.env.PATH, HOME: home, ...spec.env }, stdio: ["pipe", "pipe", "pipe"] });
  engines.push(engine);
  const replies = new Map<number, (value: any) => void>();
  createInterface({ input: engine.stdout! }).on("line", (line) => { try { const message = JSON.parse(line); replies.get(message.id)?.(message); replies.delete(message.id); } catch {} });
  let id = 0;
  return (method, params = {}) => new Promise((resolve) => {
    const next = ++id; replies.set(next, resolve);
    engine.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id: next, method, params })}\n`);
  });
}

async function connected(call: ReturnType<typeof engineFor>) {
  expect((await call("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "engine", version: "1" } })).result).toBeTruthy();
  return call;
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "omb-cloud-lent-mcp-"));
  const dataDir = join(home, ".openmausbot");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(turnDumps());
  const cli = join(home, "fixture-claude.mjs");
  writeFileSync(cli, `#!/usr/bin/env node
if (process.argv[2] === "auth") { console.log(JSON.stringify({ loggedIn: true, email: "person@example.test" })); process.exit(0); }
process.env.FAKE_CLAUDE_VERSION = "2.1.284";
if (process.argv[2] !== "--version") { process.env.FAKE_CLAUDE_DUMP = ${JSON.stringify(join(home, "turns"))} + "/" + process.pid + ".json"; process.env.FAKE_CLAUDE_TEXT_DUMP = ${JSON.stringify(join(home, "one-shot.json"))}; process.env.FAKE_CLAUDE_MODE = "hang"; }
await import(${JSON.stringify(pathToFileURL(join(SERVER_DIR, "testing", "fake-claude-cli.ts")).href)});
`, { mode: 0o755 });
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ instances: {
    ...Object.fromEntries(["codex", "cursor", "githubCopilot", "openaiCompat", "qwen", "hermes", "pi", "grok"].map((id) => [id, { driver: "not-a-real-driver" }])),
    claude: { driver: "claudeAgent", displayName: "Claude", config: { cli } },
  } }));
  port = await freePortBlock([0, 1]);
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
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
    if (Date.now() > deadline) throw new Error(`the Cloud home did not start:\n${log}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  owner = await adminPairing();
}, hostTimeout(30_000));

afterAll(async () => {
  connector?.close();
  for (const engine of engines) engine.kill();
  await new Promise((resolve) => (macServer ? macServer.close(resolve) : resolve(null)));
  if (child) await waitForExit(child, { signal: "SIGTERM" });
  if (home) await removeTempDir(home);
});

it("a bot on My Cloud uses MCP servers on the person's lent Mac, only as the Mac lends them, and is told plainly when it can't", async () => {
  // On the Mac: an MCP server at a loopback address, and one that is a program.
  macServer = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    const message = JSON.parse(body);
    macRequests.push({ authorization: req.headers.authorization, method: message.method });
    if (!("id" in message)) { res.writeHead(202).end(); return; }
    const result = message.method === "initialize" ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "mac-notes", version: "1" } }
      : message.method === "tools/list" ? { tools: [{ name: "search_notes", description: "Search the notes on this Mac", inputSchema: { type: "object", properties: { q: { type: "string" } } } }] }
      : { content: [{ type: "text", text: `On the Mac: ${message.params.arguments.q}` }] };
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  await new Promise<void>((resolve) => macServer!.listen(0, "127.0.0.1", resolve));
  const macUrl = `http://127.0.0.1:${(macServer.address() as { port: number }).port}/mcp`;
  const script = join(home, "mac-program.mjs");
  writeFileSync(script, `import readline from "node:readline";
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (!("id" in message)) return;
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "mac-program", version: "1" } } });
  if (message.method === "tools/list") return send({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "whoami", inputSchema: { type: "object" } }] } });
  send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: JSON.stringify({ parent: process.ppid, key: process.env.NOTES_TOKEN }) }] } });
});
`);

  // As the move left them on My Cloud: marked as running on the Mac.
  const runsOn = { environmentId: MAC_INSTALL, label: "Ada's Mac" };
  for (const [name, server] of Object.entries({ local: { type: "http", url: macUrl, headers: { Authorization: "Bearer mac-header-key" } }, notes: { command: process.execPath, args: [script], env: { NOTES_TOKEN: "mac-env-key" } } })) {
    expect((await api("POST", "/api/mcp/servers", { token: owner, body: { name, ...server, runsOn } })).status).toBe(201);
    expect((await api("PATCH", `/api/mcp/servers/${name}`, { token: owner, body: { enabled: true } })).status).toBe(200);
  }
  const notYet = await api("POST", "/api/mcp/servers/local/test", { token: owner });
  expect(notYet).toEqual({ status: 409, body: { error: "local runs on Ada's Mac, which isn't lent to My Cloud: it works once OpenMausBot is open on that computer and signed in to My Cloud." } });

  // The Mac lends itself to My Cloud through the real connector, its MCP servers off as lending starts.
  const env = { id: "my-cloud", name: "My Cloud", origin: base };
  const file = join(home, "desktop-profile", "computer-sharing.json");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ version: 1, records: { [env.id]: { sessionId: null, environmentId: null, id: randomUUID(), secret: randomBytes(32).toString("hex"), enabled: true,
    folders: [], terminal: false, computer: false, internet: true, cloud: { accountId: "acct_fixture", origin: base } } } }));
  const macUser = join(home, "mac-user");
  mkdirSync(macUser);
  // The person's answers on the Mac, given when the test says.
  const asks: Array<{ name: string; target: unknown }> = [];
  const answers: Array<(allow: boolean) => void> = [];
  connector = createComputerSharing({
    file, environments: () => [env], localEnvironments: () => [MAC_INSTALL], myCloud: () => env, ownClouds: () => [env], cuaConnection: async () => null, enabled: async () => false,
    cloud: () => ({ status: "connected", accountId: "acct_fixture", origin: base }), home: join(home, "mac-home"),
    fetch: (url: string, init: RequestInit) => fetch(url, { ...init, headers: { ...init.headers as Record<string, string>, authorization: `Bearer ${owner}`, host: HOST, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https", origin: `https://${HOST}` } }),
    linkHeaders: () => ({ authorization: `Bearer ${owner}`, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https" }),
    mcp: (_env, definition) => createMcpDoor({ approvals: connector!.mcpApprovals, ownPorts: async () => [], definition, home: macUser,
      prompt: (ask) => new Promise<boolean>((resolve) => { asks.push(ask); answers.push(resolve); }) }),
  });
  connector.start();
  await expect.poll(() => connector!.cloudState(env).connected, { timeout: 8000 }).toBe(true);
  const name = hostname().slice(0, 120);

  // The person turns on "Your MCP servers": Test, from Settings, asks on the Mac first, and lists the address server's
  // tools once the person allows it there.
  await connector.lendMcp(true);
  await expect.poll(async () => (await api("POST", "/api/mcp/servers/local/test", { token: owner })).body?.error ?? "", { timeout: 8000 }).toContain("a prompt is waiting there");
  const port = Number(new URL(macUrl).port);
  expect(asks).toEqual([{ name: "local", target: { kind: "url", port } }]);
  answers[0]!(true);
  await expect.poll(() => connector!.mcpApprovals.read().local).toEqual({ kind: "url", port });
  expect(await api("POST", "/api/mcp/servers/local/test", { token: owner })).toEqual({ status: 200, body: { ok: true, tools: [{ name: "search_notes", description: "Search the notes on this Mac" }] } });

  // A bot's turn: both servers are its MCP servers, at My Cloud's own address with no Mac key in it.
  const first = await turnOf("Notes bot");
  const local = first.mcpConfig.mcpServers.local!;
  expect(local).toBeDefined();
  expect(first.mcpConfig.mcpServers.notes).toBeDefined();
  expect(JSON.stringify(first.mcpConfig)).not.toMatch(/mac-header-key|mac-env-key|mac-program/);
  const call = await connected(engineFor(local));
  const listed = await call("tools/list");
  expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toEqual(["search_notes"]);
  const answer = await call("tools/call", { name: "search_notes", arguments: { q: "plan" } });
  expect(answer.result).toEqual({ content: [{ type: "text", text: "On the Mac: plan" }] });
  // It reached the Mac's server from the Mac's connector, with the key saved on My Cloud.
  expect(macRequests.every((request) => request.authorization === "Bearer mac-header-key")).toBe(true);
  expect(connector.activity(env.id).map((entry) => [entry.action, entry.detail, entry.ok])).toContainEqual(["mcp", "local", true]);

  // The program: Test asks on the Mac once, then, once the person allows it, it starts there, from the connector, never
  // on My Cloud, with the terminal still off.
  const program = await api("POST", "/api/mcp/servers/notes/test", { token: owner });
  expect(program).toMatchObject({ status: 200, body: { ok: false, reason: "unreachable" } });
  expect(program.body.error).toContain("Allow notes on");
  expect(program.body.error).toContain("a prompt is waiting there");
  expect(asks).toHaveLength(2);
  expect(asks[1]).toEqual({ name: "notes", target: { kind: "command", command: `${process.execPath} ${script}`, env: ["NOTES_TOKEN"] } });
  answers[1]!(true);
  await expect.poll(() => connector!.mcpApprovals.read().notes?.kind).toBe("command");
  expect(await api("POST", "/api/mcp/servers/notes/test", { token: owner })).toEqual({ status: 200, body: { ok: true, tools: [{ name: "whoami" }] } });
  const second = await turnOf("Program bot");
  const notes = second.mcpConfig.mcpServers.notes!;
  expect(notes).toBeDefined();
  const programCall = await connected(engineFor(notes));
  const who = JSON.parse((await programCall("tools/call", { name: "whoami", arguments: {} })).result.content[0].text);
  expect(who).toEqual({ parent: process.pid, key: "mac-env-key" });
  expect(who.parent).not.toBe(child.pid);

  // A server added on My Cloud at a loopback address nothing there answers is marked as running on this Mac; one on the
  // internet is not.
  const closed = await freePortBlock([0]);
  const added = await api("POST", "/api/mcp/servers", { token: owner, body: { name: "fresh", type: "http", url: `http://127.0.0.1:${closed}/mcp`, headers: {} } });
  expect(added.status).toBe(201);
  expect(added.body.servers.find((server: { name: string }) => server.name === "fresh")).toMatchObject({ runsOn: { environmentId: MAC_INSTALL, label: name } });
  const web = await api("POST", "/api/mcp/servers", { token: owner, body: { name: "web", type: "http", url: "https://mcp.example.com/mcp", headers: {} } });
  expect(web.body.servers.find((server: { name: string }) => server.name === "web")).not.toHaveProperty("runsOn");

  // The person pauses lending: Test and the bot's call both say so in plain words, and nothing reaches the Mac.
  connector.pause();
  await expect.poll(async () => (await api("POST", "/api/mcp/servers/local/test", { token: owner })).status, { timeout: 8000 }).toBe(409);
  const paused = await api("POST", "/api/mcp/servers/local/test", { token: owner });
  expect(paused.body.error).toMatch(/^local runs on .+, which no longer lends itself to My Cloud: OpenMausBot on it is paused or signed out\.$/);
  const before = macRequests.length;
  const refused = await call("tools/call", { name: "search_notes", arguments: { q: "plan" } });
  expect(refused.result.isError).toBe(true);
  expect(refused.result.content[0].text).toContain("no longer lends itself to My Cloud");
  expect(refused.result.content[0].text).not.toContain("Could not reach");
  expect(macRequests.length).toBe(before);
}, hostTimeout(90_000));

it("an older computer keeps the job path; a computer that sent mcp is never served by jobs", async () => {
  const edge = { host: HOST, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https", origin: `https://${HOST}` };
  const { environmentId } = await (await fetch(`${base}/.well-known/openmausbot/environment`, { headers: edge })).json() as { environmentId: string };
  const computer = { id: randomUUID(), secret: randomBytes(32).toString("hex"), runsOn: { environmentId: randomUUID(), label: "Ada's Old Mac" } };
  const post = (path: string, body: unknown, signal?: AbortSignal) => fetch(`${base}${path}`, {
    method: "POST", signal, body: JSON.stringify(body),
    headers: { ...edge, authorization: `Bearer ${owner}`, "content-type": "application/json", "x-omb-computer-secret": computer.secret },
  });
  const register = async (extra: { mcp?: boolean }) => {
    const response = await post("/api/shared-computers/connect", {
      id: computer.id, name: computer.runsOn.label, environmentId, folders: [], terminal: false, computer: false, platform: "darwin",
      mcpServers: true, environments: [computer.runsOn.environmentId], ...extra,
    });
    expect(response.status, await response.clone().text()).toBe(200);
  };
  /** The computer's poll: it answers each job it is handed with one tool, and records the job's action. */
  const poller = () => {
    const stop = new AbortController();
    const jobs: string[] = [];
    void (async () => {
      while (!stop.signal.aborted) {
        const { job } = await (await post(`/api/shared-computers/${computer.id}/poll`, {}, stop.signal)).json() as { job: { id: string; operation: { action: string } } | null };
        if (!job) continue;
        jobs.push(job.operation.action);
        await post(`/api/shared-computers/${computer.id}/result`, { jobId: job.id, result: { tools: [{ name: "search_notes", description: "Search the notes", inputSchema: { type: "object" } }] } });
      }
    })().catch(() => {});
    return { jobs, stop: () => stop.abort() };
  };

  const added = await api("POST", "/api/mcp/servers", { token: owner, body: { name: "older", type: "http", url: "http://127.0.0.1:19577/mcp", headers: {}, runsOn: computer.runsOn } });
  expect(added.status).toBe(201);
  expect((await api("PATCH", "/api/mcp/servers/older", { token: owner, body: { enabled: true } })).status).toBe(200);

  await register({});
  const jobPath = poller();
  expect(await api("POST", "/api/mcp/servers/older/test", { token: owner })).toEqual({ status: 200, body: { ok: true, tools: [{ name: "search_notes", description: "Search the notes" }] } });
  expect(jobPath.jobs).toEqual(["mcp_tools"]);
  jobPath.stop();

  await register({ mcp: false });
  const linkPath = poller();
  const off = await api("POST", "/api/mcp/servers/older/test", { token: owner });
  expect(off).toEqual({ status: 409, body: { error: `older runs on your Mac (Ada's Old Mac), which isn't lending its MCP servers to My Cloud: turn on "Let My Cloud use your MCP servers on this Mac" from the OpenMausBot icon on that Mac.` } });
  await new Promise((resolve) => setTimeout(resolve, 3000));
  expect(linkPath.jobs, "no mcp_tools job reaches a computer that sent mcp").toEqual([]);
  linkPath.stop();
}, hostTimeout(30_000));
