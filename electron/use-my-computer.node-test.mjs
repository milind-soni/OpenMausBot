import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createLendingDialogs, useMyComputerText } from "./lending-dialogs.mjs";
import nativeText from "./native-text.cjs";
import { askForMicrophone, openPrivacySettings } from "./privacy-settings.mjs";
import { QUIET_MS, createUseMyComputer, fullyLent, installUseMyComputer, missingPermissions, popupDue, quietWindow } from "./use-my-computer.mjs";
import { WORDS } from "./use-my-computer-words.mjs";

const MISSING_BOTH = "embedded host failed: Accessibility and Screen Recording required; grant access in System Settings and restart OpenMausBot";

const MY_CLOUD = "https://omb-u-1.fly.dev";
const USUAL = Object.freeze([{ name: "Desktop", write: false }, { name: "Documents", write: false }, { name: "Downloads", write: false }]);

/**
 * Use my Mac with fakes on every side: what is lent (on, internet, folders, screen; the person's own Off), computer
 * control (whether it works and which macOS permissions it lacks, and what granting each one does), the popup's answers,
 * the store and which My Cloud lending is for.
 */
function world({ lent = { on: true, internet: true, folders: USUAL, screen: false }, ownOff = false, available = true, ready = false, missing = ["accessibility", "screen"], answers = ["use"],
  grants = {}, possible = true, cloud = MY_CLOUD, kept = null } = {}) {
  const w = { lent: { folders: [], ...lent }, ownOff, available, ready, missing: [...missing], asked: [], calls: [], kept, cloud };
  const page = () => ({ available: w.available, ...w.lent, screenAvailable: w.ready, screenReady: w.ready, ownOff: w.ownOff, status: w.lent.on ? "lent" : null });
  w.useMyComputer = createUseMyComputer({
    lending: {
      state: async () => page(),
      async lendByDefault(input) {
        w.calls.push(["lendByDefault", input ?? {}]);
        if (!w.available || (w.ownOff && input?.asked !== true)) return null;
        w.ownOff = false;
        w.lent = { on: true, internet: true, folders: USUAL, screen: w.ready };
        return page();
      },
      async lendScreen() {
        w.calls.push(["lendScreen"]);
        if (!w.lent.on || !w.ready) return null;
        w.lent.screen = true;
        return page();
      },
    },
    computerUse: {
      possible,
      ready: async () => w.ready,
      missing: async () => [...w.missing],
      async request() {
        w.calls.push(["request"]);
        // macOS's own prompt: what it never asked before is granted here, when the person allows it.
        for (const pane of grants.prompt ?? []) w.missing = w.missing.filter((name) => name !== pane);
        w.ready = w.missing.length === 0 && grants.relaunch !== true;
      },
      async returned() { w.calls.push(["back"]); },
    },
    async ask(input) {
      w.asked.push(input);
      return answers.shift() ?? null;
    },
    store: { read: () => structuredClone(w.kept), write: (value) => { w.kept = structuredClone(value); } },
    cloud: () => w.cloud,
  });
  return w;
}
const lentNow = (w) => ({ on: w.lent.on, internet: w.lent.internet, folders: w.lent.folders.length, screen: w.lent.screen });

test("after the move, a Mac whose bots could already use apps and screen lends every part silently: no popup", async () => {
  const w = world({ ready: true, missing: [], lent: { on: true, internet: true, screen: false } });
  await w.useMyComputer.offer();
  assert.deepEqual(w.asked, [], "no popup");
  assert.deepEqual(w.calls, [["lendByDefault", {}]]);
  assert.deepEqual(lentNow(w), { on: true, internet: true, folders: 3, screen: true });
  assert.deepEqual(w.kept.clouds, [MY_CLOUD], "and it never comes again for this Cloud");
  await w.useMyComputer.offer();
  await w.useMyComputer.ask();
  assert.deepEqual(w.calls.length, 1);
  assert.deepEqual(w.asked, []);
});

test("after the move, a Mac not fully lent shows the popup once; Not now never brings it back on its own", async () => {
  const w = world({ answers: ["later"] });
  await w.useMyComputer.offer();
  assert.deepEqual(w.asked, [{ screen: true }], "the popup, with apps and screen");
  assert.deepEqual(w.calls, [], "Not now changes nothing");
  for (let run = 0; run < 3; run++) await w.useMyComputer.offer();
  await w.useMyComputer.changed();
  await w.useMyComputer.ask();
  assert.equal(w.asked.length, 1, "no second popup, across every run of the move, computer control starting and the page asking");
  assert.equal(await w.useMyComputer.due(), false);
});

