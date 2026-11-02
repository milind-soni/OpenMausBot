import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { desktopText, localizeNativeMenu, nativeLocale, setNativeLanguageResolver } from "./i18n.mjs";

test("native copy follows Chinese script and region tags, preserving interpolated values", () => {
  for (const tag of ["zh", "zh-CN", "zh-Hans-SG"]) assert.equal(nativeLocale(tag), "zh");
  for (const tag of ["zh-TW", "zh-HK", "zh-MO", "zh-Hant-TW"]) assert.equal(nativeLocale(tag), "zh-tw");
  for (const tag of [undefined, "", "not a locale", "ja-JP"]) assert.equal(nativeLocale(tag), "en");
  assert.equal(desktopText("desktop.menu.forgetNamed", { name: "Research {app}" }, "zh"), "忘记“Research {app}”");
  assert.equal(desktopText("desktop.menu.forgetNamed", { name: "Research {app}" }, "zh-tw"), "忘記「Research {app}」");
});

test("native dialogs read the current language at display time and preserve unknown keys", () => {
  let language = "zh";
  setNativeLanguageResolver(() => language);
  try {
    assert.equal(desktopText("desktop.common.cancel"), "取消");
    language = "en";
    assert.equal(desktopText("desktop.common.cancel"), "Cancel");
    assert.equal(desktopText("unknown.future.key"), "unknown.future.key");
    assert.equal(desktopText("constructor"), "constructor");
  } finally {
    setNativeLanguageResolver(() => undefined);
  }
});

test("native role translation keeps the platform's existing menu actions and nesting", () => {
  const click = () => {};
  const menu = { items: [{ role: "editMenu", label: "Edit", submenu: { items: [{ role: "copy", label: "Copy", click }] } }] };
  assert.equal(localizeNativeMenu(menu, "zh-tw", "Example"), menu);
  assert.equal(menu.items[0].label, "編輯");
  assert.equal(menu.items[0].submenu.items[0].label, "複製");
  assert.equal(menu.items[0].submenu.items[0].click, click);
});

test("macOS edit groups and substitution roles are translated without renaming custom menus", () => {
  const menu = { items: [
    { label: "Speech" },
    { role: "editMenu", submenu: { items: [
      { label: "Substitutions", submenu: { items: [{ role: "showSubstitutions", label: "Show Substitutions" }, { role: "toggleSmartQuotes", label: "Smart Quotes" }] } },
      { label: "Speech", submenu: { items: [{ role: "startSpeaking", label: "Start Speaking" }] } },
    ] } },
  ] };
  localizeNativeMenu(menu, "zh-tw", "Example");
  assert.equal(menu.items[0].label, "Speech");
  assert.equal(menu.items[1].submenu.items[0].label, "替代");
  assert.equal(menu.items[1].submenu.items[0].submenu.items[0].label, "顯示替代內容");
  assert.equal(menu.items[1].submenu.items[0].submenu.items[1].label, "智慧型引號");
  assert.equal(menu.items[1].submenu.items[1].label, "語音");
});

test("desktop packaging includes the catalogs imported by native dialogs", () => {
  const config = readFileSync(new URL("../electron-builder.yml", import.meta.url), "utf8");
  for (const code of ["en", "zh", "zh-tw"]) assert.ok(config.includes(`  - src/locales/${code}.json`));
});
