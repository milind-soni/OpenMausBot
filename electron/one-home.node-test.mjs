import assert from "node:assert/strict";
import test from "node:test";

import { arrivedCounts, CHECK_PASSES, COPY_RETRY_MS, createOneHome, FAILING_LINE_MS, FROZEN_RETRY_MS, KEPT_MS, missingOf, QUIET_MS, switchOn } from "./one-home.mjs";
import { oneHomeCloud } from "./one-home-main.mjs";

const CLOUD = "https://omb-t-1.fly.dev";
const reply = (status, body = {}) => ({ ok: status < 400, status, body });

/**
 * One home with fakes on every side: the journal on disk (kept across "relaunches"), this computer's server (frozen or
 * not, and who is busy), the send (each pass and check, and which fail), My Cloud's owner sessions (every call it got),
 * the clock and its timers. `relaunch()` makes a new one-home over the same journal and server, as the app does after a
 * crash.
 */
function world({ cloud = {}, switches = { "routine:r1": true, "routine:r2": false, "webhook:w1": true, "call:c1": true }, checks = [], moves = [], busy = [] } = {}) {
  let journal = null, clock = 1_000_000, typedAt = 0;
  const timers = [];
  const w = {
    cloud: { origin: CLOUD, account: "acct-1", machine: CLOUD, ready: true, moves: true, ended: false, paid: false, ...cloud },
    server: { frozen: false, freezes: 0, unfreezes: 0, forgot: 0 },
    passes: [], checked: 0, cloudCalls: [], localCalls: [], lent: [], phone: { paired: true, stopped: 0, started: 0 }, opened: [], restarted: 0, brought: [],
    again: null, version: "0.1.121",
    get journal() { return journal; },
    set journal(value) { journal = value; },
    now: () => clock,
    advance(ms) { clock += ms; },
    type() { typedAt = clock; },
    async tick() {
      const due = timers.splice(0);
      for (const timer of due) timer.work();
      await w.home.kick();
    },
    make() {
      return createOneHome({
        journal: { read: () => structuredClone(journal), write: (value) => { journal = structuredClone(value); } },
        cloud: () => (w.cloud ? { ...w.cloud } : null),
        send: {
          async move(options) {
            const kind = options?.final ? "final" : "copy";
            w.passes.push(kind);
            const failure = moves.shift();
            if (failure) throw failure;
          },
          async check() { w.checked++; return { ok: checks.shift() ?? true }; },
          switches: () => switches,
          snapshot: () => ({ running: w.running ?? null, whole: { result: { notes: [{ kind: "held", connection: "OpenRouter" }] } } }),
        },
        local: {
          async freeze() {
            const who = busy.shift();
            if (typeof who === "string") return { busy: who };
            if (who && typeof who === "object") return who;
            if (!w.server.frozen) w.server.freezes++;
            w.server.frozen = true;
            return { frozen: true };
          },
          async unfreeze() { if (w.server.frozen) w.server.unfreezes++; w.server.frozen = false; },
          frozen: async () => w.server.frozen,
          async json(route) {
            if (route === "/api/cloud-connections") return { computer: { label: "MacBook Air" } };
            if (route.startsWith("/api/bots")) return { bots: [{ id: "b1", cwd: "/Users/p/code/shop" }, { id: "b2" }] };
            if (route === "/api/cloud-send/manifest") return { items: [{ key: "bot:b1", kind: "bot" }, { key: "bot:b2", kind: "bot" }, { key: "login:l1", kind: "login" }], conversations: [{ threadId: "t1" }], automations: [{ key: "routine:r1" }] };
            return {};
          },
          async call(method, route, body) { w.localCalls.push([method, route, body]); return reply(200); },
          async forget() { w.server.forgot++; },
        },
        async session() {
          return {
            async call(method, route, body) {
              w.cloudCalls.push([method, route, body]);
              if (route === "/api/cloud-send/manifest") return reply(200, { items: [{ key: "bot:b1", kind: "bot" }, { key: "bot:b2", kind: "bot" }, { key: "login:l1", kind: "login" }], conversations: [{ threadId: "t1" }], automations: [{ key: "routine:r1" }] });
              return w.cloudAnswer?.(method, route) ?? reply(200, { v: 1 });
            },
            async close() {},
          };
        },
        lend: async (projects) => { w.lent.push(projects); },
        phone: { paired: () => w.phone.paired, stop: async () => { w.phone.stopped++; }, start: async () => { w.phone.started++; } },
        openHome: () => w.opened.push("cloud"),
        openLocal: () => w.opened.push("local"),
        lastInput: () => typedAt,
        again: { bring: async () => { const next = w.again?.() ?? { later: 60_000 }; w.brought.push(next); return next; } },
        restart: () => { w.restarted++; },
        version: w.version,
        now: () => clock,
        timers: { set: (work, ms) => { const timer = { work, ms }; timers.push(timer); return timer; }, clear: (timer) => { const at = timers.indexOf(timer); if (at >= 0) timers.splice(at, 1); } },
      });
    },
    relaunch() { w.home?.close(); timers.splice(0); w.home = w.make(); return w.home; },
    switchedOn: () => w.cloudCalls.filter(([method]) => method === "PATCH").map(([, route]) => route),
  };
  w.advance(QUIET_MS + 1);
  w.home = w.make();
  return w;
}

