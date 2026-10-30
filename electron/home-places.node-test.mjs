import assert from "node:assert/strict";
import test from "node:test";

import environments from "./environments.cjs";
import { createHomePlaces } from "./home-places.mjs";

const HOME = "https://omb-t-1.fly.dev", TEAM = "https://omb-u-acme.fly.dev", OTHER = "https://omb-u-beta.fly.dev";
const acme = { id: "team-acme", name: "Acme", role: "admin", machine: { status: "ready", origin: TEAM } };
const beta = { id: "team-beta", name: "Beta", role: "member", machine: { status: "ready", origin: OTHER } };
const connected = (teams) => ({ status: "connected", account: { id: "acct-1" }, teams });

function world({ saved = null, state = { environments: [{ id: "c", kind: "remote", name: "My Cloud", origin: HOME, home: true }], activeId: "c" } } = {}) {
  const w = { saved, state, persisted: [], ids: 0, log: [] };
  w.places = createHomePlaces({
    store: { read: () => { if (w.saved === null) throw new Error("ENOENT"); return w.saved; }, write: (value) => { if (w.failWrite) throw new Error("disk full"); w.saved = value; } },
    environments: () => w.state, persist: (next) => { w.persisted.push(next); w.state = next; }, makeId: () => `id-${++w.ids}`, homeOrigin: () => HOME, log: (line) => w.log.push(line),
  });
  return w;
}

test("a connected session's teams become saved places; the remembered team is kept with its name and address, and forgotten once the session drops it, with one line for the next page", () => {
  const w = world();
  assert.equal(w.places.remembered(), null);
  w.places.sync({ status: "unavailable", account: { id: "acct-1" } });
  assert.deepEqual(w.persisted, [], "a check that failed changes nothing");
  w.places.sync(connected([acme, beta]));
  assert.deepEqual(w.state.environments.map((entry) => [entry.name, entry.team?.id ?? null]), [["My Cloud", null], ["Acme", "team-acme"], ["Beta", "team-beta"]]);
  w.places.remember({ team: "team-acme" });
  assert.deepEqual(w.places.remembered(), { team: "team-acme", name: "Acme", origin: TEAM });
  assert.deepEqual(w.saved, { team: "team-acme" });
  w.places.remember({ team: "team-acme" });
  w.places.sync(connected([acme, beta]));
  assert.equal(w.persisted.length, 1, "the same teams again: nothing written");
  assert.equal(w.places.line(), null, "nothing to say");
  // Shown Acme, then dropped from it: Acme is gone from the places, My Cloud is active, the line waits once.
  w.state = { ...w.state, activeId: "id-1" };
  w.places.sync(connected([beta]));
  assert.deepEqual(w.state.environments.map((entry) => entry.name), ["My Cloud", "Beta"]);
  assert.equal(w.state.activeId, "c");
  assert.equal(w.places.remembered(), null, "next launch opens My Cloud");
  assert.deepEqual(w.places.line(), { kind: "left", name: "Acme" });
  assert.equal(w.places.line(), null, "said once");
  w.places.sync(connected([beta]));
  assert.equal(w.places.line(), null, "and not again on the next check");
});

test("the Admin refusing a team's pairing drops it at once: gone from the switcher, My Cloud active, remembered no more, the line once; the next session check says nothing more", () => {
  const w = world();
  w.places.sync(connected([acme, beta]));
  w.places.remember({ team: "team-acme" });
  w.state = { ...w.state, activeId: "id-1" };
  w.places.drop({ id: "team-acme", name: "Acme" });
  assert.deepEqual(w.state.environments.map((entry) => entry.name), ["My Cloud", "Beta"]);
  assert.equal(w.state.activeId, "c");
  assert.equal(w.places.remembered(), null);
  assert.deepEqual(w.places.line(), { kind: "left", name: "Acme" });
  assert.equal(w.places.line(), null);
  w.places.sync(connected([beta]));
  assert.equal(w.places.line(), null, "the session catching up says it no second time");
  w.places.drop({ id: "team-beta", name: "Beta" });
  assert.equal(w.state.activeId, "c", "a team not on screen leaves the active place alone");
  assert.deepEqual(w.places.line(), { kind: "left", name: "Beta" });
  const alone = world({ state: { environments: [{ id: "t", kind: "remote", name: "Acme", origin: TEAM, team: { id: "team-acme", role: "member" } }], activeId: "t" } });
  alone.places.drop({ id: "team-acme", name: "Acme" });
  assert.equal(alone.state.activeId, "local", "no My Cloud: this computer");
});

test("a remembered team whose place is gone from the file is still remembered by id; a bad file is an empty one; a write that fails is logged, never thrown", () => {
  const w = world({ saved: { team: "team-acme" } });
  assert.deepEqual(w.places.remembered(), { team: "team-acme" }, "no entry yet: the id alone");
  const bad = world({ saved: "garbage" });
  assert.equal(bad.places.remembered(), null);
  bad.failWrite = true;
  bad.places.remember({ team: "team-acme" });
  assert.equal(bad.log.length, 1);
  assert.deepEqual(bad.places.remembered(), { team: "team-acme" }, "kept in memory for this run");
  assert.equal(environments.reconcileTeams({ environments: [], activeId: "local" }, [], () => "x", HOME).state.activeId, "local");
});
