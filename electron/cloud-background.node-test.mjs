// What a signed-in app asks the Admin by itself, counted per hour: the session, the move's report, the pages and
// research relay tokens and the product-updates answer, wired as main.mjs wires them (its `onState`), over a fake clock and a
// fake Admin. Nobody touches the app here: these are background requests only.
import assert from "node:assert/strict";
import test from "node:test";

import { createCloudAccountClient } from "./cloud-account.mjs";
import { fixture, until } from "./fixtures/cloud-account.mjs";
import { createDesktopIncludedPages } from "./included-pages.mjs";
import { createDesktopIncludedX } from "./included-x.mjs";
import { installOneHome } from "./one-home-main.mjs";
import { createUpdatesConsent } from "./updates-consent.mjs";

const ORIGIN = "http://127.0.0.1:9";
const TOKEN = `omc_${"T".repeat(43)}`;
const HOUR = 3_600_000;
const CLOUD = "https://home-7f3k2.fly.dev";
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });

/**
 * One signed-in app. `paid`: an active plan with a ready Cloud of its own (moves off, so no move starts), else a free
 * account without one. `admin(key)`: a test's own answer for a route ("GET session", "POST move-status", ...), or
 * undefined for the healthy one; it may throw to stand for no answer at all. `attended()`: the window is in front.
 */
function app({ paid = false, admin = () => undefined, attended = () => false } = {}) {
  let clock = 1_800_000_000_000, journal = null, keep = null, consent = { status: "opted_in", version: "2026-10-23", at: 1, account: "acct-1" };
  const queue = [], counts = {}, realNow = Date.now, realRandom = Math.random;
  // Every wait unspread (a draw of 0.5), so the counts below are exact.
  Date.now = () => clock; Math.random = () => 0.5;
  const timers = { set: (work, ms) => { const timer = { work, at: clock + Math.max(0, ms) }; queue.push(timer); return timer; }, clear: (timer) => { const at = queue.indexOf(timer); if (at >= 0) queue.splice(at, 1); } };
  const session = () => ({ cloudContractVersion: 1, expiresAt: clock + 30 * 24 * HOUR, device: { id: "device-1" }, account: { id: "acct-1", email: "person@example.test" },
    entitlement: paid ? { plan: "pro", tier: "personal", status: "active", expiresAt: clock + 20 * 24 * HOUR, version: 3 } : { plan: "free", status: "inactive", expiresAt: null, version: 0 },
    ...(paid ? { cloud: { state: "ready", origin: CLOUD } } : {}), clouds: [], latestVersion: "0.1.182" });
  const healthy = (key) => {
    if (key === "GET session") return json(session());
    if (key === "POST move-status") return json({ cloudContractVersion: 1, recorded: true });
    if (key === "POST services/pages") return json({ cloudContractVersion: 1, url: `${ORIGIN}/api/pages/token`, token: `omb_pd_${"P".repeat(43)}` });
    if (key === "POST services/x") return paid ? json({ cloudContractVersion: 1, url: `${ORIGIN}/api/x`, token: `omb_xd_${"X".repeat(43)}` }) : json({ error: "subscription_inactive" }, 402);
    if (key === "GET updates-consent") return json({ cloudContractVersion: 1, consent: { status: "opted_in", textVersion: "2026-10-23" } });
    return json({ error: "not_found" }, 404);
  };
  const fetch = async (url, init = {}) => {
    const key = `${init.method ?? "GET"} ${new URL(url).pathname.replace("/api/cloud/desktop/", "")}`;
    counts[key] = (counts[key] ?? 0) + 1;
    return (await admin(key)) ?? healthy(key);
  };
  const saved = { origin: ORIGIN, token: TOKEN, expiresAt: clock + 30 * 24 * HOUR, device: { id: "device-1" }, account: { id: "acct-1", email: "person@example.test" } };
  let main = null, includedX = null, includedPages = null, updates = null;
  const client = createCloudAccountClient({ origin: ORIGIN, fixture: true, deviceName: "Fixture computer", platform: "darwin", appVersion: "0.1.182", now: () => clock, fetch,
    store: { read: async () => saved, write: async () => {} }, openBrowser: async () => {}, warn: () => {},
    setTimer: timers.set, clearTimer: timers.clear, random: () => 0.5, attended,
    // As main.mjs's `onState`: everything that follows the sign-in hears each state.
    onState: (state) => { void main?.kick(); void includedX?.onState(state); void includedPages?.onState(state); updates?.accountChanged(state); } });
  main = installOneHome({
    ipcMain: { handle: () => {} }, cloudPage: () => "local", server: () => null, home: () => null, cookieFetch: async () => json({}, 401),
    reconnect: async () => false, power: { asleep: () => false }, file: () => "/nonexistent/cloud-send.json", window: () => null, localOrigin: () => "http://127.0.0.1:4100",
    fetch: async () => json({}, 404), account: () => client, journalFile: () => "/nonexistent/one-home.json", tempRoot: () => "/nonexistent",
    localRequest: async (route) => (route === "/api/move/freeze" ? json({ frozen: false }) : json({}, 404)),
    journal: { read: () => journal, write: (value) => { journal = value; } }, keep: { read: () => keep, write: (value) => { keep = value; } },
    version: "0.1.182", reportTimers: timers,
  });
  includedX = createDesktopIncludedX({ account: () => client, server: () => null, log: () => {}, now: () => clock, timers });
  includedPages = createDesktopIncludedPages({ account: () => client, server: () => null, log: () => {}, now: () => clock, timers });
  updates = createUpdatesConsent({ prefs: { installId: () => "install-1", updatesConsent: () => consent, setUpdatesConsent: (value) => { consent = value; return true; } },
    account: () => client, available: async () => true, now: () => clock });
  const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((resolve) => setImmediate(resolve)); };
  return {
    client, updates, counts,
    now: () => clock,
    started: 0,
    async start() { await client.start(); await settle(); },
    /** Moves the clock on, running each timer that comes due on the way. */
    async pass(ms) {
      const until = clock + ms;
      for (;;) {
        queue.sort((a, b) => a.at - b.at);
        const next = queue[0];
        if (!next || next.at > until) break;
        queue.shift();
        clock = next.at;
        next.work();
        await settle();
      }
      clock = until;
      await settle();
    },
    /** Counts from now on. */
    reset() { for (const key of Object.keys(counts)) delete counts[key]; this.started = clock; },
    close() { main.close(); client.close(); Date.now = realNow; Math.random = realRandom; },
  };
}

