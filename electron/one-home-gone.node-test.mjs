import assert from "node:assert/strict";
import test from "node:test";

import { createOneHome, QUIET_MS } from "./one-home.mjs";
import { createGoneCheck, GONE_ASK_MS, installOneHome, oneHomeCloud } from "./one-home-main.mjs";
import { moveStatus } from "./move-status.mjs";

// A computer whose bots moved to one Cloud of the person's, while the account has others: that Cloud ends or is deleted and
// another becomes My Cloud. The Admin's word on the Cloud moved to brings this computer home by itself, with every
// automation off; nothing else does (an Admin that can't say, a session not verified, another account, a server of the
// person's own). Every side is faked; nothing reaches the network.
const GONE = "https://omb-trial-1.fly.dev", MINE = "https://omb-other-2.fly.dev";
const reply = (status, body = {}) => ({ ok: status < 400, status, body });

function computer({ journal = null, marker = { frozen: true, cloud: GONE }, admin = { [GONE]: "deleted" }, cloud = {} } = {}) {
  let clock = 2_000_000;
  const timers = [];
  const w = {
    journal, keep: null, admin, asked: [], passes: [], opened: [], unfreezeFails: 0,
    server: { marker: structuredClone(marker), on: { "routine:r1": true, "webhook:w1": true }, thaws: [] },
    cloud: { origin: MINE, account: "acct-1", machine: MINE, ready: true, moves: true, ended: false, paid: true, verified: true, ...cloud },
    advance(ms) { clock += ms; },
    async tick() { const due = timers.splice(0); for (const timer of due) timer.work(); await w.home.kick(); },
  };
  const frozen = () => Boolean(w.server.marker?.frozen);
  w.home = createOneHome({
    journal: { read: () => structuredClone(w.journal), write: (value) => { w.journal = structuredClone(value); } },
    keep: { read: () => w.keep, write: (value) => { w.keep = value; } },
    cloud: () => (w.cloud ? { ...w.cloud } : null),
    gone: async (origin) => { w.asked.push(origin); const said = w.admin?.[origin]; return said === "deleted" || said === "ended" ? said : null; },
    send: { move: async (options) => { w.passes.push(options?.final ? "final" : "copy"); }, check: async () => ({ ok: true }), switches: () => ({ ...w.server.on }), snapshot: () => ({ running: null }) },
    local: {
      async freeze(origin) { w.server.marker = { frozen: true, cloud: origin }; return { frozen: true }; },
      async unfreeze(options) {
        if (w.unfreezeFails > 0) { w.unfreezeFails--; throw new Error("OpenMausBot on this computer could not go on again."); }
        w.server.thaws.push(options ?? null);
        if (options?.automations === "off") for (const key of Object.keys(w.server.on)) w.server.on[key] = false;
        w.server.marker = { frozen: false };
      },
      frozen: async () => frozen(),
      marker: async () => structuredClone(w.server.marker),
      async json(route) { if (route.startsWith("/api/bots")) return { bots: [] }; return { items: [], conversations: [], automations: [] }; },
      call: async () => reply(200),
    },
    session: async () => ({ call: async () => reply(200, { v: 1 }), close: async () => {} }),
    openHome: () => w.opened.push("cloud"),
    openLocal: () => w.opened.push("local"),
    lastInput: () => 0,
    version: "0.1.138",
    now: () => clock,
    timers: { set: (work, ms) => { const timer = { work, ms }; timers.push(timer); return timer; }, clear: (timer) => { const at = timers.indexOf(timer); if (at >= 0) timers.splice(at, 1); } },
  });
  return w;
}

const doneTo = (origin, extra = {}) => ({ v: 1, phase: "done", cloud: { origin, account: "acct-1", machine: origin }, startedAt: 1_000, doneAt: 1_500, frozenAt: 1_400, version: "0.1.138", lent: true, phoneStopped: true, ...extra });

