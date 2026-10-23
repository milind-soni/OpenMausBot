// My Cloud's first open: never looked up while the Admin sets it up, and a brand-new Cloud whose name a resolver hasn't
// found yet (negative caching of the lookups made while it was set up) is waited out on the setup screen by itself.
import assert from "node:assert/strict";
import test from "node:test";

import { cloudSetupOf, myCloudOrigin, readyCloudOrigin, rememberedCloudHome } from "./cloud-home.mjs";
import { createHomeWindow, createReadyClock, FRESH_MS, HOME_SCREEN_PATH, NAME_RETRY_MS, NAME_WAIT_MS, nameNotFound, RETRY_MS } from "./home-window.mjs";

const CLOUD = "https://omb-u-new1.fly.dev";
const TEAM = "https://omb-u-acme.fly.dev";
const LOCAL = "http://127.0.0.1:8799";
const SCREEN = `${LOCAL}${HOME_SCREEN_PATH}`;
const ACCOUNT = { id: "acct-1", email: "person@example.test" };
const NOW = 1_800_000_000_000;
const settingUp = (setup = { step: "storage" }) => ({ status: "connected", account: ACCOUNT, machine: { status: "provisioning", origin: CLOUD, setup } });
const ready = (machine = {}) => ({ status: "connected", account: ACCOUNT, machine: { status: "ready", origin: CLOUD, ...machine } });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * The window before the move (no journal: My Cloud is a saved server here) with a fake Admin session (`state`), My Cloud
 * at CLOUD whose name resolves only while `dns.found`, the window's Electron session (its resolver and host cache), the
 * file that keeps when My Cloud became ready, and a manual clock.
 */
function world({ journal = null, state = settingUp(), found = true, url = `${LOCAL}/`, kept = null } = {}) {
  const w = {
    journal, state, url, clock: NOW, now: () => w.clock,
    dns: { found }, server: { up: true, signedIn: true },
    went: [], fetched: [], published: [], local: [], pairs: 0, timers: [],
    /** Each lookup of a name, by any path: the window's look, its resolver, its page loads. */
    lookups: [], cleared: 0, resolved: [], kept,
  };
  const timers = {
    set: (work, ms) => { const timer = { work, at: w.clock + ms, ms }; w.timers.push(timer); return timer; },
    clear: (timer) => { w.timers = w.timers.filter((entry) => entry !== timer); },
    every: () => ({}),
  };
  w.window = { isDestroyed: () => false, webContents: { id: 7, mainFrame: { get url() { return w.url; } }, getURL: () => w.url, reload: () => {} } };
  const account = {
    state: () => w.state,
    power: () => null,
    wakeHome: async () => "awake",
    setWaking: () => {},
    async pairHome() { w.pairs++; return { origin: CLOUD, code: "AAAA-BBBB-CCCC", expiresAt: w.clock + 60_000 }; },
    signInAgain: async () => {},
    begin: async () => {},
  };
  const nameOf = (url) => new URL(url).hostname;
  w.home = createHomeWindow({
    journal: () => w.journal,
    frozen: async () => null,
    account: () => account,
    window: () => w.window,
    ensureWindow: () => {},
    localOrigin: () => LOCAL,
    cookieFetch: async (url) => {
      w.lookups.push(nameOf(url));
      w.fetched.push(String(url).replace(CLOUD, ""));
      if (!w.dns.found) throw new TypeError("fetch failed", { cause: new Error("net::ERR_NAME_NOT_RESOLVED") });
      if (!w.server.up) throw new TypeError("fetch failed");
      const route = String(url).replace(CLOUD, "");
      if (route === "/api/health") return new Response("", { status: 200 });
      if (route === "/api/auth/session") return w.server.signedIn ? json({ kind: "session" }) : json({ error: "sign in" }, 401);
      if (route === "/.well-known/openmausbot/environment") return json({ version: "0.1.122" });
      return json({}, 404);
    },
    power: { asleep: () => false, hold: () => {}, woke: () => {} },
    go: async (url, origin) => {
      w.went.push([url, origin]);
      if (origin) w.lookups.push(nameOf(url));
      w.url = url;
    },
    showLocal: (leaving) => { w.local.push(leaving); if (leaving) w.url = `${LOCAL}/`; },
    publish: (view) => w.published.push(view),
    hosts: () => ({
      clearHostResolverCache: async () => { w.cleared++; },
      resolveHost: async (host, options) => {
        w.lookups.push(host); w.resolved.push([host, options?.cacheUsage ?? null]);
        if (!w.dns.found) throw new Error("net::ERR_NAME_NOT_RESOLVED");
        return { endpoints: [{ address: "66.241.124.1", family: "ipv4" }] };
      },
    }),
    readyStore: { read: () => w.kept, write: (value) => { w.kept = value; } },
    now: w.now,
    timers,
    log: () => {},
  });
  /** The Admin's next word reaches main (its onState), as the app hands it to the window. */
  w.says = async (next) => { w.state = next; await w.home.changed(); };
  w.later = async (ms) => {
    w.clock += ms;
    const due = w.timers.filter((timer) => timer.at <= w.clock);
    w.timers = w.timers.filter((timer) => timer.at > w.clock);
    for (const timer of due) timer.work();
    for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve));
  };
  /** The page load main's go() started: it commits, or Chromium reports its net error to main's did-fail-load. */
  w.loaded = () => w.home.navigated(w.url);
  w.loadFails = (code) => w.home.failed(w.url, code);
  w.cloudLookups = () => w.lookups.filter((host) => host === nameOf(CLOUD)).length;
  return w;
}

