import assert from "node:assert/strict";
import test from "node:test";

import { botNames, parseRemembered, teamPlaces } from "./team-places.mjs";
import { createTwoPlaces, usedBots } from "./two-places.mjs";
import { installTwoPlacesMain } from "./two-places-main.mjs";

function memory(initial = null) {
  let value = initial;
  return { read: () => { if (value === null) throw new Error("no file"); return value; }, write: (next) => { value = next; } };
}
const ACME = { id: "team-acme", name: "Acme", role: "member", machine: { status: "ready", origin: "https://omb-t-acme.fly.dev" } };
const GLOBEX = { id: "team-globex", name: "Globex", role: "admin", machine: null };

function world({ teams = [ACME, GLOBEX], answers = {}, remembered = memory() } = {}) {
  const w = { fetched: [], remembered };
  const fetchImpl = async (url, init) => {
    w.fetched.push({ url, init });
    const answer = answers[new URL(url).origin];
    if (!answer) return { ok: false, status: 401, body: { cancel: async () => {} } };
    return { ok: true, status: 200, json: async () => answer };
  };
  w.places = teamPlaces({ account: () => ({ state: () => ({ status: "connected", teams }) }), fetch: fetchImpl, remembered });
  return w;
}

test("a team's bots are read over the window's own sign-in there, by name only, and remembered for when the team is not open", async () => {
  const w = world({ answers: { "https://omb-t-acme.fly.dev": { bots: [{ id: "b1", name: "Sales" }, { id: "b2", name: " Support " }, { id: "b3", name: "Hidden", hidden: true }, { id: "b4" }] } } });
  const places = w.places();
  assert.deepEqual(places.map((place) => [place.key, place.name, place.kind]), [["team:team-acme", "Acme", "team"], ["team:team-globex", "Globex", "team"]]);
  assert.equal(places[0].tell, undefined);
  assert.equal(places[0].bring, undefined);
  assert.deepEqual(usedBots(await places[0].read()), ["Sales", "Support"]);
  assert.equal(w.fetched[0].init.credentials, "include");
  assert.equal(w.fetched[0].init.headers.origin, "https://omb-t-acme.fly.dev");
  assert.deepEqual(parseRemembered(w.remembered.read()), { "team-acme": { name: "Acme", bots: ["Sales", "Support"] } });
  // Globex has no machine and nothing remembered: it says nothing.
  assert.equal(await places[1].read(), null);
  // Signed out of Acme now: what it had is still said.
  const later = world({ answers: {}, remembered: w.remembered });
  assert.deepEqual(usedBots(await later.places()[0].read()), ["Sales", "Support"]);
});

test("a team is a place the person's own places hear about, never one that is told or suggested", async () => {
  const told = [];
  const summary = (...names) => ({ v: 1, items: names.map((name, at) => ({ key: `bot:${at}`, kind: "bot", label: name, parts: {} })) });
  const two = createTwoPlaces({
    local: async () => summary("Chief"),
    here: { name: async () => "Work laptop", tell: async (payload) => { told.push(["here", payload]); } },
    places: () => [
      { key: "cloud:https://omb-u-1.fly.dev", name: "My Cloud", kind: "cloud", read: async () => summary("Scout"), tell: async (payload) => { told.push(["cloud", payload]); } },
      { key: "team:team-acme", name: "Acme", kind: "team", read: async () => summary("Sales") },
    ],
    settled: () => true, dismissed: { read: () => null, write() {} },
  });
  await two.refresh({ force: true });
  assert.deepEqual(told.map(([who]) => who), ["here", "cloud"]);
  const toCloud = told.find(([who]) => who === "cloud")[1];
  assert.deepEqual(toCloud.places.find((place) => place.kind === "team"), { name: "Acme", kind: "team", bots: ["Sales"] });
  assert.deepEqual(two.state(), { suggest: null });
});

test("a place on an older version, which refuses a team, still hears about the person's own places; at most twenty are told", async () => {
  const summary = (...names) => ({ v: 1, items: names.map((name, at) => ({ key: `bot:${at}`, kind: "bot", label: name, parts: {} })) });
  const told = [];
  const two = createTwoPlaces({
    local: async () => null,
    places: () => [
      { key: "cloud:https://omb-u-1.fly.dev", name: "My Cloud", kind: "cloud", read: async () => summary("Scout"), tell: async (payload) => {
        told.push(payload);
        if (payload.places.some((place) => place.kind === "team")) throw Object.assign(new Error("refused"), { status: 400 });
      } },
      { key: "server:https://garage.example.test", name: "Garage", kind: "server", read: async () => summary("Ledger") },
      ...Array.from({ length: 25 }, (_, at) => ({ key: `team:t${at}`, name: `Team ${at}`, kind: "team", read: async () => summary("Sales") })),
    ],
    settled: () => true, dismissed: { read: () => null, write() {} },
  });
  await two.refresh({ force: true });
  assert.equal(told[0].places.length, 20);
  assert.deepEqual(told[1].places.map((place) => place.name), ["Garage"]);
  await two.refresh({ force: true });
  assert.equal(told.length, 2, "told once for what it was sent, not again every look");
});

test("main reads the teams the verified session lists and tells them nothing; a team the person left is no longer named", async () => {
  const summary = { v: 1, items: [{ key: "bot:b0", kind: "bot", label: "Scout", parts: {} }] };
  const calls = [], told = [];
  let teams = [ACME];
  const main = installTwoPlacesMain({
    ipcMain: { handle: () => {} }, guard: (_channel, handler) => handler,
    localRequest: async (route, init) => { if (init?.method === "PUT") { told.push(JSON.parse(init.body)); return Response.json({ ok: true }); } return Response.json(summary); },
    fetch: async (url, init) => { calls.push(`${init?.method ?? "GET"} ${url}`); return Response.json({ bots: [{ name: "Sales" }] }); },
    environments: () => [], cloud: () => ({ origin: null, asleep: false }),
    oneHome: { journal: () => null, keep: { state: () => ({ shown: false, on: false, moved: false }), set: async () => {} } },
    ownHome: { owns: () => false, offers: () => false, start: async () => {}, active: () => false, away: () => false, refresh: () => {} },
    dismissed: memory(), account: () => ({ state: () => ({ status: "connected", teams }) }), teamsRemembered: memory(), tell: () => {},
  });
  try {
    await main.refresh({ force: true });
    assert.deepEqual(calls, ["GET https://omb-t-acme.fly.dev/api/bots?messages=0"]);
    assert.deepEqual(told.at(-1).places, [{ name: "Acme", kind: "team", bots: ["Sales"] }]);
    assert.equal(main.state().suggest, null);
    teams = [];
    await main.refresh({ force: true });
    assert.deepEqual(told.at(-1).places, []);
  } finally { main.close(); }
});

test("remembered names are read back strictly", () => {
  assert.deepEqual(parseRemembered({ v: 1, teams: { "team-acme": { name: "Acme", bots: ["Sales", 3, ""] }, "bad id!": { name: "x", bots: [] }, "team-x": { name: 1, bots: [] } } }), { "team-acme": { name: "Acme", bots: ["Sales"] } });
  assert.deepEqual(parseRemembered(null), {});
  assert.deepEqual(botNames({ bots: [{ name: "A" }, { name: "A" }, { name: "B", hidden: true }] }), ["A"]);
  assert.deepEqual(botNames("nope"), []);
});
