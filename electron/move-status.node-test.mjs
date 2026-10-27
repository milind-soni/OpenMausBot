import assert from "node:assert/strict";
import test from "node:test";

import { CloudSendError } from "./cloud-send.mjs";
import { failureCode, safeSentence, SENTENCE_MAX } from "./move-failure.mjs";
import { createMoveStatusReport, MOVE_STATUS_GAP_MS, MOVE_STATUS_HEARTBEAT_MS, MOVE_STATUS_OFF_MS, MOVE_STATUS_SETTLE_MS, moveStatus } from "./move-status.mjs";
import { CHECK_PASSES, createOneHome, parseJournal, QUIET_MS } from "./one-home.mjs";
import { installOneHome, oneHomeCloud } from "./one-home-main.mjs";

const CLOUD = "https://omb-t-1.fly.dev";
const ACCOUNT = { id: "acct-1", email: "person@example.test" };
const reply = (status, body = {}) => ({ ok: status < 400, status, body });
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
/** The MausBot Cloud sign-in's state (cloud-account.mjs) for an account with a ready Cloud of its own it may move to. */
const signedIn = (patch = {}) => ({ status: "connected", account: ACCOUNT, deviceId: "device-1", entitlement: { plan: "pro", tier: "personal", status: "active", expiresAt: 1, version: 1 },
  machine: { status: "ready", origin: CLOUD, moves: true }, ...patch });
const journalOf = (patch = {}) => ({ v: 1, phase: "copy", cloud: { origin: CLOUD, account: ACCOUNT.id, machine: CLOUD }, startedAt: 1_700_000_000_000, ...patch });

/**
 * The real one home (one-home.mjs) over fakes, with the Admin's word as the sign-in's state (`w.state`, read the way the
 * app reads it), so every report below comes from what the move itself did. `moves` and `checks` are each pass's and each
 * check's outcome in turn; `busy`, each freeze's answer.
 */
function world({ state = signedIn(), moves = [], checks = [], busy = [] } = {}) {
  let journal = null, clock = 1_800_000_000_000, typedAt = 0, kept = null;
  const timers = [];
  const w = {
    state, server: { frozen: false }, cloudAnswer: null, freezeError: null,
    get journal() { return journal; },
    set journal(value) { journal = value; },
    now: () => clock,
    advance(ms) { clock += ms; },
    type() { typedAt = clock; },
    keepHere() { kept = { v: 1, on: true, at: clock }; },
    report: () => moveStatus({ journal: parseJournal(journal), state: w.state, kept: w.home.keeps(), facts: w.home.facts(), now: clock, version: "0.1.129" }),
  };
  w.home = createOneHome({
    journal: { read: () => structuredClone(journal), write: (value) => { journal = structuredClone(value); } },
    cloud: () => oneHomeCloud(w.state),
    send: {
      async move() { const failure = moves.shift(); if (failure) throw failure; },
      async check() { return { ok: checks.shift() ?? true }; },
      switches: () => ({ "routine:r1": true }),
      snapshot: () => ({}),
    },
    local: {
      async freeze() {
        const who = busy.shift();
        if (who) return who;
        if (w.freezeError) throw w.freezeError;
        w.server.frozen = true;
        return { frozen: true };
      },
      async unfreeze() { w.server.frozen = false; },
      frozen: async () => w.server.frozen,
      async json(route) { return route === "/api/cloud-connections" ? { computer: { label: "Mac" } } : route.startsWith("/api/bots") ? { bots: [] } : {}; },
      async call() { return reply(200); },
    },
    async session() { return { call: async (method, route) => w.cloudAnswer?.(method, route) ?? reply(200, { v: 1 }), close: async () => {} }; },
    keep: { read: () => kept, write: (value) => { kept = value; } },
    lastInput: () => typedAt,
    now: () => clock,
    timers: { set: (work, ms) => { const timer = { work, ms }; timers.push(timer); return timer; }, clear: (timer) => { const at = timers.indexOf(timer); if (at >= 0) timers.splice(at, 1); } },
  });
  w.advance(QUIET_MS + 1);
  return w;
}

