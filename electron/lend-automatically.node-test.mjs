// This computer works for each Cloud of the person's own by itself: what it lends, to whom, Pause, the move from the
// switches, the protections that still hold through the home folder, the menu-bar item and its activity window.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os, { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { ownCloud } from "./cloud-list.mjs";
import { automaticGrant, createComputerSharing, lendsAsWanted } from "./computer-sharing.mjs";
import { activityPage, createActivityWindow } from "./lending-activity-window.mjs";
import { createLendingIndicator, indicatorText } from "./lending-indicator.mjs";
import { createLendingTarget } from "./lending-target.mjs";
import { WORDS } from "./lending-words.mjs";

const HOME = "https://omb-u-fixture.fly.dev", OTHER = "https://omb-c-client-a.fly.dev", TEAM = "https://omb-t-acme.fly.dev";
const myCloud = { id: "my-cloud", name: "My Cloud", origin: HOME, home: true };
const clientA = { id: "client-a", name: "Client A", origin: OTHER, cloud: { id: "c-a", role: "owner" } };
const acme = { id: "acme", name: "Acme team", origin: TEAM, team: { id: "t-acme", role: "owner" } };

const until = async (check, what, ms = 5000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await check()) return; await delay(10); }
  assert.fail(`timed out waiting for ${what}`);
};

async function scratch(t) {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "omb-lend-automatically-")));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  return dir;
}

/** A Cloud home as the poll sees it: what this computer registered, each job's result, and its disconnects. */
function cloudHome({ link = true, chrome = true } = {}) {
  const json = (value, status = 200) => ({ ok: status < 400, status, headers: { get: () => null }, body: (async function* () { yield Buffer.from(JSON.stringify(value)); })() });
  const state = { environmentId: randomUUID(), sessionId: randomUUID(), connects: [], results: [], queue: [], disconnects: [], calls: 0 };
  state.push = operation => state.queue.push({ id: randomUUID(), operation: { computer_id: state.connects.at(-1).id, ...operation } });
  state.fetch = async (url, init) => {
    state.calls++;
    const route = new URL(url).pathname;
    if (route === "/api/auth/session") return json({ kind: "session", id: state.sessionId, scopes: ["admin", "client"], cloudHome: true });
    if (route === "/.well-known/openmausbot/environment") return json({ environmentId: state.environmentId, capabilities: { sharedComputers: true, lendingDetails: true, ...(link ? { deviceLink: true } : {}), ...(chrome ? { myChromeLink: true } : {}) } });
    const body = init?.body ? JSON.parse(init.body) : {};
    if (route === "/api/shared-computers/connect") { state.connects.push(body); return json({ ok: true }); }
    if (route.endsWith("/poll")) {
      const job = state.queue.shift() ?? null;
      if (!job) await delay(50, undefined, { signal: init?.signal }).catch(() => {});
      init?.signal?.throwIfAborted();
      return json({ job });
    }
    if (route.endsWith("/lease")) return json({ active: true });
    if (route.endsWith("/result")) { state.results.push(body.result); return json({ ok: true }); }
    if (route.endsWith("/disconnect")) { state.disconnects.push(body); return json({ ok: true }); }
    return json({ ok: true });
  };
  return state;
}

/** The verified session as cloud-account.mjs answers it: My Cloud, Client A of the person's own, and a Team Cloud. */
function session() {
  let state = { status: "connected", account: { id: "acct_1" }, machine: { status: "ready", origin: HOME }, clouds: [
    { id: "c-home", origin: HOME, teamId: null, role: "owner", primary: true },
    { id: "c-a", origin: OTHER, teamId: null, role: "owner" },
    { id: "c-team", origin: TEAM, teamId: "t-acme", role: "owner" },
  ] };
  const account = {
    state: () => state,
    isOwnCloud: origin => state.status === "connected" && (state.machine?.origin === origin || state.clouds.some(cloud => ownCloud(cloud) && cloud.origin === origin)),
  };
  return { account, signOut: () => { state = { status: "signed-out", account: null, machine: null, clouds: [] }; }, signIn: () => { state = { ...session().account.state() }; } };
}

