import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import { cloudPlanSnapshot } from "./cloud-account.mjs";
import { installCloudPlanIpc } from "./cloud-plan-ipc.mjs";
import { cloudPageSenderAllowed, myCloudOrigin } from "./cloud-home.mjs";
import { otherOwnClouds } from "./cloud-list.mjs";
import environments from "./environments.cjs";
import localOrigin from "./local-origin.cjs";
import { HOME_SCREEN_PATH, homeOf, installHomeWindowIpc, LOOK_MS, placeOf, QUIET_MS, routeOf, SPLASH_TEXT, splashText, TEAM_RENEW_EARLY_MS, TEAM_RENEW_MS, TEAM_RENEW_RETRY_MS, UPDATING_MS } from "./home-window.mjs";
import { ACCOUNT, ACME, CLIENT, CLIENT_A, CLOUD, connected, done, LOCAL, TEAM, world } from "./fixtures/home-window-world.mjs";

test("home is My Cloud only once the move switched and the same account is signed in; anything else is this computer or the sign-in screen", () => {
  assert.deepEqual(homeOf({}), { kind: "computer" }, "no Cloud: nothing changes");
  assert.deepEqual(homeOf({ state: connected() }), { kind: "computer" }, "a Cloud the move hasn't reached is still not home");
  for (const phase of ["copy", "wait", "freeze", "final", "check", "home-again", "back"]) {
    assert.deepEqual(homeOf({ journal: { ...done(), phase }, state: connected() }), { kind: "computer" }, phase);
  }
  for (const phase of ["switch", "done"]) assert.deepEqual(homeOf({ journal: { ...done(), phase }, state: connected() }), { kind: "cloud", origin: CLOUD }, phase);
  assert.deepEqual(homeOf({ journal: done(), state: { ...connected(), account: { id: "acct-2" } } }), { kind: "signin", other: true }, "another account never sees this computer's copy");
  for (const state of [null, { status: "signed-out" }, { status: "connecting" }, { status: "signed-out", account: ACCOUNT }]) {
    assert.deepEqual(homeOf({ journal: done(), state }), { kind: "signin" }, JSON.stringify(state));
  }
  assert.deepEqual(homeOf({ journal: done(), state: { status: "reauth-required", account: ACCOUNT } }), { kind: "cloud", origin: CLOUD }, "an ended grant still opens My Cloud on the window's own session");
  assert.deepEqual(homeOf({ journal: done(), state: { status: "unavailable", account: ACCOUNT } }), { kind: "cloud", origin: CLOUD }, "the Admin not answering is not a sign-out");
  assert.deepEqual(homeOf({ journal: done(), state: connected({ hold: { until: 9 } }) }), { kind: "computer" }, "My Cloud ended: everything comes home");
});

test("a frozen copy with its journal lost counts as moved, to the Cloud it names or the account's own", () => {
  assert.deepEqual(homeOf({ frozenCloud: CLOUD, state: connected() }), { kind: "cloud", origin: CLOUD });
  assert.deepEqual(homeOf({ frozenCloud: true, state: connected() }), { kind: "cloud", origin: CLOUD });
  assert.deepEqual(homeOf({ frozenCloud: "https://omb-t-2.fly.dev", state: connected() }), { kind: "signin", other: true });
  assert.deepEqual(homeOf({ frozenCloud: true, state: { status: "unavailable", account: ACCOUNT } }), { kind: "signin" }, "no Cloud to name: the sign-in screen, never the frozen copy");
  assert.deepEqual(homeOf({ frozenCloud: CLOUD, state: null }), { kind: "signin" });
  assert.deepEqual(homeOf({ journal: { ...done(), phase: "freeze" }, frozenCloud: CLOUD, state: connected() }), { kind: "computer" }, "a move under way is not a move done");
});

test("a server of the person's own their bots moved to is no Cloud: no sign-in, the window shows it as any saved server, and the frozen screen names it", async () => {
  const garage = "https://garage.example.test";
  const w = world({ journal: null, marker: { frozen: true, cloud: garage, place: "Garage server" }, state: { status: "signed-out" }, url: `${garage}/` });
  await w.home.show();
  assert.deepEqual([w.local, w.went, w.fetched, w.pairs], [[false], [], [], 0], "never the sign-in screen, nor any Cloud or the Admin asked");
  assert.equal(w.home.cloudOrigin(), null);
  const moving = world({ journal: null, marker: { frozen: true, cloud: garage, place: "Garage server" }, state: { status: "signed-out" }, ownMove: { phase: "final", name: "Garage server" } });
  assert.deepEqual(moving.home.view(), { screen: "moving", name: "Garage server" });
  moving.ownMove = { phase: "copy", name: "Garage server" };
  assert.deepEqual(moving.home.view(), { screen: "opening" }, "still home here: nothing is stopped yet");
});

test("a sign-in keeps only a path of My Cloud's own", () => {
  assert.equal(routeOf(`${CLOUD}/chats/b1?view=2#x`, CLOUD), "/chats/b1?view=2");
  assert.equal(routeOf(`${CLOUD}/`, CLOUD), null);
  assert.equal(routeOf(`${CLOUD}/pair#code=AAAA-BBBB-CCCC`, CLOUD), null);
  assert.equal(routeOf("https://evil.example.test/chats", CLOUD), null);
  assert.equal(routeOf("not a url", CLOUD), null);
});


test("no Cloud: the window is this computer's as before, and nothing asks any Cloud or the Admin", async () => {
  const w = world({ journal: null, state: { status: "signed-out" }, url: `${LOCAL}/` });
  await w.home.show();
  assert.deepEqual(w.local, [false]);
  assert.deepEqual([w.went, w.fetched, w.pairs, w.wakes, w.splash], [[], [], 0, 0, []]);
  assert.equal(w.home.cloudOrigin(), null);
  const paid = world({ journal: null, state: connected(), url: "https://bots.example.test/" });
  await paid.home.show();
  assert.deepEqual([paid.local, paid.went, paid.fetched], [[false], [], []], "a Cloud the move hasn't reached changes nothing either, nor the saved server the window shows");
});

test("launching with My Cloud awake: a quick look, then My Cloud's page on the window's own session", async () => {
  const w = world();
  await w.home.show();
  assert.deepEqual(w.fetched, [["/api/health", "1"], ["/api/auth/session", null]], "the look never counts as someone using My Cloud");
  assert.deepEqual(w.went, [[CLOUD, CLOUD]]);
  assert.equal(w.pairs, 0);
  assert.deepEqual(w.splash, [SPLASH_TEXT.opening]);
  assert.equal(w.home.cloudOrigin(), CLOUD);
  w.fetched.length = 0;
  await w.home.show();
  assert.deepEqual([w.went.length, w.fetched], [1, []], "a window already on My Cloud is only brought forward");
});

test("a window that showed My Cloud as a saved server before the move is opened again as home, and goes home when My Cloud ends", async () => {
  // Seen in the real app on Oct 22: with moves off, the person opened My Cloud from the switcher; after the move the
  // window kept "Hosted: My Cloud", the switcher and "This computer", and when My Cloud ended it stayed on the ended Cloud.
  const w = world({ url: `${CLOUD}/` });
  await w.home.show({ place: "cloud" });
  assert.equal(w.went.length, 1, `opened as home, not left as the saved server it was: ${JSON.stringify(w.went)}`);
  w.state = connected({ hold: { until: 9 } });
  w.journal = { ...done(), phase: "home-again" };
  await w.home.show();
  assert.equal(w.local.at(-1), true, "My Cloud ended: the window leaves it for this computer");
});

