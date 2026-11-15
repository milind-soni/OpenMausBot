import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { botRow, botRows, CLOUD_EVERY_MS, createPlacesTogether, FRESH_MS, installPlacesTogether, LOOK_EVERY_MS, OPEN_WAIT_MS, otherHome, parseTogether } from "./places-together.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLOUD = "https://mine.cloud.test";
const answer = (status, body, headers = {}) => ({ ok: status < 400, status, headers: { get: (name) => headers[name] ?? null }, json: async () => body, body: { cancel: async () => {} } });
const bot = (id, name, over = {}) => ({ id, threadId: `t-${id}`, name, title: "", color: "blue", mascotBody: "classic", ...over });
const settle = () => new Promise((done) => setImmediate(done));

function setup(over = {}) {
  const f = {
    saved: "saved" in over ? over.saved : { v: 1, on: true }, asked: [], sent: [], opened: [], changes: 0, tick: null, cleared: 0, clock: 1_000,
    cloud: { origin: CLOUD, account: "acct-a", asleep: false }, computer: true, shown: "computer", focused: true, napped: 0, checks: 0, admin: true, timeouts: [], opening: new Promise(() => {}),
    bots: { computer: [bot("scout", "Scout")], cloud: [bot("scout", "Scout"), bot("nova", "Nova", { unread: true })] },
    reply: { computer: null, cloud: null },
  };
  f.together = createPlacesTogether({
    pref: { read: () => f.saved, write: (value) => { f.saved = value; } },
    cloud: () => f.cloud, computer: () => f.computer,
    powerChecked: async () => { f.checks += 1; f.asked.push(["admin"]); return typeof f.admin === "function" ? f.admin() : f.admin; },
    local: async (route, init) => { f.asked.push(["computer", route, init]); return f.reply.computer ?? answer(200, { bots: f.bots.computer }); },
    cloudFetch: async (url, init) => { f.asked.push(["cloud", url, init]); return typeof f.reply.cloud === "function" ? f.reply.cloud() : f.reply.cloud ?? answer(200, { bots: f.bots.cloud }); },
    napped: () => { f.napped += 1; },
    shown: () => f.shown, focused: () => f.focused, openPlace: (home) => { f.opened.push(home); return f.opening; },
    send: (channel, value) => { f.sent.push([channel, value]); },
    changed: () => { f.changes += 1; },
    now: () => f.clock,
    setTimer: (run, ms) => { f.tick = { run, ms }; return {}; }, clearTimer: () => { f.cleared += 1; },
    later: (run, ms) => { const timer = { run, ms, cancelled: false }; f.timeouts.push(timer); return timer; }, cancelLater: (timer) => { if (timer) timer.cancelled = true; },
    ...over.deps,
  });
  /** The next read of My Cloud is due: a minute has passed. */
  f.later = () => { f.clock += CLOUD_EVERY_MS; };
  f.cloudAsked = () => f.asked.filter(([side]) => side === "cloud").length;
  return f;
}

test("the switch starts off, and off reads nothing, keeps nothing and starts no timer", async () => {
  const f = setup({ saved: null });
  assert.equal(parseTogether(null), false);
  assert.equal(parseTogether({ v: 1, on: "yes" }), false);
  assert.deepEqual(f.together.state("computer"), { v: 1, available: true, on: false, here: "computer", other: null });
  await f.together.refresh("cloud");
  assert.equal(f.together.open("computer", "nova"), false);
  f.together.arrived();
  await settle();
  assert.deepEqual([f.asked, f.sent, f.opened, f.tick, f.changes], [[], [], [], null, 0]);
  assert.equal(f.together.on(), false);
});

test("on: this computer's page lists My Cloud's bots, asked as background work with the person's own session", async () => {
  const f = setup();
  assert.equal(f.together.state("computer").other.state, "loading");
  await f.together.refresh("cloud");
  const state = f.together.state("computer");
  assert.deepEqual(state.other, { home: "cloud", state: "ready", bots: [
    { home: "cloud", id: "scout", threadId: "t-scout", name: "Scout", color: "blue", mascotBody: "classic" },
    { home: "cloud", id: "nova", threadId: "t-nova", name: "Nova", color: "blue", mascotBody: "classic", unread: true },
  ] });
  assert.deepEqual(f.asked.map(([side]) => side), ["admin", "cloud"], "the Admin is asked whether it sleeps first, then My Cloud, once");
  const [, url, init] = f.asked[1];
  assert.deepEqual([url, init.headers["x-omb-background"], init.credentials, init.redirect], [`${CLOUD}/api/bots?messages=0`, "1", "include", "error"]);
  assert.equal(f.changes, 1);
});

