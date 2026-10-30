// Browsing through a lent PC, on one machine: a real server booted as a Cloud home, a second real server as the PC's
// own desktop server (its screen lease), and the real outbound connector between them. A scripted cua-driver stands in
// for the PC's screen and answers browser tools the way cua-driver does for a browser without a DevTools endpoint.
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-omb.ts";
import { createComputerSharing } from "../electron/computer-sharing.mjs";
import { helperMissing, SCREEN_LOCKED } from "../electron/lent-screen-failures.mjs";
import { createHostScreenLease } from "../electron/host-screen-lease.mjs";
import { personActiveText } from "../electron/lent-screen-presence.mjs";
import { cloudPairingSignature } from "./cloud-home.ts";
import { LENT_BROWSER_NO_ENDPOINT, LENT_SCREEN_BROWSING } from "./lent-screen-guidance.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { hostTimeout } from "./testing/host-timeout.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const HOST = "omb-t-0123456789ab.fly.dev";
const secret = randomBytes(32).toString("base64url");
const edge = { host: HOST, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https", origin: `https://${HOST}` };
let home = "";
let base = "";
let cloud: ChildProcess;
let log = "";
let owner = "";
let lender: VerificationServer;
let pages: Server;
let pageUrl = "";
let connector: ReturnType<typeof createComputerSharing>;
let call: (name: string, args?: unknown) => Promise<any>;
let computerId = "";
const proxies: ChildProcess[] = [];

/** What the PC's screen does next; the scripted driver reads it on every call. */
const screen = { file: "", set(mode: "normal" | "exit" | "hang") { writeFileSync(this.file, JSON.stringify({ mode })); } };
let locked = false;
/** Seconds since the person last touched the PC; null: the PC cannot tell. */
let idle: number | null = null;
let leaseUrl = "";
let signedIn = true;
let driver: { mcpCommand: string; mcpArgs: string[]; mcpEnv: Record<string, string> } | { mode: "unavailable"; reason: string };
const channel = { lose: null as null | "answer" | "poll", lost: 0, abandoned: [] as AbortController[] };

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
  return (await api("POST", "/api/auth/pair", { body: { code: granted.code } })).body.token;
}

/** expect.poll for setup, which runs outside any test. */
async function until(check: () => unknown | Promise<unknown>, what: string, timeout = 15_000) {
  for (const deadline = Date.now() + timeout; !(await check()); await new Promise((resolve) => setTimeout(resolve, 100))) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
  }
}

