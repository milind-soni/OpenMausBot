import assert from "node:assert/strict";
import test from "node:test";

import { createTwoPlaces, LOOK_EVERY_MS, parseDismissed, parseLastRead, usedBots } from "./two-places.mjs";
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

test("My Cloud is read for the card only right after the Admin said just now that it is awake: never on its older word", async () => {
  const handlers = new Map(), asked = [];
  let fresh = false;
  const main = installTwoPlacesMain({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }, guard: (_channel, handler) => handler,
    localRequest: async () => Response.json(summary("Scout")),
    fetch: async (url) => { asked.push(new URL(url).origin); return Response.json(summary("Chief")); },
    environments: () => [], cloud: () => ({ origin: "https://omb-u-1.fly.dev", asleep: false }),
    oneHome: { journal: () => null, keep: { state: () => ({ shown: true, on: true, moved: false }), set: async () => {} } },
    ownHome: { owns: () => false, offers: () => false, start: async () => {}, active: () => false, away: () => false, refresh: () => {} },
    dismissed: memory(), awakeNow: async () => fresh, tell: () => {},
  });
  try {
    await main.refresh({ force: true });
    assert.deepEqual(asked, [], "the cached awake is not enough: nothing is asked");
    fresh = true;
    await main.refresh({ force: true });
    assert.deepEqual([...new Set(asked)], ["https://omb-u-1.fly.dev"]);
  } finally { main.close(); }
});

test("main's places: My Cloud only while the person keeps this computer's bots here, a server only when it says it is theirs alone; never a team's Cloud", async () => {
  const handlers = new Map(), asked = [];
  let keep = { shown: true, on: true, moved: false }, offered = new Set(["garage"]), journal = null, active = false, together = false;
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
    dismissed: memory(), together: () => together, tell: () => {},
  });
  try {
    together = true;
    await main.refresh({ force: true });
    assert.equal(main.state().suggest?.key, "server:https://garage.example.test", "with this computer and My Cloud together, their bots already work together: My Cloud is not suggested");
    together = false;
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
    settled: () => true, quiet: () => moving, dismissed: memory(), now: () => 7_000,
  });
  await two.refresh();
  assert.deepEqual(told.garage, [{ v: 1, self: { name: "Garage server", kind: "server" },
    places: [{ name: "Work laptop", kind: "computer", bots: ["Scout"], seen: 7_000 }, { name: "My Cloud", kind: "cloud", bots: ["Chief"], seen: 7_000 }] }]);
  assert.deepEqual(told.here, [{ v: 1, self: { name: "this computer", kind: "computer" },
    places: [{ name: "My Cloud", kind: "cloud", bots: ["Chief"], seen: 7_000 }, { name: "Garage server", kind: "server", bots: ["Ledger"], seen: 7_000 }] }]);
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

// What a place is told stands until a good read says otherwise: My Cloud asleep, offline or refusing the sign-in, or this
// computer not answering, never tells anyone a place has no bots.
function laptop({ lastRead = memory(), cloud, local = async () => summary("Scout"), at = 1_000, cloudTell = true } = {}) {
  const told = { here: [], cloud: [] }, clock = { at };
  const two = createTwoPlaces({
    local, lastRead, now: () => clock.at, settled: () => true, dismissed: memory(),
    here: { name: async () => "Work laptop", tell: async (payload) => { told.here.push(payload); } },
    places: () => [{ key: "cloud:https://omb-u-1.fly.dev", name: "My Cloud", kind: "cloud", read: cloud,
      ...(cloudTell ? { tell: async (payload) => { told.cloud.push(payload); } } : {}) }],
  });
  return { two, told, clock, lastRead };
}

test("a Cloud that can't be read keeps the bots it had when last read, with when, across a restart; only a good read with no bots drops them", async () => {
  const first = laptop({ cloud: async () => summary("Ziggy") });
  await first.two.refresh();
  assert.deepEqual(first.told.here.at(-1).places, [{ name: "My Cloud", kind: "cloud", bots: ["Ziggy"], seen: 1_000 }]);
  const failures = [["asleep or offline", async () => null], ["timed out", async () => { throw new Error("timeout"); }],
    ["a sign-in page or an error, not a move summary", async () => ({ error: "sign in" })]];
  for (const [why, cloud] of failures) {
    const restarted = laptop({ lastRead: first.lastRead, cloud, at: 9_000_000 });
    await restarted.two.refresh();
    assert.deepEqual(restarted.told.here.at(-1).places, [{ name: "My Cloud", kind: "cloud", bots: ["Ziggy"], seen: 1_000 }], why);
    assert.deepEqual(restarted.two.state(), { suggest: null }, `${why}: nothing remembered suggests anything`);
  }
  const emptied = laptop({ lastRead: first.lastRead, cloud: async () => summary(), at: 9_000_000 });
  await emptied.two.refresh();
  assert.deepEqual(emptied.told.here.at(-1).places, [], "it said it has no bots: now none");
  const after = laptop({ lastRead: first.lastRead, cloud: async () => null, at: 9_500_000 });
  await after.two.refresh();
  assert.deepEqual(after.told.here.at(-1).places, [], "and that stands too");
});