test("My Cloud's page lists this computer's bots the same way", async () => {
  const f = setup();
  f.shown = "cloud";
  f.together.state("cloud");
  await f.together.refresh("computer");
  assert.deepEqual(f.together.state("cloud").other.bots.map((row) => [row.home, row.id]), [["computer", "scout"]]);
  assert.deepEqual(f.asked.map(([side, route]) => [side, route]), [["computer", "/api/bots?messages=0"]]);
  assert.equal(otherHome("cloud"), "computer");
  assert.equal(otherHome("local"), "cloud");
});

test("two bots with one id, one in each place, stay two: each list keeps its own and a click opens its own place", async () => {
  const f = setup();
  f.bots.computer = [bot("scout", "Scout here")];
  f.bots.cloud = [bot("scout", "Scout there")];
  await Promise.all([f.together.refresh("cloud"), f.together.refresh("computer")]);
  assert.equal(f.together.state("computer").other.bots[0].name, "Scout there");
  assert.equal(f.together.state("cloud").other.bots[0].name, "Scout here");
  assert.equal(f.together.open("computer", "scout"), true);
  await settle();
  assert.deepEqual(f.opened, ["cloud"]);
  f.shown = "cloud";
  f.together.arrived();
  assert.deepEqual(f.sent, [["desktop-notifications:open", { botId: "scout", threadId: "t-scout" }]]);
  assert.equal(f.together.open("cloud", "scout"), true);
  await settle();
  assert.deepEqual(f.opened, ["cloud", "computer"]);
});

test("a click opens only a bot main listed, and lands once that place's page has loaded", async () => {
  const f = setup();
  await f.together.refresh("cloud");
  assert.equal(f.together.open("computer", "ghost"), false);
  assert.equal(f.together.open("computer", "nova"), true);
  await settle();
  f.shown = null;
  f.together.arrived();
  f.shown = "computer";
  f.together.arrived();
  assert.deepEqual(f.sent, [], "nothing lands while the window still shows the old place or loads");
  f.shown = "cloud";
  f.together.arrived();
  f.together.arrived();
  assert.deepEqual(f.sent, [["desktop-notifications:open", { botId: "nova", threadId: "t-nova" }]]);
});

test("a click that waited too long for its place is dropped", async () => {
  const f = setup();
  await f.together.refresh("cloud");
  f.together.open("computer", "nova");
  f.timeouts.at(-1).run();
  f.shown = "cloud";
  f.together.arrived();
  assert.deepEqual(f.sent, []);
});

test("a sleeping Cloud is never asked; its bots stay listed and a click wakes it by opening it", async () => {
  const f = setup();
  await f.together.refresh("cloud");
  f.cloud = { ...f.cloud, asleep: true };
  f.asked.length = 0;
  f.later();
  await f.together.refresh("cloud");
  assert.equal(f.asked.length, 0);
  let other = f.together.state("computer").other;
  assert.deepEqual([other.state, other.bots.length], ["asleep", 2]);
  assert.equal(f.together.open("computer", "nova"), true);
  await settle();
  other = f.together.state("computer").other;
  assert.deepEqual([other.state, other.bots.length, f.opened], ["waking", 2, ["cloud"]]);
  assert.equal(f.cloudAsked(), 0, "main's own switch wakes it, as opening My Cloud always does");
});

test("a Cloud that answers it is going to sleep is held like a sleeping one", async () => {
  const f = setup();
  await f.together.refresh("cloud");
  f.reply.cloud = answer(503, { error: "asleep" }, { "x-omb-cloud-power": "asleep" });
  f.later();
  await f.together.refresh("cloud");
  assert.equal(f.napped, 1);
  assert.deepEqual([f.together.state("computer").other.state, f.together.state("computer").other.bots.length], ["asleep", 2]);
});

test("a place that can't be reached keeps its last list, and nothing is thrown at the page", async () => {
  const f = setup();
  await f.together.refresh("cloud");
  f.reply.cloud = answer(502, {});
  f.later();
  await f.together.refresh("cloud");
  assert.deepEqual([f.together.state("computer").other.state, f.together.state("computer").other.bots.length], ["offline", 2]);
  const g = setup({ deps: { cloudFetch: async () => { throw new Error("offline"); } } });
  await g.together.refresh("cloud");
  assert.deepEqual(g.together.state("computer").other, { home: "cloud", state: "offline", bots: [] });
});

