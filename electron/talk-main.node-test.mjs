import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createDesktopPrefs } from "./desktop-prefs.mjs";
import { installTalk, isTalkPanel } from "./talk-main.mjs";
import { TALK_SHORTCUT_UNAVAILABLE } from "./talk-shortcut.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const main = readFileSync(join(here, "main.mjs"), "utf8").replace(/\r\n/g, "\n");
const preload = readFileSync(join(here, "preload.cjs"), "utf8");
const settle = async () => { for (let i = 0; i < 10; i += 1) await new Promise(resolve => setImmediate(resolve)); };
const json = body => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
const names = windows => windows.map(win => win?.name ?? null);

function harness({ packaged = true, appleSpeech = true, remote = false, register, serve = () => undefined } = {}) {
  const h = { handlers: new Map(), guards: new Map(), started: [], stopped: [], finished: [], requests: [], links: [], reveals: 0, log: [],
    registered: new Map(), windows: [], busy: false, fail: {}, away: false, starting: false };
  const owners = new Map();
  class FakeBrowserWindow {
    static fromWebContents(contents) { return owners.get(contents) ?? null; }
    constructor(options = {}) {
      Object.assign(this, { options, name: options.name, destroyed: false, events: new EventEmitter() });
      this.webContents = Object.assign(new EventEmitter(), { sent: [], scripts: [], setWindowOpenHandler() {} });
      this.webContents.executeJavaScript = async script => { this.webContents.scripts.push(script); return 56; };
      this.webContents.send = (...message) => { this.webContents.sent.push(message); };
      owners.set(this.webContents, this);
      h.windows.push(this);
    }
    on(...args) { this.events.on(...args); }
    setAlwaysOnTop() {}
    setVisibleOnAllWorkspaces() {}
    setBounds() {}
    getBounds() { return { x: 0, y: 0, width: 0, height: 0 }; }
    showInactive() {}
    loadURL() { return Promise.resolve(); }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; }
  }
  const failing = (name, run) => (...args) => {
    if (h.fail[name]) throw new Error(h.fail[name]);
    return run(...args);
  };
  const answer = route => serve(route) ?? new Promise(() => {});
  const guard = kind => (channel, handler) => { h.guards.set(channel, kind); return handler; };
  h.talk = installTalk({
    ipcMain: { handle: (channel, handler) => h.handlers.set(channel, handler) },
    localOnly: guard("localOnly"), localOrHome: guard("localOrHome"), BrowserWindow: FakeBrowserWindow, appleSpeech,
    speech: {
      start: (target, options) => { h.started.push([target, options]); },
      stop: failing("stop", owner => { h.stopped.push(owner); }),
      finish: owner => { h.finished.push(owner); },
      busy: failing("busy", () => h.busy),
    },
    packaged, devUrl: "http://127.0.0.1:5199", iconPath: join(here, "resources", "app-icon.png"),
    nativeImage: { createFromPath: () => ({ isEmpty: () => false, resize: () => ({ toPNG: () => Buffer.from("png") }) }) },
    openLink: link => { h.links.push(link); }, reveal: failing("reveal", () => { h.reveals += 1; }), log: line => { h.log.push(line); },
    fetch: url => { h.requests.push(["dev", String(url)]); return answer(`${url.pathname}${url.search}`); },
  });
  const globalShortcut = {
    register: register ?? ((accelerator, press) => { h.registered.set(accelerator, press); return true; }),
    unregister: accelerator => { h.registered.delete(accelerator); },
  };
  const screen = { getCursorScreenPoint: () => ({ x: 0, y: 0 }), getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 25, width: 1440, height: 875 } }) };
  h.start = () => h.talk.start({ globalShortcut, screen, prefs: createDesktopPrefs({ read: () => null, write: () => {} }), remote: () => remote,
    away: failing("away", () => h.away), starting: () => h.starting,
    localRequest: route => { h.requests.push(["local", route]); return answer(route); }, dataDir: () => "/Users/a/.openmausbot" });
  h.handle = (channel, event, ...args) => h.handlers.get(channel)(event, ...args);
  h.press = () => h.registered.get("Control+Alt+Space")();
  h.page = name => new FakeBrowserWindow({ name });
  h.box = () => h.windows.findLast(win => isTalkPanel(win));
  h.click = what => h.box().webContents.emit("ipc-message", {}, `talk-panel:${what}`);
  h.painted = async () => { h.box().webContents.emit("did-finish-load"); await settle(); return h.box().webContents.scripts.filter(script => script.startsWith("render(")).map(script => JSON.parse(script.slice(7, -1))); };
  return h;
}

