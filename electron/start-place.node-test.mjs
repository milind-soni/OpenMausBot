import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { jsonFile } from "./desktop-prefs.mjs";
import { createHomePlaces } from "./home-places.mjs";
import { reopenSavedServer } from "./saved-server.mjs";
import { world } from "./fixtures/home-window-world.mjs";

import { openStartPlace } from "./start-place.mjs";

/** A launch: the home window's word on each place (`opens`), the workspaces that open (`workspaces`), the servers that answer. */
function launch({ remembered = null, kind = "cloud", opens = {}, workspaces = ["default", "work"], servers = [], profiles = true } = {}) {
  const w = { remembered, steps: [], forgot: 0 };
  const args = {
    home: {
      refresh: async () => { w.steps.push("refresh"); return { kind }; },
      show: async () => { w.steps.push("show"); },
      opensNow: (ask) => { const key = ask === "cloud" ? "cloud" : ask.team ?? ask.cloud; return key in opens ? opens[key] : true; },
    },
    places: { remembered: () => w.remembered, remember: (place) => { w.remembered = place; w.forgot++; } },
    profiles: profiles ? { open: async (id) => { w.steps.push(`profile:${id}`); return workspaces.includes(id); } } : null,
    server: async (id) => { w.steps.push(`server:${id}`); if (id === "throws") throw new Error("boom"); return servers.includes(id); },
  };
  w.run = () => openStartPlace(args);
  return w;
}

test("a launch reopens the place open when the app closed: This Mac, a named workspace, a server, a team or another Cloud", async () => {
  for (const [remembered, step] of [[{ profile: "default" }, "profile:default"], [{ profile: "work" }, "profile:work"], [{ server: "env-1" }, "server:env-1"]]) {
    const w = launch({ remembered, servers: ["env-1"] });
    assert.equal(await w.run(), "remembered", step);
    assert.deepEqual(w.steps, ["refresh", step], "nothing else opens first");
    assert.equal(w.forgot, 0);
  }
  for (const remembered of [{ team: "team-acme" }, { cloud: "c-b" }]) {
    const w = launch({ remembered });
    assert.equal(await w.run(), "remembered");
    assert.deepEqual(w.steps, ["refresh", "show"], "the window opens the remembered Cloud itself");
  }
  const none = launch();
  assert.equal(await none.run(), "home");
  assert.deepEqual(none.steps, ["refresh", "show"]);
});

test("one that can't open now falls back to My Cloud and is forgotten: a removed workspace, a server that doesn't answer, an ended Cloud", async () => {
  for (const [remembered, extra] of [[{ profile: "gone" }, {}], [{ server: "env-9" }, {}], [{ server: "throws" }, {}], [{ cloud: "c-ended" }, { opens: { "c-ended": false } }], [{ team: "team-x" }, { opens: { "team-x": false } }]]) {
    const w = launch({ remembered, ...extra });
    assert.equal(await w.run(), "cloud", JSON.stringify(remembered));
    assert.equal(w.steps.at(-1), "show", "My Cloud, as ever");
    assert.equal(w.remembered, null, "the next launch doesn't try it again");
  }
});

test("then This Mac, when My Cloud doesn't run either; neither when This Mac can't open, nor when this computer is home", async () => {
  const w = launch({ remembered: { profile: "gone" }, opens: { cloud: false } });
  assert.equal(await w.run(), "this-mac");
  assert.deepEqual(w.steps, ["refresh", "profile:gone", "profile:default"]);
  const none = launch({ remembered: { profile: "gone" }, opens: { cloud: false }, workspaces: [] });
  assert.equal(await none.run(), "cloud");
  assert.deepEqual(none.steps.at(-1), "show");
  const computer = launch({ remembered: { profile: "gone" }, kind: "computer", opens: { cloud: false } });
  assert.equal(await computer.run(), "cloud");
  assert.deepEqual(computer.steps, ["refresh", "profile:gone", "show"]);
  const noProfiles = launch({ remembered: { profile: "default" }, profiles: false });
  assert.equal(await noProfiles.run(), "cloud");
});

test("nobody signed in: home as ever, and the place stays remembered for when they're back", async () => {
  const w = launch({ remembered: { profile: "work" }, opens: { cloud: null } });
  assert.equal(await w.run(), "home");
  assert.deepEqual(w.steps, ["refresh", "show"]);
  assert.deepEqual(w.remembered, { profile: "work" });
});


test("a saved server reopens with this computer as home, including without a Cloud sign-in", async () => {
  for (const opens of [{}, { cloud: null }]) {
    const w = launch({ remembered: { server: "env-1" }, kind: "computer", opens, servers: ["env-1"] });
    assert.equal(await w.run(), "remembered");
    assert.deepEqual(w.steps, ["refresh", "server:env-1"]);
    assert.equal(w.forgot, 0);
  }
});

test("a signed-out Cloud place waits for its account instead of opening a saved server", async () => {
  for (const remembered of [{ cloud: "c-b" }, { team: "team-acme" }]) {
    const w = launch({ remembered, kind: "computer", opens: { cloud: null }, servers: ["env-1"] });
    assert.equal(await w.run(), "home");
    assert.deepEqual(w.steps, ["refresh", "show"]);
    assert.deepEqual(w.remembered, remembered);
  }
});

test("a fresh launch reads a persisted server with no Cloud account and checks it before navigating", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-start-server-"));
  try {
    const entry = { id: "vps", kind: "remote", origin: "https://vps.example.test" };
    const state = { environments: [entry], activeId: "local" };
    const makePlaces = () => createHomePlaces({ store: jsonFile(join(dir, "home-place.json")), environments: () => state,
      persist: () => {}, makeId: () => "unused", homeOrigin: () => null });
    makePlaces().remember({ server: entry.id });
    const places = makePlaces(), w = world({ journal: null, state: null });
    const checked = [], navigated = [];
    assert.equal(await openStartPlace({ home: w.home, places, profiles: null, server: id => {
      assert.equal(id, entry.id);
      return reopenSavedServer(entry, { saved: () => [entry], fetch: async (url) => { checked.push(url); return new Response("{}"); },
        opened: found => { navigated.push(found.origin); return true; } });
    } }), "remembered");
    assert.deepEqual(checked, [`${entry.origin}/.well-known/openmausbot/environment`]);
    assert.deepEqual(navigated, [entry.origin]);
    assert.deepEqual(w.local, []);
    assert.deepEqual(places.remembered(), { server: entry.id });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test("an unavailable saved server falls back without a dialog or a Cloud sign-in", async () => {
  for (const id of ["gone", "throws"]) {
    const w = launch({ remembered: { server: id }, kind: "computer", opens: { cloud: null } });
    await w.run();
    assert.deepEqual(w.steps, ["refresh", `server:${id}`, "show"]);
    assert.equal(w.remembered, null);
  }
});