async function proxyFor(start: () => Promise<void>) {
  const dump = join(home, "spawn.json");
  rmSync(dump, { force: true });
  await start();
  let agents: { command: string; args: string[]; env: Record<string, string> } | undefined;
  await until(() => {
    try { agents = JSON.parse(readFileSync(dump, "utf8")).mcpConfig.mcpServers.agents; return true; } catch { return false; }
  }, "the turn's agents proxy");
  const proxy = spawn(agents!.command, agents!.args, { env: { PATH: process.env.PATH, HOME: home, ...agents!.env }, stdio: ["pipe", "pipe", "pipe"] });
  proxies.push(proxy);
  const replies = new Map<number, (value: any) => void>();
  createInterface({ input: proxy.stdout! }).on("line", line => { const msg = JSON.parse(line); replies.get(msg.id)?.(msg.result); replies.delete(msg.id); });
  let next = 0;
  const request = (method: string, params: unknown): Promise<any> => new Promise(resolve => {
    const id = ++next; replies.set(id, resolve);
    proxy.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  await request("initialize", { protocolVersion: "2024-11-05" });
  return (name: string, args: unknown = {}) => request("tools/call", { name, arguments: args });
}

/** cua-driver as a lent PC runs it: a browser without a DevTools endpoint refuses browser tools; the screen route reads the page. */
function writeDriver(dir: string): string {
  const script = join(dir, "cua-driver-fixture.mjs");
  writeFileSync(script, `import readline from "node:readline"; import fs from "node:fs";
const modeFile = ${JSON.stringify(screen.file)};
let opened = "";
const tools = ["get_desktop_state", "launch_app", "get_window_state", "click", "type_text", "get_browser_state", "browser_navigate", "browser_click", "browser_prepare"]
  .map(name => ({ name, inputSchema: { type: "object", properties: {} } }));
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", async line => {
  const m = JSON.parse(line); if (!m.id) return;
  if (m.method === "initialize") return reply(m.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} } });
  if (m.method === "tools/list") return reply(m.id, { tools });
  const { mode } = JSON.parse(fs.readFileSync(modeFile, "utf8"));
  if (mode === "exit") process.exit(3);
  if (mode === "hang") return;
  const { name, arguments: args = {} } = m.params;
  if (name === "get_browser_state" || name.startsWith("browser_")) return reply(m.id, { isError: true,
    content: [{ type: "text", text: "no owned endpoint is available; run browser_prepare explicitly to set one up" }],
    structuredContent: { ok: false, code: "browser_requires_setup" } });
  if (name === "launch_app") { opened = args.urls?.[0] ?? ""; return reply(m.id, { content: [{ type: "text", text: JSON.stringify({ pid: 4242, windows: [{ window_id: 7, title: "New Tab - Google Chrome" }] }) }] }); }
  if (name === "get_window_state") {
    const html = opened ? await (await fetch(opened)).text() : "";
    const title = /<title>([^<]*)/.exec(html)?.[1] ?? "";
    const body = html.replace(/<title>[^<]*<\\/title>/, "").replace(/<[^>]+>/g, " ").replace(/\\s+/g, " ").trim();
    return reply(m.id, { content: [{ type: "text", text: "AXWindow \\"" + title + " - Google Chrome\\"\\n  AXWebArea: " + body }] });
  }
  reply(m.id, { content: [{ type: "text", text: "done" }] });
});
`);
  return script;
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "omb-lent-browser-"));
  const dataDir = join(home, ".openmausbot");
  mkdirSync(dataDir, { recursive: true });
  const cli = join(home, "fixture-claude.mjs");
  writeFileSync(cli, `#!/usr/bin/env node
if (process.argv[2] === "auth") { console.log(JSON.stringify({ loggedIn: true, email: "person@example.test" })); process.exit(0); }
process.env.FAKE_CLAUDE_VERSION = "2.1.284";
if (process.argv[2] !== "--version") { process.env.FAKE_CLAUDE_DUMP = ${JSON.stringify(join(home, "spawn.json"))}; process.env.FAKE_CLAUDE_MODE = "hang"; }
await import(${JSON.stringify(pathToFileURL(join(SERVER_DIR, "testing", "fake-claude-cli.ts")).href)});
`, { mode: 0o755 });
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ instances: {
    ...Object.fromEntries(["codex", "cursor", "githubCopilot", "openaiCompat", "qwen", "hermes", "pi", "grok"].map((id) => [id, { driver: "not-a-real-driver" }])),
    claude: { driver: "claudeAgent", displayName: "Claude", config: { cli } },
  } }));
  chmodSync(cli, 0o755);
  const port = await freePortBlock([0, 1]);
  base = `http://127.0.0.1:${port}`;
  const offlinePrelude = `data:text/javascript,${encodeURIComponent('const real = globalThis.fetch; globalThis.fetch = async (url, init) => String(url).startsWith("http://127.0.0.1:") ? real(url, init) : new Response("offline fixture", { status: 503 });')}`;
  cloud = spawn(process.execPath, ["--import", offlinePrelude, join(SERVER_DIR, "index.ts")], {
    cwd: join(SERVER_DIR, ".."),
    env: {
      PATH: process.env.PATH, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home, USERPROFILE: home, OMB_DATA_DIR: dataDir, OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1),
      OMB_CLOUD_ROLE: "home", OMB_CLOUD_MACHINE_ID: "3f9c2a4e-8b1d-4c6e-9a7f-2d5e8c1b0a93", OMB_CLOUD_ADMIN_URL: "https://cloud.example.test",
      OMB_CLOUD_BOOTSTRAP_SECRET: secret, OMB_PUBLIC_URL: `https://${HOST}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  cloud.stdout?.on("data", (chunk) => { log += chunk; });
  cloud.stderr?.on("data", (chunk) => { log += chunk; });
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (cloud.exitCode !== null) throw new Error(`the Cloud home exited:\n${log}`);
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
    if (Date.now() > deadline) throw new Error(`the Cloud home did not start:\n${log}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  owner = await adminPairing();

  lender = await launchVerificationServer({ FAKE_CLAUDE_MODE: "hang" });
  const enabled = await fetch(`${lender.info.url}/api/config`, { method: "PATCH", headers: { "content-type": "application/json", origin: lender.info.url }, body: JSON.stringify({ features: { sharedComputers: true } }) });
  expect(enabled.status).toBe(200);

  pages = createServer((_req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end("<!doctype html><title>Order 1042</title><h1>Order 1042</h1><p>Total: 42.00 EUR</p>"); });
  await new Promise<void>((resolve) => pages.listen(0, "127.0.0.1", resolve));
  pageUrl = `http://127.0.0.1:${(pages.address() as { port: number }).port}/orders/1042`;

  screen.file = join(home, "screen.json");
  screen.set("normal");
  driver = { mcpCommand: process.execPath, mcpArgs: [writeDriver(home)], mcpEnv: {} };
  const env = { id: "my-cloud", name: "My Cloud", origin: base };
  // The desktop's own lease on its screen, taken from its local server the way Electron main takes it.
  leaseUrl = `${lender.info.url}/api/desktop/shared-computer-control`;
  connector = createComputerSharing({
    file: join(home, "pc-profile", "computer-sharing.json"), environments: () => [env],
    cuaConnection: async () => driver, screenLocked: () => locked, idleSeconds: () => idle,
    hostControl: createHostScreenLease({ url: () => leaseUrl, headers: () => ({ origin: lender.info.url }) }),
    cloud: () => ({ status: signedIn ? "connected" : "unverified", accountId: "acct_fixture", origin: base }),
    home: join(home, "pc-home"),
    // The PC's network to its Cloud, which a test can make lose a poll's answer, or leave a poll hanging as a dead connection does.
    fetch: async (url: string, init: RequestInit) => {
      const request = { ...init, headers: { ...init.headers as Record<string, string>, authorization: `Bearer ${owner}`, ...edge } };
      if (!String(url).endsWith("/poll") || !channel.lose) return fetch(url, request);
      const loss = channel.lose; channel.lose = null; channel.lost++;
      if (loss === "answer") { await (await fetch(url, request)).text(); throw new Error("network changed"); }
      const abandoned = new AbortController(); channel.abandoned.push(abandoned);
      void fetch(url, { ...request, signal: abandoned.signal }).catch(() => {});
      throw new Error("network changed");
    },
  });
  await connector.saveCloud(env, { folders: [], screen: true });
  await until(() => connector.cloudState(env).connected, "the PC to lend its screen");
  const status = (await api("GET", "/api/shared-computers", { token: owner })).body.computers;
  expect(status).toMatchObject([{ online: true, scopes: { screen: true, terminal: false } }]);
  computerId = status[0].id;
  const bot = (await api("POST", "/api/bots", { token: owner, body: { name: "Cloud bot", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } } })).body.bot;
  call = await proxyFor(async () => {
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { token: owner, body: { text: "Open order 1042 in the browser on my PC and tell me its total." } })).status).toBe(202);
  });
}, hostTimeout(60_000));

