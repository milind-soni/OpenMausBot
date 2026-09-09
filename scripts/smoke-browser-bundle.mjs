#!/usr/bin/env node
// Run against an unpacked/signed app's Resources (macOS) or resources directory.
// Nothing is installed or downloaded. All browser state belongs to this fixture.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { inflateSync } from "node:zlib";
import { browserBundlePaths, browserBundleSpec } from "../server/browser-bundle-release.ts";
import { executableTarget } from "./prepare-cloudflared.mjs";
import { WINDOWS_VENDOR_VERSION, verifyVendorCandidate, verifyVendorPatch } from "./build-windows-browser-vendor.mjs";

const { values } = parseArgs({ options: {
  resources: { type: "string" }, target: { type: "string" },
  "engine-candidate": { type: "string" },
  "check-only": { type: "boolean", default: false }, help: { type: "boolean" },
} });
if (values.help) {
  console.log("Usage: node scripts/smoke-browser-bundle.mjs --resources /absolute/app/resources [--target darwin-arm64] [--check-only] [--engine-candidate /absolute/vendor/agent-browser-win32-x64.exe]");
  process.exit(0);
}
assert(values.resources && isAbsolute(values.resources), "--resources must be an absolute packaged Resources/resources directory");
const target = values.target ?? `${process.platform}-${process.arch}`;
const spec = browserBundleSpec(target);
const paths = browserBundlePaths(join(resolve(values.resources), "browser-engine"), target);
const manifest = JSON.parse(await readFile(paths.manifest, "utf8"));
assert.equal(manifest.schemaVersion, spec.schemaVersion);
assert.equal(manifest.target, target);
for (const component of ["engine", "chrome"]) {
  assert.equal(manifest[component]?.version, spec[component].version);
  assert.equal(manifest[component]?.executable, spec[component].executable);
  assert((await stat(paths[component])).isFile(), `Missing bundled ${component}`);
}
assert((await readdir(paths.licenses)).length > 0, "Missing bundled third-party notices");
assert((await stat(join(paths.directory, spec.chrome.license))).size > 0, "Missing Chromium license");
assert((await stat(join(paths.directory, spec.chrome.about))).size > 0, "Missing Chromium notice");
let enginePath = paths.engine;
let engineVersionExpected = spec.engine.version;
if (values["engine-candidate"] !== undefined) {
  // Only the artifact-only vendor workflow uses this explicit mode. Standard
  // app release calls still discover and execute the bundled, pinned engine.
  assert.equal(process.platform, "win32", "Windows vendor candidates require a native Windows runner");
  assert.equal(target, "win32-x64");
  assert(!values["check-only"], "A candidate must execute the native browser checks");
  assert(isAbsolute(values["engine-candidate"]), "--engine-candidate must be absolute");
  enginePath = resolve(values["engine-candidate"]);
  const candidateDirectory = dirname(enginePath);
  const candidateBytes = await readFile(enginePath);
  verifyVendorCandidate(JSON.parse(await readFile(join(candidateDirectory, "provenance.json"), "utf8")), candidateBytes);
  verifyVendorPatch(await readFile(join(candidateDirectory, "agent-browser-windows-stdio.patch")));
  assert.equal(executableTarget(candidateBytes), "win32-x64");
  for (const license of ["agent-browser-LICENSE.txt", "LICENSE-axe-core.txt", "LICENSE-axe-core-THIRD-PARTY.txt"]) {
    assert.deepEqual(await readFile(join(candidateDirectory, license)), await readFile(join(paths.licenses, license)), `Candidate changed upstream notice ${license}`);
  }
  engineVersionExpected = WINDOWS_VENDOR_VERSION;
}
// Signing changes Mach-O bytes. Source-archive digests are checked before signing;
// this gate checks the final layout, versions, and real browser behavior instead.
if (values["check-only"]) {
  console.log(JSON.stringify({ ok: true, target, check: "structure-only", browserExecuted: false }));
  process.exit(0);
}
assert.equal(target, `${process.platform}-${process.arch}`, "A live smoke test must run on the target architecture; use --check-only for a structural cross-target check");
assert(process.platform !== "linux" || process.getuid?.() !== 0, "Run this sandboxed browser test as an unprivileged user, never root");
if (process.platform === "linux") {
  // agent-browser v0.36.0 chrome.rs:1512 automatically adds --no-sandbox for
  // root, CI, or container markers. We strip CI below; reject containers too
  // so a passing test actually exercises the Ubuntu browser sandbox.
  for (const marker of ["/.dockerenv", "/run/.containerenv"]) {
    const present = await stat(marker).then(() => true, (error) => {
      if (error.code === "ENOENT") return false;
      throw error;
    });
    assert(!present, `Sandbox verification requires an unprivileged, non-container Linux host; ${marker} makes upstream agent-browser disable Chromium's sandbox`);
  }
  const cgroup = await readFile("/proc/1/cgroup", "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  assert(!/docker|kubepods|lxc/.test(cgroup), "Sandbox verification requires a non-container Linux host; upstream agent-browser disables Chromium's sandbox for this cgroup");
}

const fixture = await mkdtemp(join(tmpdir(), "omb-browser-smoke-"));
const fixtureHome = join(fixture, "home");
const env = {
  PATH: process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32") : "/usr/bin:/bin",
  HOME: fixtureHome, USERPROFILE: fixtureHome,
  APPDATA: join(fixtureHome, "AppData", "Roaming"), LOCALAPPDATA: join(fixtureHome, "AppData", "Local"),
  XDG_CONFIG_HOME: join(fixture, "config"), XDG_CACHE_HOME: join(fixture, "cache"),
  XDG_DATA_HOME: join(fixture, "data"), XDG_RUNTIME_DIR: join(fixture, "run"),
  TMPDIR: join(fixture, "tmp"), TMP: join(fixture, "tmp"), TEMP: join(fixture, "tmp"),
  OMB_DATA_DIR: join(fixture, "omb"), OMB_RESOURCES_PATH: resolve(values.resources),
  ...(values["engine-candidate"] ? { OMB_AGENT_BROWSER_PATH: enginePath, AGENT_BROWSER_EXECUTABLE_PATH: paths.chrome } : {}),
  // macOS's per-user temp directory is long; keep Unix socket paths <104 bytes.
  AGENT_BROWSER_SOCKET_DIR: join(fixture, "s"),
  AGENT_BROWSER_DEFAULT_TIMEOUT: "15000", LANG: "en_US.UTF-8", NO_COLOR: "1",
};
for (const key of ["SystemRoot", "WINDIR", "SYSTEMDRIVE", "COMSPEC", "PATHEXT"]) {
  if (process.platform === "win32" && process.env[key]) env[key] = process.env[key];
}
for (const directory of new Set([fixtureHome, env.APPDATA, env.LOCALAPPDATA, env.XDG_CONFIG_HOME,
  env.XDG_CACHE_HOME, env.XDG_DATA_HOME, env.XDG_RUNTIME_DIR, env.TMPDIR, env.OMB_DATA_DIR, env.AGENT_BROWSER_SOCKET_DIR])) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
}
// Isolate even source-module initialization. No inherited account credentials,
// agent-browser config, external CDP connection, profile, proxy, or launch flags.
process.env = env;
const children = new Set();
const clients = [];
let server;
let report;
let failure;
let fixtureRequests = 0;
let phase = "runtime discovery";
let closeBrowserSession;