const ROUTES = ["GET session", "POST move-status", "POST services/pages", "POST services/x", "GET updates-consent"];
/** An hour's requests per route, after the first ten minutes (the launch's own asks: the session, one report, one of each token, the updates answer). */
async function hour(options, during = async () => {}) {
  const a = app(options);
  try {
    await a.start();
    await a.pass(10 * 60_000);
    a.reset();
    await during(a);
    await a.pass(HOUR - (a.now() - a.started));
    return Object.fromEntries(ROUTES.map((route) => [route, a.counts[route] ?? 0]));
  } finally { a.close(); }
}
const failing = {
  "503": () => json({ error: "unavailable" }, 503),
  "429 with Retry-After": () => json({ error: "rate_limited" }, 429, { "retry-after": "60" }),
  "no answer": () => { throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }); },
};

// Before this change, measured the same way on the code it replaced: an idle signed-in app sent 60 session reads and 4 move
// reports an hour with a healthy Admin; with an Admin failing the other routes, 60 move reports, 60 pages token asks and
// (on a paid plan) 60 research relay token asks an hour on top, one per session read, since each read's state asked again.
test("an idle signed-in app, healthy Admin, window in the back: 12 session reads an hour and nothing else (was 60 + 4 move reports)", async () => {
  for (const paid of [false, true]) {
    const counts = await hour({ paid });
    assert.deepEqual(counts, { "GET session": 12, "POST move-status": 0, "POST services/pages": 0, "POST services/x": 0, "GET updates-consent": 0 }, paid ? "paid" : "free");
  }
});

test("the same app with its window in front reads the session every minute, as before, and still nothing else", async () => {
  const counts = await hour({ paid: true, attended: () => true });
  assert.deepEqual(counts, { "GET session": 60, "POST move-status": 0, "POST services/pages": 0, "POST services/x": 0, "GET updates-consent": 0 });
});

test("an Admin failing everything but the session: the move's report backs off to 2 an hour, the tokens to every 5 minutes, instead of going with every session read (was 60 an hour each)", async () => {
  for (const [name, answer] of Object.entries(failing)) {
    const counts = await hour({ paid: true, admin: (key) => (key === "GET session" ? undefined : answer()) });
    // The report: after the launch's try and the first ten minutes' (1, 2 and 5 minutes on), the 10-minute one and the first
    // 30-minute one. The tokens: 1, 2 and 5 minutes on, then every 5 minutes. (A Retry-After of 60 s changes neither.)
    assert.deepEqual(counts, { "GET session": 12, "POST move-status": 2, "POST services/pages": 12, "POST services/x": 12, "GET updates-consent": 0 }, name);
  }
});

test("someone looking (window in front or visible) with a failing Admin: the session is tried within the minute, as before", async () => {
  const counts = await hour({ paid: true, attended: () => true, admin: (key) => (key === "GET session" ? json({ error: "unavailable" }, 503) : undefined) });
  assert.equal(counts["GET session"], 60, "15 s, 30 s, then every minute: as many as before, never fewer");
});

