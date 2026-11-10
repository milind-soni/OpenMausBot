import assert from "node:assert/strict";
import test from "node:test";

import { createMoveLease } from "./move-lease.mjs";
import { CHECK_RESUME_MS, createOneHome, FROZEN_RETRY_MS, QUEUE_POLL_MS, QUIET_MS } from "./one-home.mjs";

const CLOUD = "https://omb-t-1.fly.dev";
const reply = (status, body = {}) => ({ ok: status < 400, status, body });
const timeout = () => new DOMException("The operation was aborted due to timeout", "TimeoutError");

/** My Cloud's lease (server/cloud-send-lease.ts), as the clock `now` sees it. */
function cloudLease(now) {
  let held = null;
  return {
    get held() { return held && held.until > now() ? held : null; },
    answer(body) {
      if (body.release) { if (held?.holder === body.holder) held = null; return reply(200, { v: 1, held: false }); }
      if (held && held.holder !== body.holder && held.until > now()) return reply(409, { v: 1, held: false, label: held.label, until: held.until });
      held = { holder: body.holder, label: body.label || held?.label || "", until: now() + 10 * 60_000 };
      return reply(200, { v: 1, held: true, until: held.until });
    },
  };
}

/**
 * One computer moving into My Cloud, with fakes on every side: its journal, its server (frozen or not), the send (each
 * pass and check, `checks` answering in turn: true, false, an error, or a function of the moment), My Cloud's session,
 * the clock and its timers, and My Cloud's lease when `lease` is given (`name` and `id`: this computer as it asks).
 */
function computer({ clock, checks = [], lease = null, name = "Mac", id = "computer-mac", copy = null }) {
  let journal = null;
  const timers = [];
  const c = {
    passes: [], server: { frozen: false, freezes: 0, unfreezes: 0 }, checking: null, timers,
    get journal() { return journal; },
    set journal(value) { journal = structuredClone(value); },
    async tick() { for (const timer of timers.splice(0)) timer.work(); await c.home.kick(); },
  };
  const session = async () => ({
    async call(method, route, body) {
      if (route === "/api/cloud-send/lease") return lease ? lease.answer(body) : reply(404, { error: "not found" });
      if (route === "/api/cloud-send/manifest") return reply(200, { items: [], conversations: [], automations: [] });
      return reply(200, { v: 1 });
    },
    async close() {},
  });
  const local = {
    async freeze() { if (!c.server.frozen) c.server.freezes++; c.server.frozen = true; return { frozen: true }; },
    async unfreeze() { if (c.server.frozen) c.server.unfreezes++; c.server.frozen = false; },
    frozen: async () => c.server.frozen,
    json: async (route) => (route === "/api/cloud-connections" ? { computer: { label: name } } : route.startsWith("/api/bots") ? { bots: [] } : { items: [], conversations: [], automations: [] }),
    call: async () => reply(200),
  };
  c.home = createOneHome({
    journal: { read: () => structuredClone(journal), write: (value) => { journal = structuredClone(value); } },
    cloud: () => ({ origin: CLOUD, account: "acct-1", machine: CLOUD, ready: true, moves: true, ended: false, paid: false }),
    send: {
      async move(options) { c.passes.push(options?.final ? "final" : "copy"); if (!options?.final && copy) await copy(); },
      async check(options) {
        c.checkOptions = options;
        const next = checks.shift();
        const answer = typeof next === "function" ? await next(c) : next;
        if (answer instanceof Error) throw answer;
        return { ok: answer ?? true };
      },
      switches: () => ({}),
      snapshot: () => ({ running: null, checking: c.checking, whole: { result: { notes: [], failed: [] } } }),
    },
    local,
    session,
    ...(lease ? { lease: createMoveLease({ session, holder: async () => id, label: async () => name, timers: { set: () => null, clear: () => {} } }) } : {}),
    lastInput: () => 0,
    now: () => clock.now,
    timers: { set: (work, ms) => { const timer = { work, ms }; timers.push(timer); return timer; }, clear: (timer) => { const at = timers.indexOf(timer); if (at >= 0) timers.splice(at, 1); } },
  });
  return c;
}

const newClock = () => ({ now: 1_000_000 + QUIET_MS + 1 });

test("a check My Cloud stopped answering after it got somewhere goes on from there in minutes, and the line says My Cloud is slow until then", async () => {
  const clock = newClock();
  const slow = Object.assign(new Error("My Cloud did not answer for 15 min (The operation was aborted due to timeout)."), { cause: timeout(), progressed: true });
  const c = computer({ clock, checks: [slow, true] });
  await c.home.kick();
  assert.equal(c.journal.phase, "copy");
  assert.equal(c.server.frozen, false, "this computer is never left frozen while My Cloud is slow");
  assert.equal(c.journal.retryAt, clock.now + CHECK_RESUME_MS, "minutes, not the hour a check that got nowhere waits");
  assert.equal(c.journal.frozenTries, undefined, "nor does it count toward waiting longer next time");
  assert.deepEqual({ phase: c.journal.failure.phase, code: c.journal.failure.code }, { phase: "check", code: "unanswered" }, "the Admin hears it as it did");
  assert.deepEqual(c.home.view(), { phase: "copy", slow: { until: clock.now + CHECK_RESUME_MS } });

  clock.now += CHECK_RESUME_MS;
  await c.tick();
  assert.equal(c.journal.phase, "done");

  const nowhere = computer({ clock, checks: [Object.assign(new Error("My Cloud did not answer."), { cause: timeout(), progressed: false })] });
  await nowhere.home.kick();
  assert.equal(nowhere.journal.retryAt, clock.now + FROZEN_RETRY_MS, "a check that got nowhere still waits its hour");
});

