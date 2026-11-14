// The rail's "{name}: needs you" in the real packaged app, with a synthetic Admin and synthetic Clouds at their real
// addresses. Run on a disposable GitHub macOS runner only: it edits /etc/hosts and trusts a throwaway certificate.
//   node scripts/verify-place-inbox-rail.mjs --app release/mac-arm64/OpenMausBot.app --out <evidence dir>
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const option = (name) => { const at = process.argv.indexOf(name); return at === -1 ? undefined : process.argv[at + 1]; };
if (process.env.GITHUB_ACTIONS !== "true" || process.platform !== "darwin") throw new Error("This check edits /etc/hosts and the system keychain: it runs on a disposable GitHub macOS runner only.");
const APP = resolve(option("--app") ?? "release/mac-arm64/OpenMausBot.app");
const OUT = resolve(option("--out") ?? mkdtempSync(join(tmpdir(), "omb-rail-evidence-")));
mkdirSync(OUT, { recursive: true });
const ROOT = new URL("..", import.meta.url);
const WORK = mkdtempSync(join(tmpdir(), "omb-rail-"));
const POLL_MS = 150_000;
const DEBUG_PORT = 9333;

const ADMIN_HOST = "cloud.openmausbot.com", AWAKE_HOST = "omb-u-aaaaaaaaaaaa.fly.dev", ASLEEP_HOST = "omb-u-bbbbbbbbbbbb.fly.dev";
const BLOCKED = ["us.i.posthog.com", "us-assets.i.posthog.com", "app.posthog.com"];
const TOKEN = `omc_${"T".repeat(43)}`, COOKIE = "omb_session_fixture";
const results = [];
const log = (line) => { console.log(line); appendFileSync(join(OUT, "progress.log"), `${line}\n`); };
function passed(name, detail = "") { results.push({ name, passed: true, detail }); log(`PASS ${name}${detail ? `: ${detail}` : ""}`); }

function trustThrowawayCertificate() {
  const key = join(WORK, "key.pem"), cert = join(WORK, "cert.pem"), conf = join(WORK, "cert.conf");
  writeFileSync(conf, `[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=rail check\n[v3]\nsubjectAltName=${[ADMIN_HOST, AWAKE_HOST, ASLEEP_HOST].map((host) => `DNS:${host}`).join(",")}\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyCertSign\nextendedKeyUsage=serverAuth\n`);
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-keyout", key, "-out", cert, "-config", conf]);
  execFileSync("sudo", ["security", "add-trusted-cert", "-d", "-r", "trustRoot", "-k", "/Library/Keychains/System.keychain", cert]);
  const lines = [ADMIN_HOST, AWAKE_HOST, ASLEEP_HOST, ...BLOCKED].map((host) => `127.0.0.1 ${host}`).join("\n");
  execFileSync("sudo", ["sh", "-c", `printf '%s\\n' '${lines}' >> /etc/hosts && dscacheutil -flushcache`]);
  return { key: readFileSync(key), cert: readFileSync(cert), certFile: cert };
}

const clouds = {
  [AWAKE_HOST]: { id: "cloud-awake", name: "Studio", count: 0, power: "awake", requests: [], cookie: false },
  [ASLEEP_HOST]: { id: "cloud-asleep", name: "Archive", count: 5, power: "asleep", requests: [], cookie: false },
};
const adminLog = [];
const SINCE = Date.now() - 60_000;
const identity = () => ({ cloudContractVersion: 1, expiresAt: Date.now() + 86_400_000, device: { id: "rail-device" }, account: { id: "rail-account", email: "person@example.test" } });
const listed = () => Object.entries(clouds).map(([host, cloud]) => ({
  id: cloud.id, name: cloud.name, color: "teal", role: "owner", tier: "pro", runsOn: "cloud", status: "ready", origin: `https://${host}`, teamId: null, primary: false,
  power: { state: cloud.power, since: cloud.since ?? SINCE, sleeps: true },
}));

