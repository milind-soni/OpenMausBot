import assert from "node:assert/strict";
import test from "node:test";

import { choosable, createBotMove, MY_CLOUD } from "./bot-move-main.mjs";

const reply = (status, body = {}) => ({ ok: status < 400, status, body });
const bots = (count) => Array.from({ length: count }, (_, i) => ({ id: `b${i}`, name: `Bot ${i}` }));

/** This computer's server (each bot holds or goes on as it is told), the send, My Cloud's session, and the clock's timers. */
function world({ busy = () => null, checks = [], untouched = [], ready = () => true, lease = null, sleep = async () => {} } = {}) {
  let journal = null, clock = 1_000;
  const timers = [];
  const w = {
    holds: new Map(), calls: [], cloud: [], passes: [], scopes: [],
    get journal() { return journal; },
    set journal(value) { journal = structuredClone(value); },
    advance(ms) { clock += ms; },
    timers,
    async tick() { for (const timer of timers.splice(0)) timer.work(); await w.move.kick(); },
  };
  const local = {
    async call(method, route, body) {
      w.calls.push([method, route, body]);
      if (route === "/api/cloud-send/scope") { w.scopes.push(body.bots); return reply(200, { v: 1, scope: `scope-${w.scopes.length}` }); }
      if (route.startsWith("/api/cloud-send?move=1")) return reply(200, { v: 1, items: w.chosen().filter((id) => !untouched.includes(id)).map((id) => ({ key: `bot:${id}`, kind: "bot", id, parts: {} })) });
      if (route === "/api/cloud-connections") return reply(200, { computer: { label: "MacBook Air" } });
      if (route === "/api/bots?messages=0") return reply(200, { bots: w.chosen().map((id) => ({ id, cwd: `/work/${id}` })) });
      const id = /^\/api\/bot-moves\/([\w-]+)$/u.exec(route)?.[1];
      if (id && method === "DELETE") { w.holds.delete(id); return reply(200, { v: 1, released: true }); }
      if (id && body.state === "moving") {
        const who = busy(id);
        if (who) return reply(409, { busy: who });
        w.holds.set(id, "moving");
        return reply(200, { v: 1, movedTo: { held: [`routine:r-${id}`, `webhook:w-${id}`] } });
      }
      if (id && body.state === "moved") { w.holds.set(id, "moved"); return reply(200, { v: 1, movedTo: {} }); }
      if (id && body.state === "back") { w.holds.delete(id); return reply(200, { v: 1, released: true }); }
      return reply(404);
    },
  };
  w.chosen = () => (journal?.moves ?? []).flatMap((move) => move.bots.map((bot) => bot.id));
  w.lent = [];
  w.lendWith = (lender) => { w.lender = lender; };
  w.move = createBotMove({
    journal: { read: () => structuredClone(journal), write: (value) => { journal = structuredClone(value); } },
    local,
    send: {
      async move(options) { w.passes.push({ ...options }); },
      async check(options) { w.passes.push({ check: true, ...options }); const next = checks.shift(); if (next instanceof Error) throw next; return { ok: next ?? true }; },
    },
    session: async () => ({ async call(method, route, body) { w.cloud.push([method, route, body]); return reply(200, { v: 1 }); } }),
    ready, lease, sleep,
    lend: async (projects) => { (w.lender ?? ((seen) => w.lent.push(seen)))(projects); },
    now: () => clock,
    timers: { set: (work, ms) => { const timer = { work, ms }; timers.push(timer); return timer; }, clear: (timer) => { const at = timers.indexOf(timer); if (at >= 0) timers.splice(at, 1); } },
  });
  return w;
}
const settle = async (w) => { await w.move.kick(); await new Promise((resolve) => setImmediate(resolve)); await w.move.kick(); };

test("a choice of bots goes as one move: each is held, what was on here goes on there, and each stays here as the line that opens it", async () => {
  const w = world();
  assert.ok(w.move.start(bots(3)));
  await settle(w);
  const move = w.journal.moves[0];
  assert.equal(move.phase, "done", JSON.stringify(move));
  assert.deepEqual(move.team, MY_CLOUD);
  assert.deepEqual([...w.holds.values()], ["moved", "moved", "moved"]);
  assert.deepEqual(w.passes.map((pass) => pass.check ? "check" : pass.final ? "final" : "copy"), ["copy", "final", "check"], "one copy, one final and one check for all of them");
  assert.ok(w.passes.every((pass) => pass.scope === "scope-1"), "every read of this computer's server is kept to the choice");
  assert.deepEqual(w.cloud.filter(([method]) => method === "PATCH").map(([, route]) => route).sort(), ["/api/routines/r-b0", "/api/routines/r-b1", "/api/routines/r-b2", "/api/webhooks/w-b0", "/api/webhooks/w-b1", "/api/webhooks/w-b2"]);
  assert.deepEqual(w.cloud.find(([, route]) => route === "/api/cloud-send/arrived")[2], { v: 1, computer: "MacBook Air", webhooks: ["w-b0", "w-b1", "w-b2"] });
  assert.deepEqual(w.lent, [["/work/b0", "/work/b1", "/work/b2"]], "My Cloud can reach their folders on this computer");
  assert.deepEqual(w.move.view(), { bot: { id: move.bot.id, name: "Bot 0" }, team: { id: "my-cloud", name: "My Cloud" }, phase: "done", bots: 3 });
});