test("a new buyer's move runs every phase and ends with home on My Cloud, this computer lent and its phone link off", async () => {
  const w = world();
  await w.home.kick();
  assert.equal(w.journal.phase, "done");
  assert.deepEqual(w.passes, ["copy", "final"]);
  assert.equal(w.checked, 1);
  assert.equal(w.server.frozen, true, "this computer's copy stays frozen for good");
  assert.deepEqual(w.switchedOn().sort(), ["/api/calendar-calls/c1", "/api/routines/r1", "/api/webhooks/w1"], "only what was on here, and nothing off");
  assert.deepEqual(w.cloudCalls.find(([, route]) => route === "/api/cloud-send/arrived")?.[2], { v: 1, computer: "MacBook Air", webhooks: ["w1"] });
  assert.deepEqual(w.lent, [["/Users/p/code/shop"]], "lent once, with each bot's own project folder");
  assert.equal(w.phone.stopped, 1);
  assert.deepEqual(w.opened, ["cloud"]);
  assert.equal(w.home.away(), true);
  assert.deepEqual(w.home.view(), { phase: "done", at: w.journal.doneAt, counts: { bots: 2, skills: 0, logins: 1, onePassword: false, chats: 1, routines: 1 }, phone: true, held: ["OpenRouter"] });
  assert.equal(w.home.seen(), null, "the done line shows until it is closed");

  await w.relaunch().kick();
  assert.equal(w.lent.length, 1, "a relaunch lends nothing again");
  assert.equal(w.phone.stopped, 1);
  assert.equal(w.server.unfreezes, 0);
});

test("a Cloud too old to take a move says My Cloud is updating, never that the move fails, and the move starts once it has", async () => {
  // Seen in the real app on Oct 22: a new app with a Cloud still on the older image, and the line said "Moving your bots to
  // My Cloud…" for good.
  const outdated = () => Object.assign(new Error("My Cloud is updating. Your bots move there by themselves when it's done."), { code: "outdated" });
  const w = world({ moves: [outdated(), outdated(), new Error("My Cloud did not answer.")] });
  await w.home.kick();
  assert.deepEqual(w.home.view(), { phase: "copy", updating: true });
  assert.equal(w.journal.failingSince, undefined, "My Cloud updating is not the move failing");
  assert.equal(w.journal.retryAt, w.now() + COPY_RETRY_MS[0]);
  w.advance(FAILING_LINE_MS + COPY_RETRY_MS[0]);
  await w.tick();
  assert.deepEqual(w.home.view(), { phase: "copy", updating: true }, "a day of it still says why, with nothing to try again");
  w.running = { reason: "move" };
  assert.deepEqual(w.home.view(), { phase: "copy" }, "a pass on its way is the move again");
  w.running = null;
  // Updated, My Cloud failed once in an ordinary way: the line is the move's own again.
  w.advance(COPY_RETRY_MS[1]);
  await w.tick();
  assert.deepEqual(w.home.view(), { phase: "copy" });
  assert.equal(w.journal.failingSince, w.now());
  w.advance(COPY_RETRY_MS[2]);
  await w.tick();
  assert.equal(w.journal.phase, "done");
  assert.equal(w.journal.updating, undefined);
});