test("the Admin's word decides what counts as My Cloud's address: only a ready machine's, so nothing looks it up while it is set up", () => {
  assert.equal(readyCloudOrigin(settingUp()), null);
  assert.equal(readyCloudOrigin(ready()), CLOUD);
  assert.equal(readyCloudOrigin({ ...ready(), status: "unavailable" }), null);
  assert.deepEqual(cloudSetupOf(settingUp()), { step: "storage" });
  assert.deepEqual(cloudSetupOf(settingUp({ step: "starting", slow: true })), { step: "starting", slow: true });
  assert.deepEqual(cloudSetupOf({ status: "connected", account: ACCOUNT, machine: { status: "provisioning" } }), {});
  assert.deepEqual(cloudSetupOf({ status: "connected", account: ACCOUNT, purchase: { state: "confirming" } }), {}, "paid, and the session hasn't caught up with a machine yet");
  for (const state of [ready(), { status: "connected", account: ACCOUNT }, { status: "connected", account: ACCOUNT, purchase: { state: "held" } }, { status: "signed-out" }, null])
    assert.equal(cloudSetupOf(state), null, JSON.stringify(state));
  // Files, lending and the one-time move ask myCloudOrigin(): it never names a Cloud being set up, remembered or not.
  const remembered = rememberedCloudHome(null, settingUp());
  assert.equal(remembered, null);
  const account = (state) => ({ homeTarget: () => (readyCloudOrigin(state) ? { origin: readyCloudOrigin(state) } : null), state: () => state });
  assert.equal(myCloudOrigin({ account: account(settingUp()), remembered, remoteAccess: null }), null);
  const known = rememberedCloudHome(null, ready());
  assert.equal(rememberedCloudHome(known, settingUp()), null, "the same address being set up again is not looked up either");
  assert.equal(myCloudOrigin({ account: account(ready()), remembered: known, remoteAccess: null }), CLOUD);
});

test("asked for while the Admin sets it up: the setup screen with its step, nothing looks up My Cloud's address, and it opens by itself once ready", async () => {
  const w = world();
  await w.home.openCloud();
  assert.deepEqual(w.home.view(), { screen: "setup", step: "storage" });
  assert.deepEqual(w.went, [[SCREEN, null]], "this computer's screen, never My Cloud's address");
  w.url = SCREEN;
  assert.equal(w.home.asking(), true);
  // The screen asks again as it loads, when focused and when back online: still set up, still nothing looked up.
  await w.home.retry();
  await w.says(settingUp({ step: "checking", slow: true }));
  assert.deepEqual(w.home.view(), { screen: "setup", step: "checking", slow: true });
  assert.deepEqual(w.published.at(-1), w.home.view(), "the screen is told each step");
  assert.equal(w.cloudLookups(), 0, `nothing asked for ${CLOUD} while it was set up: ${JSON.stringify(w.fetched)}`);
  assert.deepEqual([w.went.length, w.pairs, w.timers.length], [1, 0, 0], "it waits on the Admin's word, with no timer of its own");

  await w.says(ready());
  assert.deepEqual(w.fetched, ["/api/health", "/api/auth/session"], "ready: the same look and session check as any open");
  assert.deepEqual(w.went.at(-1), [CLOUD, CLOUD], "opened by itself, with nothing pressed");
  w.loaded();
  assert.equal(w.home.asking(), false);
  await w.says(ready({ disk: { gb: 20, maxGb: 40 } }));
  assert.equal(w.went.length, 2, "once open, the session's next words leave the page alone");
  assert.deepEqual(w.local, [], "never sent back to this computer's page");
});

