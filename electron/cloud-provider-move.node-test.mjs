import assert from "node:assert/strict";
import test from "node:test";

import { parseCloudSummary } from "./cloud-home.mjs";
import { myCloudOf, parseCloudList, withoutOldCloudHome } from "./cloud-list.mjs";
import { homeOf } from "./home-window.mjs";
import { createOneHome } from "./one-home.mjs";
import { oneHomeCloud } from "./one-home-main.mjs";

// My Cloud moves to another provider: the same Cloud (its id) answers at a new address, and the Admin lists the old one
// among its `formerOrigins`. A computer whose bots moved to it keeps them there, follows it, and never brings them back,
// which would run them in two places; a Cloud that truly is another still ends the move as before. Every side is faked;
// nothing reaches the network or the disk.
const OLD = "https://omb-u-1a2b3c4d5e6f.fly.dev", NEW = "https://omb-u-1a2b3c4d5e6f.homes.example", OTHER = "https://omb-u-other.homes.example";
const reply = (status, body = {}) => ({ ok: status < 400, status, body });

function computer({ journal, cloud = {}, admin = {} }) {
  const w = {
    journal, admin, asked: [], opened: [], logged: [],
    server: { marker: { frozen: true, cloud: OLD }, thaws: [], frozenFor: [] },
    cloud: { origin: NEW, account: "acct-1", machine: NEW, ready: true, moves: true, ended: false, paid: true, verified: true, ...cloud },
  };
  w.home = createOneHome({
    journal: { read: () => structuredClone(w.journal), write: (value) => { w.journal = structuredClone(value); } },
    cloud: () => ({ ...w.cloud }),
    gone: async (origin) => { w.asked.push(origin); return w.admin[origin] ?? null; },
    send: { move: async () => {}, check: async () => ({ ok: true }), switches: () => ({}), snapshot: () => ({ running: null }) },
    local: {
      async freeze(origin) { w.server.frozenFor.push(origin); w.server.marker = { frozen: true, cloud: origin }; return { frozen: true }; },
      async unfreeze(options) { w.server.thaws.push(options ?? null); w.server.marker = { frozen: false }; },
      frozen: async () => Boolean(w.server.marker.frozen),
      marker: async () => structuredClone(w.server.marker),
      json: async (route) => (route.startsWith("/api/bots") ? { bots: [] } : { items: [], conversations: [], automations: [] }),
      call: async () => reply(200),
    },
    session: async () => ({ call: async () => reply(200, { v: 1 }), close: async () => {} }),
    openHome: () => w.opened.push("cloud"),
    openLocal: () => w.opened.push("local"),
    lastInput: () => 0,
    version: "0.1.151",
    now: () => 2_000_000,
    log: (line) => w.logged.push(line),
    timers: { set: () => ({}), clear: () => {} },
  });
  return w;
}

const movedTo = (origin, extra = {}) => ({ origin, account: "acct-1", machine: origin, ...extra });
const doneTo = (cloud) => ({ v: 1, phase: "done", cloud, startedAt: 1_000, doneAt: 1_500, frozenAt: 1_400, version: "0.1.151", lent: true });

test("a done move keyed by the Cloud's id follows it to its new address and stays done: nothing comes home, nothing is asked", async () => {
  const w = computer({ journal: doneTo(movedTo(OLD, { id: "c-home" })), cloud: { id: "c-home" } });
  await w.home.kick();
  assert.equal(w.journal.phase, "done");
  assert.deepEqual(w.journal.cloud, movedTo(NEW, { id: "c-home" }));
  assert.deepEqual([w.server.thaws, w.opened, w.asked], [[], [], []], "the freeze stays, the window stays, the Admin isn't asked whether it is gone");
  assert.equal(w.server.marker.frozen, true);
  assert.equal(w.logged.filter((line) => line.includes("new address")).length, 1);
  await w.home.kick();
  assert.deepEqual([w.journal.phase, w.journal.cloud.origin, w.server.thaws], ["done", NEW, []], "and on every run after");
});

test("a journal from before ids were kept is known again by the address the Cloud had before, and keeps its id from then on", async () => {
  const w = computer({ journal: doneTo(movedTo(OLD)), cloud: { id: "c-home", formerOrigins: [OLD] } });
  await w.home.kick();
  assert.equal(w.journal.phase, "done");
  assert.deepEqual(w.journal.cloud, movedTo(NEW, { id: "c-home" }));
  assert.deepEqual([w.server.thaws, w.opened], [[], []]);
  const without = computer({ journal: doneTo(movedTo(OLD)), cloud: { formerOrigins: [OLD] } });
  await without.home.kick();
  assert.deepEqual(without.journal.cloud, movedTo(NEW), "an Admin that lists no id: the address alone, and no id is made up");
});