test("a Cloud never read yet is told as not known, never as having no bots", async () => {
  const w = laptop({ cloud: async () => null });
  await w.two.refresh();
  assert.deepEqual(w.told.here.at(-1).places, [{ name: "My Cloud", kind: "cloud", bots: [] }]);
});

test("this computer not answering tells nobody it has no bots, and keeps what it had", async () => {
  let answer = async () => { throw new Error("no answer"); };
  const w = laptop({ cloud: async () => summary("Ziggy"), local: () => answer() });
  await w.two.refresh();
  assert.deepEqual([w.told.here.length, w.told.cloud.length], [0, 0], "never heard from it: nobody is told anything");
  answer = async () => summary("Scout");
  await w.two.refresh({ force: true });
  assert.deepEqual(w.told.cloud.at(-1).places, [{ name: "Work laptop", kind: "computer", bots: ["Scout"], seen: 1_000 }]);
  answer = async () => { throw new Error("no answer"); };
  w.clock.at = 2 * 60 * 60_000;
  await w.two.refresh({ force: true });
  assert.deepEqual(w.told.cloud.at(-1).places, [{ name: "Work laptop", kind: "computer", bots: ["Scout"], seen: 1_000 }], "what it had stands, with when");
});

test("a place is told again about once an hour though nothing changed, so what it holds says how fresh it is", async () => {
  const w = laptop({ cloud: async () => summary("Ziggy") });
  await w.two.refresh();
  w.clock.at += LOOK_EVERY_MS;
  await w.two.refresh();
  assert.equal(w.told.here.length, 1, "ten minutes on: not told again");
  w.clock.at += 60 * 60_000;
  await w.two.refresh();
  assert.equal(w.told.here.length, 2);
  assert.equal(w.told.here.at(-1).places[0].seen, w.clock.at);
});

test("a place on an older version that takes a team but not when keeps hearing the team's bots, and telling it again costs one request", async () => {
  const told = [], clock = { at: 5 };
  const two = createTwoPlaces({
    local: async () => summary("Scout"), settled: () => true, dismissed: memory(), now: () => clock.at,
    here: { name: async () => "Work laptop", tell: async () => {} },
    places: () => [
      { key: "cloud:https://omb-u-1.fly.dev", name: "My Cloud", kind: "cloud", read: async () => summary("Ziggy"), tell: async (payload) => {
        told.push(payload);
        if (payload.places.some((place) => "seen" in place || !place.bots.length)) throw Object.assign(new Error("refused"), { status: 400 });
      } },
      { key: "server:https://garage.example.test", name: "Garage server", kind: "server", read: async () => null },
      { key: "team:acme", name: "Acme", kind: "team", read: async () => summary("Sales") },
    ],
  });
  await two.refresh();
  assert.deepEqual(told.map((payload) => payload.places), [
    [{ name: "Work laptop", kind: "computer", bots: ["Scout"], seen: 5 }, { name: "Garage server", kind: "server", bots: [] }, { name: "Acme", kind: "team", bots: ["Sales"], seen: 5 }],
    [{ name: "Work laptop", kind: "computer", bots: ["Scout"] }, { name: "Acme", kind: "team", bots: ["Sales"] }],
  ]);
  clock.at += 2 * 60 * 60_000;
  await two.refresh();
  assert.equal(told.length, 3, "the hourly telling again: one request, in the shape it took");
  assert.deepEqual(told.at(-1).places, told[1].places);
});

