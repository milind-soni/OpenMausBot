import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Duplex } from "node:stream";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { createCloudPowerGate } from "./cloud-power.mjs";
import { createComputerSharing, saidNo } from "./computer-sharing.mjs";
import { createLendingTarget } from "./lending-target.mjs";
import { autostartEntry, createOpenAtLogin, HIDDEN_ARG } from "./open-at-login.mjs";
import { createAllWindowsClosedQuit } from "./window-all-closed.mjs";

const ORIGIN = "https://omb-u-fixture.fly.dev";
const env = { id: "my-cloud", name: "My Cloud", origin: ORIGIN };

const until = async (check, what, ms = 5000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await check()) return; await delay(10); }
  assert.fail(`timed out waiting for ${what}`);
};

/** My Cloud's HTTP side, as the poll sees it; `link` says whether it advertises the device link, `chrome` the lent
 * Chrome. `registered`: the lent computers it knows, which a restart forgets. */
function cloudHome({ link = true, chrome = false } = {}) {
  const json = (value, status = 200) => ({ ok: status < 400, status, headers: { get: () => null }, body: (async function* () { yield Buffer.from(JSON.stringify(value)); })() });
  const state = { environmentId: randomUUID(), sessionId: randomUUID(), connects: [], polls: 0, disconnects: 0, calls: [], registered: new Set() };
  state.fetch = async (url, init) => {
    const route = new URL(url).pathname;
    state.calls.push(route);
    if (route === "/api/auth/session") return json({ kind: "session", id: state.sessionId, scopes: ["admin", "client"], cloudHome: true });
    if (route === "/.well-known/openmausbot/environment") return json({ environmentId: state.environmentId, capabilities: { sharedComputers: true, lendingDetails: true, ...(link ? { deviceLink: true } : {}), ...(chrome ? { myChromeLink: true } : {}) } });
    const body = init?.body ? JSON.parse(init.body) : {};
    if (route === "/api/shared-computers/connect") { state.connects.push(body); state.registered.add(body.id); return json({ ok: true }); }
    if (route.endsWith("/poll")) {
      if (!state.registered.has(route.split("/")[3])) return json({ error: "Shared computer is disconnected or not authorized" }, 403);
      state.polls++;
      await delay(100, undefined, { signal: init?.signal }).catch(() => {});
      init?.signal?.throwIfAborted();
      return json({ job: null });
    }
    if (route.endsWith("/disconnect")) { state.disconnects++; return json({ ok: true }); }
    return json({ ok: true });
  };
  return state;
}

/** The device link's WebSocket as the test drives it: every dial is kept, and opens unless `accept(url)` says no. */
function fakeSockets(accept = () => true) {
  const made = [];
  class FakeSocket {
    constructor(url, init) {
      this.url = url; this.headers = init?.headers ?? {}; this.sent = []; this.closed = false;
      made.push(this);
      setImmediate(() => { if (this.closed) return; if (accept(url)) this.onopen?.(); else this.end(1006, ""); });
    }
    send(frame) { this.sent.push(frame); }
    close() { this.end(1000, ""); }
    end(code, reason) { if (this.closed) return; this.closed = true; setImmediate(() => this.onclose?.({ code, reason })); }
    deliver(data) { this.onmessage?.({ data }); }
  }
  return { FakeSocket, made, open: () => made.filter((socket) => !socket.closed) };
}

const SIGNED_IN = Object.freeze({ status: "connected", accountId: "acct_1", origin: ORIGIN });

/** `myCloud`: this app knows which saved server is My Cloud and that it is the person's own, as the desktop app does, so
 * it lends itself to it by itself (its home folder doesn't exist here, so no folder). `signIn`: the verified Cloud sign-in
 * it starts with. */