test("who is asked without a bot's link: every computer signed in to its own My Cloud that does not lend every part yet, once per Cloud", () => {
  const due = (now, { cloud = MY_CLOUD, kept = { v: 1 }, screenPossible = true } = {}) => popupDue({ now: { available: true, ownOff: false, ...now }, cloud, kept, screenPossible });
  const internetOnly = { on: true, internet: true, folders: [], screen: false };
  const all = { on: true, internet: true, folders: USUAL, screen: true };
  assert.equal(due({ on: false, internet: false, folders: [], screen: false }), true, "a fresh computer that lends nothing yet");
  assert.equal(due(internetOnly), true, "one that lends its internet connection by default");
  assert.equal(due({ ...internetOnly, folders: USUAL }), true, "folders without apps and screen");
  assert.equal(due({ ...all, folders: [] }), true, "apps and screen without folders");
  assert.equal(due({ ...all, internet: false }), true, "everything but the internet connection");
  assert.equal(due(all), false, "every part lent already");
  assert.equal(due({ ...all, screen: false }, { screenPossible: false }), false, "every part this computer can lend");
  assert.equal(due({ on: false, internet: true, folders: [], screen: false, ownOff: true }), false, "the person turned lending off themselves");
  assert.equal(due(internetOnly, { kept: { v: 1, clouds: [MY_CLOUD] } }), false, "the popup was answered for this Cloud");
  assert.equal(due(internetOnly, { kept: { v: 1, clouds: ["https://omb-u-old.fly.dev"] } }), true, "answered for another Cloud only");
  assert.equal(due(internetOnly, { kept: { v: 1, asked: true } }), false, "answered at a move before answers were kept per Cloud");
  assert.equal(due({ ...internetOnly, available: false }), false, "no own My Cloud to lend to (signed out, or only a Team Cloud)");
  assert.equal(due(internetOnly, { cloud: null }), false, "nor any Cloud named");
  assert.equal(due(internetOnly, { kept: null }), true);
});

test("the page asks when the moment is right: the popup comes once, Use my Mac turns every part on, and it never comes again for that Cloud", async () => {
  const w = world({ lent: { on: true, internet: true, folders: [], screen: false }, ready: true, missing: [], answers: ["use", "later"] });
  assert.equal(await w.useMyComputer.due(), true);
  await w.useMyComputer.ask();
  assert.deepEqual(w.asked, [{ screen: true }], "even where computer control works already: the person chooses");
  assert.deepEqual(w.calls, [["lendByDefault", { asked: true }]], "a permission that exists is used without asking macOS again");
  assert.deepEqual(lentNow(w), { on: true, internet: true, folders: 3, screen: true });
  assert.deepEqual(w.kept.clouds, [MY_CLOUD]);
  for (let i = 0; i < 3; i++) await w.useMyComputer.ask();
  await w.useMyComputer.offer();
  assert.equal(w.asked.length, 1, "shown once");
  assert.equal(await w.useMyComputer.due(), false);
  w.cloud = "https://omb-u-2.fly.dev";
  w.lent = { on: true, internet: true, folders: [], screen: false };
  assert.equal(await w.useMyComputer.due(), true, "another Cloud of theirs asks once more");
  await w.useMyComputer.ask();
  assert.equal(w.asked.length, 2);
  assert.deepEqual(w.kept.clouds, [MY_CLOUD, "https://omb-u-2.fly.dev"]);
});

test("who never gets it from the page: the person's own Off, Not now, every part lent, or a Team Cloud only", async () => {
  const off = world({ lent: { on: false, internet: true, folders: [], screen: false }, ownOff: true });
  await off.useMyComputer.ask();
  const notNow = world({ answers: ["later", "use"] });
  await notNow.useMyComputer.ask();
  await notNow.useMyComputer.ask();
  const full = world({ lent: { on: true, internet: true, folders: USUAL, screen: true }, ready: true });
  await full.useMyComputer.ask();
  const team = world({ available: false, cloud: null });
  await team.useMyComputer.ask();
  assert.deepEqual([off.asked, notNow.asked, full.asked, team.asked], [[], [{ screen: true }], [], []]);
  assert.deepEqual([off.calls, notNow.calls, full.calls, team.calls], [[], [], [], []], "nothing lent on anyone's behalf");
  assert.deepEqual(notNow.kept.clouds, [MY_CLOUD], "Not now is kept for this Cloud");
});