test("the freeze waits for a quiet moment: nobody typing for 30 s, and no bot still working", async () => {
  const w = world({ busy: ["Scout", "Scout"] });
  w.type();
  await w.home.kick();
  assert.equal(w.journal.phase, "wait");
  assert.equal(w.server.freezes, 0, "never while the person types");
  w.advance(QUIET_MS);
  await w.tick();
  assert.equal(w.journal.phase, "wait");
  assert.deepEqual(w.home.view(), { phase: "wait", waitingFor: "Scout" });
  assert.equal(w.server.frozen, false);
  w.advance(5_000);
  await w.tick();
  w.advance(5_000);
  await w.tick();
  assert.equal(w.journal.phase, "done");
  assert.equal(w.server.freezes, 1);
});

test("the wait says what holds the move as the server names it, and claims no one before it has", async () => {
  // Each tick runs the move twice (its timer and the kick), so each answer comes twice.
  const signIn = { busy: "", what: "sign-in" }, room = { busy: "Launch room", what: "room" };
  const w = world({ busy: [signIn, signIn, room, room] });
  w.type();
  await w.home.kick();
  assert.deepEqual(w.home.view(), { phase: "wait" }, "nobody named yet: the person typed a moment ago");
  w.advance(QUIET_MS);
  await w.tick();
  assert.deepEqual(w.home.view(), { phase: "wait", waitingFor: "", waitingWhat: "sign-in" });
  w.advance(5_000);
  await w.tick();
  assert.deepEqual(w.home.view(), { phase: "wait", waitingFor: "Launch room", waitingWhat: "room" });
  w.advance(5_000);
  await w.tick();
  assert.equal(w.journal.phase, "done");
});

test("a check's log line names the rooms and conversations it found missing by id, never by name, and counts the rest", () => {
  const rooms = Array.from({ length: 12 }, (_, i) => ({ id: `room-${i}`, name: `Client ${i} pricing` }));
  const said = missingOf({ gaps: { items: [{ key: "bot:ember", kind: "bot", label: "Ember" }], rooms: rooms.slice(0, 3), conversations: ["t-1"], memory: [] },
    chats: [{ threadId: "t-2", missing: 1, unstamped: 0, path: "equal" }, { threadId: "t-3", missing: 0, unstamped: 0, path: "equal" }], attachments: [], secrets: { differs: [], missing: ["key:openrouter"] } });
  assert.equal(said, "1 items, 3 rooms (room-0, room-1, room-2), 1 conversations (t-1), 1 chat paths (t-2), 1 credentials");
  assert.doesNotMatch(said, /Client|Ember|openrouter/u);
  assert.equal(missingOf({ gaps: { rooms } }), "12 rooms (room-0, room-1, room-2, room-3, room-4, room-5, room-6, room-7, room-8, room-9, 2 more)");
  assert.equal(missingOf({}), "something");
});