test("an Admin failing everything: the session is tried after 15 s, 30 s, 1, 2, 4 minutes and then every 5 (was every minute), and the move's report twice an hour (was 60)", async () => {
  for (const [name, answer] of Object.entries(failing)) {
    const counts = await hour({ paid: true, admin: () => answer() });
    assert.deepEqual(counts, { "GET session": 12, "POST move-status": 2, "POST services/pages": 0, "POST services/x": 0, "GET updates-consent": 0 }, name);
  }
});

test("pages asking for the updates answer are answered from this run, read again only once the last read is 10 minutes old (each look asked the Admin before)", async () => {
  const counts = await hour({ paid: false }, async (a) => {
    for (let look = 0; look < 10; look++) { await a.updates.state(); await a.pass(5 * 60_000); }
  });
  assert.equal(counts["GET updates-consent"], 5, "10 looks 5 minutes apart: every other one reads (was 10)");
});

test("the Admin unreachable for 20 minutes, then back: the same sign-in gets its tokens back without new ones, and its updates answer is read once", async () => {
  let down = false;
  const counts = await hour({ paid: true, admin: () => (down ? json({ error: "unavailable" }, 503) : undefined) }, async (a) => {
    down = true;
    await a.pass(20 * 60_000);
    assert.equal(a.client.state().status, "unavailable", "the verified answer stopped counting meanwhile");
    down = false;
    await a.pass(6 * 60_000);
    assert.equal(a.client.state().status, "connected");
  });
  // Was: 1 new pages token, 1 new research relay token and 1 updates read on the way back, and a move report each minute meanwhile (19).
  assert.equal(counts["POST services/pages"], 0);
  assert.equal(counts["POST services/x"], 0);
  assert.equal(counts["GET updates-consent"], 1, "the sign-in verified again, and its last read over 10 minutes old");
  assert.equal(counts["POST move-status"], 3, "the report says it is unverified, and verified again, as each changes");
});

test("coming to the front reads the session at once when its answer is a minute old, and not again within the minute", async () => {
  let front = false;
  const a = app({ attended: () => front });
  try {
    await a.start();
    await a.pass(2 * 60_000);
    a.reset();
    front = true;
    a.client.freshen();
    await a.pass(1_000);
    assert.equal(a.counts["GET session"], 1);
    a.client.freshen();
    await a.pass(30_000);
    assert.equal(a.counts["GET session"], 1);
    await a.pass(30_000);
    assert.equal(a.counts["GET session"], 2, "in front: every minute from then on");
  } finally { a.close(); }
});

// The session's own waits, against the loopback fixture (fixtures/cloud-account.mjs).
test("nobody looking, a failing check never asks before the Admin's Retry-After, held to five minutes and spread only later, with a last try before the answer stops counting", async t => {
  let draw = 0.5;
  const f = await fixture(t, { random: () => draw, attended: () => false }); await f.connect();
  f.sessionError = { status: 429, body: { error: "rate_limited" }, headers: { "retry-after": "60" } };
  for (const [drawn, delay] of [[0, 60_000], [0.5, 66_000], [1, 72_000]]) { draw = drawn; await f.client.refresh(); assert.equal(f.delay, delay, "the Admin's own wait, not 15 s, spread up to a fifth later"); }
  f.sessionError.headers["retry-after"] = "3600"; draw = 0;
  await f.client.refresh();
  assert.equal(f.delay, 300_000, "an hour asked for is held to five minutes");
  f.now = f.client.state().verifiedUntil - 140_000;
  await f.client.refresh();
  assert.equal(f.delay, 120_000, "and never past 20 s before the verified answer stops counting");
  assert.equal(f.client.state().status, "connected");
});

test("a failing check while someone looks: 15 s, 30 s, then each minute, as before; while a sleeping Cloud is awaited: every 15 s", async t => {
  let front = true, waking = false;
  const f = await fixture(t, { attended: () => front, awaitingWake: () => waking }); await f.connect();
  f.sessionStatus = 503;
  const waits = [];
  for (let i = 0; i < 6; i++) { await f.client.refresh(); waits.push(f.delay); }
  assert.deepEqual(waits, [15_000, 30_000, 60_000, 60_000, 60_000, 60_000]);
  waking = true;
  await f.client.refresh();
  assert.equal(f.delay, 15_000);
  waking = false; front = false;
  await f.client.refresh();
  assert.equal(f.delay, 300_000, "nobody looking: the eighth failure waits 5 minutes");
});

