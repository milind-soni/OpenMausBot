// The Electron entry scripts/bench-launch.mjs stages beside a copy of electron/: it points the app at the bench's own
// temporary folders, refuses anything that would reach outside them (the network, the keychain, link and login-item
// registration, global shortcuts), stamps each launch phase on one clock, then loads the app's real main module.
import { app, globalShortcut, safeStorage, session, utilityProcess } from "electron";
import childProcess from "node:child_process";
import fs from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import path from "node:path";

const config = JSON.parse(process.env.OMB_BENCH_LAUNCH ?? "null");
if (!config) { console.error("bench-launch-entry runs only under scripts/bench-launch.mjs"); app.exit(64); await new Promise(() => {}); }
const require = createRequire(import.meta.url);
require(config.blocker);

const now = () => performance.timeOrigin + performance.now();
const marks = [];
const mark = (name, extra = {}) => { marks.push({ name, t: now(), ...extra }); };
mark("entry");
globalThis.__ombBenchMark = mark;

// Security: every folder the app derives must sit inside the bench root, checked before the app's code runs.
const real = (target) => {
  let known = path.resolve(target);
  const rest = [];
  while (!fs.existsSync(known) && path.dirname(known) !== known) { rest.unshift(path.basename(known)); known = path.dirname(known); }
  return path.join(fs.realpathSync(known), ...rest);
};
const inside = (target) => { const full = real(target); return full === config.root || full.startsWith(config.root + path.sep); };
const derived = {
  home: app.getPath("home"), appData: app.getPath("appData"), userData: app.getPath("userData"), logs: app.getPath("logs"),
  downloads: app.getPath("downloads"), dataDir: process.env.OMB_DATA_DIR ?? "", profiles: `${process.env.OMB_DATA_DIR ?? ""}-profiles`,
  envHome: process.env.HOME ?? "",
};
const outside = Object.entries(derived).filter(([, value]) => !value || !inside(value));
if (outside.length || !app.commandLine.hasSwitch("use-mock-keychain") || !app.commandLine.hasSwitch("host-resolver-rules")) {
  console.error(`bench-launch-entry: refusing to start: ${JSON.stringify({ outside, derived })}`);
  app.exit(65);
  await new Promise(() => {});
}

if (!config.dev) {
  Object.defineProperty(app, "isPackaged", { value: true, configurable: true });
  Object.defineProperty(process, "resourcesPath", { value: config.resources, configurable: true, enumerable: true });
}
const refused = {};
const refuse = (target, name, result) => { target[name] = (...args) => { refused[name] = (refused[name] ?? 0) + 1; return typeof result === "function" ? result(...args) : result; }; };
refuse(app, "setAsDefaultProtocolClient", true);
refuse(app, "setLoginItemSettings", undefined);
refuse(globalShortcut, "register", false);
refuse(globalShortcut, "registerAll", undefined);

// Synchronous file calls and child processes started on the main thread, by name.
const sync = { calls: 0, ms: 0, byName: {} };
for (const name of Object.keys(fs).filter((key) => key.endsWith("Sync") && typeof fs[key] === "function")) {
  const original = fs[name];
  fs[name] = Object.assign(function (...args) {
    const at = performance.now();
    try { return original.apply(this, args); } finally {
      const took = performance.now() - at;
      sync.calls += 1; sync.ms += took;
      const entry = (sync.byName[name] ??= { calls: 0, ms: 0 });
      entry.calls += 1; entry.ms += took;
    }
  }, original);
}
const spawns = [];
const command = (args) => [args[0], ...(Array.isArray(args[1]) ? args[1].slice(0, 2) : [])].map((part) => path.basename(String(part))).join(" ").slice(0, 120);
for (const name of ["spawn", "execFile", "exec", "fork", "spawnSync", "execFileSync", "execSync"]) {
  const original = childProcess[name];
  childProcess[name] = function (...args) {
    const at = now();
    try { return original.apply(this, args); } finally { spawns.push({ fn: name, command: command(args), t: at, ms: name.endsWith("Sync") ? now() - at : undefined }); }
  };
}
syncBuiltinESMExports();
const syncAt = {};
const snapshot = (name) => { syncAt[name] = { calls: sync.calls, ms: Math.round(sync.ms * 10) / 10 }; };

