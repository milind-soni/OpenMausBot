import assert from "node:assert/strict";
import test from "node:test";

import { createTwoPlaces, LOOK_EVERY_MS, parseDismissed, usedBots } from "./two-places.mjs";
import { installTwoPlacesMain } from "./two-places-main.mjs";

const summary = (...names) => ({ v: 1, items: [...names.map((name, at) => ({ key: `bot:b${at}`, kind: "bot", label: name, parts: {} })), { key: "setting:language", kind: "setting", label: "Language", parts: {} }] });

function memory(initial = null) {
  let value = initial;
  return { read: () => value, write: (next) => { value = next; } };
}

function world({ here = ["Scout"], cloud = null, garage = ["Ledger"], settled = true } = {}) {
  const w = { here, cloud, garage, settled, at: 1_000, brought: [], reads: 0, changes: 0, dismissed: memory() };
  const place = (key, name, kind, bots) => ({ key, name, kind, read: async () => { w.reads++; return w[bots] ? summary(...w[bots]) : null; }, bring: async () => { w.brought.push(key); } });
  w.two = createTwoPlaces({
    local: async () => summary(...w.here),
    places: () => [...(w.cloud ? [place("cloud:https://omb-u-1.fly.dev", "My Cloud", "cloud", "cloud")] : []), place("server:https://garage.example.test", "Garage server", "server", "garage")],
    settled: () => w.settled, dismissed: w.dismissed, onChange: () => { w.changes++; }, now: () => w.at,
  });
  return w;
}

test("a bot counts only as a move would carry it: by name, never a place's untouched first bot", () => {
  assert.deepEqual(usedBots(summary("Scout", "Ember", "Scout")), ["Scout", "Ember"]);
  assert.deepEqual(usedBots({ v: 1, items: [{ kind: "skill", label: "Scout" }] }), []);
  assert.deepEqual(usedBots(null), []);
  assert.deepEqual([...parseDismissed({ v: 1, keys: ["server:https://garage.example.test", "nonsense", 3] })], ["server:https://garage.example.test"]);
});

test("bots here and bots on a server of the person's own: one suggestion to bring them together there, My Cloud first when both", async () => {
  const w = world();
  assert.deepEqual(w.two.state(), { suggest: null }, "nothing is known before the first look");
  await w.two.refresh();
  assert.deepEqual(w.two.state(), { suggest: { key: "server:https://garage.example.test", name: "Garage server", kind: "server" } });
  assert.equal(w.changes, 1, "this computer's page hears of it once");
  assert.deepEqual(w.two.bots(), { here: ["Scout"], places: { "server:https://garage.example.test": ["Ledger"] } });
  const both = world({ cloud: ["Chief"] });
  await both.two.refresh();
  assert.equal(both.two.state().suggest?.name, "My Cloud");
});

test("no suggestion when only one place has bots, while a move is under way, or for a place that couldn't say", async () => {
  for (const [why, setup] of [["nothing here", { here: [] }], ["nothing there", { garage: [] }], ["a move under way", { settled: false }], ["no answer there", { garage: null }]]) {
    const w = world(setup);
    await w.two.refresh();
    assert.deepEqual(w.two.state(), { suggest: null }, why);
  }
  const moving = world();
  await moving.two.refresh();
  moving.settled = false;
  assert.deepEqual(moving.two.state(), { suggest: null }, "a move started since: nothing to bring together");
  const emptied = world();
  await emptied.two.refresh();
  emptied.here = [];
  await emptied.two.refresh({ force: true });
  assert.deepEqual(emptied.two.state(), { suggest: null }, "this computer's bots were deleted since: one place again");
});

