import assert from "node:assert/strict";
import test from "node:test";
import { createOneHome } from "./one-home.mjs";
import { installOneHome } from "./one-home-main.mjs";

const CLOUD_A = "https://omb-a.fly.dev", CLOUD_B = "https://omb-b.fly.dev";
const cloudOf = (account, origin) => ({ origin, account, machine: origin, ready: true, moves: true, ended: false, paid: true, verified: true, signIn: `device-${account}` });
const movedToA = (phase = "done") => ({ v: 1, phase, cloud: { origin: CLOUD_A, account: "a", machine: CLOUD_A }, doneAt: 1, version: "1", lent: true, phoneStopped: true, reported: "device-a", told: false });

/** One home with fakes: the journal, this computer's server, each pass and every call to a Cloud or the Admin. */
function world({ journal = null, cloud = cloudOf("b", CLOUD_B), marker = { frozen: false }, gone = async () => null, onPass = () => {} } = {}) {
  const w = { journal, cloud, marker, passes: [], unfreezes: [], freezes: 0, sessions: 0, reports: 0, gone: [], running: null };
  w.home = createOneHome({
    journal: { read: () => structuredClone(w.journal), write: (value) => { w.journal = structuredClone(value); } },
    cloud: () => (w.cloud ? { ...w.cloud } : null),
    send: { async move(options) { w.passes.push(options?.final ? "final" : "copy"); await onPass(w); }, check: async () => ({ ok: true }), switches: () => ({}), snapshot: () => ({ running: w.running }) },
    local: {
      freeze: async () => { w.freezes++; w.marker = { frozen: true }; return { frozen: true }; },
      unfreeze: async (options) => { w.unfreezes.push(options ?? null); w.marker = { frozen: false }; },
      frozen: async () => w.marker.frozen, marker: async () => w.marker, json: async () => ({}), call: async () => ({ ok: true, status: 200, body: {} }), forget: async () => {},
    },
    gone: async (origin) => { w.gone.push(origin); return gone(origin); },
    session: async () => { w.sessions++; return { call: async () => ({ ok: true, status: 200, body: {} }), close: async () => {} }; },
    reportMove: async () => { w.reports++; return true; }, lastInput: () => 0, version: "1", now: () => 1_000_000, timers: { set: () => 1, clear() {} },
  });
  return w;
}

for (const phase of ["done", "switch", "keeping", "home-again", "back", "copy", "wait"]) {
  test(`this computer's move to A's Cloud (${phase}), and B is signed in: the journal stays, no freeze lifts, nothing moves, nothing is told`, async () => {
    const w = world({ journal: movedToA(phase), marker: { frozen: true, cloud: CLOUD_A } });
    const before = structuredClone(w.journal);
    await w.home.kick();
    assert.deepEqual(w.journal, before, "the journal is exactly as it was");
    assert.deepEqual([w.passes, w.unfreezes, w.sessions, w.reports, w.freezes], [[], [], 0, 0, 0]);
    assert.deepEqual(w.gone, [], "B's Admin is asked nothing about A's Cloud");
    assert.equal(w.home.view(), null, "no line about A's move on B's pages");
    assert.equal(w.home.moving(), false, "nothing holds B: B can switch away again");
  });
}

test("back to A: the same move goes on from where it was, and its line returns", async () => {
  const w = world({ journal: { ...movedToA("copy"), doneAt: undefined } });
  await w.home.kick();
  assert.deepEqual(w.passes, []);
  w.cloud = cloudOf("a", CLOUD_A);
  await w.home.kick();
  assert.equal(w.passes[0], "copy");
  assert.equal(w.journal.cloud.account, "a");
  assert.notEqual(w.home.view(), null);
});

test("no first move for the wrong account: a journal of A's never becomes a move to B, whichever phase it is in", async () => {
  const w = world({ journal: movedToA("back") });
  await w.home.kick();
  assert.equal(w.journal.cloud.origin, CLOUD_A);
  assert.deepEqual(w.passes, []);
});

test("the account changes during a pass: no next step runs, no freeze starts, for either account", async () => {
  const w = world({ cloud: cloudOf("a", CLOUD_A), onPass: (at) => { at.cloud = cloudOf("b", CLOUD_B); } });
  await w.home.kick();
  assert.deepEqual(w.passes, ["copy"], "the pass under way ended; the next read My Cloud from the new sign-in and never ran");
  assert.equal(w.freezes, 0);
  assert.equal(w.journal.cloud.account, "a");
  assert.equal(w.sessions, 0);
});