async function fixture(t, { link = true, chrome = false, adminWord = null, myCloud = false, signIn = SIGNED_IN } = {}) {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "omb-use-my-mac-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const home = cloudHome({ link, chrome });
  const sockets = fakeSockets((url) => home.registered.has(new URL(url).pathname.split("/")[3]));
  let word = adminWord;
  let account = signIn;
  const power = createCloudPowerGate({ power: () => word, holdMs: 60_000 });
  const summaries = [];
  const connects = [];
  const file = path.join(dir, "profile", "computer-sharing.json");
  const make = () => createComputerSharing({
    file, fetch: home.fetch, environments: () => [env], enabled: async () => false, ...(myCloud ? { myCloud: () => env, ownClouds: () => [env] } : {}),
    cloud: () => account, home: path.join(dir, "home"), cuaConnection: async () => null,
    power, WebSocket: sockets.FakeSocket, linkHeaders: () => ({ cookie: "omb_session_fixture=token" }), onChange: (summary) => summaries.push(summary),
    egress: {
      interfaces: () => ({}),
      resolve: async (host) => [{ address: host.startsWith("lan.") ? "192.168.1.1" : "93.184.215.14", family: 4 }],
      connect: (options) => { connects.push(options); const socket = new Duplex({ read() {}, write(_chunk, _encoding, done) { done(); } }); setImmediate(() => socket.emit("connect")); return socket; },
    },
  });
  let sharing = make();
  t.after(() => sharing.close());
  return { dir, file, home, sockets, power, summaries, connects, get sharing() { return sharing; }, setWord: (next) => { word = next; power.changed(); },
    signIn: (next) => { account = next; sharing.cloudChanged(); },
    restart: () => { sharing.close(); sharing = make(); return sharing; } };
}

test("the internet connection alone is lent: it registers with My Cloud and opens the device link with the poll's own sign-in and the grant's secret", async (t) => {
  const { home, sockets, sharing } = await fixture(t);
  const lent = await sharing.saveCloud(env, { folders: [], screen: false, internet: true });
  assert.equal(lent.enabled, true);
  await until(() => sockets.open().length === 1 && sharing.cloudState(env).link === "on", "the device link to open");
  assert.equal(home.connects.length, 1);
  assert.deepEqual({ folders: home.connects[0].folders, computer: home.connects[0].computer, internet: home.connects[0].internet }, { folders: [], computer: false, internet: true });
  const [socket] = sockets.made;
  assert.equal(socket.url, `wss://omb-u-fixture.fly.dev/api/shared-computers/${home.connects[0].id}/link`);
  assert.equal(socket.headers.cookie, "omb_session_fixture=token");
  assert.match(socket.headers["x-omb-computer-secret"], /^[a-f0-9]{64}$/);
  assert.equal(socket.headers["x-omb-background"], "1", "the link never counts as the person using My Cloud");
  assert.equal(socket.headers.origin, ORIGIN);
  assert.deepEqual({ internet: sharing.cloudState(env).internet, link: sharing.cloudState(env).link }, { internet: true, link: "on" });
});

test("a grant without the internet connection, or a Cloud too old for the device link, never dials it", async (t) => {
  const { dir, sockets, sharing, home } = await fixture(t);
  const folder = path.join(dir, "Plans");
  await mkdir(folder);
  await sharing.saveCloud(env, { folders: [{ id: randomUUID(), path: folder, write: false }], screen: false });
  await until(() => sharing.cloudState(env).connected, "lending to connect");
  await delay(150);
  assert.equal(sockets.made.length, 0);
  assert.equal(home.connects[0].internet, false, "My Cloud learns the connection is not lent");
  const old = await fixture(t, { link: false });
  await old.sharing.saveCloud(env, { folders: [], screen: false, internet: true });
  await until(() => old.sharing.cloudState(env).connected, "lending to the old Cloud to connect");
  await delay(150);
  assert.equal(old.sockets.made.length, 0, "an old Cloud is never dialled at a path it does not have");
  assert.equal(Object.hasOwn(old.home.connects[0], "internet"), false, "an old Cloud refuses fields it does not know");
  assert.equal(old.sharing.cloudState(env).link, "unsupported", "and the switch says My Cloud is updating");
});

test("a Cloud going to sleep is never dialled: its asleep close holds the link, and so does the Admin's word, until it wakes", async (t) => {
  const { sockets, sharing, power, setWord } = await fixture(t);
  await sharing.saveCloud(env, { folders: [], screen: false, internet: true });
  await until(() => sockets.open().length === 1, "the device link to open");
  sockets.made[0].end(4001, "asleep");
  await until(() => power.asleep(), "the asleep close to hold My Cloud");
  await delay(400);
  assert.equal(sockets.made.length, 1, "nothing dials a Cloud that said it is going to sleep");
  assert.equal(sharing.cloudState(env).problem, "asleep", "the switch says My Cloud is asleep");
  power.woke();
  await until(() => sockets.open().length === 1 && sockets.made.length === 2, "the link to come back once My Cloud is awake");
  // The Admin says it sleeps: the link that went silent is not dialled again until the Admin says it is awake.
  setWord({ state: "asleep", since: 1, sleeps: true });
  sockets.made[1].end(1006, "");
  await delay(400);
  assert.equal(sockets.made.length, 2, "nothing dials a Cloud the Admin says is asleep");
  setWord({ state: "awake", since: 2, sleeps: true });
  await until(() => sockets.made.length === 3, "the link to come back once the Admin says it is awake");
});