test("while lending can't take the bots' folders yet, a later look does, and the move is done meanwhile", async () => {
  let refuse = true;
  const w = world();
  const lentTo = [];
  w.lendWith((projects) => { if (refuse) throw new Error("lending is paused"); lentTo.push(projects); });
  w.move.start(bots(1));
  await settle(w);
  assert.equal(w.journal.moves[0].phase, "done");
  assert.deepEqual(w.journal.moves[0].lend, ["/work/b0"]);
  refuse = false;
  await w.move.kick();
  assert.deepEqual(lentTo, [["/work/b0"]]);
  assert.equal(w.journal.moves[0].lend, undefined);
});

test("any number of bots go in one move, and an untouched bot, which a move has nothing to carry of, stays here", async () => {
  const many = world({ untouched: ["b7"] });
  many.move.start(bots(1_000));
  await settle(many);
  assert.equal(many.journal.moves[0].phase, "done");
  assert.equal(many.journal.moves[0].bots.length, 999);
  assert.equal(many.holds.size, 999);
  assert.equal(many.holds.has("b7"), false);
  assert.equal(many.passes.length, 3, "still one copy, one final and one check");

  const nothing = world({ untouched: ["b0"] });
  nothing.move.start(bots(1));
  await settle(nothing);
  assert.equal(nothing.journal.moves[0].stopped, true);
  assert.equal(nothing.holds.size, 0);
});

test("a bot still answering holds the move for it; the others stay held meanwhile, and the rest of this computer goes on", async () => {
  let answering = "Bot 1";
  const w = world({ busy: (id) => (id === "b1" ? answering : null) });
  w.move.start(bots(3));
  await settle(w);
  assert.equal(w.journal.moves[0].phase, "freeze");
  assert.equal(w.holds.has("b2"), false, "held in turn, as each is free");
  answering = null;
  await w.tick();
  assert.equal(w.journal.moves[0].phase, "done");
});

test("a check that fails lets every bot of the choice go on here, and the move tries again later from the copy", async () => {
  const w = world({ checks: [false, false, false] });
  w.move.start(bots(2));
  await settle(w);
  const move = w.journal.moves[0];
  assert.equal(move.phase, "copy");
  assert.equal(move.failing, true);
  assert.ok(move.retryAt > 1_000);
  assert.equal(w.holds.size, 0, "nothing stays held");
  assert.equal(w.move.view().phase, "failed");
});

test("bots already on their way are not moved twice, and My Cloud ending brings the ones that moved back", async () => {
  const w = world();
  w.move.start(bots(2), "acct-1");
  assert.deepEqual(w.move.moving(), ["b0", "b1"]);
  assert.equal(w.move.start(bots(2)), null, "no bot left to move");
  await settle(w);
  assert.deepEqual(w.move.moving(), [], "done");
  await w.move.back("acct-2");
  assert.equal(w.holds.size, 2, "another account's Cloud ending says nothing of these");
  await w.move.back("acct-1");
  assert.equal(w.holds.size, 0);
  assert.deepEqual(w.journal.moves, []);
});

test("Move everything stops a choice still on its way, and its bots go on here until that move takes them", async () => {
  let answering = "Bot 1";
  const w = world({ busy: (id) => (id === "b1" ? answering : null) });
  w.move.start(bots(2));
  await settle(w);
  assert.equal(w.holds.get("b0"), "moving");
  await w.move.drop();
  assert.equal(w.holds.size, 0);
  assert.deepEqual(w.journal.moves, []);
  answering = null;
});

test("Move everything leaves a choice at its switch to finish: My Cloud already runs its bots", async () => {
  const w = world();
  w.move.start(bots(2));
  await settle(w);
  w.journal = { ...w.journal, moves: w.journal.moves.map((move) => ({ ...move, phase: "switch" })) };
  w.holds.set("b0", "moving"); w.holds.set("b1", "moving");
  await w.move.drop();
  assert.equal(w.holds.get("b0"), "moving", "not let go here while My Cloud runs it");
  assert.equal(w.journal.moves.length, 1);
  assert.equal(w.journal.moves[0].phase, "switch");
});

test("it waits its turn at My Cloud behind another computer's move, and lets go when it is done", async () => {
  let asks = 0;
  const released = [];
  const lease = { take: async () => (++asks < 3 ? { name: "NUC" } : null), release: async () => { released.push(asks); } };
  const naps = [];
  const w = world({ lease, sleep: async (ms) => { naps.push(ms); } });
  w.move.start(bots(1));
  await settle(w);
  assert.equal(w.journal.moves[0].phase, "done");
  assert.deepEqual(naps, [60_000, 60_000]);
  assert.ok(released.length >= 1);
});

test("only the bots a person can move are offered: never the helper every place has, an archived one, or one that moved", () => {
  assert.deepEqual(choosable([{ id: "a", name: "A" }, { id: "d", name: "D", defaultBot: { v: 1 } }, { id: "h", name: "H", hidden: true }, { id: "m", name: "M", movedTo: { state: "moved" } }, { id: "bad id", name: "X" }, null]).map((bot) => bot.id), ["a"]);
});
