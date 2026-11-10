import assert from "node:assert/strict";
import test from "node:test";

import { ACME, CLOUD, connected, world } from "./fixtures/home-window-world.mjs";
import { createPlaceSwitch, PAGE_SETTLE_MS } from "./place-switch.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));
const gate = () => { let open; const shut = new Promise((resolve) => { open = resolve; }); return { shut, open }; };
function rail(over = {}) {
  const told = [], switches = { told };
  switches.of = createPlaceSwitch({ changed: () => told.push(switches.of.target()), ...over });
  return switches;
}

test("a click is listed before anything else happens, and the place stays listed until its work is done", async () => {
  const r = rail(), calls = [];
  const work = gate();
  const opening = r.of.ask("cloud", async () => { calls.push(r.of.target()); await work.shut; return "opened"; });
  assert.deepEqual(r.of.target(), { id: "cloud" }, "at once, from the click");
  assert.deepEqual(r.told, [{ id: "cloud" }], "the rail hears before the switch has done anything");
  await tick();
  assert.deepEqual(calls, [{ id: "cloud" }]);
  assert.deepEqual(r.of.target(), { id: "cloud" });
  work.open();
  assert.equal(await opening, "opened");
  assert.equal(r.of.target(), null, "done");
  assert.deepEqual(r.told, [{ id: "cloud" }, null]);
});

test("a click during a switch is not lost: it runs at once, and the last click is the one left listed when the others finish", async () => {
  const r = rail(), started = [], first = gate(), second = gate(), third = gate();
  const one = r.of.ask("a", () => { started.push("a"); return first.shut; });
  const two = r.of.ask("b", () => { started.push("b"); return second.shut; });
  await tick();
  assert.deepEqual(started, ["a", "b"], "the second does not wait for the first");
  assert.equal(r.of.replacing(), true, "it replaced one still under way");
  first.open();
  await one;
  assert.deepEqual(r.of.target(), { id: "b" }, "the older one finishing leaves the newer one listed");
  const three = r.of.ask("c", () => { started.push("c"); return third.shut; });
  second.open();
  await two;
  assert.deepEqual(r.of.target(), { id: "c" }, "the last click wins, however the earlier ones finish");
  third.open();
  await three;
  assert.equal(r.of.target(), null);
  assert.equal(r.of.replacing(), false);
});

test("the first click replaces nothing; what the next launch would open is read once, before the first of a run of clicks", async () => {
  const seen = { remembered: { team: "t1" } }, r = rail({ kept: () => seen.remembered });
  const done = r.of.ask("a", async () => { assert.equal(r.of.replacing(), false); });
  assert.deepEqual(r.of.before(), { team: "t1" });
  await done;
  assert.equal(r.of.before(), null, "a finished switch keeps nothing");
  const held = gate();
  const one = r.of.ask("b", () => held.shut);
  seen.remembered = { team: "t2" };
  const two = r.of.ask("c", async () => { assert.equal(r.of.replacing(), true); assert.deepEqual(r.of.before(), { team: "t1" }, "still from before the run of clicks"); });
  await two;
  held.open();
  await one;
});

test("the switch stays listed while its page loads, for as long as PAGE_SETTLE_MS at most", async () => {
  const timers = [];
  let loading;
  const r = rail({ pageSettled: () => loading, setTimer: (work, ms) => { const timer = { work, ms }; timers.push(timer); return timer; }, clearTimer: () => {} });
  await r.of.ask("idle", async () => {});
  assert.equal(r.of.target(), null, "no load under way: done with the work");
  const page = gate();
  loading = page.shut;
  const opening = r.of.ask("cloud", async () => {});
  await tick();
  assert.deepEqual(r.of.target(), { id: "cloud" }, "its page is still loading");
  page.open();
  await opening;
  assert.equal(r.of.target(), null);
  loading = new Promise(() => {});
  const stuck = r.of.ask("cloud", async () => {});
  await tick();
  assert.deepEqual(r.of.target(), { id: "cloud" });
  assert.equal(timers.at(-1).ms, PAGE_SETTLE_MS);
  timers.at(-1).work();
  await stuck;
  assert.equal(r.of.target(), null, "a page that never finishes doesn't hold the rail forever");
});

test("waking is said for the place asked for, and only once it changes", () => {
  const r = rail();
  r.of.waking(true);
  assert.equal(r.of.target(), null, "nothing asked for: nothing to say");
  void r.of.ask("home", () => new Promise(() => {}));
  r.told.length = 0;
  r.of.waking(true); r.of.waking(true);
  assert.deepEqual(r.of.target(), { id: "home", waking: true });
  r.of.waking(false);
  assert.deepEqual(r.told, [{ id: "home", waking: true }, { id: "home" }]);
});

test("a click ends what the last one had under way in the window: a Cloud being woken never opens once another place was chosen", async () => {
  const wake = gate();
  const w = world({ state: connected(), power: { state: "asleep", since: 1, sleeps: true }, cloud: { wakeGate: wake.shut }, url: "http://127.0.0.1:8799/" });
  const r = rail({ stop: () => w.home.stopOpening() });
  const opening = r.of.ask("home", () => w.home.show({ place: "cloud" }));
  await tick();
  assert.deepEqual(w.home.view(), { screen: "waking" }, "the switch is under way");
  await r.of.ask("elsewhere", async () => {});
  assert.deepEqual(w.home.view(), { screen: "opening" }, "the waking is over for this window");
  wake.open();
  await opening;
  assert.deepEqual(w.went, [], "the Cloud it asked for never opens");
});

test("going back to the place on screen before the other one opened: it stops there, and that place is still the one shown", async () => {
  const w = world({ state: { ...connected(), teams: [ACME] } });
  await w.home.show({ place: "cloud" });
  w.went.length = 0;
  const r = rail({ stop: () => w.home.stopOpening() });
  const opening = r.of.ask("team", () => w.home.show({ place: { team: ACME.id, name: ACME.name } }));
  await r.of.ask("home", async () => { w.home.stay(); });
  await opening;
  assert.deepEqual(w.went, [], "the team's Cloud never opens");
  assert.equal(w.home.placeOrigin(), CLOUD, "My Cloud is still the place on screen");
});
