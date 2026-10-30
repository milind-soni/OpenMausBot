import assert from "node:assert/strict";
import fs, { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { createDesktopPrefs, DESKTOP_NOTICES, DESKTOP_PORTS, jsonFile, registerDesktopPrefs } from "./desktop-prefs.mjs";
import { ONBOARDING_CLOUD_HINT, onboardingHints, WELCOME_VERSION } from "./onboarding-record.mjs";

const require = createRequire(import.meta.url);
const environments = require("./environments.cjs");
const localOrigin = require("./local-origin.cjs");

const POPUP = "whats-new-2026-11", BOAT = "boat-credit-2026-11";
const NOON = new Date(2026, 9, 16, 12).getTime();
const LOCAL = "http://127.0.0.1:18799", CLOUD = "https://omb-u-1.fly.dev", VPS = "https://bots.example.test";

test("What's new and Boat's credit offer are the notices a page can record; seen and analytics survive a restart; a broken record never stops the app", () => {
  assert.deepEqual([...DESKTOP_NOTICES], [POPUP, BOAT]);
  let saved = null;
  const writes = [];
  const prefs = createDesktopPrefs({ read: () => saved, write: value => { writes.push(value); saved = structuredClone(value); } });
  assert.deepEqual(prefs.seen(), []); assert.equal(prefs.analytics(), null);
  for (const id of ["other-notice", "__proto__", "", 42]) prefs.markSeen(id);
  assert.equal(writes.length, 0, "nothing a page names outside the list is written");
  prefs.markSeen(POPUP); prefs.markSeen(POPUP);
  assert.deepEqual(prefs.seen(), [POPUP]); assert.equal(writes.length, 1);
  prefs.markSeen(BOAT);
  assert.deepEqual(prefs.seen(), [POPUP, BOAT]); assert.equal(writes.length, 2);
  prefs.setAnalytics(false);
  const restarted = createDesktopPrefs({ read: () => saved, write: value => { saved = value; } });
  assert.deepEqual(restarted.seen(), [POPUP, BOAT]); assert.equal(restarted.analytics(), false);
  restarted.setAnalytics("yes"); assert.equal(restarted.analytics(), false, "only true turns it on");
  restarted.setAnalytics(true); assert.equal(restarted.analytics(), true);

  const broken = createDesktopPrefs({ read: () => { throw new Error("unreadable"); }, write: () => { throw new Error("read-only disk"); } });
  assert.deepEqual(broken.seen(), []);
  broken.markSeen(POPUP); broken.setAnalytics(false);
  assert.deepEqual(broken.seen(), [POPUP], "kept for this launch when the file cannot be written");
  assert.equal(broken.analytics(), false);
  for (const record of ["nonsense", [POPUP], { seen: "all", shown: [], analytics: "off" }, { seen: [POPUP, "<b>"], shown: { [POPUP]: "today" } }]) {
    const prefs = createDesktopPrefs({ read: () => record, write: () => {} });
    assert.equal(prefs.analytics(), null, JSON.stringify(record));
    assert.ok(prefs.seen().every(id => id === POPUP), JSON.stringify(record));
  }
});

test("a write that fails leaves the last whole record on disk, analytics opt-out included", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "desktop-prefs-"));
  try {
    const file = path.join(dir, "desktop-prefs.json");
    createDesktopPrefs(jsonFile(file)).setAnalytics(false);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { seen: [], analytics: false });
    // As a full disk or a file-size limit does: the file is opened and emptied, then the write fails.
    const full = { ...fs, writeFileSync: target => { fs.writeFileSync(target, ""); throw Object.assign(new Error("file too large"), { code: "EFBIG" }); } };
    const launch = createDesktopPrefs({ ...jsonFile(file, full) });
    launch.markSeen(POPUP);
    assert.deepEqual(launch.seen(), [POPUP], "kept for this launch");
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

