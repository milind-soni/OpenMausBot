import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { chatLinkFrom } from "./chat-link.mjs";
import {
  APP_WINDOW_MIN, APP_WINDOW_SIZE, appIdFrom, appWindowSize, appWindowUrl, createAppWindowSizes, installLocalAppWindows, isLocalAppWindow,
} from "./local-app-windows.mjs";

const ID = "la_AbCdEfGhIjKlMnOp";
const OTHER = "la_0000000000000000";

test("an app's own page is on the asking server, for a well-formed id only", () => {
  assert.equal(appWindowUrl("http://127.0.0.1:8799", ID), `http://127.0.0.1:8799/local-app?id=${ID}`);
  assert.equal(appWindowUrl("https://ada.mausbot.cloud", ID), `https://ada.mausbot.cloud/local-app?id=${ID}`);
  for (const [origin, id] of [["http://127.0.0.1:8799", "la_short"], ["http://127.0.0.1:8799", `${ID}/../x`], ["file:///", ID], ["javascript:alert(1)", ID],
    ["http://127.0.0.1:8799/path", ID], [null, ID]]) assert.equal(appWindowUrl(origin, id), null, `${origin} ${id}`);
  assert.equal(appIdFrom(ID), ID);
  assert.equal(appIdFrom({ id: ID }), null);
});

test("openmausbot://app/<id> reaches the page as a chat link", () => {
  assert.equal(chatLinkFrom(`openmausbot://app/${ID}`), `openmausbot://app/${ID}`);
  assert.equal(chatLinkFrom(`OPENMAUSBOT://APP/${ID}`), `OPENMAUSBOT://APP/${ID}`);
  assert.equal(chatLinkFrom("openmausbot://apps/x"), null);
  assert.equal(chatLinkFrom(`openmausbot://app/${"x".repeat(2000)}`), null);
});

test("a window opens at its remembered size, within the largest screen", () => {
  assert.deepEqual(appWindowSize(null, [{ width: 1440, height: 900 }]), APP_WINDOW_SIZE);
  assert.deepEqual(appWindowSize(null, [{ width: 800, height: 600 }]), { width: 800, height: 600 });
  assert.deepEqual(appWindowSize({ width: 900.4, height: 500 }, [{ width: 1440, height: 900 }]), { width: 900, height: 500 });
  assert.deepEqual(appWindowSize({ width: 5000, height: 10 }, [{ width: 1440, height: 900 }, { width: 2560, height: 1400 }]), { width: 2560, height: APP_WINDOW_MIN.height });
  assert.deepEqual(appWindowSize({ width: "big" }, []), { width: APP_WINDOW_SIZE.width, height: APP_WINDOW_SIZE.height });
});

test("sizes are kept per app, the newest hundred", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omb-app-windows-"));
  const sizes = createAppWindowSizes({ file: () => path.join(dir, "app-windows.json") });
  sizes.set(ID, { width: 900.6, height: 700 });
  sizes.set("not an id", { width: 1, height: 1 });
  assert.deepEqual(sizes.get(ID), { width: 901, height: 700 });
  for (let n = 0; n < 120; n += 1) sizes.set(`la_${String(n).padStart(16, "0")}`, { width: 500, height: 500 });
  assert.equal(sizes.get(ID), null);
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, "app-windows.json"), "utf8"))).length, 100);
});

class FakeContents extends EventEmitter {
  constructor() { super(); this.opener = null; }
  setWindowOpenHandler(handler) { this.opener = handler; }
}
class FakeWindow extends EventEmitter {
  static made = [];
  constructor(options) {
    super();
    this.options = options;
    this.webContents = new FakeContents();
    this.destroyed = false;
    this.loaded = null;
    this.focused = 0;
    this.bounds = { x: 0, y: 0, width: options.width, height: options.height };
    FakeWindow.made.push(this);
  }
  loadURL(url) { this.loaded = url; return Promise.resolve(); }
  isDestroyed() { return this.destroyed; }
  isMinimized() { return false; }
  isMaximized() { return false; }
  isFullScreen() { return false; }
  restore() {}
  show() {}
  focus() { this.focused += 1; }
  getNormalBounds() { return this.bounds; }
  setAppDetails(details) { this.appDetails = details; }
  close() { this.emit("close"); this.destroyed = true; this.emit("closed"); }
}

function install(overrides = {}) {
  FakeWindow.made = [];
  const handlers = new Map();
  const saved = new Map();
  const external = [], chats = [], refused = [];
  const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler) };
  const result = installLocalAppWindows({
    ipcMain,
    guard: (channel, handler) => (event, ...args) => {
      if (event.page === "other") { refused.push(channel); throw new Error("refused"); }
      return handler(event, ...args);
    },
    BrowserWindow: FakeWindow,
    senderOrigin: (event) => event.origin,
    webPreferences: () => ({ contextIsolation: true, preload: "/app/preload.cjs", additionalArguments: ["--omb-app-version=1"] }),
    openChat: (link) => { chats.push(link); return true; },
    openExternal: async (url) => { external.push(url); },
    sizes: { get: (id) => saved.get(id) ?? null, set: (id, size) => saved.set(id, size) },
    workAreas: () => [{ width: 1440, height: 900 }],
    ...overrides,
  });
  const call = (channel, event, ...args) => handlers.get(channel)(event, ...args);
  return { result, call, saved, external, chats, refused };
}

const fromMain = { origin: "http://127.0.0.1:8799" };