test("a payment the Admin is still confirming shows the setup screen too, at its first step", async () => {
  const w = world({ state: { status: "connected", account: ACCOUNT, purchase: { state: "confirming", tier: "pro" } } });
  await w.home.openCloud("phone");
  assert.deepEqual(w.home.view(), { screen: "setup" });
  w.url = SCREEN;
  await w.says(settingUp({ step: "reserving" }));
  assert.deepEqual(w.home.view(), { screen: "setup", step: "reserving" });
  await w.says(ready());
  assert.deepEqual(w.went.at(-1), [`${CLOUD}/?desktop-settings=phone`, CLOUD], "what was asked for (its phone pairing) is what opens");
  assert.equal(w.cloudLookups(), 3, "looked up only once ready: its look, its session, its page");
});

test("nothing to open (no Cloud, or not signed in): asking says so, as before, and the window stays where it is", async () => {
  for (const state of [{ status: "connected", account: ACCOUNT }, { status: "signed-out" }, ready({ status: "stopped" })]) {
    const w = world({ state });
    await assert.rejects(w.home.openCloud(), /not ready/);
    assert.deepEqual([w.went, w.fetched, w.home.asking()], [[], [], false], JSON.stringify(state));
  }
});

test("going somewhere else from the setup screen lets My Cloud go: the Server menu's choice stands when it becomes ready", async () => {
  for (const elsewhere of [`${LOCAL}/`, "https://vps.example.test/"]) {
    const w = world();
    await w.home.openCloud();
    w.url = SCREEN; w.home.navigated(SCREEN);
    assert.equal(w.home.asking(), true, "its own screen keeps it");
    w.url = elsewhere; w.home.navigated(elsewhere);
    assert.equal(w.home.asking(), false, elsewhere);
    await w.says(ready());
    await w.home.retry();
    assert.deepEqual([w.went.length, w.fetched, w.local], [1, [], [false]], elsewhere);
  }
});

test("a brand-new Cloud whose name isn't found yet keeps the setup screen and opens by itself once found, Chromium's host cache cleared before each try", async () => {
  const w = world({ found: false });
  await w.says(settingUp());
  await w.says(ready());
  assert.deepEqual(w.kept, { origin: CLOUD, readyAt: NOW }, "kept: when this app saw it become ready");
  await w.home.openCloud();
  assert.deepEqual(w.home.view(), { screen: "setup", step: "checking" }, "not the offline screen, not \"choose it again\"");
  assert.deepEqual(w.went, [[SCREEN, null]]);
  assert.deepEqual(w.resolved, [["omb-u-new1.fly.dev", "disallowed"]], "Electron's own resolver, past its cache");
  w.url = SCREEN;
  assert.deepEqual(w.timers.map((timer) => timer.ms), [NAME_RETRY_MS[0]]);
  for (const ms of NAME_RETRY_MS.slice(0, 3)) {
    const cleared = w.cleared;
    await w.later(ms);
    assert.equal(w.cleared, cleared + 1, `the host cache is cleared before the try after ${ms} ms`);
    assert.deepEqual(w.home.view(), { screen: "setup", step: "checking" });
  }
  assert.deepEqual(w.timers.map((timer) => timer.ms), [NAME_RETRY_MS[3]], "backing off");
  w.dns.found = true;
  await w.later(NAME_RETRY_MS[3]);
  assert.deepEqual(w.went.at(-1), [CLOUD, CLOUD], "found: My Cloud opens with nothing pressed");
  w.loaded();
  assert.deepEqual([w.home.asking(), w.timers.length], [false, 0]);
});

test("the window's own load of a brand-new Cloud failing on its name (ERR_NAME_NOT_RESOLVED) is waited out too, not the old fall-back dialog", async () => {
  const w = world();
  await w.says(settingUp());
  await w.says(ready());
  await w.home.openCloud();
  assert.deepEqual(w.went, [[CLOUD, CLOUD]], "the look found it");
  w.dns.found = false;
  assert.equal(w.loadFails(-105), true, "main shows no dialog: the window has it");
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(w.home.view(), { screen: "setup", step: "checking" });
  assert.deepEqual(w.went.at(-1), [SCREEN, null]);
  w.url = SCREEN;
  w.dns.found = true;
  await w.later(NAME_RETRY_MS[0]);
  assert.equal(w.cleared, 1);
  assert.deepEqual(w.went.at(-1), [CLOUD, CLOUD]);
  assert.equal(w.home.failed("https://vps.example.test/", -105), false, "another server's failure is still main's to say");
});

