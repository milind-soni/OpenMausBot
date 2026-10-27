// Use my Mac on a real server booted as a Cloud home, with the real desktop connector lending this test process as the
// Mac. The sites that turn away data centres go out through the Mac's device link, and the Mac checks every connection
// itself; every other site goes My Cloud's own way. "The internet" here is a web server on this machine that only the
// Mac's own connect reaches, under a public address. My Cloud itself is offline: it resolves no name and fetches nothing.
import { randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { connect as tcpConnect, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { installCloudLending, usualFolders } from "../electron/cloud-lending-ipc.mjs";
import { createCloudPowerGate } from "../electron/cloud-power.mjs";
import { createComputerSharing, validateSharedFolders } from "../electron/computer-sharing.mjs";
import { gateChromeFlags } from "./browser/egress/gate.ts";
import { cloudPairingSignature } from "./cloud-home.ts";
import { findChrome, launchPipeChrome } from "./testing/chrome-pipe.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { hostTimeout } from "./testing/host-timeout.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const HOST = "omb-t-0123456789ab.fly.dev";
/** The Mac's public address as My Cloud sees it, through the edge. */
const MAC_PUBLIC = "203.0.113.9";
const edge = { host: HOST, "x-forwarded-for": MAC_PUBLIC, "x-forwarded-proto": "https", origin: `https://${HOST}` };
const secret = randomBytes(32).toString("base64url");
const chrome = findChrome();
let home = "";
let base = "";
let port = 0;
let child: ChildProcess;
let log = "";
let owner = "";
let website: Server;
let websitePort = 0;
/** Each request the website served: the peer it saw and the name asked for. */
const visits: Array<{ peer: number; host: string }> = [];
/** Local ports of the sockets the Mac opened to the internet. */
const macSockets = new Set<number>();
const proxies: ChildProcess[] = [];

/** The public internet, as the Mac sees it: names resolve here only, and only port 80 or 443 of a public address reaches
 * the website. The hostile names are the sites that go through the Mac, resolving (as a hostile network or DNS rebinding
 * would have them) to the Mac's home network, the Mac itself and the rest. */
const PUBLIC = "93.184.215.14";
const names: Record<string, string> = {
  "www.instagram.com": PUBLIC, "slow.youtube.com": PUBLIC, "www.google.zz": PUBLIC, "en.wikipedia.org": PUBLIC,
  "router.google.com": "192.168.1.1", "mac.google.com": "127.0.0.1", "metadata.googlevideo.com": "169.254.169.254",
  "nat64.instagram.com": "64:ff9b::c0a8:101", "own.youtube.com": "192.168.1.20", "neighbour.google.com": "2a02:1200:5:6::99",
  "home.instagram.com": MAC_PUBLIC,
};
/** Every name the Mac was asked to look up. */
const macLookups: string[] = [];
const macEgress = () => ({
  interfaces: () => ({ en0: [
    { address: "192.168.1.20", cidr: "192.168.1.20/24", family: "IPv4", internal: false, netmask: "255.255.255.0", mac: "00:00:00:00:00:00" },
    { address: "2a02:1200:5:6::20", cidr: "2a02:1200:5:6::20/64", family: "IPv6", internal: false, netmask: "ffff:ffff:ffff:ffff::", mac: "00:00:00:00:00:00", scopeid: 0 },
  ] }) as never,
  resolve: async (host: string) => { macLookups.push(host); return names[host] ? [{ address: names[host]!, family: names[host]!.includes(":") ? 6 : 4 }] : []; },
  connect: (options: { host: string; port: number; lookup: (host: string, options: { all: boolean }, callback: (error: Error | null, addresses: Array<{ address: string }>) => void) => void }) => {
    let address = "";
    options.lookup(options.host, { all: true }, (_error, addresses) => { address = addresses[0]?.address ?? ""; });
    const socket = tcpConnect(address === PUBLIC && (options.port === 80 || options.port === 443) ? websitePort : 1, "127.0.0.1");
    socket.once("connect", () => macSockets.add(socket.localPort!));
    return socket;
  },
});

async function api(method: string, path: string, options: { body?: unknown; token?: string } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...edge, ...(options.token ? { authorization: `Bearer ${options.token}` } : {}), ...(options.body === undefined ? {} : { "content-type": "application/json" }) },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { status: response.status, body: await response.json().catch(() => null) as any };
}

async function adminPairing(): Promise<string> {
  const body = JSON.stringify({ label: "OpenMausBot app (Cloud)", ttlSeconds: 300 });
  const timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomBytes(16).toString("base64url");
  const response = await fetch(`${base}/api/cloud/pairing`, { method: "POST", headers: {
    ...edge, "content-type": "application/json",
    "x-omb-cloud-timestamp": timestamp, "x-omb-cloud-nonce": nonce, "x-omb-cloud-signature": `v1=${cloudPairingSignature(secret, timestamp, nonce, body)}`,
  }, body });
  const granted = await response.json() as { code: string };
  const paired = await api("POST", "/api/auth/pair", { body: { code: granted.code } });
  expect(paired.status, JSON.stringify(paired.body)).toBe(200);
  return paired.body.token;
}

const turnDumps = () => join(home, "turns");
type Turn = { mcpConfig: { mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> } };
/** The newest turn of `botId` whose engine was started after `before`. */
async function turnOf(botId: string, before: Set<string>): Promise<Turn> {
  let found: Turn | undefined;
  await expect.poll(() => {
    for (const name of readdirSync(turnDumps())) {
      if (before.has(name) || !name.endsWith(".json")) continue;
      try {
        const turn = JSON.parse(readFileSync(join(turnDumps(), name), "utf8")) as Turn;
        if (turn.mcpConfig?.mcpServers?.agents?.env?.OMB_BOT_ID === botId) { found = turn; return true; }
      } catch {}
    }
    return false;
  }, { timeout: 15_000 }).toBe(true);
  return found!;
}

/** The egress gate of a bot's own browser on My Cloud, as the server hands it to the browser engine. */
async function gateOf(botId: string): Promise<number> {
  // Asked while its Chrome counts as running, the engine is handed that Chrome's settings, the gate among them.
  writeFileSync(join(home, "browser-running"), "");
  await api("GET", `/api/browser-sites?bot=${botId}`, { token: owner }).finally(() => rmSync(join(home, "browser-running"), { force: true }));
  let gatePort = 0;
  await expect.poll(() => {
    const lines = (() => { try { return readFileSync(join(home, "gates.txt"), "utf8").trim().split("\n"); } catch { return []; } })();
    const found = lines.map((line) => /^bot-\S+ socks5:\/\/127\.0\.0\.1:(\d+)$/.exec(line)).filter(Boolean).at(-1);
    gatePort = Number(found?.[1] ?? 0);
    return gatePort > 0;
  }, { timeout: 10_000 }).toBe(true);
  return gatePort;
}

/** A bot's turn: its agents proxy (for shared_computer) and its own browser's egress gate. */
async function botTurn(name: string) {
  const bot = (await api("POST", "/api/bots", { token: owner, body: { name, modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } } })).body.bot;
  const before = new Set(readdirSync(turnDumps()));
  expect((await api("POST", `/api/bots/${bot.id}/messages`, { token: owner, body: { text: "Open instagram and read my Mac." } })).status).toBe(202);
  const turn = await turnOf(bot.id, before);
  const agents = turn.mcpConfig.mcpServers.agents!;
  const spawned = spawn(agents.command, agents.args, { env: { PATH: process.env.PATH, HOME: home, ...agents.env }, stdio: ["pipe", "pipe", "pipe"] });
  proxies.push(spawned);
  const replies = new Map<number, (value: any) => void>();
  createInterface({ input: spawned.stdout! }).on("line", (line) => { const message = JSON.parse(line); replies.get(message.id)?.(message.result); replies.delete(message.id); });
  let next = 0;
  const request = (method: string, params: unknown): Promise<any> => new Promise((resolve) => {
    const id = ++next; replies.set(id, resolve);
    spawned.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  await request("initialize", { protocolVersion: "2024-11-05" });
  return { gate: await gateOf(bot.id), call: (tool: string, args: unknown = {}) => request("tools/call", { name: tool, arguments: args }) };
}

/** What a bot's Chrome does through its gate: a SOCKS5 CONNECT by name, then (once open) one HTTP request. */
function throughGate(gate: number, host: string, targetPort = 443, { request = true } = {}) {
  return new Promise<{ code: number; body: string; socket: Socket }>((resolve) => {
    const name = Buffer.from(host);
    const socket = tcpConnect(gate, "127.0.0.1", () => socket.write(Buffer.concat([Buffer.from([5, 1, 0, 5, 1, 0, 3, name.length]), name, Buffer.from([targetPort >> 8, targetPort & 0xff])])));
    let received = Buffer.alloc(0);
    let code = -1;
    socket.on("error", () => {});
    socket.on("data", (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      if (code === -1 && received.length >= 12) {
        code = received[3]!;
        received = received.subarray(12);
        if (code !== 0 || !request) return resolve({ code, body: "", socket });
        socket.write(`GET / HTTP/1.1\r\nhost: ${host}\r\nconnection: close\r\n\r\n`);
      }
    });
    socket.on("close", () => resolve({ code, body: received.toString(), socket }));
  });
}

/** The desktop app's lending connector, signed in to My Cloud with the owner's session, as the Mac. It knows My Cloud's
 * saved entry, as the desktop app does, so it lends its internet connection by default. */
let dials = 0;
function lend(file: string, power = createCloudPowerGate()) {
  class CountingSocket extends WebSocket {
    constructor(url: string | URL, init?: unknown) { dials++; super(url, init as never); }
  }
  const env = { id: "my-cloud", name: "My Cloud", origin: base };
  const connector = createComputerSharing({
    file, environments: () => [env], myCloud: () => env, cuaConnection: async () => null, enabled: async () => false, power,
    cloud: () => ({ status: "connected", accountId: "acct_fixture", origin: base }), home: join(home, "mac-home"),
    fetch: (url: string, init: RequestInit) => fetch(url, { ...init, headers: { ...init.headers as Record<string, string>, ...edge, authorization: `Bearer ${owner}` } }),
    linkHeaders: () => ({ authorization: `Bearer ${owner}`, "x-forwarded-for": MAC_PUBLIC, "x-forwarded-proto": "https" }),
    WebSocket: CountingSocket as typeof WebSocket, egress: macEgress(),
  });
  return { connector, env, power };
}

async function boot() {
  const dataDir = join(home, ".openmausbot");
  // Off the internet: My Cloud's own fetches go nowhere, and its own way out resolves no name, so it reaches nothing.
  const offlinePrelude = `data:text/javascript,${encodeURIComponent([
    'import dns from "node:dns/promises"; import { syncBuiltinESMExports } from "node:module";',
    'dns.lookup = async (host) => { throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" }); }; syncBuiltinESMExports();',
    'const real = globalThis.fetch; globalThis.fetch = async (url, init) => String(url).startsWith("http://127.0.0.1:") ? real(url, init) : new Response("offline fixture", { status: 503 });',
  ].join("\n"))}`;
  child = spawn(process.execPath, ["--import", offlinePrelude, join(SERVER_DIR, "index.ts")], {
    cwd: join(SERVER_DIR, ".."),
    env: {
      PATH: process.env.PATH, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home, USERPROFILE: home, OMB_DATA_DIR: dataDir, OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1),
      OMB_CLOUD_ROLE: "home", OMB_CLOUD_MACHINE_ID: "3f9c2a4e-8b1d-4c6e-9a7f-2d5e8c1b0a93", OMB_CLOUD_ADMIN_URL: "https://cloud.example.test",
      OMB_CLOUD_BOOTSTRAP_SECRET: secret, OMB_PUBLIC_URL: `https://${HOST}`,
      OMB_AGENT_BROWSER_PATH: join(home, "agent-browser"),
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
}

beforeAll(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "omb-use-my-mac-")));
  const dataDir = join(home, ".openmausbot");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(turnDumps());
  const cli = join(home, "fixture-claude.mjs");
  writeFileSync(cli, `#!/usr/bin/env node
if (process.argv[2] === "auth") { console.log(JSON.stringify({ loggedIn: true, email: "person@example.test" })); process.exit(0); }
process.env.FAKE_CLAUDE_VERSION = "2.1.284";
if (process.argv[2] !== "--version") { process.env.FAKE_CLAUDE_DUMP = ${JSON.stringify(turnDumps())} + "/" + process.pid + ".json"; process.env.FAKE_CLAUDE_TEXT_DUMP = ${JSON.stringify(join(home, "one-shot.json"))}; process.env.FAKE_CLAUDE_MODE = "hang"; }
await import(${JSON.stringify(pathToFileURL(join(SERVER_DIR, "testing", "fake-claude-cli.ts")).href)});
`, { mode: 0o755 });
  // The bot's browser engine as the server finds it: it names the Chrome its turns would drive, through the gate.
  // It writes down the egress gate each command's Chrome would go through: the bot's own, for the life of the server.
  writeFileSync(join(home, "agent-browser"), `#!${process.execPath}
const args = process.argv.slice(2).filter((arg) => arg !== "--json" && arg !== "--no-webmcp");
if (args[0] === "--version") { console.log("agent-browser 0.37.0"); process.exit(0); }
if (process.env.AGENT_BROWSER_PROXY) require("node:fs").appendFileSync(${JSON.stringify(join(home, "gates.txt"))}, process.env.AGENT_BROWSER_SESSION + " " + process.env.AGENT_BROWSER_PROXY + "\\n");
const running = require("node:fs").existsSync(${JSON.stringify(join(home, "browser-running"))});
process.stdout.write(JSON.stringify({ success: true, data: args[0] === "session" ? { sessions: running ? [process.env.AGENT_BROWSER_SESSION] : [] } : {} }));
`, { mode: 0o755 });
  chmodSync(join(home, "agent-browser"), 0o755);
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ instances: {
    ...Object.fromEntries(["codex", "cursor", "openaiCompat", "qwen", "hermes", "pi", "grok"].map((id) => [id, { driver: "not-a-real-driver" }])),
    claude: { driver: "claudeAgent", displayName: "Claude", config: { cli } },
  } }));
  website = createServer((req, res) => {
    visits.push({ peer: req.socket.remotePort!, host: String(req.headers.host) });
    if (req.headers.host === "slow.youtube.com") return void setTimeout(() => res.end("late"), 60_000);
    res.end(`hello from ${req.headers.host}`);
  });
  await new Promise<void>((resolve) => website.listen(0, "127.0.0.1", resolve));
  websitePort = (website.address() as AddressInfo).port;
  port = await freePortBlock([0, 1]);
  base = `http://127.0.0.1:${port}`;
  await boot();
  owner = await adminPairing();
}, hostTimeout(40_000));

