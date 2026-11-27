// Moving this computer's bots into the person's team: which place a bot comes from, the bots that stay, several moved one
// after another (one failing while the rest go on, and going on after the app quits), a routine never on in two places,
// and nothing of the bot changed on this computer until the team has said it arrived.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { computerStays, installTeamMove, teamMoveConfirmWords } from "./team-move-main.mjs";
import { createTeamMove, RETRY_MS } from "./team-move.mjs";

const ACME = { id: "team-acme", name: "Acme", origin: "https://acme.example.test" };
const BOTS = ["scout", "quill", "wren"].map((id) => ({ id: `${id}-bot-1`, name: id[0].toUpperCase() + id.slice(1) }));
const reply = (status, body = {}) => ({ ok: status < 400, status, body });

/** Several bots of this computer moving into Acme with fakes on every side: per bot, this computer's hold and line, its
 * routine's switch here and there, and the team's begin and done; `fail` says which step of which bot fails, and how often. */
function world({ fail = {} } = {}) {
  let journal = null, clock = 1_000_000;
  const timers = [];
  const routine = Object.fromEntries(BOTS.map((bot) => [bot.id, { here: true, there: null, removedHere: false }]));
  const w = {
    calls: [], routine, samples: [],
    get journal() { return journal; },
    advance(ms) { clock += ms; },
    async tick() { const due = timers.splice(0); for (const timer of due) timer.work(); await w.moves.kick(); },
    sample(id) { w.samples.push({ id, here: routine[id].here && !routine[id].removedHere, there: routine[id].there === true }); },
    make() {
      return createTeamMove({
        journal: { read: () => structuredClone(journal), write: (value) => { w.beforeWrite?.(value); journal = structuredClone(value); } },
        inTeam: () => true,
        now: () => clock,
        timers: { set: (work, ms) => { const timer = { work, ms }; timers.push(timer); return timer; }, clear: (timer) => { const at = timers.indexOf(timer); if (at >= 0) timers.splice(at, 1); } },
        open: (move) => {
          const id = move.bot.id, step = (name) => { w.calls.push(`${id} ${name}`); w.sample(id); const left = fail[`${id} ${name}`]; if (left > 0) { fail[`${id} ${name}`] = left - 1; return true; } return false; };
          return {
            engine: {
              async move(options) {
                if (step(options?.final ? "final" : "copy")) throw new Error("no network");
                // The routine arrives in the team switched off.
                routine[id].there ??= false;
              },
              async check() { return { ok: !step("check") }; },
            },
            myCloud: {
              async call(method, route, body) {
                if (method === "DELETE") { step("thaw"); routine[id].here = true; return reply(200, { released: true }); }
                if (body?.state === "moving") {
                  if (step("hold")) return reply(500, { error: "busy disk" });
                  const held = routine[id].here ? ["routine:r1"] : [];
                  routine[id].here = false;
                  return reply(200, { movedTo: { team: ACME, state: "moving", held } });
                }
                if (body?.state === "moved") {
                  if (step("moved")) return reply(500, { error: "disk" });
                  routine[id].removedHere = true;
                  return reply(200, { movedTo: { team: ACME, state: "moved" } });
                }
                return reply(404, {});
              },
            },
            team: {
              async begin() { if (step("begin")) throw new Error("the team did not answer"); return { name: move.bot.name }; },
              async done(on) { if (step("done")) throw new Error("the team did not switch"); if (on.includes("routine:r1")) routine[id].there = true; w.sample(id); },
            },
            close: async () => {},
          };
        },
      });
    },
  };
  w.moves = w.make();
  w.relaunch = () => { w.moves.close(); w.moves = w.make(); };
  return w;
}
const phaseOf = (w, id) => w.journal?.moves?.find((move) => move.bot.id === id)?.phase;
const startAll = (w) => w.moves.startMany(BOTS.map((bot) => ({ bot, team: ACME, from: "computer" })));
const neverTwice = (w) => assert.equal(w.samples.some((sample) => sample.here && sample.there), false, JSON.stringify(w.samples));

