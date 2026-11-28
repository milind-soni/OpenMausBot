import assert from "node:assert/strict";
import test from "node:test";

import { createPlaceChatMain, PLACE_CHAT_LABEL } from "./place-chat-main.mjs";
import { createPlacesTogether, installPlacesTogether } from "./places-together.mjs";

const CLOUD = "https://mine.cloud.test";
const TOKEN = "omb_sess_abcdefghijklmnop";
const answer = (status, body) => ({ ok: status < 400, status, json: async () => body, body: { cancel: async () => {} } });
const settle = () => new Promise((done) => setImmediate(done));

function setup(over = {}) {
  const f = { cloud: { origin: CLOUD, account: "acct-a", asleep: false }, asked: [], told: [], grants: 0, wakes: 0, waited: [], pair: () => answer(200, { token: TOKEN }), ...over };
  f.chat = createPlaceChatMain({
    cloud: () => f.cloud,
    grant: async () => { f.grants += 1; return { origin: f.cloud.origin, code: `code-${f.grants}` }; },
    wake: async () => { f.wakes += 1; f.cloud = { ...f.cloud, asleep: false }; },
    server: () => ({ postMessage: (message) => f.told.push(message) }),
    fetch: async (url, init) => { f.asked.push([url, init]); if (url.endsWith("/api/auth/pair")) return f.pair(); return answer(200, { ok: true }); },
    delay: async (ms) => { f.waited.push(ms); },
  });
  return f;
}

test("nothing is opened at My Cloud until a row is clicked; the click opens one session, kept for the run and told to this computer's server only", async () => {
  const f = setup();
  await settle();
  assert.deepEqual([f.asked, f.told, f.grants], [[], [], 0], "nothing at start");
  assert.deepEqual(await f.chat.ensure(), { ok: true });
  assert.equal(f.asked.length, 1);
  const [url, init] = f.asked[0];
  assert.equal(url, `${CLOUD}/api/auth/pair`);
  assert.equal(init.credentials, "omit");
  assert.deepEqual(JSON.parse(init.body), { code: "code-1", label: PLACE_CHAT_LABEL });
  assert.deepEqual(f.told, [{ type: "openmausbot:place-session", place: "cloud", origin: CLOUD, token: TOKEN }]);
  // The next click reuses it, and tells the server again (it may have restarted since).
  assert.deepEqual(await f.chat.ensure(), { ok: true });
  assert.equal(f.grants, 1);
  assert.equal(f.told.length, 2);
});

test("a sleeping My Cloud is woken through the Admin first, and a Cloud still starting is asked again until it answers", async () => {
  let tries = 0;
  const f = setup({ cloud: { origin: CLOUD, account: "acct-a", asleep: true }, pair: () => { tries += 1; if (tries < 3) throw new Error("starting"); return answer(200, { token: TOKEN }); } });
  assert.deepEqual(await f.chat.ensure(), { ok: true });
  assert.equal(f.wakes, 1);
  assert.equal(tries, 3);
  assert.equal(f.grants, 3, "each try redeems a fresh one-time code");
  assert.equal(f.waited.length, 2);
});

test("a code My Cloud refuses ends the click at once: the page opens My Cloud's page instead", async () => {
  const f = setup({ pair: () => answer(403, { error: "no" }) });
  assert.deepEqual(await f.chat.ensure(), { ok: false });
  assert.deepEqual(f.told, []);
  assert.deepEqual(f.waited, []);
});

