import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { LOCALES_DIR, createNativeText, englishText, nativeLanguage } = require("./native-text.cjs");

function packs(t, files) {
  const dir = mkdtempSync(path.join(tmpdir(), "native-text-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [name, value] of Object.entries(files)) writeFileSync(path.join(dir, name), typeof value === "string" ? value : JSON.stringify(value));
  return dir;
}

test("a language tag reads the pack the renderer would pick, aliases included, and anything else reads English", (t) => {
  const dir = packs(t, { "en.json": { "native.x": "en" }, "pt-br.json": { "native.x": "pt" }, "zh-tw.json": { "native.x": "zh-tw" }, "de.json": { "native.x": "de" } });
  const language = (tag) => createNativeText({ dir, saved: tag }).language();
  assert.equal(language("pt-br"), "pt-br");
  assert.equal(language("pt"), "pt-br");
  assert.equal(language("pt-PT"), "pt-br", "as src/locales/index.ts maps pt");
  assert.equal(language("pt_BR"), "pt-br");
  for (const tag of ["zh-hant", "zh-HK", "zh-mo", "zh-Hant-TW", "zh-tw"]) assert.equal(language(tag), "zh-tw", tag);
  assert.equal(language("de-AT"), "de");
  for (const tag of ["xx", "", null, 42, "en-GB"]) assert.equal(language(tag), "en", String(tag));
});

test("a code from a page is never a path: only a pack listed in the folder is read, never the hashes or a parent", (t) => {
  const dir = packs(t, { "en.json": { "native.x": "en" }, "source-hashes.json": { "native.x": "hash" }, "evil.txt": "{}" });
  writeFileSync(path.join(path.dirname(dir), "native-text-outside.json"), JSON.stringify({ "native.x": "outside" }));
  t.after(() => rmSync(path.join(path.dirname(dir), "native-text-outside.json"), { force: true }));
  for (const code of ["../en", "../native-text-outside", "source-hashes", "evil", "en/../en", "EN.JSON", "/etc/passwd"]) {
    assert.equal(nativeLanguage(code, dir), null, code);
    const text = createNativeText({ dir, saved: code });
    assert.equal(text.language(), "en", code);
    assert.equal(text.t("native.x"), "en", code);
  }
  assert.equal(nativeLanguage("en", dir), "en");
});

test("a key a language lacks reads in English, parameters fill in, and only main's own keys are kept", (t) => {
  const dir = packs(t, {
    "en.json": { "native.a": "Forget “{name}”", "native.b": "Only English", "place.local": "This computer", "chat.other": "not main's" },
    "pt-br.json": { "native.a": "Esquecer “{name}”", "place.local": "Este computador", "chat.other": "não" },
  });
  const text = createNativeText({ dir, saved: "pt-br" });
  assert.equal(text.t("native.a", { name: "Studio" }), "Esquecer “Studio”");
  assert.equal(text.t("native.a"), "Esquecer “{name}”", "a missing parameter stays as written");
  assert.equal(text.t("native.b"), "Only English");
  assert.equal(text.t("place.local"), "Este computador");
  assert.equal(text.t("chat.other"), "chat.other", "the renderer's own keys are not held in main");
});

test("shared native controls reuse the renderer's catalog in the current language", () => {
  const text = createNativeText({ saved: "en" });
  const controls = ["rail.thisComputer", "rail.remove", "cloudHome.tryAgain", "computer.windows.start", "mcp.turnOn", "cloudSetup.myCloud", "computer.badge.local"];
  assert.deepEqual(controls.map(key => text.t(key)), ["This computer", "Remove from list", "Try again", "Start screen control", "Turn on", "My Cloud", "this computer"]);
  text.set("pt-br");
  assert.deepEqual(controls.map(key => text.t(key)), ["Este computador", "Remover da lista", "Tentar novamente", "Iniciar o controle de tela", "Ligar", "My Cloud", "este computador"]);
});

test("the saved language wins over the system's, \"\" follows the system again, and set says when the words change", (t) => {
  const dir = packs(t, { "en.json": { "native.x": "en" }, "pt-br.json": { "native.x": "pt" }, "de.json": { "native.x": "de" } });
  let system = "";
  const text = createNativeText({ dir, saved: null, system: () => system });
  assert.equal(text.t("native.x"), "en", "before Electron knows the system's language");
  system = "de-DE";
  assert.equal(text.t("native.x"), "de");
  assert.equal(text.set("pt-br"), true);
  assert.equal(text.t("native.x"), "pt");
  assert.equal(text.set("pt"), false, "the same pack");
  assert.equal(text.set(""), true);
  assert.equal(text.t("native.x"), "de");
  assert.equal(text.set("de"), false);
  const broken = createNativeText({ dir, system: () => { throw new Error("not ready"); } });
  assert.equal(broken.t("native.x"), "en");
});

test("with nothing picked, main's words follow the language the window shows, not the system's beside it", (t) => {
  const dir = packs(t, { "en.json": { "native.x": "en" }, "pt-br.json": { "native.x": "pt" }, "de.json": { "native.x": "de" } });
  const text = createNativeText({ dir, saved: null, system: () => "pt-BR" });
  assert.equal(text.t("native.x"), "pt", "before the window has drawn");
  assert.equal(text.follow("en"), true, "an English window, say a team's default, on a Portuguese system");
  assert.equal(text.t("native.x"), "en");
  assert.equal(text.follow("en"), false);
  for (const code of ["../en", "xx", null]) {
    text.follow("en");
    assert.equal(text.follow(code), true, String(code));
    assert.equal(text.t("native.x"), "pt", `${code}: not a pack, so the system's again`);
  }
  assert.equal(text.follow("de"), true);
  assert.equal(text.set("pt-br"), true, "a pick wins");
  assert.equal(text.follow("de"), false, "the window shows the pick, so this is a stale report");
  assert.equal(text.t("native.x"), "pt");
  assert.equal(text.set(""), true, "System is a pick that follows the window again");
  assert.equal(text.t("native.x"), "de");
});

test("dates and lists follow the app's language; English keeps its own list words", (t) => {
  const dir = packs(t, { "en.json": {}, "pt-br.json": {} });
  const pt = createNativeText({ dir, saved: "pt-br", system: () => "en-US" });
  assert.equal(pt.intlTag(), "pt-BR");
  assert.equal(pt.listFormat(["Ana", "Bo", "Cy"]), "Ana, Bo e Cy");
  const en = createNativeText({ dir, saved: "en", system: () => "en-GB" });
  assert.equal(en.intlTag(), "en-GB", "the system's own English");
  assert.equal(en.listFormat(["Ana", "Bo", "Cy"]), "Ana, Bo and Cy");
  assert.equal(en.listFormat(["Ana"]), "Ana");
  assert.equal(en.listFormat([]), "");
  assert.equal(createNativeText({ dir, saved: "pt-br", system: () => "pt-PT" }).intlTag(), "pt-PT");
});

test("the shipped catalog: English reads every native key, and pt-br has them all", () => {
  const en = JSON.parse(readFileSync(path.join(LOCALES_DIR, "en.json"), "utf8"));
  const pt = JSON.parse(readFileSync(path.join(LOCALES_DIR, "pt-br.json"), "utf8"));
  const keys = Object.keys(en).filter((key) => key.startsWith("native."));
  assert.ok(keys.length > 100);
  for (const key of keys) assert.equal(englishText.t(key), en[key], key);
  const text = createNativeText({ saved: "pt-BR" });
  for (const key of keys) assert.equal(text.t(key), pt[key], key);
  assert.equal(text.t("place.local"), pt["place.local"]);
});

test("the native team confirm reuses the renderer's teamMove keys without retaining unrelated keys", (t) => {
  const dir = packs(t, {
    "en.json": { "teamMove.title": "Move {bot} to {team}?", "chat.other": "not main's" },
    "pt-br.json": { "teamMove.title": "Mover {bot} para {team}?" },
  });
  const text = createNativeText({ dir, saved: "pt-br" });
  assert.equal(text.t("teamMove.title", { bot: "Atlas", team: "Acme" }), "Mover Atlas para Acme?");
  assert.equal(text.t("chat.other"), "chat.other");
});
