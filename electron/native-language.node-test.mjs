import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";
import { createLendingIndicator } from "./lending-indicator.mjs";
import { createSystemTray } from "./system-tray.mjs";

const require = createRequire(import.meta.url);
const environments = require("./environments.cjs");
const { createNativeText } = require("./native-text.cjs");
const MAIN = readFileSync(new URL("./main.mjs", import.meta.url), "utf8").replace(/\r\n/g, "\n");

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
    desktopTray, lendingTray, nativeT: text.t,
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