afterAll(async () => {
  for (const proxy of proxies) proxy.kill();
  if (child) await waitForExit(child, { signal: "SIGTERM" });
  website?.closeAllConnections();
  website?.close();
  if (home) await removeTempDir(home);
});

let mac: ReturnType<typeof lend>;
let gate = 0;
/** A bot's turn needs the fixture engine and browser engine, scripts started by their #! line, which Windows does not run. */
const posixOnly = it.skipIf(process.platform === "win32");

it("My Cloud offers the device link, and a fresh Mac signed in to it lends its internet connection by itself, with nothing else and no click", async () => {
  expect((await api("GET", "/.well-known/openmausbot/environment")).body.capabilities).toMatchObject({ sharedComputers: true, deviceLink: true });
  const file = join(home, "desktop-profile", "computer-sharing.json");
  expect(existsSync(file), "nothing was ever lent from this Mac").toBe(false);
  mac = lend(file);
  mac.connector.start();
  await expect.poll(() => mac.connector.cloudState(mac.env).link, { timeout: 8000 }).toBe("on");
  expect(mac.connector.cloudState(mac.env)).toMatchObject({ enabled: true, folders: [], screen: false, terminal: false, internet: true });
  const known = (await api("GET", "/api/shared-computers", { token: owner })).body.known;
  expect(known).toEqual([expect.objectContaining({ online: true, lent: true, scopes: { folders: 0, terminal: false, screen: false, internet: true, chrome: false } })]);
}, hostTimeout(30_000));