test("launching with My Cloud asleep says Waking My Cloud… and wakes it through the Admin, never by a look, then shows the page", async () => {
  const w = world({ power: { state: "asleep", since: 1, sleeps: true } });
  await w.home.show();
  assert.deepEqual(w.splash, [SPLASH_TEXT.waking]);
  assert.equal(w.wakes, 1);
  assert.equal(w.fetched.some(([route]) => route === "/api/health"), false, "a sleeping Cloud is never looked at");
  assert.deepEqual(w.went, [[CLOUD, CLOUD]]);
  assert.ok(w.calls.includes("woke"));
});

test("a lapsed cookie: a new session from the Admin's one-time code, so the page never asks for one", async () => {
  const w = world({ cloud: { signedIn: false } });
  await w.home.show();
  assert.equal(w.pairs, 1);
  assert.deepEqual(w.went, [[`${CLOUD}/pair#code=AAAA-BBBB-CCCC`, CLOUD]]);
});

test("a session that ends while the page is open is renewed by itself, back on the same page", async () => {
  const w = world();
  await w.home.show();
  w.url = `${CLOUD}/chats/b1`;
  w.cloud.signedIn = false;
  w.home.responded({ url: `${CLOUD}/api/bots`, statusCode: 401, webContentsId: 7 });
  await w.home.repair();
  assert.deepEqual(w.went.at(-1), [`${CLOUD}/pair?next=%2Fchats%2Fb1#code=AAAA-BBBB-CCCC`, CLOUD]);
  const pairs = w.pairs;
  for (const details of [{ url: `${CLOUD}/api/bots`, statusCode: 401, webContentsId: 8 }, { url: "https://other.example.test/api/bots", statusCode: 401, webContentsId: 7 },
    { url: `${CLOUD}/api/bots`, statusCode: 403, webContentsId: 7 }, { url: `${CLOUD}/assets/x.js`, statusCode: 401, webContentsId: 7 }]) {
    w.home.responded(details);
    await w.later(0);
  }
  assert.equal(w.pairs, pairs, "another window, another server, another status or a file is not this session ending");
  w.cloud.signedIn = true;
  w.home.responded({ url: `${CLOUD}/api/bots`, statusCode: 401, webContentsId: 7 });
  await w.later(0);
  assert.equal(w.pairs, pairs, "still signed in: a 401 of some other kind changes nothing");
  w.cloud.signedIn = false;
  w.home.navigated(`${CLOUD}/pair`);
  await w.later(0);
  assert.equal(w.pairs, pairs + 1, "landing on My Cloud's own sign-in page signs in again by itself");
  w.state = { status: "reauth-required", message: "access-ended", account: ACCOUNT };
  await w.home.repair();
  assert.deepEqual(w.home.view(), { screen: "signin" }, "no code because this device's sign-in ended: the one Sign in, not the offline screen");
  w.state = connected(); w.cloud.down = true;
  await w.home.refresh();
  await w.home.repair();
  assert.equal(w.home.view().screen, "offline", "no code because nothing answered: the offline screen");
});

test("an ended Admin grant opens My Cloud while its session lasts, and shows the one Sign in when it doesn't", async () => {
  const w = world({ state: { status: "reauth-required", account: ACCOUNT, lastPlan: { tier: "pro", active: true } } });
  await w.home.show();
  assert.deepEqual(w.went, [[CLOUD, CLOUD]], "the window's own session still works");
  const lapsed = world({ state: { status: "reauth-required", account: ACCOUNT }, cloud: { signedIn: false } });
  await lapsed.home.show();
  assert.deepEqual(lapsed.went, [[`${LOCAL}${HOME_SCREEN_PATH}`, null]]);
  assert.deepEqual(lapsed.home.view(), { screen: "signin" });
  await lapsed.home.signIn();
  assert.deepEqual(lapsed.signIns, ["again"]);
  const out = world({ state: { status: "signed-out" } });
  await out.home.show();
  assert.deepEqual([out.went, out.home.view(), out.fetched], [[[`${LOCAL}${HOME_SCREEN_PATH}`, null]], { screen: "signin" }, []], "signed out: the sign-in screen, never the frozen copy");
  await out.home.signIn();
  assert.deepEqual(out.signIns, ["begin"]);
  out.state = connected();
  await out.home.changed();
  assert.deepEqual(out.went.at(-1), [CLOUD, CLOUD], "signed in again: My Cloud opens by itself");
});

test("another account: the sign-in screen says so, and My Cloud is never opened for it", async () => {
  const w = world({ state: { ...connected(), account: { id: "acct-2", email: "else@example.test" } } });
  await w.home.show();
  assert.deepEqual(w.home.view(), { screen: "signin", other: true });
  assert.deepEqual([w.fetched, w.pairs], [[], 0]);
});

test("with the network down the offline screen shows at once, with the Admin's reason, and goes away by itself", async () => {
  const w = world({ state: connected({ unreachable: { cause: "host", since: 1 } }), cloud: { down: true } });
  const started = Date.now();
  await w.home.show();
  assert.ok(Date.now() - started < LOOK_MS);
  assert.deepEqual(w.went, [[`${LOCAL}${HOME_SCREEN_PATH}`, null]]);
  const view = w.home.view();
  assert.equal(view.screen, "offline");
  assert.match(view.reason, /being restarted by our hosting provider/);
  assert.deepEqual([w.fetched, w.pairs], [[["/api/health", "1"]], 0], "a My Cloud that fails the look is asked nothing else, and never paired");
  assert.deepEqual(w.published.at(-1), view, "the screen is told");
  w.url = `${LOCAL}${HOME_SCREEN_PATH}`;
  await w.later(2_000);
  assert.equal(w.went.length, 1, "still down: it stays, and looks again later");
  w.cloud.down = false;
  await w.later(4_000);
  assert.deepEqual(w.went.at(-1), [CLOUD, CLOUD], "back: My Cloud's page, with nothing pressed");
  assert.equal(w.home.view().screen, "opening");
  w.url = `${CLOUD}/`;
  const moves = w.went.length;
  w.home.failed("https://other.example.test/");
  assert.deepEqual([w.home.view().screen, w.went.length], ["opening", moves], "another server failing to load is not My Cloud failing");
  w.home.failed(`${CLOUD}/chats`);
  assert.equal(w.home.view().screen, "offline", "My Cloud's page failing to load is the same screen");
  assert.deepEqual(w.went.at(-1), [`${LOCAL}${HOME_SCREEN_PATH}`, null]);
});

test("a plan problem shows the Admin's state and never knocks on My Cloud", async () => {
  for (const status of ["stopped", "payment-problem", "failed"]) {
    const w = world({ state: connected({ status }) });
    await w.home.show();
    assert.deepEqual(w.home.view(), { screen: "plan", machine: status }, status);
    assert.deepEqual(w.fetched, [], status);
  }
});

test("while home is My Cloud the startup screen says Opening My Cloud…, whichever screen comes next; otherwise it keeps its own words", async () => {
  for (const [state, cloud] of [[connected({ status: "stopped" }), {}], [{ status: "signed-out" }, {}], [connected(), { down: true }], [connected(), {}]]) {
    const w = world({ state, cloud });
    await w.home.show();
    assert.deepEqual(w.splash, [SPLASH_TEXT.opening], `${JSON.stringify(state)} ${JSON.stringify(cloud)}`);
  }
  for (const w of [world({ journal: null }), world({ state: connected({ hold: { until: 9 } }) }), world({ journal: { ...done(), phase: "copy" } })]) {
    await w.home.show();
    assert.deepEqual(w.splash, [], "home is this computer");
  }
});