test("Use my Mac drives macOS's own prompts from the press and never opens System Settings", async () => {
  const w = world({ grants: { prompt: ["accessibility", "screen"] } });
  await w.useMyComputer.ask();
  assert.deepEqual(w.calls, [["lendByDefault", { asked: true }], ["request"], ["back"], ["lendScreen"]],
    "the internet connection and folders first, then computer control starts again, which asks macOS");
  assert.deepEqual(lentNow(w), { on: true, internet: true, folders: 3, screen: true });
  assert.equal(w.kept.screenWanted, undefined);
});

test("macOS asks one permission at a time: each one allowed starts computer control again for the next, and one it won't ask again waits", async () => {
  let prompts = 0;
  const stepwise = world();
  stepwise.useMyComputer = createUseMyComputer({
    lending: {
      state: async () => ({ available: true, ownOff: false, ...stepwise.lent }),
      lendByDefault: async () => { stepwise.lent = { on: true, internet: true, folders: USUAL, screen: false }; return stepwise.lent; },
      lendScreen: async () => { stepwise.lent.screen = true; return stepwise.lent; },
    },
    computerUse: {
      possible: true, ready: async () => stepwise.missing.length === 0, missing: async () => [...stepwise.missing],
      request: async () => { prompts++; stepwise.calls.push(["request"]); stepwise.missing = stepwise.missing.slice(1); },
      returned: async () => {},
    },
    ask: async () => "use", store: { read: () => stepwise.kept, write: (value) => { stepwise.kept = value; } }, cloud: () => MY_CLOUD,
  });
  await stepwise.useMyComputer.ask();
  assert.equal(prompts, 2, "Accessibility, then Screen Recording");
  assert.equal(stepwise.lent.screen, true);
  const refused = world({ grants: { prompt: [] } });
  await refused.useMyComputer.ask();
  assert.deepEqual(refused.calls, [["lendByDefault", { asked: true }], ["request"], ["back"]], "macOS asked nothing new: no System Settings, no loop");
  assert.equal(refused.lent.screen, false);
  assert.equal(refused.kept.screenWanted, true, "apps and screen go on once the person allows them in their own time");
  refused.ready = true;
  await refused.useMyComputer.changed();
  assert.equal(refused.lent.screen, true);
});

test("Screen Recording that works only after OpenMausBot restarts: apps and screen go on by themselves once computer control works", async () => {
  const w = world({ grants: { prompt: ["accessibility", "screen"], relaunch: true } });
  await w.useMyComputer.offer();
  assert.deepEqual(lentNow(w), { on: true, internet: true, folders: 3, screen: false }, "everything else is lent at once");
  assert.equal(w.kept.screenWanted, true);
  // OpenMausBot started again: computer control works now.
  w.ready = true;
  w.available = false;
  await w.useMyComputer.changed();
  assert.equal(w.lent.screen, false, "not before lending can tell what is lent");
  w.available = true;
  await w.useMyComputer.offer();
  assert.equal(w.lent.screen, true);
  assert.equal(w.kept.screenWanted, undefined);
  assert.equal(w.asked.length, 1, "with no second popup");
});

test("the person's own Off, a computer fully lent, or a Cloud lending can't reach yet: no popup", async () => {
  const off = world({ lent: { on: false, internet: false, screen: false }, ownOff: true });
  await off.useMyComputer.offer();
  assert.deepEqual([off.asked, off.calls, off.kept.clouds], [[], [], [MY_CLOUD]], "lending they turned off stays off");
  const full = world({ lent: { on: true, internet: true, folders: USUAL, screen: true }, ready: true });
  await full.useMyComputer.offer();
  assert.deepEqual([full.asked, full.calls, full.kept.clouds], [[], [], [MY_CLOUD]]);
  const away = world({ available: false });
  await away.useMyComputer.offer();
  assert.deepEqual([away.asked, away.kept], [[], null], "asked on a later run instead");
  away.available = true;
  await away.useMyComputer.offer();
  assert.equal(away.asked.length, 1);
});