afterAll(async () => {
  connector?.close();
  for (const abandoned of channel.abandoned) abandoned.abort();
  for (const proxy of proxies) proxy.kill();
  if (cloud) await waitForExit(cloud, { signal: "SIGTERM" });
  await lender?.close();
  await new Promise((resolve) => pages ? pages.close(resolve) : resolve(undefined));
  if (home) await removeTempDir(home);
});

const screenCall = (tool_name: string, args: Record<string, unknown> = {}) => call("shared_computer", { computer_id: computerId, action: "computer_call", tool_name, arguments: args });
const said = (result: any) => (result?.content ?? []).map((part: any) => part.text).join("\n");

it("a browser task through the lent PC: the browser tools explain the screen route, and the screen route reads the page", async () => {
  const listing = await call("shared_computer", { computer_id: computerId, action: "computer_tools" });
  expect(said(listing)).toContain(LENT_SCREEN_BROWSING);
  const bound = await screenCall("get_browser_state", { pid: 4242, window_id: 7 });
  expect(bound.isError).toBe(true);
  expect(said(bound)).toContain(LENT_BROWSER_NO_ENDPOINT);
  const prepare = await screenCall("browser_prepare", { pid: 4242 });
  expect(prepare.isError).toBe(true);
  expect(said(prepare)).toContain("browser_prepare is not part of lent apps and screen");
  expect(said(prepare)).toContain(LENT_BROWSER_NO_ENDPOINT);
  expect((await screenCall("launch_app", { name: "Google Chrome", urls: [pageUrl] })).isError).toBeFalsy();
  const page = await screenCall("get_window_state", { pid: 4242, window_id: 7 });
  expect(said(page)).toContain("Order 1042 - Google Chrome");
  expect(said(page)).toContain("Total: 42.00 EUR");
}, hostTimeout(60_000));