/** This computer lending to every saved place the way main wires it: the session's own Clouds, its home folder, and
 * apps and screen while `screen` says so. */
async function computer(t, { places = [myCloud, clientA, acme], screen = () => false, home, homes = {}, cuaConnection = async () => null, askForScreen } = {}) {
  const dir = await scratch(t);
  const file = path.join(dir, "profile", "computer-sharing.json");
  const signedIn = session();
  const target = createLendingTarget({ account: () => signedIn.account, environments: () => places });
  const summaries = [];
  const dials = [];
  const make = () => createComputerSharing({
    file, environments: () => places, enabled: async () => false, home: home ?? path.join(dir, "home"),
    fetch: (url, init) => {
      const at = homes[new URL(url).origin];
      if (!at) throw new Error(`no Cloud at ${new URL(url).origin}`);
      return at.fetch(url, init);
    },
    cloud: target.cloud, myCloud: target.environment, ownClouds: target.places, screen, cuaConnection, ...(askForScreen ? { askForScreen } : {}),
    hostControl: async () => ({ renew: async () => {}, release: async () => {} }), onChange: summary => summaries.push(summary),
    WebSocket: class { constructor(url) { dials.push(url); } close() {} send() {} },
  });
  let sharing = make();
  t.after(() => sharing.close());
  return { dir, file, target, summaries, dials, signedIn, get sharing() { return sharing; }, restart: () => { sharing.close(); sharing = make(); return sharing; } };
}

test("each Cloud of the person's own is lent this computer by itself: the internet connection, their Chrome and the home folder with editing; never the terminal", async t => {
  const homes = { [HOME]: cloudHome(), [OTHER]: cloudHome() };
  const dir = await scratch(t);
  const home = path.join(dir, "me");
  await mkdir(home);
  t.mock.method(os, "homedir", () => home);
  const mac = await computer(t, { homes, home, places: [myCloud] });
  mac.sharing.start();
  await until(() => homes[HOME].connects.length === 1, "My Cloud to be lent this computer, with no click");
  const [lent] = homes[HOME].connects;
  assert.deepEqual({ folders: lent.folders.map(folder => [folder.name, folder.write]), internet: lent.internet, chrome: lent.chrome, terminal: lent.terminal, computer: lent.computer },
    { folders: [["me", true]], internet: true, chrome: true, terminal: false, computer: false });
  const kept = JSON.parse(await readFile(mac.file, "utf8")).records[myCloud.id];
  assert.deepEqual({ home: kept.folders[0].home, path: kept.folders[0].path, write: kept.folders[0].write }, { home: true, path: home, write: true });
  assert.deepEqual(mac.summaries.at(-1).clouds, ["My Cloud"]);
});

test("apps and screen are lent once computer control works here, and follow it", async t => {
  const homes = { [HOME]: cloudHome() };
  let works = false;
  const mac = await computer(t, { homes, places: [myCloud], screen: () => works });
  mac.sharing.start();
  await until(() => homes[HOME].connects.length === 1, "lending to start");
  assert.equal(homes[HOME].connects[0].computer, false, "not before macOS has granted its permissions");
  works = true;
  await mac.sharing.screenChanged();
  await until(() => homes[HOME].connects.length === 2, "apps and screen to be lent");
  assert.equal(homes[HOME].connects[1].computer, true);
  await mac.sharing.screenChanged();
  await delay(100);
  assert.equal(homes[HOME].connects.length, 2, "nothing is lent again while nothing changed");
  works = false;
  await mac.sharing.screenChanged();
  await until(() => homes[HOME].connects.length === 3, "apps and screen to be taken back");
  assert.equal(homes[HOME].connects[2].computer, false);
});