posixOnly("a bot's browser on My Cloud reaches Instagram from the Mac's own connection: the website sees the Mac, not My Cloud", async () => {
  ({ gate } = await botTurn("Browser bot"));
  const page = await throughGate(gate, "www.instagram.com", 443);
  expect(page.code).toBe(0);
  expect(page.body).toContain("hello from www.instagram.com");
  expect(visits.length).toBeGreaterThan(0);
  expect(visits.every((visit) => macSockets.has(visit.peer)), "every request the website served came over a socket the Mac opened").toBe(true);
  if (!chrome) return console.log("skipping the real-Chrome page through the Mac: no Chrome found (set OMB_TEST_CHROME)");
  const browser = await launchPipeChrome(chrome, gateChromeFlags(gate));
  try {
    const tab = await browser.page();
    const before = visits.length;
    // Google in a country, by plain http: Chrome would turn a page of instagram.com into https by itself.
    expect((await tab.navigate("http://www.google.zz/")).errorText).toBeUndefined();
    await tab.loaded("http://www.google.zz/");
    expect(await tab.evaluate("document.body.textContent")).toBe("hello from www.google.zz");
    expect(visits.length).toBeGreaterThan(before);
    expect(visits.slice(before).every((visit) => macSockets.has(visit.peer)), "Chrome's page came through the Mac").toBe(true);
  } finally {
    await browser.close();
  }
}, hostTimeout(60_000));