test("a slow wake never moves the window after a newer request; a long one hands the startup screen to this computer's", async () => {
  let woken;
  const w = world({ power: { state: "asleep", since: 1, sleeps: true }, cloud: { wakeGate: new Promise((resolve) => { woken = resolve; }) } });
  const waking = w.home.show();
  await w.later(0);
  assert.deepEqual(w.went, [], "the startup screen says it first");
  await w.later(6_000);
  assert.deepEqual(w.went, [[`${LOCAL}${HOME_SCREEN_PATH}`, null]], "the screen says Waking My Cloud… once the startup screen has been up long enough");
  assert.equal(w.home.view().screen, "waking");
  woken();
  await waking;
  assert.deepEqual(w.went.at(-1), [CLOUD, CLOUD], "then the page");
  let release;
  const settled = world({ power: { state: "asleep", since: 1, sleeps: true }, cloud: { wakeGate: new Promise((resolve) => { release = resolve; }) } });
  const first = settled.home.show();
  await new Promise((resolve) => setImmediate(resolve));
  settled.journal = { ...done(), phase: "home-again" };
  const second = settled.home.show();
  release();
  await Promise.all([first, second]);
  assert.deepEqual(settled.went.filter(([, origin]) => origin === CLOUD), [], "the newer request (this computer, home again) wins");
  assert.deepEqual(settled.local, [true]);
});

test("a newer My Cloud page reloads at a quiet moment; an asleep My Cloud is never asked", async () => {
  const w = world();
  await w.home.show();
  w.home.navigated(`${CLOUD}/`);
  await w.tick();
  w.cloud.version = "0.1.131";
  w.typed = w.clock;
  await w.tick();
  assert.equal(w.reloads, 0, "the person is typing");
  w.clock += QUIET_MS;
  await w.tick();
  assert.equal(w.reloads, 1);
  await w.tick();
  assert.equal(w.reloads, 1, "once");
  w.power = { state: "asleep", since: 2 };
  const asked = w.fetched.length;
  w.cloud.version = "0.1.132";
  w.clock += QUIET_MS;
  await w.tick();
  assert.deepEqual([w.fetched.length, w.reloads], [asked, 1]);
});

test("My Cloud's page that the window reloaded for its newer version learns it once, as it loads, to say Updating My Cloud…", async () => {
  const w = world();
  await w.home.show();
  const listeners = new Map();
  installHomeWindowIpc({ ipcMain: { handle() {}, on: (channel, listener) => listeners.set(channel, listener) }, homeWindow: w.home, cloudPage: () => null });
  const asks = (event = { sender: w.contents, senderFrame: w.contents.mainFrame }) => { listeners.get("home:updating")(event); return event.returnValue; };
  w.url = `${CLOUD}/`;
  w.home.navigated(w.url);
  await w.tick();
  assert.equal(asks(), false, "a page that loads for any other reason");
  w.cloud.version = "0.1.131";
  w.clock += QUIET_MS;
  await w.tick();
  assert.equal(w.reloads, 1);
  assert.equal(asks({ sender: {}, senderFrame: w.contents.mainFrame }), false, "another window is never told");
  assert.equal(asks(), true, "the reloaded page");
  assert.equal(asks(), false, "once");
  w.cloud.version = "0.1.132";
  w.clock += QUIET_MS;
  await w.tick();
  assert.equal(w.reloads, 2);
  w.clock += UPDATING_MS;
  assert.equal(asks(), false, "a page that loads long after is not that version");
});

test("My Cloud ending brings the window back to this computer's page", async () => {
  const w = world();
  await w.home.show();
  w.state = connected({ hold: { until: 9 } });
  await w.home.changed();
  assert.deepEqual(w.local, [true]);
  assert.equal(w.home.cloudOrigin(), null);
});

test("a change of home is told once as it happens: My Cloud after the move, this computer when My Cloud ends", async () => {
  const w = world();
  w.rehomeThrows = true;
  await w.home.show();
  await w.home.show();
  assert.deepEqual(w.rehomes, [{ kind: "cloud", origin: CLOUD }], "a listener that throws never stops the window");
  assert.equal(w.home.cloudOrigin(), CLOUD);
  w.state = connected({ hold: { until: 9 } });
  await w.home.changed();
  assert.deepEqual(w.rehomes, [{ kind: "cloud", origin: CLOUD }, { kind: "computer" }]);
  const never = world({ journal: null, state: { status: "signed-out" } });
  await never.home.show();
  await never.home.refresh();
  assert.deepEqual(never.rehomes, [], "no move: home stays this computer");
});

test("only the main window's main frame counts, at My Cloud's origin for its page and this computer's for the screen", async () => {
  const w = world();
  await w.home.show();
  const frame = w.contents.mainFrame;
  w.url = `${CLOUD}/`;
  assert.equal(w.home.homePage({ sender: w.contents, senderFrame: frame }), true);
  assert.equal(w.home.homePage({ sender: w.contents, senderFrame: { url: `${CLOUD}/` } }), false, "a subframe");
  assert.equal(w.home.homePage({ sender: {}, senderFrame: frame }), false, "another window");
  assert.equal(w.home.screenPage({ sender: w.contents, senderFrame: frame }), false);
  w.url = `${LOCAL}${HOME_SCREEN_PATH}`;
  assert.equal(w.home.homePage({ sender: w.contents, senderFrame: frame }), false);
  assert.equal(w.home.screenPage({ sender: w.contents, senderFrame: frame }), true);
  w.state = { status: "signed-out" };
  w.url = `${CLOUD}/`;
  await w.home.refresh();
  assert.equal(w.home.homePage({ sender: w.contents, senderFrame: frame }), false, "signed out, My Cloud's page is no longer this app's");
});

test("the window's IPC: the screen reads and retries, My Cloud's page renews its session, either signs in again", async () => {
  const w = world();
  await w.home.show();
  const handlers = new Map(), listeners = new Map();
  installHomeWindowIpc({ ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), on: (channel, listener) => listeners.set(channel, listener) },
    homeWindow: w.home, cloudPage: (event) => event.cloudPage ?? null });
  const frame = w.contents.mainFrame, page = { sender: w.contents, senderFrame: frame };
  w.url = `${CLOUD}/`;
  const sync = (event) => { listeners.get("home:page")(event); return event.returnValue; };
  assert.equal(sync({ ...page }), true);
  assert.equal(sync({ sender: {}, senderFrame: frame }), false);
  assert.throws(() => handlers.get("home:state")(page), /only available/);
  assert.throws(() => handlers.get("home:retry")(page), /only available/);
  await handlers.get("home:repair")(page);
  w.url = `${LOCAL}${HOME_SCREEN_PATH}`;
  assert.deepEqual(handlers.get("home:state")(page), { screen: "opening" });
  assert.throws(() => handlers.get("home:repair")(page), /only available/);
  await handlers.get("home:sign-in")(page);
  w.url = "https://other.example.test/";
  assert.throws(() => handlers.get("home:sign-in")(page), /only available/);
  await handlers.get("home:sign-in")({ ...page, cloudPage: "cloud" });
  assert.deepEqual(w.signIns, ["begin", "begin"]);
});

const PRELOAD = readFileSync(new URL("./preload.cjs", import.meta.url), "utf8");
function preload(origin, { home = false, activation = false } = {}) {
  let bridge; const invoked = [], synced = [], listeners = new Map();
  vm.runInNewContext(PRELOAD, {
    process: { platform: "darwin", argv: [`--omb-local-origin=${LOCAL}`, "--omb-company-desktop=1"] },
    location: { origin }, navigator: { userActivation: { isActive: activation } }, TextEncoder, localStorage: { getItem: () => null },
    queueMicrotask,
    require: () => ({ webUtils: {}, contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } },
      ipcRenderer: { on: (channel, listener) => listeners.set(channel, listener), removeListener() {}, send() {}, sendSync: (channel) => { synced.push(channel); return channel === "home:page" ? home : null; },
        invoke: (...args) => { invoked.push(args); return Promise.resolve(); } } }),
  });
  const tell = (channel, ...args) => listeners.get(channel)?.({}, ...args);
  return { bridge, invoked, synced, tell };
}