test("every Cloud of the person's own gets it at its own address; a Team Cloud never does", async t => {
  const homes = { [HOME]: cloudHome(), [OTHER]: cloudHome(), [TEAM]: cloudHome() };
  const mac = await computer(t, { homes });
  mac.sharing.start();
  await until(() => homes[HOME].connects.length === 1 && homes[OTHER].connects.length === 1, "My Cloud and Client A to be lent");
  await delay(200);
  assert.equal(homes[TEAM].calls, 0, "the Team Cloud is never called");
  const records = JSON.parse(await readFile(mac.file, "utf8")).records;
  assert.deepEqual(Object.keys(records).sort(), ["client-a", "my-cloud"]);
  assert.equal(records["client-a"].cloud.origin, OTHER, "checked at its own address");
  assert.deepEqual(mac.summaries.at(-1).clouds, ["My Cloud", "Client A"]);
});

test("signing out stops lending; signing in again lends again by itself", async t => {
  const homes = { [HOME]: cloudHome() };
  const mac = await computer(t, { homes, places: [myCloud] });
  mac.sharing.start();
  await until(() => homes[HOME].connects.length === 1, "lending to start");
  mac.signedIn.signOut();
  mac.sharing.cloudChanged();
  assert.equal(mac.sharing.cloudState(myCloud).enabled, false);
  assert.deepEqual(mac.summaries.at(-1).clouds, [], "nothing in the menu bar while signed out");
  mac.signedIn.signIn();
  mac.sharing.cloudChanged();
  await until(() => homes[HOME].connects.length === 2, "lending to come back by itself");
});

test("Pause stops every Cloud at once and lasts across restarts; Resume lends again", async t => {
  const homes = { [HOME]: cloudHome(), [OTHER]: cloudHome() };
  const mac = await computer(t, { homes, places: [myCloud, clientA] });
  mac.sharing.start();
  await until(() => homes[HOME].connects.length === 1 && homes[OTHER].connects.length === 1, "both Clouds to be lent");
  mac.sharing.pause();
  await until(() => homes[HOME].disconnects.length === 1 && homes[OTHER].disconnects.length === 1, "both Clouds to be told");
  assert.deepEqual(mac.summaries.at(-1), { lending: [], clouds: ["My Cloud", "Client A"], using: [], paused: true, busy: null });
  assert.equal(mac.sharing.lentToCloud(myCloud).paused, true, "Files keeps My Cloud's copies, and holds bots' changes there");
  const plans = path.join(mac.dir, "Plans");
  await mkdir(plans);
  await mac.sharing.saveCloud(myCloud, { folders: [{ id: randomUUID(), path: plans, write: false }], internet: true, chrome: true });
  await delay(200);
  assert.equal(homes[HOME].connects.length, 1, "a folder the Files page adds while paused is kept for Resume, never lent now");
  homes[HOME].push({ action: "list_files", folder_id: randomUUID() });
  const again = mac.restart();
  again.start();
  again.cloudChanged();
  await delay(300);
  assert.deepEqual([homes[HOME].connects.length, homes[OTHER].connects.length, homes[HOME].results.length], [1, 1, 0], "nothing runs while paused, after a restart too");
  assert.equal(again.paused(), true);
  await again.resume();
  await until(() => homes[HOME].connects.length === 2 && homes[OTHER].connects.length === 2, "Resume to lend to both again");
  assert.deepEqual(homes[HOME].connects[1].folders.map(folder => folder.name), ["Plans"], "with the folder added while paused");
  assert.equal(homes[OTHER].connects[1].id, homes[OTHER].connects[0].id, "and the same grant where nothing changed");
  assert.equal(mac.restart().paused(), false);
});