/** installOneHome as main wires it, with a fake sign-in that records every report and this computer's server's freeze. */
function installed({ state = null, journal = null, frozen = false, keep = null, reportMoveStatus, reportTimers } = {}) {
  let kept = journal, choice = keep;
  const sent = [];
  const account = { state: () => structuredClone(f.state), reportMoveStatus: reportMoveStatus ?? (async (body) => { sent.push(body); return true; }) };
  const f = { state, sent, frozen };
  f.main = installOneHome({
    ipcMain: { handle: () => {} }, cloudPage: () => "local", server: () => null, home: () => null, cookieFetch: async () => json({}, 401),
    reconnect: async () => false, power: { asleep: () => false }, file: () => "/nonexistent/cloud-send.json", window: () => null, localOrigin: () => "http://127.0.0.1:4100",
    fetch: async () => json({}, 404), account: () => (f.state === undefined ? null : account), journalFile: () => "/nonexistent/one-home.json", tempRoot: () => "/nonexistent",
    localRequest: async (route) => {
      if (route !== "/api/move/freeze") return json({}, 404);
      if (f.frozen === "down") throw new TypeError("fetch failed");
      return json({ frozen: f.frozen === true });
    },
    journal: { read: () => kept, write: (value) => { kept = value; } },
    keep: { read: () => choice, write: (value) => { choice = value; } },
    version: "0.1.129",
    ...(reportTimers ? { reportTimers } : {}),
  });
  f.journal = () => kept;
  return f;
}

test("why no move starts, each by its own code, through the move's own gates: none of them starts a move", async () => {
  const machine = { status: "ready", origin: CLOUD, moves: true };
  const cases = [
    ["signed_out", { state: undefined }],
    ["not_verified", { state: { status: "unavailable", message: "unreachable", account: ACCOUNT, deviceId: "device-1" } }],
    ["not_verified", { state: { status: "reauth-required", message: "access-ended", account: ACCOUNT, deviceId: "device-1" } }],
    ["no_cloud", { state: signedIn({ machine: undefined, entitlement: { plan: "free", status: "inactive", expiresAt: null, version: 0 } }) }],
    ["team_only", { state: signedIn({ machine: undefined, entitlement: { plan: "pro", tier: "team", status: "active", expiresAt: 1, version: 1 }, teams: [{ id: "t1", name: "Acme", role: "owner", machine }] }) }],
    ["team_only", { state: signedIn({ machine: undefined, entitlement: { plan: "free", status: "inactive", expiresAt: null, version: 0 }, teams: [{ id: "t1", name: "Acme", role: "member", machine }] }) }],
    ["cloud_not_ready", { state: signedIn({ machine: { status: "provisioning", origin: CLOUD, moves: true } }), cloudState: "provisioning" }],
    ["cloud_ended", { state: signedIn({ machine: { status: "stopped", origin: CLOUD, moves: true, hold: { until: 2_000_000_000_000 } } }), cloudState: "stopped" }],
    ["moves_off", { state: signedIn({ machine: { status: "ready", origin: CLOUD } }) }],
    ["keep_here", { state: signedIn(), keep: { v: 1, on: true, at: 1 }, keepHere: true }],
    ["frozen_without_move", { state: signedIn(), frozen: true }],
    ["local_unavailable", { state: signedIn(), frozen: "down" }],
    ["other_account", { state: signedIn({ account: { id: "acct-2", email: "other@example.test" } }), journal: journalOf({ phase: "wait" }), phase: "wait" }],
    ["already_moved", { state: signedIn(), journal: journalOf({ phase: "done", doneAt: Date.now() - 1_000, lent: true, phoneStopped: true, reported: "device-1", version: "0.1.129" }), phase: "done" }],
  ];
  for (const [reason, { state, journal = null, frozen = false, keep = null, phase = "none", cloudState, keepHere = false }] of cases) {
    const f = installed({ state, journal, frozen, keep });
    try {
      await f.main.kick();
      assert.equal(f.journal()?.phase ?? null, journal?.phase ?? null, `${reason}: no move started`);
      const report = f.main.moveStatus.read();
      assert.equal(report.reason, reason, `${reason}: ${JSON.stringify(report)}`);
      assert.equal(report.phase, phase, reason);
      assert.equal(report.keepHere, keepHere, reason);
      if (cloudState) assert.equal(report.cloudState, cloudState, reason);
      await f.main.moveStatus.flush();
      if (reason === "signed_out" || state?.status === "reauth-required") assert.deepEqual(f.sent, [], "with no sign-in, or one that ended, nothing is sent");
      else assert.deepEqual(f.sent, [report], `${reason}: sent as read, once`);
    } finally { f.main.close(); }
  }
});