test("the tray reads In use while My Cloud's browsing goes through this computer, and not otherwise", async (t) => {
  const { sockets, sharing, summaries, connects } = await fixture(t);
  await sharing.saveCloud(env, { folders: [], screen: false, internet: true });
  await until(() => sockets.open().length === 1, "the device link to open");
  assert.equal(summaries.at(-1).busy, null);
  const socket = sockets.made[0];
  socket.deliver(JSON.stringify({ t: "open", id: 1, host: "example.test", port: 443 }));
  await until(() => socket.sent.includes(JSON.stringify({ t: "opened", id: 1 })), "the stream to open");
  assert.equal(connects.length, 1);
  const frame = Buffer.concat([Buffer.from([0, 0, 0, 1]), Buffer.from("GET / HTTP/1.1\r\n\r\n")]);
  socket.deliver(frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.length));
  await until(() => summaries.at(-1)?.busy?.action === "internet", "In use");
  assert.equal(summaries.at(-1).busy.env, env.id);
  assert.deepEqual(summaries.at(-1).using, ["My Cloud"], "the menu bar names the Cloud browsing through this computer");
});

test("each site opened through this computer is in its activity, refused ones too, once per site and outcome every 10 minutes", async (t) => {
  const { sockets, sharing } = await fixture(t);
  await sharing.saveCloud(env, { folders: [], screen: false, internet: true });
  await until(() => sockets.open().length === 1, "the device link to open");
  const socket = sockets.made[0];
  let id = 0;
  const answered = (n) => socket.sent.some((frame) => typeof frame === "string" && JSON.parse(frame).id === n && ["opened", "refused", "failed"].includes(JSON.parse(frame).t));
  for (const host of ["www.instagram.com", "www.instagram.com", "lan.home.test", "lan.home.test", "www.youtube.com"]) {
    const n = ++id;
    socket.deliver(JSON.stringify({ t: "open", id: n, host, port: 443 }));
    await until(() => answered(n), `an answer for ${host}`);
  }
  const browsed = sharing.activity(env.id, 30).filter((entry) => entry.action === "internet").reverse();
  assert.deepEqual(browsed.map((entry) => [entry.detail, entry.ok, entry.error]),
    [["www.instagram.com", true, undefined], ["lan.home.test", false, "home-network"], ["www.youtube.com", true, undefined]]);
  assert.equal(browsed[0].origin, ORIGIN);
});

test("a lent folder deleted since is left out, and the rest, the internet connection with it, keeps working", async (t) => {
  const fixtureState = await fixture(t);
  const { dir, home, sockets } = fixtureState;
  const plans = path.join(dir, "Plans"), notes = path.join(dir, "Notes");
  await mkdir(plans); await mkdir(notes);
  await fixtureState.sharing.saveCloud(env, { folders: [{ id: randomUUID(), path: plans, write: true }, { id: randomUUID(), path: notes, write: false }], screen: false, internet: true });
  await until(() => sockets.open().length === 1, "the device link to open");
  await rm(plans, { recursive: true, force: true });
  const again = fixtureState.restart();
  again.start();
  await until(() => home.connects.length === 2 && sockets.open().length === 1, "lending to come back after the restart");
  assert.deepEqual(home.connects[1].folders.map((folder) => folder.name), ["Notes"], "the deleted folder is no longer offered");
  assert.equal(again.cloudState(env).link, "on");
});