test("this computer's bots are read again on the timer while the window shows one of the two places and is in use", async () => {
  const f = setup();
  f.shown = "cloud";
  f.together.state("cloud");
  await settle();
  assert.equal(f.tick.ms, LOOK_EVERY_MS);
  f.asked.length = 0;
  f.clock += LOOK_EVERY_MS;
  f.shown = null;
  f.tick.run();
  f.shown = "cloud";
  f.focused = false;
  f.tick.run();
  await settle();
  assert.equal(f.asked.length, 0);
  f.focused = true;
  f.tick.run();
  await settle();
  assert.deepEqual(f.asked.map(([side]) => side), ["computer"]);
  f.clock += FRESH_MS - 1;
  f.together.state("cloud");
  await settle();
  assert.equal(f.asked.length, 1, "a page that asks again at once gets the list just read");
});

test("My Cloud is asked at most once a minute however often a page or the timer asks", async () => {
  const f = setup();
  f.together.state("computer");
  await settle();
  assert.equal(f.cloudAsked(), 1);
  for (let i = 0; i < 5; i += 1) { f.clock += 9_000; f.together.state("computer"); f.tick.run(); await settle(); }
  assert.equal(f.cloudAsked(), 1);
  assert.equal(f.checks, 1, "nor is the Admin asked more often for it");
  f.clock += CLOUD_EVERY_MS;
  f.tick.run();
  await settle();
  assert.equal(f.cloudAsked(), 2);
});

test("My Cloud is never asked while the person is not using the window: behind other apps, or with the screen locked", async () => {
  const f = setup();
  f.focused = false;
  f.together.state("computer");
  f.tick.run();
  f.later();
  await f.together.refresh("cloud");
  await settle();
  assert.deepEqual(f.asked, []);
  assert.equal(f.together.state("computer").other.state, "loading");
  f.focused = true;
  f.together.state("computer");
  await settle();
  assert.equal(f.cloudAsked(), 1, "back in front, it is read at once");
});

test("My Cloud is asked only right after the Admin said it is awake: a Cloud that fell asleep since the last word is left asleep", async () => {
  const f = setup();
  await f.together.refresh("cloud");
  f.asked.length = 0;
  f.later();
  f.admin = () => { f.cloud = { ...f.cloud, asleep: true }; return true; };
  await f.together.refresh("cloud");
  assert.deepEqual(f.asked, [["admin"]], "the Admin's fresh word stopped the read");
  assert.deepEqual([f.together.state("computer").other.state, f.together.state("computer").other.bots.length], ["asleep", 2]);
});

test("when the Admin can't say whether My Cloud sleeps, My Cloud is not asked", async () => {
  const f = setup();
  f.admin = false;
  await f.together.refresh("cloud");
  assert.equal(f.cloudAsked(), 0);
  assert.equal(f.together.state("computer").other.state, "offline");
  const g = setup({ deps: { powerChecked: async () => { throw new Error("offline"); } } });
  await g.together.refresh("cloud");
  assert.equal(g.cloudAsked(), 0);
});

test("another account's Cloud never shows the last account's bots: asleep, it lists none and opens none", async () => {
  const f = setup();
  await f.together.refresh("cloud");
  assert.equal(f.together.state("computer").other.bots.length, 2);
  f.cloud = { origin: "https://other.cloud.test", account: "acct-b", asleep: true };
  f.together.scopeChanged();
  const other = f.together.state("computer").other;
  assert.deepEqual([other.state, other.bots], ["asleep", []]);
  assert.equal(f.together.open("computer", "nova"), false);
  await settle();
  assert.deepEqual(f.opened, []);
});

test("the same holds without being told: the same address under another account, and a sign-out, drop the list on the next ask", async () => {
  const f = setup();
  await f.together.refresh("cloud");
  f.cloud = { origin: CLOUD, account: "acct-b", asleep: true };
  assert.equal(f.together.open("computer", "nova"), false);
  assert.deepEqual(f.together.state("computer").other.bots, []);
  const g = setup();
  await g.together.refresh("cloud");
  g.together.open("computer", "nova");
  g.cloud = { origin: null, account: null, asleep: false };
  g.together.scopeChanged();
  assert.deepEqual(g.together.state("computer"), { v: 1, available: false, on: true, here: "computer", other: null });
  g.cloud = { origin: CLOUD, account: "acct-a", asleep: true };
  assert.deepEqual(g.together.state("computer").other.bots, [], "signed in again, nothing from before comes back");
  g.shown = "cloud";
  g.together.arrived();
  assert.deepEqual(g.sent, [], "the click from before the sign-out opens nothing");
});