test("where apps and screen can't work at all, the internet connection and folders are every part", async () => {
  const w = world({ possible: false, lent: { on: true, internet: true, folders: USUAL, screen: false } });
  await w.useMyComputer.offer();
  await w.useMyComputer.ask();
  assert.deepEqual(w.asked, []);
  const off = world({ possible: false, lent: { on: false, internet: false, screen: false } });
  await off.useMyComputer.offer();
  assert.deepEqual(off.asked, [{ screen: false }]);
  assert.deepEqual(off.calls, [["lendByDefault", { asked: true }]], "nothing asks macOS");
});

test("a bot's Use my Mac link opens the same popup, even after Not now, and undoes the person's own Off when they choose it", async () => {
  const w = world({ answers: ["later", "use"], ready: true, missing: [] });
  await w.useMyComputer.ask();
  assert.equal(w.asked.length, 1);
  w.lent = { on: false, internet: false, folders: [], screen: false };
  w.ownOff = true;
  await w.useMyComputer.again();
  assert.equal(w.asked.length, 2, "the link always asks");
  assert.deepEqual(lentNow(w), { on: true, internet: true, folders: 3, screen: true });
  await w.useMyComputer.again();
  assert.equal(w.asked.length, 2, "nothing to ask once every part is lent");
});

test("one popup at a time: the link pressed or the page asking while it is open asks nothing more", async () => {
  let answer;
  const w = world();
  const shown = new Promise((resolve) => { w.useMyComputer = createUseMyComputer({
    lending: { state: async () => ({ available: true, on: true, internet: true, folders: [], screen: false, ownOff: false }), lendByDefault: async () => null, lendScreen: async () => null },
    computerUse: { possible: true, ready: async () => false, missing: async () => [], request: async () => {}, returned: async () => {} },
    ask: () => { w.asked.push(true); resolve(); return new Promise((done) => { answer = done; }); },
    store: { read: () => w.kept, write: (value) => { w.kept = value; } }, cloud: () => MY_CLOUD,
  }); });
  const first = w.useMyComputer.ask();
  await shown;
  await Promise.all([w.useMyComputer.again(), w.useMyComputer.offer(), w.useMyComputer.ask(), w.useMyComputer.changed(), (answer("later"), first)]);
  assert.equal(w.asked.length, 1);
});

test("what computer control lacks is read from its own start-up failure, never by asking macOS", () => {
  assert.deepEqual(missingPermissions(MISSING_BOTH), ["accessibility", "screen"]);
  assert.deepEqual(missingPermissions("Screen Recording required; grant access"), ["screen"]);
  assert.deepEqual(missingPermissions("Screen Recording and Accessibility required"), ["accessibility", "screen"]);
  assert.deepEqual(missingPermissions("cua-driver binary not found"), []);
  assert.deepEqual(missingPermissions(undefined), []);
  assert.equal(fullyLent({ on: true, internet: true, folders: USUAL, screen: false }, true), false);
  assert.equal(fullyLent({ on: true, internet: true, folders: USUAL, screen: false }, false), true);
  assert.equal(fullyLent({ on: true, internet: true, folders: [], screen: true }, true), false, "folders are a part too");
  assert.equal(fullyLent({ on: false, internet: true, folders: USUAL, screen: true }, true), false);
});

