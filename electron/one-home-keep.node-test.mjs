import assert from "node:assert/strict";
import test from "node:test";

import { createOneHome, QUIET_MS } from "./one-home.mjs";

const CLOUD = "https://omb-t-1.fly.dev";
const reply = (status, body = {}) => ({ ok: status < 400, status, body });
const KINDS = { routines: "routine", webhooks: "webhook", "calendar-calls": "call", "app-triggers": "app-event" };
const keyOf = (route) => {
  const match = /^\/api\/(routines|webhooks|calendar-calls|app-triggers)\/([\w-]+)$/u.exec(route);
  return match ? `${KINDS[match[1]]}:${match[2]}` : null;
};

/**
 * My Cloud and two computers that move to it, each with its own app, journal, choice ("Keep this computer's bots on this
 * computer") and server. My Cloud holds each automation by key, on or off, and runs those that are on; a computer runs
 * those on here while it is not frozen. A move carries a computer's automations My Cloud lacks, off there until its switch
 * turns on what was on here. A come-home stages My Cloud's backup, and its restore replaces what the computer has with My
 * Cloud's things, every automation off. `events` is the order things happened in.
 */
function world() {
  let clock = 1_000_000;
  const timers = [];
  const cloud = { on: { "routine:c1": true }, ready: true, moves: true, takesOff: true, exports: 0, kept: [], moved: [] };
  const events = [];
  const make = (id, name, own) => {
    const desk = {
      id, name, journal: null, keep: null, server: { frozen: false, freezes: 0, on: { ...own }, thaws: [] }, carried: {}, passes: 0, restored: 0, restarted: 0,
      opened: [], localCalls: [], crashOn: null,
      live: () => (desk.server.frozen ? [] : Object.keys(desk.server.on).filter((key) => desk.server.on[key]).sort()),
    };
    desk.make = () => {
      // What one run of the app staged, as main keeps it.
      let staged = null;
      const stage = async () => {
        if (!staged) { cloud.exports++; staged = { ...cloud.on }; events.push(`${id}: My Cloud's backup staged`); }
        return { staged: true, switches: { ...staged } };
      };
      return createOneHome({
      journal: {
        read: () => structuredClone(desk.journal),
        write: (value) => {
          if (desk.crashOn?.(value)) { desk.crashOn = null; throw new Error("the app was killed"); }
          desk.journal = structuredClone(value);
        },
      },
      keep: { read: () => structuredClone(desk.keep), write: (value) => { desk.keep = structuredClone(value); } },
      cloud: () => ({ origin: CLOUD, account: "acct-1", machine: CLOUD, ready: cloud.ready, moves: cloud.moves, ended: false, paid: true, signIn: `${id}-sign-in` }),
      send: {
        async move(options) {
          desk.passes++;
          // An automation goes when My Cloud lacks it: its switch is not part of what a pass compares.
          for (const [key, on] of Object.entries(desk.server.on)) if (!(key in cloud.on)) { desk.carried[key] = on; cloud.on[key] = false; }
          w.onPass?.(desk, options);
        },
        check: async () => ({ ok: true }),
        switches: () => ({ ...desk.carried }),
        snapshot: () => ({ running: null }),
      },
      local: {
        async freeze() { if (!desk.server.frozen) desk.server.freezes++; desk.server.frozen = true; return { frozen: true }; },
        async unfreeze(options) {
          desk.server.thaws.push(options ?? null);
          if (options?.automations === "off") for (const key of Object.keys(desk.server.on)) desk.server.on[key] = false;
          desk.server.frozen = false;
          events.push(`${id}: open here, ${options?.automations === "off" ? "automations off" : "as it was"}`);
        },
        frozen: async () => desk.server.frozen,
        async json(route) {
          if (route === "/api/cloud-connections") return { computer: { label: name } };
          if (route === "/api/cloud-send/manifest") return { items: [], conversations: [], automations: Object.entries(desk.server.on).map(([key, on]) => ({ key, on })) };
          return { bots: [] };
        },
        async call(method, route, body) {
          desk.localCalls.push([method, route, body]);
          const key = keyOf(route);
          if (method === "PATCH" && key && key in desk.server.on) desk.server.on[key] = true;
          return reply(200, { v: 1 });
        },
      },
      session: async () => ({
        async call(method, route, body) {
          if (route === "/api/cloud-send/automations-off") {
            if (!cloud.takesOff) return reply(404, { error: "not found" });
            const off = body.keys.filter((key) => cloud.on[key]);
            for (const key of off) cloud.on[key] = false;
            events.push(`${id}: off on My Cloud ${body.keys.join(" ")}`);
            return reply(200, { v: 1, off });
          }
          const key = keyOf(route);
          if (method === "PATCH" && key) {
            if (!(key in cloud.on)) return reply(404);
            cloud.on[key] = true;
          }
          return reply(200, { v: 1 });
        },
        close: async () => {},
      }),
      keepHome: {
        stage,
        async bring() {
          await stage();
          desk.server.on = Object.fromEntries(Object.keys(staged).map((key) => [key, false]));
          staged = null;
          desk.restored++;
          events.push(`${id}: restored`);
          return { restored: `restore-${id}-${desk.restored}`, switches: {} };
        },
      },
      installation: async () => `installation-${id}`,
      reportMove: async () => { cloud.moved.push(id); return true; },
      reportKept: async () => { cloud.kept.push(id); return true; },
      phone: { paired: () => false, stop: async () => {}, start: async () => {} },
      openHome: () => desk.opened.push("cloud"),
      openLocal: () => desk.opened.push("local"),
      lastInput: () => w.typedAt,
      restart: () => { desk.restarted++; },
      version: "0.1.125",
      now: () => clock,
      timers: { set: (work, ms) => { const timer = { work, ms }; timers.push(timer); return timer; }, clear: (timer) => { const at = timers.indexOf(timer); if (at >= 0) timers.splice(at, 1); } },
      });
    };
    desk.relaunch = () => { desk.home?.close(); desk.home = desk.make(); return desk.home; };
    desk.home = desk.make();
    return desk;
  };
  const w = {
    cloud, events, typedAt: 0, onPass: null,
    now: () => clock,
    a: make("a", "MacBook Air", { "routine:a1": true, "webhook:aw": true, "routine:a2": false }),
    b: make("b", "Studio iMac", { "routine:b1": true }),
    advance(ms) { clock += ms; },
    async tick(desk) { const due = timers.splice(0); for (const timer of due) timer.work(); await desk.home.kick(); },
    /** Both computers moved: each is frozen, and My Cloud runs what was on at each. */
    async moved() {
      w.advance(QUIET_MS + 1);
      for (const desk of [w.a, w.b]) { await desk.home.kick(); assert.equal(desk.journal.phase, "done", desk.name); assert.equal(desk.server.frozen, true); }
      assert.deepEqual(w.runningOnCloud(), ["routine:a1", "routine:b1", "routine:c1", "webhook:aw"]);
    },
    runningOnCloud: () => Object.keys(cloud.on).filter((key) => cloud.on[key]).sort(),
    /** Each automation that runs in more than one place. */
    twice: () => {
      const places = [w.runningOnCloud(), w.a.live(), w.b.live()].flat();
      return places.filter((key, at) => places.indexOf(key) !== at);
    },
  };
  return w;
}

