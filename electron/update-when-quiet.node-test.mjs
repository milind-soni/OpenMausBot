import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { createOneHome, QUIET_MS } from "./one-home.mjs";
import { createUpdaterCoordinator } from "./updater-coordinator.mjs";
import { AWAY_MS, awayNow, createQuietInstall, installFailed, launchAfter, OUT_OF_SIGHT_MS, QUIET_TRIES, REOPEN_MS, updateSeen } from "./update-when-quiet.mjs";
import { quietSignals } from "./update-when-quiet-main.mjs";

const CLOUD = "https://omb-t-1.fly.dev";

/** A file the record lives in, kept across "relaunches". */
function file(initial = null) {
  let value = initial;
  return { read: () => structuredClone(value), write: (next) => { value = structuredClone(next); }, get value() { return value; } };
}

/**
 * The quiet install over fakes: the downloaded update (what Restart would install, and each install it got), the clock,
 * and every signal, quiet by default: the window open, nobody has touched the computer for 11 minutes, nothing runs.
 */
function world({ version = "0.1.121", target = "0.1.130", record = file(), ...signals } = {}) {
  let clock = 10_000_000;
  const w = {
    clock: () => clock,
    advance(ms) { clock += ms; },
    installs: [],
    target,
    record,
    idleMs: AWAY_MS + 60_000, locked: false, typedAt: 0, shown: true, busy: null, work: async () => null,
    ...signals,
  };
  w.quiet = createQuietInstall({
    updater: { installable: () => (w.target ? { version: w.target } : null), install: () => { w.installs.push(w.target); w.target = null; } },
    signals: { locked: () => w.locked, idleMs: () => w.idleMs, typedAt: () => w.typedAt, shown: () => w.shown, busy: () => w.busy, work: () => w.work() },
    record, version, now: () => clock,
  });
  return w;
}

test("the person counts as away when the screen is locked, after 10 minutes untouched, or with the window out of sight 2 minutes", () => {
  assert.equal(awayNow({ locked: true, idleMs: 0, outOfSightMs: 0 }), "locked");
  assert.equal(awayNow({ locked: false, idleMs: AWAY_MS, outOfSightMs: 0 }), "away");
  assert.equal(awayNow({ locked: false, idleMs: AWAY_MS - 1, outOfSightMs: 0 }), null, "the window open, someone touched the computer 9 minutes ago");
  assert.equal(awayNow({ locked: false, idleMs: QUIET_MS, outOfSightMs: OUT_OF_SIGHT_MS }), "out of sight");
  assert.equal(awayNow({ locked: false, idleMs: QUIET_MS - 1, outOfSightMs: OUT_OF_SIGHT_MS }), null, "the window closed, but someone is typing elsewhere");
  assert.equal(awayNow({ locked: false, idleMs: QUIET_MS, outOfSightMs: OUT_OF_SIGHT_MS - 1 }), null, "the window closed only a minute ago");
});

test("a downloaded update installs by itself at a quiet moment, and the record says where it came from and that the window was open", async () => {
  const w = world();
  assert.equal(await w.quiet.look(), true);
  assert.deepEqual(w.installs, ["0.1.130"]);
  assert.deepEqual(w.record.value, { v: 1, from: "0.1.121", to: "0.1.130", tries: 1, at: w.clock(), window: true });
});

test("with the window closed it waits until the window has been out of sight 2 minutes, and records it closed", async () => {
  const w = world({ shown: false, idleMs: QUIET_MS });
  assert.equal(await w.quiet.look(), false, "the first look only notes when the window went out of sight");
  w.advance(OUT_OF_SIGHT_MS - 1_000);
  assert.equal(await w.quiet.look(), false);
  w.advance(1_000);
  assert.equal(await w.quiet.look(), true);
  assert.equal(w.record.value.window, false);
});

test("never while a bot's turn runs on this computer's server", async () => {
  const w = world({ work: async () => "bot" });
  assert.equal(await w.quiet.look(), false);
  assert.deepEqual(w.installs, []);
  w.work = async () => null;
  assert.equal(await w.quiet.look(), true, "once the turn is over it goes");
});

test("never when the server can't say what it is doing", async () => {
  const w = world({ work: async () => { throw new Error("connect ECONNREFUSED"); } });
  assert.equal(await w.quiet.look(), false);
  assert.deepEqual(w.installs, []);
});

test("never while someone typed in the app in the last 30 seconds, even with the screen locked", async () => {
  const w = world({ locked: true });
  w.typedAt = w.clock() - QUIET_MS + 1_000;
  assert.equal(await w.quiet.look(), false);
  w.advance(1_000);
  assert.equal(await w.quiet.look(), true);
});

test("never while the person is here: the window open and the computer touched in the last 10 minutes", async () => {
  const w = world({ idleMs: AWAY_MS - 1_000 });
  assert.equal(await w.quiet.look(), false);
  assert.deepEqual(w.installs, []);
});

test("quiet is checked again right before installing: someone who typed while the server answered holds it", async () => {
  const w = world();
  w.work = async () => { w.typedAt = w.clock(); return null; };
  assert.equal(await w.quiet.look(), false);
  assert.deepEqual(w.installs, []);
  assert.equal(w.record.value, null, "nothing was tried");
});