test("someone who had switched lending off, or unticked the internet connection, starts Paused; anyone else is lent by itself", async t => {
  const record = extra => ({ sessionId: null, environmentId: null, id: randomUUID(), secret: "a".repeat(64), folders: [], terminal: false, computer: false,
    cloud: { accountId: "acct_1", origin: HOME }, ...extra });
  const cases = [
    ["their own Off", record({ enabled: false, internet: true, stopped: { reason: "you", at: 1 } }), true],
    ["an Off kept from before its reason was", record({ enabled: false, internet: true }), true],
    ["the internet connection unticked", record({ enabled: true, internet: false }), true],
    ["a sign-out stopped it", record({ enabled: false, internet: true, stopped: { reason: "signed-out", at: 1 } }), false],
    ["lending on", record({ enabled: true, internet: true }), false],
    ["nothing kept", null, false],
  ];
  for (const [what, kept, paused] of cases) {
    const homes = { [HOME]: cloudHome() };
    const mac = await computer(t, { homes, places: [myCloud] });
    await mkdir(path.dirname(mac.file), { recursive: true });
    await writeFile(mac.file, JSON.stringify({ version: 1, records: kept ? { [myCloud.id]: kept } : {} }));
    const sharing = mac.restart();
    sharing.start();
    if (paused) {
      await delay(200);
      assert.equal(sharing.paused(), true, what);
      assert.equal(homes[HOME].connects.length, 0, `${what}: nothing lent`);
      assert.deepEqual({ paused: mac.summaries.at(-1)?.paused, clouds: mac.summaries.at(-1)?.clouds }, { paused: true, clouds: ["My Cloud"] }, `${what}: the menu bar says Paused, with Resume`);
    } else {
      await until(() => homes[HOME].connects.at(-1)?.internet === true, `${what}: lent by itself`);
      assert.equal(sharing.paused(), false, what);
    }
  }
});

test("a grant kept from before keeps its folders, which Files keeps copies of; the terminal it had is not lent any more", async t => {
  const homes = { [HOME]: cloudHome() };
  const mac = await computer(t, { homes, places: [myCloud] });
  const plans = path.join(mac.dir, "Plans");
  await mkdir(plans);
  const id = randomUUID();
  await mkdir(path.dirname(mac.file), { recursive: true });
  await writeFile(mac.file, JSON.stringify({ version: 1, records: { [myCloud.id]: { sessionId: null, environmentId: null, id: randomUUID(), secret: "a".repeat(64), enabled: true,
    folders: [{ id, path: plans, name: "Plans", write: false }], terminal: true, computer: false, internet: true, cloud: { accountId: "acct_1", origin: HOME } } } }));
  const sharing = mac.restart();
  sharing.start();
  await until(() => homes[HOME].connects.length === 1, "the automatic grant to reach My Cloud");
  await delay(100);
  assert.equal(homes[HOME].connects.length, 1, "the grant with the terminal never connected, not even for a moment");
  assert.deepEqual(homes[HOME].connects[0].folders.map(folder => [folder.id, folder.name, folder.write]), [[id, "Plans", false]], "the same folder, by the same id");
  assert.equal(homes[HOME].connects[0].terminal, false);
  homes[HOME].push({ action: "run_command", command: "id" });
  await until(() => homes[HOME].results.length === 1, "the command's answer");
  assert.equal(homes[HOME].results[0].isError, true, "no command runs here");
});

test("the automatic grant, piece by piece: the home folder first with editing, folders kept as they were, project folders with editing, at most 20", () => {
  const folder = (name, write = false, extra = {}) => ({ id: randomUUID(), path: `/Users/me/${name}`, name, write, ...extra });
  const home = { id: randomUUID(), path: "/Users/me", name: "me", write: true, home: true };
  const kept = Array.from({ length: 20 }, (_, n) => folder(`Kept ${n}`));
  const wanted = automaticGrant({ kept, home, screen: true, projects: [folder("Kept 0", true), folder("App", true)] });
  assert.equal(wanted.folders.length, 20);
  assert.deepEqual(wanted.folders[0], home);
  assert.equal(wanted.folders[1].write, true, "a kept folder the move lends with editing keeps it");
  assert.deepEqual({ screen: wanted.screen, internet: wanted.internet, chrome: wanted.chrome, terminal: wanted.terminal }, { screen: true, internet: true, chrome: true, terminal: false });
  const keptHome = { ...home, id: "kept-home-id", write: false };
  assert.deepEqual(automaticGrant({ kept: [keptHome], home }).folders, [{ ...keptHome, write: true }], "the home folder kept before keeps its id and gains editing");
  assert.deepEqual(automaticGrant({}).folders, [], "no home folder where it can't be lent");
  const record = { enabled: true, cloud: { accountId: "a", origin: HOME }, folders: wanted.folders, internet: true, chrome: true, computer: true, terminal: false };
  assert.equal(lendsAsWanted(record, wanted), true);
  for (const changed of [{ terminal: true }, { chrome: false }, { internet: false }, { computer: false }, { enabled: false }, { cloud: undefined }, { folders: wanted.folders.slice(1) }]) {
    assert.equal(lendsAsWanted({ ...record, ...changed }, wanted), false, JSON.stringify(Object.keys(changed)));
  }
});