test("a read still under way when the account changes is thrown away", async () => {
  let release;
  const f = setup();
  f.reply.cloud = () => new Promise((done) => { release = () => done(answer(200, { bots: [bot("old", "Old account's bot")] })); });
  const reading = f.together.refresh("cloud");
  await settle();
  f.cloud = { origin: "https://other.cloud.test", account: "acct-b", asleep: false };
  f.together.scopeChanged();
  release();
  await reading;
  f.reply.cloud = () => new Promise(() => {});
  assert.deepEqual(f.together.state("computer").other.bots, []);
  assert.equal(f.together.open("computer", "old"), false);
});

test("a Cloud this window is not signed in to says so once, lists nothing, and is not asked again until it has been opened", async () => {
  const f = setup();
  await f.together.refresh("cloud");
  f.reply.cloud = answer(401, { error: "unauthorized" });
  f.later();
  await f.together.refresh("cloud");
  assert.deepEqual(f.together.state("computer").other, { home: "cloud", state: "signin", bots: [] });
  const asked = f.cloudAsked();
  for (let i = 0; i < 3; i += 1) { f.later(); f.tick.run(); f.together.state("computer"); await settle(); }
  assert.equal(f.cloudAsked(), asked);
  f.reply.cloud = null;
  f.shown = "cloud";
  f.together.arrived();
  f.shown = "computer";
  await f.together.refresh("cloud");
  assert.equal(f.together.state("computer").other.state, "ready");
});

test("a wake that never comes stops saying it is waking: the wait ends on its own, and when the switch ends on the page it left", async () => {
  const f = setup();
  await f.together.refresh("cloud");
  f.cloud = { ...f.cloud, asleep: true };
  f.together.open("computer", "nova");
  assert.equal(f.together.state("computer").other.state, "waking");
  assert.equal(f.timeouts.at(-1).ms, OPEN_WAIT_MS);
  f.timeouts.at(-1).run();
  assert.equal(f.together.state("computer").other.state, "asleep");
  f.shown = "cloud";
  f.together.arrived();
  assert.deepEqual(f.sent, []);

  const g = setup();
  await g.together.refresh("cloud");
  g.cloud = { ...g.cloud, asleep: true };
  g.opening = Promise.resolve();
  g.together.open("computer", "nova");
  await settle();
  assert.equal(g.together.state("computer").other.state, "asleep", "main's switch ended and the window still shows this computer");
  assert.equal(g.timeouts.at(-1).cancelled, true);
});

test("going back to the page the click left ends the wait, so My Cloud opened later by another route opens as it is", async () => {
  const f = setup();
  await f.together.refresh("cloud");
  f.shown = null;
  f.together.open("computer", "nova");
  await settle();
  f.together.navigated(null);
  assert.equal(f.timeouts.at(-1).cancelled, false, "another screen on the way, such as the one shown while it wakes, changes nothing");
  f.together.navigated("computer");
  assert.equal(f.timeouts.at(-1).cancelled, true);
  f.shown = "cloud";
  f.together.navigated("cloud");
  f.together.arrived();
  assert.deepEqual(f.sent, []);
});

test("turning it off forgets every list and stops the timer; the choice is kept", async () => {
  const f = setup();
  f.together.state("computer");
  await f.together.refresh("cloud");
  f.together.open("computer", "nova");
  const off = f.together.set("computer", false);
  assert.deepEqual([off.on, off.other, f.saved, f.cleared], [false, null, { v: 1, on: false }, 1]);
  f.shown = "cloud";
  f.together.arrived();
  assert.deepEqual(f.sent, []);
  assert.equal(f.together.open("computer", "nova"), false);
  const on = f.together.set("computer", true);
  assert.deepEqual([on.on, on.other.bots, f.saved], [true, [], { v: 1, on: true }]);
});

test("without a My Cloud, or once this computer's bots moved away, there is nothing to join", async () => {
  const f = setup();
  f.cloud = { origin: null, account: null, asleep: false };
  assert.deepEqual(f.together.state("computer"), { v: 1, available: false, on: true, here: "computer", other: null });
  f.cloud = { origin: CLOUD, account: "acct-a", asleep: false };
  f.computer = false;
  assert.equal(f.together.state("cloud").available, false);
  assert.equal(f.together.on(), false);
  await f.together.refresh("cloud");
  assert.equal(f.asked.length, 0);
});