test("several bots move one after another; one that fails waits for its next try while the others go on, and each one's result is told", async () => {
  const w = world({ fail: { "quill-bot-1 begin": 1 } });
  await startAll(w);
  assert.deepEqual(BOTS.map((bot) => phaseOf(w, bot.id)), ["done", "copy", "done"]);
  assert.deepEqual(w.journal.moves.map((move) => move.from), ["computer", "computer", "computer"]);
  assert.equal(w.calls.filter((call) => call.startsWith("quill-bot-1")).join(), "quill-bot-1 begin", "nothing of Quill was held here");
  assert.deepEqual(w.moves.view("computer"), { bot: { id: "wren-bot-1", name: "Wren" }, team: { id: ACME.id, name: ACME.name }, phase: "failed", from: "computer",
    batch: [{ id: "scout-bot-1", name: "Scout", phase: "done" }, { id: "quill-bot-1", name: "Quill", phase: "failed" }, { id: "wren-bot-1", name: "Wren", phase: "done" }] });
  assert.equal(w.moves.view("cloud"), null, "My Cloud's page shows no move of this computer's");
  w.advance(RETRY_MS[0]);
  await w.tick();
  assert.equal(phaseOf(w, "quill-bot-1"), "done");
  assert.equal(w.moves.view("computer").phase, "done");
  neverTwice(w);
});

test("the app quit half-way through several goes on from the journal: the bot it held goes on, the next ones follow, none moves twice", async () => {
  const w = world();
  w.beforeWrite = (value) => { if (value.moves.some((move) => move.bot.id === "quill-bot-1" && move.phase === "check")) throw new Error("the app was killed"); };
  await startAll(w);
  w.beforeWrite = null;
  assert.deepEqual(BOTS.map((bot) => phaseOf(w, bot.id)), ["done", "final", "copy"]);
  w.relaunch();
  await w.moves.kick();
  assert.deepEqual(BOTS.map((bot) => phaseOf(w, bot.id)), ["done", "done", "done"]);
  for (const bot of BOTS) assert.equal(w.calls.filter((call) => call === `${bot.id} moved`).length, 1, bot.name);
  assert.equal(w.calls.filter((call) => call === "scout-bot-1 begin").length, 1, "Scout, done before the quit, is not moved again");
  neverTwice(w);
});

test("a routine is never on in two places: off here while held, on there only after the check, and on here again if the move stops before", async () => {
  const w = world({ fail: { "scout-bot-1 check": 3, "quill-bot-1 done": 1 } });
  await startAll(w);
  // Scout's check kept finding something missing: it goes on here with its routine on, and is off in the team.
  assert.equal(phaseOf(w, "scout-bot-1"), "copy");
  assert.deepEqual(w.routine["scout-bot-1"], { here: true, there: false, removedHere: false });
  // Quill's switch failed after the check: from there it only goes forward, its routine off in both places meanwhile.
  assert.equal(phaseOf(w, "quill-bot-1"), "switch");
  assert.deepEqual(w.routine["quill-bot-1"], { here: false, there: false, removedHere: false });
  w.advance(RETRY_MS.at(-1));
  await w.tick();
  await w.tick();
  assert.deepEqual(BOTS.map((bot) => phaseOf(w, bot.id)), ["done", "done", "done"]);
  for (const bot of BOTS) assert.deepEqual(w.routine[bot.id], { here: false, there: true, removedHere: true }, bot.name);
  neverTwice(w);
});

test("nothing of a bot is changed for good on this computer until the team has checked it arrived and switched it on", async () => {
  const w = world({ fail: { "scout-bot-1 check": 3, "quill-bot-1 done": 1 } });
  await startAll(w);
  const scout = w.calls.filter((call) => call.startsWith("scout-bot-1"));
  assert.equal(scout.includes("scout-bot-1 moved"), false, "a check that never passed keeps Scout here");
  assert.equal(scout.at(-1), "scout-bot-1 thaw", "and lets it go on here");
  assert.equal(w.calls.includes("quill-bot-1 moved"), false, "a switch the team refused keeps Quill's line as it was");
  const wren = w.calls.filter((call) => call.startsWith("wren-bot-1"));
  assert.deepEqual(wren, ["wren-bot-1 begin", "wren-bot-1 copy", "wren-bot-1 hold", "wren-bot-1 final", "wren-bot-1 check", "wren-bot-1 done", "wren-bot-1 moved"], "switched on there before kept as the line here");
});

