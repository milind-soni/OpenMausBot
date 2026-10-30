import assert from "node:assert/strict";
import test from "node:test";

import { BUSY_POLL_MS, CHECK_PASSES, createTeamMove, RETRY_MS, routinesOn } from "./team-move.mjs";

const ACME = { id: "team-acme", name: "Acme", origin: "https://omb-u-acme.fly.dev" };
const SCOUT = { id: "scout-1", name: "Scout" };
const reply = (status, body = {}) => ({ ok: status < 400, status, body });

/** One team move with fakes on every side: its journal (kept across "relaunches"), each run's send, My Cloud's owner
 * session and the team's move-in sign-in (every call either got, and which fail), the clock and its timers. */
function world({ checks = [], passes = [], freeze = [], begin = [], done = [], moved = [], prepare = null } = {}) {
  let journal = null, clock = 1_000_000;
  const timers = [];
  const w = {
    calls: [], held: false, team: { done: false, on: null }, inTeam: true, closes: 0, opens: 0,
    get journal() { return journal; },
    now: () => clock,
    advance(ms) { clock += ms; },
    async tick() { const due = timers.splice(0); for (const timer of due) timer.work(); await w.moves.kick(); },
    make() {
      return createTeamMove({
        journal: { read: () => structuredClone(journal), write: (value) => { w.beforeWrite?.(value); journal = structuredClone(value); } },
        inTeam: () => w.inTeam,
        now: () => clock,
        timers: { set: (work, ms) => { const timer = { work, ms }; timers.push(timer); return timer; }, clear: (timer) => { const at = timers.indexOf(timer); if (at >= 0) timers.splice(at, 1); } },
        open: () => {
          w.opens++;
          return {
            engine: {
              async move(options) { const kind = options?.final ? "final" : "copy"; w.calls.push(kind); const fail = passes.shift(); if (fail) throw new Error(fail); },
              async check() { w.calls.push("check"); return { ok: checks.length ? checks.shift() : true }; },
            },
            myCloud: {
              async call(method, route, body) {
                w.calls.push(`${method} ${route} ${body?.state ?? ""}`.trim());
                if (method === "DELETE") { w.held = false; return reply(200, { released: true }); }
                if (body.state === "moving") {
                  const next = freeze.shift();
                  if (next === "busy") return reply(409, { busy: "Scout" });
                  if (next) throw new Error(next);
                  w.held = true;
                  return reply(200, { movedTo: { team: ACME, state: "moving", held: ["routine:r1", "webhook:w1"] } });
                }
                const next = moved.shift();
                if (next) return reply(500, { error: next });
                return reply(200, { movedTo: { team: ACME, state: "moved" } });
              },
            },
            team: {
              async begin() { w.calls.push("begin"); const next = begin.shift(); if (next instanceof Error) throw next; return next ?? { name: "Scout" }; },
              async done(on) { w.calls.push("done"); const next = done.shift(); if (next) throw new Error(next); w.team = { done: true, on }; },
            },
            ...(prepare ? { prepare } : {}),
            close: async () => { w.closes++; },
          };
        },
      });
    },
  };
  w.moves = w.make();
  w.relaunch = () => { w.moves.close(); w.moves = w.make(); };
  return w;
}
const phase = (w) => w.journal?.moves?.[0]?.phase;

test("a move goes copy, hold, final, check, switch: the team switches on what was on, then My Cloud keeps the line; one sign-in each per run", async () => {
  const w = world();
  await w.moves.start({ bot: SCOUT, team: ACME });
  assert.deepEqual(w.calls, ["begin", "copy", "POST /api/bot-moves/scout-1 moving", "final", "check", "done", "POST /api/bot-moves/scout-1 moved"]);
  assert.deepEqual(w.team, { done: true, on: ["routine:r1"] });
  assert.equal(phase(w), "done");
  assert.deepEqual([w.opens, w.closes], [1, 1]);
  assert.deepEqual(w.moves.view(), { bot: SCOUT, team: { id: ACME.id, name: ACME.name }, phase: "done" });
  w.moves.seen();
  assert.equal(w.moves.view(), null);
});

test("a failure before the hold tries again later and never touches My Cloud's bot; one while held lets it go on there first", async () => {
  const w = world({ passes: ["no network"] });
  await w.moves.start({ bot: SCOUT, team: ACME });
  assert.deepEqual(w.calls, ["begin", "copy"]);
  assert.equal(w.held, false);
  assert.equal(w.moves.view().phase, "failed");
  assert.equal(w.journal.moves[0].retryAt, w.now() + RETRY_MS[0]);
  w.advance(RETRY_MS[0]);
  w.calls.length = 0;
  await w.tick();
  assert.equal(phase(w), "done");

  const held = world({ passes: [null, "the team did not answer"] });
  await held.moves.start({ bot: SCOUT, team: ACME });
  assert.deepEqual(held.calls, ["begin", "copy", "POST /api/bot-moves/scout-1 moving", "final", "DELETE /api/bot-moves/scout-1"]);
  assert.equal(held.held, false);
  assert.equal(phase(held), "copy");
});