const timed = (target, name, label) => {
  const original = target[name];
  if (typeof original !== "function") return;
  target[name] = function (...args) {
    mark(`${label}:start`);
    const result = original.apply(this, args);
    Promise.resolve(result).then(() => mark(`${label}:end`), () => mark(`${label}:end`, { failed: true }));
    return result;
  };
};
timed(safeStorage, "decryptStringAsync", "credentials-decrypt");
timed(safeStorage, "encryptStringAsync", "credentials-encrypt");

const fork = utilityProcess.fork;
utilityProcess.fork = function (entry, ...rest) {
  const label = path.basename(String(entry));
  mark("fork", { entry: label }); snapshot("fork");
  const child = fork.call(this, entry, ...rest);
  child.once("spawn", () => mark("fork-spawned", { entry: label }));
  let listening = false;
  child.stdout?.on("data", (chunk) => { if (!listening && String(chunk).includes("openmausbot server on ")) { listening = true; mark("server-first-listen-line"); } });
  return child;
};

const COLLECT = (target) => `(() => {
  if (window.__ombLaunch) return;
  const L = window.__ombLaunch = { seen: {}, painted: {}, longtasks: [], paints: {} };
  const abs = () => performance.timeOrigin + performance.now();
  const checks = {
    root: () => (document.getElementById("root")?.childElementCount ?? 0) > 0,
    sidebarRow: () => Boolean(document.querySelector("[data-sidebar-bot-row]")),
    sidebarRows: () => document.querySelectorAll("[data-sidebar-bot-row]").length >= ${Number(target.rows) || 1},
    anyMessage: () => Boolean(document.querySelector("[data-mid]")),
    lastMessage: () => Boolean(document.querySelector(${JSON.stringify(`[data-mid="${target.lastMessageId ?? "-"}"]`)})),
  };
  const check = () => {
    for (const [name, test] of Object.entries(checks)) {
      if (L.seen[name] || !test()) continue;
      L.seen[name] = abs();
      requestAnimationFrame(() => requestAnimationFrame(() => { L.painted[name] = abs(); }));
    }
  };
  new MutationObserver(check).observe(document, { childList: true, subtree: true });
  check();
  try { new PerformanceObserver((list) => { for (const entry of list.getEntries()) L.longtasks.push([entry.startTime, entry.duration]); }).observe({ type: "longtask", buffered: true }); } catch {}
  try { new PerformanceObserver((list) => { for (const entry of list.getEntries()) L.paints[entry.name] = entry.startTime; }).observe({ type: "paint", buffered: true }); } catch {}
})()`;
const REPORT = `(() => {
  const L = window.__ombLaunch ?? { seen: {}, painted: {}, longtasks: [], paints: {} };
  const nav = performance.getEntriesByType("navigation")[0];
  return {
    timeOrigin: performance.timeOrigin, now: performance.now(), seen: L.seen, painted: L.painted, longtasks: L.longtasks, paints: L.paints,
    visibility: document.visibilityState, rows: document.querySelectorAll("[data-sidebar-bot-row]").length, messages: document.querySelectorAll("[data-mid]").length,
    title: document.title, text: (document.body?.innerText ?? "").slice(0, 400),
    nav: nav ? { responseStart: nav.responseStart, responseEnd: nav.responseEnd, domInteractive: nav.domInteractive, dcl: nav.domContentLoadedEventEnd, load: nav.loadEventEnd, bytes: nav.transferSize } : null,
    resources: performance.getEntriesByType("resource").map((entry) => ({ url: entry.name.replace(location.origin, ""), kind: entry.initiatorType, start: entry.startTime, end: entry.responseEnd, wait: entry.responseStart - entry.requestStart, transfer: entry.transferSize, encoded: entry.encodedBodySize, decoded: entry.decodedBodySize })),
  };
})()`;