const lenderLease = (id: string, action: string) => fetch(leaseUrl, { method: "POST", headers: { "content-type": "application/json", origin: lender.info.url }, body: JSON.stringify({ id, action }) });

it("a screen lock an earlier lent call left behind, or a person holding a bot's other computer, never blocks the lent screen", async () => {
  // An earlier lent call whose release never arrived (the app crashed, or the release timed out) still holds the lock.
  expect((await lenderLease("5d0c7a39-2b39-4b07-9a0e-0c58a7d55f21", "acquire")).status).toBe(200);
  expect((await screenCall("get_desktop_state")).isError).toBeFalsy();
  // The person took control of a desktop bot's own cloud computer and never handed it back: that is another computer.
  const bot = await (await fetch(`${lender.info.url}/api/bots`, { method: "POST", headers: { "content-type": "application/json", origin: lender.info.url }, body: JSON.stringify({ name: "Desk bot" }) })).json() as { bot: { id: string } };
  const take = await fetch(`${lender.info.url}/api/bots/${bot.bot.id}/computer/control`, { method: "POST", headers: { "content-type": "application/json", origin: lender.info.url }, body: JSON.stringify({ action: "take" }) });
  expect((await take.json() as { held: boolean }).held).toBe(true);
  const free = await screenCall("get_desktop_state");
  expect(free.isError, said(free)).toBeFalsy();
}, hostTimeout(30_000));

it("a screen the PC's own server cannot check says so in one sentence, never that a person is using it", async () => {
  const right = leaseUrl;
  leaseUrl = `${lender.info.url}/api/desktop/not-the-screen-lock`;
  const refused = await screenCall("get_desktop_state");
  leaseUrl = right;
  expect(refused.isError).toBe(true);
  expect(said(refused)).toMatch(/^OpenMausBot on this computer could not check whether its screen is free \(its server answered 404.*\), so this call was not performed\. This is not a person using the computer\./);
  expect((await screenCall("get_desktop_state")).isError).toBeFalsy();
}, hostTimeout(30_000));

it("while the person uses the PC, background calls run and a call that would take their mouse waits with the reason", async () => {
  idle = 0;
  const listing = await call("shared_computer", { computer_id: computerId, action: "computer_tools" });
  expect(listing.isError, said(listing)).toBeFalsy();
  expect((await screenCall("launch_app", { name: "Google Chrome", urls: [pageUrl] })).isError).toBeFalsy();
  expect(said(await screenCall("get_window_state", { pid: 4242, window_id: 7 }))).toContain("Total: 42.00 EUR");
  expect((await screenCall("click", { pid: 4242, window_id: 7, element_index: 3 })).isError).toBeFalsy();
  const front = await screenCall("click", { x: 10, y: 10 });
  expect(front.isError).toBe(true);
  expect(said(front)).toBe(personActiveText("click"));
  idle = 45;
  expect((await screenCall("click", { x: 10, y: 10 })).isError).toBeFalsy();
  idle = null;
}, hostTimeout(30_000));