test("each failed pass is reported by where and why it failed, its sentence safe to send, counted until the move is done", async () => {
  const fetchFailed = new TypeError("fetch failed");
  const w = world({ moves: [fetchFailed, new CloudSendError("session", "This app could not sign in to My Cloud. Try again.")] });
  await w.home.kick();
  const first = w.report();
  assert.equal(first.phase, "copy");
  assert.equal(first.reason, "retry_wait");
  assert.equal(first.retryAt, w.journal.retryAt);
  assert.deepEqual(first.failure, { phase: "copy", code: "unanswered", message: "fetch failed", count: 1, since: w.now(), at: w.now() });
  const since = w.now();
  w.advance(2 * 60_000 + 1);
  await w.home.kick();
  assert.deepEqual(w.report().failure, { phase: "copy", code: "session", message: "This app could not sign in to My Cloud. Try again.", count: 2, since, at: w.now() });
  w.advance(5 * 60_000 + 1);
  await w.home.kick();
  const done = w.report();
  assert.equal(done.phase, "done");
  assert.equal(done.reason, "already_moved");
  assert.equal(done.failure, null, "a move that is done has no failure left");
  assert.equal(done.since, w.journal.doneAt);
});

test("every phase's failure has its own code", async () => {
  const limited = new CloudSendError("session", "Too many connection links.", { cause: Object.assign(new Error("Cloud request failed."), { status: 429 }) });
  const cases = [
    { name: "an owner session refused for too many requests", moves: [limited], expect: { phase: "copy", code: "rate_limited" } },
    { name: "this computer's server not answering the pass", moves: [new CloudSendError("local", "OpenMausBot on this computer did not answer. Try again in a moment.")], expect: { phase: "copy", code: "local" } },
    { name: "My Cloud answering nothing usable", moves: [new CloudSendError("unreachable", "My Cloud said: Bot \"Sales team\" can't be read")], expect: { phase: "copy", code: "unreachable", message: "My Cloud said: …" } },
    { name: "My Cloud refusing the final pass", moves: [undefined, new CloudSendError("refused", "My Cloud could not add the chats.")], expect: { phase: "final", code: "refused" } },
    { name: "something unforeseen", moves: [new Error("Cannot read properties of undefined (reading 'items')")], expect: { phase: "copy", code: "error" } },
    { name: "the check still missing things after three passes", checks: [false, false, false], expect: { phase: "check", code: "incomplete", message: "Some of this computer's things did not reach My Cloud." } },
    { name: "this computer's server refusing to pause", freezeError: Object.assign(new Error("OpenMausBot on this computer could not pause."), { status: 500 }), expect: { phase: "freeze", code: "freeze" } },
    { name: "My Cloud refusing to switch an automation on", cloudAnswer: (method) => (method === "PATCH" ? reply(500, { error: "Routines are busy." }) : null), expect: { phase: "switch", code: "switch_refused", message: "Routines are busy." } },
  ];
  for (const { name, moves = [], checks = [], freezeError = null, cloudAnswer = null, expect } of cases) {
    const w = world({ moves: [...moves], checks: [...checks] });
    w.freezeError = freezeError;
    w.cloudAnswer = cloudAnswer;
    await w.home.kick();
    const report = w.report();
    assert.equal(report.reason, "retry_wait", name);
    assert.equal(report.phase, expect.phase === "switch" ? "switch" : "copy", `${name}: a failure before the switch goes back to the copy`);
    assert.deepEqual({ phase: report.failure?.phase, code: report.failure?.code }, { phase: expect.phase, code: expect.code }, name);
    if (expect.message) assert.equal(report.failure.message, expect.message, name);
    assert.equal(report.failure.count, 1, name);
    if (expect.phase === "check") assert.equal(report.passes, 0, "the passes start again with the copy");
  }
});