test("Not now is remembered for that place, after the app opens again too; another place may still be suggested", async () => {
  const w = world({ cloud: ["Chief"] });
  await w.two.refresh();
  assert.equal(w.two.state().suggest?.key, "cloud:https://omb-u-1.fly.dev");
  assert.deepEqual(w.two.dismiss("cloud:https://omb-u-1.fly.dev"), { suggest: { key: "server:https://garage.example.test", name: "Garage server", kind: "server" } });
  w.two.dismiss("server:https://garage.example.test");
  assert.deepEqual(w.two.state(), { suggest: null });
  const reopened = createTwoPlaces({ local: async () => summary("Scout"), settled: () => true, dismissed: w.dismissed, now: () => w.at,
    places: () => [{ key: "server:https://garage.example.test", name: "Garage server", kind: "server", read: async () => summary("Ledger"), bring: async () => {} }] });
  await reopened.refresh();
  assert.deepEqual(reopened.state(), { suggest: null }, "never asked again");
  assert.throws(() => w.two.dismiss("https://evil.example.test"), /isn't a place/u);
});

test("the one tap starts the move to the place suggested, and only to it", async () => {
  const both = world({ cloud: ["Chief"] });
  await both.two.refresh();
  await assert.rejects(both.two.accept("server:https://garage.example.test"), /can't be brought together there/u, "My Cloud is the one suggested");
  assert.deepEqual(both.brought, []);
  const w = world();
  await w.two.refresh();
  await assert.rejects(w.two.accept("cloud:https://omb-u-1.fly.dev"), /can't be brought together there/u);
  assert.deepEqual(await w.two.accept("server:https://garage.example.test"), { suggest: null });
  assert.deepEqual(w.brought, ["server:https://garage.example.test"]);
});

test("each place is read again at most every ten minutes, unless something about the places changed", async () => {
  const w = world();
  await w.two.refresh();
  await w.two.refresh();
  assert.equal(w.reads, 1);
  w.at += LOOK_EVERY_MS;
  await w.two.refresh();
  assert.equal(w.reads, 2);
  await w.two.refresh({ force: true });
  assert.equal(w.reads, 3);
});

test("main's places: My Cloud only while the person keeps this computer's bots here, a server only when it says it is theirs alone; never a team's Cloud", async () => {
  const handlers = new Map(), asked = [];
  let keep = { shown: true, on: true, moved: false }, offered = new Set(["garage"]), journal = null, active = false;
  const environments = [
    { id: "garage", kind: "remote", name: "Garage server", origin: "https://garage.example.test" },
    { id: "family", kind: "remote", name: "Family server", origin: "https://family.example.test" },
    { id: "acme", kind: "remote", name: "Acme", origin: "https://omb-t-acme.fly.dev", team: { id: "t-acme", role: "owner" } },
  ];
  const main = installTwoPlacesMain({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }, guard: (_channel, handler) => handler,
    localRequest: async () => Response.json(summary("Scout")),
    fetch: async (url) => { asked.push(new URL(url).origin); return Response.json(summary("Chief")); },
    environments: () => environments, cloud: () => ({ origin: "https://omb-u-1.fly.dev", asleep: false }),
    oneHome: { journal: () => journal, keep: { state: () => keep, set: async (on) => { keep = { ...keep, on }; } } },
    ownHome: { owns: (place) => offered.has(place.id), offers: (place) => offered.has(place.id), start: async (id) => { active = true; asked.push(`start:${id}`); }, active: () => active,
      away: () => false, refresh: () => {} },
    dismissed: memory(), tell: () => {},
  });
  try {
    await main.refresh({ force: true });
    assert.deepEqual(await handlers.get("two-places:state")({}), { suggest: { key: "cloud:https://omb-u-1.fly.dev", name: "My Cloud", kind: "cloud" } });
    assert.deepEqual([...new Set(asked)].sort(), ["https://garage.example.test", "https://omb-u-1.fly.dev"], "never the team's Cloud or a server others use");
    await handlers.get("two-places:accept")({}, "cloud:https://omb-u-1.fly.dev");
    assert.equal(keep.on, false, "the one tap lets this computer's bots move to My Cloud, as anyone's first move");
    await main.refresh({ force: true });
    assert.equal(main.state().suggest?.key, "server:https://garage.example.test");
    journal = { v: 1, phase: "copy", cloud: { origin: "https://omb-u-1.fly.dev", account: "acct" } };
    assert.deepEqual(main.state(), { suggest: null }, "nothing while a move is under way");
    journal = null;
    offered = new Set();
    assert.deepEqual(main.state(), { suggest: null }, "a server that stopped saying it is theirs alone is never suggested");
  } finally { main.close(); }
});

test("each place of the person's own hears which bots their other places have, names only, and again only once that changed", async () => {
  const told = { here: [], cloud: [], garage: [] };
  let mine = ["Scout"], ledger = ["Ledger"], moving = false, failing = false;
  const place = (key, name, kind, bots, to) => ({ key, name, kind, read: async () => summary(...bots()),
    tell: async (payload) => { if (failing && to === "garage") throw new Error("Garage server did not answer"); told[to].push(payload); } });
  const two = createTwoPlaces({
    local: async () => (mine === null ? null : summary(...mine)),
    here: { name: async () => "Work laptop", tell: async (payload) => { told.here.push(payload); } },
    places: () => [place("cloud:https://omb-u-1.fly.dev", "My Cloud", "cloud", () => ["Chief"], "cloud"), place("server:https://garage.example.test", "Garage server", "server", () => ledger, "garage")],
    settled: () => true, quiet: () => moving, dismissed: memory(),
  });
  await two.refresh();
  assert.deepEqual(told.garage, [{ v: 1, self: { name: "Garage server", kind: "server" },
    places: [{ name: "Work laptop", kind: "computer", bots: ["Scout"] }, { name: "My Cloud", kind: "cloud", bots: ["Chief"] }] }]);
  assert.deepEqual(told.here, [{ v: 1, self: { name: "this computer", kind: "computer" },
    places: [{ name: "My Cloud", kind: "cloud", bots: ["Chief"] }, { name: "Garage server", kind: "server", bots: ["Ledger"] }] }]);
  assert.equal(told.cloud.length, 1);
  assert.ok(!/https?:|bot:/u.test(JSON.stringify(told)), "never an address or an id");
  await two.refresh({ force: true });
  assert.deepEqual([told.here.length, told.cloud.length, told.garage.length], [1, 1, 1], "nothing changed: nobody is told again");

  ledger = ["Ledger", "Quill"];
  await two.refresh({ force: true });
  assert.deepEqual([told.here.length, told.cloud.length, told.garage.length], [2, 2, 1], "Garage server's own bots changed: only the others hear of it");

  failing = true;
  mine = ["Scout", "Ember"];
  await two.refresh({ force: true });
  assert.equal(told.garage.length, 1, "Garage server didn't answer");
  failing = false;
  await two.refresh({ force: true });
  assert.equal(told.garage.length, 2, "so it is told on the next look");

  moving = true;
  mine = ["Scout", "Ember", "Echo"];
  await two.refresh({ force: true });
  assert.deepEqual([told.here.length, told.cloud.length, told.garage.length], [2, 3, 2], "nothing is read or told while a move is under way");
  moving = false;
  mine = null;
  ledger = ["Ledger", "Quill", "Ink"];
  await two.refresh({ force: true });
  assert.equal(told.here.length, 2, "this computer's bots moved: it is told nothing more, whatever changed elsewhere");
  assert.deepEqual(told.garage.at(-1).places.map((entry) => entry.name), ["My Cloud"], "and the others no longer hear of bots on it");
});