test("Pause survives a restart: nothing is lent or dialled until Resume, which lends the same again", async (t) => {
  const fixtureState = await fixture(t, { myCloud: true });
  const { sockets, home, file } = fixtureState;
  fixtureState.sharing.start();
  await until(() => sockets.open().length === 1, "the device link to open");
  fixtureState.sharing.pause();
  await until(() => sockets.open().length === 0, "the link to end with lending");
  assert.equal(JSON.parse(await readFile(file, "utf8")).automatic.paused, true);
  const connectsBefore = home.connects.length;
  const again = fixtureState.restart();
  again.start();
  again.cloudChanged();
  await delay(300);
  assert.equal(home.connects.length, connectsBefore, "a restart lends nothing while paused");
  assert.equal(sockets.made.length, 1);
  assert.equal(again.paused(), true);
  await again.resume();
  await until(() => sockets.open().length === 1 && again.cloudState(env).link === "on", "lending to come back with Resume");
  assert.equal(home.connects.at(-1).id, home.connects[0].id, "the same grant");
  assert.equal(JSON.parse(await readFile(file, "utf8")).automatic.paused, false);
});
test("lending on opens the app at login, out of sight; off removes only the login item this app added", async (t) => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "omb-login-item-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const calls = [];
  const fakeApp = (settings = { openAtLogin: false, wasOpenedAtLogin: false }) => ({
    isPackaged: true, settings,
    getLoginItemSettings(options) { calls.push(["get", options]); return { ...settings }; },
    setLoginItemSettings(next) { calls.push(["set", next]); Object.assign(settings, { openAtLogin: next.openAtLogin }); },
  });
  const mac = fakeApp();
  const login = createOpenAtLogin({ app: mac, file: path.join(dir, "mac.json"), platform: "darwin", home: dir });
  login.follow(true);
  assert.equal(mac.settings.openAtLogin, true);
  mac.settings.wasOpenedAtLogin = true;
  assert.equal(login.startedHidden(), true, "a launch from the login item lending added starts hidden");
  login.follow(false);
  assert.equal(mac.settings.openAtLogin, false);
  const theirs = fakeApp({ openAtLogin: true, wasOpenedAtLogin: true });
  const kept = createOpenAtLogin({ app: theirs, file: path.join(dir, "theirs.json"), platform: "darwin", home: dir });
  kept.follow(true);
  kept.follow(false);
  assert.equal(theirs.settings.openAtLogin, true, "a login item the person set up is theirs");
  assert.equal(kept.startedHidden(), false, "and it opens the window as before");
  const windows = fakeApp();
  const win = createOpenAtLogin({ app: windows, file: path.join(dir, "win.json"), platform: "win32", home: dir, argv: ["OpenMausBot.exe", HIDDEN_ARG] });
  win.follow(true);
  assert.deepEqual(calls.filter(([kind]) => kind === "set").at(-1), ["set", { openAtLogin: true, args: [HIDDEN_ARG] }]);
  assert.equal(win.startedHidden(), true);
  assert.equal(createOpenAtLogin({ app: windows, file: path.join(dir, "win.json"), platform: "win32", home: dir, argv: ["OpenMausBot.exe"] }).startedHidden(), false);
  const config = path.join(dir, "config");
  const linux = createOpenAtLogin({ app: fakeApp(), file: path.join(dir, "linux.json"), platform: "linux", home: dir, env: { XDG_CONFIG_HOME: config, APPIMAGE: "/home/me/Apps/Open Maus$Bot.AppImage" } });
  linux.follow(true);
  const entry = path.join(config, "autostart", "openmausbot.desktop");
  assert.equal(await readFile(entry, "utf8"), autostartEntry("/home/me/Apps/Open Maus$Bot.AppImage"));
  assert.match(await readFile(entry, "utf8"), /^Exec="\/home\/me\/Apps\/Open Maus\\\$Bot\.AppImage" --omb-hidden$/m);
  linux.follow(false);
  await assert.rejects(readFile(entry, "utf8"), { code: "ENOENT" });
  await mkdir(path.dirname(entry), { recursive: true });
  await writeFile(entry, "[Desktop Entry]\nExec=openmausbot\n");
  linux.follow(true);
  linux.follow(false);
  assert.equal(await readFile(entry, "utf8"), "[Desktop Entry]\nExec=openmausbot\n", "an autostart entry the person wrote is never replaced or removed");
  const unpackaged = { ...fakeApp(), isPackaged: false };
  createOpenAtLogin({ app: unpackaged, file: path.join(dir, "dev.json"), platform: "darwin", home: dir }).follow(true);
  assert.equal(unpackaged.settings.openAtLogin, false, "a development build never registers itself");
});

test("an app started hidden at login runs with no window until the person opens one, then quits on its last close as before", () => {
  const listeners = new Map();
  const app = { on: (event, listener) => listeners.set(event, listener), quit: () => app.quits++, quits: 0 };
  const windows = [];
  let hidden = true;
  const quit = createAllWindowsClosedQuit({ app, platform: "linux", allWindows: () => windows, stayOpen: () => hidden });
  quit.settleStartup();
  assert.equal(app.quits, 0, "no window at all, and still running for lending");
  hidden = false;
  windows.push({});
  windows.length = 0;
  listeners.get("window-all-closed")();
  assert.equal(app.quits, 1);
});