test("a frozen move whose Cloud stops being ready, or whose account changes, says so", async () => {
  const w = world();
  // Stopped just as the final pass would go: frozen, then the Cloud is no longer ready.
  w.journal = journalOf({ phase: "final", frozenAt: w.now() });
  w.server.frozen = true;
  w.state = signedIn({ machine: { status: "stopped", origin: CLOUD, moves: true } });
  await w.home.kick();
  assert.equal(w.server.frozen, false, "lifted");
  assert.deepEqual([w.report().reason, w.report().failure.phase, w.report().failure.code, w.report().cloudState], ["cloud_not_ready", "final", "not_ready", "stopped"]);

  const other = world();
  other.journal = journalOf({ phase: "check", passes: 1 });
  other.server.frozen = true;
  other.state = signedIn({ account: { id: "acct-2", email: "other@example.test" } });
  await other.home.kick();
  assert.deepEqual([other.report().reason, other.report().failure.code, other.report().failure.phase], ["other_account", "other_account", "check"]);
});

test("a move under way says what it waits for: a quiet moment, work here by its kind (never its name), My Cloud's update, the Admin's switch", async () => {
  const quiet = world();
  await quiet.home.kick();
  assert.deepEqual([quiet.report().phase, quiet.report().reason], ["done", "already_moved"]);

  const typing = world();
  typing.type();
  await typing.home.kick();
  assert.deepEqual([typing.report().phase, typing.report().reason, typing.report().busy], ["wait", "waiting_quiet", null]);
  assert.equal(typing.report().since, typing.journal.phaseAt);

  const busy = world({ busy: [{ busy: "Sales team", what: "bot" }] });
  await busy.home.kick();
  const held = busy.report();
  assert.deepEqual([held.phase, held.reason, held.busy], ["wait", "waiting_busy", "bot"]);
  assert.ok(!JSON.stringify(held).includes("Sales"), "never the bot's name");
  const signIn = world({ busy: [{ busy: "", what: "sign-in" }] });
  await signIn.home.kick();
  assert.equal(signIn.report().busy, "sign-in");
  const unnamed = world({ busy: [{ busy: "Lab" }] });
  await unnamed.home.kick();
  assert.equal(unnamed.report().busy, "other", "an older server that doesn't say what it is");

  const outdated = world({ moves: [new CloudSendError("outdated", "My Cloud is updating. Your bots move there by themselves when it's done.")] });
  await outdated.home.kick();
  assert.deepEqual([outdated.report().reason, outdated.report().failure], ["cloud_outdated", null], "My Cloud updating is not the move failing");

  const paused = world();
  paused.journal = journalOf({ phase: "wait" });
  paused.state = signedIn({ machine: { status: "ready", origin: CLOUD } });
  await paused.home.kick();
  assert.equal(paused.journal.paused, true);
  assert.equal(paused.report().reason, "moves_off");

  const keeping = world();
  keeping.journal = journalOf({ phase: "copy" });
  keeping.keepHere();
  await keeping.home.kick();
  assert.equal(keeping.journal, null, "a move under way stops before its switch");
  assert.deepEqual([keeping.report().phase, keeping.report().reason, keeping.report().keepHere], ["none", "keep_here", true]);
});