test("switched on before the move, this computer never moves: no copy, no freeze, nothing on My Cloud, at every launch", async () => {
  const w = world();
  w.cloud.ready = false;
  await w.a.home.keep(true);
  assert.deepEqual(w.a.keep, { v: 1, on: true, at: 1_000_000 }, "kept on this computer");
  w.cloud.ready = true;
  w.advance(QUIET_MS + 1);
  for (let launch = 0; launch < 3; launch++) { await w.a.relaunch().kick(); w.advance(60 * 60_000); await w.tick(w.a); }
  assert.equal(w.a.journal, null);
  assert.deepEqual([w.a.passes, w.a.server.freezes, w.a.server.frozen], [0, 0, false]);
  assert.deepEqual(w.a.live(), ["routine:a1", "webhook:aw"], "its automations go on running here");
  assert.deepEqual(w.runningOnCloud(), ["routine:c1"]);
  assert.equal(w.a.home.away(), false, "the window keeps this computer, with the switcher");
  assert.equal(w.a.home.view(), null, "and no line about a move");
  assert.equal(w.a.home.keeps(), true);
  assert.deepEqual([w.cloud.moved, w.cloud.kept], [[], []], "the Admin has nothing to be told");

  // The other computer moves as anyone does.
  await w.b.home.kick();
  assert.equal(w.b.journal.phase, "done");
});