test("lends Chrome only in a grant that says so, and tells only a Cloud that takes it", async (t) => {
  const old = await fixture(t);
  await old.sharing.saveCloud(env, { chrome: true, folders: [] });
  await until(() => old.home.connects.length === 1, "the connect");
  assert.equal("chrome" in old.home.connects[0], false, "a Cloud that does not know Chrome is not sent it");
  const { home, sockets, sharing } = await fixture(t, { chrome: true });
  await sharing.saveCloud(env, { chrome: true, folders: [] });
  await until(() => sockets.open().length === 1 && sharing.cloudState(env).chromeLink === "on", "the device link to open");
  assert.equal(home.connects[0].chrome, true);
  assert.equal(sharing.cloudState(env).chrome, true);
  await sharing.saveCloud(env, { folders: [{ id: randomUUID(), path: tmpdir(), write: false }], screen: false });
  await until(() => home.connects.length === 2, "the second connect");
  assert.equal(home.connects[1].chrome, false);
  assert.equal(sharing.cloudState(env).chrome, false);
});

test("a Chrome-only grant keeps the device link open, and the link refuses web streams", async (t) => {
  const { sockets, sharing } = await fixture(t, { chrome: true });
  await sharing.saveCloud(env, { chrome: true, internet: false, folders: [] });
  await until(() => sockets.open().length === 1, "the device link to open");
  const socket = sockets.made[0];
  socket.deliver(JSON.stringify({ t: "open", id: 1, host: "example.com", port: 443 }));
  await until(() => socket.sent.some((frame) => typeof frame === "string" && JSON.parse(frame).id === 1), "an answer");
  const answer = socket.sent.map((frame) => JSON.parse(frame)).find((frame) => frame.id === 1);
  assert.deepEqual({ t: answer.t, reason: answer.reason }, { t: "refused", reason: "not-lent" });
});

test("who starts Paused, record by record: only someone who had said no to lending a Cloud of their own", () => {
  const cloud = { accountId: "acct_1", origin: ORIGIN };
  const cases = [
    ["nothing kept", undefined, false],
    ["lending on, internet connection included", { enabled: true, cloud, internet: true }, false],
    ["lending on, kept from before the internet connection could be chosen", { enabled: true, cloud }, false],
    ["lending on, internet connection unticked", { enabled: true, cloud, internet: false }, true],
    ["turned off by the person", { enabled: false, cloud, internet: true, stopped: { reason: "you", at: 1 } }, true],
    ["off, saved before the reason was kept", { enabled: false, cloud, folders: [], internet: true }, true],
    ["stopped at a sign-out", { enabled: false, cloud, folders: [], internet: true, stopped: { reason: "signed-out", at: 1 } }, false],
    ["stopped when another account signed in", { enabled: false, cloud, folders: [], internet: true, stopped: { reason: "account-changed", at: 1 } }, false],
    ["stopped when My Cloud moved to a new machine", { enabled: false, cloud, folders: [], internet: true, stopped: { reason: "machine-changed", at: 1 } }, false],
    ["Computer access lending to a server", { enabled: true, sessionId: randomUUID(), environmentId: randomUUID() }, false],
    ["Computer access turned off by the person", { enabled: false, stopped: { reason: "you", at: 1 } }, false],
  ];
  for (const [what, record, paused] of cases) assert.equal(saidNo(record), paused, what);
});
test("a desktop signed in to its own Cloud lends itself by itself: the internet connection and Chrome, no terminal, no click, once, and again after a restart", async (t) => {
  const state = await fixture(t, { myCloud: true });
  const { home, sockets, summaries } = state;
  state.sharing.start();
  await until(() => sockets.open().length === 1 && state.sharing.cloudState(env).link === "on", "the device link to open with no click");
  assert.equal(home.connects.length, 1);
  const [lent] = home.connects;
  assert.deepEqual({ folders: lent.folders, computer: lent.computer, terminal: lent.terminal, internet: lent.internet }, { folders: [], computer: false, terminal: false, internet: true },
    "the internet connection; no terminal, and no screen while computer control can't work here");
  assert.deepEqual(state.sharing.cloudState(env), { enabled: true, folders: [], screen: false, terminal: false, internet: true, link: "on", chrome: true, chromeLink: "unsupported", busy: false, connected: true });
  assert.deepEqual(summaries.at(-1).clouds, ["My Cloud"], "the menu bar names the Cloud");
  const saved = JSON.parse(await readFile(state.file, "utf8")).records[env.id];
  assert.deepEqual({ internet: saved.internet, chrome: saved.chrome, folders: saved.folders, computer: saved.computer, terminal: saved.terminal, cloud: saved.cloud },
    { internet: true, chrome: true, folders: [], computer: false, terminal: false, cloud: { accountId: "acct_1", origin: ORIGIN } });
  state.sharing.cloudChanged();
  await delay(150);
  assert.equal(home.connects.length, 1, "a grant already made is never made again");
  const again = state.restart();
  again.start();
  await until(() => home.connects.length === 2 && sockets.open().length === 1 && again.cloudState(env).link === "on", "the same grant to come back after the app restarts");
  assert.equal(home.connects[1].id, lent.id);
  assert.equal(sockets.made.at(-1).headers["x-omb-computer-secret"], sockets.made[0].headers["x-omb-computer-secret"]);
});
test("nothing is lent until this app is signed in to My Cloud itself, and only to My Cloud", async (t) => {
  const state = await fixture(t, { myCloud: true, signIn: { status: "restoring", accountId: null, origin: null } });
  state.sharing.start();
  for (const signIn of [{ status: "signed-out", accountId: null, origin: null }, { status: "reauth-required", accountId: "acct_1", origin: null },
    { status: "connected", accountId: null, origin: ORIGIN }, { status: "connected", accountId: "acct_1", origin: "https://omb-u-other.fly.dev" }]) state.signIn(signIn);
  await delay(150);
  assert.deepEqual(state.home.calls, [], "nothing called My Cloud");
  await assert.rejects(readFile(state.file, "utf8"), { code: "ENOENT" }, "and nothing was kept");
  state.signIn(SIGNED_IN);
  await until(() => state.sharing.cloudState(env).link === "on", "lending to start once signed in to My Cloud");
});