test("through the home folder, keys, passwords, sign-ins and git secrets stay private and its settings can't be changed; other files can be edited", async t => {
  const dir = await scratch(t);
  const home = path.join(dir, "me");
  const put = async (relative, text) => { await mkdir(path.dirname(path.join(home, relative)), { recursive: true }); await writeFile(path.join(home, relative), text); };
  await put(".ssh/id_ed25519", "PRIVATE KEY");
  await put(".zshrc", "export OPENAI_API_KEY=sk-fixture");
  await put(".gitconfig", "[credential]\n\thelper = store");
  await put(".git-credentials", "https://me:token@github.com");
  await put(".config/gh/hosts.yml", "oauth_token: gho_fixture");
  await put("Library/Application Support/App/settings.json", "{}");
  await put("Documents/notes.md", "my notes");
  t.mock.method(os, "homedir", () => home);
  const homes = { [HOME]: cloudHome() };
  const mac = await computer(t, { homes, home, places: [myCloud] });
  mac.sharing.start();
  await until(() => homes[HOME].connects.length === 1, "lending to start");
  const folder = homes[HOME].connects[0].folders[0].id;
  const jobs = [
    ["read_file", ".ssh/id_ed25519"], ["read_file", ".zshrc"], ["read_file", ".gitconfig"], ["read_file", ".git-credentials"], ["read_file", ".config/gh/hosts.yml"],
    ["write_file", ".zprofile"], ["write_file", ".config/autostart/run.desktop"], ["write_file", "Library/LaunchAgents/run.plist"], ["write_file", "library/Application Support/App/settings.json"],
    ["read_file", "Documents/notes.md"], ["write_file", "Documents/plan.md"], ["list_files", ""],
  ];
  for (const [action, where] of jobs) homes[HOME].push({ action, folder_id: folder, path: where, ...(action === "write_file" ? { content: "from My Cloud" } : {}) });
  await until(() => homes[HOME].results.length === jobs.length, "every answer", 10_000);
  const answers = homes[HOME].results.map(result => result.content[0].text);
  for (const [index, [action, where]] of jobs.slice(0, 9).entries()) {
    assert.equal(homes[HOME].results[index].isError, true, `${action} ${where}`);
    assert.doesNotMatch(answers[index], /sk-fixture|PRIVATE KEY|token|gho_/, `${where}: nothing private in the answer`);
  }
  assert.match(answers[5], /hidden files, Library and AppData/);
  assert.match(answers[7], /hidden files, Library and AppData/);
  assert.equal(JSON.parse(answers[9]).content, "my notes");
  assert.equal(JSON.parse(answers[10]).written, true);
  assert.equal(await readFile(path.join(home, "Documents", "plan.md"), "utf8"), "from My Cloud");
  const listed = Object.fromEntries(JSON.parse(answers[11]).entries.map(entry => [entry.name, entry.type]));
  assert.deepEqual([listed[".ssh"], listed[".zshrc"], listed[".gitconfig"], listed.Documents], ["protected", "protected", "protected", "directory"]);
  await assert.rejects(readFile(path.join(home, ".zprofile")), { code: "ENOENT" });
  assert.deepEqual(await readdir(path.join(home, "Library")), ["Application Support"]);
});

