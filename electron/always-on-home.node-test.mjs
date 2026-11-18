import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ALWAYS_ON_BLOCKER, createAlwaysOnHome, installAlwaysOnHome, parseAlwaysOn } from "./always-on-home.mjs";

/** A login item that is simply on or off, recording what the switch asked of it. */
function simpleLogin(world, available = true) {
  return {
    available: () => available, chosen: () => world.login, starts: () => world.login, hold: () => {}, whenChosen: () => {}, follow: () => {},
    choose: (on) => { world.chose.push(on); world.login = on; },
    homeAdd: () => { world.chose.push(true); world.login = true; return null; },
    homeRelease: () => { world.chose.push(false); world.login = false; },
  };
}

function fixture(t, { login = false, battery = false, available = true, updates = "by-itself", platform = "darwin" } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "omb-always-on-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const world = { login, battery, chose: [], held: new Set(), started: [], nextId: 1 };
  const loginItem = simpleLogin(world, available);
  const blocker = {
    start: (type) => { const id = world.nextId++; world.started.push(type); world.held.add(id); return id; },
    stop: (id) => { world.held.delete(id); },
    isStarted: (id) => world.held.has(id),
  };
  const file = path.join(dir, "always-on-home.json");
  const make = () => createAlwaysOnHome({ file, loginItem, blocker, isOnBattery: () => world.battery, updates: () => updates, platform, lookMs: 3_600_000 });
  return { world, file, make, home: make() };
}

test("the saved switch reads only its own shape; anything else is off", () => {
  assert.deepEqual(parseAlwaysOn(null), { v: 1, on: false, addedLogin: false });
  assert.deepEqual(parseAlwaysOn({ v: 2, on: true }), { v: 1, on: false, addedLogin: false });
  assert.deepEqual(parseAlwaysOn({ v: 1, on: "yes", addedLogin: true }), { v: 1, on: false, addedLogin: false });
  assert.deepEqual(parseAlwaysOn({ v: 1, on: true, addedLogin: true }), { v: 1, on: true, addedLogin: true });
});

test("on: opens at login, holds the computer awake on power, and says how updates arrive", (t) => {
  const f = fixture(t);
  assert.deepEqual(f.home.state(), { available: true, on: false, platform: "darwin", openAtLogin: false, awake: "off", updates: "by-itself" });
  const state = f.home.set(true);
  assert.deepEqual(state, { available: true, on: true, platform: "darwin", openAtLogin: true, awake: "holding", updates: "by-itself" });
  assert.deepEqual(f.world.chose, [true]);
  assert.deepEqual(f.world.started, [ALWAYS_ON_BLOCKER]);
  assert.equal(f.home.holding(), true);
  assert.equal(f.home.on(), true);
  assert.deepEqual(JSON.parse(readFileSync(f.file, "utf8")), { v: 1, on: true, addedLogin: true });
  f.home.set(true);
  assert.equal(f.world.started.length, 1, "asking again holds nothing twice");
  f.home.stop();
});

test("on battery the hold lets go, and comes back once the computer is plugged in", (t) => {
  const f = fixture(t);
  f.home.set(true);
  f.world.battery = true;
  f.home.look();
  assert.equal(f.home.holding(), false);
  assert.equal(f.home.state().awake, "battery");
  f.world.battery = false;
  f.home.look();
  assert.equal(f.home.holding(), true);
  f.home.stop();
  assert.equal(f.world.held.size, 0, "stop releases the hold");
});

test("off undoes only what on changed: a login item the person set up stays", (t) => {
  const added = fixture(t);
  added.home.set(true);
  added.home.set(false);
  assert.deepEqual(added.world.chose, [true, false], "the login item the switch added goes");
  assert.equal(added.home.holding(), false);
  assert.equal(added.home.state().awake, "off");

  const theirs = fixture(t, { login: true });
  theirs.home.set(true);
  theirs.home.set(false);
  assert.deepEqual(theirs.world.chose, [], "the person's own login item is never touched");
  assert.equal(theirs.world.login, true);
});

test("the switch survives a restart, and a fresh launch holds the computer awake again", (t) => {
  const f = fixture(t);
  f.home.set(true);
  f.home.stop();
  const again = f.make();
  assert.equal(again.on(), true);
  again.start();
  assert.equal(again.holding(), true);
  again.set(false);
  assert.deepEqual(f.world.chose, [true, false], "what the first launch added is still known after a restart");
  again.stop();
});

test("a damaged file reads as off, and a failing login item still saves the choice", (t) => {
  const f = fixture(t);
  writeFileSync(f.file, "{not json");
  assert.equal(f.make().on(), false);
  const home = createAlwaysOnHome({ file: f.file, loginItem: { ...simpleLogin(f.world), homeAdd: () => { throw new Error("denied"); } },
    blocker: { start: () => 1, stop: () => {}, isStarted: () => true }, isOnBattery: () => false });
  const state = home.set(true);
  assert.equal(state.on, true);
  assert.equal(state.openAtLogin, false, "Settings then says Open at login is off");
  home.stop();
});

test("an updater that names no way reads as none", (t) => {
  const f = fixture(t, { updates: "sideways", available: false, platform: "linux" });
  assert.deepEqual(f.home.state(), { available: false, on: false, platform: "linux", openAtLogin: false, awake: "off", updates: "none" });
});

test("Settings' channels go through main's guard, and set takes only true as on", async (t) => {
  const f = fixture(t);
  const handlers = new Map(), guarded = [];
  let changed = 0;
  const home = installAlwaysOnHome({ ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }, guard: (channel, handler) => { guarded.push(channel); return handler; },
    changed: () => changed++, file: f.file, loginItem: simpleLogin(f.world),
    blocker: { start: () => 1, stop: () => {}, isStarted: () => false }, isOnBattery: () => false });
  assert.deepEqual(guarded, ["always-on-home:state", "always-on-home:set"]);
  assert.equal((await handlers.get("always-on-home:set")({}, "true")).on, false, "a string is not a yes");
  assert.equal((await handlers.get("always-on-home:set")({}, true)).on, true);
  assert.equal((await handlers.get("always-on-home:state")({})).on, true);
  assert.equal(changed, 2);
  home.stop();
});