test("the popup: one question, one plain line, Use my Mac and a quiet Not now, by the word the person knows the computer by, in the page's language", async () => {
  assert.deepEqual(useMyComputerText("darwin", { screen: true }), {
    message: "Let your bots use this Mac?",
    detail: "Your bots on My Cloud can then read your Desktop, Documents and Downloads and use your apps and screen, while this Mac is awake and OpenMausBot is open.",
    buttons: ["Use my Mac", "Not now"],
  });
  assert.deepEqual(useMyComputerText("win32", { screen: true }).buttons, ["Use my PC", "Not now"]);
  assert.equal(useMyComputerText("win32", { screen: true }).message, "Let your bots use this PC?");
  assert.deepEqual(useMyComputerText("linux", { screen: false }), {
    message: "Let your bots use this computer?",
    detail: "Your bots on My Cloud can then read your Desktop, Documents and Downloads, while this computer is awake and OpenMausBot is open.",
    buttons: ["Use this computer", "Not now"],
  });
  assert.deepEqual(useMyComputerText("win32", { screen: true, locale: "de-DE" }).buttons, ["Meinen PC nutzen", "Jetzt nicht"]);
  assert.equal(useMyComputerText("darwin", { screen: true, locale: "pt" }).message, "Deixar seus bots usarem este Mac?");
  assert.equal(useMyComputerText("darwin", { screen: true, locale: "zh-Hant-TW" }).buttons[0], "使用我的 Mac");
  assert.equal(useMyComputerText("darwin", { screen: true, locale: "xx" }).message, "Let your bots use this Mac?", "English for a language the app does not speak");
  for (const platform of ["darwin", "win32", "linux"]) {
    for (const screen of [true, false]) assert.doesNotMatch(useMyComputerText(platform, { screen }).detail, /edit|save|change|Settings/iu, "folders are read only, and nobody is sent to Settings");
  }
  const shown = [];
  const dialogs = createLendingDialogs({ dialog: { showMessageBox: async (...args) => { shown.push(args); return { response: 0 }; } }, window: () => null, validate: async () => [], platform: "darwin" });
  const win = { isDestroyed: () => false };
  assert.equal(await dialogs.useMyComputer(win, { screen: true, locale: "fr" }), "use");
  assert.equal(shown[0][0], win, "main's own dialog, on the app's window");
  assert.equal(shown[0][1].message, "Laisser vos bots utiliser ce Mac ?");
  assert.equal(shown[0][1].defaultId, 0);
  assert.equal(shown[0][1].cancelId, 1);
});

test("the popup speaks the app's language, in main's own dialog", async () => {
  const { t } = nativeText.createNativeText({ saved: "pt-br" });
  assert.deepEqual(useMyComputerText("darwin", { screen: true, locale: "pt-br" }), {
    message: "Deixar seus bots usarem este Mac?",
    detail: "Seus bots no Cloud poderão ler as pastas Mesa, Documentos e Downloads e usar seus apps e sua tela enquanto este Mac estiver ativo e o OpenMausBot estiver aberto.",
    buttons: ["Usar meu Mac", "Agora não"],
  });
  assert.deepEqual(useMyComputerText("win32", { screen: false, locale: "pt-br" }).buttons, ["Usar meu PC", "Agora não"]);
  assert.deepEqual(useMyComputerText("linux", { screen: false, locale: "pt-br" }).buttons, ["Usar este computador", "Agora não"]);
  const shown = [];
  const dialogs = createLendingDialogs({ dialog: { showMessageBox: async (...args) => { shown.push(args); return { response: 1 }; } }, window: () => null, validate: async () => [], platform: "win32", t });
  assert.equal(await dialogs.useMyComputer({ isDestroyed: () => false }, { screen: false, locale: "pt-br" }), "later");
  assert.equal(shown[0][1].message, "Deixar seus bots usarem este PC?");
});

test("main's popup says what every language pack says, word for word", async () => {
  const dir = fileURLToPath(new URL("../src/locales/", import.meta.url));
  const en = JSON.parse(await readFile(path.join(dir, "en.json"), "utf8"));
  const keys = Object.keys(en).filter((key) => key.startsWith("lending.useMyComputer."));
  assert.deepEqual(keys.sort(), Object.keys(WORDS.en).sort(), "every key main uses is in the catalog, and only those");
  for (const file of (await readdir(dir)).filter((name) => name.endsWith(".json") && name !== "source-hashes.json")) {
    const locale = file.slice(0, -".json".length);
    const pack = JSON.parse(await readFile(path.join(dir, file), "utf8"));
    assert.ok(WORDS[locale], `${locale}: main has no words for it`);
    for (const key of keys) assert.equal(WORDS[locale][key], pack[key] ?? en[key], `${locale} ${key}: copy src/locales/${file} into electron/use-my-computer-words.mjs`);
  }
});

