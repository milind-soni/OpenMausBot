// Prove the built server actually STARTS with no node_modules in reach.
//
// 0.1.24 shipped a server that died on every launch with
//   ERR_MODULE_NOT_FOUND: Cannot find package 'zod'
// because `tsc` leaves bare imports verbatim and the packaged app carries no
// node_modules. Every existing gate passed it: the unit suite runs in the repo
// (where zod resolves), and the packaging check only asserts index.js EXISTS.
//
// So this copies dist-server OUT of the repo before running it. Inside the
// repo a bare import still resolves by walking up to ./node_modules and the
// test passes on a build that would be dead in the field — which is precisely
// how the bug escaped. The copy is the whole point; do not "simplify" it away.
import { execFile, spawn } from "node:child_process";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { browserBundlePaths, browserBundleSpec } from "../server/browser-bundle-release.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({ options: { "browser-bundle": { type: "string" } } });
const browserBundle = values["browser-bundle"];
let browserSpec;
if (browserBundle !== undefined) {
  assert(isAbsolute(browserBundle), "--browser-bundle must be an absolute staged browser target directory");
  const manifest = JSON.parse(readFileSync(join(browserBundle, "manifest.json"), "utf8"));
  browserSpec = browserBundleSpec(manifest.target);
  assert.equal(manifest.target, `${process.platform}-${process.arch}`, "--browser-bundle must match this Node host's platform and architecture");
  assert.equal(manifest.schemaVersion, browserSpec.schemaVersion, "Unsupported browser bundle manifest");
  const paths = browserBundlePaths(browserBundle, manifest.target);
  for (const component of ["engine", "chrome"]) {
    assert.equal(manifest[component]?.version, browserSpec[component].version);
    assert.equal(manifest[component]?.executable, browserSpec[component].executable);
    assert(statSync(paths[component]).isFile(), `Missing bundled ${component}`);
  }
}
/** Free loopback ports, asked of the OS (listen on port 0) rather than picked
 * at random: Windows reserves port ranges (Hyper-V and WinNAT exclusions), and
 * a random pick in one died with `listen EACCES 127.0.0.1:497xx` on the
 * Windows runners three times in October 2026. The OS never hands out a
 * reserved port. Every listener stays open until all are bound, so the ports
 * differ from each other; each server under test gets its app port and its
 * webhook port (which otherwise defaults to the app port + 1) this way. */
async function freePorts(count) {
  const servers = [];
  try {
    for (let i = 0; i < count; i++) {
      const server = createServer();
      servers.push(server);
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
    }
    return servers.map((server) => server.address().port);
  } finally {
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(() => resolve()))));
  }
}

const staging = mkdtempSync(join(tmpdir(), "omb-smoke-"));
const home = mkdtempSync(join(tmpdir(), "omb-smoke-home-"));
const [port, webhookPort] = await freePorts(2);

// OMB_SMOKE_DIST lets the release workflow aim this at a packaged app's
// Resources/server tree instead of the repo build.
try {
  // A desktop install can live beneath a user's CommonJS package scope.
  // Only metadata shipped with the server may establish its ESM format.
  writeFileSync(join(staging, "package.json"), '{"type":"commonjs"}\n');
  cpSync(process.env.OMB_SMOKE_DIST ?? join(root, "dist-server"), join(staging, "server"), { recursive: true });
  if (browserBundle) cpSync(resolve(browserBundle), join(staging, "browser-engine"), { recursive: true });
} catch (error) {
  for (const directory of [staging, home]) rmSync(directory, { recursive: true, force: true });
  throw error;
}