function serve(tls) {
  const server = createServer(tls, async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const reply = (status, value, headers = {}) => { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(value)); };
    const host = (req.headers.host ?? "").split(":")[0];
    const path = new URL(req.url, `https://${host}`).pathname;
    if (host === ADMIN_HOST) {
      adminLog.push(`${req.method} ${path}`);
      if (path === "/api/cloud/desktop/authorize") return reply(201, { cloudContractVersion: 1, deviceCode: "A".repeat(43), userCode: "ABCDE-FGHJK", verificationUriComplete: `https://${ADMIN_HOST}/cloud/desktop?code=ABCDE-FGHJK`, expiresIn: 600, interval: 5 });
      if (path === "/api/cloud/desktop/token") return reply(200, { ...identity(), accessToken: TOKEN });
      if (path === "/api/cloud/desktop/pairing" && req.headers.authorization === `Bearer ${TOKEN}`) {
        const wanted = Object.entries(clouds).find(([, cloud]) => cloud.id === JSON.parse(raw || "{}").cloudId);
        return wanted ? reply(200, { cloudContractVersion: 1, origin: `https://${wanted[0]}`, code: "ABCD-EFGH-JKLM", expiresAt: Date.now() + 60_000 }) : reply(404, { error: "not_found" });
      }
      if (path === "/api/cloud/desktop/session" && req.headers.authorization === `Bearer ${TOKEN}`) {
        return reply(200, { ...identity(), entitlement: { plan: "free", status: "inactive", expiresAt: null, version: 1 }, clouds: listed() });
      }
      if (req.url === "/" || path.startsWith("/cloud/")) { res.writeHead(200, { "content-type": "text/html" }); return res.end("<h1>Synthetic Admin</h1>"); }
      return reply(404, { error: "not_found" });
    }
    const cloud = clouds[host];
    if (!cloud) return reply(404, { error: "not_found" });
    const signedIn = (req.headers.cookie ?? "").includes(`${COOKIE}=`);
    if (path === "/api/inbox/count") {
      cloud.requests.push({ at: Date.now(), cookie: signedIn, background: req.headers["x-omb-background"] === "1" });
      return signedIn ? reply(200, { count: cloud.count }) : reply(401, { error: "sign in" });
    }
    cloud.requests.push({ at: Date.now(), other: `${req.method} ${path}` });
    if (path === "/api/auth/pair") {
      cloud.cookie = true;
      return reply(200, { token: "fixture", session: { id: "s" } }, { "set-cookie": `${COOKIE}=${randomBytes(16).toString("hex")}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400; Secure` });
    }
    if (path === "/api/auth/session") return signedIn ? reply(200, { kind: "session", id: "s", label: "app", scopes: ["admin"], expiresAt: Date.now() + 86_400_000 }) : reply(401, { error: "sign in" });
    if (path.startsWith("/api/")) return reply(404, { error: "not_found" });
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><title>${cloud.name}</title><h1 id="fake-cloud">${cloud.name}</h1>`);
  });
  return new Promise((done, fail) => { server.once("error", fail); server.listen(443, "0.0.0.0", () => done(server)); });
}

class Page {
  constructor(socket) { this.socket = socket; this.next = 0; this.waiting = new Map();
    socket.addEventListener("message", (event) => { const data = JSON.parse(event.data); const pending = this.waiting.get(data.id); if (pending) { this.waiting.delete(data.id); pending(data); } }); }
  static async open(target) {
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((done, fail) => { socket.addEventListener("open", done, { once: true }); socket.addEventListener("error", fail, { once: true }); });
    return new Page(socket);
  }
  send(method, params = {}) { const id = ++this.next; return new Promise((done) => { this.waiting.set(id, done); this.socket.send(JSON.stringify({ id, method, params })); }); }
  async evaluate(expression) {
    const { result, error } = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (error || result?.exceptionDetails) throw new Error(`${expression.slice(0, 120)}: ${JSON.stringify(error ?? result.exceptionDetails).slice(0, 600)}`);
    return result.result.value;
  }
  async shot(name) { const { result } = await this.send("Page.captureScreenshot", { format: "png" }); if (result?.data) writeFileSync(join(OUT, `${name}.png`), Buffer.from(result.data, "base64")); }
  close() { this.socket.close(); }
}

const targets = async () => (await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json());
async function until(what, test, ms = 60_000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await test().catch(() => null);
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await delay(500);
  }
}
const isRail = (target) => new URL(target.url || "about:blank").pathname === "/rail";
const railPage = async () => Page.open(await until("the rail's page", async () => (await targets()).find(isRail)));
const windowTarget = async (test, what) => until(what, async () => (await targets()).find((target) => target.type === "page" && !isRail(target) && test(new URL(target.url || "about:blank"))));

const TILES = `[...document.querySelectorAll("[data-rail-place]")].map((tile) => ({ id: tile.dataset.railPlace, kind: tile.dataset.railKind, label: tile.getAttribute("aria-label"), dot: Boolean(tile.querySelector("[data-rail-dot]")), active: tile.getAttribute("aria-current") === "page" }))`;
const tiles = (rail) => rail.evaluate(TILES);
const tileOf = async (rail, name) => (await tiles(rail)).find((tile) => tile.label?.includes(name));
const open = (rail, name) => rail.evaluate(`[...document.querySelectorAll("[data-rail-place]")].find((tile) => tile.getAttribute("aria-label")?.includes(${JSON.stringify(name)})).click()`);
async function dumpOnFailure(rail) {
  writeFileSync(join(OUT, "state.json"), JSON.stringify({ tiles: rail ? await tiles(rail).catch(() => null) : null, adminLog, clouds, targets: await targets().catch(() => null) }, null, 2));
}

let app, server, rail, failure = null;
try {
  const { certFile, ...tls } = trustThrowawayCertificate();
  server = await serve(tls);
  const home = join(WORK, "home"), dataDir = join(home, ".openmausbot");
  mkdirSync(dataDir, { recursive: true });
  const plan = join(WORK, "room-plan.json");
  writeFileSync(plan, "{}");
  const cli = join(WORK, "fixture-claude.mjs");
  writeFileSync(cli, `#!${process.execPath}
if (process.argv[2] === "auth") { console.log(JSON.stringify({ loggedIn: true, email: "person@example.test" })); process.exit(0); }
process.env.FAKE_CLAUDE_VERSION = "2.1.284";
process.env.FAKE_CLAUDE_ROOM_PLAN = ${JSON.stringify(plan)};
await import(${JSON.stringify(new URL("server/testing/fake-claude-cli.ts", ROOT).href)});
`);
  chmodSync(cli, 0o755);
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ instances: {
    ...Object.fromEntries(["codex", "cursor", "githubCopilot", "openaiCompat", "qwen", "hermes", "pi", "grok"].map((id) => [id, { driver: "not-a-real-driver" }])),
    claude: { driver: "claudeAgent", displayName: "Claude", config: { cli } },
  } }));

  const binary = join(APP, "Contents", "MacOS", "OpenMausBot");
  assert.ok(existsSync(binary), `no app at ${binary}`);
  const appLog = join(OUT, "app.log");
  app = spawn(binary, ["--use-mock-keychain", `--remote-debugging-port=${DEBUG_PORT}`], { env: { ...process.env, HOME: home, OMB_DATA_DIR: dataDir, NODE_EXTRA_CA_CERTS: certFile }, stdio: ["ignore", "pipe", "pipe"] });
  for (const stream of [app.stdout, app.stderr]) stream.on("data", (chunk) => appendFileSync(appLog, chunk));
  app.once("exit", (code, signal) => { if (!failure) log(`app exited: ${code ?? signal}`); });

  const local = await windowTarget((url) => url.hostname === "127.0.0.1" && url.pathname !== "/rail", "this computer's page");
  const page = await Page.open(local);
  await until("the page's bridge", () => page.evaluate(`Boolean(window.ogb?.cloudAccount) && document.readyState === "complete"`), 120_000);
  passed("the packaged app starts with the rail's watch wired in", local.url);
  await page.shot("00-app-started");

  await page.evaluate(`window.ogb.cloudAccount.begin().then(() => true)`);
  await until("the sign-in", () => page.evaluate(`window.ogb.cloudAccount.state().then((state) => state.status === "connected")`), 60_000).catch(async (error) => {
    log(`account state: ${JSON.stringify(await page.evaluate("window.ogb.cloudAccount.state()").catch(String)).slice(0, 600)}`);
    throw error;
  });
  assert.ok(adminLog.some((line) => line.endsWith("/api/cloud/desktop/session")), "the app read the Admin's session");
  passed("signs in to the synthetic Admin at its real address, over real TLS");

  rail = await railPage();
  await until("three tiles", async () => (await tiles(rail))?.length >= 3, 60_000);
  const first = await tiles(rail);
  log(JSON.stringify(first));
  assert.ok(first.some((tile) => tile.kind === "computer"), "This computer has a tile");
  passed("the rail lists this computer and both Clouds", first.map((tile) => tile.label).join(" | "));

  const counts = () => clouds[AWAKE_HOST].requests.filter((one) => one.background !== undefined);
  await until("a first look at the Cloud", async () => counts().length > 0, POLL_MS);
  assert.ok(counts().every((one) => one.background), "every count is asked as background work");
  assert.ok(counts().every((one) => one.cookie), "it asks with a session, which the app made itself by pairing with its own Cloud");
  assert.ok(clouds[AWAKE_HOST].cookie, "the app paired with its own awake Cloud without the person opening it");
  assert.equal((await tileOf(rail, "Studio")).dot, false);
  passed("a Cloud never opened on this computer is asked, as background work, with the session the app paired itself; nothing waits, so its tile stays quiet");

  clouds[AWAKE_HOST].count = 2;
  const fired = await until("Studio's attention", async () => { const tile = await tileOf(rail, "Studio"); return tile?.dot ? tile : null; }, POLL_MS);
  assert.equal(fired.label, "Studio: needs you");
  assert.ok(counts().every((one) => one.background && one.cookie));
  passed("a place with lines waiting fires its label and dot, without ever being opened", fired.label);
  await rail.shot("01-rail-fired");

  await open(rail, "Studio");
  const cloudWindow = await windowTarget((url) => url.hostname === AWAKE_HOST, "Studio's page");
  await rail.close(); rail = await railPage();
  await until("Studio on screen", async () => (await tileOf(rail, "Studio"))?.active);
  assert.equal((await tileOf(rail, "Studio")).dot, false, "the place on screen has its own row");
  passed("the place on screen shows no dot, even with lines waiting", cloudWindow.url);

  await open(rail, "This computer");
  await windowTarget((url) => url.hostname === "127.0.0.1" && url.pathname !== "/rail", "this computer's page again");
  await rail.close(); rail = await railPage();
  await until("Studio's dot back", async () => (await tileOf(rail, "Studio"))?.dot, POLL_MS);
  passed("leaving it with lines still waiting brings its dot back");

  const beforeSleep = () => counts().length;
  clouds[AWAKE_HOST].power = "asleep"; clouds[AWAKE_HOST].since = Date.now();
  const page2 = await Page.open(await windowTarget((url) => url.hostname === "127.0.0.1" && url.pathname !== "/rail", "this computer's page"));
  await page2.evaluate(`window.ogb.cloudAccount.refresh().then(() => true)`);
  await delay(3_000);
  const sleeping = beforeSleep();
  clouds[AWAKE_HOST].count = 0;
  await delay(POLL_MS);
  assert.equal(beforeSleep(), sleeping, "a sleeping Cloud is not asked");
  assert.equal((await tileOf(rail, "Studio")).dot, true, "it keeps the last number it gave");
  passed("once the Admin says a Cloud sleeps it is never asked, over a whole poll, and keeps its last number", `${POLL_MS / 1000}s with no request`);

  clouds[AWAKE_HOST].power = "awake"; clouds[AWAKE_HOST].since = Date.now();
  await page2.evaluate(`window.ogb.cloudAccount.refresh().then(() => true)`);
  await until("Studio's attention to clear", async () => !(await tileOf(rail, "Studio")).dot, POLL_MS);
  assert.equal((await tileOf(rail, "Studio")).label, "Studio");
  passed("awake again with nothing waiting, its label and dot clear");

  assert.deepEqual(clouds[ASLEEP_HOST].requests, [], "the Cloud that slept throughout got no request at all");
  passed("a Cloud the Admin says is asleep received no request in the whole run", `${Math.round((Date.now() - SINCE) / 1000)}s`);

  const api = (method, path, body) => page2.evaluate(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { "content-type": "application/json" }${body ? `, body: ${JSON.stringify(JSON.stringify(body))}` : ""} }).then(async (res) => ({ status: res.status, body: await res.json().catch(() => null) }))`);
  const created = await api("POST", "/api/bots", { name: "Eli", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } });
  assert.equal(created.status, 201, JSON.stringify(created));
  const bot = created.body.bot;
  assert.ok((await api("PATCH", `/api/bots/${bot.id}`, { approvalMode: "ask", applyToAllThreads: true })).status < 300);
  writeFileSync(plan, JSON.stringify({ [bot.id]: { script: [{ key: "Q", match: ["Q-GO"], timeoutMs: 600_000,
    steps: [{ server: "ogb", tool: "ask_user", arguments: { question: "Which page?", choices: ["Home", "Pricing"] }, capture: { answer: "([\\s\\S]+)" } }], reply: "Q: {{answer}}" }] } }));
  const sent = await api("POST", `/api/bots/${bot.id}/messages`, { text: "Q-GO", threadId: bot.threadId });
  assert.equal(sent.status, 202, JSON.stringify(sent));
  const asking = await until("the question in this computer's inbox", async () => { const { body } = await api("GET", "/api/inbox/count"); return body?.count >= 1 ? body : null; }, 120_000);
  passed("a real bot's question on the real packaged server counts in this computer's inbox", JSON.stringify(asking));
  await page2.shot("02-local-inbox-row");
  page2.close();

  await open(rail, "Studio");
  await windowTarget((url) => url.hostname === AWAKE_HOST, "Studio's page again");
  await rail.close(); rail = await railPage();
  const computer = await until("This computer's attention", async () => { const tile = (await tiles(rail)).find((one) => one.kind === "computer"); return tile?.dot ? tile : null; }, POLL_MS);
  assert.match(computer.label, /needs you/);
  passed("while the window shows a Cloud, this computer's tile fires through its real local request", computer.label);
  await rail.shot("03-rail-this-computer");
} catch (error) {
  failure = error;
  console.error(error);
  await dumpOnFailure(rail);
} finally {
  await dumpOnFailure(rail);
  writeFileSync(join(OUT, "receipt.json"), `${JSON.stringify({ passed: !failure, results, failure: failure ? String(failure.stack ?? failure) : null,
    limitation: "Synthetic Admin and Clouds at their real addresses over real TLS; unsigned ad-hoc build; a bot on the synthetic Claude CLI. No real Cloud, real sleep or real wake." }, null, 2)}\n`);
  log(JSON.stringify({ passed: !failure, steps: results.length }));
  rail?.close?.();
  app?.kill("SIGTERM");
  await delay(3_000);
  app?.kill("SIGKILL");
  server?.closeAllConnections?.(); server?.close?.();
  process.exit(failure ? 1 : 0);
}