test("My Cloud's own page, once it is home, gets this app's chat links, diagnostics and its session renewal; any other server's page doesn't", async () => {
  const keys = ["home", "onChatLink", "onPackageInstall", "exportDiagnostics", "openLogsFolder"];
  const home = preload(CLOUD, { home: true });
  for (const key of keys) assert.ok(home.bridge[key], key);
  assert.ok(home.synced.includes("home:page"));
  assert.equal(home.bridge.home.updating, false);
  assert.ok(home.synced.includes("home:updating"), "My Cloud's page asks once whether it was reloaded for its newer version");
  for (const key of ["cloudAccount", "companion", "environments", "credential", "setCredential", "saveFile", "revealInFolder", "pickFolder"]) assert.equal(home.bridge[key], undefined, key);
  await home.bridge.home.repair();
  await assert.rejects(home.bridge.home.signIn(), /Choose Sign in/, "only from the person's click");
  await assert.rejects(home.bridge.cloudPlan.signIn(), /Choose Sign in/);
  const clicked = preload(CLOUD, { home: true, activation: true });
  await clicked.bridge.home.signIn(); await clicked.bridge.cloudPlan.signIn();
  assert.deepEqual([...home.invoked, ...clicked.invoked].map(([channel]) => channel), ["home:repair", "home:sign-in", "home:sign-in"]);
  const other = preload("https://bots.example.test", { home: false });
  for (const key of keys) assert.equal(other.bridge[key], undefined, key);
  for (const page of [home, other]) {
    const opened = [];
    page.bridge.onOpenAppSettings(section => opened.push(section ?? "settings"));
    page.tell("app:open-settings");
    assert.deepEqual(opened, ["settings"], "the app menu's Settings reaches every server's page");
  }
  const local = preload(LOCAL);
  for (const key of keys) assert.ok(local.bridge[key], key);
  assert.equal(local.synced.includes("home:page"), false, "this computer's page never needs to ask");
  assert.equal(local.synced.includes("home:updating"), false);
  assert.equal(local.bridge.home.updating, false);
  await local.bridge.home.retry(); await local.bridge.home.state(); await local.bridge.home.signIn();
  assert.deepEqual(local.invoked.map(([channel]) => channel), ["home:retry", "home:state", "home:sign-in"]);
});

test("only the verified Cloud, open as this window's active server, counts as the Cloud page", () => {
  const frame = { url: `${CLOUD}/` }, contents = { mainFrame: frame };
  const context = { contents, homeOrigin: CLOUD, activeOrigin: CLOUD };
  assert.equal(cloudPageSenderAllowed({ sender: contents, senderFrame: frame }, context), true);
  assert.equal(cloudPageSenderAllowed({ sender: contents, senderFrame: { url: `${CLOUD}/` } }, context), false, "a subframe");
  assert.equal(cloudPageSenderAllowed({ sender: {}, senderFrame: frame }, context), false, "another window");
  assert.equal(cloudPageSenderAllowed({ sender: contents, senderFrame: frame }, { ...context, activeOrigin: "https://other.example.test" }), false);
  assert.equal(cloudPageSenderAllowed({ sender: contents, senderFrame: frame }, { ...context, homeOrigin: null }), false, "signed out of Cloud");
  const evil = { url: "https://evil.example.test/" }, evilContents = { mainFrame: evil };
  assert.equal(cloudPageSenderAllowed({ sender: evilContents, senderFrame: evil }, { contents: evilContents, homeOrigin: CLOUD, activeOrigin: CLOUD }), false);
});

const MAIN = readFileSync(new URL("./main.mjs", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const PAGE_IPC = MAIN.slice(MAIN.indexOf("function myCloud() {"), MAIN.indexOf("const savedWorkspace = id =>"));

const plain = (value) => JSON.parse(JSON.stringify(value));
function pageIpc(overrides = {}) {
  const handlers = new Map(), calls = [];
  const localFrame = { url: `${LOCAL}/` }, localContents = { mainFrame: localFrame };
  const cloudFrame = { url: `${CLOUD}/` }, cloudContents = { mainFrame: cloudFrame };
  localOrigin.setLocalOrigin(LOCAL);
  const account = { status: "connected", account: { id: "a1", email: "person@example.test" }, deviceId: "d1",
    entitlement: { plan: "pro", tier: "max", status: "active", expiresAt: 1, version: 1 }, machine: { status: "ready", origin: CLOUD } };
  const context = vm.createContext({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), on: () => {} },
    senderIsLocal: localOrigin.isLocalSender, workspaceSenderAllowed: environments.workspaceSenderAllowed, cloudPageSenderAllowed, otherOwnClouds,
    activeEnvironment: environments.activeEnvironment, rendererOrigin: () => LOCAL, desktopRemoteAccess: false,
    mainWindow: { isDestroyed: () => false, webContents: cloudContents },
    environmentsState: { environments: [{ id: "cloud", name: "My Cloud", origin: CLOUD }], activeId: "cloud" },
    cloudAccount: { homeTarget: () => ({ origin: CLOUD }), state: () => account, isOwnCloud: (origin) => origin === CLOUD }, cloudPlanSnapshot, installCloudPlanIpc, myCloudOrigin, rememberedHome: null,
    cloudTrialNotices: () => ({ due: () => null, seen: (...args) => { calls.push(["notice-seen", ...args]); } }),
    ensureCloudAccount: () => ({ openDashboard: async () => { calls.push(["dashboard"]); return account; }, state: () => account,
      upgradePreview: async (...args) => { calls.push(["upgrade-preview", ...args]); return { outcome: "failed" }; },
      upgrade: async (...args) => { calls.push(["upgrade", ...args]); return { outcome: "failed" }; },
      cancelPlan: async (...args) => { calls.push(["cancel", ...args]); return { outcome: "failed" }; },
      keepPlan: async (...args) => { calls.push(["keep", ...args]); return { outcome: "failed" }; },
      roomNotNow: async (...args) => { calls.push(["room-not-now", ...args]); return true; },
      restartNow: async (...args) => { calls.push(["restart-now", ...args]); return "restarting"; } }),
    homeWindow: { homePage: () => false },
    ...overrides,
  });
  vm.runInContext(PAGE_IPC, context);
  return { handlers, calls, context, account, localContents, localFrame, cloudContents, cloudFrame };
}