test("opens one window per app, with the main window's preload, and focuses it again", async () => {
  const { call, result } = install();
  assert.equal(await call("local-apps:open-window", fromMain, ID), true);
  const [win] = FakeWindow.made;
  assert.equal(win.loaded, `http://127.0.0.1:8799/local-app?id=${ID}`);
  assert.deepEqual(win.options.webPreferences, { contextIsolation: true, preload: "/app/preload.cjs", additionalArguments: ["--omb-app-version=1"] });
  assert.equal(win.options.show, false);
  assert.ok(isLocalAppWindow(win));
  assert.equal(await call("local-apps:open-window", fromMain, ID), true);
  assert.equal(FakeWindow.made.length, 1);
  assert.equal(win.focused, 1);
  await call("local-apps:open-window", fromMain, OTHER);
  assert.equal(FakeWindow.made.length, 2);
  assert.equal(result.windows().length, 2);
});

test("refuses a bad id, an unknown origin and a page the guard turns away", async () => {
  const { call, refused } = install();
  assert.equal(await call("local-apps:open-window", fromMain, "la_x"), false);
  assert.equal(await call("local-apps:open-window", { origin: null }, ID), false);
  assert.throws(() => call("local-apps:open-window", { page: "other", origin: "https://evil.example" }, ID));
  assert.deepEqual(refused, ["local-apps:open-window"]);
  assert.equal(FakeWindow.made.length, 0);
});

test("remembers the window's size as it closes, and closing it closes nothing else", async () => {
  const { call, saved } = install();
  await call("local-apps:open-window", fromMain, ID);
  const [win] = FakeWindow.made;
  win.bounds = { x: 10, y: 10, width: 820, height: 640 };
  win.close();
  assert.deepEqual(saved.get(ID), { x: 10, y: 10, width: 820, height: 640 });
  await call("local-apps:open-window", fromMain, ID);
  assert.equal(FakeWindow.made.length, 2);
  assert.equal(FakeWindow.made[1].options.width, 820);
});

test("its page can't navigate, open windows or frame the server; web links go to the browser", async () => {
  const { call, external } = install();
  await call("local-apps:open-window", fromMain, ID);
  const { webContents } = FakeWindow.made[0];
  assert.deepEqual(webContents.opener({ url: "https://example.com/" }), { action: "deny" });
  assert.deepEqual(webContents.opener({ url: "file:///etc/passwd" }), { action: "deny" });
  let prevented = 0;
  const event = { preventDefault: () => { prevented += 1; } };
  webContents.emit("will-navigate", event, "http://127.0.0.1:8799/");
  webContents.emit("will-navigate", event, "https://elsewhere.example/");
  webContents.emit("will-redirect", event, "http://127.0.0.1:8799/settings");
  webContents.emit("will-navigate", event, `http://127.0.0.1:8799/local-app?id=${ID}`);
  assert.equal(prevented, 3);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(external, ["https://example.com/", "https://elsewhere.example/"]);
  let frames = 0;
  const frame = (details) => webContents.emit("will-frame-navigate", { ...details, preventDefault: () => { frames += 1; } });
  frame({ isMainFrame: false, url: "about:srcdoc", frame: { origin: "null" } });
  frame({ isMainFrame: false, url: "https://example.com/", frame: { origin: "null" } });
  frame({ isMainFrame: false, url: "http://127.0.0.1:8799/api/bots", frame: { origin: "http://127.0.0.1:8799" } });
  assert.equal(frames, 2);
});

test("only an app's own window may bring up the main window, and only on a chat", async () => {
  const { call, chats } = install();
  await call("local-apps:open-window", fromMain, ID);
  const own = { sender: FakeWindow.made[0].webContents };
  assert.equal(await call("local-apps:open-chat", own, "openmausbot://thread/t1?bot=b1"), true);
  assert.equal(await call("local-apps:open-chat", own, `openmausbot://app/${ID}`), false);
  assert.equal(await call("local-apps:open-chat", own, "https://example.com"), false);
  assert.equal(await call("local-apps:open-chat", { sender: new FakeContents() }, "openmausbot://thread/t1?bot=b1"), false);
  assert.deepEqual(chats, ["openmausbot://thread/t1?bot=b1"]);
});

test("a launcher's app opens in its own window on this computer's server once it is up, never in the main window", async () => {
  const { createAppLaunches } = await import("./app-launches.mjs");
  const later = [];
  const launches = createAppLaunches({ later: (run) => { later.push(run); } });
  launches.fromUrl(`openmausbot://app/${ID}?window=1`);
  let up = false;
  install({ launches, ready: () => up, launchOrigin: () => "http://127.0.0.1:8799" });
  assert.equal(FakeWindow.made.length, 0);
  up = true;
  later.splice(0).forEach((run) => run());
  assert.equal(FakeWindow.made.length, 1);
  assert.equal(FakeWindow.made[0].loaded, `http://127.0.0.1:8799/local-app?id=${ID}`);
  launches.fromArgs(["exe", `openmausbot://app/${ID}?window=1`]);
  assert.equal(FakeWindow.made.length, 1);
  assert.equal(FakeWindow.made[0].focused, 1);
});

test("on Windows an installed app's window takes its launcher's taskbar details", async () => {
  const details = { appId: "com.openmausbot.app.localapp.0123456789abcdef", relaunchCommand: "x", relaunchDisplayName: "Board" };
  const { call } = install({ windowDetails: async (id) => (id === ID ? details : null) });
  await call("local-apps:open-window", fromMain, ID);
  await call("local-apps:open-window", fromMain, OTHER);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(FakeWindow.made[0].appDetails, details);
  assert.equal(FakeWindow.made[1].appDetails, undefined);
});

