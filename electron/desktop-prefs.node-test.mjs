import assert from "node:assert/strict";
import fs, { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { createDesktopPrefs, DESKTOP_NOTICES, DESKTOP_PORTS, jsonFile, registerDesktopPrefs } from "./desktop-prefs.mjs";
import { localDay } from "./cloud-trial-notice.mjs";
import { ONBOARDING_CLOUD_HINT, onboardingHints, WELCOME_VERSION } from "./onboarding-record.mjs";

const require = createRequire(import.meta.url);
const environments = require("./environments.cjs");
const localOrigin = require("./local-origin.cjs");

const POPUP = "cloud-pro-update-2026-10";
const HOUR = 3600_000, NOON = new Date(2026, 9, 16, 12).getTime();
const LOCAL = "http://127.0.0.1:18799", CLOUD = "https://omb-u-1.fly.dev", VPS = "https://bots.example.test";

test("the popup is the one notice a page can record; seen and analytics survive a restart; a broken record never stops the app", () => {
  assert.deepEqual([...DESKTOP_NOTICES], [POPUP]);
  let saved = null;
  const writes = [];
  const prefs = createDesktopPrefs({ read: () => saved, write: value => { writes.push(value); saved = structuredClone(value); }, now: () => NOON });
  assert.deepEqual(prefs.seen(), []); assert.equal(prefs.analytics(), null);
  for (const id of ["other-notice", "__proto__", "", 42]) prefs.markSeen(id);
  assert.equal(writes.length, 0, "nothing a page names outside the list is written");
  prefs.markSeen(POPUP); prefs.markSeen(POPUP);
  assert.deepEqual(prefs.seen(), [POPUP]); assert.equal(writes.length, 1);
  prefs.setAnalytics(false);
  const restarted = createDesktopPrefs({ read: () => saved, write: value => { saved = value; }, now: () => NOON });
  assert.deepEqual(restarted.seen(), [POPUP]); assert.equal(restarted.analytics(), false);
  restarted.setAnalytics("yes"); assert.equal(restarted.analytics(), false, "only true turns it on");
  restarted.setAnalytics(true); assert.equal(restarted.analytics(), true);

  const broken = createDesktopPrefs({ read: () => { throw new Error("unreadable"); }, write: () => { throw new Error("read-only disk"); }, now: () => NOON });
  assert.deepEqual(broken.seen(), []);
  broken.markSeen(POPUP); broken.setAnalytics(false);
  assert.deepEqual(broken.seen(), [POPUP], "kept for this launch when the file cannot be written");
  assert.equal(broken.analytics(), false);
  for (const record of ["nonsense", [POPUP], { seen: "all", shown: [], analytics: "off" }, { seen: [POPUP, "<b>"], shown: { [POPUP]: "today" } }]) {
    const prefs = createDesktopPrefs({ read: () => record, write: () => {}, now: () => NOON });
    assert.equal(prefs.analytics(), null, JSON.stringify(record));
    assert.ok(prefs.seen().every(id => id === POPUP), JSON.stringify(record));
    if (!prefs.seen().length) assert.equal(prefs.shown(POPUP), true, JSON.stringify(record));
  }
});

test("a write that fails leaves the last whole record on disk, analytics opt-out included", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "desktop-prefs-"));
  try {
    const file = path.join(dir, "desktop-prefs.json");
    createDesktopPrefs(jsonFile(file)).setAnalytics(false);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { seen: [], shown: {}, analytics: false });
    // As a full disk or a file-size limit does: the file is opened and emptied, then the write fails.
    const full = { ...fs, writeFileSync: target => { fs.writeFileSync(target, ""); throw Object.assign(new Error("file too large"), { code: "EFBIG" }); } };
    const launch = createDesktopPrefs({ ...jsonFile(file, full), now: () => NOON });
    assert.equal(launch.shown(POPUP), true, "kept for this launch");
    launch.markSeen(POPUP);
    assert.throws(() => jsonFile(file, full).write({ seen: [] }), /file too large/);
    assert.deepEqual(readdirSync(dir), ["desktop-prefs.json"], "no temporary file is left behind");
    const next = createDesktopPrefs(jsonFile(file));
    assert.equal(next.analytics(), false, "the opt-out survives");
    assert.deepEqual(next.seen(), []);
    assert.deepEqual(createDesktopPrefs(jsonFile(path.join(dir, "missing.json"))).seen(), [], "no file yet");
    const notepad = path.join(dir, "config.json");
    fs.writeFileSync(notepad, `\uFEFF${JSON.stringify({ onboarding: { hintsSeen: [ONBOARDING_CLOUD_HINT] } })}`);
    assert.deepEqual(onboardingHints(jsonFile(notepad).read()), [ONBOARDING_CLOUD_HINT], "a byte-order mark, as Notepad saves on Windows");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("shown counts once a day on this desktop, whichever page asks, until the popup is seen", () => {
  let now = NOON, saved = null;
  const prefs = createDesktopPrefs({ read: () => saved, write: value => { saved = structuredClone(value); }, now: () => now });
  assert.equal(prefs.shown(POPUP), true);
  assert.equal(prefs.shown(POPUP), false, "a reload the same day");
  assert.equal(createDesktopPrefs({ read: () => saved, write: () => {}, now: () => now }).shown(POPUP), false, "another page, another launch, the same day");
  assert.equal(saved.shown[POPUP], localDay(NOON));
  now += 24 * HOUR;
  assert.equal(prefs.shown(POPUP), true, "the next day, still not seen");
  prefs.markSeen(POPUP); now += 24 * HOUR;
  assert.equal(prefs.shown(POPUP), false);
  assert.equal(prefs.shown("other-notice"), false);
});