test("every list of the app's windows leaves the talk box out", () => {
  assert.equal(main.match(/BrowserWindow\.getAllWindows\(\)/g).length, 1);
  assert.match(main, /function appWindows\(\) \{\s*return BrowserWindow\.getAllWindows\(\)\.filter\(\(win\) => !isTalkPanel\(win\)\);/);
  assert.match(main, /if \(appWindows\(\)\.length === 0\) openWindowForLink\(\);/);
  assert.match(main, /allWindows: \(\) => appWindows\(\)/);
});

test("main hands the talk wiring its speech sinks, this computer's own server and window, and closes it first on quit", () => {
  assert.match(main, /const talk = installTalk\(\{ ipcMain, localOnly, localOrHome, BrowserWindow, appleSpeech: nativeActions\.appleSpeech,\s*speech: \{ start: startSpeech, stop: stopSpeech, finish: finishSpeech, busy: speechBusy \},/);
  assert.match(main, /packaged: app\.isPackaged, devUrl: DEV_URL, nativeImage, iconPath: APP_ICON, openLink: queueChatLink, reveal: revealForLink, log: slog \}\);/);
  assert.match(main, /talk\.start\(\{ globalShortcut, screen, prefs: desktopPrefs, remote: \(\) => Boolean\(desktopRemoteAccess\), away: \(\) => homeWindow\.current\(\)\.kind !== "computer", starting: \(\) => !serverReady, localRequest: localServerRequest, dataDir: \(\) => runningDataDir \}\);/);
  assert.match(main, /app\.on\("before-quit", \(e\) => \{\s*talk\.close\(\);/);
  assert.doesNotMatch(main, /ipcMain\.handle\("(?:speech|talk-shortcut|call):/);
});

test("main tells the talk wiring when home changes and which skin the app painted, and counts a talk ask as busy for a quiet update", () => {
  assert.match(main, /const homeWindow = createHomeWindow\(\{[^]*?rehomed: \(\) => talk\.homeChanged\(\),[^]*?\}\);\ninstallHomeWindowIpc/);
  assert.match(main, /ipcMain\.handle\("desktop:skin", \(event, skin\) => \{\s*if \(!isKnownSkin\(skin\)\) return false;\s*if \(chromeRail\.owns\(event\)\) return true;\s*try \{\s*talk\.skin\(skin\);/);
  assert.match(main, /busy: \(\) => \(oneHome\.oneHome\.busy\(\) && "move"\) \|\| \(computerSharing\?\.busy\(\) && "lending"\) \|\| \(talk\.busy\(\) && "talk"\) \|\|/);
});

test("the talk bridge keys stay off other servers' pages; a call can be reported from My Cloud's page", () => {
  const list = name => preload.match(new RegExp(`const ${name} = (?:new Set\\()?\\[([^\\]]*)\\]`))[1];
  assert.doesNotMatch(list("REMOTE_SAFE"), /talkShortcut|callActive/);
  assert.match(list("HOME_PAGE"), /"callActive"/);
  assert.doesNotMatch(list("HOME_PAGE"), /talkShortcut/);
});

test("every microphone channel answers only this computer's page; a call can be reported from My Cloud's page too", () => {
  const { guards, handlers } = harness();
  assert.deepEqual(Object.fromEntries(guards), {
    "speech:start": "localOnly", "speech:stop": "localOnly", "speech:finish": "localOnly",
    "talk-shortcut:state": "localOnly", "talk-shortcut:set": "localOnly", "call:active": "localOrHome",
  });
  assert.deepEqual([...handlers.keys()], [...guards.keys()]);
});

test("a page's speech stop and finish name that page's own window, so they touch only the session it started", () => {
  const h = harness();
  const page = h.page("page"), other = h.page("other");
  h.handle("speech:start", { sender: page.webContents }, { endpointMs: 900 });
  h.handle("speech:start", { sender: {} });
  h.handle("speech:stop", { sender: other.webContents });
  h.handle("speech:finish", { sender: page.webContents });
  h.handle("speech:stop", { sender: page.webContents });
  h.handle("speech:stop", { sender: {} });
  assert.deepEqual(h.started.map(([win, options]) => [win.name, options]), [["page", { endpointMs: 900 }]]);
  assert.deepEqual(names(h.stopped), ["other", "page", null]);
  assert.deepEqual(names(h.finished), ["page"]);

  const elsewhere = harness({ appleSpeech: false });
  const win = elsewhere.page("page");
  elsewhere.handle("speech:start", { sender: win.webContents });
  elsewhere.handle("speech:stop", { sender: win.webContents });
  elsewhere.handle("speech:finish", { sender: win.webContents });
  assert.deepEqual(win.webContents.sent, [["speech:end", { code: 2, reason: "unsupported-platform" }]]);
  assert.deepEqual([elsewhere.started, elsewhere.stopped, elsewhere.finished], [[], [], []]);
});

test("the shortcut is offered only with Apple speech, on a desktop that is not a remote client of another computer", () => {
  for (const options of [{ appleSpeech: false }, { remote: true }]) {
    const h = harness(options);
    h.start();
    assert.equal(h.handle("talk-shortcut:state", {}).available, false);
    assert.deepEqual([...h.registered.keys()], []);
  }
  const h = harness();
  h.start();
  assert.equal(h.handle("talk-shortcut:state", {}).available, true);
  assert.deepEqual([...h.registered.keys()], ["Control+Alt+Space"]);
});

test("before the shortcut is set up its setting says unavailable; afterwards a change passes on only what it understands", () => {
  const h = harness();
  assert.equal(h.handle("talk-shortcut:state", {}), TALK_SHORTCUT_UNAVAILABLE);
  assert.equal(h.handle("talk-shortcut:set", {}, { enabled: false }), TALK_SHORTCUT_UNAVAILABLE);
  h.start();
  const shown = state => ({ enabled: state.enabled, key: state.key, taken: state.taken });
  assert.deepEqual(shown(h.handle("talk-shortcut:set", {}, { enabled: "no", key: 7, extra: 1 })), { enabled: true, key: "ctrl-opt-space", taken: false });
  assert.deepEqual(shown(h.handle("talk-shortcut:set", {}, { enabled: false })), { enabled: false, key: "ctrl-opt-space", taken: false });
  assert.deepEqual([...h.registered.keys()], []);
  h.handle("talk-shortcut:set", {}, { enabled: true, key: "ctrl-shift-space" });
  assert.deepEqual([...h.registered.keys()], ["Control+Shift+Space"]);
  h.talk.close();
  assert.deepEqual([...h.registered.keys()], [], "quitting lets the key go");
});

test("a press listens until the key's modifiers are let go, and asks this computer's own server; in development, the dev server's proxy", () => {
  const built = harness();
  built.start();
  built.press();
  assert.equal(typeof built.started[0][0].transcript, "function", "the box's own speech sink, not a window");
  assert.deepEqual(built.started.map(([, options]) => options), [{ finishOnRelease: ["control", "option"] }]);
  assert.deepEqual(built.requests, [["local", "/api/bots?messages=0"]]);
  built.talk.close();

  const dev = harness({ packaged: false });
  dev.start();
  dev.press();
  assert.deepEqual(dev.requests, [["dev", "http://127.0.0.1:5199/api/bots?messages=0"]]);
  dev.talk.close();
});

test("a call or composer dictation holding the microphone keeps a press from listening", () => {
  const h = harness();
  h.start();
  const page = new EventEmitter();
  h.handle("call:active", { sender: page }, true);
  h.press();
  assert.equal(h.started.length, 0);
  h.handle("call:active", { sender: page }, "yes");
  h.press();
  assert.equal(h.started.length, 1);
  h.talk.close();

  const dictating = harness();
  dictating.busy = true;
  dictating.start();
  dictating.press();
  assert.equal(dictating.started.length, 0);
  dictating.talk.close();
});

test("a talk shortcut that cannot be set up is logged, says unavailable, and startup goes on", () => {
  const h = harness({ register: () => { throw new Error("no hotkeys"); } });
  assert.doesNotThrow(() => h.start());
  assert.deepEqual(h.log, ["talk shortcut unavailable: no hotkeys"]);
  assert.equal(h.handle("talk-shortcut:state", {}), TALK_SHORTCUT_UNAVAILABLE);
  assert.doesNotThrow(() => h.talk.close());
});

test("a press, an open or a dismiss that throws is logged, never thrown at Electron", () => {
  const h = harness();
  h.start();
  h.fail.busy = "busy broke";
  h.press();
  h.fail.busy = null;
  h.press();
  h.fail.reveal = "reveal broke";
  h.click("open");
  h.fail.reveal = null;
  h.press();
  h.fail.stop = "stop broke";
  h.click("dismiss");
  h.fail.stop = null;
  assert.deepEqual(h.log, ["talk press failed: busy broke", "talk open failed: reveal broke", "talk dismiss failed: stop broke"]);
  h.talk.close();
});

test("clicking the box opens its chat by a link with both ids escaped, or else just shows MausBot", async () => {
  const h = harness({ serve: route => {
    if (route === "/api/bots?messages=0") return json({ bots: [{ id: "b?1&x", defaultBot: {}, tasks: [] }] });
    if (route === "/api/bots/b%3F1%26x/tasks") return json({ task: { threadId: "t 1/x" } });
    return undefined;
  } });
  h.start();
  h.press();
  h.click("open");
  assert.equal(h.reveals, 1);
  assert.deepEqual(h.links, []);
  h.press();
  await settle();
  const [sink] = h.started.at(-1);
  sink.transcript({ text: "what's on today" });
  sink.end({ code: 0, reason: "completed" });
  h.click("open");
  assert.deepEqual(h.links, ["openmausbot://thread/t%201%2Fx?bot=b%3F1%26x"]);
  h.talk.close();
});

test("while home is My Cloud or this computer's copy is frozen the shortcut is unavailable and the key free; home here again takes it back", () => {
  const h = harness();
  h.away = true;
  h.start();
  assert.equal(h.handle("talk-shortcut:state", {}).available, false);
  assert.deepEqual([...h.registered.keys()], []);
  assert.equal(h.handle("talk-shortcut:set", {}, { enabled: false }).available, false, "a change does nothing meanwhile");
  h.away = false;
  h.talk.homeChanged();
  assert.equal(h.handle("talk-shortcut:state", {}).available, true);
  assert.deepEqual([...h.registered.keys()], ["Control+Alt+Space"]);
  h.away = true;
  h.talk.homeChanged();
  assert.deepEqual([...h.registered.keys()], []);
  h.fail.away = "home unknown";
  assert.doesNotThrow(() => h.talk.homeChanged());
  assert.deepEqual(h.log, ["talk home change failed: home unknown"]);
  const early = harness();
  assert.doesNotThrow(() => early.talk.homeChanged(), "before start");
  h.talk.close();
});

test("a press while this computer's server is still starting says so", async () => {
  const h = harness({ serve: route => (route === "/api/bots?messages=0" ? Promise.reject(new Error("not running")) : undefined) });
  h.starting = true;
  h.start();
  h.press();
  await settle();
  assert.deepEqual((await h.painted()).at(-1), { state: "error", text: "MausBot is still starting. Try again in a moment." });
  h.talk.close();
});

test("the box takes the light or dark of the skin the app painted last, before or after it opens", async () => {
  const h = harness();
  h.talk.skin("meadow");
  h.start();
  h.press();
  assert.deepEqual((await h.painted()).at(-1), { state: "listening", text: "", theme: "light" });
  h.talk.skin("midnight");
  await settle();
  assert.deepEqual((await h.painted()).at(-1), { state: "listening", text: "", theme: "dark" });
  h.talk.skin("no-such-skin");
  h.talk.skin(undefined);
  await settle();
  assert.equal((await h.painted()).at(-1).theme, "dark");
  h.talk.close();
});

test("busy while a talk ask is under way, never before the shortcut is set up", () => {
  const h = harness();
  assert.equal(h.talk.busy(), false);
  h.start();
  assert.equal(h.talk.busy(), false);
  h.press();
  assert.equal(h.talk.busy(), true);
  h.click("dismiss");
  assert.equal(h.talk.busy(), false);
  h.talk.close();
});

test("quitting while listening logs a failure to stop speech and still lets the key go", () => {
  const h = harness();
  h.start();
  h.press();
  h.fail.stop = "stop broke";
  assert.doesNotThrow(() => h.talk.close());
  assert.deepEqual(h.log, ["talk close failed: stop broke"]);
  assert.deepEqual([...h.registered.keys()], []);
});