test("a stage is dated once, however often the wait looks again, so a move that stands still says since when", async () => {
  const w = world({ busy: [{ busy: "Scout", what: "bot" }, { busy: "Scout", what: "bot" }, { busy: "Scout", what: "bot" }] });
  await w.home.kick();
  const since = w.report().since;
  assert.equal(since, w.now());
  for (let poll = 0; poll < 2; poll++) {
    w.advance(5_000);
    await w.home.kick();
    assert.deepEqual([w.report().phase, w.report().reason, w.report().since], ["wait", "waiting_busy", since], `poll ${poll}`);
  }
  w.advance(5_000);
  await w.home.kick();
  assert.equal(w.report().phase, "done");
  assert.equal(w.report().since, w.now());
});

test("what leaves this computer is ids and fixed words: quotes, what My Cloud said, addresses, paths and tokens are taken out", () => {
  assert.equal(safeSentence("My Cloud said: The skill Pricing notes for Acme is too large"), "My Cloud said: …");
  assert.equal(safeSentence('Could not add "Quarterly plan" to room r_12ab'), "Could not add … to room r_12ab");
  assert.equal(safeSentence("Could not read 'Ideas.md' here"), "Could not read … here");
  assert.equal(safeSentence("This computer's bots can't go yet."), "This computer's bots can't go yet.");
  assert.equal(safeSentence("ENOENT: no such file or directory, open /Users/jane/Documents/plans.md"), "ENOENT: no such file or directory, open …");
  assert.equal(safeSentence("EPERM C:\\Users\\jane\\AppData\\x.db"), "EPERM …");
  assert.equal(safeSentence("Sent to jane@example.com via https://omb-t-1.fly.dev/api/x?token=1"), "Sent to … via …");
  assert.equal(safeSentence(`Bearer omc_${"A".repeat(43)} was refused`), "Bearer … was refused");
  assert.equal(safeSentence("conversation 3f0c2a9e-1b2c-4d5e-8f90-123456789abc is missing"), "conversation 3f0c2a9e-1b2c-4d5e-8f90-123456789abc is missing", "ids stay");
  assert.equal(safeSentence("line one\nline two\u0007"), "line one line two");
  assert.equal(safeSentence("My Cloud could not add this. ".repeat(20)).length, SENTENCE_MAX);
  assert.equal(safeSentence("x".repeat(500)), "…", "one long run is a token");
  assert.equal(safeSentence("   "), null);
  assert.equal(safeSentence(null), null);
  assert.equal(failureCode(Object.assign(new Error("Gateway"), { status: 502 }), "copy"), "unanswered");
  assert.equal(failureCode(Object.assign(new Error("x"), { name: "TimeoutError" }), "final"), "unanswered");
  assert.equal(failureCode(new CloudSendError("no_cloud", "This computer has no My Cloud yet."), "copy"), "no_cloud");
});

