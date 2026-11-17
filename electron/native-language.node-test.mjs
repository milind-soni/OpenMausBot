import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { createCloudAccountClient as cloudAccountClient } from "./cloud-account.mjs";
import { createDesktopPrefs, createDesktopText, relabelDesktop } from "./desktop-prefs.mjs";
import { createActivityWindow } from "./lending-activity-window.mjs";
import { createLendingIndicator } from "./lending-indicator.mjs";
import { createSystemTray } from "./system-tray.mjs";

const require = createRequire(import.meta.url);
const environments = require("./environments.cjs");
const { createNativeText } = require("./native-text.cjs");
const MAIN = readFileSync(new URL("./main.mjs", import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("main's Cloud account factory keeps the same client in the current app language", async () => {
  const prefs = createDesktopPrefs({ read: () => ({ language: "en" }), write: () => assert.fail("unexpected preference write") });
  const initialization = MAIN.match(/^const nativeText = .+$/m)?.[0];
  assert.ok(initialization, "main initializes its native text and Cloud account factory");
  const { text, createClient } = vm.runInNewContext(`${initialization}\n({ text: nativeText, createClient: createCloudAccountClient })`, {
    app: { isReady: () => true, getLocale: () => "en" },
    createDesktopText: app => createDesktopText(app, prefs), cloudAccountClient,
  });
  const client = createClient({
    store: {}, platform: "darwin", deviceName: "Test computer", appVersion: "1.0.0",
    fetch: () => assert.fail("unexpected Cloud request"),
  });
  await assert.rejects(client.pairHome(), { message: "My Cloud is not ready to connect yet." });
  text.set("pt-br");
  await assert.rejects(client.pairHome(), { message: "Ainda não é possível se conectar ao Cloud." });
  text.set("en");
  await assert.rejects(client.pairHome(), { message: "My Cloud is not ready to connect yet." });
});

test("main's activity window follows the shown Chinese language without a saved preference on an English OS", () => {
  const app = { isReady: () => true, getLocale: () => "en-US", getPath: () => "/unused" };
  const prefs = createDesktopPrefs({ read: () => ({}), write: () => assert.fail("unexpected preference write") });
  const nativeText = createDesktopText(app, prefs);
  const windows = [];
  class BrowserWindow {
    constructor(options) {
      this.options = options;
      this.webContents = { setWindowOpenHandler() {}, on() {} };
      windows.push(this);
    }
    isDestroyed() { return false; }
    once() {} on() {} show() {} focus() {}
    loadURL(url) { this.html = decodeURIComponent(url.slice(url.indexOf(",") + 1)); return Promise.resolve(); }
  }
  const initialization = MAIN.match(/^const lendingActivity = createActivityWindow\([\s\S]+?\}\);/m)?.[0];
  assert.ok(initialization, "main initializes its activity window");
  const activity = vm.runInNewContext(`${initialization}\nlendingActivity`, {
    app, nativeText, BrowserWindow, createActivityWindow, APP_ICON: "icon.png",
    nativeTheme: { shouldUseDarkColors: false }, windowBackground: () => "#fff",
    sharingController: () => ({ activity: () => [{ at: Date.UTC(2026, 9, 1), server: "Test Cloud", action: "read_file", ok: false }] }),
    jsonFile: () => ({ read: () => ({}) }), path,
  });
  activity.show();
  assert.match(windows[0].html, /<html lang="en-US">/);
  assert.equal(nativeText.follow("zh-Hant"), true);
  activity.show();
  assert.match(windows[0].html, /<html lang="zh-TW">/);
  assert.match(windows[0].html, /<h1>這台電腦上的活動<\/h1>/);
  assert.match(windows[0].html, /讀取檔案 · 已拒絕/);
  assert.equal(prefs.language(), null);
  assert.equal(windows.length, 1);
});

test("a new language redraws main's menu, both trays, the window title and the badge", () => {
  const text = createNativeText({ saved: "en" });
  const trays = [], calls = [];
  class Tray {
    constructor() { trays.push(this); }
    on() {} setToolTip(value) { this.tip = value; } setTitle(value) { this.title = value; }
    setContextMenu(menu) { this.menu = menu; } isDestroyed() { return false; }
  }
  const fakes = { Tray, Menu: { buildFromTemplate: (items) => items }, nativeImage: { createFromPath: () => ({ resize: () => ({}) }) }, iconPath: "icon.png", t: text.t };
  const desktopTray = createSystemTray({ ...fakes, getWindow: () => null, onQuit: () => {} });
  const lendingTray = createLendingIndicator({ ...fakes, onPause: () => {}, onResume: () => {}, onActivity: () => {}, device: "PC" });
  lendingTray.update({ clouds: ["My Cloud"], using: [], paused: false });
  const office = { id: "o", kind: "remote", name: "Office", origin: "https://office.example.test" };
  const context = vm.createContext({
    desktopTray, lendingTray, nativeT: text.t, relabelDesktop,
    refreshApplicationMenu: () => calls.push(["menu", text.t("native.menu.server")]),
    applyUnreadBadge: () => calls.push(["badge", text.t("native.badge.none")]),
    mainWindow: { isDestroyed: () => false, setTitle: (title) => calls.push(["title", title]) },
    environmentsState: { environments: [office], activeId: "o" }, desktopRemoteAccess: null,
    homeWindow: { cloudOrigin: () => null }, workspaceWindowTitle: environments.workspaceWindowTitle,
  });
  const start = MAIN.indexOf("function mainWindowTitle() {"), end = MAIN.indexOf("async function workspaceMenuAction(", start);
  assert.ok(start > 0 && end > start, "main.mjs still has applyNativeLanguage");
  vm.runInContext(`${MAIN.slice(start, end)}; this.applyNativeLanguage = applyNativeLanguage;`, context);

  const said = (tray) => tray.menu.filter((item) => item.label).map((item) => item.label);
  assert.deepEqual(said(trays[1]), ["My Cloud can use this PC", "Pause", "Let Clouds run commands on this PC", "See activity"]);

  text.set("pt-br");
  context.applyNativeLanguage();
  assert.deepEqual(calls, [["menu", "Servidor"], ["title", "OpenMausBot — Hospedado: Office (office.example.test)"], ["badge", "Nenhuma conversa não lida"]]);
  assert.deepEqual(said(trays[0]), ["Abrir o OpenMausBot", "Sair do OpenMausBot"]);
  assert.deepEqual(said(trays[1]), ["My Cloud com acesso a este PC", "Pausar", "Permitir que os Clouds executem comandos neste PC", "Ver atividade"]);
  assert.equal(trays[1].tip, "OpenMausBot: My Cloud com acesso a este PC");
});
