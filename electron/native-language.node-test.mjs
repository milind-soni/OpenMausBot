import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { createCloudAccountClient as cloudAccountClient } from "./cloud-account.mjs";
import { createDesktopPrefs, createDesktopText, relabelDesktop } from "./desktop-prefs.mjs";
import { createLendingIndicator } from "./lending-indicator.mjs";
import { createLendingDialogs } from "./lending-dialogs.mjs";
import { createSystemTray } from "./system-tray.mjs";
import { installUseMyComputer } from "./use-my-computer.mjs";

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
  await assert.rejects(client.pairHome(), { message: "O Cloud ainda não está pronto para conectar." });
  text.set("en");
  await assert.rejects(client.pairHome(), { message: "My Cloud is not ready to connect yet." });
});

test("main's automatic computer offer follows the saved language dynamically until the page names one", async () => {
  const prefs = createDesktopPrefs({ read: () => ({ language: "pt-br" }), write: () => {} });
  const app = { isReady: () => true, getLocale: () => "en-US", getPath: () => "/fixture" };
  const shown = [], handlers = new Map();
  let kept = null, cloud = "https://first.example.test";
  const mainWindow = { isDestroyed: () => false, isVisible: () => true, webContents: { isLoading: () => false } };
  const dialogs = createLendingDialogs({ platform: "darwin", window: () => mainWindow, dialog: {
    showMessageBox: async (_parent, options) => { shown.push(options); return { response: 1 }; },
  } });
  const initialization = MAIN.match(/^const nativeText = .+$/m)?.[0];
  const start = MAIN.indexOf("const useMyComputer = installUseMyComputer("), end = MAIN.indexOf("\n\n", start);
  assert.ok(initialization && start > 0 && end > start, "main composes its native language and computer offer");
  const { text, offer } = vm.runInNewContext(`${initialization}\n${MAIN.slice(start, end)}\n({ text: nativeText, offer: useMyComputer })`, {
    app, path, createDesktopText: app => createDesktopText(app, prefs), cloudAccountClient,
    installUseMyComputer: options => installUseMyComputer({ ...options, platform: "darwin", wait: async () => {} }),
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }, cloudPageAsking: () => cloud,
    useMyMac: { state: async () => ({ available: true, on: false }) }, cuaReady: Promise.resolve({ available: false }),
    requestComputerUse: () => assert.fail("unexpected computer-control request"), lendingTarget: { environment: () => ({ origin: cloud }) },
    mainWindow, desktopRemoteAccess: null, oneHome: { lastInput: () => 0 }, lendingDialogs: dialogs,
    jsonFile: () => ({ read: () => kept, write: value => { kept = value; } }), slog: () => {},
  });
  await offer.offer();
  assert.equal(shown.at(-1).message, "Deixar seus bots usarem este Mac?");
  prefs.setLanguage("en"); text.set("en"); cloud = "https://second.example.test";
  await offer.offer();
  assert.equal(shown.at(-1).message, "Let your bots use this Mac?");
  prefs.setLanguage("pt-br"); text.set("pt-br"); cloud = "https://third.example.test";
  await offer.offer();
  assert.equal(shown.at(-1).message, "Deixar seus bots usarem este Mac?");
  cloud = "https://fourth.example.test";
  await handlers.get("cloud-lending:ask")({}, "en");
  assert.equal(shown.at(-1).message, "Let your bots use this Mac?", "the page's explicit language wins over the saved choice");
  assert.equal(shown.length, 4);
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
  const lendingTray = createLendingIndicator({ ...fakes, onStop: () => {}, onOpen: () => {}, device: "PC" });
  lendingTray.update({ lending: true, busy: false });
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

  text.set("pt-br");
  context.applyNativeLanguage();
  assert.deepEqual(calls, [["menu", "Servidor"], ["title", "OpenMausBot — Hospedado: Office (office.example.test)"], ["badge", "Nenhuma conversa não lida"]]);
  const said = (tray) => tray.menu.filter((item) => item.label).map((item) => item.label);
  assert.deepEqual(said(trays[0]), ["Abrir o OpenMaus Bot", "Sair do OpenMaus Bot"]);
  assert.deepEqual(said(trays[1]), ["Seus bots podem usar este PC", "Parar de compartilhar", "Configurações de compartilhamento…"]);
  assert.equal(trays[1].tip, "OpenMausBot: seus bots podem usar este PC");
});