test("a check that still fails after three passes lifts the freeze and tries again in an hour; a day of it shows Try again", async () => {
  const w = world({ checks: [false, false, false] });
  await w.home.kick();
  assert.equal(w.checked, CHECK_PASSES);
  assert.deepEqual(w.passes, ["copy", "final", "final", "final"]);
  assert.equal(w.journal.phase, "copy");
  assert.equal(w.server.frozen, false, "a failure never leaves this computer frozen");
  assert.equal(w.server.unfreezes, 1);
  assert.deepEqual(w.switchedOn(), [], "a failure never switches anything on");
  assert.equal(w.journal.retryAt, w.now() + FROZEN_RETRY_MS);
  await w.home.kick();
  assert.equal(w.passes.length, 4, "not before the hour is up");
  w.cloud.ready = false;
  await w.home.kick();
  w.cloud.ready = true;
  await w.home.kick();
  assert.equal(w.passes.length, 4, "not before the hour is up, even when My Cloud comes back: this computer is not frozen again sooner");

  w.advance(FROZEN_RETRY_MS);
  await w.tick();
  assert.equal(w.journal.phase, "done", "the next try goes through");
  assert.equal(w.server.frozen, true);

  const failing = world({ moves: Array.from({ length: 40 }, () => Object.assign(new Error("My Cloud did not answer."), { status: 503 })) });
  await failing.home.kick();
  assert.equal(failing.home.view().failing, undefined);
  for (let hour = 0; hour < 25; hour++) { failing.advance(FROZEN_RETRY_MS); await failing.tick(); }
  assert.ok(failing.now() - failing.journal.failingSince >= FAILING_LINE_MS);
  assert.deepEqual(failing.home.view(), { phase: "copy", failing: { error: "My Cloud did not answer." } });
  failing.journal.retryAt = failing.now() + FROZEN_RETRY_MS;
  await failing.home.retry();
  assert.ok(failing.passes.length > 25, "Try again goes now, not at the next hourly try");
});

test("a frozen pass the Admin refused for too many connections lifts the freeze and goes again in minutes, never an hour", async () => {
  // Seen in the real app on Oct 22: killed in the final pass and relaunched, the move's next owner session got 429 from the
  // Admin's pairing limit (10 a device in 10 minutes; every pass opens one), and the move waited an hour.
  const limited = new Error("Cloud request failed.", { cause: new Error("Cloud request failed.", { cause: Object.assign(new Error("Cloud request failed."), { status: 429 }) }) });
  const w = world({ moves: [undefined, limited] });
  await w.home.kick();
  assert.deepEqual(w.passes, ["copy", "final"]);
  assert.equal(w.journal.phase, "copy");
  assert.equal(w.server.frozen, false, "the freeze is lifted");
  assert.equal(w.journal.hourly, undefined);
  assert.equal(w.journal.retryAt, w.now() + COPY_RETRY_MS[0]);
  w.advance(COPY_RETRY_MS[0]);
  await w.tick();
  assert.equal(w.journal.phase, "done");
});

test("an app killed at any phase goes on from the journal: nothing is switched on twice, and nothing is lifted after the switch", async () => {
  for (const at of ["copy", "wait", "freeze", "final", "check", "switch"]) {
    const w = world();
    // The crash: the journal as it was written at `at`, the server as it was then, and a new app.
    w.journal = { v: 1, phase: at, cloud: { origin: CLOUD, account: "acct-1", machine: CLOUD }, startedAt: 1, ...(at === "switch" ? { switched: { "routine:r1": true } } : {}) };
    w.server.frozen = ["freeze", "final", "check", "switch"].includes(at);
    await w.relaunch().kick();
    assert.equal(w.journal.phase, "done", at);
    assert.equal(w.server.frozen, true, at);
    assert.equal(w.server.unfreezes, 0, `${at}: a resumed move never lifts the freeze when nothing failed`);
    const routes = w.switchedOn();
    assert.equal(new Set(routes).size, routes.length, `${at}: each automation switched on once`);
    if (at === "switch") assert.ok(!routes.includes("/api/routines/r1"), "one switched on before the crash is not switched on again");
    if (at === "copy") assert.deepEqual(w.passes, ["copy", "final"], at);
    if (["wait", "freeze", "final"].includes(at)) assert.deepEqual(w.passes, ["final"], at);
    if (["check", "switch"].includes(at)) assert.deepEqual(w.passes, [], at);
  }
});