test("a row is a name, a look and a state: no messages, and no row for an archived bot or a move's pointer", () => {
  const full = bot("scout", " Scout ", { title: "Research", messages: [{ text: "secret" }], soul: "secret", modelSelection: { instanceId: "x" }, chiefOfStaff: true,
    tasks: [{ threadId: "t1", unread: true }, { threadId: "t2", activity: "waiting-on-you" }, { threadId: "t3", busy: true, routineRunId: "r" }] });
  assert.deepEqual(botRow(full, "cloud"), { home: "cloud", id: "scout", threadId: "t-scout", name: "Scout", title: "Research", color: "blue", mascotBody: "classic", chief: true, waiting: true, unread: true });
  assert.deepEqual(botRow(bot("w", "Worker", { busy: true }), "computer").working, true);
  assert.equal(botRow(bot("a", "Archived", { hidden: true }), "cloud"), null);
  assert.equal(botRow(bot("h", "Hidden from the sidebar", { sidebarHidden: true }), "cloud"), null);
  assert.equal(botRow(bot("m", "Moved", { hidden: true, movedTo: { state: "moved" } }), "computer"), null);
  assert.equal(botRow(bot("bad id", "X"), "cloud"), null);
  assert.equal(botRow(bot("x", "X", { color: "url(javascript:1)<" }), "cloud").color, undefined);
  assert.deepEqual(botRows({ bots: "no" }, "cloud"), []);
  assert.deepEqual(botRows(null, "cloud"), []);
});

test("only this computer's page and My Cloud's own page are answered", async () => {
  const handlers = new Map();
  const f = setup();
  installPlacesTogether({ ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }, asking: (event) => event.page, together: f.together });
  assert.deepEqual([...handlers.keys()], ["places-together:state", "places-together:set", "places-together:open"]);
  for (const handler of handlers.values()) assert.throws(() => handler({ page: null }, "nova"), /Only this computer's page and My Cloud's page/);
  assert.equal(handlers.get("places-together:state")({ page: "local" }).here, "computer");
  assert.equal(handlers.get("places-together:state")({ page: "cloud" }).here, "cloud");
  assert.equal(handlers.get("places-together:set")({ page: "local" }, "yes").on, false, "only true turns it on");
  assert.throws(() => handlers.get("places-together:set")({ page: "cloud" }, true), /from this computer's page/);
  assert.equal(f.saved.on, false, "My Cloud's page cannot start the joining");
  assert.equal(handlers.get("places-together:set")({ page: "local" }, true).on, true);
  assert.equal(handlers.get("places-together:set")({ page: "cloud" }, false).on, false, "either page may turn it off");
});

test("main wires it to the one rule for this app's own pages, and the preload offers it to those pages only through main", () => {
  const main = readFileSync(join(HERE, "main.mjs"), "utf8");
  assert.match(main, /installPlacesTogether\(\{ ipcMain, asking: cloudPageAsking, /);
  assert.match(main, /desktopNotifications\.arrived\(\); placesTogether\.arrived\(\);/);
  assert.match(main, /try \{ placesTogether\.scopeChanged\(\); \} catch \{\}/, "an account change or sign-out drops the lists at once");
  assert.match(main, /placesTogether\.navigated\(homeOfUrl\(url\)\)/);
  assert.match(main, /powerChecked: async \(\) => \{ const account = cloudAccount; if \(!account\) return false; await account\.refresh\(\); return Date\.now\(\) - \(account\.state\(\)\.verifiedAt \?\? 0\) < 5_000; \}/);
  assert.match(main, /focused: \(\) => powerMonitor\.getSystemIdleState\(60\) !== "locked" && Boolean\(mainWindow && !mainWindow\.isDestroyed\(\) && mainWindow\.isFocused\(\)\)/);
  assert.equal(main.match(/places-together:/g).length, 1, "main sends only that the list changed, never the list");
  const preload = readFileSync(join(HERE, "preload.cjs"), "utf8");
  assert.match(preload.match(/const REMOTE_SAFE = new Set\(\[([^\]]*)\]\)/)[1], /"placesTogether"/);
  const bridge = preload.slice(preload.indexOf("  placesTogether: "), preload.indexOf("  twoPlaces: {"));
  assert.deepEqual(bridge.match(/"places-together:[a-z]+"/g), ['"places-together:state"', '"places-together:set"', '"places-together:open"', '"places-together:changed"', '"places-together:changed"']);
});