test("after ten minutes without its name the offline screen shows, and it still opens by itself once the name is found", async () => {
  const w = world({ found: false });
  await w.says(settingUp());
  await w.says(ready());
  await w.home.openCloud();
  w.url = SCREEN;
  let waited = 0;
  while (w.home.view().screen === "setup") {
    const [timer] = w.timers;
    waited += timer.ms;
    await w.later(timer.ms);
    assert.ok(waited <= NAME_WAIT_MS + NAME_RETRY_MS.at(-1), `gave up in time: ${waited} ms`);
  }
  assert.ok(waited >= NAME_WAIT_MS, `waited ${waited} ms`);
  assert.equal(w.home.view().screen, "offline");
  assert.deepEqual(w.timers.map((timer) => timer.ms), [RETRY_MS[0]], "the offline screen's own tries go on");
  const cleared = w.cleared;
  w.dns.found = true;
  await w.later(RETRY_MS[0]);
  assert.equal(w.cleared, cleared + 1, "still past a cached \"no such name\"");
  assert.deepEqual(w.went.at(-1), [CLOUD, CLOUD]);
});

test("an older Cloud's name failing is the offline screen at once, as before: only a Cloud ready within minutes is waited out", async () => {
  // Never seen being set up: listed ready from the start.
  const known = world({ state: ready(), found: false });
  await known.home.openCloud();
  assert.equal(known.home.view().screen, "offline");
  assert.deepEqual(known.resolved, [], "nothing special is looked up for it");
  assert.deepEqual(known.timers.map((timer) => timer.ms), [RETRY_MS[0]]);
  // Became ready over FRESH_MS ago (kept across a launch).
  const old = world({ state: ready(), found: false, kept: { origin: CLOUD, readyAt: NOW - FRESH_MS - 1 } });
  await old.home.openCloud();
  assert.equal(old.home.view().screen, "offline");
  // Its page failing on its name the same.
  const page = world({ state: ready(), url: `${CLOUD}/chats` });
  assert.equal(page.home.failed(`${CLOUD}/chats`, -105), true);
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(page.home.view().screen, "offline", "My Cloud is never sent to the fall-back dialog");
  assert.deepEqual(page.went, [[SCREEN, null]]);
});

test("a Cloud ready a few minutes before a launch is still brand-new after it; one that became ready on another day is not", () => {
  let clock = NOW, kept = null;
  const store = { read: () => kept, write: (value) => { kept = value; } };
  const first = createReadyClock({ store, now: () => clock });
  first.seen(ready());
  assert.equal(kept, null, "first seen ready: not seen becoming ready");
  first.seen(settingUp());
  clock += 60_000;
  first.seen(ready());
  assert.deepEqual(kept, { origin: CLOUD, readyAt: NOW + 60_000 });
  clock += 5 * 60_000;
  const relaunched = createReadyClock({ store, now: () => clock });
  assert.equal(relaunched.fresh(CLOUD), true);
  assert.equal(relaunched.fresh(TEAM), false);
  clock += FRESH_MS;
  assert.equal(relaunched.fresh(CLOUD), false);
  assert.equal(createReadyClock({ store: { read: () => { throw new Error("no file"); }, write: () => {} } }).fresh(CLOUD), false);
});

test("Chromium's name errors are the ones waited out; a refused or reset connection is not", () => {
  for (const code of [-105, -137, -800, -803, -804]) assert.equal(nameNotFound(code), true, String(code));
  for (const code of [0, -2, -3, -7, -100, -101, -102, -106, -118, -200, -900]) assert.equal(nameNotFound(code), false, String(code));
});

test("once home, a Cloud the Admin sets up again shows the setup screen and is not looked up; a team's Cloud being set up the same, by name", async () => {
  const moved = { v: 1, phase: "done", cloud: { origin: CLOUD, account: ACCOUNT.id, machine: CLOUD }, doneAt: 1 };
  const w = world({ journal: moved, state: settingUp({ step: "starting" }) });
  await w.home.show();
  assert.deepEqual(w.home.view(), { screen: "setup", step: "starting" });
  assert.deepEqual([w.went, w.fetched], [[[SCREEN, null]], []]);
  w.url = SCREEN;
  await w.says(ready());
  assert.deepEqual(w.went.at(-1), [CLOUD, CLOUD]);

  const acme = { id: "team-acme", name: "Acme", role: "member", machine: { status: "provisioning", origin: TEAM, setup: { step: "reserving" } } };
  const team = world({ state: { ...ready(), teams: [acme] } });
  await team.home.show({ place: { team: "team-acme" } });
  assert.deepEqual(team.home.view(), { screen: "setup", step: "reserving", name: "Acme" });
  assert.deepEqual([team.went, team.fetched], [[[SCREEN, null]], []], "the team's address is not looked up either");
  const early = world({ state: { ...ready(), teams: [{ ...acme, machine: { status: "provisioning" } }] } });
  await early.home.show({ place: { team: "team-acme" } });
  assert.deepEqual(early.home.view(), { screen: "setup", name: "Acme" }, "no address yet: still being set up, never a plan problem");
});