test("the session is signed out at My Cloud and dropped from the server when let go, and when the account changes", async () => {
  const f = setup();
  await f.chat.ensure();
  f.asked.length = 0;
  await f.chat.close();
  assert.equal(f.asked.length, 1);
  assert.equal(f.asked[0][0], `${CLOUD}/api/auth/logout`);
  assert.equal(f.asked[0][1].headers.authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(f.told.at(-1), { type: "openmausbot:place-session", place: "cloud", token: null });
  assert.equal(f.chat.open(), false);
  await f.chat.ensure();
  f.cloud = { ...f.cloud, account: "acct-b" };
  f.asked.length = 0;
  await f.chat.ensure();
  assert.deepEqual(f.asked.map(([url]) => url.slice(CLOUD.length)), ["/api/auth/logout", "/api/auth/pair"], "the old one signed out, a new one opened");
});

test("a session My Cloud refused is replaced when asked: the old one let go, a new one opened", async () => {
  const f = setup();
  await f.chat.ensure();
  f.asked.length = 0;
  assert.deepEqual(await f.chat.ensure({ fresh: true }), { ok: true });
  assert.deepEqual(f.asked.map(([url]) => url.slice(CLOUD.length)), ["/api/auth/logout", "/api/auth/pair"]);
  assert.equal(f.grants, 2);
});

test("a session redeemed after the account changed is signed out, never kept or told to the server", async () => {
  let release;
  const f = setup({ pair: () => new Promise((done) => { release = done; }) });
  const opening = f.chat.ensure();
  await settle();
  f.cloud = { ...f.cloud, account: "acct-b" };
  release(answer(200, { token: TOKEN }));
  assert.deepEqual(await opening, { ok: false });
  assert.equal(f.chat.open(), false);
  assert.deepEqual(f.told, []);
  await settle();
  assert.ok(f.asked.some(([url, init]) => url === `${CLOUD}/api/auth/logout` && init.headers.authorization === `Bearer ${TOKEN}`), "signed out at My Cloud");
});

test("no My Cloud, no session", async () => {
  const f = setup({ cloud: { origin: null, account: null, asleep: false } });
  assert.deepEqual(await f.chat.ensure(), { ok: false });
  assert.deepEqual(f.asked, []);
});

function together(inPlace, over = {}) {
  const changes = [];
  const f = { cloud: { origin: CLOUD, account: "acct-a", asleep: false }, saved: { v: 1, on: true } };
  f.together = createPlacesTogether({
    pref: { read: () => f.saved, write: (value) => { f.saved = value; } },
    cloud: () => f.cloud, computer: () => true, powerChecked: async () => true,
    local: async () => answer(200, { bots: [] }),
    cloudFetch: async () => answer(200, { bots: [{ id: "scout", threadId: "t1", name: "Scout" }] }),
    shown: () => "computer", focused: () => true, openPlace: () => new Promise(() => {}), send: () => {}, changed: () => changes.push(1),
    setTimer: () => ({}), clearTimer: () => {}, later: () => ({}), cancelLater: () => {}, startQuietMs: 0, inPlace, ...over,
  });
  f.changes = changes;
  return f;
}

test("only a bot main listed, and only from this computer's page: neither asks for a session", async () => {
  const calls = { ensure: 0 };
  const f = together({ ensure: async () => { calls.ensure += 1; return { ok: true }; }, close: () => {} });
  f.together.state("computer");
  await f.together.refresh("cloud");
  assert.deepEqual(await f.together.openInPlace("computer", "atlas"), { ok: false }, "not a bot main listed");
  assert.deepEqual(await f.together.openInPlace("cloud", "scout"), { ok: false }, "My Cloud's own page has nothing to open in place");
  assert.equal(calls.ensure, 0);
  assert.deepEqual(await f.together.openInPlace("computer", "scout"), { ok: true }, "a listed bot from this computer's page does");
  assert.equal(calls.ensure, 1);
});

test("the row says My Cloud is waking while the click readies it, and the session goes with the lists", async () => {
  let release;
  const calls = { close: 0 };
  const f = together({ ensure: () => new Promise((done) => { release = done; }), close: () => { calls.close += 1; } });
  f.together.state("computer");
  await f.together.refresh("cloud");
  f.cloud = { ...f.cloud, asleep: true };
  const opening = f.together.openInPlace("computer", "scout");
  assert.equal(f.together.state("computer").other.state, "waking");
  release({ ok: true });
  assert.deepEqual(await opening, { ok: true });
  assert.equal(f.together.state("computer").other.state, "asleep");
  const before = calls.close;
  f.together.set("computer", false);
  assert.equal(calls.close, before + 1, "switched off: the session is let go");
});

test("whether My Cloud is awake comes from the Admin's word, never from My Cloud, and only for this computer's page", async () => {
  let checks = 0, admin = true;
  const f = together({ ensure: async () => ({ ok: true }), close: () => {} }, { powerChecked: async () => { checks += 1; return admin; } });
  f.together.state("computer");
  await f.together.refresh("cloud");
  const before = checks;
  assert.equal(await f.together.cloudAwake("cloud"), false);
  assert.equal(checks, before, "My Cloud's own page is never answered");
  assert.equal(await f.together.cloudAwake("computer"), true);
  f.cloud = { ...f.cloud, asleep: true };
  assert.equal(await f.together.cloudAwake("computer"), false, "the Admin says it sleeps: not asked again");
  f.cloud = { ...f.cloud, asleep: false };
  admin = false;
  assert.equal(await f.together.cloudAwake("computer"), false, "the Admin could not be asked just now");
});

test("the page asks to open in place over its own channel, and main answers for its own page only", async () => {
  const handlers = new Map();
  const asked = [];
  installPlacesTogether({ ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }, asking: (event) => event.page,
    together: { openInPlace: async (asking, id, options) => { asked.push([asking, id, options]); return { ok: true }; } } });
  assert.deepEqual(await handlers.get("places-together:open-in-place")({ page: "local" }, "scout"), { ok: true });
  await handlers.get("places-together:open-in-place")({ page: "local" }, "scout", true);
  assert.deepEqual(asked, [["computer", "scout", { fresh: false }], ["computer", "scout", { fresh: true }]]);
  await assert.rejects(async () => handlers.get("places-together:open-in-place")({ page: null }, "scout"));
  assert.equal(asked.length, 2, "another page never reaches main's side");
});