let main = null;
let windows = 0;
const local = (url) => /^http:\/\/127\.0\.0\.1:\d+\/?(\?|#|$)/.test(url);
app.on("browser-window-created", (_event, win) => {
  const id = (windows += 1);
  mark("window-created", { id });
  win.once("ready-to-show", () => mark("window-ready-to-show", { id }));
  for (const name of ["show", "showInactive"]) {
    const original = win[name];
    win[name] = function (...args) { mark("window-show", { id }); if (win.webContents === main) snapshot("mainShown"); return original.apply(this, args); };
  }
});
app.on("web-contents-created", (_event, contents) => {
  const id = contents.id;
  mark("contents-created", { id, type: contents.getType() });
  contents.on("did-start-navigation", (details) => { if (details.isMainFrame && !details.isSameDocument) mark("nav-start", { id, url: details.url.slice(0, 48) }); });
  contents.on("dom-ready", () => {
    const url = contents.getURL();
    mark("dom-ready", { id, url: url.slice(0, 48) });
    if (!local(url) || (main && main !== contents)) return;
    main = contents;
    void contents.executeJavaScript(COLLECT(config.target ?? {})).catch(() => {});
  });
  contents.on("did-finish-load", () => mark("did-finish-load", { id }));
  contents.on("did-fail-load", (_e, code, _d, url, isMainFrame) => { if (isMainFrame) mark("did-fail-load", { id, code, url: String(url).slice(0, 48) }); });
});

const egress = [];
app.once("ready", () => {
  mark("ready"); snapshot("ready");
  for (const name of ["clearCache", "resolveProxy"]) timed(session.defaultSession, name, name);
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    let host = "";
    try { host = new URL(details.url).hostname; } catch {}
    const allowed = /^(data|blob|file|devtools|chrome|about):/.test(details.url) || host === "127.0.0.1" || host === "localhost";
    if (!allowed) egress.push({ t: now(), url: details.url.slice(0, 80) });
    callback({ cancel: !allowed });
  });
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function finish() {
  const deadline = Date.now() + (config.timeoutMs ?? 45_000);
  let page = null;
  const want = config.prime ? "root" : "lastMessage";
  while (Date.now() < deadline) {
    await sleep(250);
    if (!main || main.isDestroyed()) continue;
    page = await main.executeJavaScript(REPORT).catch(() => null);
    if (!page?.seen?.[want]) continue;
    const lastLong = page.longtasks.reduce((latest, [start, duration]) => Math.max(latest, start + duration), 0);
    if (page.now - Math.max(lastLong, page.seen[want] - page.timeOrigin) >= (config.quietMs ?? 1500)) break;
  }
  const steps = [];
  if (config.prime && main && !main.isDestroyed()) {
    steps.push(await main.executeJavaScript(`(async () => {
      for (const [key, value] of Object.entries(${JSON.stringify(config.prime.storage ?? {})})) localStorage.setItem(key, value);
      const until = async (test, ms) => { const end = performance.now() + ms; while (performance.now() < end) { if (test()) return true; await new Promise((r) => setTimeout(r, 50)); } return false; };
      const row = () => document.querySelector(${JSON.stringify(`[data-sidebar-bot-row="${config.prime.botId}"]`)});
      const hasRow = await until(() => Boolean(row()), 15000);
      if (hasRow) row().click();
      const drawn = await until(() => Boolean(document.querySelector(${JSON.stringify(`[data-mid="${config.target?.lastMessageId}"]`)})), 15000);
      return { hasRow, drawn, keys: Object.keys(localStorage) };
    })()`).catch((error) => ({ error: String(error) })));
    await sleep(2500);
    page = await main.executeJavaScript(REPORT).catch(() => page);
  }
  if (config.screenshot && main && !main.isDestroyed()) {
    try { fs.writeFileSync(config.screenshot, (await main.capturePage()).toPNG()); } catch (error) { steps.push({ screenshot: String(error) }); }
  }
  let metrics = [];
  try { metrics = app.getAppMetrics().map((entry) => ({ type: entry.type, name: entry.name ?? entry.serviceName, rssMb: Math.round((entry.memory?.workingSetSize ?? 0) / 1024) })); } catch {}
  fs.writeFileSync(config.out, JSON.stringify({
    processStart: process.getCreationTime(), marks, sync, syncAt, spawns, refused, egress, page, steps, metrics, derived,
    timedOut: Date.now() >= deadline, versions: { electron: process.versions.electron, node: process.versions.node, app: app.getVersion() },
  }));
  const hardStop = setTimeout(() => app.exit(0), 10_000);
  hardStop.unref();
  app.quit();
}
void app.whenReady().then(finish);

mark("main-import:start"); snapshot("importStart");
try {
  await import(new URL("./electron/main.mjs", import.meta.url).href);
} catch (error) {
  console.error(`bench-launch-entry: the app's main module did not load: ${error?.stack ?? error}`);
  app.exit(66);
  await new Promise(() => {});
}
mark("main-import:end"); snapshot("importEnd");