test("no page gets a control over lending this computer: not My Cloud's, another Cloud's or this computer's own, and main handles none", async () => {
  for (const origin of [CLOUD, "https://omb-c-a.fly.dev", LOCAL]) {
    const page = preload(origin, { activation: true });
    assert.equal(page.bridge.cloudLending, undefined, origin);
    assert.equal(page.bridge.cloudAccount?.lending, undefined, origin);
  }
  assert.deepEqual(MAIN.match(/ipcMain\.handle\("(?:cloud-)?lending:[^"]*"/g), null, "no lending channel at all");
});

test("Settings on the person's own Cloud shows the plan read only, says when it is home, and can open the Plan page or sign in again; never switch away", async () => {
  const page = preload(CLOUD);
  assert.deepEqual(Object.keys(page.bridge.cloudPlan), ["state", "manage", "signIn", "noticeSeen", "upgradePreview", "upgrade", "cancel", "keep", "roomNotNow", "restartNow"]);
  assert.equal(page.bridge.cloudAccount, undefined, "no account, credential or address reaches the Cloud's page");
  await page.bridge.cloudPlan.state({ origin: "https://evil.example.test" });
  await assert.rejects(page.bridge.cloudPlan.manage(), /Choose Manage/);
  const ipc = pageIpc();
  const event = { sender: ipc.cloudContents, senderFrame: ipc.cloudFrame };
  assert.deepEqual(Object.keys(Object.fromEntries(ipc.handlers)), ["cloud-plan:state", "cloud-plan:notice-seen", "cloud-plan:manage",
    "cloud-plan:upgrade-preview", "cloud-plan:upgrade", "cloud-plan:cancel", "cloud-plan:keep", "cloud-plan:room-not-now", "cloud-plan:restart-now"]);
  assert.deepEqual(plain(await ipc.handlers.get("cloud-plan:state")(event, { tier: "personal" })), { status: "paid", tier: "max" });
  ipc.context.homeWindow = { homePage: (asked) => asked === event };
  assert.deepEqual(plain(await ipc.handlers.get("cloud-plan:state")(event)), { status: "paid", tier: "max", home: true });
  await ipc.handlers.get("cloud-plan:manage")(event, "https://evil.example.test");
  assert.deepEqual(ipc.calls, [["dashboard"]]);
  for (const sender of [{ sender: ipc.cloudContents, senderFrame: { url: "https://other.example.test/" } }, { sender: {}, senderFrame: ipc.cloudFrame }]) {
    for (const channel of ["cloud-plan:state", "cloud-plan:manage", "cloud-plan:notice-seen"]) assert.throws(() => ipc.handlers.get(channel)(sender), /only available/);
  }
  let current = { status: "reauth-required", message: "expired", account: ipc.account.account, lastPlan: { tier: "max", active: true } };
  ipc.context.cloudAccount = { homeTarget: () => null, state: () => current, isOwnCloud: () => false };
  assert.throws(() => ipc.handlers.get("cloud-plan:state")(event), /only available/);
  ipc.context.rememberedHome = { accountId: "a1", origin: CLOUD };
  assert.deepEqual(plain(await ipc.handlers.get("cloud-plan:state")(event)), { status: "signin", tier: "max", home: true });
  current = { status: "unavailable", account: ipc.account.account, lastPlan: { tier: "max", active: true } };
  assert.deepEqual(plain(await ipc.handlers.get("cloud-plan:state")(event)), { status: "checking", tier: "max", home: true });
  ipc.context.rememberedHome = { accountId: "someone-else", origin: CLOUD };
  assert.throws(() => ipc.handlers.get("cloud-plan:state")(event), /only available/);
});

test("main shows the switcher at home only with somewhere else to go: My Cloud alone has none", () => {
  const start = MAIN.indexOf("const homeAlone = "), end = MAIN.indexOf("\n", start);
  assert.ok(start > 0 && end > start);
  const cloud = { id: "c", kind: "remote", name: "My Cloud", origin: CLOUD }, office = { id: "o", kind: "remote", name: "Office", origin: "https://office.example.test" };
  const context = vm.createContext({ homeWindow: { cloudOrigin: () => CLOUD }, otherPlaces: environments.otherPlaces, environmentsState: { environments: [cloud], activeId: "c" } });
  vm.runInContext(`${MAIN.slice(start, end)}; this.homeAlone = homeAlone;`, context);
  assert.equal(context.homeAlone(), true, "My Cloud alone: no switcher");
  context.environmentsState = { environments: [cloud, office], activeId: "c" };
  assert.equal(context.homeAlone(), false, "a saved server besides: the switcher lists both");
  context.environmentsState = { environments: [cloud, { id: "l", kind: "local", name: "Lab", dataDir: "/lab" }], activeId: "c" };
  assert.equal(context.homeAlone(), true, "a named folder of this computer is not a place once home is My Cloud");
  context.homeWindow = { cloudOrigin: () => null };
  assert.equal(context.homeAlone(), false, "no home: the switcher as before");
});

test("the place asked for: My Cloud unless a team is asked or remembered; a team is the session's, one the connected session no longer lists is gone, and one the Admin can't vouch for opens as saved", () => {
  const state = { ...connected(), teams: [ACME] };
  assert.deepEqual(placeOf({ state }), { kind: "cloud" });
  assert.deepEqual(placeOf({ ask: "cloud", remembered: { team: "team-acme" }, state }), { kind: "cloud" }, "asked for My Cloud: My Cloud");
  assert.deepEqual(placeOf({ ask: { team: "team-acme" }, state }), { kind: "team", id: "team-acme", name: "Acme", role: "member", origin: TEAM, machine: ACME.machine });
  assert.deepEqual(placeOf({ remembered: { team: "team-acme", name: "Old name", origin: "https://old.fly.dev" }, state }).origin, TEAM, "the session's address wins over the saved one");
  assert.deepEqual(placeOf({ ask: { team: "team-acme" }, state: { ...state, teams: [{ ...ACME, machine: null }] } }), { kind: "team", id: "team-acme", name: "Acme", role: "member", origin: null, machine: null });
  assert.deepEqual(placeOf({ remembered: { team: "team-acme", name: "Acme", origin: TEAM }, state: connected() }), { kind: "cloud", left: "Acme" }, "connected, not listed: gone, by name");
  assert.deepEqual(placeOf({ ask: { team: "team-acme", name: "Acme" }, state: connected() }), { kind: "cloud", left: "Acme" });
  assert.deepEqual(placeOf({ remembered: { team: "team-acme" }, state: connected() }), { kind: "cloud", left: null }, "gone, with no name to say");
  for (const state of [{ status: "unavailable", account: ACCOUNT }, { status: "reauth-required", account: ACCOUNT }, null]) {
    assert.deepEqual(placeOf({ remembered: { team: "team-acme", name: "Acme", origin: TEAM }, state }), { kind: "team", id: "team-acme", name: "Acme", role: null, origin: TEAM, machine: null }, JSON.stringify(state));
    assert.deepEqual(placeOf({ remembered: { team: "team-acme" }, state }), { kind: "cloud" }, "no saved address: My Cloud");
  }
  assert.equal(splashText("opening", "Acme"), "Opening Acme…");
  assert.equal(splashText("waking"), SPLASH_TEXT.waking);
});

test("choosing a team opens its Cloud through the Admin's team pairing, at the team's address, remembered for next time; My Cloud on request lets it go", async () => {
  const w = world({ state: { ...connected(), teams: [ACME] }, team: { signedIn: false } });
  await w.home.show({ place: { team: "team-acme" } });
  assert.deepEqual(w.teamPairs, ["team-acme"]);
  assert.equal(w.pairs, 0, "never My Cloud's pairing");
  assert.deepEqual(w.went, [[`${TEAM}/pair#code=TTTT-EEEE-AAAA`, TEAM, "team-acme"]]);
  assert.deepEqual(w.fetched, [["team:/api/health", "1"], ["team:/api/auth/session", null]], "a look at the team's Cloud, never My Cloud");
  assert.deepEqual(w.splash, ["Opening Acme…"]);
  assert.deepEqual(w.remembers, [{ team: "team-acme" }]);
  assert.deepEqual(w.home.shown(), { kind: "team", id: "team-acme", name: "Acme", role: "member", origin: TEAM, machine: ACME.machine });
  assert.equal(w.home.cloudOrigin(), CLOUD, "My Cloud stays the person's home");
  assert.equal(w.home.placeOrigin(), TEAM, "the window's page is the team's");
  assert.equal(w.wakes, 0, "a team's Cloud is never woken through the Admin");
  // Already there: only brought forward.
  w.fetched.length = 0;
  await w.home.show();
  assert.deepEqual([w.went.length, w.fetched], [1, []]);
  await w.home.show({ place: "cloud" });
  assert.deepEqual(w.went.at(-1), [CLOUD, CLOUD]);
  assert.deepEqual(w.remembers.at(-1), null);
  assert.equal(w.home.placeOrigin(), CLOUD);
});

test("launching opens the team remembered from last time; one the connected session no longer lists is gone: My Cloud, with its name said once", async () => {
  const w = world({ state: { ...connected(), teams: [ACME] }, remembered: { team: "team-acme", name: "Acme", origin: TEAM } });
  await w.home.show();
  assert.deepEqual(w.went, [[TEAM, TEAM, "team-acme"]], "the remembered team, on the window's own session");
  assert.deepEqual(w.left, []);
  // Removed from the team: the next sign-in check says so.
  w.state = connected();
  await w.home.changed();
  assert.deepEqual(w.went.at(-1), [CLOUD, CLOUD]);
  assert.deepEqual(w.left, ["Acme"]);
  assert.deepEqual(w.remembers.at(-1), null);
  assert.equal(w.home.placeOrigin(), CLOUD);
  assert.deepEqual(w.teamPairs, [], "a team gone is never paired");
});

test("a team's Cloud that can't be reached shows this computer's screen with the team's name and looks again by itself; My Cloud is untouched", async () => {
  const w = world({ state: { ...connected(), teams: [ACME] }, team: { down: true }, url: `${CLOUD}/` });
  await w.home.show({ place: { team: "team-acme" } });
  assert.deepEqual(w.went, [[`${LOCAL}${HOME_SCREEN_PATH}`, null]]);
  assert.deepEqual(w.home.view(), { screen: "offline", name: "Acme" }, "named, with no reason of My Cloud's");
  assert.equal(w.fetched.some(([route]) => !route.startsWith("team:")), false, "nothing asks My Cloud");
  w.team.down = false;
  await w.later(2_000);
  assert.deepEqual(w.went.at(-1), [TEAM, TEAM, "team-acme"], "back by itself");
  assert.deepEqual(w.home.view(), { screen: "opening", name: "Acme" });
  // The team's Cloud answering asleep is simply not reachable yet: no wake through the Admin.
  w.team.health = 503; w.url = `${LOCAL}/`;
  await w.home.show({ place: { team: "team-acme" } });
  assert.deepEqual(w.home.view(), { screen: "offline", name: "Acme" });
  assert.equal(w.wakes, 0);
});

test("signed out, a team shows the sign-in screen with its name; the Admin refusing the team pairing (no longer a member) falls back to My Cloud and says so", async () => {
  const out = world({ state: { status: "signed-out" }, remembered: { team: "team-acme", name: "Acme", origin: TEAM } });
  await out.home.show();
  assert.deepEqual(out.home.view(), { screen: "signin", name: "Acme" });
  assert.deepEqual(out.teamPairs, []);
  const w = world({ state: { ...connected(), teams: [ACME] }, team: { signedIn: false, gone: true } });
  await w.home.show({ place: { team: "team-acme" } });
  assert.deepEqual(w.teamPairs, ["team-acme"]);
  assert.deepEqual(w.left, ["Acme"]);
  assert.deepEqual(w.went.at(-1), [CLOUD, CLOUD], "My Cloud instead");
  assert.deepEqual(w.remembers.at(-1), null);
  const problem = world({ state: { ...connected(), teams: [{ ...ACME, machine: { status: "stopped", hold: { until: 9 } } }] } });
  await problem.home.show({ place: { team: "team-acme" } });
  assert.deepEqual(problem.home.view(), { screen: "plan", machine: "stopped", name: "Acme" }, "a team's Cloud that ended: its plan screen, by name");
  assert.deepEqual(problem.teamPairs, []);
});

test("on the team's page, a session that ends is renewed through the team pairing, the page counts as this app's, and its new version reloads at a quiet moment", async () => {
  const w = world({ state: { ...connected(), teams: [ACME] } });
  await w.home.show({ place: { team: "team-acme" } });
  w.url = `${TEAM}/chats/b1`;
  const frame = w.contents.mainFrame;
  assert.equal(w.home.homePage({ sender: w.contents, senderFrame: frame }), true, "the team's page is this app's");
  w.team.signedIn = false;
  w.home.responded({ url: `${TEAM}/api/bots`, statusCode: 401, webContentsId: 7 });
  await w.home.repair();
  assert.deepEqual(w.went.at(-1), [`${TEAM}/pair?next=%2Fchats%2Fb1#code=TTTT-EEEE-AAAA`, TEAM, "team-acme"]);
  assert.deepEqual(w.teamPairs, ["team-acme"]);
  assert.equal(w.pairs, 0);
  w.team.signedIn = true;
  w.url = `${TEAM}/`;
  w.home.navigated(w.url);
  await w.tick();
  w.team.version = "0.1.131"; w.typed = w.clock - QUIET_MS - 1;
  await w.tick();
  assert.equal(w.reloads, 1, "the team's page reloads for its own new version");
  w.state = { status: "signed-out" };
  await w.home.refresh();
  assert.equal(w.home.homePage({ sender: w.contents, senderFrame: frame }), false, "signed out, the team's page is no longer this app's");
});

test("going from a team to another server lets the team go: a later session check never pulls the window back", async () => {
  const w = world({ state: { ...connected(), teams: [ACME] } });
  await w.home.show({ place: { team: "team-acme" } });
  assert.equal(w.home.placeOrigin(), TEAM);
  // The Server menu moved the window to a saved server (main's switchEnvironment), not through the home window.
  w.remembered = null;
  w.url = "https://office.example.test/";
  w.home.navigated(w.url);
  assert.equal(w.home.shown(), null);
  assert.equal(w.home.placeOrigin(), CLOUD, "My Cloud is home again for the window's rules");
  const went = w.went.length;
  await w.home.changed();
  assert.equal(w.went.length, went, "the session check left the window where the person put it");
  // The team's own sign-in page or this computer's screen keep the team as the place.
  await w.home.show({ place: { team: "team-acme" } });
  w.home.navigated(`${LOCAL}${HOME_SCREEN_PATH}`);
  assert.equal(w.home.placeOrigin(), TEAM);
});

test("a team on screen signs in again before its hour ends, without moving the page: through the Admin's team pairing, into the window's own cookie", async () => {
  const w = world({ state: { ...connected(), teams: [ACME] }, team: { signedIn: false } });
  await w.home.show({ place: { team: "team-acme" } });
  w.url = `${TEAM}/chats/b1`;
  const went = w.went.length;
  await w.later(TEAM_RENEW_MS - 1);
  assert.deepEqual(w.teamPairs, ["team-acme"], "not before its time");
  await w.later(1);
  assert.deepEqual(w.teamPairs, ["team-acme", "team-acme"]);
  assert.deepEqual(w.redeemed, [["team", { code: "TTTT-EEEE-AAAA", cookie: true, label: "OpenMausBot app" }]]);
  assert.equal(w.went.length, went, "the page never moved");
  assert.equal(w.pairs, 0, "never My Cloud's pairing");
  await w.later(TEAM_RENEW_MS);
  assert.equal(w.teamPairs.length, 3, "and again each time");
  // My Cloud is never renewed this way, and leaving the team stops it.
  await w.home.show({ place: "cloud" });
  await w.later(TEAM_RENEW_MS * 2);
  assert.equal(w.teamPairs.length, 3);
  assert.equal(w.redeemed.length, 2);
});

test("opening a team on the window's own session renews before the end that session reports; a failed renewal tries again soon", async () => {
  const w = world({ state: { ...connected(), teams: [ACME] } });
  w.team.expiresAt = w.clock + 20 * 60_000;
  await w.home.show({ place: { team: "team-acme" } });
  assert.deepEqual(w.teamPairs, [], "its own session: no pairing to open it");
  await w.later(20 * 60_000 - TEAM_RENEW_EARLY_MS - 1);
  assert.deepEqual(w.teamPairs, []);
  await w.later(1);
  assert.deepEqual(w.teamPairs, ["team-acme"], "ten minutes before the end it reports");
  w.team.redeems = false;
  await w.later(TEAM_RENEW_MS);
  assert.equal(w.teamPairs.length, 2);
  await w.later(TEAM_RENEW_RETRY_MS);
  assert.equal(w.teamPairs.length, 3, "a code that didn't take is asked again in five minutes");
});

test("the Admin refusing the team pairing (404) means the person was removed: the team is dropped at once and My Cloud opens, on a renewal or a session that ended", async () => {
  const w = world({ state: { ...connected(), teams: [ACME] }, team: { signedIn: false } });
  await w.home.show({ place: { team: "team-acme" } });
  w.team.gone = true;
  await w.home.renew();
  assert.deepEqual(w.dropped, ["team-acme"], "dropped now, not at the next session check");
  assert.deepEqual(w.left, ["Acme"]);
  assert.deepEqual(w.went.at(-1), [CLOUD, CLOUD]);
  assert.equal(w.home.placeOrigin(), CLOUD);
  assert.equal(w.redeemed.length, 0);
  await w.later(TEAM_RENEW_MS * 2);
  assert.equal(w.teamPairs.length, 2, "no renewal of a team that is gone");
  // The same on the 401 path: the team's session ended and the re-pair is refused.
  const ended = world({ state: { ...connected(), teams: [ACME] } });
  await ended.home.show({ place: { team: "team-acme" } });
  ended.url = `${TEAM}/`;
  ended.team.signedIn = false; ended.team.gone = true;
  ended.home.responded({ url: `${TEAM}/api/bots`, statusCode: 401, webContentsId: 7 });
  await ended.home.repair();
  assert.deepEqual(ended.dropped, ["team-acme"]);
  assert.deepEqual(ended.went.at(-1), [CLOUD, CLOUD]);
});

test("while the window is on the place's own sign-in page, its 401s start no second sign-in (a team's and My Cloud's alike)", async () => {
  const w = world({ state: { ...connected(), teams: [ACME] }, team: { signedIn: false } });
  await w.home.show({ place: { team: "team-acme" } });
  assert.deepEqual(w.teamPairs, ["team-acme"]);
  assert.match(w.url, /^https:\/\/omb-u-acme\.fly\.dev\/pair#code=/);
  w.home.responded({ url: `${TEAM}/api/auth/session`, statusCode: 401, webContentsId: 7 });
  await w.later(0);
  assert.deepEqual(w.teamPairs, ["team-acme"], "the code on its way is not replaced");
  w.url = `${TEAM}/chats/b1`;
  w.home.responded({ url: `${TEAM}/api/bots`, statusCode: 401, webContentsId: 7 });
  await w.home.repair();
  assert.deepEqual(w.teamPairs, ["team-acme", "team-acme"], "once on its page, a 401 signs in again as before");
  const mine = world({ cloud: { signedIn: false } });
  await mine.home.show();
  mine.home.responded({ url: `${CLOUD}/api/auth/session`, statusCode: 401, webContentsId: 7 });
  await mine.later(0);
  assert.equal(mine.pairs, 1);
});

test("the usage meter's Upgrade: only from the person's click, only to a plan the verified session offers, only from this app's own pages", async () => {
  for (const origin of [LOCAL, CLOUD]) {
    const page = preload(origin);
    await assert.rejects(page.bridge.cloudPlan.upgrade("max", "app_usage"), /Choose Upgrade/, "the change needs the confirm's own click on every page");
    await assert.rejects(page.bridge.cloudPlan.upgradePreview("max", "app_usage"), /Choose Upgrade/, "so does the price");
    const clicked = preload(origin, { activation: true });
    await clicked.bridge.cloudPlan.upgradePreview("max", "app_usage");
    await clicked.bridge.cloudPlan.upgrade("max", "app_usage");
    assert.deepEqual(clicked.invoked, [["cloud-plan:upgrade-preview", "max", "app_usage"], ["cloud-plan:upgrade", "max", "app_usage"]]);
  }
  const ipc = pageIpc();
  const event = { sender: ipc.cloudContents, senderFrame: ipc.cloudFrame };
  ipc.account.usage = { tier: "pro", resetsAt: 1, meters: [], upgrades: [{ tier: "max", amount: 9900 }] };
  await ipc.handlers.get("cloud-plan:upgrade-preview")(event, "max", "app_usage");
  await ipc.handlers.get("cloud-plan:upgrade")(event, "max", "app_settings");
  assert.deepEqual(ipc.calls, [["upgrade-preview", "max", "app_usage"], ["upgrade", "max", "app_settings"]]);
  for (const [plan, source] of [["pro", "app_usage"], ["business", "app_usage"], ["max", "somewhere"], [{ tier: "max" }, "app_usage"]]) {
    for (const channel of ["cloud-plan:upgrade-preview", "cloud-plan:upgrade"]) assert.throws(() => ipc.handlers.get(channel)(event, plan, source), /Choose a plan/);
  }
  for (const sender of [{ sender: ipc.cloudContents, senderFrame: { url: "https://other.example.test/" } }, { sender: {}, senderFrame: ipc.cloudFrame }]) {
    for (const channel of ["cloud-plan:upgrade-preview", "cloud-plan:upgrade"]) assert.throws(() => ipc.handlers.get(channel)(sender, "max", "app_usage"), /only available/);
  }
  assert.equal(ipc.calls.length, 2);
});

test("Cancel and Keep my plan on the Cloud's own page: only from the person's click there, the survey's words only, and the plan's renewal shown read only", async () => {
  const page = preload(CLOUD);
  await assert.rejects(page.bridge.cloudPlan.cancel({ answer: "price" }), /Choose Cancel/, "the Cloud's page cancels only from the person's click");
  await assert.rejects(page.bridge.cloudPlan.keep(), /Choose Keep my plan/);
  const clicked = preload(CLOUD, { activation: true });
  await clicked.bridge.cloudPlan.cancel({ answer: "price", improve: "words" }, { cloudId: "someone-elses" });
  await clicked.bridge.cloudPlan.cancel();
  await clicked.bridge.cloudPlan.keep({ cloudId: "someone-elses" });
  assert.deepEqual(clicked.invoked, [["cloud-plan:cancel", { answer: "price", improve: "words" }], ["cloud-plan:cancel", null], ["cloud-plan:keep"]]);
  const local = preload(LOCAL);
  await local.bridge.cloudPlan.cancel({ answer: "later" });
  await local.bridge.cloudPlan.keep();
  assert.deepEqual(local.invoked, [["cloud-plan:cancel", { answer: "later" }], ["cloud-plan:keep"]]);
  const ipc = pageIpc();
  const event = { sender: ipc.cloudContents, senderFrame: ipc.cloudFrame };
  ipc.account.renewal = { trial: true, cancelled: false, renewsAt: 1_900_000_000_000, endsAt: null, keptDays: 3 };
  assert.deepEqual(plain(await ipc.handlers.get("cloud-plan:state")(event)).renewal, ipc.account.renewal);
  await ipc.handlers.get("cloud-plan:cancel")(event, { answer: "setup" }, "https://evil.example.test");
  await ipc.handlers.get("cloud-plan:keep")(event, { cloudId: "someone-elses" });
  assert.deepEqual(ipc.calls, [["cancel", { answer: "setup" }], ["keep"]]);
  for (const sender of [{ sender: ipc.cloudContents, senderFrame: { url: "https://other.example.test/" } }, { sender: {}, senderFrame: ipc.cloudFrame }]) {
    for (const channel of ["cloud-plan:cancel", "cloud-plan:keep"]) assert.throws(() => ipc.handlers.get(channel)(sender, { answer: "price" }), /only available/);
  }
  assert.equal(ipc.calls.length, 2);
});

test("the room card on the person's own Cloud: the offer read only, Not now and Restart now only from their click there, for the session's own Cloud", async () => {
  const page = preload(CLOUD);
  await assert.rejects(page.bridge.cloudPlan.roomNotNow("offer-1"), /Choose Not now/);
  await assert.rejects(page.bridge.cloudPlan.restartNow(), /Choose Restart now/);
  const clicked = preload(CLOUD, { activation: true });
  await clicked.bridge.cloudPlan.roomNotNow("offer-1", { cloudId: "someone-elses" });
  await clicked.bridge.cloudPlan.restartNow({ cloudId: "someone-elses" });
  await clicked.bridge.cloudPlan.upgradePreview("max", "app_room");
  assert.deepEqual(clicked.invoked, [["cloud-plan:room-not-now", "offer-1"], ["cloud-plan:restart-now"], ["cloud-plan:upgrade-preview", "max", "app_room"]]);
  const ipc = pageIpc();
  const event = { sender: ipc.cloudContents, senderFrame: ipc.cloudFrame };
  ipc.account.usage = { tier: "pro", resetsAt: 1, meters: [], upgrades: [{ tier: "max", amount: 9900 }] };
  ipc.account.room = { id: "offer-1", cause: { kind: "memory", waits: 3, waitMinutes: 6, stopped: 0 },
    plan: { tier: "max", amount: 9900, memoryMb: 8192, fromMemoryMb: 4096, diskGb: 100, fromDiskGb: 100 } };
  assert.deepEqual(plain(await ipc.handlers.get("cloud-plan:state")(event)).room, ipc.account.room);
  await ipc.handlers.get("cloud-plan:room-not-now")(event, "offer-1", { cloudId: "someone-elses" });
  await ipc.handlers.get("cloud-plan:restart-now")(event, { cloudId: "someone-elses" });
  await ipc.handlers.get("cloud-plan:upgrade-preview")(event, "max", "app_room");
  assert.deepEqual(ipc.calls, [["room-not-now", "offer-1"], ["restart-now"], ["upgrade-preview", "max", "app_room"]]);
  for (const sender of [{ sender: ipc.cloudContents, senderFrame: { url: "https://other.example.test/" } }, { sender: {}, senderFrame: ipc.cloudFrame }]) {
    for (const channel of ["cloud-plan:room-not-now", "cloud-plan:restart-now"]) assert.throws(() => ipc.handlers.get(channel)(sender, "offer-1"), /only available/);
  }
  assert.equal(ipc.calls.length, 3);
});

test("another Cloud of the person's own is the place asked for by its id, from the session's list; one it no longer lists is simply My Cloud again", () => {
  const state = { ...connected(), clouds: [{ ...CLIENT_A, id: "c-home", name: "My Cloud", origin: CLOUD, primary: true }, CLIENT_A] };
  assert.deepEqual(placeOf({ ask: { cloud: "c-a" }, state }), { kind: "own", id: "c-a", name: "Client A", role: "owner", origin: CLIENT, machine: { status: "ready", origin: CLIENT } });
  assert.deepEqual(placeOf({ remembered: { cloud: "c-a", name: "Client A", origin: CLIENT }, state }).kind, "own");
  assert.deepEqual(placeOf({ ask: { cloud: "c-home" }, state }), { kind: "cloud" }, "My Cloud is never another Cloud");
  assert.deepEqual(placeOf({ ask: { cloud: "c-a" }, state: connected() }), { kind: "cloud" }, "not listed (or an older Admin): My Cloud, nothing said");
  assert.deepEqual(placeOf({ remembered: { cloud: "c-a", name: "Client A", origin: CLIENT }, state: { status: "unavailable" } }),
    { kind: "own", id: "c-a", name: "Client A", role: null, origin: CLIENT, machine: null }, "while the Admin can't be asked, as it was saved");
  assert.deepEqual(placeOf({ ask: { cloud: "c-a" }, state: { ...state, clouds: [{ ...CLIENT_A, status: "setting_up", origin: null, setup: { step: "storage" } }] } }).machine,
    { status: "provisioning", setup: { step: "storage" } });
});

test("choosing another Cloud of the person's own opens it through the Admin's pairing for that Cloud, at its own address, remembered for next time; no team renewal", async () => {
  const w = world({ state: { ...connected(), clouds: [CLIENT_A] }, client: { signedIn: false } });
  await w.home.show({ place: { cloud: "c-a" } });
  assert.deepEqual(w.ownPairs, ["c-a"]);
  assert.equal(w.pairs, 0, "never My Cloud's pairing");
  assert.deepEqual(w.went, [[`${CLIENT}/pair#code=CCCC-LLLL-AAAA`, CLIENT, "c-a"]]);
  assert.deepEqual(w.fetched, [["client:/api/health", "1"], ["client:/api/auth/session", null]], "a look at that Cloud only");
  assert.deepEqual(w.remembers, [{ cloud: "c-a" }]);
  assert.equal(w.home.placeOrigin(), CLIENT);
  assert.equal(w.timers.length, 0, "its session lasts as My Cloud's does: nothing to renew");
  assert.deepEqual(w.home.view(), { screen: "opening", name: "Client A" });
});

test("another Cloud of the person's own that the Admin says is asleep is never asked for its version; once the Admin says it is awake, it is", async () => {
  const w = world({ state: { ...connected(), clouds: [CLIENT_A] } });
  await w.home.show({ place: { cloud: "c-a" } });
  w.url = `${CLIENT}/`;
  w.home.navigated(w.url);
  await w.tick();
  const versions = () => w.fetched.filter(([route]) => route === "client:/.well-known/openmausbot/environment");
  const read = versions().length;
  assert.ok(read > 0, "the shown Cloud's version is read while it is awake");
  // The Clouds list says it sleeps (`power`, contract v1): any request reaching it would wake it.
  w.state = { ...w.state, clouds: [{ ...CLIENT_A, power: { state: "asleep", since: 5, sleeps: true } }] };
  await w.tick();
  await w.tick();
  assert.equal(versions().length, read, "a Cloud the Admin says is asleep is never asked");
  assert.deepEqual([w.home.asleepAt(CLIENT), w.home.asleepAt(CLOUD)], [true, false], "and the quiet updater asks the same: only that Cloud sleeps");
  w.state = { ...w.state, clouds: [{ ...CLIENT_A, power: { state: "awake", since: 6, sleeps: true } }] };
  await w.tick();
  assert.equal(versions().length, read + 1, "awake again, it is asked");
  assert.deepEqual(versions().at(-1), ["client:/.well-known/openmausbot/environment", "1"], "as a background read");
});

test("another Cloud the Admin says is no longer theirs is dropped at once and My Cloud opens, with no line; one being set up shows its setup with its name", async () => {
  const w = world({ state: { ...connected(), clouds: [CLIENT_A] }, client: { signedIn: false, gone: true } });
  await w.home.show({ place: { cloud: "c-a" } });
  assert.deepEqual(w.dropped, ["c-a"]);
  assert.deepEqual(w.left, [], "a Cloud of their own leaving is no team they were removed from");
  assert.deepEqual(w.went.at(-1), [CLOUD, CLOUD], "My Cloud");
  const setup = world({ state: { ...connected(), clouds: [{ ...CLIENT_A, status: "setting_up", setup: { step: "starting" } }] } });
  await setup.home.show({ place: { cloud: "c-a" } });
  assert.deepEqual(setup.home.view(), { screen: "setup", step: "starting", name: "Client A" });
  assert.deepEqual(setup.ownPairs, [], "never paired while it is set up");
});