const WELCOMED = { onboarding: { completedAt: "2026-10-01T09:00:00.000Z", version: WELCOME_VERSION, hintsSeen: [] } };
function desktopMain({ offered = true, page = event => event.page, config = () => WELCOMED } = {}) {
  const handlers = new Map(), listeners = new Map(), calls = [], languages = [];
  let saved = null, now = NOON;
  registerDesktopPrefs({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), on: (channel, listener) => listeners.set(channel, listener) },
    read: () => saved, write: value => { saved = structuredClone(value); }, page,
    cloudOffered: async () => { calls.push("offered"); return offered; },
    localConfig: () => config(),
    onLanguage: code => languages.push(code),
    now: () => now,
  });
  const ask = (channel, page, ...args) => handlers.get(channel)({ page }, ...args);
  const read = page => { const event = { page }; listeners.get("desktop-analytics:read")(event); return event.returnValue; };
  return { ask, read, calls, languages, channels: [...handlers.keys()], saved: () => saved, later: ms => { now += ms; } };
}

test("every page of this desktop's window reads and records the same notices; nothing else is answered", async () => {
  const main = desktopMain();
  assert.deepEqual(main.channels, ["desktop-notices:state", "desktop-notices:seen", "desktop-notices:shown", "desktop-analytics:set", "desktop-language:set"]);
  for (const page of ["local", "cloud", "server"]) assert.deepEqual(await main.ask("desktop-notices:state", page), { seen: [], cloud: true });
  assert.equal(await main.ask("desktop-notices:shown", "server", POPUP), true);
  assert.equal(await main.ask("desktop-notices:shown", "local", POPUP), false, "once a day for the desktop, not per page");
  await main.ask("desktop-notices:seen", "server", POPUP);
  assert.deepEqual(await main.ask("desktop-notices:state", "local"), { seen: [POPUP], cloud: true });
  for (const channel of main.channels) assert.throws(() => main.ask(channel, null, POPUP), /only available in this app's window/, channel);
  assert.deepEqual((await desktopMain({ offered: false }).ask("desktop-notices:state", "server")).cloud, false);
});

test("This computer's own record counts on every page before its page loads on this build: an earlier close or the welcome's Cloud beat", async () => {
  assert.equal(ONBOARDING_CLOUD_HINT, "onboarding-cloud-v1");
  const record = (onboarding) => () => ({ composio: { apiKey: "" }, onboarding });
  for (const hint of [POPUP, ONBOARDING_CLOUD_HINT]) {
    const main = desktopMain({ config: record({ completedAt: "2026-10-01", version: 1, hintsSeen: ["tour-finished", hint] }) });
    for (const page of ["local", "cloud", "server"]) assert.deepEqual(await main.ask("desktop-notices:state", page), { seen: [POPUP], cloud: true }, `${hint} ${page}`);
    assert.equal(main.saved(), null, "read, never written into this desktop's record");
  }
  assert.deepEqual(onboardingHints({ onboarding: { completedAt: "x", version: 2, hintsSeen: ["a", 1, null, "b"] } }), ["a", "b"]);
});

test("every desktop gets the popup on whichever page its window opens, whatever This computer's welcome record says or lacks", async () => {
  // An install from before the welcome kept a record, a welcome never finished, no config.json, or one main cannot read.
  const records = [() => ({ onboarding: { completedAt: "", version: 0, hintsSeen: [] } }), () => ({ composio: {} }), () => null, () => "nonsense",
    () => { throw new Error("ENOENT"); }, () => { throw new SyntaxError("Unexpected token"); }, () => ({ onboarding: { hintsSeen: POPUP } }), () => ({ onboarding: { hintsSeen: [{ id: POPUP }] } })];
  for (const config of records) {
    for (const page of ["local", "cloud", "server"]) {
      const main = desktopMain({ config }), name = `${String(config)} ${page}`;
      assert.deepEqual(await main.ask("desktop-notices:state", page), { seen: [], cloud: true }, name);
    }
  }
});

test("the analytics switch is This computer's page's to set; a server's page in the window is told only that it is off", async () => {
  const main = desktopMain();
  for (const page of ["local", "cloud", "server", null]) assert.equal(main.read(page), null, String(page));
  await main.ask("desktop-analytics:set", "local", false);
  assert.equal(main.read("local"), false);
  assert.equal(main.read("cloud"), false, "My Cloud's page starts with analytics off");
  assert.equal(main.read("server"), false);
  assert.equal(main.read(null), null, "a page outside this desktop's window is told nothing");
  for (const page of ["cloud", "server"]) assert.throws(() => main.ask("desktop-analytics:set", page, true), /only available/);
  assert.equal(main.read("local"), false);
  await main.ask("desktop-analytics:set", "local", true);
  assert.equal(main.read("local"), true);
  assert.equal(main.read("cloud"), null, "a server's page never learns it is on");
  assert.equal(main.read("server"), null);
  const broken = desktopMain({ page: () => { throw new Error("Object has been destroyed"); } });
  assert.equal(broken.read("local"), null);
});

test("the app's language is kept as a pack's own code, survives the analytics switch and a restart, and nothing else is kept", () => {
  let saved = null;
  const file = { read: () => saved, write: value => { saved = structuredClone(value); } };
  const prefs = createDesktopPrefs(file);
  assert.equal(prefs.language(), null, "the system's until a page says");
  prefs.setLanguage("pt-BR");
  assert.equal(prefs.language(), "pt-br");
  prefs.setAnalytics(false);
  const restarted = createDesktopPrefs(file);
  assert.equal(restarted.language(), "pt-br");
  assert.equal(restarted.analytics(), false);
  for (const code of ["../en", "source-hashes", "xx", "pt-br/../../x"]) restarted.setLanguage(code);
  assert.equal(restarted.language(), "pt-br", "a code with no pack changes nothing");
  restarted.setLanguage("");
  assert.equal(restarted.language(), null, "back to the system's");
  assert.equal(saved.language, undefined);
  for (const language of ["../en", "source-hashes", 7, { code: "pt-br" }]) {
    assert.equal(createDesktopPrefs({ read: () => ({ seen: [], language }), write: () => {} }).language(), null, JSON.stringify(language));
  }
  assert.equal(createDesktopPrefs({ read: () => ({ language: "pt" }), write: () => {} }).language(), "pt-br");
});

test("only this computer's page and My Cloud's own page set the language main draws in", async () => {
  const main = desktopMain();
  assert.throws(() => main.ask("desktop-language:set", "server", "pt-br"), /only available/);
  assert.deepEqual(main.languages, []);
  await main.ask("desktop-language:set", "local", "pt-br");
  assert.equal(main.saved().language, "pt-br");
  await main.ask("desktop-language:set", "cloud", "");
  assert.equal(main.saved().language, undefined);
  await main.ask("desktop-language:set", "local", "../en");
  await main.ask("desktop-language:set", "local", 42);
  await main.ask("desktop-language:set", "local", "x".repeat(40));
  assert.deepEqual(main.languages, ["pt-br", "", ""], "main hears only what is kept");
});

const PRELOAD = readFileSync(new URL("./preload.cjs", import.meta.url), "utf8").replace(/\r\n/g, "\n");
function preload(origin, { activation = false, saved = null, home = false } = {}) {
  let bridge;
  const invoked = [], synced = [];
  vm.runInNewContext(PRELOAD, {
    process: { platform: "darwin", argv: [`--omb-local-origin=${LOCAL}`, "--omb-company-desktop=1"] },
    location: { origin }, navigator: { userActivation: { isActive: activation } }, TextEncoder, localStorage: { getItem: () => null },
    require: () => ({ webUtils: {}, contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } },
      ipcRenderer: { on() {}, removeListener() {}, send() {},
        sendSync: channel => { synced.push(channel); return channel === "desktop-analytics:read" ? saved : channel === "home:page" ? home : undefined; },
        invoke: (...args) => { invoked.push(args); return Promise.resolve(true); } } }),
  });
  return { bridge, invoked, synced };
}

