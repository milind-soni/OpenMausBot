import assert from "node:assert/strict";
import test from "node:test";

import { createLendingDialogs, useMyComputerText } from "./lending-dialogs.mjs";
import { askForMicrophone, openPrivacySettings } from "./privacy-settings.mjs";
import { QUIET_MS, createUseMyComputer, fullyLent, installUseMyComputer, missingPermissions, quietWindow } from "./use-my-computer.mjs";

const MISSING_BOTH = "embedded host failed: Accessibility and Screen Recording required; grant access in System Settings and restart OpenMausBot";

/**
 * Use my Mac with fakes on every side: what is lent (on, internet, screen; the person's own Off), computer control (whether
 * it works and which macOS permissions it lacks, and what granting each one does), the popup's answers and the store.
 */
function world({ lent = { on: true, internet: true, screen: false }, ownOff = false, available = true, ready = false, missing = ["accessibility", "screen"], answers = ["use"],
  grants = {}, possible = true } = {}) {
  const w = { lent: { ...lent }, ownOff, available, ready, missing: [...missing], asked: [], calls: [], kept: null };
  const page = () => ({ available: w.available, ...w.lent, screenAvailable: w.ready, screenReady: w.ready, ownOff: w.ownOff, folders: [], status: w.lent.on ? "lent" : null });
  w.useMyComputer = createUseMyComputer({
    lending: {
      state: async () => page(),
      async lendByDefault(input) {
        w.calls.push(["lendByDefault", input ?? {}]);
        if (!w.available || (w.ownOff && input?.asked !== true)) return null;
        w.ownOff = false;
        w.lent = { on: true, internet: true, screen: w.ready };
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
      async openSettings(pane) {
        w.calls.push(["settings", pane]);
        if ((grants.settings ?? []).includes(pane)) w.missing = w.missing.filter((name) => name !== pane);
      },
      async returned() { w.calls.push(["back"]); },
    },
    async ask(input) {
      w.asked.push(input);
      return answers.shift() ?? null;
    },
    store: { read: () => structuredClone(w.kept), write: (value) => { w.kept = structuredClone(value); } },
  });
  return w;
}

test("after the move, a Mac whose bots could already use apps and screen lends every part silently: no popup", async () => {
  const w = world({ ready: true, missing: [] });
  await w.useMyComputer.offer();
  assert.deepEqual(w.asked, [], "no popup");
  assert.deepEqual(w.calls, [["lendByDefault", {}]]);
  assert.deepEqual(w.lent, { on: true, internet: true, screen: true });
  assert.equal(w.kept.asked, true, "and it never comes again");
  await w.useMyComputer.offer();
  assert.deepEqual(w.calls.length, 1);
});

test("after the move, a Mac not fully lent shows the popup once; Not now never brings it back on its own", async () => {
  const w = world({ answers: ["later"] });
  await w.useMyComputer.offer();
  assert.deepEqual(w.asked, [{ screen: true }], "the popup, with apps and screen");
  assert.deepEqual(w.calls, [], "Not now changes nothing");
  for (let run = 0; run < 3; run++) await w.useMyComputer.offer();
  await w.useMyComputer.changed();
  assert.equal(w.asked.length, 1, "no second popup, across every run of the move and computer control starting");
  assert.equal(w.kept.asked, true);
});

test("Use my Mac lends every part at once, and walks through macOS's permissions until apps and screen go on", async () => {
  const w = world({ grants: { settings: ["accessibility", "screen"] } });
  await w.useMyComputer.offer();
  assert.deepEqual(w.calls, [
    ["lendByDefault", { asked: true }],
    ["request"], ["back"],
    ["settings", "accessibility"], ["back"], ["request"],
    ["settings", "screen"], ["back"], ["request"],
    ["lendScreen"],
  ], "the internet connection and folders first, then macOS's own prompt, then each pane still missing, one after another");
  assert.deepEqual(w.lent, { on: true, internet: true, screen: true });
  assert.equal(w.kept.screenWanted, undefined);
});

test("a permission macOS grants from its own prompt is never opened in System Settings", async () => {
  const w = world({ grants: { prompt: ["accessibility"], settings: ["screen"] } });
  await w.useMyComputer.offer();
  assert.deepEqual(w.calls.filter(([kind]) => kind === "settings"), [["settings", "screen"]]);
  assert.equal(w.lent.screen, true);
});

test("Screen Recording that works only after OpenMausBot restarts: apps and screen go on by themselves once computer control works", async () => {
  const w = world({ grants: { prompt: ["accessibility", "screen"], relaunch: true } });
  await w.useMyComputer.offer();
  assert.deepEqual(w.lent, { on: true, internet: true, screen: false }, "everything else is lent at once");
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
  assert.deepEqual([off.asked, off.calls, off.kept.asked], [[], [], true], "lending they turned off stays off");
  const full = world({ lent: { on: true, internet: true, screen: true }, ready: true });
  await full.useMyComputer.offer();
  assert.deepEqual([full.asked, full.calls, full.kept.asked], [[], [], true]);
  const away = world({ available: false });
  await away.useMyComputer.offer();
  assert.deepEqual([away.asked, away.kept], [[], null], "asked on a later run instead");
  away.available = true;
  await away.useMyComputer.offer();
  assert.equal(away.asked.length, 1);
});

test("where apps and screen can't work at all, the internet connection and folders are every part", async () => {
  const w = world({ possible: false, lent: { on: true, internet: true, screen: false } });
  await w.useMyComputer.offer();
  assert.deepEqual(w.asked, []);
  const off = world({ possible: false, lent: { on: false, internet: false, screen: false } });
  await off.useMyComputer.offer();
  assert.deepEqual(off.asked, [{ screen: false }]);
  assert.deepEqual(off.calls, [["lendByDefault", { asked: true }]], "nothing asks macOS");
});

test("a bot's Use my Mac link opens the same popup, even after Not now, and undoes the person's own Off when they choose it", async () => {
  const w = world({ answers: ["later", "use"], grants: { settings: ["accessibility", "screen"] } });
  await w.useMyComputer.offer();
  assert.equal(w.asked.length, 1);
  w.lent = { on: false, internet: false, screen: false };
  w.ownOff = true;
  await w.useMyComputer.again();
  assert.equal(w.asked.length, 2, "the link always asks");
  assert.deepEqual(w.lent, { on: true, internet: true, screen: true });
  await w.useMyComputer.again();
  assert.equal(w.asked.length, 2, "nothing to ask once every part is lent");
});

test("one popup at a time: the link pressed while it is open asks nothing more", async () => {
  let answer;
  const w = world();
  const shown = new Promise((resolve) => { w.useMyComputer = createUseMyComputer({
    lending: { state: async () => ({ available: true, on: true, internet: true, screen: false, ownOff: false }), lendByDefault: async () => null, lendScreen: async () => null },
    computerUse: { possible: true, ready: async () => false, missing: async () => [], request: async () => {}, openSettings: async () => {}, returned: async () => {} },
    ask: () => { w.asked.push(true); resolve(); return new Promise((done) => { answer = done; }); },
    store: { read: () => w.kept, write: (value) => { w.kept = value; } },
  }); });
  const first = w.useMyComputer.offer();
  await shown;
  await Promise.all([w.useMyComputer.again(), w.useMyComputer.offer(), w.useMyComputer.changed(), (answer("later"), first)]);
  assert.equal(w.asked.length, 1);
});

test("what computer control lacks is read from its own start-up failure, never by asking macOS", () => {
  assert.deepEqual(missingPermissions(MISSING_BOTH), ["accessibility", "screen"]);
  assert.deepEqual(missingPermissions("Screen Recording required; grant access"), ["screen"]);
  assert.deepEqual(missingPermissions("Screen Recording and Accessibility required"), ["accessibility", "screen"]);
  assert.deepEqual(missingPermissions("cua-driver binary not found"), []);
  assert.deepEqual(missingPermissions(undefined), []);
  assert.equal(fullyLent({ on: true, internet: true, screen: false }, true), false);
  assert.equal(fullyLent({ on: true, internet: true, screen: false }, false), true);
  assert.equal(fullyLent({ on: false, internet: true, screen: true }, true), false);
});

test("the popup: one question, one plain line, Use my Mac and a quiet Not now, by the word the person knows the computer by", async () => {
  assert.deepEqual(useMyComputerText("darwin", { screen: true }), {
    message: "Let your bots use this Mac?",
    detail: "Like before, they can use its internet connection, read your Desktop, Documents and Downloads, and use your apps and screen.",
    buttons: ["Use my Mac", "Not now"],
  });
  assert.deepEqual(useMyComputerText("win32", { screen: true }).buttons, ["Use my PC", "Not now"]);
  assert.equal(useMyComputerText("win32", { screen: true }).message, "Let your bots use this PC?");
  assert.deepEqual(useMyComputerText("linux", { screen: false }), {
    message: "Let your bots use this computer?",
    detail: "Like before, they can use its internet connection and read your Desktop, Documents and Downloads.",
    buttons: ["Use this computer", "Not now"],
  });
  for (const platform of ["darwin", "win32", "linux"]) {
    for (const screen of [true, false]) assert.doesNotMatch(useMyComputerText(platform, { screen }).detail, /edit|save|change|Settings/iu, "folders are read only, and nobody is sent to Settings");
  }
  const shown = [];
  const dialogs = createLendingDialogs({ dialog: { showMessageBox: async (...args) => { shown.push(args); return { response: 0 }; } }, window: () => null, validate: async () => [], platform: "darwin" });
  const win = { isDestroyed: () => false };
  assert.equal(await dialogs.useMyComputer(win, { screen: true }), "use");
  assert.equal(shown[0][0], win, "main's own dialog, on the app's window");
  assert.equal(shown[0][1].defaultId, 0);
  assert.equal(shown[0][1].cancelId, 1);
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

test("main's side: computer control's running state decides, a bot's link reaches the popup only from this app's own pages", async () => {
  const handlers = new Map(), shown = [], requested = [], panes = [];
  let connection = { mode: "unavailable", reason: MISSING_BOTH };
  const win = { isDestroyed: () => false, isVisible: () => true, isFocused: () => true, webContents: { isLoading: () => false } };
  let lending = { available: true, on: true, internet: true, screen: false, ownOff: false };
  const useMyComputer = installUseMyComputer({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    cloudPage: (event) => event.page ?? null,
    lending: { state: async () => lending, lendByDefault: async () => (lending = { ...lending, on: true, internet: true }), lendScreen: async () => (lending = { ...lending, screen: true }) },
    connection: async () => connection,
    request: async () => { requested.push(true); },
    openSettings: (pane) => { panes.push(pane); },
    window: () => win, remote: () => false, lastInput: () => -Infinity,
    dialogs: { useMyComputer: async (parent, input) => { shown.push([parent, input]); return "use"; } },
    store: { read: () => null, write: () => {} },
    platform: "darwin", wait: async () => {},
  });
  assert.throws(() => handlers.get("cloud-lending:offer")({ page: null }), /only available in this app's window/, "any other page gets nothing");
  assert.equal(shown.length, 0);
  handlers.get("cloud-lending:offer")({ page: "cloud" });
  await useMyComputer.again();
  assert.deepEqual(shown, [[win, { screen: true }]], "main's own popup, on the app's window");
  assert.deepEqual(panes, ["accessibility", "screen"], "what the running driver says is missing, in order");
  assert.equal(lending.screen, false, "never while the driver says it can't work");
  connection = { mode: "embedded", socketPath: "/tmp/cua.sock", mcpCommand: "/Applications/OpenMausBot.app/cua-driver", mcpArgs: ["mcp"], mcpEnv: {} };
  await useMyComputer.again();
  assert.equal(lending.screen, true, "once computer control runs, apps and screen go on");
  assert.ok(requested.length > 0);
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