test("a grant kept from before lending was automatic becomes the automatic one, its folders kept; one with the internet connection unticked starts Paused", async (t) => {
  for (const [kept, paused] of [[undefined, false], [true, false], [false, true]]) {
    const state = await fixture(t, { myCloud: true });
    const folder = path.join(state.dir, "Plans");
    await mkdir(folder);
    const id = randomUUID();
    await mkdir(path.dirname(state.file), { recursive: true });
    await writeFile(state.file, JSON.stringify({ version: 1, records: { [env.id]: {
      sessionId: null, environmentId: null, id, secret: "a".repeat(64), enabled: true, folders: [{ id: randomUUID(), path: folder, name: "Plans", write: false }],
      terminal: true, computer: false, ...(kept === undefined ? {} : { internet: kept }), cloud: { accountId: "acct_1", origin: ORIGIN },
    } } }));
    const sharing = state.restart();
    sharing.start();
    if (paused) {
      await delay(300);
      assert.equal(sharing.paused(), true, "the person had unticked the internet connection");
      assert.deepEqual([state.home.connects.length, state.sockets.made.length], [0, 0], "nothing lent, nothing dialled");
      continue;
    }
    await until(() => state.home.connects.at(-1)?.internet === true && sharing.cloudState(env).link === "on", "the automatic grant to connect");
    const last = state.home.connects.at(-1);
    assert.deepEqual(last.folders.map((entry) => entry.name), ["Plans"], "its folders as they were");
    assert.equal(last.terminal, true, "the terminal it lent, kept as the menu's switch");
    sharing.cloudChanged();
    await delay(100);
    assert.equal(state.home.connects.at(-1), last, "nothing else is lent on top");
  }
});
test("someone who had turned lending off starts Paused: no grant and no link after the sign-in changes or a restart, until Resume", async (t) => {
  const state = await fixture(t, { myCloud: true });
  await mkdir(path.dirname(state.file), { recursive: true });
  await writeFile(state.file, JSON.stringify({ version: 1, records: { [env.id]: {
    sessionId: null, environmentId: null, id: randomUUID(), secret: "b".repeat(64), enabled: false, folders: [], terminal: false, computer: false, internet: true,
    cloud: { accountId: "acct_1", origin: ORIGIN }, stopped: { reason: "you", at: 1 },
  } } }));
  const sharing = state.restart();
  sharing.start();
  state.signIn({ ...SIGNED_IN });
  const again = state.restart();
  again.start();
  again.cloudChanged();
  await delay(300);
  assert.deepEqual([state.home.connects.length, state.sockets.made.length], [0, 0], "nothing is lent or dialled");
  assert.equal(again.paused(), true);
  await again.resume();
  await until(() => again.cloudState(env).link === "on", "Resume to lend it");
  const third = state.restart();
  third.start();
  assert.equal(third.paused(), false, "a Resume is kept: the old Off never pauses it again");
});
test("lending a sign-out stopped comes back by itself once signed in again, with the folders it lent", async (t) => {
  const state = await fixture(t, { myCloud: true });
  const folder = path.join(state.dir, "Plans");
  await mkdir(folder);
  await state.sharing.saveCloud(env, { folders: [{ id: randomUUID(), path: folder, write: true }], screen: false, internet: true });
  await until(() => state.sharing.cloudState(env).link === "on", "lending to connect");
  state.signIn({ status: "signed-out", accountId: null, origin: null });
  assert.equal(state.sharing.cloudState(env).enabled, false);
  state.signIn(SIGNED_IN);
  await until(() => state.home.connects.length === 2 && state.sharing.cloudState(env).link === "on", "lending to come back");
  assert.deepEqual({ folders: state.home.connects[1].folders.map((entry) => [entry.name, entry.write]), internet: state.home.connects[1].internet }, { folders: [["Plans", true]], internet: true });
});
test("a Cloud asleep at sign-in: the automatic grant waits, calling nothing, and lends once My Cloud wakes", async (t) => {
  const state = await fixture(t, { myCloud: true, adminWord: { state: "asleep", since: 1, sleeps: true } });
  state.sharing.start();
  await until(() => state.sharing.cloudState(env).problem === "asleep", "lending to wait for My Cloud");
  await delay(300);
  assert.equal(state.sharing.cloudState(env).enabled, true, "it is lent");
  assert.deepEqual(state.home.calls, [], "nothing called a sleeping Cloud, which would wake it");
  assert.equal(state.sockets.made.length, 0);
  state.setWord({ state: "awake", since: 2, sleeps: true });
  await until(() => state.sharing.cloudState(env).link === "on" && state.home.connects[0]?.internet === true, "the link to open once My Cloud is awake");
});