test("a check that keeps finding something missing passes three times at most, then lets the bot go on on My Cloud", async () => {
  const w = world({ checks: [false, false, false] });
  await w.moves.start({ bot: SCOUT, team: ACME });
  assert.equal(w.calls.filter((call) => call === "check").length, CHECK_PASSES);
  assert.equal(w.calls.at(-1), "DELETE /api/bot-moves/scout-1");
  assert.equal(w.team.done, false);
  assert.equal(phase(w), "copy");
  assert.match(w.journal.moves[0].error, /did not reach Acme/u);
});

test("a busy bot is held once it is done answering", async () => {
  const w = world({ freeze: ["busy"] });
  await w.moves.start({ bot: SCOUT, team: ACME });
  assert.equal(phase(w), "freeze");
  w.calls.length = 0;
  await w.tick();
  assert.equal(phase(w), "done");
  assert.equal(w.calls[0], "POST /api/bot-moves/scout-1 moving");
  assert.equal(BUSY_POLL_MS, 5_000);
});

test("from the switch on it only goes forward: a failed switch waits and tries again, never letting the bot go on in two places", async () => {
  const w = world({ done: ["the team is restarting"], moved: ["My Cloud is restarting"] });
  await w.moves.start({ bot: SCOUT, team: ACME });
  assert.equal(phase(w), "switch");
  assert.ok(!w.calls.includes("DELETE /api/bot-moves/scout-1"));
  w.advance(2 * 60_000);
  await w.tick();
  assert.equal(phase(w), "switch", "the team switched, My Cloud did not keep the line yet");
  assert.equal(w.journal.moves[0].teamDone, true);
  w.advance(2 * 60_000);
  w.calls.length = 0;
  await w.tick();
  assert.equal(phase(w), "done");
  assert.deepEqual(w.calls, ["POST /api/bot-moves/scout-1 moved"], "the team is never asked to switch twice");
});

test("killed anywhere, the next launch goes on from the journal", async () => {
  for (const at of ["freeze", "final", "check", "switch"]) {
    const w = world();
    w.beforeWrite = (value) => { if (value?.moves?.[0]?.phase === at) { w.beforeWrite = null; throw new Error("killed"); } };
    await w.moves.start({ bot: SCOUT, team: ACME }).catch(() => {});
    w.relaunch();
    await w.moves.kick();
    assert.equal(phase(w), "done", at);
    assert.equal(w.calls.filter((call) => call === "done").length, 1, at);
  }
  // The team already took it (the run was cut short after its switch): straight on to My Cloud's line.
  const w = world({ begin: [{ done: true, name: "Scout (Ada)" }] });
  await w.moves.start({ bot: SCOUT, team: ACME });
  assert.deepEqual(w.calls, ["begin", "POST /api/bot-moves/scout-1 moved"]);
  assert.equal(w.journal.moves[0].name, "Scout (Ada)");
});

test("someone no longer in the team moves nothing into it: a held bot goes on on My Cloud, and the move stops", async () => {
  const w = world();
  w.beforeWrite = (value) => { if (value?.moves?.[0]?.phase === "final") { w.beforeWrite = null; w.inTeam = false; throw new Error("killed"); } };
  await w.moves.start({ bot: SCOUT, team: ACME }).catch(() => {});
  w.relaunch();
  await w.moves.kick();
  assert.equal(w.held, false);
  assert.deepEqual(w.journal.moves[0], { ...w.journal.moves[0], phase: "copy", failing: true, stopped: true, error: "You're no longer in Acme." });
  w.calls.length = 0;
  await w.moves.kick();
  assert.deepEqual(w.calls, [], "stopped: nothing more");
});

test("a bot that stays on My Cloud (its Chief of Staff, or gone) stops the move before anything changes", async () => {
  const w = world({ prepare: async () => { throw Object.assign(new Error("Scout is your Chief of Staff, which stays on My Cloud."), { final: true }); } });
  await w.moves.start({ bot: SCOUT, team: ACME });
  assert.deepEqual(w.calls, []);
  assert.equal(w.moves.view().phase, "failed");
  assert.equal(w.journal.moves[0].stopped, true);
});

test("one move per bot: starting it again goes on with it, to another team is refused", async () => {
  const w = world({ passes: ["no network"] });
  await w.moves.start({ bot: SCOUT, team: ACME });
  assert.throws(() => w.moves.start({ bot: SCOUT, team: { id: "team-beta", name: "Beta" } }), /Scout is moving to Acme/u);
  await w.moves.retry();
  assert.equal(phase(w), "done");
  assert.equal(w.journal.moves.length, 1);
});

test("the routines switched on in the team are those that were on on My Cloud", () => {
  assert.deepEqual(routinesOn(["routine:r1", "webhook:w1", "app-event:a1", "routine:r2", 4, "routine:"]), ["routine:r1", "routine:r2"]);
  assert.deepEqual(routinesOn(undefined), []);
});