posixOnly("every other site loads straight from My Cloud: the Mac is never asked, nor looks it up", async () => {
  const before = { visits: visits.length, sockets: macSockets.size, lookups: macLookups.length };
  for (const host of ["en.wikipedia.org", "static.cdninstagram.com", "api.ipify.org"]) {
    const page = await throughGate(gate, host, 443);
    page.socket.destroy();
    expect(page.code, `${host}: My Cloud's own way, which resolves nothing here`).toBe(4);
  }
  expect(macLookups.length, "the Mac looked up nothing").toBe(before.lookups);
  expect(macSockets.size).toBe(before.sockets);
  expect(visits.length).toBe(before.visits);
}, hostTimeout(30_000));

posixOnly("a page that reaches for the Mac's home network, the Mac itself, a metadata service, NAT64 or another port is refused on the Mac", async () => {
  const before = { visits: visits.length, sockets: macSockets.size };
  for (const [host, targetPort] of [["router.google.com", 443], ["mac.google.com", 443], ["metadata.googlevideo.com", 80], ["nat64.instagram.com", 443], ["own.youtube.com", 443],
    ["neighbour.google.com", 443], ["home.instagram.com", 443], ["www.instagram.com", 8080], ["www.instagram.com", 25]] as const) {
    const attempt = await throughGate(gate, host, targetPort);
    attempt.socket.destroy();
    expect(attempt.code, `${host}:${targetPort}`).toBe(2);
  }
  expect(macSockets.size, "the Mac connected nowhere").toBe(before.sockets);
  expect(visits.length).toBe(before.visits);
}, hostTimeout(30_000));