const fixtureEnv = {
  ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
  ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  HOME: home,
  USERPROFILE: home,
  APPDATA: join(home, "AppData", "Roaming"),
  LOCALAPPDATA: join(home, "AppData", "Local"),
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_CACHE_HOME: join(home, ".cache"),
  XDG_DATA_HOME: join(home, ".local", "share"),
  OMB_DATA_DIR: join(home, ".openmausbot"),
  OMB_PORT: String(port),
  OMB_WEBHOOK_PORT: String(webhookPort),
  // Not a genuine key: enough to make the server look for its enterprise
  // layer and say whether it found one (checked below), never enough to
  // unlock anything.
  OMB_LICENSE_KEY: "omb1.not.real",
  ...(browserBundle ? {
    OMB_RESOURCES_PATH: staging,
    // A global engine on the developer's PATH must not make this test pass.
    PATH: process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32") : "/usr/bin:/bin",
  } : {}),
};

const child = spawn(process.execPath, [join(staging, "server", "index.js")], {
  cwd: staging,
  env: fixtureEnv,
  stdio: ["ignore", "pipe", "pipe"],
});

let output = "";
child.stdout.on("data", (chunk) => (output += chunk));
child.stderr.on("data", (chunk) => (output += chunk));

// Best-effort by design. Windows holds file handles open a little longer than
// the process that owned them, so removing the scratch dir immediately after
// the kill raises EPERM; Linux runners can raise EACCES the same way. Scratch
// cleanup must never decide whether the build is good — it failed a green run
// on Windows once already, and see f66d30f for the same lesson on Linux.
const cleanup = () => {
  child.kill("SIGKILL");
  for (const dir of [staging, home]) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* the OS will reap it; the assertion below is what matters */
    }
  }
};

const deadline = Date.now() + 45_000;
let listening = false;
while (Date.now() < deadline) {
  if (child.exitCode !== null) break;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    if (res.ok) {
      listening = true;
      break;
    }
  } catch {
    /* not up yet */
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
}

let searchReport = null;
if (listening) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/search?q=packaged-worker-probe`, { signal: AbortSignal.timeout(10_000) });
    searchReport = { status: response.status, body: await response.json() };
  } catch (error) { searchReport = { error: String(error) }; }
}

let browserReport = null;
if (browserBundle && listening) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/config`, { signal: AbortSignal.timeout(5_000) });
    assert.equal(response.status, 200, "Packaged browser config did not respond successfully");
    const config = await response.json();
    browserReport = { browserEngine: config.browserEngine, browserEnabled: config.features?.browser };
  } catch (error) { browserReport = { error: String(error) }; }
}

// Serving /api/health is necessary but nowhere near sufficient. Bundling
// relocates import.meta.url, so a module that used to sit in drivers/ resolves
// its sibling paths from the bundle's directory instead — one level too high.
// The 0.1.24 candidate booted and answered /api/health perfectly while every
// spawned proxy pointed outside Resources/server, silently killing permission
// prompts, computer use and dweb. So check the paths the server ACTUALLY
// resolved, from inside the staged copy, before calling the build good.
const probe = join(staging, "server", "probe-proxy-paths.mjs");
writeFileSync(
  probe,
  [
    'import { existsSync } from "node:fs";',
    'import { SPAWNED_PROXIES } from "./proxy-paths.js";',
    "const missing = Object.entries(SPAWNED_PROXIES).filter(([, p]) => !existsSync(p));",
    "console.log(JSON.stringify({ resolved: SPAWNED_PROXIES, missing }));",
  ].join("\n"),
);

// The packaged tree carries the bundled enterprise layer inside the server
// root (server/enterprise/server/index.js). server/enterprise.ts must find it
// there, or a licensed install silently runs the open-source edition.
const layerShipped = existsSync(join(staging, "server", "enterprise", "server", "index.js"));
let editionReport = null;
if (listening) {
  try {
    editionReport = await (await fetch(`http://127.0.0.1:${port}/api/edition`, { signal: AbortSignal.timeout(5_000) })).json();
  } catch (error) { editionReport = { error: String(error) }; }
}

let proxyReport = null;
try {
  const { stdout } = await promisify(execFile)(process.execPath, [probe], { cwd: staging, env: fixtureEnv });
  proxyReport = JSON.parse(stdout);
} catch (error) {
  proxyReport = { error: String((error && error.message) || error) };
}

