#!/usr/bin/env node
// The desktop app's launch, phase by phase, on isolated folders only: Electron's own main module packed as an asar and
// run in packaged mode on this checkout's Electron, the bundled server (dist-server) and the built pages (dist), a
// seeded workspace, and one reused profile. Prints one JSON object, so a change can show before/after.
//   pnpm build && pnpm build:server
//   node scripts/bench-launch.mjs --root /tmp/openmausbot-bench-launch.XXXXXX [--app CHECKOUT] [--runs 7] [--cold]
//     [--seed 30,60,300] [--label NAME] [--out FILE] [--no-asar] [--dev] [--server-prof DIR [--server-prof-tail MS]] [--quiet-ms 1500]
//     [--engines]
// --app: the checkout whose electron/, dist/ and dist-server/ are measured (this one by default), so two checkouts run
//   under the same bench. --cold: the page cache, its code cache and the main and server compile caches are emptied before each
//   launch (what the first launch after an update does); otherwise one primed profile is reused. --dev: what
//   `pnpm dev:desktop` starts instead: electron/ from loose files, unpackaged, its page from a Vite dev server already
//   running in front of a source server (both started here, on the bench's own ports and folders).
// --server-prof: the server child of each launch writes a V8 CPU profile into DIR, up to its "listening" line or
//   --server-prof-tail ms past it; those launches are slower for it.
// --engines: this computer's PATH instead of the sealed one, so the engines installed here are found and probed as at a
//   real launch (their probes run in the bench's own HOME).
// --quiet-ms: how long the page must stay free of long tasks after the chat is drawn before the app is quit; 4000 or
//   more lets the app write its own launch record (launch-timings.json in the data folder) first.
// Not measured: a signed app's signature and keychain checks (a mock keychain stands in), the real engines' probes
// (the fixture's sealed PATH hides them), the computer-control and browser helpers (not staged), any network call
// (all refused and counted in `egress`).
import { spawn, execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { get as httpGet } from "node:http";
import { createRequire } from "node:module";
import { loadavg } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const require = createRequire(import.meta.url);
const { values } = parseArgs({ options: {
  root: { type: "string" }, app: { type: "string", default: ROOT }, runs: { type: "string", default: "7" }, cold: { type: "boolean", default: false },
  seed: { type: "string", default: "30,60,300" }, label: { type: "string", default: "launch" }, out: { type: "string" }, "no-asar": { type: "boolean", default: false }, dev: { type: "boolean", default: false }, "server-prof": { type: "string" }, "quiet-ms": { type: "string", default: "1500" }, "server-prof-tail": { type: "string", default: "0" },
  engines: { type: "boolean", default: false },
} });
const log = (line) => process.stderr.write(`bench-launch: ${line}\n`);
if (!values.root || !values.root.includes("openmausbot-bench-")) throw new Error("--root must be a folder made for this bench (its name holds openmausbot-bench-)");
mkdirSync(values.root, { recursive: true });
const root = realpathSync(values.root);
const appRoot = resolve(values.app);
for (const needed of ["electron/main.mjs", "dist/index.html", "dist-server/desktop-entry.mjs"]) {
  if (!existsSync(join(appRoot, needed))) throw new Error(`${appRoot} has no ${needed}; run pnpm build && pnpm build:server there`);
}
const BENCH_PORTS = [38799, 48799, 58799];
const paths = {
  home: join(root, "home"), tmp: join(root, "tmp"), data: join(root, "data"), userData: join(root, values.dev ? "user-data-dev" : "user-data"), stage: join(root, `stage-${values.label}`),
  egress: join(root, "egress.log"), seed: join(root, "seed.json"), results: join(root, "results"),
};
for (const dir of [paths.home, paths.tmp, paths.userData, paths.results]) mkdirSync(dir, { recursive: true });

function stage() {
  rmSync(paths.stage, { recursive: true, force: true });
  const appDir = join(paths.stage, "app"), resources = join(paths.stage, "resources");
  cpSync(join(appRoot, "electron"), join(appDir, "electron"), { recursive: true, filter: (source) => !/\.test\.|node-test\.|[\\/]node_modules([\\/]|$)/.test(source) });
  mkdirSync(join(appDir, "src", "locales"), { recursive: true });
  for (const file of readdirSync(join(appRoot, "src", "locales"))) if (file.endsWith(".json") && file !== "source-hashes.json") cpSync(join(appRoot, "src", "locales", file), join(appDir, "src", "locales", file));
  const manifest = JSON.parse(readFileSync(join(appRoot, "package.json"), "utf8"));
  writeFileSync(join(appDir, "package.json"), JSON.stringify({ name: "openmausbot-bench-launch", productName: "OpenMausBot Bench", version: manifest.version, type: "module", main: "bench-launch-entry.mjs" }));
  cpSync(join(HERE, "testing", "bench-launch-entry.mjs"), join(appDir, "bench-launch-entry.mjs"));
  // The installed app owns the real ports; a measured launch never knocks on them.
  const portsFile = join(appDir, "electron", "desktop-ports.mjs");
  const ports = readFileSync(portsFile, "utf8");
  if (!ports.includes("[8799, 18799, 28799]")) throw new Error("electron/desktop-ports.mjs no longer lists the ports this bench replaces");
  writeFileSync(portsFile, ports.replace("[8799, 18799, 28799]", JSON.stringify(BENCH_PORTS)));
  mkdirSync(resources, { recursive: true });
  for (const [name, from] of [["ui", "dist"], ["server", "dist-server"], ["skills", "skills"]]) symlinkSync(join(appRoot, from), join(resources, name));
  const blocker = join(paths.stage, "bench-launch-block.cjs");
  cpSync(join(HERE, "testing", "bench-launch-block.cjs"), blocker);
  let entry = appDir;
  if (!values["no-asar"] && !values.dev) {
    const store = join(ROOT, "node_modules", ".pnpm");
    const packed = readdirSync(store).find((name) => name.startsWith("@electron+asar@"));
    if (!packed) throw new Error("@electron/asar is not installed; pass --no-asar");
    const asar = join(paths.stage, "app.asar");
    execFileSync(process.execPath, ["-e", `require(${JSON.stringify(join(store, packed, "node_modules", "@electron", "asar"))}).createPackage(${JSON.stringify(appDir)}, ${JSON.stringify(asar)}).then(() => process.exit(0), (error) => { console.error(error); process.exit(1); })`], { stdio: "inherit" });
    entry = asar;
  }
  return { entry, resources, blocker };
}

function seed() {
  if (existsSync(paths.seed)) return JSON.parse(readFileSync(paths.seed, "utf8"));
  const [bots, threads, messages] = values.seed.split(",");
  mkdirSync(join(paths.data, "tmp"), { recursive: true });
  const out = execFileSync(process.execPath, ["--experimental-strip-types", join(appRoot, "scripts", "testing", "bench-desktop-seed.ts"), bots, threads, messages], {
    cwd: appRoot, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
    env: { PATH: dirname(process.execPath), HOME: paths.data, OMB_DATA_DIR: paths.data, TMPDIR: join(paths.data, "tmp") },
  });
  const seeded = JSON.parse(out.trim().split("\n").at(-1));
  writeFileSync(join(paths.data, "config.json"), JSON.stringify({
    features: { smartSetupChoices: false },
    instances: { claude: { driver: "claudeAgent", config: { cli: join(appRoot, "server", "testing", "fake-claude-cli.ts") } } },
  }));
  writeFileSync(paths.seed, JSON.stringify(seeded));
  return seeded;
}

const STORAGE = { "omb-analytics-opt-out": "1", "omb-email-gate": "skipped", "omb-simple-mode-prompt": "1", "grok-move-2026-11": "1", "teams-2026-11b": "1", "modelgo-offer-2026-11": "1", "whats-new-2026-11b": "1", "whats-new-2026-11c": "1", "omb-advanced-mode": "0" };
const electron = require("electron");
const DEV_PAGE_PORT = BENCH_PORTS[0] - 3600;
const fixtureEnv = () => ({
  PATH: values.engines ? process.env.PATH : dirname(process.execPath), HOME: paths.home, CFFIXED_USER_HOME: paths.home, TMPDIR: paths.tmp, LANG: process.env.LANG ?? "en_US.UTF-8",
  OMB_DATA_DIR: paths.data, OMB_WEBHOOK_PORT: String(BENCH_PORTS[0] + 1), ...(values.engines ? {} : { OMB_TEST_SEALED_PATH: "1" }), OMB_DISABLE_ANNOUNCEMENTS: "1", FAKE_CLAUDE_MODE: "happy",
  OMB_BENCH_EGRESS_LOG: paths.egress, ...(values["server-prof"] ? { OMB_BENCH_SERVER_PROF: resolve(values["server-prof"]), OMB_BENCH_SERVER_PROF_TAIL_MS: values["server-prof-tail"] } : {}),
});
const answers = (url) => new Promise((done) => { const request = httpGet(url, (response) => { response.resume(); done(response.statusCode < 500); }); request.on("error", () => done(false)); request.setTimeout(2000, () => request.destroy()); });
const devChildren = [];
async function startDevServers() {
  const env = { ...fixtureEnv(), OMB_PORT: String(BENCH_PORTS[0]), OMB_UI_PORT: String(DEV_PAGE_PORT) };
  devChildren.push(spawn(process.execPath, ["--require", staged.blocker, "--experimental-strip-types", join(appRoot, "server", "dev-server.ts")], { cwd: appRoot, env, stdio: "ignore" }));
  devChildren.push(spawn(process.execPath, [join(appRoot, "node_modules", "vite", "bin", "vite.js"), "--strictPort"], { cwd: appRoot, env, stdio: "ignore" }));
  for (const url of [`http://127.0.0.1:${BENCH_PORTS[0]}/api/health`, `http://127.0.0.1:${DEV_PAGE_PORT}/`]) {
    const deadline = Date.now() + 60_000;
    while (!(await answers(url))) { if (Date.now() > deadline) throw new Error(`${url} did not answer`); await new Promise((r) => setTimeout(r, 200)); }
  }
}
const stopDevServers = () => { for (const child of devChildren) child.kill("SIGTERM"); };
const staged = stage();
if (!existsSync(join(paths.userData, "desktop-prefs.json"))) writeFileSync(join(paths.userData, "desktop-prefs.json"), JSON.stringify({ seen: [], analytics: false }));
const seeded = seed();

let logRead = 0;
function launch(name, { prime = false, screenshot = false } = {}) {
  const out = join(paths.results, `${values.label}-${name}.json`);
  rmSync(out, { force: true });
  const config = {
    root, resources: staged.resources, blocker: staged.blocker, out, timeoutMs: 60_000, quietMs: Number(values["quiet-ms"]), dev: values.dev,
    target: { rows: Math.min(10, Number(values.seed.split(",")[0])), lastMessageId: seeded.bigLastMessageId },
    ...(prime ? { prime: { storage: STORAGE, botId: seeded.bigBotId } } : {}),
    ...(screenshot ? { screenshot: join(paths.results, `${values.label}-${name}.png`) } : {}),
  };
  const env = {
    ...fixtureEnv(), OMB_BENCH_LAUNCH: JSON.stringify(config), NODE_OPTIONS: `--require ${staged.blocker}`,
    ...(values.dev ? { ELECTRON_START_URL: `http://127.0.0.1:${DEV_PAGE_PORT}` } : {}),
  };
  const args = [staged.entry, "--use-mock-keychain", "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1 , EXCLUDE localhost", `--user-data-dir=${paths.userData}`];
  return new Promise((done) => {
    const spawnedAt = Date.now();
    const child = spawn(electron, args, { env, cwd: paths.tmp, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (!existsSync(out)) { done({ failed: true, code, signal, output: output.slice(-3000) }); return; }
      const run = JSON.parse(readFileSync(out, "utf8"));
      const logFile = join(run.derived.logs, "server.log");
      const whole = existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
      const serverLog = whole.slice(logRead);
      logRead = whole.length;
      done({ ...run, spawnedAt, code, serverLog, output: output.slice(-1500) });
    });
  });
}

const round = (value) => (Number.isFinite(value) ? Math.round(value) : null);
const median = (samples) => { const sorted = samples.filter(Number.isFinite).sort((a, b) => a - b); return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null; };
function phases(run) {
  const zero = run.processStart;
  const first = (name, test = () => true) => run.marks.find((entry) => entry.name === name && test(entry))?.t;
  const local = (entry) => /^http:\/\/127\.0\.0\.1:\d+\/?(\?|#|$)/.test(entry.url ?? "");
  const mainNav = run.marks.find((entry) => entry.name === "nav-start" && local(entry));
  const windowIds = run.marks.filter((entry) => entry.name === "window-created").map((entry) => entry.id);
  const shows = run.marks.filter((entry) => entry.name === "window-show");
  const page = run.page ?? {};
  const at = (ms) => (Number.isFinite(ms) ? page.timeOrigin + ms : undefined);
  const logAt = (pattern) => { const line = run.serverLog.split("\n").find((entry) => pattern.test(entry)); const stamp = line && /^\[([^\]]+)\]/.exec(line)?.[1]; return stamp ? Date.parse(stamp) : undefined; };
  const longEnd = (page.longtasks ?? []).reduce((latest, [start, duration]) => Math.max(latest, start + duration), 0);
  const relative = {
    spawnToProcess: zero - run.spawnedAt,
    entry: first("entry"), mainImported: first("main-import:end"), ready: first("ready"),
    splashCreated: first("window-created", (entry) => entry.id === windowIds[0]), splashShown: shows[0]?.t,
    credentialsRead: first("credentials-decrypt:end"), proxyRead: first("resolveProxy:end"),
    fork: first("fork"), forkSpawned: first("fork-spawned"), serverListening: logAt(/\[out\].*openmausbot server on /),
    mainWindowCreated: first("window-created", (entry) => entry.id === windowIds[1]), pageNavStart: mainNav?.t,
    pageResponse: at(page.nav?.responseStart), domContentLoaded: at(page.nav?.dcl), rootFilled: page.seen?.root,
    mainWindowShown: shows.find((entry) => entry.id === windowIds[1])?.t, firstContentfulPaint: at(page.paints?.["first-contentful-paint"]),
    sidebarFirstRow: page.seen?.sidebarRow, sidebarRows: page.seen?.sidebarRows, sidebarPainted: page.painted?.sidebarRows,
    firstMessage: page.seen?.anyMessage, lastMessage: page.seen?.lastMessage, lastMessagePainted: page.painted?.lastMessage,
    lastLongTaskEnd: longEnd ? at(longEnd) : undefined,
  };
  const result = Object.fromEntries(Object.entries(relative).map(([name, t]) => [name, name === "spawnToProcess" ? round(t) : round(t - zero)]));
  result.mainImportMs = round(first("main-import:end") - first("main-import:start"));
  const resources = page.resources ?? [];
  const scripts = resources.filter((entry) => /\.js(\?|$)/.test(entry.url));
  const api = resources.filter((entry) => entry.url.startsWith("/api/"));
  const beforeMessages = (entry) => page.seen?.lastMessage === undefined || page.timeOrigin + entry.start <= page.seen.lastMessage;
  result.counts = {
    scripts: scripts.length, scriptKb: round(scripts.reduce((sum, entry) => sum + entry.decoded, 0) / 1024), scriptTransferKb: round(scripts.reduce((sum, entry) => sum + entry.transfer, 0) / 1024),
    apiCalls: api.length, apiBeforeMessages: api.filter(beforeMessages).length, apiKb: round(api.reduce((sum, entry) => sum + entry.decoded, 0) / 1024),
    slowestApi: api.map((entry) => ({ url: entry.url.slice(0, 60), ms: round(entry.end - entry.start), startMs: round(entry.start) })).sort((a, b) => b.ms - a.ms).slice(0, 5),
    longTasks: (page.longtasks ?? []).length, longTaskMs: round((page.longtasks ?? []).reduce((sum, [, duration]) => sum + duration, 0)),
    syncFsBeforeFork: run.syncAt?.fork ?? null, syncFsBeforeMainShown: run.syncAt?.mainShown ?? null, syncFsDuringImport: run.syncAt?.importEnd && { calls: run.syncAt.importEnd.calls - run.syncAt.importStart.calls, ms: round(run.syncAt.importEnd.ms - run.syncAt.importStart.ms) },
    spawns: run.spawns.map((entry) => `${entry.fn} ${entry.command}${entry.ms === undefined ? "" : ` (${round(entry.ms)} ms)`} @${round(entry.t - zero)}`),
    egressRefused: run.egress.length, rows: page.rows, messages: page.messages, windows: windowIds.length,
  };
  return result;
}

function wipeCaches() {
  for (const name of ["Cache", "Code Cache", "GPUCache", "DawnGraphiteCache", "DawnWebGPUCache", "server-compile-cache", "main-compile-cache", "Shared Dictionary"]) rmSync(join(paths.userData, name), { recursive: true, force: true });
}

const runs = [];
const failures = [];
if (values.dev) await startDevServers();
process.on("exit", stopDevServers);
const primedFile = join(root, values.dev ? "primed-dev" : "primed");
const primed = existsSync(primedFile);
if (!primed) {
  for (const name of ["prime-1", "prime-2"]) {
    log(`${name}: sets the page's kept choices and opens the long chat`);
    const run = await launch(name, { prime: name === "prime-1", screenshot: true });
    if (run.failed) { console.error(JSON.stringify(run, null, 1)); stopDevServers(); process.exit(1); }
    log(`${name}: rows=${run.page?.rows} messages=${run.page?.messages} steps=${JSON.stringify(run.steps)} egress=${run.egress.length}`);
  }
  writeFileSync(primedFile, new Date().toISOString());
}
const count = Number(values.runs);
if (!values.cold && count > 0) await launch("warmup");
for (let index = 0; index < count; index += 1) {
  if (values.cold) wipeCaches();
  const run = await launch(`${values.cold ? "cold" : "warm"}-${index + 1}`);
  if (run.failed || run.timedOut || !run.page?.seen?.lastMessage) { failures.push({ index, failed: run.failed ?? false, timedOut: run.timedOut ?? false, output: run.output, text: run.page?.text }); log(`run ${index + 1} did not reach the chat`); continue; }
  const measured = phases(run);
  runs.push(measured);
  log(`run ${index + 1}: ready ${measured.ready} · fork ${measured.fork} · listening ${measured.serverListening} · nav ${measured.pageNavStart} · shown ${measured.mainWindowShown} · sidebar ${measured.sidebarRows} · messages ${measured.lastMessage} · quiet ${measured.lastLongTaskEnd} (load ${loadavg()[0].toFixed(1)})`);
}
const names = runs[0] ? Object.keys(runs[0]).filter((name) => name !== "counts") : [];
const result = {
  label: values.label, app: appRoot, mode: `${values.dev ? "dev, " : ""}${values.cold ? "cold caches" : "warm"}`, runs: runs.length, failures,
  medianMs: Object.fromEntries(names.map((name) => [name, median(runs.map((run) => run[name]))])),
  minMs: Object.fromEntries(names.map((name) => [name, Math.min(...runs.map((run) => run[name]).filter(Number.isFinite))])),
  counts: runs.at(-1)?.counts ?? null, loadAverage: loadavg().map((value) => Math.round(value * 10) / 10),
  egressLog: existsSync(paths.egress) ? readFileSync(paths.egress, "utf8").split("\n").filter((line) => line.includes("blocked")).slice(-20) : [],
  perRun: runs.map(({ counts: _counts, ...rest }) => rest),
};
const text = JSON.stringify(result, null, 1);
if (values.out) writeFileSync(values.out, text);
process.stdout.write(`${text}\n`);
stopDevServers();