test("the preload gives every page of the window the notices and the switch's state, and only This computer's page a way to set it", async () => {
  for (const origin of [CLOUD, VPS]) {
    const page = preload(origin, { saved: false });
    assert.equal(typeof page.bridge.desktopNotices.state, "function", origin);
    assert.equal(page.bridge.cloudAccount, undefined, origin);
    const asked = () => page.synced.filter(channel => channel.startsWith("desktop-"));
    assert.deepEqual(asked(), [], "nothing is asked until analytics asks");
    assert.equal(page.bridge.desktopAnalytics.enabled(), false, "turned off on this desktop");
    assert.deepEqual(asked(), ["desktop-analytics:read"]);
    assert.equal(page.bridge.desktopAnalytics.set, undefined, "a server's page cannot change the desktop's switch");
    await page.bridge.desktopNotices.state(); await page.bridge.desktopNotices.seen({ toString: () => POPUP }); await page.bridge.desktopNotices.shown(POPUP);
    assert.deepEqual(page.invoked, [["desktop-notices:state"], ["desktop-notices:seen", POPUP], ["desktop-notices:shown", POPUP]]);
    assert.deepEqual(Object.keys(page.bridge.desktopNotices), ["state", "seen", "shown"], "no page moves the window to this computer");
  }
  const local = preload(LOCAL, { activation: true, saved: false });
  assert.equal(typeof local.bridge.desktopNotices.state, "function");
  assert.deepEqual(local.synced, [], "nothing is asked until analytics asks");
  assert.equal(local.bridge.desktopAnalytics.enabled(), false, "answered at once, before anything loads");
  assert.equal(local.bridge.desktopAnalytics.enabled(), false);
  assert.deepEqual(local.synced, ["desktop-analytics:read"], "asked once a page");
  await local.bridge.desktopAnalytics.set(true);
  assert.equal(local.bridge.desktopAnalytics.enabled(), true);
  assert.deepEqual(local.invoked, [["desktop-analytics:set", true]]);
  const unsaved = preload(LOCAL);
  for (let i = 0; i < 3; i++) assert.equal(unsaved.bridge.desktopAnalytics.enabled(), null);
  assert.deepEqual(unsaved.synced, ["desktop-analytics:read"], "no choice saved yet is asked once too");
  assert.equal(preload(LOCAL, { saved: "off" }).bridge.desktopAnalytics.enabled(), null);
  const safe = PRELOAD.match(/const REMOTE_SAFE = new Set\(\[([^\]]*)\]\)/)[1];
  assert.ok(safe.includes('"desktopNotices"')); assert.ok(safe.includes('"desktopAnalytics"'));
});