test("a move under way follows the Cloud too, so the freeze names its new address", async () => {
  const w = computer({ journal: { v: 1, phase: "wait", cloud: movedTo(OLD), startedAt: 1_000 }, cloud: { id: "c-home", formerOrigins: [OLD] } });
  w.server.marker = { frozen: false };
  await w.home.kick();
  assert.deepEqual(w.server.frozenFor, [NEW]);
  assert.equal(w.journal.cloud.origin, NEW);
  assert.equal(w.journal.phase, "done");
});

test("the id is kept once the session lists it, even before the Cloud ever moves", async () => {
  const w = computer({ journal: doneTo(movedTo(NEW)), cloud: { id: "c-home" } });
  await w.home.kick();
  assert.deepEqual(w.journal.cloud, movedTo(NEW, { id: "c-home" }));
  const fresh = computer({ journal: null, cloud: { id: "c-home" } });
  fresh.server.marker = { frozen: false };
  await fresh.home.kick();
  assert.equal(fresh.journal.cloud.id, "c-home", "a new move keeps the id from its start");
});

test("a Cloud that truly is another still counts as ended: a move not switched yet stops, and a done one comes home on the Admin's word", async () => {
  // Another id, another address, and the journal's address not among the ones it had before.
  const other = { origin: OTHER, machine: OTHER, id: "c-other", formerOrigins: ["https://omb-u-other.fly.dev"] };
  const moving = computer({ journal: { v: 1, phase: "copy", cloud: movedTo(OLD, { id: "c-home" }), startedAt: 1_000 }, cloud: other });
  moving.server.marker = { frozen: false };
  await moving.home.kick();
  assert.equal(moving.journal, null, "the move to the old Cloud stops: nothing runs there yet");
  const done = computer({ journal: doneTo(movedTo(OLD, { id: "c-home" })), cloud: other, admin: { [OLD]: "deleted" } });
  await done.home.kick();
  assert.deepEqual(done.asked, [OLD], "the Admin is asked about the Cloud this computer moved to, at its own address");
  assert.equal(done.journal.phase, "back");
  assert.equal(done.journal.gone, "deleted");
  assert.deepEqual(done.server.thaws, [{ automations: "off" }]);
  const waiting = computer({ journal: doneTo(movedTo(OLD, { id: "c-home" })), cloud: other });
  await waiting.home.kick();
  assert.deepEqual([waiting.journal.phase, waiting.journal.cloud.origin, waiting.server.thaws], ["done", OLD, []], "no word from the Admin: it stays, and is not followed");
  const sameAddress = computer({ journal: doneTo(movedTo(OLD, { id: "c-home" })), cloud: { origin: OTHER, machine: OTHER, id: "c-other" }, admin: { [OLD]: "ended" } });
  await sameAddress.home.kick();
  assert.equal(sameAddress.journal.gone, "ended", "an id of its own is no sign of being the same Cloud");
});

test("the same Cloud that moved and then ended still brings this computer home, as My Cloud ending always has", async () => {
  const w = computer({ journal: doneTo(movedTo(OLD, { id: "c-home" })), cloud: { id: "c-home", ended: true, ready: false } });
  await w.home.kick();
  assert.equal(w.journal.cloud.origin, NEW, "its things come home from where it is now");
  assert.equal(w.journal.phase, "back");
  assert.deepEqual(w.server.thaws, [null]);
});

test("nobody else's word moves a journal: a session not verified, or another account's", async () => {
  for (const cloud of [{ id: "c-home", formerOrigins: [OLD], verified: false }, { id: "c-home", formerOrigins: [OLD], account: "acct-2" }]) {
    const w = computer({ journal: doneTo(movedTo(OLD, { id: "c-home" })), cloud });
    await w.home.kick();
    assert.equal(w.journal.cloud.origin, OLD, JSON.stringify(cloud));
    assert.deepEqual(w.server.thaws, [], JSON.stringify(cloud));
  }
});

test("a freeze with no journal that names the Cloud's old address is My Cloud's, never asked about as another", async () => {
  const w = computer({ journal: null, cloud: { id: "c-home", formerOrigins: [OLD] }, admin: { [OLD]: "deleted" } });
  await w.home.kick();
  assert.deepEqual([w.asked, w.server.thaws], [[], []]);
});

const session = ({ machine = {}, clouds } = {}) => ({
  status: "connected", account: { id: "acct-1" }, entitlement: { status: "active" },
  machine: { status: "ready", origin: NEW, ...machine },
  ...(clouds ? { clouds } : {}),
});
const listed = (over = {}) => ({ id: "c-home", name: "My Cloud", color: null, role: "owner", tier: "pro", runsOn: "cloud", status: "ready", origin: NEW, teamId: null, primary: true, managed: true, ...over });