test("while the check runs, the line says which step it is at, how far, and how many bots it checks", async () => {
  const clock = newClock();
  const views = [];
  const c = computer({ clock, checks: [async (self) => {
    self.checking = { step: "chats", done: 400, total: 1_000, bots: 25 };
    views.push(self.home.view());
    self.checking = { step: "chats", done: 400, total: 1_000, bots: 25, until: clock.now + 60_000 };
    views.push(self.home.view());
    self.checking = null;
    return true;
  }] });
  await c.home.kick();
  assert.deepEqual(views, [
    { phase: "finishing", checking: { step: "chats", done: 400, total: 1_000, bots: 25 } },
    { phase: "finishing", checking: { step: "chats", done: 400, total: 1_000, bots: 25 }, slow: { until: clock.now + 60_000 } },
  ]);
  assert.equal(c.journal.phase, "done");
});

test("two computers moving into one Cloud take turns: the second waits for the first, says for which, and goes on once it is done", async () => {
  const clock = newClock();
  const lease = cloudLease(() => clock.now);
  let letCopyEnd;
  const copying = new Promise((resolve) => { letCopyEnd = resolve; });
  let seenFromNuc = null;
  const nuc = computer({ clock, lease, name: "NUC", id: "computer-nuc" });
  const mac = computer({ clock, lease, name: "Mac", id: "computer-mac", copy: () => copying, checks: [async () => {
    // While the Mac finishes, the NUC asks: it waits, unfrozen, and copies nothing.
    await nuc.tick();
    seenFromNuc = nuc.home.view();
    return true;
  }] });

  const macRun = mac.home.kick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(lease.held?.label, "Mac", "the Mac's copy holds the lease");
  await nuc.home.kick();
  assert.deepEqual(nuc.passes, [], "nothing of the NUC's goes while the Mac's copy runs");
  assert.deepEqual(nuc.home.view(), { phase: "copy", queued: { name: "Mac" } });
  assert.deepEqual(nuc.timers.map((timer) => timer.ms), [QUEUE_POLL_MS], "it asks again in a minute");

  letCopyEnd();
  await macRun;
  assert.equal(mac.journal.phase, "done");
  assert.deepEqual(mac.passes, ["copy", "final"]);
  assert.deepEqual(seenFromNuc, { phase: "copy", queued: { name: "Mac" } }, "the Mac held the lease from its freeze to its switch");
  assert.deepEqual(nuc.passes, []);
  assert.equal(lease.held, null, "the Mac let go once it was done");

  clock.now += QUEUE_POLL_MS;
  await nuc.tick();
  assert.equal(nuc.journal.phase, "done");
  assert.deepEqual(nuc.passes, ["copy", "final"]);
  assert.equal(nuc.server.frozen, true);
  assert.equal(lease.held, null);
});

test("a Cloud too old to keep a lease lets every computer move as before", async () => {
  const clock = newClock();
  const c = computer({ clock });
  await c.home.kick();
  assert.equal(c.journal.phase, "done");
  const old = createMoveLease({ session: async () => ({ call: async () => reply(404, { error: "not found" }) }), holder: async () => "computer-x", label: async () => "X", timers: { set: () => null, clear: () => {} } });
  assert.equal(await old.take(), null);
  assert.equal(old.held(), false);
});

test("a move that waits for another computer after an earlier failure asks again in a minute, not in a tight loop", async () => {
  const clock = newClock();
  const lease = cloudLease(() => clock.now);
  lease.answer({ holder: "computer-mac", label: "Mac" });
  const nuc = computer({ clock, lease, name: "NUC", id: "computer-nuc" });
  nuc.journal = { v: 1, phase: "copy", cloud: { origin: CLOUD, account: "acct-1", machine: CLOUD }, retryAt: clock.now - 1, failure: { phase: "check", code: "unanswered", count: 1, since: 1, at: 1 } };
  await nuc.home.kick();
  assert.deepEqual(nuc.passes, []);
  assert.deepEqual(nuc.timers.map((timer) => timer.ms), [QUEUE_POLL_MS]);
});

test("a check is told when the person stops the move, and a failed one lifts the freeze before it lets go of My Cloud", async () => {
  const clock = newClock();
  const order = [];
  const lease = cloudLease(() => clock.now);
  const answer = lease.answer;
  lease.answer = (body) => { if (body.release) order.push(c.server.frozen ? "released frozen" : "released thawed"); return answer(body); };
  const c = computer({ clock, lease, checks: [Object.assign(new Error("My Cloud did not answer."), { cause: timeout() })] });
  await c.home.kick();
  assert.equal(typeof c.checkOptions.stopped, "function");
  assert.equal(c.checkOptions.stopped(), false);
  assert.ok(order.includes("released thawed") && !order.includes("released frozen"), order.join());
});