test("a Cloud's bot needing apps and screen on a Mac that lacks only macOS's permissions asks macOS for them, and says how to allow them", async t => {
  const homes = { [HOME]: cloudHome() };
  const asked = [];
  const missing = { mode: "unavailable", reason: "Error: Accessibility and Screen Recording required; grant access in System Settings and restart OpenMausBot" };
  const mac = await computer(t, { homes, places: [myCloud], screen: () => true, cuaConnection: async () => missing, askForScreen: connection => asked.push(connection) });
  mac.sharing.start();
  await until(() => homes[HOME].connects.length === 1, "lending to start");
  assert.equal(homes[HOME].connects[0].computer, true, "lent, so the first bot to need it can have macOS ask");
  homes[HOME].push({ action: "computer_tools" });
  await until(() => homes[HOME].results.length === 1, "the answer");
  assert.deepEqual(asked, [missing]);
  assert.match(homes[HOME].results[0].content[0].text, /allow Accessibility and Screen Recording for OpenMausBot in System Settings/);
});

test("the move's project folders are lent to My Cloud with editing on top; while paused the move is told to try later", async t => {
  const homes = { [HOME]: cloudHome(), [OTHER]: cloudHome() };
  const mac = await computer(t, { homes, places: [myCloud, clientA] });
  const app = path.join(mac.dir, "App");
  await mkdir(app);
  mac.sharing.start();
  await until(() => homes[HOME].connects.length === 1 && homes[OTHER].connects.length === 1, "lending to start");
  await mac.sharing.lendProjects([app, path.join(mac.dir, "Gone")]);
  await until(() => homes[HOME].connects.length === 2, "the projects to reach My Cloud");
  assert.deepEqual(homes[HOME].connects[1].folders.map(folder => [folder.name, folder.write]), [["App", true]]);
  await delay(100);
  assert.equal(homes[OTHER].connects.length, 1, "only My Cloud gets the move's projects");
  mac.sharing.pause();
  await assert.rejects(mac.sharing.lendProjects([app]), /waits/);
});

test("the menu-bar item: which Clouds are using this Mac, Pause or Resume, See activity, and nothing else to set", () => {
  const trays = [];
  class Tray {
    constructor() { this.destroyed = false; trays.push(this); }
    on() {} setToolTip(value) { this.tip = value; } setTitle(value) { this.title = value; }
    setContextMenu(menu) { this.menu = menu; } isDestroyed() { return this.destroyed; } destroy() { this.destroyed = true; }
  }
  const clicked = [];
  const indicator = createLendingIndicator({ Tray, Menu: { buildFromTemplate: items => items }, nativeImage: { createFromPath: () => ({ resize: () => ({}) }) }, iconPath: "icon.png",
    onPause: () => clicked.push("pause"), onResume: () => clicked.push("resume"), onActivity: () => clicked.push("activity"), device: "Mac" });
  const labels = () => trays.at(-1).menu.map(item => item.type === "separator" ? "-" : item.label);
  indicator.update({ clouds: [], using: [], paused: false });
  assert.equal(trays.length, 0, "nothing in the menu bar without a Cloud of the person's own");
  indicator.update({ clouds: ["My Cloud", "Client A"], using: [], paused: false });
  assert.deepEqual(labels(), ["My Cloud and Client A can use this Mac", "-", "Pause", "See activity"]);
  assert.equal(trays[0].title, "");
  indicator.update({ clouds: ["My Cloud", "Client A"], using: ["Client A"], paused: false });
  assert.equal(trays.length, 1);
  assert.deepEqual(labels(), ["Client A is using this Mac", "-", "Pause", "See activity"]);
  assert.equal(trays[0].title, "Client A is using this Mac");
  assert.equal(trays[0].tip, "OpenMausBot: Client A is using this Mac");
  trays[0].menu.find(item => item.label === "Pause").click();
  trays[0].menu.find(item => item.label === "See activity").click();
  indicator.update({ clouds: ["My Cloud"], using: [], paused: true });
  assert.deepEqual(labels(), ["Paused: My Cloud can't use this Mac", "-", "Resume", "See activity"]);
  assert.equal(trays[0].title, "Paused");
  trays[0].menu.find(item => item.label === "Resume").click();
  assert.deepEqual(clicked, ["pause", "activity", "resume"]);
  assert.ok(trays[0].menu.every(item => item.type !== "checkbox"), "no switch in it");
  indicator.update({ clouds: [], using: [], paused: true });
  assert.equal(trays[0].destroyed, true, "gone once there is no Cloud to resume");
  assert.deepEqual(indicatorText({ clouds: ["A", "B", "C"], using: ["A", "B", "C"], paused: false }, "PC"),
    { line: "A, B and C are using this PC", title: "3 Clouds are using this PC" });
});