test("the Admin's formerOrigins are read beside a Cloud's origin, strictly, and an Admin without them reads as before", () => {
  assert.deepEqual(parseCloudSummary({ state: "ready", origin: NEW, formerOrigins: [OLD, OLD, NEW, "http://omb-u-x.fly.dev", `${OLD}/path`, 7, null] }),
    { status: "ready", origin: NEW, formerOrigins: [OLD] });
  assert.deepEqual(parseCloudSummary({ state: "ready", origin: NEW }), { status: "ready", origin: NEW });
  for (const formerOrigins of [OLD, {}, [], ["nope"]]) assert.deepEqual(parseCloudSummary({ state: "ready", origin: NEW, formerOrigins }), { status: "ready", origin: NEW }, JSON.stringify(formerOrigins));
  const [entry] = parseCloudList([{ ...listed(), formerOrigins: [OLD, "ftp://x.example"] }]);
  assert.deepEqual(entry.formerOrigins, [OLD]);
  assert.equal("formerOrigins" in parseCloudList([listed()])[0], false);
});

test("My Cloud's identity: its id from the list at its address, and every address it had before, the summary's and the list's", () => {
  assert.deepEqual(myCloudOf(session({ machine: { formerOrigins: [OLD] }, clouds: [listed({ formerOrigins: ["https://omb-u-older.fly.dev"] })] })),
    { origin: NEW, id: "c-home", formerOrigins: [OLD, "https://omb-u-older.fly.dev"] });
  assert.deepEqual(myCloudOf(session({ clouds: [listed({ origin: OTHER })] })), { origin: NEW, id: null, formerOrigins: [] }, "an id only from the Cloud at its address");
  assert.deepEqual(myCloudOf(session({ clouds: [listed({ role: "member" })] })).id, null, "never a team's");
  assert.equal(myCloudOf({ status: "unavailable", machine: { status: "ready", origin: NEW } }), null, "only a verified session's word");
  const cloud = oneHomeCloud(session({ machine: { formerOrigins: [OLD] }, clouds: [listed()] }));
  assert.deepEqual([cloud.id, cloud.formerOrigins, cloud.origin], ["c-home", [OLD], NEW]);
});

test("the window opens My Cloud at its new address for a journal or a freeze kept at its old one, and nothing else changes", () => {
  const state = session({ machine: { formerOrigins: [OLD] }, clouds: [listed()] });
  assert.deepEqual(homeOf({ journal: doneTo(movedTo(OLD)), state }), { kind: "cloud", origin: NEW });
  assert.deepEqual(homeOf({ journal: doneTo(movedTo(OLD, { id: "c-home" })), state: session({ clouds: [listed()] }) }), { kind: "cloud", origin: NEW }, "by id alone");
  assert.deepEqual(homeOf({ frozenCloud: OLD, state }), { kind: "cloud", origin: NEW }, "a freeze with no journal is not another account's");
  assert.deepEqual(homeOf({ journal: doneTo(movedTo(OLD)), state: session({ machine: { hold: { until: 9 }, formerOrigins: [OLD] } }) }), { kind: "computer" }, "it ended: home is this computer");
  assert.deepEqual(homeOf({ journal: doneTo(movedTo(OLD)), state: session({ machine: { origin: OTHER }, clouds: [listed({ origin: OTHER, id: "c-other" })] }) }), { kind: "cloud", origin: OLD },
    "another Cloud: the one moved to opens, as before");
  assert.deepEqual(homeOf({ journal: doneTo(movedTo(OLD)), state: { ...state, account: { id: "acct-2" } } }), { kind: "cloud", origin: NEW, otherAccount: true },
    "another account's Cloud is never this journal's");
});

test("My Cloud's saved place moves to its new address with it, keeping its id, name and colour", () => {
  const garage = { id: "garage", kind: "remote", name: "Garage", origin: "https://garage.example" };
  const saved = { environments: [{ id: "home", kind: "remote", name: "Anagama", color: "teal", origin: OLD, home: true }, garage], activeId: "home" };
  const moved = withoutOldCloudHome(saved, session({ machine: { formerOrigins: [OLD] }, clouds: [listed()] }));
  assert.deepEqual(moved.environments, [{ id: "home", kind: "remote", name: "Anagama", color: "teal", origin: NEW, home: true }, garage]);
  assert.equal(moved.activeId, "home");
  const already = { ...saved, environments: [...saved.environments, { id: "new", kind: "remote", name: "My Cloud", origin: NEW, home: true }] };
  assert.deepEqual(withoutOldCloudHome(already, session({ machine: { formerOrigins: [OLD] }, clouds: [listed()] })).environments.map((entry) => entry.id), ["garage", "new"],
    "one already saved at the new address stays the only one");
});