test("never while the move is in a frozen phase, or waits for its quiet moment, or switches over", async () => {
  for (const phase of ["wait", "freeze", "final", "check", "switch"]) {
    const journal = { v: 1, phase, cloud: { origin: CLOUD, account: "acct-1", machine: CLOUD } };
    const home = createOneHome({ journal: { read: () => journal, write: () => {} }, cloud: () => null, send: { snapshot: () => ({ running: null }) }, local: {}, session: async () => ({}) });
    assert.equal(home.busy(), true, phase);
    const w = world({ busy: home.busy() ? "move" : null });
    assert.equal(await w.quiet.look(), false, phase);
    assert.deepEqual(w.installs, [], phase);
  }
  const copying = { v: 1, phase: "copy", retryAt: 1, cloud: { origin: CLOUD, account: "acct-1", machine: CLOUD } };
  let running = null;
  const home = createOneHome({ journal: { read: () => copying, write: () => {} }, cloud: () => null, send: { snapshot: () => ({ running }) }, local: {}, session: async () => ({}) });
  assert.equal(home.busy(), false, "a copy waiting to try again is not cut into");
  running = { reason: "move" };
  assert.equal(home.busy(), true, "a pass carrying things to My Cloud is");
});

test("never while a Live call runs here or on the Cloud the window shows, and My Cloud asleep is not asked", async () => {
  const asked = [];
  const reply = (body, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));
  let here = null, there = null, asleep = false;
  const signals = quietSignals({
    powerMonitor: { getSystemIdleTime: () => 700, getSystemIdleState: () => "idle", on: () => {} },
    window: () => null, lastInput: () => 0, busy: () => null,
    local: (route) => { asked.push(route); return route === "/api/move/freeze" ? reply({ frozen: false }) : reply({ call: here }); },
    place: () => CLOUD, asleep: () => asleep,
    cloudFetch: (url, init) => { asked.push(url); assert.equal(init.headers["x-omb-background"], "1"); return reply({ call: there }); },
  });
  assert.equal(await signals.work(), null);
  here = { id: "call-1", botId: "b1" };
  assert.equal(await signals.work(), "call");
  here = null;
  there = { id: "call-2", botId: "b1" };
  assert.equal(await signals.work(), "call");
  const w = world({ work: () => signals.work() });
  assert.equal(await w.quiet.look(), false);
  assert.deepEqual(w.installs, []);
  asked.length = 0;
  asleep = true;
  assert.equal(await signals.work(), null);
  assert.deepEqual(asked, ["/api/move/freeze", "/api/live/call"], "a sleeping Cloud is never woken to ask");
});

test("the server's own answer to the move (a turn, a routine run, a sign-in) holds it by what it is", async () => {
  const reply = (body) => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  for (const [answer, held] of [[{ frozen: false, busy: "Ember", what: "bot" }, "bot"], [{ frozen: false, busy: "Launch room", what: "room" }, "room"], [{ frozen: false, busy: "", what: "sign-in" }, "sign-in"]]) {
    const signals = quietSignals({ powerMonitor: { getSystemIdleTime: () => 0, getSystemIdleState: () => "active", on: () => {} }, window: () => null, lastInput: () => 0, busy: () => null,
      local: () => reply(answer), place: () => null, asleep: () => false, cloudFetch: () => { throw new Error("not asked"); } });
    assert.equal(await signals.work(), held);
  }
  const failing = quietSignals({ powerMonitor: { getSystemIdleTime: () => 0, getSystemIdleState: () => "active", on: () => {} }, window: () => null, lastInput: () => 0, busy: () => null,
    local: () => Promise.resolve(new Response("", { status: 503 })), place: () => null, asleep: () => false, cloudFetch: () => { throw new Error("not asked"); } });
  await assert.rejects(failing.work());
});

test("a failed install is tried again at the next quiet moment, at most three times, and then only Restart or quit installs it", async () => {
  const record = file();
  for (let attempt = 1; attempt <= QUIET_TRIES; attempt += 1) {
    const w = world({ record });
    assert.equal(w.quiet.promises("0.1.130"), true, `before try ${attempt}`);
    assert.equal(await w.quiet.look(), true, `try ${attempt}`);
    assert.equal(record.value.tries, attempt);
    // The app came back on the version it left: that try went wrong.
    assert.deepEqual(launchAfter(record, { version: "0.1.121", now: w.clock }), { hidden: false, updated: null });
  }
  const w = world({ record });
  assert.equal(w.quiet.promises("0.1.130"), false);
  assert.equal(await w.quiet.look(), false);
  assert.deepEqual(w.installs, []);
  const newer = world({ record, target: "0.1.131" });
  assert.equal(await newer.quiet.look(), true, "a newer version gets its own tries");
  assert.equal(record.value.tries, 1);
});

