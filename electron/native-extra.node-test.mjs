import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import test from "node:test";
import { setNativeLanguageResolver } from "./i18n.mjs";
import { createLendingIndicator } from "./lending-indicator.mjs";
import { askPromptWords, screenLine } from "./screen-words.mjs";
import { startupScreenHtml } from "./startup-screen.mjs";
import { splashText } from "./home-window.mjs";
import { createDesktopPrefs } from "./desktop-prefs.mjs";
import { screenStatus } from "./screen-status.mjs";

test("changing language redraws the existing sharing menu without changing permissions", t => {
  let language = "en", tray, actions = 0;
  setNativeLanguageResolver(() => language);
  t.after(() => setNativeLanguageResolver(() => undefined));
  class Tray {
    constructor() { tray = this; }
    on() {}
    setToolTip(value) { this.tip = value; }
    setTitle(value) { this.title = value; }
    setContextMenu(value) { this.menu = value; }
    isDestroyed() { return false; }
    destroy() {}
  }
  const indicator = createLendingIndicator({ Tray, Menu: { buildFromTemplate: value => value },
    nativeImage: { createFromPath: () => ({ resize: () => ({}) }) }, iconPath: "unused",
    onPause: () => actions++, onResume: () => actions++, onActivity: () => actions++, onTerminal: () => actions++, device: "PC" });
  indicator.update({ clouds: ["User's Cloud"], terminal: false });
  assert.ok(tray.menu.some(item => item.label === "Pause"));
  language = "zh";
  indicator.refresh?.();
  assert.ok(tray.menu.some(item => item.label === "暂停"));
  assert.ok(tray.tip.includes("User's Cloud"));
  assert.equal(tray.menu.find(item => item.type === "checkbox").checked, false);
  assert.equal(actions, 0);
  language = "zh-TW";
  indicator.refresh?.();
  assert.ok(tray.menu.some(item => item.label === "暫停"));
  assert.equal(actions, 0);
  indicator.destroy();
});

test("Chinese permission copy preserves the bot's words and external failure details", t => {
  setNativeLanguageResolver(() => "zh-TW");
  t.after(() => setNativeLanguageResolver(() => undefined));
  const words = askPromptWords({ bot: "Scout", need: "terminal", reason: "terminal-off", why: "原句 {do_not_expand}" }, { cloud: "My saved Cloud", device: "Mac" });
  assert.equal(words.message, "My saved Cloud 上的 Scout 想要在這台 Mac 上執行指令");
  assert.ok(words.detail.includes("原句 {do_not_expand}"));
  assert.deepEqual(words.buttons, ["開啟", "暫時不要"]);
  assert.equal(screenLine({ ready: false, reason: "unsupported", message: "External driver detail." }, "PC"), "External driver detail");
});

test("the startup page uses the selected Chinese language while keeping its restrictive page policy", t => {
  setNativeLanguageResolver(() => "zh");
  t.after(() => setNativeLanguageResolver(() => undefined));
  const page = startupScreenHtml(fileURLToPath(new URL("./resources/app-icon.png", import.meta.url)));
  assert.ok(page.includes('aria-label="关闭"'));
  assert.ok(page.includes("正在打开你的工作区…"));
  assert.ok(page.includes("default-src 'none'"));
  assert.ok(page.includes("OpenMaus Bot"));
});

test("startup status reads the current language and preserves saved location names", t => {
  let language = "zh";
  setNativeLanguageResolver(() => language);
  t.after(() => setNativeLanguageResolver(() => undefined));
  assert.equal(splashText("opening"), "正在打开我的云端…");
  language = "zh-TW";
  assert.equal(splashText("waking"), "正在喚醒我的雲端…");
  assert.equal(splashText("opening", "Acme {keep}"), "正在開啟 Acme {keep}…");
});

test("startup initializes the same saved language preference before its first awaited operation", t => {
  const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  const opening = "app.whenReady().then(async () => {";
  const from = main.indexOf(opening) + opening.length;
  const to = main.indexOf("await evictStartupCacheOnce", from);
  assert.ok(from >= opening.length && to > from);
  let writes = 0;
  const context = { desktopPrefs: null, createDesktopPrefs, path, app: { getPath: () => "/isolated-prefs-fixture" },
    jsonFile: file => {
      assert.equal(file, path.join("/isolated-prefs-fixture", "desktop-prefs.json"));
      return { read: () => ({ language: "zh-TW" }), write: () => writes++ };
    } };
  vm.runInNewContext(main.slice(from, to), context);
  setNativeLanguageResolver(() => context.desktopPrefs?.language() || "en");
  t.after(() => setNativeLanguageResolver(() => undefined));
  const page = startupScreenHtml(fileURLToPath(new URL("./resources/app-icon.png", import.meta.url)));
  assert.ok(page.includes('aria-label="關閉"'));
  assert.equal(writes, 0);
});

test("translated Linux policy copy still refuses control and preserves unknown driver explanations", t => {
  setNativeLanguageResolver(() => "zh-TW");
  t.after(() => setNativeLanguageResolver(() => undefined));
  const status = screenStatus({ platform: "linux", connection: { reasonCode: "linux-wayland-seat-safety-blocked", message: "Local control is not available on Wayland yet. Sign out and choose Ubuntu on Xorg to use This computer." } });
  assert.deepEqual({ ready: status.ready, lent: status.lent, reason: status.reason, fix: status.fix }, { ready: false, lent: false, reason: "unsupported", fix: null });
  assert.equal(status.message, "目前尚無法在 Wayland 使用本機控制。請登出並選擇 Ubuntu on Xorg，以使用「這台電腦」。");
  const external = screenStatus({ platform: "linux", connection: { reasonCode: "bundled-driver-invalid", message: "Driver-supplied diagnostic" } });
  assert.equal(external.message, "Driver-supplied diagnostic");
});