function child(command, args, childEnv) {
  const proc = spawn(command, args, { cwd: fixture, env: childEnv, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  children.add(proc);
  proc.once("close", () => children.delete(proc));
  return proc;
}

async function run(command, args, childEnv, timeout = 30_000) {
  const proc = child(command, args, childEnv);
  proc.stdin.end();
  let output = "";
  let errors = "";
  proc.stdout.on("data", (data) => { output = (output + data).slice(-1_000_000); });
  proc.stderr.on("data", (data) => { errors = (errors + data).slice(-8_000); });
  const timer = setTimeout(() => proc.kill("SIGKILL"), timeout);
  try {
    const [code, signal] = await once(proc, "close");
    assert.equal(code, 0, `${args.join(" ")} failed (${signal ?? code}): ${errors || output}`);
    return output.trim();
  } finally { clearTimeout(timer); }
}

function mcp(integration) {
  const proc = child(integration.command, integration.args, { ...env, ...integration.env });
  const pending = new Map();
  const lines = createInterface({ input: proc.stdout });
  let sequence = 0;
  let errors = "";
  proc.stderr.on("data", (data) => { errors = (errors + data).slice(-8_000); });
  const rejectPending = (error) => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
    pending.clear();
  };
  proc.on("error", rejectPending);
  // Let close report the engine's stderr instead of an unhandled EPIPE
  // hiding why the child refused to start.
  proc.stdin.on("error", (error) => { if (error.code !== "EPIPE") rejectPending(error); });
  proc.on("close", () => { lines.close(); rejectPending(new Error(`Browser MCP exited: ${errors}`)); });
  lines.on("line", (line) => {
    let message;
    try { message = JSON.parse(line); } catch { rejectPending(new Error("Browser MCP emitted invalid JSON")); return; }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  });
  const request = (method, params = {}, timeout = 45_000) => new Promise((resolveRequest, reject) => {
    const id = ++sequence;
    const label = method === "tools/call" ? params.name : method;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${label} timed out after ${timeout}ms (session ${integration.env.AGENT_BROWSER_SESSION}; fixture HTTP requests ${fixtureRequests}): ${errors}`));
    }, timeout);
    pending.set(id, { resolve: resolveRequest, reject, timer });
    proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  return { proc, integration, request,
    async tool(name, args = {}) {
      const started = Date.now();
      phase = `${name} (${integration.env.AGENT_BROWSER_SESSION})`;
      console.error(`[browser-smoke] ${phase} started`);
      const result = await request("tools/call", { name, arguments: { ...args, timeoutMs: 30_000 } });
      const response = result?.structuredContent?.response;
      assert(!result?.isError && response?.success === true,
        `${name} failed: ${JSON.stringify(result).slice(0, 8_000)}`);
      console.error(`[browser-smoke] ${phase} passed in ${Date.now() - started}ms`);
      return { data: response.data, content: result.content };
    },
  };
}

async function failureDiagnostics() {
  console.error(`[browser-smoke] failure during ${phase}; owned fixture received ${fixtureRequests} HTTP requests`);
  for (const { integration, proc } of clients) {
    const session = integration.env.AGENT_BROWSER_SESSION;
    const sidecars = {};
    // Only fixed metadata names in our own temporary socket directory. Never
    // dump daemon config, encryption keys, browser profiles, or parent env.
    for (const extension of ["pid", "port", "version", "engine"]) {
      sidecars[extension] = await readFile(join(env.AGENT_BROWSER_SOCKET_DIR, `${session}.${extension}`), "utf8")
        .then((value) => value.trim().slice(0, 128), (error) => error.code === "ENOENT" ? null : error.code);
    }
    let daemonAlive = false;
    if (/^[1-9][0-9]*$/.test(sidecars.pid ?? "")) {
      try { process.kill(Number(sidecars.pid), 0); daemonAlive = true; } catch { /* owned daemon already exited */ }
    }
    console.error(`[browser-smoke] ${JSON.stringify({ session, mcpPid: proc.pid, mcpExited: proc.exitCode ?? proc.signalCode, daemonAlive, sidecars })}`);
    if (!daemonAlive) continue;
    try {
      // Failure evidence, not a fallback or prewarm: the MCP test still fails.
      // Upstream Windows issue #1308/#1407 can leave MCP waiting on inherited
      // pipe handles after navigation actually succeeded. A read-only command
      // to the exact existing fixture session distinguishes those two cases.
      const response = JSON.parse(await run(integration.command, ["--json", "--no-webmcp", "get", "url"], { ...env, ...integration.env }, 8_000));
      console.error(`[browser-smoke] existing-session URL diagnostic ${JSON.stringify({ session, success: response.success, url: response.data?.url, error: response.error }).slice(0, 2_000)}`);
    } catch (error) {
      console.error(`[browser-smoke] existing-session URL diagnostic failed: ${error.message.slice(0, 2_000)}`);
    }
  }
}

function pngInfo(buffer) {
  assert(buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), "Screenshot is not PNG");
  assert.equal(buffer.toString("ascii", 12, 16), "IHDR");
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  assert(width >= 100 && height >= 100 && width <= 16_384 && height <= 16_384, "Invalid screenshot dimensions");
  const chunks = [];
  let ended = false;
  for (let offset = 8; offset + 12 <= buffer.length;) {
    const length = buffer.readUInt32BE(offset);
    assert(offset + length + 12 <= buffer.length, "Truncated PNG");
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    if (type === "IDAT") chunks.push(buffer.subarray(offset + 8, offset + 8 + length));
    if (type === "IEND") { ended = true; break; }
    offset += length + 12;
  }
  assert(ended && chunks.length > 0, "Incomplete PNG");
  assert(inflateSync(Buffer.concat(chunks), { maxOutputLength: 128 * 1024 * 1024 }).length > 0, "Empty PNG image data");
  return { width, height, bytes: buffer.length, sha256: createHash("sha256").update(buffer).digest("hex") };
}

async function ownedDaemonPid(client) {
  const session = client.integration.env.AGENT_BROWSER_SESSION;
  const value = (await readFile(join(env.AGENT_BROWSER_SOCKET_DIR, `${session}.pid`), "utf8")).trim();
  assert(/^[1-9][0-9]*$/.test(value), "Owned browser daemon did not record a valid PID");
  return Number(value);
}

async function waitForOwnedDaemonExit(pid) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); }
    catch (error) { if (error.code === "ESRCH") return; throw error; }
    await new Promise((done) => setTimeout(done, 25));
  }
  throw new Error(`Owned browser daemon ${pid} did not exit after close`);
}

const interrupt = () => { for (const proc of children) proc.kill("SIGTERM"); };
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
try {
  const { browserEngineStatus, agentBrowserIntegration, prepareBrowserSessionState, closeBrowserSession: closeSession } = await import("../server/browser-engine.ts");
  closeBrowserSession = closeSession;
  const status = browserEngineStatus({ dataDir: env.OMB_DATA_DIR, env });
  assert.equal(status.kind, "ready", `Fresh-home runtime did not discover the bundle: ${JSON.stringify(status)}`);
  assert.equal(resolve(status.binaryPath), resolve(enginePath), "Runtime did not select the engine under test");
  const engineVersion = await run(enginePath, ["--version"], env);
  const chromeVersion = await run(paths.chrome, ["--version"], env);
  assert.equal(engineVersion, `agent-browser ${engineVersionExpected}`, `Unexpected engine version: ${engineVersion}`);
  assert(chromeVersion.includes(spec.chrome.version), `Unexpected Chromium version: ${chromeVersion}`);

  const title = `OpenMausBot bundled browser ${randomBytes(6).toString("hex")}`;
  server = createServer((_request, response) => {
    fixtureRequests += 1;
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    response.end(`<!doctype html><html><head><title>${title}</title></head><body>
      <h1>${title}</h1><label for="message">Test message</label><input id="message">
      <button id="submit" onclick="document.getElementById('result').textContent=document.getElementById('message').value">Show message</button>
      <p id="result">Waiting</p></body></html>`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}/`;
  for (const name of ["alpha", "beta"]) {
    const integration = agentBrowserIntegration({ binaryPath: status.binaryPath,
      session: `omb-${name[0]}-${randomBytes(4).toString("hex")}`,
      encryptionKey: randomBytes(32).toString("hex"), persistent: false, env });
    assert.equal(resolve(integration.env.AGENT_BROWSER_EXECUTABLE_PATH ?? ""), resolve(paths.chrome), "MCP did not receive bundled Chromium");
    assert.equal(integration.env.AGENT_BROWSER_RESTORE_SAVE, "never");
    // Use the production preparation path. Guest preparation creates only
    // managed config; it must not prewarm a daemon and mask cold-start bugs.
    await prepareBrowserSessionState(integration.command, integration.env.AGENT_BROWSER_SESSION,
      { env: { ...env, ...integration.env }, persistent: false });
    await assert.rejects(readFile(join(env.AGENT_BROWSER_SOCKET_DIR, `${integration.env.AGENT_BROWSER_SESSION}.pid`)), { code: "ENOENT" });
    const client = mcp(integration);
    clients.push(client);
    await client.request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "omb-bundle-smoke", version: "1" } });
    client.proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    const inventory = await client.request("tools/list");
    assert(inventory.tools.some((tool) => tool.name === "agent_browser_open"), "Browser tools missing from MCP core profile");
    await client.tool("agent_browser_open", { url });
  }
  const [alpha, beta] = clients;
  assert.equal((await alpha.tool("agent_browser_get_title")).data.title, title);
  await alpha.tool("agent_browser_fill", { selector: "#message", text: "Bundled browser works" });
  await alpha.tool("agent_browser_click", { selector: "#submit" });
  assert.equal((await alpha.tool("agent_browser_get_text", { selector: "#result" })).data.text, "Bundled browser works");
  const storage = "({ local: localStorage.getItem('omb-smoke'), cookie: document.cookie })";
  const setStorage = (value) => `(() => { localStorage.setItem('omb-smoke', '${value}'); document.cookie = 'omb_smoke=${value}; Path=/; SameSite=Lax'; return ${storage}; })()`;
  assert.deepEqual((await alpha.tool("agent_browser_eval", { script: setStorage("alpha") })).data.result, { local: "alpha", cookie: "omb_smoke=alpha" });
  assert.deepEqual((await beta.tool("agent_browser_eval", { script: storage })).data.result, { local: null, cookie: "" }, "Second bot inherited first bot's state");
  assert.deepEqual((await beta.tool("agent_browser_eval", { script: setStorage("beta") })).data.result, { local: "beta", cookie: "omb_smoke=beta" });
  assert.deepEqual((await alpha.tool("agent_browser_eval", { script: storage })).data.result, { local: "alpha", cookie: "omb_smoke=alpha" }, "First bot's state was overwritten by the second bot");
  // Reopen through the SAME MCP process: warming a daemon before MCP would
  // conceal the Windows inherited-pipe bug, which returns after a close.
  const previousDaemonPid = await ownedDaemonPid(alpha);
  await alpha.tool("agent_browser_close");
  // Upstream acknowledges close before its delayed daemon shutdown. Wait for
  // this exact owned process, otherwise reopen could race the old daemon.
  await waitForOwnedDaemonExit(previousDaemonPid);
  await alpha.tool("agent_browser_open", { url });
  assert.notEqual(await ownedDaemonPid(alpha), previousDaemonPid, "Reopen reused the closed daemon");
  assert.equal((await alpha.tool("agent_browser_get_title")).data.title, title);
  assert.deepEqual((await alpha.tool("agent_browser_eval", { script: storage })).data.result, { local: null, cookie: "" }, "Guest state was restored after close");
  assert.deepEqual((await beta.tool("agent_browser_eval", { script: storage })).data.result, { local: "beta", cookie: "omb_smoke=beta" }, "Restarting the first bot changed the second bot's state");
  await alpha.tool("agent_browser_fill", { selector: "#message", text: "Reopened browser works" });
  await alpha.tool("agent_browser_click", { selector: "#submit" });
  assert.equal((await alpha.tool("agent_browser_get_text", { selector: "#result" })).data.text, "Reopened browser works");
  const screenshotPath = join(fixture, "browser.png");
  const screenshot = await alpha.tool("agent_browser_screenshot", { path: screenshotPath });
  const image = screenshot.content.find((item) => item.type === "image" && item.mimeType === "image/png");
  assert(image?.data, "MCP did not return the screenshot image to the agent");
  const screenshotInfo = pngInfo(await readFile(screenshotPath));
  assert.deepEqual(pngInfo(Buffer.from(image.data, "base64")), screenshotInfo, "MCP image differs from screenshot file");
  report = { ok: true, target, engineMode: values["engine-candidate"] ? "vendor-candidate" : "packaged", engineVersion, chromeVersion, checks: ["fresh-home auto-discovery", "real MCP cold-start navigation", "title", "input and click", "same-MCP close and reopen", "PNG screenshot after restart", "two-bot cookie and localStorage isolation"], screenshot: screenshotInfo };
} catch (error) {
  failure = error;
  try { await failureDiagnostics(); } catch (diagnosticError) {
    console.error(`[browser-smoke] failure diagnostics could not complete: ${diagnosticError.message}`);
  }
}
finally {
  const cleanupErrors = [];
  for (const client of clients) {
    try {
      assert(await closeBrowserSession(client.integration.command, { ...env, ...client.integration.env }), "Owned browser daemon did not close");
    } catch (error) { cleanupErrors.push(error.message); }
  }
  await Promise.all([...children].map((proc) => new Promise((done) => {
    if (proc.exitCode !== null || proc.signalCode !== null) { done(); return; }
    const timer = setTimeout(() => { cleanupErrors.push(`Owned process ${proc.pid} did not exit`); done(); }, 5_000);
    proc.once("close", () => { clearTimeout(timer); done(); });
    proc.kill("SIGKILL");
  })));
  if (server?.listening) { server.closeAllConnections(); await new Promise((done) => server.close(done)); }
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
  if (cleanupErrors.length) failure = new Error(`${failure?.message ?? "Browser test passed"}; browser cleanup failed, isolated fixture retained at ${fixture}: ${cleanupErrors.join("; ")}`);
  else await rm(fixture, { recursive: true, force: true });
}
if (failure) { console.error(failure.stack ?? failure); process.exitCode = 1; }
else console.log(JSON.stringify({ ...report, cleanup: "owned browsers, local HTTP server, and isolated home removed" }, null, 2));