posixOnly("a 2 MiB file on the Mac reads whole through My Cloud, under its 4 MB body", async () => {
  const folderPath = realpathSync(mkdtempSync(join(tmpdir(), "omb-use-my-mac-folder-")));
  const bytes = randomBytes(2 * 1024 * 1024);
  writeFileSync(join(folderPath, "photo.bin"), bytes);
  const folder = { id: randomUUID(), name: "Photos", path: folderPath, write: false };
  await mac.connector.saveCloud(mac.env, { folders: [folder], screen: false, internet: true });
  await expect.poll(() => mac.connector.cloudState(mac.env).link, { timeout: 8000 }).toBe("on");
  const { call, gate: next } = await botTurn("Reader bot");
  gate = next;
  const [computer] = JSON.parse((await call("list_shared_computers")).content[0].text).computers;
  const read = await call("shared_computer", { computer_id: computer.id, folder_id: folder.id, action: "read_file", path: "photo.bin", encoding: "base64" });
  expect(read.isError, JSON.stringify(read).slice(0, 300)).not.toBe(true);
  expect(Buffer.from(JSON.parse(read.content[0].text).content, "base64").equals(bytes)).toBe(true);
  rmSync(folderPath, { recursive: true, force: true });
}, hostTimeout(60_000));

posixOnly("when the Mac goes away, a page in flight ends at once, My Cloud says it is away, and the next page goes My Cloud's own way without waiting", async () => {
  const slow = await new Promise<{ socket: Socket; closed: Promise<number> }>((resolve) => {
    const name = Buffer.from("slow.youtube.com");
    const socket = tcpConnect(gate, "127.0.0.1", () => socket.write(Buffer.concat([Buffer.from([5, 1, 0, 5, 1, 0, 3, name.length]), name, Buffer.from([1, 187])])));
    socket.on("error", () => {});
    let received = 0;
    const closed = new Promise<number>((settle) => socket.once("close", () => settle(Date.now())));
    socket.on("data", (chunk: Buffer) => {
      if (received >= 12) return;
      received += chunk.length;
      if (received < 12) return;
      socket.write("GET / HTTP/1.1\r\nhost: slow.youtube.com\r\n\r\n");
      resolve({ socket, closed });
    });
  });
  await expect.poll(() => visits.some((visit) => visit.host === "slow.youtube.com"), { timeout: 5000 }).toBe(true);
  const quit = Date.now();
  mac.connector.close();
  expect(await slow.closed - quit, "the page in flight ended within two seconds").toBeLessThan(2000);
  await expect.poll(async () => (await api("GET", "/api/shared-computers", { token: owner })).body.known.find((computer: any) => computer.lent),
    { timeout: hostTimeout(60_000), interval: 500 }).toEqual(expect.objectContaining({ online: false, scopes: expect.objectContaining({ internet: true }) }));
  const started = Date.now();
  const away = await throughGate(gate, "www.instagram.com", 443);
  expect(away.code, "My Cloud's own way, which resolves nothing here").toBe(4);
  expect(Date.now() - started, "answered without waiting on a Mac that is gone").toBeLessThan(2000);
}, hostTimeout(90_000));