test("switched on while the move goes, the move stops before its switch: a frozen copy opens as it was, and nothing runs on My Cloud", async () => {
  const w = world();
  w.advance(QUIET_MS + 1);
  w.typedAt = w.now();
  await w.a.home.kick();
  assert.equal(w.a.journal.phase, "wait", "copied, and waiting for a quiet moment");
  await w.a.home.keep(true);
  assert.equal(w.a.journal, null);
  assert.deepEqual([w.a.server.freezes, w.a.server.frozen], [0, false]);
  w.advance(QUIET_MS + 1);
  await w.tick(w.a);
  assert.deepEqual([w.a.journal, w.a.passes, w.a.server.freezes], [null, 1, 0], "and it never goes on");

  // Switched on while this computer is frozen for the final pass: the freeze lifts once the pass is over, as the
  // Admin's kill switch lifts it.
  const v = world();
  v.advance(QUIET_MS + 1);
  v.onPass = (desk, options) => { if (options?.final) void desk.home.keep(true); };
  await v.a.home.kick();
  assert.equal(v.a.journal, null);
  assert.deepEqual([v.a.server.freezes, v.a.server.thaws], [1, [null]], "lifted as it was, its automations as they were");
  assert.deepEqual(v.a.live(), ["routine:a1", "webhook:aw"]);
  assert.deepEqual(v.runningOnCloud(), ["routine:c1"], "what it carried stays off on My Cloud");
});

test("switched on after this computer moved: its bots come home with My Cloud's backup, their automations run here and stop on My Cloud, and the other computer is untouched", async () => {
  const w = world();
  await w.moved();
  const before = structuredClone({ journal: w.b.journal, server: w.b.server, carried: w.b.carried });
  await w.a.home.keep(true);

  assert.deepEqual(w.events, [
    "a: My Cloud's backup staged",
    "a: off on My Cloud routine:a1 webhook:aw",
    "a: open here, automations off",
    "a: restored",
  ], "the backup is taken before anything changes; this computer opens with nothing on");
  assert.equal(w.a.journal.phase, "back");
  assert.equal(w.a.journal.kept, true);
  assert.equal(w.a.restarted, 1, "the app opens again to finish the restore");
  assert.deepEqual(w.runningOnCloud(), ["routine:b1", "routine:c1"], "this computer's automations stop on My Cloud; the rest go on");
  assert.deepEqual(w.a.live(), [], "and none runs here before the app opens again");

  await w.a.relaunch().kick();
  assert.deepEqual(w.a.live(), ["routine:a1", "webhook:aw"], "what was on of this computer's at My Cloud runs here");
  assert.deepEqual(w.a.server.on, { "routine:a1": true, "webhook:aw": true, "routine:a2": false, "routine:b1": false, "routine:c1": false },
    "the other computer's and My Cloud's own came too, with their automations off");
  assert.deepEqual(w.a.localCalls.find(([, route]) => route === "/api/cloud-send/home"), ["POST", "/api/cloud-send/home", { v: 1, webhooks: ["aw"] }],
    "only this computer's webhook says it has an address here again");
  assert.deepEqual(w.twice(), [], "nothing runs twice");
  assert.equal(w.a.home.away(), false, "the window goes back to this computer, with the switcher");
  assert.deepEqual(w.a.home.view(), { phase: "back", kept: true });
  assert.deepEqual(w.cloud.kept, ["a"], "the Admin is told this computer no longer counts as moved");

  for (let launch = 0; launch < 2; launch++) await w.a.relaunch().kick();
  assert.deepEqual([w.cloud.exports, w.a.restored, w.a.restarted, w.cloud.kept.length], [1, 1, 1, 1], "once");
  w.a.home.seen();
  assert.equal(w.a.home.view(), null);

  assert.deepEqual({ journal: w.b.journal, server: w.b.server, carried: w.b.carried }, before, "the other computer: nothing changed");
  await w.b.relaunch().kick();
  assert.deepEqual([w.b.journal.phase, w.b.server.frozen, w.b.live()], ["done", true, []]);
  assert.deepEqual(w.runningOnCloud(), ["routine:b1", "routine:c1"]);
});