test("the popup waits for a shown, loaded window and a few quiet seconds, so a key meant for the page never answers it", async () => {
  let clock = 0, typedAt = 0, loading = true;
  const win = { isDestroyed: () => false, isVisible: () => true, webContents: { isLoading: () => loading } };
  const waits = [];
  const found = quietWindow({ window: () => win, lastInput: () => typedAt, now: () => clock, wait: async (ms) => {
    waits.push(ms);
    clock += ms;
    if (clock === 2_000) loading = false;
    if (clock === 3_000) typedAt = clock;
  } });
  assert.equal(await found, win);
  assert.ok(clock - typedAt >= QUIET_MS, "only once nobody typed for a while");
  assert.equal(await quietWindow({ window: () => null, lastInput: () => 0, now: () => clock, wait: async (ms) => { clock += ms; } }), null, "no window: asked on a later run");
});

test("main's side: computer control's running state decides; the page asks only from this app's own window, says when and in which language, never what", async () => {
  const handlers = new Map(), shown = [], requested = [];
  let connection = { mode: "unavailable", reason: MISSING_BOTH };
  let kept = null;
  const win = { isDestroyed: () => false, isVisible: () => true, isFocused: () => true, webContents: { isLoading: () => false } };
  let lending = { available: true, on: true, internet: true, folders: [], screen: false, ownOff: false };
  const useMyComputer = installUseMyComputer({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    cloudPage: (event) => event.page ?? null,
    lending: { state: async () => lending, lendByDefault: async () => (lending = { ...lending, on: true, internet: true, folders: USUAL }), lendScreen: async () => (lending = { ...lending, screen: true }) },
    connection: async () => connection,
    request: async () => { requested.push(true); },
    window: () => win, remote: () => false, lastInput: () => -Infinity,
    dialogs: { useMyComputer: async (parent, input) => { shown.push([parent, input]); return "use"; } },
    store: { read: () => kept, write: (value) => { kept = value; } },
    cloud: () => MY_CLOUD, locale: () => "en-GB",
    platform: "darwin", wait: async () => {},
  });
  for (const channel of ["cloud-lending:offer", "cloud-lending:due", "cloud-lending:ask"]) {
    await assert.rejects(async () => handlers.get(channel)({ page: null }), /only available in this app's window/, `${channel}: any other page gets nothing`);
  }
  assert.equal(shown.length, 0);
  assert.equal(await handlers.get("cloud-lending:due")({ page: "cloud" }), true);
  await handlers.get("cloud-lending:ask")({ page: "cloud" }, "ja");
  assert.deepEqual(shown, [[win, { screen: true, locale: "ja" }]], "main's own popup, on the app's window, in the page's language");
  assert.ok(requested.length > 0, "the press starts computer control again, which asks macOS");
  assert.equal(lending.screen, false, "never while the driver says it can't work");
  assert.equal(await handlers.get("cloud-lending:due")({ page: "local" }), false, "asked once for this Cloud");
  await handlers.get("cloud-lending:ask")({ page: "cloud" }, "de");
  assert.equal(shown.length, 1);
  handlers.get("cloud-lending:offer")({ page: "cloud" }, "<script>");
  await useMyComputer.again();
  assert.deepEqual(shown[1], [win, { screen: true, locale: "de" }], "a bot's link asks again, in the page's latest language; one that is no language changes nothing");
  connection = { mode: "embedded", socketPath: "/tmp/cua.sock", mcpCommand: "/Applications/OpenMausBot.app/cua-driver", mcpArgs: ["mcp"], mcpEnv: {} };
  await useMyComputer.again();
  assert.equal(lending.screen, true, "once computer control runs, apps and screen go on");
});

test("System Settings opens a permission's own pane, and nothing where there is none", async () => {
  const opened = [];
  const open = (pane, available = true) => openPrivacySettings(pane, { available, openExternal: (url) => { opened.push(url); return true; } });
  assert.equal(open("accessibility"), true);
  open("screen");
  open("__proto__");
  assert.deepEqual(opened, [
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
    "x-apple.systempreferences:com.apple.preference.security?Privacy",
  ]);
  assert.equal(open("screen", false), false);
  assert.equal(opened.length, 3);
  assert.equal(await askForMicrophone({ available: false }), false);
  assert.equal(await askForMicrophone({ available: true, systemPreferences: { askForMediaAccess: async () => true } }), true);
  assert.equal(await askForMicrophone({ available: true, systemPreferences: { askForMediaAccess: async () => { throw new Error("no"); } } }), false);
});