test("a computer stuck today (no journal, the freeze names a deleted Cloud of the same account, My Cloud another Cloud) comes home by itself once, with every automation off", async () => {
  const w = computer();
  await w.home.kick();
  assert.deepEqual(w.asked, [GONE], "the Admin is asked about the Cloud the freeze names, not My Cloud");
  assert.deepEqual(w.server.thaws, [{ automations: "off" }]);
  assert.equal(w.server.marker.frozen, false);
  assert.deepEqual(w.server.on, { "routine:r1": false, "webhook:w1": false }, "nothing runs twice");
  assert.equal(w.journal.phase, "back");
  assert.equal(w.journal.gone, "deleted");
  assert.deepEqual(w.journal.cloud, { origin: GONE, account: "acct-1", machine: GONE });
  assert.deepEqual(w.opened, ["local"]);
  assert.equal(w.keep?.on, true, "its bots stay here: no move to My Cloud starts by itself");
  assert.deepEqual(w.home.view(), { phase: "back", gone: true });
  // Said once: closed, it is gone for good, and nothing loops.
  w.home.seen();
  assert.equal(w.home.view(), null);
  for (let launch = 0; launch < 3; launch++) { w.advance(QUIET_MS + 1); await w.tick(); }
  assert.deepEqual(w.server.thaws, [{ automations: "off" }], "lifted once");
  assert.deepEqual(w.passes, [], "nothing of this computer goes to My Cloud");
  assert.equal(w.journal.phase, "back");
  assert.equal(moveStatus({ journal: w.journal, state: { status: "connected", account: { id: "acct-1" }, machine: { status: "ready", origin: MINE, moves: true } }, kept: w.home.keeps(), now: 0 }).reason, "keep_here");
});

test("a Cloud that ended and is not My Cloud any more brings this computer home too", async () => {
  const w = computer({ admin: { [GONE]: "ended" } });
  await w.home.kick();
  assert.equal(w.journal.gone, "ended");
  assert.deepEqual(w.server.thaws, [{ automations: "off" }]);
});

test("the freeze is never lifted without the Admin's verified word: an Admin that can't say, a session not verified, signed out, or a Cloud none of this account's", async () => {
  for (const [name, setup] of [
    ["an older Admin, or one that can't be reached", { admin: {} }],
    ["the Cloud is still there", { admin: { [GONE]: "live" } }],
    ["another account's Cloud (unknown to this one)", { admin: { [GONE]: "unknown" } }],
    ["a session not verified now", { cloud: { verified: false } }],
  ]) {
    const w = computer(setup);
    await w.home.kick();
    assert.deepEqual(w.server.thaws, [], name);
    assert.equal(w.server.marker.frozen, true, name);
    assert.equal(w.journal, null, name);
    assert.equal(w.home.facts().noted, "frozen_without_move", name);
  }
  const out = computer();
  out.cloud = null;
  await out.home.kick();
  assert.deepEqual([out.asked, out.server.thaws], [[], []], "signed out: nothing is asked");
});

test("a freeze for a server of the person's own, one that names no Cloud, or one for My Cloud itself is never asked about", async () => {
  for (const marker of [{ frozen: true, cloud: GONE, place: "Home box" }, { frozen: true }, { frozen: true, cloud: MINE }]) {
    const w = computer({ marker, admin: { [GONE]: "deleted", [MINE]: "deleted" } });
    await w.home.kick();
    assert.deepEqual([w.asked, w.server.thaws], [[], []], JSON.stringify(marker));
  }
});

test("the journal's Cloud deleted while My Cloud is another: home with every automation off, and no top-up ever goes to the other Cloud", async () => {
  const w = computer({ journal: doneTo(GONE, { version: "0.1.120" }) });
  w.admin = {};
  await w.home.kick();
  assert.deepEqual(w.passes, [], "a newer app's top-up only ever goes to the Cloud this computer moved to");
  assert.deepEqual(w.server.thaws, []);
  w.admin = { [GONE]: "deleted" };
  w.advance(GONE_ASK_MS);
  await w.home.kick();
  assert.deepEqual(w.server.thaws, [{ automations: "off" }]);
  assert.equal(w.journal.phase, "back");
  assert.equal(w.journal.gone, "deleted");
  assert.equal(w.journal.frozenAt, 1_400, "what the journal knew stays");
  assert.deepEqual(w.home.view(), { phase: "back", gone: true });
});

