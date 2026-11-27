import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { profileDir } from "./clean-workspace.mjs";
import { BUSY_RETRY_MS, BUSY_TRIES, createTogetherBackground, holdsBots, TRY_AT_MS } from "./together-background.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

function setup(t, { bots = [{ id: "ledger", name: "Ledger" }] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "together-background-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const data = join(root, "omb");
  if (bots) { mkdirSync(profileDir(data, "default"), { recursive: true }); writeFileSync(join(profileDir(data, "default"), "bots.json"), JSON.stringify(bots)); }
  const f = { cloudHome: true, on: true, shown: "cloud", running: null, busy: false, opened: [], left: 0, timers: [], clock: 0, order: [] };
  f.background = createTogetherBackground({
    cloudHome: () => f.cloudHome, togetherOn: () => f.on, shown: () => f.shown, ownCopyRuns: () => f.running === null, running: () => f.running, dataDir: () => data,
    open: async (id) => { f.opened.push(id); f.running = id; return true; }, leave: async () => { f.order.push("leave"); f.left += 1; f.running = null; return true; }, busy: async () => f.busy,
    linkOff: async () => { f.order.push("link off:start"); await new Promise((done) => setImmediate(done)); f.order.push("link off:done"); },
    now: () => f.clock, later: (run, ms) => { const timer = { run, ms }; f.timers.push(timer); return timer; }, cancel: () => {},
  });
  /** Time moves to `at` ms after launch and every try due by then runs. */
  f.at = async (at) => { f.clock = at; for (const timer of f.timers.splice(0).sort((a, b) => a.ms - b.ms)) { if (timer.ms <= at) await timer.run(); else f.timers.push(timer); } await new Promise((done) => setImmediate(done)); };
  return f;
}

test("My Cloud home, together on: this computer's own workspace starts in the background once the launch's quiet start is over, and only once", async (t) => {
  const f = setup(t);
  f.background.start();
  f.background.settled();
  assert.deepEqual(f.opened, [], "nothing during the launch's quiet start, even when the window settles");
  assert.deepEqual(f.timers.map((timer) => timer.ms), TRY_AT_MS);
  await f.at(TRY_AT_MS[0]);
  assert.deepEqual(f.opened, ["default"]);
  await f.at(TRY_AT_MS.at(-1));
  assert.deepEqual(f.opened, ["default"], "once a launch");
});

test("a window still loading, or on the screen of My Cloud waking, is tried again at the next try and when it settles, and then no more", async (t) => {
  const f = setup(t);
  f.shown = null;
  f.background.start();
  await f.at(TRY_AT_MS[0]);
  assert.deepEqual(f.opened, []);
  f.shown = "waking";
  await f.at(TRY_AT_MS[1]);
  assert.deepEqual(f.opened, []);
  f.shown = "cloud";
  f.clock = TRY_AT_MS[1] + 5_000;
  f.background.settled();
  await new Promise((done) => setImmediate(done));
  assert.deepEqual(f.opened, ["default"], "the window settled on My Cloud: started then");
  const late = setup(t);
  late.shown = null;
  late.background.start();
  await late.at(TRY_AT_MS.at(-1));
  late.shown = "cloud";
  late.clock = TRY_AT_MS.at(-1) + 60_000;
  late.background.settled();
  await new Promise((done) => setImmediate(done));
  assert.deepEqual(late.opened, [], "past the last try it is left for the next launch");
});

test("it never starts: together off, home this computer, the window on another place, another workspace running, or a workspace with no bot or none at all", async (t) => {
  for (const [why, change] of [["together off", (f) => { f.on = false; }], ["home is this computer", (f) => { f.cloudHome = false; }],
    ["the window shows another place", (f) => { f.shown = "other"; }], ["a workspace runs already", (f) => { f.running = "work"; }]]) {
    const f = setup(t);
    change(f);
    f.clock = TRY_AT_MS[0];
    assert.equal(await f.background.run(), false, why);
    assert.deepEqual(f.opened, [], why);
  }
  for (const [why, bots] of [["no workspace", null], ["no bot", []], ["only bots that moved or are hidden", [{ id: "a", movedTo: "x" }, { id: "b", hidden: true }]]]) {
    const f = setup(t, { bots });
    f.clock = TRY_AT_MS[0];
    assert.equal(await f.background.run(), false, why);
    assert.deepEqual(f.opened, [], why);
  }
});

test("turned off: the workspace it started stops and the frozen copy runs again, once no turn is under way, never while the window shows it, never one the person opened", async (t) => {
  const f = setup(t);
  f.background.start();
  await f.at(TRY_AT_MS[0]);
  f.on = false;
  f.busy = true;
  f.background.changed();
  await new Promise((done) => setImmediate(done));
  assert.equal(f.left, 0, "a turn is under way: it waits");
  assert.equal(f.timers.some((timer) => timer.ms === BUSY_RETRY_MS), true);
  f.busy = false;
  await f.at(BUSY_RETRY_MS);
  assert.deepEqual([f.left, f.running], [1, null], "idle now: back to the frozen copy");

  const looking = setup(t);
  looking.background.start();
  await looking.at(TRY_AT_MS[0]);
  looking.on = false;
  looking.shown = "computer";
  looking.background.changed();
  await new Promise((done) => setImmediate(done));
  assert.equal(looking.left, 0, "the person is on This Mac: it stays");

  const opened = setup(t);
  opened.running = "default";
  opened.on = false;
  opened.background.changed();
  await new Promise((done) => setImmediate(done));
  assert.equal(opened.left, 0, "a workspace the person opened is theirs");
  assert.equal(BUSY_TRIES > 1, true);
});

test("a workspace counts as holding bots only from a readable bots.json", (t) => {
  const root = mkdtempSync(join(tmpdir(), "together-bots-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(holdsBots(join(root, "missing")), false);
  writeFileSync(join(root, "bots.json"), "{not json");
  assert.equal(holdsBots(root), false);
  writeFileSync(join(root, "bots.json"), JSON.stringify([{ id: "scout" }]));
  assert.equal(holdsBots(root), true);
});

test("main starts it after the start place opened, tries it as the window settles, stops it when the switch changes, and opens and leaves without moving the window", () => {
  const main = readFileSync(join(HERE, "main.mjs"), "utf8");
  assert.match(main, /await showStartPlace\(\); void cloudAccountRestored\(\)\.then\(\(\) => teamLinks\.ready\(\)\); togetherBackground\.start\(\);/);
  assert.match(main, /desktopNotifications\.arrived\(\); placesTogether\.arrived\(\); togetherBackground\.settled\(\);/);
  assert.match(main, /try \{ togetherBackground\.changed\(\); \} catch \{\}/);
  assert.match(main, /shown: placeShown, ownCopyRuns: \(\) => cleanWorkspace\.ownCopy\(\), running: \(\) => cleanWorkspace\.profile\(\)/, "it reads which place the window shows and whether the frozen copy runs from main's own state");
  assert.match(main, /linkOff: async \(\) => \{ await botLink\?\.look\(\); await botLink\?\.look\(\); \}/);
  assert.match(main, /open: id => cleanWorkspace\.open\(id, \{ background: true \}\), leave: \(\) => cleanWorkspace\.leave\(\{ background: true \}\)/);
  assert.match(main, /windowFollows = \(\) => !background && \(placeSwitch\.turn\(\) === asked \|\|/, "a background start or stop never moves the window or the remembered place");
  const clean = readFileSync(join(HERE, "clean-workspace.mjs"), "utf8");
  assert.match(clean, /if \(background && !fs\.existsSync\(dir\)\) return false;/);
  assert.match(clean, /const leave = \(\{ background = false \} = \{\}\) => inTurn\(\(\) => \(active\(\) \? swapTo\(dataDir\(\), background \? \{ background: true \} : undefined\) : true\)\);/);
});

test("turned off, the link is ended on the workspace's own server before it stops; turned on again in the same session, it is tried again from then", async (t) => {
  const f = setup(t);
  f.background.start();
  await f.at(TRY_AT_MS[0]);
  f.on = false;
  f.background.changed();
  await new Promise((done) => setTimeout(done, 20));
  assert.deepEqual(f.order, ["link off:start", "link off:done", "leave"], "the link ends (and its Cloud is told) before the frozen copy runs again");
  f.clock = 10 * 60_000;
  f.timers.length = 0;
  f.on = true;
  f.background.changed();
  assert.deepEqual(f.timers.map((timer) => timer.ms), TRY_AT_MS, "the tries start again from the switch turned on");
  const base = f.clock;
  for (const timer of f.timers) timer.ms += base;
  await f.at(base + TRY_AT_MS[0]);
  assert.deepEqual(f.opened, ["default", "default"]);
});