test("before the switch, moves switched off or a Cloud that ended lift the freeze; after it, only coming home does", async () => {
  const off = world();
  off.journal = { v: 1, phase: "final", cloud: { origin: CLOUD, account: "acct-1", machine: CLOUD } };
  off.server.frozen = true;
  off.cloud.moves = false;
  await off.relaunch().kick();
  assert.equal(off.server.frozen, false);
  assert.equal(off.journal.phase, "copy");
  assert.equal(off.home.view(), null, "nothing to say while moves are off");
  off.cloud.moves = true;
  await off.home.kick();
  assert.equal(off.journal.phase, "done", "it goes on when moves are back on");

  const ended = world();
  ended.journal = { v: 1, phase: "check", cloud: { origin: CLOUD, account: "acct-1", machine: CLOUD } };
  ended.server.frozen = true;
  ended.cloud.ended = true;
  await ended.relaunch().kick();
  assert.equal(ended.server.frozen, false);
  assert.equal(ended.journal, null);

  const gone = world();
  gone.journal = { v: 1, phase: "final", cloud: { origin: CLOUD, account: "acct-1", machine: CLOUD } };
  gone.server.frozen = true;
  gone.cloud.ready = false;
  await gone.relaunch().kick();
  assert.equal(gone.server.frozen, false, "a frozen computer never waits on a Cloud that isn't there");

  const never = world();
  never.server.frozen = true;
  await never.home.kick();
  assert.equal(never.journal, null, "a frozen server no move knows of is never moved or lifted");
  assert.equal(never.server.frozen, true);
});

test("when My Cloud ends after the move, this computer is home again at once, then brings My Cloud's changes back and switches on what was on there", async () => {
  const w = world();
  await w.home.kick();
  assert.equal(w.journal.phase, "done");
  w.cloud.ended = true;
  await w.home.kick();
  assert.equal(w.server.frozen, false, "home again at once");
  assert.equal(w.journal.phase, "home-again");
  assert.deepEqual(w.home.view(), { phase: "home-again" });
  assert.equal(w.phone.started, 1, "its phone link comes back");
  assert.deepEqual(w.opened, ["cloud", "local"]);
  assert.equal(w.home.away(), false);

  w.again = () => ({ restored: "restore-1", switches: { "routine:r1": true, "routine:r9": true, "webhook:w1": false } });
  w.advance(60_000);
  await w.tick();
  assert.equal(w.journal.phase, "back");
  assert.equal(w.restarted, 1, "the app opens again to finish the restore");
  await w.relaunch().kick();
  assert.deepEqual(w.localCalls.map(([method, route, body]) => [method, route, body]).sort(), [["PATCH", "/api/routines/r1", { enabled: true }], ["PATCH", "/api/routines/r9", { enabled: true }],
    ["POST", "/api/cloud-send/home", { v: 1 }]], "and the bots whose webhooks moved say their address is here again");
  assert.equal(w.journal.switchBack, undefined);
  assert.deepEqual(w.home.view(), { phase: "back" });
  w.home.seen();
  assert.equal(w.home.view(), null);

  const deleted = world();
  await deleted.home.kick();
  deleted.cloud.ended = true;
  deleted.again = () => ({ deleted: true });
  await deleted.home.kick();
  assert.deepEqual(deleted.home.view(), { phase: "back", lost: true });
});

test("another account's Cloud never moves this computer's copy, nor lifts its freeze once the move is done", async () => {
  const w = world();
  await w.home.kick();
  w.cloud.account = "acct-2";
  w.cloud.ended = true;
  await w.home.kick();
  assert.equal(w.journal.phase, "done");
  assert.equal(w.server.frozen, true);

  const fresh = world();
  fresh.journal = { v: 1, phase: "copy", cloud: { origin: CLOUD, account: "acct-1", machine: CLOUD } };
  fresh.cloud.account = "acct-2";
  await fresh.relaunch().kick();
  assert.deepEqual(fresh.passes, []);
});

test("a newer app tops up once from the frozen copy, which is deleted 30 days after the move once My Cloud was paid for", async () => {
  const w = world();
  await w.home.kick();
  w.version = "0.1.122";
  await w.relaunch().kick();
  assert.deepEqual(w.passes, ["copy", "final", "final"]);
  await w.relaunch().kick();
  assert.equal(w.passes.length, 3, "once per version");

  w.cloud.paid = true;
  await w.home.kick();
  assert.equal(w.server.forgot, 0, "kept for 30 days after the move, paid or not");
  w.cloud.paid = false;
  w.advance(KEPT_MS);
  await w.home.kick();
  assert.equal(w.server.forgot, 0, "kept until My Cloud has been paid for");
  w.cloud.paid = true;
  await w.home.kick();
  assert.equal(w.server.forgot, 1);
  await w.home.kick();
  assert.equal(w.server.forgot, 1);
});