it("a sleeping Cloud is never dialled: while the Admin says it sleeps the Mac neither polls nor opens the link, and does both once it wakes", async () => {
  let word: { state: "asleep" | "awake"; since: number; sleeps: true } | null = { state: "asleep", since: 1, sleeps: true };
  const power = createCloudPowerGate({ power: () => word });
  const polls: string[] = [];
  const file = join(home, "desktop-profile", "computer-sharing.json");
  const env = { id: "my-cloud", name: "My Cloud", origin: base };
  const counted = createComputerSharing({
    file, environments: () => [env], myCloud: () => env, cuaConnection: async () => null, enabled: async () => false, power,
    cloud: () => ({ status: "connected", accountId: "acct_fixture", origin: base }), home: join(home, "mac-home"),
    fetch: (url: string, init: RequestInit) => { polls.push(new URL(url).pathname); return fetch(url, { ...init, headers: { ...init.headers as Record<string, string>, ...edge, authorization: `Bearer ${owner}` } }); },
    linkHeaders: () => ({ authorization: `Bearer ${owner}`, "x-forwarded-for": MAC_PUBLIC }), egress: macEgress(),
    WebSocket: class extends WebSocket { constructor(url: string | URL, init?: unknown) { dials++; super(url, init as never); } } as typeof WebSocket,
  });
  // The grant the Mac kept: lent when the app quit. Where the case above is skipped, the first Mac quits here.
  mac.connector.close();
  counted.start();
  const dialsBefore = dials;
  await new Promise((resolve) => setTimeout(resolve, 1500));
  expect(polls, "nothing called a Cloud the Admin says is asleep").toEqual([]);
  expect(dials).toBe(dialsBefore);
  expect(counted.cloudState(env).problem).toBe("asleep");
  word = { state: "awake", since: 2, sleeps: true };
  power.changed();
  await expect.poll(() => counted.cloudState(env).link, { timeout: 8000 }).toBe("on");
  expect(dials).toBeGreaterThan(dialsBefore);
  mac = { connector: counted, env, power };
}, hostTimeout(30_000));

it("the person's own Off survives a restart of the app: nothing is lent again, neither by the internet connection's default nor by the move's", async () => {
  mac.connector.revoke(mac.env);
  await expect.poll(async () => (await api("GET", "/api/shared-computers", { token: owner })).body.known.every((computer: any) => !computer.lent), { timeout: 5000 }).toBe(true);
  mac.connector.close();
  const again = lend(join(home, "desktop-profile", "computer-sharing.json"));
  const dialsBefore = dials;
  again.connector.start();
  const handlers = new Map<string, (...args: unknown[]) => Promise<any>>();
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omb-use-my-mac-usual-")));
  for (const name of ["Desktop", "Documents", "Downloads"]) mkdirSync(join(root, name));
  const useMyMac = installCloudLending({
    ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => Promise<any>) => handlers.set(channel, handler) },
    localOnly: (_channel: string, handler: unknown) => handler, cloudPage: (_channel: string, handler: unknown) => handler,
    snapshot: async () => ({ available: true, screenAvailable: false, state: again.connector.cloudState(again.env) }),
    environment: () => again.env, save: (target: typeof again.env, choice: never) => again.connector.saveCloud(target, choice), stop: () => again.connector.revoke(again.env),
    chooseFolder: async () => null, defaults: () => usualFolders(["Desktop", "Documents", "Downloads"].map((name) => join(root, name)), validateSharedFolders), validate: validateSharedFolders,
  });
  expect(await useMyMac.lendByDefault({ projects: [root] })).toBeNull();
  await new Promise((resolve) => setTimeout(resolve, 1000));
  expect(again.connector.cloudState(again.env)).toMatchObject({ enabled: false, stopped: { reason: "you" }, internet: true });
  expect(dials, "the link of a computer turned off is never dialled").toBe(dialsBefore);
  expect((await api("GET", "/api/shared-computers", { token: owner })).body.computers).toEqual([]);
  // The person's own switch still lends it again.
  await handlers.get("cloud-lending:set")!({}, true);
  await expect.poll(() => again.connector.cloudState(again.env).link, { timeout: 8000 }).toBe("on");
  again.connector.close();
  rmSync(root, { recursive: true, force: true });
}, hostTimeout(30_000));