// The public MCP process is a second packaged entry point. Send a request and
// close stdin immediately: this proves both that the bundle has no external
// dependencies and that shutdown lets the final JSON-RPC frame drain.
let mcpReport = null;
if (listening) {
  const mcp = spawn(process.execPath, [join(staging, "server", "mcp-server.js")], {
    cwd: staging,
    env: fixtureEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  mcp.stdout.on("data", (chunk) => (stdout += chunk));
  mcp.stderr.on("data", (chunk) => (stderr += chunk));
  const initialize = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "package-smoke", version: "1" } },
  });
  const health = JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "get_system_health", arguments: {} },
  });
  mcp.stdin.write(`${initialize}\n${health}\n`);
  const healthDeadline = Date.now() + 8_000;
  while (Date.now() < healthDeadline && !stdout.split("\n").some((line) => line.includes('"id":2'))) {
    if (mcp.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  // The ping is deliberately followed by EOF without waiting. If the stdio
  // close path exits before buffered frames drain, id 3 will be missing.
  mcp.stdin.end(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "ping" })}\n`);
  const closed = new Promise((resolve) => mcp.once("close", (code, signal) => resolve({ code, signal })));
  let timeout;
  const exit = await Promise.race([
    closed,
    new Promise((resolve) => {
      timeout = setTimeout(() => resolve({ timeout: true }), 10_000);
    }),
  ]);
  clearTimeout(timeout);
  if (exit.timeout) {
    mcp.kill("SIGKILL");
    await closed;
  }
  try {
    const responses = stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    mcpReport = { exit, responses, stderr };
  } catch (error) {
    mcpReport = { exit, stdout, stderr, error: String(error) };
  }
}

// An HTTP export must actually start the bundled worker outside the checkout.
// Existence checks alone cannot catch an unbundled transitive dependency.
let backupReport = null;
if (listening) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/workspace-backup/export`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "packaged-fixture-password-only" }), signal: AbortSignal.timeout(30_000),
    });
    assert.equal(response.status, 200, "Packaged backup worker did not export successfully");
    const archive = await response.json();
    assert.equal(archive.summary.format, "openmaus.workspace-backup");
    const download = await fetch(`http://127.0.0.1:${port}/api/workspace-backup/download/${archive.id}`);
    assert.equal(download.status, 200);
    const bytes = Buffer.from(await download.arrayBuffer());
    assert.equal(bytes.length, archive.bytes);
    assert.equal(bytes.subarray(0, 16).toString(), "OMB-WORKSPACE-1\n");
    backupReport = { ok: true, bytes: bytes.length };
  } catch (error) { backupReport = { error: String(error) }; }
}