test("My Cloud ended, but this computer moved to another Cloud that goes on: it stays moved, and nothing comes home", async () => {
  const w = computer({ journal: doneTo(GONE), admin: { [GONE]: "live" }, cloud: { ended: true, ready: false, homecoming: { installationId: "x".repeat(43), name: "MacBook Air" } } });
  await w.home.kick();
  assert.deepEqual(w.server.thaws, []);
  assert.equal(w.journal.phase, "done");
});

test("My Cloud ending is still the one signal for the Cloud this computer moved to itself", async () => {
  const w = computer({ journal: doneTo(MINE), marker: { frozen: true, cloud: MINE }, cloud: { ended: true, ready: false } });
  await w.home.kick();
  assert.deepEqual(w.asked, [], "My Cloud's own word, as before");
  assert.equal(w.journal.phase, "back");
  assert.equal(w.journal.lost, true);
  assert.equal(w.journal.gone, undefined);
  assert.deepEqual(w.server.thaws, [null], "its automations come back as they were, as before");
});

test("another account signed in: the journal's account decides, as before, and nothing is asked", async () => {
  const w = computer({ journal: doneTo(GONE), cloud: { account: "acct-2" } });
  await w.home.kick();
  assert.deepEqual([w.asked, w.server.thaws, w.journal.phase], [[], [], "done"]);
});

test("a move not switched over yet, while My Cloud became another Cloud: the freeze lifts and the move stops, as when My Cloud ends", async () => {
  const w = computer({ journal: { ...doneTo(GONE), phase: "final", frozenAt: 1_400 }, admin: {} });
  await w.home.kick();
  assert.deepEqual(w.server.thaws, [null]);
  assert.equal(w.journal, null);
  assert.deepEqual(w.passes, [], "nothing more goes to the other Cloud in that move");
});

test("already home and waiting for a gone Cloud's things: it stops waiting", async () => {
  const w = computer({ journal: { ...doneTo(GONE), phase: "home-again", endedAt: 1_600, retryAt: 9_999_999 }, marker: { frozen: false } });
  await w.home.kick();
  assert.equal(w.journal.phase, "back");
  assert.equal(w.journal.lost, true);
  assert.deepEqual(w.server.thaws, [], "already open: its automations are left as they are");
});

test("a copy that can't open yet is tried again a minute later, and then once only", async () => {
  const w = computer();
  w.unfreezeFails = 1;
  await w.home.kick();
  assert.equal(w.server.marker.frozen, true);
  assert.equal(w.journal, null);
  w.advance(60_000);
  await w.tick();
  assert.deepEqual(w.server.thaws, [{ automations: "off" }]);
  assert.equal(w.journal.phase, "back");
});

test("the Admin is asked about a Cloud at most every GONE_ASK_MS while it says nothing that brings this computer home, per account; gone stays gone", async () => {
  let clock = 0, said = "live", who = "acct-1";
  const asks = [];
  const gone = createGoneCheck({ ask: async (origin) => { asks.push(origin); if (said === "throw") throw new Error("offline"); return said; }, account: () => who, now: () => clock });
  assert.equal(await gone(GONE), null);
  assert.equal(await gone(GONE), null);
  assert.equal(asks.length, 1);
  said = "throw"; clock += GONE_ASK_MS;
  assert.equal(await gone(GONE), null, "an Admin that can't be asked is no word");
  said = "deleted"; clock += GONE_ASK_MS;
  assert.equal(await gone(GONE), "deleted");
  said = "live"; clock += GONE_ASK_MS;
  assert.equal(await gone(GONE), "deleted", "gone stays gone");
  who = "acct-2";
  assert.equal(await gone(GONE), null, "another account's answer is its own");
  who = null;
  assert.equal(await gone(GONE), null);
  assert.equal(asks.length, 4);
});