test("a bot moving from one place is not started again from the other, and moves done and closed make room for a batch", async () => {
  const w = world({ fail: { "scout-bot-1 begin": 1 } });
  await w.moves.start({ bot: BOTS[0], team: ACME, from: "computer" });
  assert.throws(() => w.moves.start({ bot: BOTS[0], team: ACME }), /Scout is moving to Acme/);
  const journal = { value: { v: 1, moves: Array.from({ length: 48 }, (_, i) => ({ bot: { id: `old-bot-${i}`, name: `Old ${i}` }, team: ACME, phase: "done", told: true, startedAt: 1 })) } };
  const moves = createTeamMove({ journal: { read: () => structuredClone(journal.value), write: (value) => { journal.value = structuredClone(value); } }, inTeam: () => true,
    open: () => ({ engine: { move: async () => {}, check: async () => ({ ok: true }) }, myCloud: { call: async () => reply(500, {}) }, team: { begin: async () => { throw new Error("offline"); }, done: async () => {} }, close: async () => {} }),
    timers: { set: () => null, clear: () => {} } });
  await moves.startMany(BOTS.map((bot) => ({ bot, team: ACME, from: "computer" })));
  assert.deepEqual(journal.value.moves.map((move) => move.bot.id), BOTS.map((bot) => bot.id), "the closed moves were dropped, the batch kept whole");
  moves.close();
});