test("switched off again, this computer moves again at the next quiet moment, and My Cloud runs what is on here then", async () => {
  const w = world();
  await w.moved();
  await w.a.home.keep(true);
  await w.a.relaunch().kick();
  // Changed here since coming home: one switched off, one switched on.
  w.a.server.on["webhook:aw"] = false;
  w.a.server.on["routine:a2"] = true;

  w.typedAt = w.now();
  await w.a.home.keep(false);
  assert.equal(w.a.journal.phase, "wait", "it copies at once and waits for a quiet moment");
  assert.equal(w.a.server.frozen, false);
  w.advance(QUIET_MS + 1);
  await w.tick(w.a);
  assert.equal(w.a.journal.phase, "done");
  assert.equal(w.a.journal.kept, undefined);
  assert.deepEqual([w.a.server.frozen, w.a.live()], [true, []]);
  assert.deepEqual(w.runningOnCloud(), ["routine:a1", "routine:a2", "routine:b1", "routine:c1"], "what is on here now, not what was on at the first move");
  assert.deepEqual(w.twice(), []);
  assert.equal(w.a.home.away(), true);
  assert.deepEqual(w.cloud.moved, ["a", "b", "a"], "the Admin is told it moved again");
});

test("while this computer's bots are on their way home the switch can't be turned back; killed half-way, it goes on with what was on at My Cloud before", async () => {
  const w = world();
  await w.moved();
  w.a.crashOn = (value) => value?.thawed === true;
  await w.a.home.keep(true).catch(() => {});
  assert.equal(w.a.journal.phase, "keeping");
  assert.equal(w.a.journal.offThere, true);
  assert.equal(w.a.home.away(), true, "the window stays on My Cloud meanwhile");
  assert.deepEqual(w.a.home.view(), { phase: "keeping" });
  assert.throws(() => w.a.home.keep(false), /on their way back/u);
  assert.deepEqual(w.runningOnCloud(), ["routine:b1", "routine:c1"]);

  await w.a.relaunch().kick();
  assert.equal(w.a.journal.phase, "back");
  assert.equal(w.cloud.exports, 2, "the backup is taken again after the app was killed");
  await w.a.relaunch().kick();
  assert.deepEqual(w.a.live(), ["routine:a1", "webhook:aw"], "what was on at My Cloud before it stopped there, not after");
  assert.deepEqual(w.twice(), []);
});

test("a My Cloud too old to stop this computer's automations: nothing changes anywhere until it has updated", async () => {
  const w = world();
  await w.moved();
  w.cloud.takesOff = false;
  await w.a.home.keep(true);
  assert.equal(w.a.journal.phase, "keeping");
  assert.deepEqual(w.a.home.view(), { phase: "keeping", updating: true });
  assert.deepEqual([w.a.server.frozen, w.a.restored, w.runningOnCloud()], [true, 0, ["routine:a1", "routine:b1", "routine:c1", "webhook:aw"]]);
  w.cloud.takesOff = true;
  w.advance(60 * 60_000);
  await w.tick(w.a);
  assert.equal(w.a.journal.phase, "back");
  await w.a.relaunch().kick();
  assert.deepEqual(w.a.live(), ["routine:a1", "webhook:aw"]);
  assert.deepEqual(w.twice(), []);
});

test("turned back off before anything changed on either side, home is My Cloud as it was", async () => {
  const w = world();
  await w.moved();
  const done = structuredClone(w.a.journal);
  w.cloud.takesOff = false;
  await w.a.home.keep(true);
  assert.deepEqual([w.a.journal.phase, w.cloud.exports], ["keeping", 1], "My Cloud's backup was staged, and nothing else");
  await w.a.home.keep(false);
  const onDisk = (journal) => JSON.parse(JSON.stringify(journal));
  assert.deepEqual(onDisk(w.a.journal), onDisk(done), "the journal is as it was at the move");
  assert.equal(w.a.home.away(), true);
  assert.deepEqual([w.a.server.frozen, w.a.server.thaws, w.a.restored], [true, [], 0]);
  assert.deepEqual(w.runningOnCloud(), ["routine:a1", "routine:b1", "routine:c1", "webhook:aw"]);
  w.cloud.takesOff = true;
  w.advance(60 * 60_000);
  await w.tick(w.a);
  assert.equal(w.a.journal.phase, "done", "and it stays home on My Cloud");
  assert.equal(w.a.restored, 0);
});