test("the preload lets this computer's page and My Cloud's own page tell main the language, and no other server's page", async () => {
  assert.equal(preload(VPS).bridge.desktopLanguage, undefined);
  for (const page of [preload(LOCAL), preload(CLOUD, { home: true })]) {
    await page.bridge.desktopLanguage.set("pt-br");
    await page.bridge.desktopLanguage.set({ toString: () => "../en" });
    assert.deepEqual(page.invoked, [["desktop-language:set", "pt-br"], ["desktop-language:set", ""]]);
  }
});

test("production wiring: main answers this computer's page, My Cloud's own page and the active saved server's own page, and no other", async () => {
  const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  assert.match(main, /for \(const port of DESKTOP_PORTS\)/, "main tries the ports this module names, in order");
  assert.deepEqual([...DESKTOP_PORTS], [8799, 18799, 28799]);
  const start = main.indexOf("  registerDesktopPrefs({"), end = main.indexOf("\n", main.indexOf("page:", start));
  assert.ok(start >= 0 && end > start, "main.mjs registers the desktop prefs");
  let options = null;
  const localFrame = { url: `${LOCAL}/` }, serverFrame = { url: `${VPS}/` };
  const contents = { mainFrame: serverFrame };
  const calls = [];
  localOrigin.setLocalOrigin(LOCAL);
  let switched = async id => { calls.push(["switch", id]); }, loads = true;
  const context = vm.createContext({
    registerDesktopPrefs: value => { options = value; }, jsonFile: file => ({ read: () => file, write: () => {} }), ipcMain: {},
    desktopPrefs: { kept: true }, nativeText: { set: code => { calls.push(["language", code]); return code === "pt-br"; } }, applyNativeLanguage: () => calls.push("relabel"),
    path: { join: (...parts) => parts.join("/") }, app: { getPath: () => "/user-data" }, desktopDataDir: () => "/home/.openmausbot",
    navigateMainWindow: async url => { calls.push(["navigate", url]); return loads; },
    senderIsLocal: localOrigin.isLocalSender, workspaceSenderAllowed: environments.workspaceSenderAllowed,
    mainWindow: { webContents: contents }, environmentsState: { environments: [{ id: "vps", name: "VPS", origin: VPS }], activeId: "vps" },
    rendererOrigin: () => LOCAL, cloudAccountRestored: async () => calls.push("restored"), cloudOffersReady: async () => { calls.push("offers"); return true; },
    cloudPageAsking: event => event.verifiedCloud ? "cloud" : null,
    serverReady: true, LOCAL_ID: "local", switchEnvironment: id => switched(id),
    // main's own: a failed switch shows its dialog and resolves.
    workspaceMenuAction: async action => { try { await action(); } catch { calls.push("dialog"); } },
  });
  vm.runInContext(main.slice(start, end), context);
  assert.equal(options.prefs, context.desktopPrefs, "the record main read before the tray and the startup screen");
  assert.match(main, /const desktopPrefs = createDesktopPrefs\(jsonFile\(path\.join\(app\.getPath\("userData"\), "desktop-prefs\.json"\)\)\);/);
  assert.equal(options.localConfig(), "/home/.openmausbot/config.json", "This computer's own workspace, whichever server the window shows");
  assert.equal(options.page({ sender: { mainFrame: localFrame }, senderFrame: localFrame }), "local");
  assert.equal(options.page({ sender: contents, senderFrame: serverFrame }), "server");
  assert.equal(options.page({ sender: contents, senderFrame: serverFrame, verifiedCloud: true }), "cloud", "My Cloud's page as main verifies it");
  assert.equal(options.page({ sender: contents, senderFrame: { url: `${VPS}/` } }), null, "a frame inside the server's page");
  assert.equal(options.page({ sender: {}, senderFrame: serverFrame }), null, "another window");
  const evil = { url: "https://evil.example.test/" };
  assert.equal(options.page({ sender: { mainFrame: evil }, senderFrame: evil }), null, "a page that is not the active server");
  assert.equal(await options.cloudOffered(), true);
  assert.deepEqual(calls, ["restored", "offers"]);
  options.onLanguage("pt-br"); options.onLanguage("en");
  assert.deepEqual(calls.slice(2), [["language", "pt-br"], "relabel", ["language", "en"]], "main draws again only when the words change");
  const navigate = main.slice(main.indexOf("function navigateMainWindow(url) {"), main.indexOf("\n}\n", main.indexOf("function navigateMainWindow(url) {")) + 3);
  const load = vm.runInNewContext(`${navigate}; navigateMainWindow`, { mainWindow: { isDestroyed: () => false, loadURL: async url => { if (url.endsWith("fail")) throw new Error("ERR_CONNECTION_REFUSED"); } } });
  assert.equal(await load(`${LOCAL}/ok`), true); assert.equal(await load(`${LOCAL}/fail`), false, "a failed load answers false, never throws");
  assert.equal(await vm.runInNewContext(`${navigate}; navigateMainWindow`, { mainWindow: null })(`${LOCAL}/`), false, "no window");
});