test("an install that never reached a restart (the updater's own error) is not mistaken for the reopening", async () => {
  const w = world({ shown: false, idleMs: QUIET_MS });
  await w.quiet.look();
  w.advance(OUT_OF_SIGHT_MS);
  assert.equal(await w.quiet.look(), true);
  installFailed(w.record);
  assert.deepEqual(w.record.value, { v: 1, from: "0.1.121", to: "0.1.130", tries: 1 });
  assert.deepEqual(launchAfter(w.record, { version: "0.1.121", now: w.clock }), { hidden: false, updated: null }, "the person's own launch opens the window");
});

test("the reopening on the new version keeps a closed window closed, says once that the app updated itself, and forgets it once seen", async () => {
  const record = file();
  const w = world({ record, shown: false, idleMs: QUIET_MS });
  await w.quiet.look();
  w.advance(OUT_OF_SIGHT_MS);
  await w.quiet.look();
  w.advance(20_000);
  assert.deepEqual(launchAfter(record, { version: "0.1.130", now: w.clock }), { hidden: true, updated: "0.1.130" });
  assert.deepEqual(launchAfter(record, { version: "0.1.130", now: w.clock }), { hidden: false, updated: "0.1.130" }, "the next launch is the person's own");
  updateSeen(record);
  assert.deepEqual(launchAfter(record, { version: "0.1.130", now: w.clock }), { hidden: false, updated: null });
});

test("a window that was open opens again, and a launch long after the install is the person's own", () => {
  const open = file({ v: 1, from: "0.1.121", to: "0.1.130", tries: 1, at: 1_000, window: true });
  assert.deepEqual(launchAfter(open, { version: "0.1.130", now: () => 2_000 }), { hidden: false, updated: "0.1.130" });
  const late = file({ v: 1, from: "0.1.121", to: "0.1.130", tries: 1, at: 1_000, window: false });
  assert.deepEqual(launchAfter(late, { version: "0.1.130", now: () => 1_000 + REOPEN_MS + 1 }), { hidden: false, updated: "0.1.130" });
  assert.deepEqual(launchAfter(file({ v: 1, updated: "0.1.129" }), { version: "0.1.130", now: () => 0 }), { hidden: false, updated: null }, "an older line is never said");
  assert.deepEqual(launchAfter(file("garbage"), { version: "0.1.130", now: () => 0 }), { hidden: false, updated: null });
});

/** electron-updater with a downloaded update, through the coordinator the Restart button uses. */
function coordinated(options) {
  const updater = new EventEmitter();
  updater.on("error", () => {});
  updater.quitAndInstall = (...args) => { updater.quits.push(args); };
  updater.quits = [];
  updater.checkForUpdates = async () => { updater.emit("checking-for-update"); updater.emit("update-available", { version: "0.1.130" }); };
  updater.downloadUpdate = async () => {
    updater.emit("update-downloaded", { version: "0.1.130" });
    return ["/tmp/OpenMausBot-0.1.130.zip"];
  };
  const states = [];
  const coordinator = createUpdaterCoordinator(updater, (patch) => states.push(patch), options);
  return { updater, coordinator, states };
}

test("it installs exactly as Restart does: quitAndInstall, silently, reopening the app", async () => {
  const { updater, coordinator } = coordinated();
  assert.equal(coordinator.installable(), null, "nothing downloaded yet");
  await coordinator.check();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(coordinator.installable(), { version: "0.1.130" });
  let clock = 10_000_000;
  const quiet = createQuietInstall({ updater: coordinator, record: file(), version: "0.1.121", now: () => clock,
    signals: { locked: () => true, idleMs: () => 0, typedAt: () => 0, shown: () => true, busy: () => null, work: async () => null } });
  assert.equal(await quiet.look(), true);
  assert.deepEqual(updater.quits, [[true, true]]);
  assert.equal(coordinator.installable(), null, "an install under way is never started twice");
  clock += 60_000;
  assert.equal(await quiet.look(), false);
  assert.equal(updater.quits.length, 1);
});

test("an install that failed keeps the updater's own failure handling: nothing installs by itself until the update is ready again", async () => {
  const { updater, coordinator, states } = coordinated();
  await coordinator.check();
  await new Promise((resolve) => setImmediate(resolve));
  updater.quitAndInstall = () => { throw new Error("The installer could not start."); };
  coordinator.install();
  assert.equal(states.at(-1).status, "error");
  assert.equal(coordinator.installable(), null);
});

test("macOS installs by itself only once Squirrel.Mac has staged the update", async () => {
  const { updater, coordinator } = coordinated({ nativeStaging: true });
  let finish;
  updater.downloadUpdate = () => new Promise((resolve) => {
    updater.emit("update-downloaded", { version: "0.1.130" });
    finish = () => resolve(["/tmp/OpenMausBot-0.1.130-arm64-mac.zip"]);
  });
  await coordinator.check();
  assert.equal(coordinator.installable(), null, "preparing");
  finish();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(coordinator.installable(), { version: "0.1.130" });
});

test("Linux hand-off and password installs never install by themselves", async () => {
  for (const options of [{ handOffInstall: async () => ({ command: "sudo apt-get install -y x.deb" }) }, { elevatedInstall: async () => ({ ok: true }), relaunch: () => {} }]) {
    const { coordinator } = coordinated(options);
    await coordinator.check();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(coordinator.installable(), null);
  }
});