test("a report goes a moment after it changes, at most once a minute, and every 15 minutes while it doesn't", async () => {
  let clock = 1_800_000_000_000, body = { v: 1, phase: "copy", reason: null }, who = "device-1";
  const timers = [], sent = [];
  let answer = async () => true;
  const r = createMoveStatusReport({ status: () => body, signIn: () => who, send: async (report) => { sent.push(structuredClone(report)); return answer(); }, now: () => clock,
    timers: { set: (work, ms) => { const timer = { work, at: clock + ms }; timers.push(timer); return timer; }, clear: (timer) => { const at = timers.indexOf(timer); if (at >= 0) timers.splice(at, 1); } } });
  /** Moves the clock on, running each timer due on the way. */
  const pass = async (ms) => {
    const until = clock + ms;
    for (let next = timers.sort((a, b) => a.at - b.at)[0]; next && next.at <= until; next = timers.sort((a, b) => a.at - b.at)[0]) {
      timers.splice(timers.indexOf(next), 1);
      clock = next.at;
      next.work();
      await new Promise((resolve) => setImmediate(resolve));
    }
    clock = until;
  };
  r.changed(); r.changed(); r.changed();
  assert.equal(timers.length, 1, "a burst is one wait");
  await pass(MOVE_STATUS_SETTLE_MS);
  assert.equal(sent.length, 1);
  body = { ...body, phase: "wait" };
  r.changed();
  await pass(MOVE_STATUS_SETTLE_MS);
  assert.equal(sent.length, 1, "not twice in a minute");
  await pass(MOVE_STATUS_GAP_MS);
  assert.deepEqual(sent.map((report) => report.phase), ["copy", "wait"], "the change goes once the minute is over");
  r.changed();
  await pass(MOVE_STATUS_HEARTBEAT_MS - 10_000);
  assert.equal(sent.length, 2, "nothing changed: nothing sent");
  await pass(10_000);
  assert.equal(sent.length, 3, "and again after 15 minutes");
  who = "device-2";
  r.changed();
  await pass(MOVE_STATUS_GAP_MS);
  assert.equal(sent.length, 4, "a new sign-in hears it within the minute");

  answer = async () => { throw new Error("offline"); };
  body = { ...body, phase: "final" };
  r.changed();
  await pass(MOVE_STATUS_GAP_MS);
  assert.equal(sent.length, 5);
  answer = async () => false;
  body = { ...body, phase: "check" };
  r.changed();
  await pass(MOVE_STATUS_GAP_MS);
  assert.equal(sent.length, 6, "a failed send goes again at the next change");
  body = { ...body, phase: "switch" };
  r.changed();
  await pass(MOVE_STATUS_OFF_MS - 60_000);
  assert.equal(sent.length, 6, "an Admin that doesn't take reports is left alone for hours");
  answer = async () => true;
  await pass(MOVE_STATUS_HEARTBEAT_MS);
  assert.equal(sent.length, 7);
  r.close();
  r.changed();
  assert.equal(timers.length, 0);
});

test("the move's own changes send the report by themselves, a moment later", async () => {
  const timers = [];
  const f = installed({ state: signedIn({ machine: { status: "ready", origin: CLOUD } }),
    reportTimers: { set: (work, ms) => { const timer = { work, ms }; timers.push(timer); return timer; }, clear: (timer) => { const at = timers.indexOf(timer); if (at >= 0) timers.splice(at, 1); } } });
  try {
    await f.main.kick();
    assert.deepEqual(timers.map((timer) => timer.ms), [MOVE_STATUS_SETTLE_MS], "one wait, however many changes the run made");
    timers.shift().work();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(f.sent.map((report) => report.reason), ["moves_off"]);
    assert.equal(timers.at(-1)?.ms, MOVE_STATUS_HEARTBEAT_MS, "and again in 15 minutes");
  } finally { f.main.close(); }
});

test("reporting never touches the move: a send that fails or never answers changes nothing and holds nothing up", async () => {
  for (const reportMoveStatus of [async () => { throw new Error("Cloud request failed."); }, () => new Promise(() => {}), () => { throw new Error("sync"); }]) {
    const f = installed({ state: signedIn({ machine: { status: "ready", origin: CLOUD } }), reportMoveStatus });
    try {
      await f.main.kick();
      assert.equal(f.journal(), null);
      await Promise.race([f.main.moveStatus.flush(), new Promise((resolve) => setTimeout(resolve, 50))]);
      await f.main.kick();
      assert.equal(f.main.moveStatus.read().reason, "moves_off");
    } finally { f.main.close(); }
  }
});

test("an older journal's failure, written before failures had codes, is still reported, as an error", () => {
  const report = moveStatus({ journal: journalOf({ error: "My Cloud did not answer.", tries: 4, failingSince: 1_700_000_000_500, retryAt: 1_900_000_000_000 }), state: signedIn(), kept: false,
    now: 1_800_000_000_000, version: "0.1.128" });
  assert.deepEqual(report.failure, { phase: null, code: "error", message: "My Cloud did not answer.", count: 4, since: 1_700_000_000_500, at: null });
  assert.equal(report.reason, "retry_wait");
  assert.equal(CHECK_PASSES, 3);
});