test("one home's view of the session says when it is the Admin's verified word", () => {
  const state = { status: "connected", account: { id: "acct-1" }, machine: { status: "ready", origin: MINE } };
  assert.equal(oneHomeCloud(state).verified, true);
  assert.equal(oneHomeCloud({ ...state, status: "unavailable" }).verified, false);
});

test("on their way home by the person's choice when the Cloud goes: what that way home would have switched on stays off", async () => {
  const w = computer({ journal: { ...doneTo(GONE), phase: "keeping", keptFrom: "done", keptAt: 1_700, switchBack: { "routine:r1": true }, webhooks: ["w1"], offThere: true } });
  w.keep = { v: 1, on: true };
  await w.home.kick();
  assert.deepEqual(w.server.thaws, [{ automations: "off" }]);
  assert.equal(w.journal.phase, "back");
  for (const field of ["switchBack", "webhooks", "keptFrom", "offThere"]) assert.equal(w.journal[field], undefined, field);
  await w.home.kick();
  assert.deepEqual(w.server.on, { "routine:r1": false, "webhook:w1": false });
});

test("a copy this computer already deleted still opens, and is not said to be back as it was", async () => {
  const w = computer({ journal: doneTo(GONE, { forgot: true }) });
  await w.home.kick();
  assert.equal(w.server.marker.frozen, false);
  assert.equal(w.journal.phase, "back");
  assert.equal(w.home.view(), null);
});

test("wired up for real: a stuck computer's own server is asked, the Admin's word comes from the sign-in, and the freeze lifts with automations off", async () => {
  const state = { status: "connected", deviceId: "device-2", account: { id: "acct-1" }, machine: { status: "ready", origin: MINE, moves: true } };
  const asked = [], requests = [];
  let frozen = true, kept = null, choice = null, opened = 0;
  const main = installOneHome({
    ipcMain: { handle: () => {} }, cloudPage: () => "local", server: () => null, home: () => null, cookieFetch: async () => new Response("{}", { status: 401 }),
    reconnect: async () => false, power: { asleep: () => false }, file: () => "/nonexistent/cloud-send.json", window: () => null, localOrigin: () => "http://127.0.0.1:4100",
    fetch: async () => new Response("{}", { status: 404 }),
    localRequest: async (route, init) => {
      requests.push([init?.method ?? "GET", route, init?.body ?? null]);
      if (route === "/api/move/freeze" && init?.method === "DELETE") { frozen = false; return new Response(JSON.stringify({ frozen: false })); }
      if (route === "/api/move/freeze") return new Response(JSON.stringify(frozen ? { frozen: true, cloud: GONE } : { frozen: false }));
      return new Response("{}", { status: 404 });
    },
    account: () => ({ state: () => state, movedTo: async (origin) => { asked.push(origin); return "deleted"; } }),
    journalFile: () => "/nonexistent/one-home.json", tempRoot: () => "/nonexistent", openLocal: () => { opened++; },
    journal: { read: () => kept, write: (value) => { kept = value; } }, keep: { read: () => choice, write: (value) => { choice = value; } },
  });
  try {
    await main.kick();
    assert.deepEqual(asked, [GONE]);
    assert.deepEqual(requests.find(([method]) => method === "DELETE"), ["DELETE", "/api/move/freeze", JSON.stringify({ automations: "off" })]);
    assert.equal(frozen, false);
    assert.deepEqual([kept.phase, kept.gone, kept.cloud.account, choice?.on, opened], ["back", "deleted", "acct-1", true, 1]);
  } finally { main.close(); }
});

test("My Cloud held with no address gives no sign of being another Cloud: it comes home as it always did, with its automations as they were", async () => {
  const w = computer({ journal: doneTo(GONE), admin: { [GONE]: "ended" }, cloud: { origin: null, machine: null, ready: false, ended: true } });
  await w.home.kick();
  assert.deepEqual(w.asked, []);
  assert.deepEqual(w.server.thaws, [null]);
  assert.equal(w.journal.gone, undefined);
  assert.equal(w.journal.phase, "back");
});