/** Main's channels with this computer's own server faked: its bots, what each request asked, and the team's answers. */
function main({ bots = [{ id: "maus-bot-1", name: "MausBot", defaultBot: true }, { id: "luna-bot-1", name: "Luna", chiefOfStaff: true }, ...BOTS], available = true, member = true, agrees = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "omb-team-computer-"));
  const handlers = new Map(), here = [], away = [], asked = [];
  const journal = { value: null, read() { return this.value; }, write(next) { this.value = next; } };
  const json = (status, body) => new Response(JSON.stringify(body), { status });
  const move = installTeamMove({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    cloudPage: (event) => event.page ?? null,
    pageOrigin: (event) => event.origin ?? null,
    confirmMove: async (words) => { asked.push(words); return agrees; },
    home: () => ({ origin: "https://home.example.test", grant: async () => { away.push("My Cloud's code"); return { origin: "https://home.example.test", code: "C" }; } }),
    computer: {
      available: () => available,
      request: async (route, init = {}) => {
        here.push(`${init.method ?? "GET"} ${route}`);
        if (route === "/api/bots?messages=0") return json(200, { bots });
        if (route === "/api/config") return json(200, { profile: { name: "Olive" } });
        return json(404, {});
      },
    },
    account: () => ({ state: () => ({ status: "connected", teams: [{ id: ACME.id, name: ACME.name, machine: { origin: ACME.origin, status: "ready" } }] }), pairTeam: async () => ({ origin: ACME.origin, code: "T" }) }),
    file: () => join(dir, "send.json"), journalFile: () => join(dir, "moves.json"), journal,
    fetch: async (url, init) => {
      away.push(`${init?.method ?? "GET"} ${String(url)}`);
      if (String(url) === `${ACME.origin}/api/auth/pair`) return json(200, { token: "omb_sess_member" });
      if (String(url) === `${ACME.origin}/api/team-move-in`) return member ? json(503, { error: "Acme is restarting." }) : json(403, { error: "Only someone in Acme can move a bot in." });
      return json(200, {});
    },
  });
  const settle = async () => { await move.kick(); };
  return { handlers, here, away, asked, journal, move, settle, call: (channel, event, ...args) => handlers.get(channel)(event, ...args), done: () => { move.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const LOCAL = { page: "local" }, CLOUD = { page: "cloud" }, OWN = { origin: ACME.origin };

test("source selection: this computer's page moves this computer's bots, read from its own server, never signing in to My Cloud; My Cloud's page moves My Cloud's", async () => {
  const m = main();
  try {
    assert.deepEqual(await m.call("cloud-send:teams", LOCAL), { teams: [{ id: ACME.id, name: ACME.name, ready: true }], from: "computer" });
    assert.deepEqual(await m.call("cloud-send:teams", CLOUD), { teams: [{ id: ACME.id, name: ACME.name, ready: true }], from: "cloud" });
    assert.deepEqual(await m.call("cloud-send:teams", {}), { teams: [] });
    await m.call("cloud-send:team-move-coded", LOCAL, "scout-bot-1", ACME.id, "Scout");
    await m.settle();
    assert.equal(m.journal.value.moves[0].from, "computer");
    assert.deepEqual(m.here.slice(0, 2), ["GET /api/bots?messages=0", "GET /api/config"]);
    assert.equal(m.away.includes("My Cloud's code"), false, "My Cloud is never asked for a code");
    assert.equal(m.away.some((call) => call.includes("home.example.test")), false);
    assert.ok(m.away.includes(`POST ${ACME.origin}/api/team-move-in`), "the team's move-in sign-in, as from My Cloud");
    assert.equal(m.here.some((call) => call.includes("/api/bot-moves/")), false, "the team not answering holds nothing here");
    await m.call("cloud-send:team-move-coded", CLOUD, "atlas-bot-1", ACME.id, "Atlas");
    assert.equal(m.journal.value.moves.find((entry) => entry.bot.id === "atlas-bot-1").from, undefined, "My Cloud's page: a bot of My Cloud's");
    assert.equal(computerStays([{ id: "a" }, { id: "b" }], "a", null), null);
  } finally { m.done(); }
});

test("refusals: MausBot, the Chief of Staff and the last bot stay; a team the person isn't in, another team's page, and the team turning away a non-member move nothing", async () => {
  const m = main();
  try {
    const listed = await m.call("cloud-send:team-choices", LOCAL);
    assert.deepEqual(listed.bots.map((bot) => [bot.name, bot.stays ?? null]), [["MausBot", "default"], ["Luna", "chief"], ["Scout", null], ["Quill", null], ["Wren", null]]);
    assert.deepEqual(await m.call("cloud-send:team-move-many", LOCAL, ["maus-bot-1", "luna-bot-1"], ACME.id), { refused: { code: "notABot", params: {}, message: "Choose one of your bots to move." } });
    assert.deepEqual(await m.call("cloud-send:team-move-many", LOCAL, ["scout-bot-1"], "team-beta"), { refused: { code: "notInTeam", params: {}, message: "You're not in that team." } });
    assert.equal(m.journal.value, null, "nothing started");
    // Asked by id anyway (an older page, say), main reads this computer's own list and stops before anything changes.
    for (const [id, why] of [["maus-bot-1", "default"], ["luna-bot-1", "chief"]]) {
      await m.call("cloud-send:team-move-coded", LOCAL, id, ACME.id, "x");
      await m.settle();
      assert.deepEqual((({ stopped, why: said }) => ({ stopped, why: said }))(m.journal.value.moves.find((entry) => entry.bot.id === id)), { stopped: true, why }, id);
    }
    assert.equal(m.here.some((call) => call.includes("/api/bot-moves/")), false, "nothing was held here");
    assert.equal(m.away.some((call) => call.endsWith("/api/team-move-in")), false, "nor asked of the team");
    // Another team's page, or a page that isn't the window's, learns nothing and moves nothing.
    assert.deepEqual(await m.call("cloud-send:team-bring", { origin: "https://beta.example.test" }), { bots: [] });
    await assert.rejects(m.call("cloud-send:team-bring-many", { origin: "https://beta.example.test" }, ["scout-bot-1"]), /Open the team/);
    assert.deepEqual(m.asked, []);
  } finally { m.done(); }
  const last = main({ bots: [{ id: "maus-bot-1", name: "MausBot", defaultBot: true, hidden: true }, BOTS[0]] });
  try {
    assert.deepEqual((await last.call("cloud-send:team-choices", LOCAL)).bots.map((bot) => bot.stays ?? null), ["last"]);
    await last.call("cloud-send:team-move-coded", LOCAL, "scout-bot-1", ACME.id, "Scout");
    await last.settle();
    assert.equal(last.journal.value.moves[0].why, "last", "the last bot this computer shows stays");
  } finally { last.done(); }
  const stranger = main({ member: false });
  try {
    await stranger.call("cloud-send:team-move-coded", LOCAL, "scout-bot-1", ACME.id, "Scout");
    await stranger.settle();
    assert.deepEqual((({ phase, failing }) => ({ phase, failing }))(stranger.journal.value.moves[0]), { phase: "copy", failing: true });
    assert.match(stranger.journal.value.moves[0].error, /Only someone in Acme/);
    assert.equal(stranger.here.some((call) => call.includes("/api/bot-moves/")), false, "the team turning the person away holds nothing here");
  } finally { stranger.done(); }
});

test("while this computer's bots move to My Cloud, none is offered to a team", async () => {
  const m = main({ available: false });
  try {
    assert.deepEqual(await m.call("cloud-send:teams", LOCAL), { teams: [] });
    assert.deepEqual((await m.call("cloud-send:team-move-coded", LOCAL, "scout-bot-1", ACME.id, "Scout")).refused.code, "computerMoving");
    assert.deepEqual(await m.call("cloud-send:team-choices", LOCAL), { bots: [] });
    assert.deepEqual((await m.call("cloud-send:team-bring", OWN)).computer, undefined);
  } finally { m.done(); }
});

test("a team's own page moves several of this computer's bots after one confirm in main's words that names them", async () => {
  const m = main();
  try {
    const listed = await m.call("cloud-send:team-bring", OWN);
    assert.deepEqual(listed.computer.filter((bot) => !bot.stays).map((bot) => bot.id), BOTS.map((bot) => bot.id));
    const started = await m.call("cloud-send:team-bring-many", OWN, ["wren-bot-1", "maus-bot-1", "scout-bot-1"]);
    assert.equal(started.started, true);
    assert.deepEqual(m.journal.value.moves.map((entry) => [entry.bot.id, entry.from]), [["wren-bot-1", "computer"], ["scout-bot-1", "computer"]]);
    assert.equal(m.asked.length, 1);
    assert.deepEqual(m.asked[0], teamMoveConfirmWords({ bot: "Wren", team: "Acme" }, undefined, { from: "computer", bots: ["Wren", "Scout"] }));
    assert.match(m.asked[0].detail, /^Wren, Scout\n\n/u);
    assert.match(m.asked[0].detail, /Stays on this computer: what they remember/u);
    assert.match(m.asked[0].message, /Move 2 bots to Acme\?/u);
  } finally { m.done(); }
  const no = main({ agrees: false });
  try {
    assert.equal((await no.call("cloud-send:team-bring-many", OWN, ["scout-bot-1"])).started, false);
    assert.equal(no.journal.value, null, "a cancel moves nothing");
  } finally { no.done(); }
});

test("a bot held for another move here (on its way to My Cloud) is not let go of by a team move that was refused its hold", async () => {
  const calls = [];
  let journal = null;
  const moves = createTeamMove({
    journal: { read: () => structuredClone(journal), write: (value) => { journal = structuredClone(value); } }, inTeam: () => true,
    timers: { set: () => null, clear: () => {} },
    open: () => ({
      engine: { move: async () => {}, check: async () => ({ ok: true }) },
      myCloud: { call: async (method, route, body) => { calls.push(`${method} ${body?.state ?? ""}`.trim()); return method === "POST" ? reply(409, { error: "Scout is moving to My Cloud. It's ready there in a moment." }) : reply(200, { released: true }); } },
      team: { begin: async () => ({ name: "Scout" }), done: async () => {} }, close: async () => {},
    }),
  });
  await moves.start({ bot: BOTS[0], team: ACME, from: "computer" });
  assert.deepEqual(calls, ["POST moving"], "no DELETE: the other move's hold stays");
  assert.deepEqual((({ phase, failing }) => ({ phase, failing }))(journal.moves[0]), { phase: "copy", failing: true });
  moves.close();
});

test("a bot on its way to My Cloud by itself is not offered to a team, and stops before anything changes if asked by id", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-team-computer-"));
  const handlers = new Map(), here = [];
  const journal = { value: null, read() { return this.value; }, write(next) { this.value = next; } };
  const move = installTeamMove({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }, cloudPage: (event) => event.page ?? null, home: () => null,
    computer: { available: () => true, busy: (id) => id === "quill-bot-1", request: async (route) => { here.push(route); return new Response(JSON.stringify(route === "/api/bots?messages=0" ? { bots: BOTS } : {}), { status: 200 }); } },
    account: () => ({ state: () => ({ status: "connected", teams: [{ id: ACME.id, name: ACME.name, machine: { origin: ACME.origin, status: "ready" } }] }), pairTeam: async () => { throw new Error("offline"); } }),
    file: () => join(dir, "send.json"), journalFile: () => join(dir, "moves.json"), journal,
  });
  try {
    assert.deepEqual((await handlers.get("cloud-send:team-choices")(LOCAL)).bots.map((bot) => bot.id), ["scout-bot-1", "wren-bot-1"]);
    await handlers.get("cloud-send:team-move-coded")(LOCAL, "quill-bot-1", ACME.id, "Quill");
    await move.kick();
    assert.deepEqual((({ stopped, why }) => ({ stopped, why }))(journal.value.moves[0]), { stopped: true, why: "elsewhere" });
    assert.equal(move.moving("quill-bot-1"), false, "a stopped move holds no bot");
    await handlers.get("cloud-send:team-move-coded")(LOCAL, "scout-bot-1", ACME.id, "Scout");
    assert.equal(move.moving("scout-bot-1"), true, "My Cloud's move is told this one is taken");
  } finally { move.close(); rmSync(dir, { recursive: true, force: true }); }
});
