// A real server booted as a Cloud home, the real outbound connector on the Mac side, and two MCP servers on the Mac: one
// a program, one at a loopback address. Each runs only where the Mac lends it and its person allows it, and a bot's turn
// on My Cloud reaches it as any other MCP server.
import { randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createComputerSharing } from "../electron/computer-sharing.mjs";
import { lentMcpOptions } from "../electron/lent-mcp-wiring.mjs";
import { cloudPairingSignature } from "./cloud-home.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { hostTimeout } from "./testing/host-timeout.ts";
import { startFakeHttpMcp } from "./testing/fake-http-mcp-server.ts";
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
const cleanups: Array<() => Promise<unknown>> = [];
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

type Spec = { type?: string; url?: string; headers?: Record<string, string>; command?: string; args?: string[]; env?: Record<string, string> };
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
type Engine = ((method: string, params?: unknown) => Promise<any>) & { end?: () => Promise<Response> };
function engineFor(spec: Spec): Engine {
  if (spec.url) {
    let id = 0;
    let session: string | null = null;
    const call: Engine = async (method, params = {}) => {
      const response = await fetch(spec.url!, { method: "POST", headers: { ...spec.headers, "content-type": "application/json", accept: "application/json, text/event-stream", ...(session ? { "mcp-session-id": session } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
      session = response.headers.get("mcp-session-id") ?? session;
      return (await response.json()) as any;
    };
    call.end = () => fetch(spec.url!, { method: "DELETE", headers: { ...spec.headers, ...(session ? { "mcp-session-id": session } : {}) } });
    return call;
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
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  if (child) await waitForExit(child, { signal: "SIGTERM" });
  if (home) await removeTempDir(home);
});

it("a bot on My Cloud uses MCP servers on the person's lent Mac through its link, only as the person allows there", async () => {
  // On the Mac: an MCP server at a loopback address that can hold one call open, an old-SSE one, and a program.
  let arrived!: () => void;
  const slowArrived = new Promise<void>((resolve) => { arrived = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const mac = await startFakeHttpMcp({
    requireHeader: { name: "authorization", value: "Bearer mac-header-key" },
    tools: [{ name: "search_notes", description: "Search the notes on this Mac", inputSchema: { type: "object", properties: { q: { type: "string" } } } }],
    callResult: (params) => ({ content: [{ type: "text", text: `On the Mac: ${(params as { arguments: { q: string } }).arguments.q}` }] }),
    holdCall: async (params) => { if ((params as { arguments?: { slow?: boolean } }).arguments?.slow) { arrived(); await gate; } },
  });
  const sse = await startFakeHttpMcp({ transport: "sse", requireHeader: { name: "authorization", value: "Bearer mac-header-key" }, tools: [{ name: "read_old" }] });
  // A listener standing in for this app's own server: the door must never reach it.
  let ownHits = 0;
  const ownServer = createServer((_req, res) => { ownHits += 1; res.writeHead(200).end(); });
  await new Promise<void>((resolve) => ownServer.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => { await mac.close(); await sse.close(); await new Promise((resolve) => ownServer.close(resolve)); });
  const ownPort = (ownServer.address() as { port: number }).port;
  const macUrl = mac.url;
  const macPort = Number(new URL(macUrl).port);
  const script = join(home, "mac-program.mjs");
  writeFileSync(script, `import readline from "node:readline";
// The program reports whether it saw the env value, not the value: a tool answer crosses the link.
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (!("id" in message)) return;
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "mac-program", version: "1" } } });
  if (message.method === "tools/list") return send({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "whoami", inputSchema: { type: "object" } }] } });
  send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: JSON.stringify({ parent: process.ppid, pid: process.pid, sawKey: process.env.NOTES_TOKEN === "mac-env-key" }) }] } });
});
`);

  // As the move left them on My Cloud: marked as running on the Mac.
  const runsOn = { environmentId: MAC_INSTALL, label: "Ada's Mac" };
  const saved: Record<string, object> = {
    local: { type: "http", url: macUrl, headers: { Authorization: "Bearer mac-header-key" } },
    notes: { command: process.execPath, args: [script], env: { NOTES_TOKEN: "mac-env-key" } },
    ownport: { type: "http", url: `http://127.0.0.1:${ownPort}/mcp`, headers: {} },
    oldsse: { type: "sse", url: sse.url, headers: { Authorization: "Bearer mac-header-key" } },
  };
  for (const [name, server] of Object.entries(saved)) {
    expect((await api("POST", "/api/mcp/servers", { token: owner, body: { name, ...server, runsOn } })).status).toBe(201);
    expect((await api("PATCH", `/api/mcp/servers/${name}`, { token: owner, body: { enabled: true } })).status).toBe(200);
  }
  const notYet = await api("POST", "/api/mcp/servers/local/test", { token: owner });
  expect(notYet).toEqual({ status: 409, body: { error: "local runs on Ada's Mac, which isn't lent to My Cloud: it works once OpenMausBot is open on that computer and signed in to My Cloud." } });

  // The Mac lends itself to My Cloud through the real connector and the real wiring, its MCP servers off as lending starts.
  const env = { id: "my-cloud", name: "My Cloud", origin: base };
  const file = join(home, "desktop-profile", "computer-sharing.json");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ version: 1, records: { [env.id]: { sessionId: null, environmentId: null, id: randomUUID(), secret: randomBytes(32).toString("hex"), enabled: true,
    folders: [], terminal: false, computer: false, internet: true, cloud: { accountId: "acct_fixture", origin: base } } } }));
  const macUser = join(home, "mac-user");
  mkdirSync(macUser);
  // The person's answer on the Mac, given when the test says; `skew` moves the door's clock.
  const asks: Array<{ name: string; target: unknown }> = [];
  let allow = false;
  let skew = 0;
  const declineMs = 60_000;
  const frames = { text: [] as string[], all: [] as string[] };
  const seen = (data: unknown) => {
    if (typeof data === "string") { frames.text.push(data); frames.all.push(data); return; }
    const bytes = ArrayBuffer.isView(data) ? Buffer.from(data.buffer, data.byteOffset, data.byteLength) : Buffer.from(data as ArrayBuffer);
    frames.all.push(bytes.toString("latin1"));
  };
  class Tapped extends WebSocket {
    constructor(...args: ConstructorParameters<typeof WebSocket>) {
      super(...args);
      this.addEventListener("message", ({ data }) => seen(data));
    }
    override send(data: Parameters<WebSocket["send"]>[0]): void { seen(data); super.send(data); }
  }
  connector = createComputerSharing({
    file, environments: () => [env], localEnvironments: () => [MAC_INSTALL], myCloud: () => env, ownClouds: () => [env], cuaConnection: async () => null, enabled: async () => false,
    cloud: () => ({ status: "connected", accountId: "acct_fixture", origin: base }), home: join(home, "mac-home"), WebSocket: Tapped,
    fetch: (url: string, init: RequestInit) => fetch(url, { ...init, headers: { ...init.headers as Record<string, string>, authorization: `Bearer ${owner}`, host: HOST, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https", origin: `https://${HOST}` } }),
    linkHeaders: () => ({ authorization: `Bearer ${owner}`, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https" }),
    ...lentMcpOptions({
      sharing: () => connector!, serverPorts: () => [ownPort], declineMs, now: () => Date.now() + skew, home: macUser,
      prompt: async (ask: { name: string; target: unknown }) => { asks.push(ask); return allow; },
    }),
  });
  connector.start();
  await expect.poll(() => connector!.cloudState(env).connected, { timeout: 8000 }).toBe(true);
  const name = hostname().slice(0, 120);

  // The switch is off: Test says so, the bot's prompt names the server, and no stream or request reaches the Mac.
  const lendingOff = /isn't lending its MCP servers to My Cloud: turn on "Let My Cloud use your MCP servers on this Mac"/;
  const off = await api("POST", "/api/mcp/servers/local/test", { token: owner });
  expect(off.status).toBe(409);
  expect(off.body.error).toMatch(lendingOff);
  const idle = await turnOf("Off bot");
  expect(idle.systemPrompt).toMatch(/local runs on[^\n]*isn't lending its MCP servers to My Cloud/);
  expect(idle.mcpConfig.mcpServers.local).toBeUndefined();
  expect(frames.all.join("\n")).not.toContain(`"local"`);
  expect(mac.seenHeaders).toEqual([]);

  // The person turns on "Your MCP servers". The port of this app's own server is refused before any prompt or request.
  await connector.lendMcp(true);
  await expect.poll(async () => (await api("POST", "/api/mcp/servers/ownport/test", { token: owner })).body?.error ?? "", { timeout: 8000 }).toContain("didn't answer");
  const first = await turnOf("Notes bot");
  const bearers = new Set<string>();
  const specOf = (turn: Turn, server: string) => {
    const spec = turn.mcpConfig.mcpServers[server]!;
    expect(spec, server).toBeDefined();
    bearers.add(spec.headers!.authorization!.replace(/^Bearer /, ""));
    return spec;
  };
  const initialized = async (spec: Spec) => (await engineFor(spec)("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "engine", version: "1" } })).result;
  expect((await initialized(specOf(first, "ownport"))).instructions).toMatch(/^ownport on .* didn't answer\. Check that it is running there\.$/);
  expect(ownHits, "nothing reached this app's own port").toBe(0);
  expect(asks, "no prompt for a port the door refuses").toEqual([]);

  // The person says no: the first call answers needs-approval (the prompt was shown once); the next, inside the hold,
  // says the person didn't allow it, with no second prompt.
  const local = specOf(first, "local");
  expect((await initialized(local)).instructions).toMatch(/^Allow local on .*: a prompt is waiting there\. Then try again\.$/);
  expect(asks).toEqual([{ name: "local", target: { kind: "url", port: macPort } }]);
  expect((await initialized(local)).instructions).toMatch(/^On .*, the person didn't allow local\. Ask them before trying again\.$/);
  expect(asks).toHaveLength(1);
  expect(mac.seenHeaders, "a refused server was never reached").toEqual([]);

  // After the hold, the person allows it: the prompt is shown once more, and then the bot's calls work.
  allow = true;
  skew += declineMs + 1;
  expect((await initialized(local)).instructions).toMatch(/a prompt is waiting there/);
  expect(asks).toHaveLength(2);
  await expect.poll(() => connector!.mcpApprovals.read().local).toEqual({ kind: "url", port: macPort });
  const call = await connected(engineFor(local));
  const listed = await call("tools/list");
  expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toEqual(["search_notes"]);
  const answer = await call("tools/call", { name: "search_notes", arguments: { q: "plan" } });
  expect(answer.result).toEqual({ content: [{ type: "text", text: "On the Mac: plan" }] });
  // It reached the Mac's server from the Mac's connector, with the key saved on My Cloud, a closed connection and the Mac's own host.
  expect(mac.seenHeaders.length).toBeGreaterThan(0);
  for (const headers of mac.seenHeaders) {
    expect(headers.authorization).toBe("Bearer mac-header-key");
    expect(headers.connection).toBe("close");
    expect(headers.host).toBe(`127.0.0.1:${macPort}`);
  }
  expect(connector.activity(env.id).map((entry) => [entry.action, entry.detail, entry.ok])).toContainEqual(["mcp", "local", true]);
  expect(await api("POST", "/api/mcp/servers/local/test", { token: owner })).toEqual({ status: 200, body: { ok: true, tools: [{ name: "search_notes", description: "Search the notes on this Mac" }] } });

  // Two calls side by side: the slow one is held on the Mac, the fast one answers meanwhile.
  let slowDone = false;
  const slow = call("tools/call", { name: "search_notes", arguments: { q: "slow", slow: true } }).then((result) => { slowDone = true; return result; });
  await slowArrived;
  const fast = await call("tools/call", { name: "search_notes", arguments: { q: "fast" } });
  expect(fast.result.content[0].text).toBe("On the Mac: fast");
  expect(slowDone, "the fast call answered while the slow one was still held").toBe(false);
  release();
  expect((await slow).result.content[0].text).toBe("On the Mac: slow");

  // The program: the prompt names its command and env names; once the person allows it, it starts there, from the
  // connector (a child of this process), never on My Cloud, with the terminal still off.
  const program = await api("POST", "/api/mcp/servers/notes/test", { token: owner });
  expect(program).toMatchObject({ status: 200, body: { ok: false, reason: "unreachable" } });
  expect(program.body.error).toContain("Allow notes on");
  expect(program.body.error).toContain("a prompt is waiting there");
  expect(asks).toHaveLength(3);
  expect(asks[2]).toEqual({ name: "notes", target: { kind: "command", command: `${process.execPath} ${script}`, env: ["NOTES_TOKEN"] } });
  await expect.poll(() => connector!.mcpApprovals.read().notes?.kind).toBe("command");
  expect(await api("POST", "/api/mcp/servers/notes/test", { token: owner })).toEqual({ status: 200, body: { ok: true, tools: [{ name: "whoami" }] } });
  const second = await turnOf("Program bot");
  const notes = specOf(second, "notes");
  const programCall = await connected(engineFor(notes));
  const who = JSON.parse((await programCall("tools/call", { name: "whoami", arguments: {} })).result.content[0].text);
  expect(who).toEqual({ parent: process.pid, pid: expect.any(Number), sawKey: true });
  expect(who.parent).not.toBe(child.pid);
  const alive = () => { try { process.kill(who.pid, 0); return true; } catch { return false; } };
  expect(alive()).toBe(true);
  expect((await programCall.end!()).status).toBe(200);
  await expect.poll(alive, { timeout: 8000 }).toBe(false);

  // The old SSE transport: Test allows it on the Mac, then it lists its tools through the door.
  await expect.poll(async () => (await api("POST", "/api/mcp/servers/oldsse/test", { token: owner })).body?.ok, { timeout: 8000 }).toBe(true);
  const old = specOf(await turnOf("Old bot"), "oldsse");
  expect(old.type).toBe("sse");
  const stream = await fetch(old.url!, { headers: { ...old.headers, accept: "text/event-stream" } });
  expect(stream.status).toBe(200);
  const reader = stream.body!.getReader();
  let events = "";
  const until = async (text: string) => {
    while (!events.includes(text)) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`the stream ended before ${text}: ${events}`);
      events += new TextDecoder().decode(value, { stream: true });
    }
  };
  try {
    await until("data: /");
    const endpoint = /event: endpoint\ndata: (\S+)\n/.exec(events)![1]!;
    const posted = await fetch(new URL(endpoint, old.url!), { method: "POST", headers: { ...old.headers, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list", params: {} }) });
    expect(posted.status).toBe(202);
    await until(`"id":7`);
    expect(events).toContain(`"tools":[{"name":"read_old"}]`);
  } finally { await reader.cancel().catch(() => {}); }

  // A server added on My Cloud at a loopback address nothing there answers is marked as running on this Mac; one on the
  // internet is not.
  const closed = await freePortBlock([0]);
  const added = await api("POST", "/api/mcp/servers", { token: owner, body: { name: "fresh", type: "http", url: `http://127.0.0.1:${closed}/mcp`, headers: {} } });
  expect(added.status).toBe(201);
  expect(added.body.servers.find((server: { name: string }) => server.name === "fresh")).toMatchObject({ runsOn: { environmentId: MAC_INSTALL, label: name } });
  const web = await api("POST", "/api/mcp/servers", { token: owner, body: { name: "web", type: "http", url: "https://mcp.example.com/mcp", headers: {} } });
  expect(web.body.servers.find((server: { name: string }) => server.name === "web")).not.toHaveProperty("runsOn");

  // Nothing secret crossed the link: the env value is on no frame, the header value on no control frame (it rides inside
  // the replayed request bytes), the turn's bearer on none; and the env value is in no log, turn dump or activity row.
  const crossed = frames.all.join("\n");
  expect(crossed, "the capture saw the opens").toContain(`"notes"`);
  expect(crossed, "env value on a frame").not.toContain("mac-env-key");
  expect(frames.text.join("\n"), "header value on a control frame").not.toContain("mac-header-key");
  for (const bearer of bearers) expect(crossed, "turn bearer on a frame").not.toContain(bearer);
  expect(bearers.size).toBeGreaterThan(0);
  const dumps = [...readTurns().values()].join("\n");
  expect([dumps, log, JSON.stringify(connector.activity(env.id))].join("\n")).not.toContain("mac-env-key");
  expect(dumps).not.toContain("mac-header-key");

  // The person pauses lending: Test and the bot's call both say so in plain words, and nothing reaches the Mac.
  connector.pause();
  await expect.poll(async () => (await api("POST", "/api/mcp/servers/local/test", { token: owner })).status, { timeout: 8000 }).toBe(409);
  const paused = await api("POST", "/api/mcp/servers/local/test", { token: owner });
  expect(paused.body.error).toMatch(/^local runs on .+, which no longer lends itself to My Cloud: OpenMausBot on it is paused or signed out\.$/);
  const before = mac.seenHeaders.length;
  const refused = await call("tools/call", { name: "search_notes", arguments: { q: "plan" } });
  expect(refused.result.isError).toBe(true);
  expect(refused.result.content[0].text).toContain("no longer lends itself to My Cloud");
  expect(refused.result.content[0].text).not.toContain("Could not reach");
  expect(mac.seenHeaders.length).toBe(before);
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