test("coming to the front inside a failure's wait reads at once when the last read began a minute ago; under a minute, the next read moves up to a minute after the last", async t => {
  let front = false;
  const f = await fixture(t, { attended: () => front }); await f.connect();
  assert.equal(f.delay, 300_000, "in the back: 5 minutes");
  f.now += 20_000; front = true;
  const before = f.requests.length;
  assert.equal(f.client.freshen(), null, "the answer is 20 s old: not read again now");
  assert.equal(f.delay, 40_000, "the 5-minute read moves up to a minute after the last");
  f.sessionStatus = 503; front = false;
  for (let i = 0; i < 5; i++) await f.client.refresh();
  assert.equal(f.delay, 240_000, "in the back, failing: 4 minutes");
  f.now += 61_000; front = true;
  await f.client.freshen();
  assert.equal(f.requests.length, before + 6, "a minute after the last try: read now, inside the failure's wait");
  assert.equal(f.delay, 60_000, "and, in front, every minute from then on");
});

test("a failing check gets one last try before the verified answer stops counting, so a short outage never shows", async t => {
  const f = await fixture(t, { attended: () => false }); await f.connect();
  const counted = f.client.state().verifiedUntil;
  f.sessionStatus = 503;
  for (let i = 0; i < 6; i++) { f.now += f.delay; await f.client.refresh(); }
  assert.equal(f.now + f.delay, counted - 20_000, "after 5 minutes, then 15 s, 30 s, 1, 2 and 4 minutes, the next try is 20 s before the answer stops counting, not 5 minutes on");
  assert.equal(f.client.state().status, "connected");
  f.now += f.delay; f.sessionStatus = 200; await f.client.refresh();
  assert.equal(f.client.state().status, "connected");
});

test("nobody looking and nothing under way: the session every 5 minutes, spread a fifth either way; in front, every minute and never later; coming to the front reads it at once", async t => {
  let front = false, draw = 0.5;
  const f = await fixture(t, { attended: () => front, random: () => draw }); await f.connect();
  assert.equal(f.delay, 300_000);
  for (const [drawn, delay] of [[0, 240_000], [1, 360_000]]) { draw = drawn; await f.client.refresh(); assert.equal(f.delay, delay); }
  draw = 0.5;
  const before = f.requests.length;
  f.client.freshen();
  assert.equal(f.requests.length, before, "an answer under a minute old is not asked again");
  f.now += 61_000; front = true;
  f.client.freshen(); await until(() => f.requests.length === before + 1);
  await until(() => f.delay === 60_000);
  for (const [drawn, delay] of [[0, 48_000], [1, 48_000], [0.5, 60_000]]) { draw = drawn; await f.client.refresh(); assert.equal(f.delay, delay, "in front: never later than every minute"); }
  // A sign-in that must be redone is never read on coming to the front.
  f.revoked = true; await f.client.refresh();
  const ended = f.requests.length;
  f.now += 120_000; f.client.freshen();
  assert.equal(f.requests.length, ended);
});

test("while someone looks, a Retry-After an hour long still leaves a read each minute, as before", async t => {
  const f = await fixture(t, { attended: () => true }); await f.connect();
  f.sessionError = { status: 429, body: { error: "rate_limited" }, headers: { "retry-after": "3600" } };
  await f.client.refresh();
  assert.equal(f.delay, 60_000);
});

test("coming to the front never moves the next read later than it was", async t => {
  const f = await fixture(t, { attended: () => true, random: () => 0 }); await f.connect();
  assert.equal(f.delay, 48_000, "in front, spread sooner");
  f.now += 20_000;
  assert.equal(f.client.freshen(), null);
  assert.equal(f.delay, 48_000, "already due before a minute after the last read: left as it is");
});

test("triggers at the same moment (focus, show, wake, Try again) make one session read", async t => {
  const f = await fixture(t); await f.connect();
  f.now += 61_000;
  const before = f.requests.filter((row) => row.route.endsWith("/session")).length;
  await Promise.all([0, 1, 2, 3, 4].map(() => f.client.freshen()));
  assert.equal(f.requests.filter((row) => row.route.endsWith("/session")).length, before + 1);
});

test("while another account takes over, neither token is asked for with the sign-in before", async t => {
  const f = await fixture(t); await f.connect();
  f.pages = { status: 200, body: { cloudContractVersion: 1, url: `${f.origin}/api/pages/token`, token: `omb_pd_${"P".repeat(43)}` } };
  f.x = { status: 200, body: { cloudContractVersion: 1, url: `${f.origin}/api/x`, token: `omb_xd_${"X".repeat(43)}` } };
  assert.ok(await f.client.pagesAccess(), "signed in: the token comes");
  const before = f.requests.length;
  f.client.quiesce();
  await assert.rejects(f.client.pagesAccess(), /another account/i);
  await assert.rejects(f.client.xResearchAccess(), /another account/i);
  assert.equal(f.requests.length, before, "nothing reached the Admin");
});