test("See activity shows this computer's own record in the app's language: every value escaped, no script, nothing loaded", async () => {
  const entries = [
    { at: Date.UTC(2026, 9, 28, 14, 2), server: "Client <A>", origin: OTHER, action: "read_file", detail: "Notes/<img src=x onerror=alert(1)>.md", ok: true },
    { at: Date.UTC(2026, 9, 28, 14, 3), server: "My Cloud", origin: HOME, action: "run_command", detail: "rm -rf ~", ok: false, error: "Terminal access is not enabled for this server" },
  ];
  const page = activityPage(entries, "de");
  assert.doesNotMatch(page, /<script|<img/i);
  assert.match(page, /Notes\/&lt;img src=x onerror=alert\(1\)&gt;\.md/);
  assert.match(page, /Client &lt;A&gt;/);
  assert.match(page, /default-src 'none'/);
  assert.match(page, new RegExp(WORDS.de["lending.action.readFile"]));
  assert.match(page, /class="refused"/);
  assert.match(activityPage([], "en"), new RegExp(WORDS.en["lending.activity.empty"].replace(/[.]/g, "\\.")));
  const windows = [];
  class BrowserWindow {
    constructor(options) { this.options = options; this.loaded = []; this.handlers = {}; this.destroyed = false; this.webContents = { setWindowOpenHandler: handler => { this.opener = handler; }, on: (event, handler) => { this.handlers[event] = handler; } }; windows.push(this); }
    once() {} on() {} show() { this.shown = true; } focus() {} isDestroyed() { return this.destroyed; } close() { this.destroyed = true; }
    loadURL(url) { this.loaded.push(url); return Promise.resolve(); }
  }
  const activity = createActivityWindow({ BrowserWindow, icon: "icon.png", background: () => "#000", entries: () => entries, locale: () => "en" });
  activity.show();
  activity.show();
  assert.equal(windows.length, 1, "one window at a time");
  const [win] = windows;
  assert.deepEqual({ javascript: win.options.webPreferences.javascript, sandbox: win.options.webPreferences.sandbox, node: win.options.webPreferences.nodeIntegration },
    { javascript: false, sandbox: true, node: false });
  assert.equal(win.loaded.length, 2, "opening it again shows what was recorded since");
  assert.ok(win.loaded.every(url => url.startsWith("data:text/html;charset=utf-8,")));
  assert.deepEqual(win.opener(), { action: "deny" });
  let prevented = false;
  win.handlers["will-navigate"]({ preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
});

test("the activity window says what every language pack says, word for word", async () => {
  const dir = fileURLToPath(new URL("../src/locales/", import.meta.url));
  const en = JSON.parse(await readFile(path.join(dir, "en.json"), "utf8"));
  const keys = Object.keys(en).filter(key => key.startsWith("lending.activity.") || key.startsWith("lending.action."));
  assert.deepEqual(keys.sort(), Object.keys(WORDS.en).sort(), "every key main uses is in the catalog, and only those");
  for (const file of (await readdir(dir)).filter(name => name.endsWith(".json") && name !== "source-hashes.json")) {
    const locale = file.slice(0, -".json".length);
    const pack = JSON.parse(await readFile(path.join(dir, file), "utf8"));
    assert.ok(WORDS[locale], `${locale}: main has no words for it`);
    for (const key of keys) assert.equal(WORDS[locale][key], pack[key] ?? en[key], `${locale} ${key}: copy src/locales/${file} into electron/lending-words.mjs`);
  }
});
