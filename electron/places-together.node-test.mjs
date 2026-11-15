import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { botRow, botRows, createPlacesTogether, installPlacesTogether, LOOK_EVERY_MS, OPEN_WAIT_MS, otherHome, parseTogether } from "./places-together.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLOUD = "https://mine.cloud.test";
const answer = (status, body, headers = {}) => ({ ok: status < 400, status, headers: { get: (name) => headers[name] ?? null }, json: async () => body, body: { cancel: async () => {} } });
const bot = (id, name, over = {}) => ({ id, threadId: `t-${id}`, name, title: "", color: "blue", mascotBody: "classic", ...over });
const settle = () => new Promise((done) => setImmediate(done));

function setup(over = {}) {
  const f = {
    saved: "saved" in over ? over.saved : { v: 1, on: true }, asked: [], sent: [], opened: [], changes: 0, tick: null, cleared: 0, clock: 1_000,
    cloud: { origin: CLOUD, asleep: false }, computer: true, shown: "computer", napped: 0,
    bots: { computer: [bot("scout", "Scout")], cloud: [bot("scout", "Scout"), bot("nova", "Nova", { unread: true })] },
    reply: { computer: null, cloud: null },
  };
  f.together = createPlacesTogether({
    pref: { read: () => f.saved, write: (value) => { f.saved = value; } },
    cloud: () => f.cloud, computer: () => f.computer,
    local: async (route, init) => { f.asked.push(["computer", route, init]); return f.reply.computer ?? answer(200, { bots: f.bots.computer }); },
    cloudFetch: async (url, init) => { f.asked.push(["cloud", url, init]); return f.reply.cloud ?? answer(200, { bots: f.bots.cloud }); },
    napped: () => { f.napped += 1; },
    shown: () => f.shown, openPlace: (home) => { f.opened.push(home); },
    send: (channel, value) => { f.sent.push([channel, value]); },
    changed: () => { f.changes += 1; },
    now: () => f.clock,
    setTimer: (run, ms) => { f.tick = { run, ms }; return {}; }, clearTimer: () => { f.cleared += 1; },
    ...over.deps,
  });
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
  const [side, url, init] = f.asked[0];
  assert.deepEqual([side, url, init.headers["x-omb-background"], init.credentials, init.redirect], ["cloud", `${CLOUD}/api/bots?messages=0`, "1", "include", "error"]);
  assert.equal(f.asked.some(([place]) => place === "computer"), false, "a page's own bots are its own to read");
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
  f.clock += OPEN_WAIT_MS + 1;
  f.shown = "cloud";
  f.together.arrived();
  assert.deepEqual(f.sent, []);
});

test("a sleeping Cloud is never asked; its bots stay listed and a click wakes it by opening it", async () => {
  const f = setup();
  await f.together.refresh("cloud");
  f.cloud = { origin: CLOUD, asleep: true };
  f.asked.length = 0;
  f.clock += 60_000;
  await f.together.refresh("cloud");
  assert.equal(f.asked.length, 0);
  let other = f.together.state("computer").other;
  assert.deepEqual([other.state, other.bots.length], ["asleep", 2]);
  assert.equal(f.together.open("computer", "nova"), true);
  await settle();
  other = f.together.state("computer").other;
  assert.deepEqual([other.state, other.bots.length, f.opened], ["waking", 2, ["cloud"]]);
  assert.equal(f.asked.length, 0, "main's own switch wakes it, as opening My Cloud always does");
});

test("a Cloud that answers it is going to sleep is held like a sleeping one", async () => {
  const f = setup();
  await f.together.refresh("cloud");
  f.reply.cloud = answer(503, {}, { "x-omb-cloud-power": "asleep" });
  await f.together.refresh("cloud");
  assert.equal(f.napped, 1);
  assert.deepEqual([f.together.state("computer").other.state, f.together.state("computer").other.bots.length], ["asleep", 2]);
});

test("a place that can't be reached keeps its last list, and nothing is thrown at the page", async () => {
  const f = setup();
  await f.together.refresh("cloud");
  f.reply.cloud = answer(502, {});
  await f.together.refresh("cloud");
  assert.deepEqual([f.together.state("computer").other.state, f.together.state("computer").other.bots.length], ["offline", 2]);
  const g = setup({ deps: { cloudFetch: async () => { throw new Error("offline"); } } });
  await g.together.refresh("cloud");
  assert.deepEqual(g.together.state("computer").other, { home: "cloud", state: "offline", bots: [] });
});

test("the list is read again on a timer only while the window shows one of the two places", async () => {
  const f = setup();
  f.together.state("computer");
  await settle();
  assert.equal(f.tick.ms, LOOK_EVERY_MS);
  f.asked.length = 0;
  f.shown = null;
  f.tick.run();
  await settle();
  assert.equal(f.asked.length, 0);
  f.shown = "cloud";
  f.tick.run();
  await settle();
  assert.deepEqual(f.asked.map(([side]) => side), ["computer"]);
});

test("turning it off forgets every list and stops the timer; the choice is kept", async () => {
  const f = setup();
  f.together.state("computer");
  await f.together.refresh("cloud");
  const off = f.together.set("computer", false);
  assert.deepEqual([off.on, off.other, f.saved, f.cleared], [false, null, { v: 1, on: false }, 1]);
  assert.equal(f.together.open("computer", "nova"), false);
  const on = f.together.set("computer", true);
  assert.deepEqual([on.on, on.other.bots, f.saved], [true, [], { v: 1, on: true }]);
});

test("without a My Cloud, or once this computer's bots moved away, there is nothing to join", async () => {
  const f = setup();
  f.cloud = { origin: null, asleep: false };
  assert.deepEqual(f.together.state("computer"), { v: 1, available: false, on: true, here: "computer", other: null });
  f.cloud = { origin: CLOUD, asleep: false };
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
});

test("main wires it to the one rule for this app's own pages, and the preload offers it to those pages only through main", () => {
  const main = readFileSync(join(HERE, "main.mjs"), "utf8");
  assert.match(main, /installPlacesTogether\(\{ ipcMain, asking: cloudPageAsking, /);
  assert.match(main, /desktopNotifications\.arrived\(\); placesTogether\.arrived\(\);/);
  assert.equal(main.match(/places-together:/g).length, 1, "main sends only that the list changed, never the list");
  const preload = readFileSync(join(HERE, "preload.cjs"), "utf8");
  assert.match(preload.match(/const REMOTE_SAFE = new Set\(\[([^\]]*)\]\)/)[1], /"placesTogether"/);
  const bridge = preload.slice(preload.indexOf("  placesTogether: "), preload.indexOf("  twoPlaces: {"));
  assert.deepEqual(bridge.match(/"places-together:[a-z]+"/g), ['"places-together:state"', '"places-together:set"', '"places-together:open"', '"places-together:changed"', '"places-together:changed"']);
});