test("main: a sleeping Cloud is never asked or told anything, and this computer still hears the bots it had", async () => {
  const asked = [], told = [];
  let asleep = false;
  const lastRead = memory();
  const install = () => installTwoPlacesMain({
    ipcMain: { handle: () => {} }, guard: (_channel, handler) => handler,
    localRequest: async (route, init) => { if (init?.method === "PUT") { told.push(JSON.parse(init.body)); return Response.json({ ok: true }); } return route.startsWith("/.well-known") ? Response.json({ label: "Work laptop" }) : Response.json(summary("Scout")); },
    fetch: async (url, init) => { asked.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`); return init?.method === "PUT" ? Response.json({ ok: true }) : Response.json(summary("Ziggy")); },
    environments: () => [], cloud: () => ({ origin: "https://omb-u-1.fly.dev", asleep }),
    oneHome: { journal: () => null, keep: { state: () => ({ shown: true, on: true, moved: false }), set: async () => {} } },
    ownHome: { owns: () => false, offers: () => false, start: async () => {}, active: () => false, away: () => false, refresh: () => {} },
    dismissed: memory(), lastRead, tell: () => {},
  });
  const awake = install();
  try { await awake.refresh({ force: true }); } finally { awake.close(); }
  assert.deepEqual(told.at(-1).places.map(({ name, bots }) => ({ name, bots })), [{ name: "My Cloud", bots: ["Ziggy"] }]);
  asleep = true;
  asked.length = 0;
  const restarted = install();
  try {
    await restarted.refresh({ force: true });
    assert.deepEqual(asked, [], "never woken");
    assert.deepEqual(told.at(-1).places.map(({ name, bots }) => ({ name, bots })), [{ name: "My Cloud", bots: ["Ziggy"] }], "not told My Cloud has no bots");
    assert.deepEqual(restarted.state(), { suggest: null }, "nor suggested while asleep");
  } finally { restarted.close(); }
  const notAnswering = installTwoPlacesMain({
    ipcMain: { handle: () => {} }, guard: (_channel, handler) => handler,
    localRequest: async () => new Response("down", { status: 503 }), fetch: async () => Response.json(summary("Ziggy")),
    environments: () => [], cloud: () => ({ origin: "https://omb-u-1.fly.dev", asleep: false }),
    oneHome: { journal: () => null, keep: { state: () => ({ shown: true, on: true, moved: false }), set: async () => {} } },
    ownHome: { owns: () => false, offers: () => false, start: async () => {}, active: () => false, away: () => false, refresh: () => {} },
    dismissed: memory(), lastRead, tell: () => {},
  });
  try { await notAnswering.refresh({ force: true }); } finally { notAnswering.close(); }
  assert.ok(!asked.includes("PUT /api/places/elsewhere"), "this computer not answering is not 'its bots moved': My Cloud is not told it has none");
});

test("a place no longer listed (signed out, its owner check lapsed) is told as last read for a week, then dropped; a Cloud at a new address replaces the old one", async () => {
  const DAY = 24 * 60 * 60_000;
  const lastRead = memory();
  const first = laptop({ lastRead, cloud: async () => summary("Ziggy") });
  await first.two.refresh();
  const unlisted = (at) => {
    const told = [];
    const two = createTwoPlaces({ local: async () => summary("Scout"), lastRead, now: () => at, settled: () => true, dismissed: memory(),
      here: { name: async () => "Work laptop", tell: async (payload) => { told.push(payload); } }, places: () => [] });
    return { two, told };
  };
  const soon = unlisted(6 * DAY);
  await soon.two.refresh();
  assert.deepEqual(soon.told.at(-1).places, [{ name: "My Cloud", kind: "cloud", bots: ["Ziggy"], seen: 1_000, away: true }], "named, and nothing is offered there");
  const late = unlisted(8 * DAY);
  await late.two.refresh();
  assert.deepEqual(late.told.at(-1).places, [], "a week on, it is no longer named");

  const moved = createTwoPlaces({ local: async () => summary("Scout"), lastRead, now: () => 2_000, settled: () => true, dismissed: memory(),
    here: { name: async () => "Work laptop", tell: async () => {} },
    places: () => [{ key: "cloud:https://new.example.test", name: "My Cloud", kind: "cloud", read: async () => summary("Ziggy", "Quill") }] });
  await moved.refresh();
  assert.deepEqual(Object.keys(parseLastRead(lastRead.read())[""]), ["cloud:https://new.example.test"], "one Cloud of their own");
  const told = [];
  const elsewhere = createTwoPlaces({ local: async () => summary("Scout"), lastRead: memory({ v: 2, accounts: { "": { "cloud:https://old.example.test": { name: "My Cloud", kind: "cloud", bots: ["Ziggy"], at: 1 } } } }),
    now: () => 2_000, settled: () => true, dismissed: memory(), here: { name: async () => "Work laptop", tell: async (payload) => { told.push(payload); } },
    places: () => [{ key: "cloud:https://new.example.test", name: "My Cloud", kind: "cloud", read: async () => null }] });
  await elsewhere.refresh();
  assert.deepEqual(told.at(-1).places, [{ name: "My Cloud", kind: "cloud", bots: [] }], "never two of My Cloud");
});

test("what was last read is read back strictly", () => {
  assert.deepEqual(parseLastRead({ v: 2, accounts: { "acct-a": {
    "cloud:https://omb-u-1.fly.dev": { name: "My Cloud", kind: "cloud", bots: ["Ziggy", 3, ""], at: 5 },
    "team:acme": { name: "Acme", kind: "team", bots: ["Sales"], at: 5 },
    "server:https://garage.example.test": { name: "Garage", kind: "server", bots: ["Ledger"], at: -1 },
    "nonsense": { name: "x", kind: "cloud", bots: [], at: 1 },
    "server:https://family.example.test": { name: "", kind: "server", bots: [], at: 1 },
  }, "bad id": {} } }), { "acct-a": { "cloud:https://omb-u-1.fly.dev": { name: "My Cloud", kind: "cloud", bots: ["Ziggy"], at: 5 } } });
  for (const junk of [null, "x", { v: 1, places: {} }, { v: 2, accounts: [] }]) assert.deepEqual(parseLastRead(junk), {});
});

test("what one account's places had is never told while another account is signed in, and is forgotten once nobody is", async () => {
  const lastRead = memory();
  let who = { id: "acct-a", signedOut: false }, cloud = "cloud:https://a.example.test", asleep = false;
  const told = { here: [], cloud: [] };
  const two = createTwoPlaces({ local: async () => summary("Scout"), lastRead, account: () => who, now: () => 1_000, settled: () => true, dismissed: memory(),
    here: { name: async () => "Work laptop", tell: async (payload) => { told.here.push(payload); } },
    places: () => (cloud ? [{ key: cloud, name: "My Cloud", kind: "cloud", read: async () => (asleep ? null : cloud.includes("a.example") ? summary("Ziggy") : summary()),
      tell: async (payload) => { told.cloud.push(payload); } }] : []) });
  await two.refresh();
  assert.deepEqual(told.here.at(-1).places.map((place) => place.bots), [["Ziggy"]]);
  // B signs in, with no Cloud; then with one that is asleep.
  who = { id: "acct-b", signedOut: false }; cloud = null;
  await two.refresh({ force: true });
  assert.deepEqual(told.here.at(-1).places, []);
  cloud = "cloud:https://b.example.test"; asleep = true;
  await two.refresh({ force: true });
  assert.deepEqual(told.here.at(-1).places, [{ name: "My Cloud", kind: "cloud", bots: [] }], "B's Cloud, not known yet: never A's bots");
  assert.ok(!JSON.stringify([...told.here.slice(1), ...told.cloud.slice(1)]).includes("Ziggy"), "nothing of A's told anywhere");
  // Back to A: A's are A's again. Then nobody is signed in: all of it is forgotten.
  who = { id: "acct-a", signedOut: false }; cloud = "cloud:https://a.example.test";
  await two.refresh({ force: true });
  assert.deepEqual(told.here.at(-1).places.map((place) => place.bots), [["Ziggy"]], "A's last read, A's Cloud asleep");
  who = { id: null, signedOut: true }; cloud = null;
  await two.refresh({ force: true });
  assert.deepEqual(parseLastRead(lastRead.read()), {});
  assert.deepEqual(told.here.at(-1).places, []);
  // While who is signed in is not known yet, nothing is read or told.
  const before = told.here.length;
  who = undefined;
  await two.refresh({ force: true });
  assert.equal(told.here.length, before);
});

test("what was last read is written only when it changed, or about once an hour for when", async () => {
  let writes = 0, bots = ["Ziggy"];
  const store = memory(), lastRead = { read: store.read, write: (value) => { writes++; store.write(value); } };
  const w = laptop({ lastRead, cloud: async () => summary(...bots) });
  await w.two.refresh();
  assert.equal(writes, 1);
  w.clock.at += LOOK_EVERY_MS;
  await w.two.refresh();
  assert.equal(writes, 1, "the same bots ten minutes on: not written");
  bots = ["Ziggy", "Quill"];
  w.clock.at += LOOK_EVERY_MS;
  await w.two.refresh();
  assert.equal(writes, 2);
  w.clock.at += 60 * 60_000;
  await w.two.refresh();
  assert.equal(writes, 3);
});

test("main: a Cloud that fell asleep after it was listed is not told", async () => {
  const asked = [];
  let asleep = false;
  const main = installTwoPlacesMain({
    ipcMain: { handle: () => {} }, guard: (_channel, handler) => handler,
    localRequest: async (route, init) => (init?.method === "PUT" ? Response.json({ ok: true }) : route.startsWith("/.well-known") ? Response.json({ label: "Work laptop" }) : Response.json(summary("Scout"))),
    fetch: async (url, init) => { asked.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`); asleep = true; return Response.json(summary("Ziggy")); },
    environments: () => [], cloud: () => ({ origin: "https://omb-u-1.fly.dev", asleep }),
    oneHome: { journal: () => null, keep: { state: () => ({ shown: true, on: false, moved: false }), set: async () => {} } },
    ownHome: { owns: () => false, offers: () => false, start: async () => {}, active: () => false, away: () => false, refresh: () => {} },
    dismissed: memory(), tell: () => {},
  });
  try { await main.refresh({ force: true }); } finally { main.close(); }
  assert.deepEqual(asked, ["GET /api/cloud-send"], "read while awake; asleep by the time it would be told");
});