test("when My Cloud restarts and forgets this computer, lending registers again and the link comes back by itself", async (t) => {
  const state = await fixture(t, { myCloud: true });
  state.sharing.start();
  await until(() => state.sockets.open().length === 1 && state.sharing.cloudState(env).link === "on", "the default link to open");
  state.home.registered.clear();
  state.sockets.made[0].end(1012, "restarting");
  await until(() => state.home.connects.length === 2 && state.sockets.open().length === 1 && state.sharing.cloudState(env).link === "on", "lending and the link to come back", 20_000);
  assert.equal(state.home.connects[1].id, state.home.connects[0].id);
  assert.equal(state.home.connects[1].internet, true);
});

test("a person whose only Cloud is a Team Cloud lends nothing: lending is personal", async (t) => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "omb-team-cloud-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const team = { id: "team-cloud", name: "Acme", origin: "https://omb-t-acme.fly.dev" };
  const account = { status: "connected", account: { id: "acct_1" }, teams: [{ id: "team-acme", name: "Acme", role: "member", machine: { status: "ready", origin: team.origin } }] };
  const target = createLendingTarget({ account: () => ({ state: () => account }), environments: () => [team] });
  const calls = [];
  const sharing = createComputerSharing({
    file: path.join(dir, "computer-sharing.json"), environments: () => [team], enabled: async () => false, cuaConnection: async () => null, home: path.join(dir, "home"),
    fetch: async (url) => { calls.push(url); throw new Error("must not call a Team Cloud"); }, cloud: target.cloud, myCloud: target.environment, ownClouds: target.places,
    WebSocket: class { constructor() { calls.push("dial"); } },
  });
  t.after(() => sharing.close());
  sharing.start();
  sharing.cloudChanged();
  await delay(100);
  assert.equal(target.environment(), null);
  assert.deepEqual(calls, []);
  assert.equal(sharing.cloudState(team).enabled, false);
  await assert.rejects(readFile(path.join(dir, "computer-sharing.json"), "utf8"), { code: "ENOENT" });
});

