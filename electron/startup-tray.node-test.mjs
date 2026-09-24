import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createStartupScreen } from "./startup-screen.mjs";
import { createSystemTray } from "./system-tray.mjs";

const iconPath = fileURLToPath(new URL("./resources/app-icon.png", import.meta.url));
class Window extends EventEmitter {
  constructor(options = {}) {
    super(); this.options = options; this.destroyed = false; this.visible = false;
    this.webContents = new EventEmitter();
    this.webContents.executeJavaScript = async () => {};
  }
  setMenu() {}
  loadURL() { queueMicrotask(() => this.emit("ready-to-show")); return Promise.resolve(); }
  isDestroyed() { return this.destroyed; }
  destroy() { this.destroyed = true; this.emit("closed"); }
  show() { this.visible = true; this.emit("show"); }
  showInactive() { this.show(); }
  hide() { this.visible = false; }
  focus() { this.focused = true; }
  isMinimized() { return this.minimized ?? false; }
  minimize() { this.minimized = true; }
  restore() { this.minimized = false; }
  maximize() { this.maximized = true; }
  setSkipTaskbar(value) { this.skipTaskbar = value; }
}
function fixture(options = {}) {
  const calls = [];
  let trayInstance;
  class Tray extends EventEmitter {
    constructor(_icon, guid) { super(); this.guid = guid; trayInstance = this; }
    setToolTip(value) { this.tooltip = value; }
    setContextMenu(value) { this.menu = value; }
    isDestroyed() { return this.destroyed ?? false; }
    destroy() { this.destroyed = true; calls.push("destroy-tray"); }
  }
  let active;
  const tray = createSystemTray({ Tray, Menu: { buildFromTemplate: value => value },
    nativeImage: { createFromPath: () => ({ resize: () => ({}) }) }, iconPath,
    getWindow: () => active, onQuit: () => calls.push("quit") });
  const splash = createStartupScreen({ BrowserWindow: Window, iconPath, platform: "win32",
    isQuitting: () => false, onQuit: () => calls.push("quit"), onHide: win => tray.hide(win),
    isHidden: () => tray.isHidden(), onShow: win => tray.windowShown(win),
    onFinished: () => calls.push("finished"), ...options });
  active = splash.window;
  const win = new Window();
  win.on("show", () => tray.windowShown(win));
  return { tray, trayInstance, splash, win, calls, setActive: value => { active = value; } };
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

class UnreadyWindow extends Window {
  loadURL() { return Promise.resolve(); }
}

test("a loading screen that never becomes ready cannot block server startup", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { splash, calls } = fixture({ BrowserWindow: UnreadyWindow });
  let ready = false;
  void splash.ready.then(() => { ready = true; });
  t.mock.timers.tick(9999); await flush();
  assert.equal(ready, false);
  t.mock.timers.tick(1); await flush();
  assert.equal(ready, true);
  assert.equal(splash.window.destroyed, true);
  assert.deepEqual(calls, ["finished"]);
});

test("a loading renderer crash unblocks startup before ready-to-show", async () => {
  const { splash, calls } = fixture({ BrowserWindow: UnreadyWindow });
  let ready = false;
  void splash.ready.then(() => { ready = true; });
  splash.window.webContents.emit("render-process-gone");
  await flush();
  assert.equal(ready, true);
  assert.equal(splash.window.destroyed, true);
  assert.deepEqual(calls, ["finished"]);
});

test("loading screen waits for mounted content before revealing the restored workspace", async () => {
  const { splash, win, calls } = fixture();
  await splash.ready;
  assert.equal(splash.window.visible, true);
  let mounted;
  win.webContents.executeJavaScript = () => new Promise(resolve => { mounted = resolve; });
  splash.attach(win, { maximized: true });
  win.webContents.emit("did-finish-load");
  assert.equal(win.visible, false);
  mounted(); await flush();
  assert.equal(win.visible, true); assert.equal(win.maximized, true);
  assert.equal(win.focused, true); assert.equal(splash.window.destroyed, true);
  assert.deepEqual(calls, ["finished"]);
});

test("closing during startup keeps the eventual workspace hidden until tray restore", async () => {
  const { splash, win, tray, calls, setActive } = fixture();
  await splash.ready;
  let prevented = false;
  splash.window.emit("close", { preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.equal(tray.isHidden(), true);
  splash.attach(win, { maximized: true });
  win.webContents.emit("did-finish-load"); await flush();
  assert.equal(win.visible, false); assert.equal(win.skipTaskbar, true);
  setActive(win); assert.equal(tray.show(), true);
  assert.equal(win.visible, true); assert.equal(win.skipTaskbar, false);
  assert.equal(win.maximized, true); assert.equal(tray.isHidden(), false);
  assert.deepEqual(calls, ["finished"]);
});

test("tray restores minimized windows, supports explicit quit, and disposes once", async () => {
  const { splash, win, tray, trayInstance, setActive, calls } = fixture();
  await splash.ready; splash.dispose(); setActive(win);
  win.minimize(); tray.hide(win); trayInstance.emit("click");
  assert.equal(win.minimized, false); assert.equal(win.focused, true);
  assert.equal(win.skipTaskbar, false);
  trayInstance.menu[2].click();
  tray.destroy(); tray.destroy();
  assert.deepEqual(calls, ["finished", "quit", "destroy-tray"]);
  win.destroy(); assert.equal(tray.show(), false);
});

test("renderer crash reveals the workspace recovery surface", async () => {
  const { splash, win } = fixture(); await splash.ready; splash.attach(win);
  win.webContents.emit("render-process-gone");
  assert.equal(win.visible, true); assert.equal(splash.window.destroyed, true);
});

test("a renderer that never mounts has a bounded fallback", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { splash, win } = fixture(); await splash.ready; splash.attach(win);
  t.mock.timers.tick(9999); assert.equal(win.visible, false);
  t.mock.timers.tick(1); assert.equal(win.visible, true);
  assert.equal(splash.window.destroyed, true);
});

test("quit never reveals a waiting workspace", async () => {
  let quitting = false;
  const { splash, win } = fixture({ isQuitting: () => quitting });
  await splash.ready; splash.attach(win); quitting = true; splash.dispose();
  win.webContents.emit("did-finish-load"); await flush();
  assert.equal(win.visible, false); assert.equal(splash.window.destroyed, true);
});

test("without a Windows tray or on another platform splash close quits", async () => {
  for (const options of [{ platform: "darwin" }, { onHide: undefined }]) {
    const { splash, calls } = fixture(options); await splash.ready;
    splash.window.emit("close", { preventDefault() {} });
    assert.deepEqual(calls, ["quit"]); splash.dispose();
  }
});