// The container image runs the server through server-launcher.js (Dockerfile,
// deploy/podman/Containerfile). It must start the bundled index.js beside it
// as its own child, and a stop (SIGTERM, `docker stop`) must end both with the
// server's clean exit. Containers are Linux; Windows has no SIGTERM to pass on.
let launcherReport = null;
if (listening && process.platform !== "win32") {
  const launcherHome = mkdtempSync(join(tmpdir(), "omb-smoke-launcher-"));
  const [launcherPort, launcherWebhookPort] = await freePorts(2);
  const launcher = spawn(process.execPath, [join(staging, "server", "server-launcher.js")], {
    cwd: staging,
    env: { ...fixtureEnv, HOME: launcherHome, USERPROFILE: launcherHome, OMB_DATA_DIR: join(launcherHome, ".openmausbot"), OMB_PORT: String(launcherPort), OMB_WEBHOOK_PORT: String(launcherWebhookPort) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let launcherOutput = "";
  launcher.stdout.on("data", (chunk) => (launcherOutput += chunk));
  launcher.stderr.on("data", (chunk) => (launcherOutput += chunk));
  const exited = new Promise((resolve) => launcher.once("exit", (code, signal) => resolve({ code, signal })));
  try {
    let serverPid = null;
    const until = Date.now() + 45_000;
    while (Date.now() < until && launcher.exitCode === null && serverPid === null) {
      try {
        const health = await (await fetch(`http://127.0.0.1:${launcherPort}/api/health`, { signal: AbortSignal.timeout(2_000) })).json();
        if (Number.isSafeInteger(health.pid)) serverPid = health.pid;
      } catch { /* not up yet */ }
      if (serverPid === null) await new Promise((resolve) => setTimeout(resolve, 300));
    }
    launcher.kill("SIGTERM");
    let timer;
    const exit = await Promise.race([exited, new Promise((resolve) => { timer = setTimeout(() => resolve({ timeout: true }), 20_000); })]);
    clearTimeout(timer);
    let stillServing = false;
    try { await fetch(`http://127.0.0.1:${launcherPort}/api/health`, { signal: AbortSignal.timeout(2_000) }); stillServing = true; } catch { /* stopped */ }
    launcherReport = { serverPid, launcherPid: launcher.pid, exit, stillServing, output: launcherOutput.slice(-2_000) };
  } catch (error) {
    launcherReport = { error: String(error), output: launcherOutput.slice(-2_000) };
  } finally {
    if (launcher.exitCode === null) launcher.kill("SIGKILL");
    try { rmSync(launcherHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* the OS will reap it */ }
  }
}

// The packaged desktop forks desktop-entry.mjs, not index.js
// (electron/server-child-launch.mjs): it turns on Node's compile cache, then
// imports index.js beside it. Start it twice on one cache directory. The first
// start must write the cache while it runs (Windows has no SIGTERM, so a kill
// there skips Node's exit-time write); the second must start on top of it.
let desktopEntryReport = null;
if (listening) {
  const entryHome = mkdtempSync(join(tmpdir(), "omb-smoke-entry-"));
  const cacheDir = join(entryHome, "server-compile-cache");
  const cacheEntries = () => {
    try {
      return readdirSync(cacheDir).filter((name) => /^v\d+\.\d+\.\d+-/.test(name))
        .flatMap((version) => readdirSync(join(cacheDir, version)).map((file) => `${version}/${file}`));
    } catch { return []; }
  };
  desktopEntryReport = { starts: [] };
  try {
    for (let round = 0; round < 2; round++) {
      const [entryPort, entryWebhookPort] = await freePorts(2);
      const entry = spawn(process.execPath, [join(staging, "server", "desktop-entry.mjs")], {
        cwd: staging,
        env: { ...fixtureEnv, HOME: entryHome, USERPROFILE: entryHome, OMB_DATA_DIR: join(entryHome, ".openmausbot"),
          OMB_PORT: String(entryPort), OMB_WEBHOOK_PORT: String(entryWebhookPort), OMB_SERVER_COMPILE_CACHE: cacheDir },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let entryOutput = "";
      entry.stdout.on("data", (chunk) => (entryOutput += chunk));
      entry.stderr.on("data", (chunk) => (entryOutput += chunk));
      const exited = new Promise((resolve) => entry.once("exit", (code, signal) => resolve({ code, signal })));
      let served = false;
      const until = Date.now() + 45_000;
      while (Date.now() < until && entry.exitCode === null && !served) {
        try { served = (await fetch(`http://127.0.0.1:${entryPort}/api/health`, { signal: AbortSignal.timeout(2_000) })).ok; } catch { /* not up yet */ }
        if (!served) await new Promise((resolve) => setTimeout(resolve, 300));
      }
      // The bootstrap writes the cache about 10 s after the server starts.
      const written = Date.now() + 30_000;
      while (served && round === 0 && Date.now() < written && entry.exitCode === null && cacheEntries().length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      const cached = cacheEntries();
      entry.kill("SIGTERM");
      let timer;
      await Promise.race([exited, new Promise((resolve) => { timer = setTimeout(resolve, 20_000); })]);
      clearTimeout(timer);
      if (entry.exitCode === null) entry.kill("SIGKILL");
      desktopEntryReport.starts.push({ served, cached, output: served ? undefined : entryOutput.slice(-2_000) });
    }
  } catch (error) {
    desktopEntryReport.error = String(error);
  } finally {
    try { rmSync(entryHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* the OS will reap it */ }
  }
}

cleanup();

if (launcherReport && (launcherReport.error || !launcherReport.serverPid || launcherReport.serverPid === launcherReport.launcherPid ||
  launcherReport.exit?.code !== 0 || launcherReport.stillServing)) {
  console.error("the packaged container launcher did not run the server as its child and stop it cleanly:");
  console.error(JSON.stringify(launcherReport, null, 2));
  process.exit(1);
}

if (desktopEntryReport && (desktopEntryReport.error || desktopEntryReport.starts.length !== 2 ||
  !desktopEntryReport.starts.every((start) => start.served) || desktopEntryReport.starts[0].cached.length === 0)) {
  console.error("the packaged desktop entry did not start the server twice on a compile cache it wrote:");
  console.error(JSON.stringify(desktopEntryReport, null, 2));
  process.exit(1);
}

if (!listening) {
  console.error(`the packaged server never served /api/health on port ${port}.`);
  console.error(`exit code: ${child.exitCode}`);
  console.error(output.trim() || "(no output)");
  process.exit(1);
}

if (searchReport?.status !== 200 || !Array.isArray(searchReport.body?.hits)) {
  console.error("The packaged read-only search worker did not respond:", searchReport);
  process.exit(1);
}

if (layerShipped && (!editionReport || editionReport.error || String(editionReport.notice ?? "").includes("no enterprise layer exists"))) {
  console.error("the packaged server ships an enterprise layer but did not find it:");
  console.error(JSON.stringify(editionReport, null, 2));
  process.exit(1);
}

if (!proxyReport || proxyReport.error || proxyReport.missing.length > 0) {
  console.error("spawned proxy paths do not resolve inside the packaged server dir:");
  console.error(JSON.stringify(proxyReport, null, 2));
  console.error("\nthe server would still answer /api/health — and every one of these");
  console.error("features would be dead: permission prompts, computer use, dweb, peer comms.");
  process.exit(1);
}

if (browserBundle && (browserReport?.error || browserReport?.browserEngine?.kind !== "engine" ||
  browserReport.browserEngine.version !== browserSpec.engine.version || browserReport.browserEnabled !== true)) {
  console.error("The fresh-home packaged server did not discover its browser bundle with browser access on by default:");
  console.error(JSON.stringify(browserReport, null, 2));
  process.exit(1);
}

if (
  !mcpReport ||
  mcpReport.error ||
  mcpReport.exit?.timeout ||
  mcpReport.exit?.code !== 0 ||
  mcpReport.responses?.find((response) => response.id === 1)?.result?.serverInfo?.name !== "openmausbot-mcp" ||
  mcpReport.responses?.find((response) => response.id === 2)?.result?.structuredContent?.status !== "connected" ||
  JSON.stringify(mcpReport.responses?.find((response) => response.id === 3)?.result) !== "{}"
) {
  console.error("the packaged MCP stdio server failed its initialize-health-and-drain smoke test:");
  console.error(JSON.stringify(mcpReport, null, 2));
  process.exit(1);
}

const count = Object.keys(proxyReport.resolved).length;
if (!backupReport?.ok) {
  console.error("the packaged backup worker failed its encrypted export smoke:", backupReport);
  process.exit(1);
}
console.log(`packaged server started with no node_modules in reach (port ${port}) ✓`);
console.log(`all ${count} spawned proxy paths resolve inside the packaged server dir ✓`);
console.log("packaged MCP stdio server reached the API and flushed its final frames ✓");
console.log("packaged backup worker exported an encrypted archive ✓");
if (launcherReport) console.log("packaged container launcher ran the server as its child and stopped it cleanly ✓");
if (desktopEntryReport) console.log(`packaged desktop entry started the server twice on its compile cache (${desktopEntryReport.starts[0].cached.length} entries) ✓`);
if (layerShipped) console.log("packaged server found its enterprise layer inside the server dir ✓");
if (browserBundle) console.log(`packaged browser discovered without installation; access on by default ✓ ${JSON.stringify(browserReport)}`);