test("another Cloud of the person's own going to sleep holds only its own link: My Cloud's keeps lending, and the sleeping one isn't dialled again at once", async (t) => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "omb-use-my-mac-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const OTHER = "https://omb-c-a.fly.dev";
  const mine = env, other = { id: "client-a", name: "Client A", origin: OTHER, cloud: { id: "c-a", role: "owner" } };
  const homes = { [ORIGIN]: cloudHome(), [OTHER]: cloudHome() };
  const sockets = fakeSockets((url) => { const at = new URL(url.replace(/^wss:/, "https:")); return homes[at.origin].registered.has(at.pathname.split("/")[3]); });
  const power = createCloudPowerGate({ power: () => null, holdMs: 60_000 });
  const sharing = createComputerSharing({
    file: path.join(dir, "profile", "computer-sharing.json"), fetch: (url, init) => homes[new URL(url).origin].fetch(url, init), environments: () => [mine, other],
    enabled: async () => false, myCloud: () => mine, cloud: (place) => ({ status: "connected", accountId: "acct_1", origin: place?.cloud ? place.origin : ORIGIN }),
    home: path.join(dir, "home"), cuaConnection: async () => null, power, WebSocket: sockets.FakeSocket, linkHeaders: () => ({}),
  });
  t.after(() => sharing.close());
  await sharing.saveCloud(mine, { folders: [], screen: false, internet: true });
  await sharing.saveCloud(other, { folders: [], screen: false, internet: true });
  const to = (origin) => sockets.made.filter((socket) => socket.url.startsWith(origin.replace("https:", "wss:")));
  await until(() => to(ORIGIN).some((socket) => !socket.closed) && to(OTHER).some((socket) => !socket.closed), "both links to open");
  to(OTHER)[0].end(4001, "asleep");
  await delay(400);
  assert.equal(power.asleep(), false, "My Cloud's gate never holds for another Cloud");
  assert.equal(to(OTHER).length, 1, "the Cloud going to sleep is not dialled again at once");
  assert.equal(to(ORIGIN).filter((socket) => !socket.closed).length, 1, "My Cloud's link stays open");
});

test("another Cloud of the person's own that the Admin says is asleep is never dialled, even after its own hold ends, and lends once the Admin says it is awake", async (t) => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "omb-use-my-mac-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const OTHER = "https://omb-c-b.fly.dev";
  const mine = env, other = { id: "client-b", name: "Client B", origin: OTHER, cloud: { id: "c-b", role: "owner" } };
  const homes = { [ORIGIN]: cloudHome(), [OTHER]: cloudHome() };
  const sockets = fakeSockets((url) => { const at = new URL(url.replace(/^wss:/, "https:")); return homes[at.origin].registered.has(at.pathname.split("/")[3]); });
  // The Admin's word on each Cloud, as the session's Clouds list carries it (`power`): My Cloud awake, Client B asleep.
  let words = { [ORIGIN]: { state: "awake", since: 1, sleeps: true }, [OTHER]: { state: "asleep", since: 1, sleeps: true } };
  const power = createCloudPowerGate({ power: () => words[ORIGIN], holdMs: 60_000 });
  const sharing = createComputerSharing({
    file: path.join(dir, "profile", "computer-sharing.json"), fetch: (url, init) => homes[new URL(url).origin].fetch(url, init), environments: () => [mine, other],
    enabled: async () => false, myCloud: () => mine, ownClouds: () => [mine, other], cloud: (place) => ({ status: "connected", accountId: "acct_1", origin: place?.cloud ? place.origin : ORIGIN }),
    home: path.join(dir, "home"), cuaConnection: async () => null, power, WebSocket: sockets.FakeSocket, linkHeaders: () => ({}),
    cloudPower: (origin) => words[origin] ?? null,
  });
  t.after(() => sharing.close());
  sharing.start();
  await until(() => sharing.cloudState(other).problem === "asleep" && sharing.cloudState(mine).link === "on", "My Cloud to lend and Client B to wait");
  await delay(300);
  assert.equal(sharing.cloudState(other).enabled, true, "it is lent");
  assert.deepEqual(homes[OTHER].calls, [], "nothing called the Cloud the Admin says is asleep: any request reaching it wakes it");
  // The Admin's word changing (a session read) lets it go on.
  words = { ...words, [OTHER]: { state: "awake", since: 2, sleeps: true } };
  sharing.cloudChanged();
  await until(() => sharing.cloudState(other).link === "on" && homes[OTHER].connects.length === 1, "Client B's link to open once the Admin says it is awake");
});