test("one home reads the Admin's word: a ready Cloud the account may move to, and a held one that ended", () => {
  const state = (machine, extra = {}) => ({ status: "connected", account: { id: "acct-1" }, entitlement: { status: "active" }, machine, ...extra });
  assert.equal(oneHomeCloud({ status: "signed-out" }), null);
  assert.deepEqual(oneHomeCloud(state({ status: "ready", origin: CLOUD, moves: true })), { origin: CLOUD, account: "acct-1", machine: CLOUD, ready: true, moves: true, ended: false, paid: true });
  assert.equal(oneHomeCloud(state({ status: "ready", origin: CLOUD })).moves, false, "no move unless the Admin lets this account move");
  assert.equal(oneHomeCloud(state({ status: "stopped", hold: { until: 5 } })).ended, true);
  assert.equal(oneHomeCloud(state({ status: "stopped" })).ended, false, "stopped alone is not ended");
  assert.equal(oneHomeCloud(state({ status: "ready", origin: CLOUD }, { trial: { state: "active" } })).paid, false);
  assert.equal(oneHomeCloud({ ...state({ status: "ready", origin: CLOUD, moves: true }), status: "unavailable" }).ready, false);
  const team = [{ id: "team-acme", name: "Acme", role: "owner", machine: { status: "ready", origin: "https://omb-t-2.fly.dev", moves: true } }];
  assert.deepEqual(oneHomeCloud(state(undefined, { entitlement: { plan: "pro", tier: "team", status: "active" }, teams: team })),
    { origin: null, account: "acct-1", machine: null, ready: false, moves: false, ended: false, paid: false }, "a Team plan has no My Cloud: nothing moves, and nothing here counts as paid for");
});

test("automations switch on through their own routes, and the done line counts only what both sides hold", () => {
  assert.deepEqual(switchOn("routine:r1"), { method: "PATCH", route: "/api/routines/r1", body: { enabled: true } });
  assert.deepEqual(switchOn("call:c1"), { method: "PATCH", route: "/api/calendar-calls/c1", body: {} });
  assert.deepEqual(switchOn("app-event:a1"), { method: "PATCH", route: "/api/app-triggers/a1", body: { enabled: true } });
  assert.equal(switchOn("bot:b1"), null);
  assert.deepEqual(arrivedCounts({ items: [{ key: "bot:a", kind: "bot" }, { key: "bot:b", kind: "bot" }, { key: "1password", kind: "1password" }], conversations: [{ threadId: "t1" }, { threadId: "t2" }] },
    { items: [{ key: "bot:a", kind: "bot" }, { key: "1password", kind: "1password" }], conversations: [{ threadId: "t1" }] }),
  { bots: 1, skills: 0, logins: 0, onePassword: true, chats: 1, routines: 0 });
});

test("a move left off while My Cloud was away goes on as soon as it is back; a switch that fails waits before it tries again", async () => {
  const w = world({ moves: [Object.assign(new Error("My Cloud did not answer."), { status: 503 })] });
  await w.home.kick();
  assert.equal(w.journal.phase, "copy");
  assert.ok(w.journal.retryAt > w.now());
  await w.home.kick();
  assert.deepEqual(w.passes, ["copy"], "not again at once, however often the app looks");
  w.cloud.ready = false;
  await w.home.kick();
  w.cloud.ready = true;
  await w.home.kick();
  assert.equal(w.journal.phase, "done", "it goes on as soon as My Cloud is back");

  const s = world();
  let refusing = true;
  s.cloudAnswer = (method) => (refusing && method === "PATCH" ? reply(503, { error: "Bad gateway" }) : null);
  await s.home.kick();
  assert.equal(s.journal.phase, "switch");
  const tried = s.switchedOn().length;
  await s.home.kick();
  await s.home.kick();
  assert.equal(s.switchedOn().length, tried, "each look of the app is not another try");
  refusing = false;
  s.advance(2 * 60_000 + 1);
  await s.tick();
  assert.equal(s.journal.phase, "done");
  assert.equal(s.server.unfreezes, 0, "never lifted after the switch");
});