const WELCOMED = { onboarding: { completedAt: "2026-10-01T09:00:00.000Z", version: WELCOME_VERSION, hintsSeen: [] } };
function desktopMain({ offered = true, page = event => event.page, config = () => WELCOMED, record = null } = {}) {
  const handlers = new Map(), listeners = new Map(), calls = [], told = [];
  let saved = record, now = NOON;
  registerDesktopPrefs({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), on: (channel, listener) => listeners.set(channel, listener) },
    read: () => saved, write: value => { saved = structuredClone(value); }, page,
    cloudOffered: async () => { calls.push("offered"); return offered; },
    localConfig: () => config(),
    languageChanged: (language, sender) => told.push([language, sender]),
    now: () => now,
    systemName: async () => "Ada Lovelace",
  });
  const ask = (channel, page, ...args) => handlers.get(channel)({ page, sender: `${page}-page` }, ...args);
  const answer = channel => page => { const event = { page }; listeners.get(channel)(event); return event.returnValue; };
  return { ask, read: answer("desktop-analytics:read"), language: answer("desktop-language:read"), told, calls, channels: [...handlers.keys()], saved: () => saved, later: ms => { now += ms; } };
}

test("every page of this desktop's window reads and records the same notices; nothing else is answered", async () => {
  const main = desktopMain();
  assert.deepEqual(main.channels, ["desktop-notices:state", "desktop-notices:seen", "desktop-profile:system-name", "desktop-analytics:set", "desktop-language:set"]);
  for (const page of ["local", "cloud", "server"]) assert.deepEqual(await main.ask("desktop-notices:state", page), { seen: [], cloud: true });
  await main.ask("desktop-notices:seen", "server", POPUP);
  assert.deepEqual(await main.ask("desktop-notices:state", "local"), { seen: [POPUP], cloud: true });
  for (const channel of main.channels) assert.throws(() => main.ask(channel, null, POPUP), /only available in this app's window/, channel);
  assert.deepEqual((await desktopMain({ offered: false }).ask("desktop-notices:state", "server")).cloud, false);
});

test("a first run's default name for the profile goes to this computer's own page only", async () => {
  const main = desktopMain();
  assert.equal(await main.ask("desktop-profile:system-name", "local"), "Ada Lovelace");
  for (const page of ["cloud", "server"]) assert.throws(() => main.ask("desktop-profile:system-name", page), /only available in this app's window/, page);
});

test("This computer's own record counts on every page before its page loads on this build: an earlier close; the welcome's Cloud beat does not", async () => {
  assert.equal(ONBOARDING_CLOUD_HINT, "onboarding-cloud-v1");
  const record = (onboarding) => () => ({ composio: { apiKey: "" }, onboarding });
  for (const [hint, seen] of [[POPUP, [POPUP]], [ONBOARDING_CLOUD_HINT, []]]) {
    const main = desktopMain({ config: record({ completedAt: "2026-10-01", version: 1, hintsSeen: ["tour-finished", hint] }) });
    for (const page of ["local", "cloud", "server"]) assert.deepEqual(await main.ask("desktop-notices:state", page), { seen, cloud: true }, `${hint} ${page}`);
    assert.equal(main.saved(), null, "read, never written into this desktop's record");
  }
  assert.deepEqual(onboardingHints({ onboarding: { completedAt: "x", version: 2, hintsSeen: ["a", 1, null, "b"] } }), ["a", "b"]);
});

test("every desktop has What's new still to show, whatever This computer's welcome record says or lacks", async () => {
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

test("the app language picked on any page of the window is the one every page reads, and it outlives a restart", async () => {
  const main = desktopMain();
  for (const page of ["local", "cloud", "server", null]) assert.equal(main.language(page), null, `System until a pick: ${page}`);
  assert.equal(await main.ask("desktop-language:set", "local", "en"), true);
  for (const page of ["local", "cloud", "server"]) assert.equal(main.language(page), "en", page);
  assert.deepEqual(main.told, [["en", "local-page"]], "the other pages hear it");
  assert.equal(await main.ask("desktop-language:set", "server", "de"), true, "a team's or a saved server's page picks for this computer too");
  assert.equal(await main.ask("desktop-language:set", "cloud", "de"), true);
  assert.equal(main.language("local"), "de");
  assert.deepEqual(main.told, [["en", "local-page"], ["de", "server-page"]], "told once per change");
  assert.equal(await main.ask("desktop-language:set", "cloud", ""), true, "System is a pick too");
  assert.equal(main.language("server"), "");
  assert.equal(main.language(null), null, "a page outside this desktop's window is told nothing");
  for (const bad of ["../../etc", "<b>", "x".repeat(40), 42, null, undefined, { toString: () => "en" }]) {
    assert.equal(await main.ask("desktop-language:set", "local", bad), false, String(bad));
  }
  assert.throws(() => main.ask("desktop-language:set", null, "en"), /only available in this app's window/);
  assert.equal(main.language("local"), "");
  assert.equal(main.told.length, 3);

  const restarted = desktopMain({ record: main.saved() });
  assert.equal(restarted.language("cloud"), "");
  await restarted.ask("desktop-language:set", "local", "pt-br");
  assert.equal(desktopMain({ record: restarted.saved() }).language("server"), "pt-br");
  for (const record of [{ language: "<script>" }, { language: 7 }, { language: "x".repeat(40) }]) {
    assert.equal(createDesktopPrefs({ read: () => record, write: () => {} }).language(), null, JSON.stringify(record));
  }
  const broken = desktopMain({ page: () => { throw new Error("Object has been destroyed"); } });
  assert.equal(broken.language("local"), null);
});

const PRELOAD = readFileSync(new URL("./preload.cjs", import.meta.url), "utf8").replace(/\r\n/g, "\n");
function preload(origin, { activation = false, saved = null, language = null } = {}) {
  let bridge;
  const invoked = [], synced = [], heard = new Map();
  vm.runInNewContext(PRELOAD, {
    process: { platform: "darwin", argv: [`--omb-local-origin=${LOCAL}`, "--omb-company-desktop=1"] },
    location: { origin }, navigator: { userActivation: { isActive: activation } }, TextEncoder, localStorage: { getItem: () => null },
    require: () => ({ webUtils: {}, contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } },
      ipcRenderer: { on(channel, handler) { heard.set(channel, handler); }, removeListener() {}, send() {},
        sendSync: channel => { synced.push(channel); return channel === "desktop-analytics:read" ? saved : channel === "desktop-language:read" ? language : undefined; },
        invoke: (...args) => { invoked.push(args); return Promise.resolve(true); } } }),
  });
  return { bridge, invoked, synced, tell: (channel, ...args) => heard.get(channel)({}, ...args) };
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
    await page.bridge.desktopNotices.state(); await page.bridge.desktopNotices.seen({ toString: () => POPUP });
    assert.deepEqual(page.invoked, [["desktop-notices:state"], ["desktop-notices:seen", POPUP]]);
    assert.deepEqual(Object.keys(page.bridge.desktopNotices), ["state", "seen"], "no page moves the window to this computer");
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

test("the preload gives every page of the window the app language this computer keeps", async () => {
  for (const origin of [LOCAL, CLOUD, VPS]) {
    const page = preload(origin, { language: "de" });
    assert.deepEqual(Object.keys(page.bridge.desktopLanguage), ["choice", "set", "onChange"], origin);
    const asked = () => page.synced.filter(channel => channel.startsWith("desktop-"));
    assert.deepEqual(asked(), [], "nothing is asked until the language is");
    assert.equal(page.bridge.desktopLanguage.choice(), "de", origin);
    assert.equal(page.bridge.desktopLanguage.choice(), "de");
    assert.deepEqual(asked(), ["desktop-language:read"], "asked once a page");
    await page.bridge.desktopLanguage.set("en");
    assert.equal(page.bridge.desktopLanguage.choice(), "en", "answered at once, before main replies");
    assert.deepEqual(page.invoked, [["desktop-language:set", "en"]]);
    const heard = [];
    const stop = page.bridge.desktopLanguage.onChange(language => heard.push(language));
    page.tell("desktop-language:changed", "ja");
    page.tell("desktop-language:changed", 42);
    assert.equal(page.bridge.desktopLanguage.choice(), "ja", "a pick made on another page");
    assert.deepEqual(heard, ["ja"]);
    stop();
    page.tell("desktop-language:changed", "fr");
    assert.deepEqual(heard, ["ja"]);
    assert.equal(page.bridge.desktopLanguage.choice(), "fr");
  }
  assert.equal(preload(VPS, { language: 7 }).bridge.desktopLanguage.choice(), null);
  const safe = PRELOAD.match(/const REMOTE_SAFE = new Set\(\[([^\]]*)\]\)/)[1];
  assert.ok(safe.includes('"desktopLanguage"'));
});

test("production wiring: main answers this computer's page, My Cloud's own page and the active saved server's own page, and no other", async () => {
  const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  assert.match(main, /for \(const port of DESKTOP_PORTS\)/, "main tries the ports this module names, in order");
  assert.deepEqual([...DESKTOP_PORTS], [8799, 18799, 28799]);
  const start = main.indexOf("  desktopPrefs = createDesktopPrefs("), end = main.indexOf("\n", main.indexOf("page:", start));
  assert.ok(start >= 0 && end > start, "main.mjs registers the desktop prefs");
  let options = null;
  const localFrame = { url: `${LOCAL}/` }, serverFrame = { url: `${VPS}/` };
  const contents = { mainFrame: serverFrame };
  const calls = [];
  localOrigin.setLocalOrigin(LOCAL);
  const sent = [], window = name => ({ isDestroyed: () => name === "closed", webContents: { send: (...message) => sent.push([name, ...message]) } });
  const windows = [window("team"), window("home"), window("closed")];
  let switched = async id => { calls.push(["switch", id]); }, loads = true;
  const context = vm.createContext({
    registerDesktopPrefs: value => { options = value; }, createDesktopPrefs: store => ({ store }), jsonFile: file => ({ read: () => file, write: () => {} }), ipcMain: {}, updatesConsent: null, cloudAccount: "the client",
    path: { join: (...parts) => parts.join("/") }, app: { getPath: () => "/user-data" }, desktopDataDir: () => "/home/.openmausbot",
    navigateMainWindow: async url => { calls.push(["navigate", url]); return loads; },
    senderIsLocal: localOrigin.isLocalSender, workspaceSenderAllowed: environments.workspaceSenderAllowed,
    mainWindow: { webContents: contents }, environmentsState: { environments: [{ id: "vps", name: "VPS", origin: VPS }], activeId: "vps" },
    appWindows: () => windows, BrowserWindow: { getAllWindows: () => windows }, chromeRail: { send: (...told) => sent.push(["rail", ...told]) },
    rendererOrigin: () => LOCAL, cloudAccountRestored: async () => calls.push("restored"), cloudOffersReady: async () => { calls.push("offers"); return true; },
    cloudPageAsking: event => event.verifiedCloud ? "cloud" : null,
    serverReady: true, LOCAL_ID: "local", switchEnvironment: id => switched(id),
    // main's own: a failed switch shows its dialog and resolves.
    workspaceMenuAction: async action => { try { await action(); } catch { calls.push("dialog"); } },
  });
  vm.runInContext(main.slice(start, end), context);
  assert.equal(options.prefs.store.read(), "/user-data/desktop-prefs.json");
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
  options.languageChanged("en", windows[0].webContents);
  assert.deepEqual(sent, [["home", "desktop-language:changed", "en"], ["rail", "desktop-language:changed", "en"]], "every other open window hears the pick, and the window's rail");
  const navigate = main.slice(main.indexOf("function navigateMainWindow(url) {"), main.indexOf("\n}\n", main.indexOf("function navigateMainWindow(url) {")) + 3);
  const load = vm.runInNewContext(`${navigate}; navigateMainWindow`, { mainWindow: { isDestroyed: () => false, loadURL: async url => { if (url.endsWith("fail")) throw new Error("ERR_CONNECTION_REFUSED"); } } });
  assert.equal(await load(`${LOCAL}/ok`), true); assert.equal(await load(`${LOCAL}/fail`), false, "a failed load answers false, never throws");
  assert.equal(await vm.runInNewContext(`${navigate}; navigateMainWindow`, { mainWindow: null })(`${LOCAL}/`), false, "no window");
});

test("the window's rail of places is shown until the person hides it, and the choice survives a restart", () => {
  let saved = null, writes = 0;
  const prefs = createDesktopPrefs({ read: () => saved, write: value => { saved = structuredClone(value); writes++; } });
  assert.equal(prefs.railHidden(), false);
  prefs.setRailHidden(false);
  assert.equal(writes, 0, "showing a rail that shows writes nothing");
  prefs.setRailHidden(true);
  assert.equal(createDesktopPrefs({ read: () => saved, write: () => {} }).railHidden(), true);
  prefs.setRailHidden("no");
  assert.equal(createDesktopPrefs({ read: () => saved, write: () => {} }).railHidden(), false, "only true hides it");
  assert.equal(createDesktopPrefs({ read: () => ({ railHidden: "yes" }), write: () => {} }).railHidden(), false);
});

test("the talk shortcut is on with ⌃⌥Space until changed, and the choice survives a restart", () => {
  let saved = null;
  const prefs = createDesktopPrefs({ read: () => saved, write: value => { saved = structuredClone(value); } });
  assert.equal(prefs.talkShortcut(), true);
  assert.equal(prefs.talkKey(), "ctrl-opt-space");
  prefs.setTalkShortcut(false);
  assert.equal(prefs.setTalkKey("opt-shift-space"), true);
  for (const key of ["cmd-space", "__proto__", "toString", 7]) assert.equal(prefs.setTalkKey(key), false);
  const restarted = createDesktopPrefs({ read: () => saved, write: () => {} });
  assert.equal(restarted.talkShortcut(), false);
  assert.equal(restarted.talkKey(), "opt-shift-space");
  const junk = createDesktopPrefs({ read: () => ({ talkShortcut: "off", talkKey: "toString" }), write: () => {} });
  assert.equal(junk.talkShortcut(), true);
  assert.equal(junk.talkKey(), "ctrl-opt-space");
});

test("each server keeps its own Quick asks chat; nothing malformed is read back", () => {
  let saved = null;
  const prefs = createDesktopPrefs({ read: () => saved, write: value => { saved = structuredClone(value); } });
  prefs.setQuickAsksChat("/Users/a/.openmausbot", { botId: "bot-1", threadId: "t-1" });
  assert.deepEqual(createDesktopPrefs({ read: () => saved, write: () => {} }).quickAsksChat("/Users/a/.openmausbot"), { botId: "bot-1", threadId: "t-1" });
  assert.equal(prefs.quickAsksChat("/Users/a/.openmausbot-aprs"), null);
  const broken = createDesktopPrefs({ read: () => ({ quickAsks: { a: { botId: "../x", threadId: "t" }, b: "t-1", c: { botId: "b", threadId: "t", extra: 1 } } }), write: () => {} });
  assert.equal(broken.quickAsksChat("a"), null);
  assert.equal(broken.quickAsksChat("b"), null);
  assert.deepEqual(broken.quickAsksChat("c"), { botId: "b", threadId: "t" });
});

test("registerDesktopPrefs works on the store main hands it", async () => {
  const prefs = createDesktopPrefs({ read: () => null, write: () => {} });
  const handlers = new Map();
  registerDesktopPrefs({ prefs, ipcMain: { handle: (c, h) => handlers.set(c, h), on: () => {} }, read: () => null, write: () => {},
    page: () => "local", cloudOffered: async () => false });
  await handlers.get("desktop-analytics:set")({}, false);
  assert.equal(prefs.analytics(), false);
});