it("a locked screen says to unlock it, and works once unlocked", async () => {
  locked = true;
  const refused = await screenCall("get_desktop_state");
  expect(refused.isError).toBe(true);
  expect(said(refused)).toBe(SCREEN_LOCKED);
  locked = false;
  expect((await screenCall("get_desktop_state")).isError).toBeFalsy();
}, hostTimeout(30_000));

it("a quarantined driver says how to restore it; restored, the next action works without a restart", async () => {
  screen.set("exit");
  const stopped = await screenCall("get_desktop_state");
  expect(said(stopped)).toMatch(/^Computer control stopped on this computer: its helper, cua-driver, exited\. Try the action once more/);
  const working = driver;
  driver = { mcpCommand: join(home, "Program Files", "OpenMausBot", "resources", "cua-driver.exe"), mcpArgs: ["mcp"], mcpEnv: {} };
  const missing = await screenCall("get_desktop_state");
  expect(said(missing)).toBe(helperMissing());
  expect(said(missing)).not.toContain(home);
  driver = { mode: "unavailable", reason: "cua-driver binary not found" };
  expect(said(await screenCall("get_desktop_state"))).toBe(helperMissing());
  driver = working; screen.set("normal");
  expect((await screenCall("get_desktop_state")).isError).toBeFalsy();
}, hostTimeout(30_000));

it("a poll whose answer is lost on the network still delivers its job, once", async () => {
  const started = Date.now(), lost = channel.lost;
  channel.lose = "answer";
  await expect.poll(() => channel.lost, { timeout: 25_000 }).toBe(lost + 1);
  await launchAndRead();
  expect(Date.now() - started).toBeLessThan(35_000);
}, hostTimeout(60_000));

it("a dead poll the server still holds neither blocks the reconnecting PC nor takes its job", async () => {
  const started = Date.now(), lost = channel.lost;
  channel.lose = "poll";
  await expect.poll(() => channel.lost, { timeout: 25_000 }).toBe(lost + 1);
  await launchAndRead();
  expect(Date.now() - started).toBeLessThan(35_000);
}, hostTimeout(60_000));

it("lending paused on the PC reads as offline, and resumes by itself", async () => {
  signedIn = false; connector.cloudChanged();
  await expect.poll(async () => (await api("GET", "/api/shared-computers", { token: owner })).body.computers.length, { timeout: 8000 }).toBe(0);
  const paused = await screenCall("get_desktop_state");
  expect(paused.isError).toBe(true);
  expect(said(paused)).toMatch(/offline/);
  signedIn = true; connector.cloudChanged();
  await expect.poll(async () => (await api("GET", "/api/shared-computers", { token: owner })).body.computers[0]?.online, { timeout: 15_000 }).toBe(true);
  computerId = (await api("GET", "/api/shared-computers", { token: owner })).body.computers[0].id;
  expect((await screenCall("get_desktop_state")).isError).toBeFalsy();
}, hostTimeout(60_000));

it("a driver that stops answering ends the action in one sentence, and the next action starts a fresh driver", async () => {
  screen.set("hang");
  const hung = await screenCall("get_desktop_state");
  expect(hung.isError).toBe(true);
  expect(said(hung)).toMatch(/^Computer control stopped\. An action already admitted by the driver may have completed\./);
  screen.set("normal");
  expect((await screenCall("get_desktop_state")).isError).toBeFalsy();
}, hostTimeout(60_000));

async function launchAndRead() {
  const opened = await screenCall("launch_app", { name: "Google Chrome", urls: [pageUrl] });
  expect(opened.isError, said(opened)).toBeFalsy();
  expect(said(await screenCall("get_window_state", { pid: 4242, window_id: 7 }))).toContain("Total: 42.00 EUR");
}