test("the account changes while frozen for a pass: the freeze this move took lifts, and the move goes back to its copy, still A's", async () => {
  const w = world({ journal: { ...movedToA("final"), frozenAt: 1, doneAt: undefined }, cloud: cloudOf("b", CLOUD_B), marker: { frozen: true, cloud: CLOUD_A } });
  await w.home.kick();
  assert.equal(w.journal.phase, "copy");
  assert.equal(w.journal.cloud.account, "a");
  assert.equal(w.journal.failure?.code ?? "other_account", "other_account");
  assert.deepEqual(w.passes, []);
});

for (const phase of ["wait", "freeze", "final", "check", "switch"]) {
  test(`the move past where it can stop (${phase}) holds the account signed in: the switcher refuses, so no freeze is ever lifted by a switch`, () => {
    const w = world({ journal: movedToA(phase), cloud: cloudOf("a", CLOUD_A) });
    assert.equal(w.home.moving(), true);
  });
}

test("a pass copying now holds its account too; a journal at rest doesn't", () => {
  const copying = world({ journal: movedToA("copy"), cloud: cloudOf("a", CLOUD_A) });
  assert.equal(copying.home.moving(), false);
  copying.running = { phase: "chats" };
  assert.equal(copying.home.moving(), true);
  assert.equal(world({ journal: movedToA("done"), cloud: cloudOf("a", CLOUD_A) }).home.moving(), false);
});

test("a freeze with no journal, naming A's Cloud: B's Admin doesn't know that Cloud, so it stays frozen and no move starts", async () => {
  const w = world({ marker: { frozen: true, cloud: CLOUD_A } });
  await w.home.kick();
  assert.deepEqual(w.gone, [CLOUD_A], "asked of B's Admin, which answers only for B's own Clouds");
  assert.deepEqual([w.unfreezes, w.passes, w.freezes], [[], [], 0]);
  assert.equal(w.journal, null);
});

function main({ state, accounts = 1, journal = null, marker = { frozen: false } }) {
  let kept = journal, passes = 0;
  const handlers = new Map();
  const reply = (value) => new Response(JSON.stringify(value), { status: 200 });
  const installed = installOneHome({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }, cloudPage: () => "local", server: () => null, home: () => null, cookieFetch: async () => reply({}), reconnect: async () => false,
    power: { asleep: () => false }, file: () => "/nonexistent/cloud-send.json", window: () => null, localOrigin: () => "http://127.0.0.1:4100", fetch: async () => reply({}),
    localRequest: async (route) => { if (route.startsWith("/api/cloud-send")) passes++; return route === "/api/move/freeze" ? reply(marker) : reply({}); },
    account: () => ({ state: () => state, reportMoveStatus: async () => { throw new Error("nothing is reported"); } }), journalFile: () => "/nonexistent/one-home.json", tempRoot: () => "/nonexistent",
    journal: { read: () => kept, write: (value) => { kept = value; } }, keep: { read: () => null, write() {} }, accountsHere: () => accounts,
  });
  return { installed, handlers, journal: () => kept, passes: () => passes };
}
const withCloud = (id, origin) => ({ status: "connected", deviceId: `device-${id}`, account: { id, email: `${id}@example.test` }, entitlement: { plan: "pro", status: "active", expiresAt: 9e15, version: 1 }, machine: { status: "ready", origin, moves: true } });

test("one account with a Cloud: its first move starts as ever; with a second account signed in here, none starts by itself", async () => {
  const one = main({ state: withCloud("b", CLOUD_B), accounts: 1 });
  await one.installed.oneHome.kick();
  assert.equal(one.journal()?.cloud?.account, "b");
  one.installed.close();
  const two = main({ state: withCloud("b", CLOUD_B), accounts: 2 });
  await two.installed.oneHome.kick();
  assert.equal(two.journal(), null, "this computer's own workspace stays as it is");
  two.installed.close();
});

test("a move under way stays with its account when a second one signs in here", async () => {
  const running = main({ state: withCloud("a", CLOUD_A), accounts: 2, journal: { ...movedToA("copy"), doneAt: undefined } });
  await running.installed.oneHome.kick();
  assert.notEqual(running.journal().paused, true);
  running.installed.close();
});

test("Keep this computer's bots here isn't offered to B for A's move, and A's move doesn't hold B", async () => {
  const f = main({ state: withCloud("b", CLOUD_B), accounts: 2, journal: movedToA("done"), marker: { frozen: true, cloud: CLOUD_A } });
  const keep = await f.handlers.get("one-home:keep")({});
  assert.equal(keep.shown, false);
  assert.equal(f.installed.holding(), null);
  f.installed.close();
});
