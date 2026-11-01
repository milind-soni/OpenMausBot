import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import { parseCloudList } from "./cloud-list.mjs";
import { addCloudView, createAddedCloudNotice, installCloudRail, railPlaces } from "./cloud-rail.mjs";
import { otherCloudSnapshot } from "./cloud-plan-ipc.mjs";

const HOME = "https://omb-u-1a2b3c4d5e6f.fly.dev", CLIENT_A = "https://omb-c-a.fly.dev", TEAM = "https://omb-t-acme.fly.dev", VPS = "https://bots.example.test";
const LOCAL = "http://127.0.0.1:8799";
const entry = (over = {}) => ({ id: "c-a", name: "Client A", color: "green", role: "owner", tier: "pro", runsOn: "cloud", status: "ready", origin: CLIENT_A,
  teamId: null, primary: false, ...over });
const PRIMARY = entry({ id: "c-home", name: "My Cloud", color: null, origin: HOME, primary: true });
const saved = (activeId = "home", extra = []) => ({ activeId, environments: [
  { id: "home", kind: "remote", name: "Studio", origin: HOME, home: true, color: "purple" },
  { id: "vps", kind: "remote", name: "Office", origin: VPS },
  { id: "acme", kind: "remote", name: "Acme", origin: TEAM, team: { id: "team-acme", role: "member" } },
  { id: "a", kind: "remote", name: "Client A", origin: CLIENT_A, color: "teal", cloud: { id: "c-a", role: "owner" } },
  { id: "lab", kind: "local", name: "Lab", dataDir: "/Users/person/lab" },
  ...extra,
] });
const session = (over = {}) => ({ status: "connected", account: { id: "acct-1" }, machine: { status: "ready", origin: HOME },
  teams: [{ id: "team-acme", name: "Acme", role: "member", machine: { status: "ready", origin: TEAM } }],
  clouds: parseCloudList([PRIMARY, entry(), entry({ id: "c-team", name: "Acme", color: "amber", teamId: "team-acme", role: "member", origin: TEAM })]), ...over });

test("the rail: My Cloud, the person's Clouds and teams' Clouds in the session's order, then servers saved by hand; names, colours and states, never an address", () => {
  const places = railPlaces({ saved: saved(), home: HOME, mine: HOME, state: session() });
  assert.deepEqual(places, [
    { id: "home", name: "Studio", color: "purple", kind: "cloud", opens: true, paint: { swatch: "violet" }, active: true },
    { id: "a", name: "Client A", color: "teal", kind: "cloud", opens: true, paint: { swatch: "green" } },
    { id: "acme", name: "Acme", color: "yellow", kind: "team", opens: true, paint: { swatch: "amber", locked: "member" } },
    { id: "vps", name: "Office", color: null, kind: "server", opens: true, paint: { swatch: null } },
  ], "each colour changed from the rail, but a team's by its admins alone");
  for (const origin of [HOME, CLIENT_A, TEAM, VPS, "/Users/person/lab"]) assert.equal(JSON.stringify(places).includes(origin), false, origin);
  const before = railPlaces({ saved: saved("local"), home: null, mine: HOME, state: session() });
  assert.deepEqual(before[0], { id: "local", name: "This computer", color: null, kind: "computer", opens: true, paint: { swatch: null }, active: true },
    "before the move, this computer is a place too: plain until a colour is picked, from its circle's menu as well");
  assert.equal(before.length, 5);
  const teal = railPlaces({ saved: { ...saved("local"), localColor: "teal" }, home: null, mine: HOME, state: session() })[0];
  assert.deepEqual([teal.color, teal.paint], ["teal", { swatch: "green" }], "its circle takes the colour this app keeps for it");
  assert.equal(railPlaces({ saved: { ...saved("home"), localColor: "teal" }, home: HOME, mine: HOME, state: session() }).some(place => place.kind === "computer"), false,
    "once My Cloud is home, this computer is no circle, whatever its colour");
});

test("a Cloud of your own is a rail even alone, for its ＋; otherwise one place, or none: no rail, the window as it was", () => {
  const alone = { activeId: "home", environments: [{ id: "home", kind: "remote", name: "My Cloud", origin: HOME, home: true }] };
  assert.deepEqual(railPlaces({ saved: alone, home: HOME, mine: HOME, state: session({ teams: [], clouds: parseCloudList([PRIMARY]) }) }).map(place => place.id), ["home"],
    "My Cloud alone, after the move: its circle, so the ＋ that buys another is there");
  assert.deepEqual(railPlaces({ saved: alone, home: HOME, mine: HOME, state: null }), [], "signed out of Cloud: one saved place is no rail");
  assert.deepEqual(railPlaces({ saved: alone, home: null, mine: HOME, state: session({ teams: [], clouds: parseCloudList([PRIMARY]) }) }).map(place => place.id), ["local", "home"],
    "before the move, This computer and My Cloud are two places: two circles");
  assert.deepEqual(railPlaces({ saved: { activeId: "local", environments: [] }, state: null }), []);
  const two = railPlaces({ saved: { activeId: "home", environments: [alone.environments[0], { id: "vps", kind: "remote", name: "Office", origin: VPS }] }, home: HOME, mine: HOME, state: null });
  assert.deepEqual(two.map(place => place.id), ["home", "vps"], "a server saved by hand is a place");
  const typed = { activeId: "local", environments: [{ id: "vps", kind: "remote", name: "Office", origin: VPS }] };
  assert.deepEqual(railPlaces({ saved: typed, home: null, state: null }).map(place => place.id), ["local", "vps"], "This computer and one server: two circles");
  assert.deepEqual(railPlaces({ saved: { activeId: "local", environments: [] }, home: null, state: null }), [], "This computer alone: no rail");
});

test("a Cloud being set up shows how far it is, one at checkout waits, one the Admin is still making opens its own screen, and a payment problem needs its owner", () => {
  const clouds = parseCloudList([PRIMARY, entry({ status: "setting_up", setup: { progress: 0.4 } }), entry({ id: "c-b", name: "Client B", color: "violet", status: "checkout", origin: null }),
    entry({ id: "c-c", name: "Client C", status: "setting_up", origin: null, setup: { step: "storage" } }), entry({ id: "c-team", name: "Acme", teamId: "team-acme", role: "member", origin: TEAM, status: "payment_problem" })]);
  const places = railPlaces({ saved: saved(), home: HOME, mine: HOME, state: session({ clouds }) });
  assert.deepEqual(places.find(place => place.id === "a"), { id: "a", name: "Client A", color: "teal", kind: "cloud", opens: true, paint: { swatch: "green" }, progress: 0.4 });
  assert.deepEqual(places.slice(-2), [
    { id: "pending:c-b", name: "Client B", color: "purple", kind: "cloud", opens: true, progress: 0, waiting: true, cloudId: "c-b" },
    { id: "pending:c-c", name: "Client C", color: "teal", kind: "cloud", opens: true, progress: 0.4, cloudId: "c-c" },
  ], "each opens its own screen (its checkout, its setup), never an address; main keeps which Cloud it is");
  assert.equal(places.find(place => place.id === "acme").attention, undefined, "a member can't fix a team's payment");
  const owner = railPlaces({ saved: saved(), home: HOME, mine: HOME, state: session({ clouds: parseCloudList([PRIMARY, entry({ status: "payment_problem" })]) }) });
  assert.equal(owner.find(place => place.id === "a").attention, true);
  const older = railPlaces({ saved: saved(), home: HOME, mine: HOME, state: session({ clouds: undefined, machine: { status: "payment-problem", origin: HOME } }) });
  assert.equal(older.find(place => place.id === "home").attention, true, "an older Admin: My Cloud's own word");
  const settingUp = railPlaces({ saved: saved(), home: HOME, mine: HOME, state: session({ clouds: undefined, teams: [{ id: "team-acme", name: "Acme", role: "member", machine: { status: "provisioning", origin: TEAM, setup: { step: "starting" } } }] }) });
  assert.equal(settingUp.find(place => place.id === "acme").progress, 0.65);
});

test("a server of the person's own that signed in with their account: one saved here is that place, online or not; one not connected yet shows how; one only on its own network opens nothing", () => {
  const RENDER = "https://render.example.test";
  const clouds = parseCloudList([PRIMARY, entry(),
    entry({ id: "s-mini", name: "Mac mini", color: null, tier: null, runsOn: "server", managed: false, status: "offline", origin: null, lastSeenAt: 1_761_000_000_000 }),
    entry({ id: "s-office", name: "Office box", color: null, tier: null, runsOn: "server", managed: false, status: "ready", origin: VPS }),
    entry({ id: "s-render", name: "Render VPS", color: "rose", tier: null, runsOn: "server", managed: false, status: "offline", origin: RENDER, lastSeenAt: 1_761_000_100_000 })]);
  const state = session({ clouds });
  const places = railPlaces({ saved: saved(), home: HOME, mine: HOME, state });
  assert.deepEqual(places.find(place => place.id === "vps"), { id: "vps", name: "Office", color: null, kind: "server", opens: true, paint: { swatch: null }, server: true },
    "saved by hand at its address: the same circle, marked as theirs, online, opening as it always did");
  assert.deepEqual(places.slice(-2), [
    { id: "signed-in:s-mini", name: "Mac mini", color: null, kind: "server", opens: false, paint: { swatch: null }, ownNetwork: true, server: true, offline: true, lastSeenAt: 1_761_000_000_000 },
    { id: "signed-in:s-render", name: "Render VPS", color: "red", kind: "server", opens: false, paint: { swatch: "rose" }, pairs: true, server: true, offline: true, lastSeenAt: 1_761_000_100_000 },
  ]);
  assert.equal(places.length, 6, "one circle per server");
  for (const origin of [VPS, RENDER]) assert.equal(JSON.stringify(places).includes(origin), false, origin);
  const alone = { activeId: "home", environments: [{ id: "home", kind: "remote", name: "My Cloud", origin: HOME, home: true }] };
  assert.equal(railPlaces({ saved: alone, home: HOME, mine: HOME, state: session({ teams: [], clouds: parseCloudList([PRIMARY, clouds[2]]) }) }).length, 2, "it counts as a place");
  assert.equal(places.some(place => place.update), false, "no newest release named (the Admin doesn't follow releases): no reminder");
  const behind = parseCloudList([PRIMARY, entry({ id: "s-mini", name: "Mac mini", runsOn: "server", managed: false, status: "ready", origin: null, version: "0.1.118" }),
    entry({ id: "s-new", name: "New box", runsOn: "server", managed: false, status: "ready", origin: null, version: "0.1.130" }),
    entry({ id: "s-dev", name: "Dev box", runsOn: "server", managed: false, status: "ready", origin: null, version: "0.1.118-dev" })]);
  const reminded = railPlaces({ saved: saved(), home: HOME, mine: HOME, state: session({ clouds: behind, latestVersion: "0.1.130" }) });
  assert.deepEqual(reminded.filter(place => place.update).map(place => [place.id, place.update]), [["signed-in:s-mini", { version: "0.1.118", latest: "0.1.130" }]],
    "only one on an older numbered release");
  const r = rail({ places: () => places });
  assert.throws(() => r.call("workspaces:open", "signed-in:s-render"), /isn't here/, "nothing opens one main can't pair with yet");
  assert.throws(() => r.call("workspaces:open", "signed-in:s-mini"), /isn't here/);
});

function rail(over = {}) {
  const handlers = new Map(), opened = [], ran = [], sent = [];
  const w = { trusted: true, lists: true, beside: true, state: session(), offer: { recommended: "pro", plans: [{ tier: "pro", amount: 4900 }] }, added: [], organized: [],
    organization: { outcome: "added", cloudId: "c-new" } };
  const account = { state: () => w.state, offer: async () => w.offer, addCloud: async (input) => { w.added.push(input); return { outcome: "opened", state: w.state }; },
    addOrganization: async (input) => { w.organized.push(input); return w.organization; },
    reopenAdd: async () => true, addLink: () => "https://test.checkout.dodopayments.com/x", addDone: () => { w.done = true; }, interest: async () => {} };
  const installed = installCloudRail({ ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }, guard: handler => handler, trusted: () => w.trusted,
    lists: () => w.lists, beside: () => w.beside,
    places: () => railPlaces({ saved: saved(), home: HOME, mine: HOME, state: w.state }), open: id => opened.push(id), account: () => account,
    add: { choices: () => ({ cloud: true, link: true, address: false }), run: (...args) => ran.push(args) }, clipboard: { writeText: text => sent.push(text) },
    openCloud: async id => opened.push(`cloud:${id}`), targets: () => [{ isDestroyed: () => false, send: (channel) => sent.push(`page:${channel}`) }, null,
      { isDestroyed: () => false, send: (channel) => sent.push(`rail:${channel}`) }], ...over });
  return { handlers, opened, ran, sent, w, installed, call: (channel, ...args) => handlers.get(channel)({ sender: {} }, ...args) };
}

test("the rail's channels: the list only for the rail's own page, a circle only by an id main listed, ＋ only its fixed choices", async () => {
  const r = rail();
  assert.deepEqual((await r.call("workspaces:places")).places.map(place => place.id), ["home", "a", "acme", "vps"]);
  r.w.lists = false;
  assert.deepEqual(await r.call("workspaces:places"), { places: [], add: { cloud: false, link: false, address: false, organization: false }, beside: true },
    "a place's page, this computer's and a Cloud's included, learns only that the rail stands beside it");
  r.w.beside = false;
  assert.deepEqual(await r.call("workspaces:places"), { places: [], add: { cloud: false, link: false, address: false, organization: false } });
  assert.throws(() => r.call("workspaces:open", "a"), /only available/);
  assert.throws(() => r.call("workspaces:add", "link"), /only available/);
  assert.equal(typeof await r.call("cloud-add:state"), "object", "＋'s buying sheet still runs on a page main vouches for (this computer's own)");
  r.w.lists = true;
  r.call("workspaces:open", "a");
  assert.throws(() => r.call("workspaces:open", "https://evil.example.test"), /isn't here/);
  assert.throws(() => r.call("workspaces:open", "lab"), /isn't here/, "a local environment is the Server menu's, not the rail's");
  r.call("workspaces:add", "link");
  r.call("workspaces:add", "link", "  https://bots.example.test/#pair=abc  ");
  r.call("workspaces:add", "link", { href: "https://evil.example.test" });
  r.call("workspaces:add", "link", "x".repeat(5000));
  assert.throws(() => r.call("workspaces:add", "address"), /isn't something/, "not offered here");
  assert.throws(() => r.call("workspaces:add", "javascript:alert(1)"), /isn't something/);
  assert.deepEqual([r.opened, r.ran], [["a"], [["link"], ["link", "https://bots.example.test/#pair=abc"], ["link"], ["link", "x".repeat(4096)]]],
    "a pasted link reaches main's own Connect dialog trimmed and bounded; anything but text is the clipboard's");
  r.installed.changed(); r.installed.changed();
  assert.deepEqual(r.sent, ["page:workspaces:changed", "rail:workspaces:changed"], "a signal only, to the page and the rail, and once per change");
  r.w.beside = true;
  r.installed.changed();
  assert.deepEqual(r.sent.slice(2), ["page:workspaces:changed", "rail:workspaces:changed"], "the rail came beside the page (or went): the page reads it again");
});

test("buying another Cloud from a page: the plan must be on sale, the name is checked, and the page gets only what the sheet says", async () => {
  const r = rail();
  await assert.rejects(r.call("cloud-add:start", "max", "Client B", "rose"), /Choose a plan/);
  await assert.rejects(r.call("cloud-add:start", "pro", " ", "rose"), /Choose a plan/);
  assert.deepEqual(await r.call("cloud-add:start", "pro", "Client B", "url(x)"), { outcome: "opened" });
  assert.deepEqual(r.w.added, [{ tier: "pro", interval: "month", name: "Client B", color: null }], "an unknown swatch is none");
  await r.call("cloud-add:start", "pro", "Client C", "rose", "app_whats_new_team");
  await r.call("cloud-add:start", "pro", "Client D", "rose", "https://evil.example.test");
  assert.deepEqual(r.w.added.slice(1), [{ tier: "pro", interval: "month", name: "Client C", color: "rose", source: "app_whats_new_team" },
    { tier: "pro", interval: "month", name: "Client D", color: "rose" }], "the app's own source goes with it; anything else is left out");
  assert.equal(await r.call("cloud-add:copy-link"), true);
  assert.deepEqual(r.sent, ["https://test.checkout.dodopayments.com/x"]);
  r.w.state = session({ adding: { cloudId: "c-a", name: "Client A", color: "green", tier: "pro", startedAt: 1, link: true } });
  await r.call("cloud-add:open");
  assert.deepEqual(r.opened, ["cloud:c-a"]);
  assert.equal(r.w.done, true);
  const view = await r.call("cloud-add:state");
  assert.equal(JSON.stringify(view).includes("acct-1"), false, "never the account");
  assert.deepEqual({ ...view, offer: undefined }, { signedIn: true, hasCloud: true, supported: true, canAdd: true, offer: undefined, count: 2,
    home: { name: "My Cloud", color: null }, adding: { name: "Client A", color: "green", tier: "pro", startedAt: 1, status: "ready", link: true } });
  r.w.trusted = false;
  for (const channel of ["cloud-add:state", "cloud-add:start", "cloud-add:open", "cloud-add:copy-link", "cloud-add:interest"]) assert.throws(() => r.call(channel), /only available/, channel);
});

test("New organization on ＋: only while this account runs a Team plan's organizations and the Admin hasn't turned adding them off; the name is checked, the page gets only the outcome", async () => {
  const r = rail(), plan = { planCloudId: "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a", canAdd: true, count: 2, max: 10 };
  assert.equal((await r.call("workspaces:places")).add.organization, false, "no Team plan's organizations: no such choice");
  r.w.state = session({ organizations: plan });
  assert.deepEqual((await r.call("workspaces:places")).add, { cloud: true, link: true, address: false, organization: true });
  r.w.state = session({ organizations: { ...plan, canAdd: false, blocked: "limit" } });
  assert.equal((await r.call("workspaces:places")).add.organization, true, "at the plan's limit it is still there, to say so");
  r.w.state = session({ organizations: { ...plan, canAdd: false, blocked: "off" } });
  assert.equal((await r.call("workspaces:places")).add.organization, false, "turned off on the Admin: not offered");
  r.installed.changed(); r.w.state = session({ organizations: plan }); r.installed.changed();
  assert.deepEqual(r.sent.filter(item => item === "rail:workspaces:changed"), ["rail:workspaces:changed", "rail:workspaces:changed"], "the rail reads ＋'s choices again");
  await assert.rejects(r.call("cloud-add:organization", " ", "rose"), /Give the organization a name/);
  assert.deepEqual(await r.call("cloud-add:organization", "  Client   B ", "url(x)"), { outcome: "added" }, "only the outcome, never an id");
  assert.deepEqual(r.w.organized, [{ name: "Client B", color: null }], "the name folded; an unknown swatch is none");
  r.w.organization = { outcome: "blocked", blocked: "limit" };
  assert.deepEqual(await r.call("cloud-add:organization", "Client C", "rose"), { outcome: "blocked", blocked: "limit" });
  assert.deepEqual(addCloudView(session({ organizations: { ...plan, canAdd: false, blocked: "limit" } }), null).organizations, { canAdd: false, blocked: "limit", count: 2, max: 10 });
  assert.equal(addCloudView(session(), null).organizations, undefined);
  r.w.trusted = false;
  assert.throws(() => r.call("cloud-add:organization", "Client D", null), /only available/);
});

test("what the add sheet says: an older Admin is one Cloud for now, the Admin's cap says why, and a new Cloud's setup is followed", () => {
  assert.deepEqual(addCloudView({ status: "signed-out" }, null), { signedIn: false });
  const older = addCloudView(session({ clouds: undefined }), null);
  assert.deepEqual([older.supported, older.canAdd, older.hasCloud, older.count], [false, false, true, 1]);
  const capped = addCloudView(session({ addCloud: { canAdd: false, blocked: "cap" } }), null);
  assert.deepEqual([capped.canAdd, capped.blocked], [false, "cap"]);
  const none = addCloudView({ status: "connected", account: { id: "x" }, clouds: [] }, null);
  assert.equal(none.hasCloud, false, "no Cloud yet: ＋ buys the first one on this computer's own sheet");
  const adding = (status, extra = {}) => addCloudView(session({ clouds: parseCloudList([PRIMARY, entry({ id: "c-b", status, origin: status === "ready" ? CLIENT_A : null, ...extra })]),
    adding: { cloudId: "c-b", name: "Client B", color: "rose", tier: "pro", startedAt: 5 } }), null).adding;
  assert.deepEqual(adding("checkout"), { name: "Client B", color: "rose", tier: "pro", startedAt: 5, status: "checkout", progress: 0 });
  assert.deepEqual(adding("setting_up", { setup: { progress: 0.5 } }), { name: "Client B", color: "rose", tier: "pro", startedAt: 5, status: "setting_up", progress: 0.5 });
  assert.equal(adding("ready").status, "ready");
  assert.equal(adding("payment_problem").status, "problem");
});

test("another Cloud's page reads its own plan: its tier, and whether it runs", () => {
  assert.deepEqual(otherCloudSnapshot(entry()), { status: "paid", tier: "pro" });
  assert.deepEqual(otherCloudSnapshot(entry({ status: "payment_problem", tier: null })), { status: "attention" });
});

test("“{name}” is ready, once per Cloud this app bought, unless its sheet shows it in the focused window; a click opens it", () => {
  const shown = [], opened = [];
  class FakeNotification { static isSupported() { return true; } constructor(options) { this.options = options; shown.push(this); } on(_event, handler) { this.click = handler; } show() {} }
  let sheet = false;
  const notice = createAddedCloudNotice({ Notification: FakeNotification, focused: () => true, sheetOpen: () => sheet, open: id => opened.push(id) });
  const state = status => session({ clouds: parseCloudList([PRIMARY, entry({ id: "c-b", name: "Client B", status, origin: status === "ready" ? CLIENT_A : null })]),
    adding: { cloudId: "c-b", name: "Client B", color: null, tier: "pro", startedAt: 1 } });
  assert.equal(notice(state("setting_up")), false);
  assert.equal(notice(state("ready")), true);
  assert.equal(shown[0].options.title, "“Client B” is ready");
  shown[0].click();
  assert.deepEqual(opened, ["c-b"]);
  assert.equal(notice(state("ready")), false, "once");
  sheet = true;
  const quiet = createAddedCloudNotice({ Notification: FakeNotification, focused: () => true, sheetOpen: () => sheet, open: () => {} });
  assert.equal(quiet(state("ready")), false, "the sheet in the focused window says it itself");
  assert.equal(shown.length, 1);
});

test("a Cloud of your own that ended is marked, and its menu offers Remove from list only when the Admin says so; a running Cloud or a team's never does", () => {
  const OLD = "https://omb-c-old.fly.dev";
  const withOld = (over = {}) => saved("home", [{ id: "old", kind: "remote", name: "Old", origin: OLD, cloud: { id: "c-old", role: "owner" } }, ...(over.extra ?? [])]);
  const clouds = parseCloudList([PRIMARY, entry(), entry({ id: "c-old", name: "Old", color: null, status: "ended", origin: OLD, deleteAfter: 1_800_000_000_000, removable: true }),
    entry({ id: "c-team", name: "Acme", color: "amber", teamId: "team-acme", role: "owner", origin: TEAM, status: "ended", removable: true })]);
  const places = railPlaces({ saved: withOld(), home: HOME, mine: HOME, state: session({ clouds }) });
  assert.deepEqual(places.find(place => place.id === "old"), { id: "old", name: "Old", color: null, kind: "cloud", opens: true, paint: { swatch: null }, ended: true, removable: true, cloudId: "c-old" });
  assert.equal(places.find(place => place.id === "a").removable, undefined, "a running Cloud: never");
  assert.deepEqual([places.find(place => place.id === "acme").removable, places.find(place => place.id === "acme").ended], [undefined, undefined], "a team's Cloud is its team's");
  const older = railPlaces({ saved: withOld(), home: HOME, mine: HOME, state: session({ clouds: parseCloudList([PRIMARY, entry({ id: "c-old", name: "Old", status: "ended", origin: OLD })]) }) });
  assert.deepEqual([older.find(place => place.id === "old").ended, older.find(place => place.id === "old").removable], [true, undefined], "an Admin without Remove from list: marked, nothing to remove");
});

test("My Cloud that ended and was removed from the list leaves the rail; while it is listed it is a circle that opens its own screen", () => {
  const OLD = "https://omb-u-old.fly.dev";
  const before = { activeId: "local", environments: [{ id: "mine", kind: "remote", name: "My Cloud", origin: OLD, home: true }, { id: "a", kind: "remote", name: "Client A", origin: CLIENT_A, cloud: { id: "c-a", role: "owner" } }] };
  const ended = entry({ id: "c-home", name: "My Cloud", color: null, origin: OLD, primary: true, status: "ended", deleteAfter: 1_800_000_000_000, removable: true });
  const listed = railPlaces({ saved: before, home: null, mine: OLD, state: session({ machine: { status: "stopped", origin: OLD }, teams: [], clouds: parseCloudList([ended, entry()]) }) });
  assert.deepEqual(listed.map(place => [place.id, place.ended ?? false, place.removable ?? false]), [["local", false, false], ["mine", true, true], ["a", false, false]]);
  assert.equal(listed.find(place => place.id === "mine").cloudId, "c-home");
  const removed = railPlaces({ saved: before, home: null, mine: OLD, state: session({ machine: { status: "stopped", origin: OLD }, teams: [], clouds: parseCloudList([entry()]) }) });
  assert.deepEqual(removed.map(place => place.id), ["local", "a"], "the session no longer lists it: no circle, though its machine still keeps its files");
  const unknown = railPlaces({ saved: before, home: null, mine: OLD, state: session({ machine: { status: "stopped", origin: OLD }, teams: [], clouds: undefined }) });
  assert.deepEqual(unknown.map(place => place.id), ["local", "mine", "a"], "an Admin without the list: as it was");
  assert.deepEqual(railPlaces({ saved: before, home: null, mine: OLD, state: { status: "unavailable" } }).map(place => place.id), ["local", "mine", "a"], "the Admin can't be asked: as saved");
});

test("Remove from list from a circle's menu: only the rail's own page, only a circle main listed as removable, and by main's own word for the Cloud", async () => {
  const OLD = "https://omb-c-old.fly.dev", hidden = [];
  const clouds = parseCloudList([PRIMARY, entry(), entry({ id: "c-old", name: "Old", status: "ended", origin: OLD, removable: true })]);
  const savedOld = saved("home", [{ id: "old", kind: "remote", name: "Old", origin: OLD, cloud: { id: "c-old", role: "owner" } }]);
  const account = { state: () => session({ clouds }), offer: async () => null, hideCloud: async (id) => { hidden.push(id); return { outcome: "removed" }; } };
  const installed = rail({ places: () => railPlaces({ saved: savedOld, home: HOME, mine: HOME, state: session({ clouds }) }), account: () => account });
  const listedPlaces = (await installed.call("workspaces:places")).places;
  assert.equal(JSON.stringify(listedPlaces).includes("c-old"), false, "the page never sees which Cloud it is");
  assert.equal(listedPlaces.find(place => place.id === "old").removable, true);
  assert.deepEqual(await installed.call("workspaces:remove", "old"), { outcome: "removed" });
  assert.deepEqual(hidden, ["c-old"], "main's own word for the circle's Cloud");
  for (const id of ["a", "home", "acme", "c-old", "pending:c-old", { toString: () => "old" }]) {
    await assert.rejects(installed.call("workspaces:remove", id), /isn't here/, String(id));
  }
  assert.deepEqual(hidden, ["c-old"], "nothing else was asked");
  installed.w.lists = false;
  assert.throws(() => installed.call("workspaces:remove", "old"), /only available/, "any other page: refused");
  const older = rail({ places: () => railPlaces({ saved: savedOld, home: HOME, mine: HOME, state: session({ clouds }) }), account: () => ({ state: () => session({ clouds }), offer: async () => null }) });
  assert.deepEqual(await older.call("workspaces:remove", "old"), { outcome: "unsupported" }, "a main without Remove from list says so");
  // A Cloud still being made opens its own screen, by main's word for which Cloud it is.
  const making = rail({ places: () => railPlaces({ saved: saved(), home: HOME, mine: HOME, state: session({ clouds: parseCloudList([PRIMARY, entry({ id: "c-b", status: "checkout", origin: null })]) }) }) });
  await making.call("workspaces:open", "pending:c-b");
  assert.deepEqual(making.opened, ["cloud:c-b"], "its own screen, never a saved place or an address");
});

test("Make … my home: only on a server connected by hand that main offers it for, from the rail's own page, by main's own word for it", async () => {
  const offered = new Set(["vps"]), made = [];
  const r = rail({ places: () => railPlaces({ saved: saved("home", [{ id: "box", kind: "remote", name: "Box", origin: "https://box.example.test" }]), home: HOME, mine: HOME, state: session(),
    offers: entry => offered.has(entry.id) || entry.id === "home" || entry.id === "a" || entry.id === "acme" }), makeHome: id => { made.push(id); return { started: true }; } });
  const places = (await r.call("workspaces:places")).places;
  assert.deepEqual(places.filter(place => place.makeHome).map(place => place.id), ["vps"], "never My Cloud, another Cloud or a team's, whatever main says");
  assert.deepEqual(await r.call("workspaces:make-home", "vps"), { started: true });
  for (const id of ["box", "home", "a", "acme", "https://box.example.test", { toString: () => "vps" }]) {
    assert.throws(() => r.call("workspaces:make-home", id), /can't be your bots' home/, String(id));
  }
  assert.deepEqual(made, ["vps"]);
  offered.clear();
  assert.throws(() => r.call("workspaces:make-home", "vps"), /can't be your bots' home/, "no longer offered: refused");
  r.w.lists = false;
  assert.throws(() => r.call("workspaces:make-home", "vps"), /only available/, "any other page: refused");
  assert.throws(() => rail().call("workspaces:make-home", "vps"), /can't be your bots' home/, "a main that offers it nowhere");
});

const PRELOAD = readFileSync(new URL("./preload.cjs", import.meta.url), "utf8");
function preload(origin, { activation = false } = {}) {
  let bridge; const invoked = [];
  vm.runInNewContext(PRELOAD, {
    process: { platform: "darwin", argv: [`--omb-local-origin=${LOCAL}`, "--omb-company-desktop=1"] },
    location: { origin }, navigator: { userActivation: { isActive: activation } }, TextEncoder, localStorage: { getItem: () => null }, queueMicrotask,
    require: () => ({ webUtils: {}, contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } },
      ipcRenderer: { on() {}, removeListener() {}, send() {}, sendSync: () => null, invoke: (...args) => { invoked.push(args); return Promise.resolve(); } } }),
  });
  return { bridge, invoked };
}

test("a Cloud's page gets the rail and the add sheet's narrow bridges; a circle, ＋ and checkout open only from the person's click", async () => {
  const page = preload(HOME);
  assert.deepEqual(Object.keys(page.bridge.workspaces), ["state", "menu", "line", "places", "open", "add", "look", "color", "recolor", "remove", "makeHome", "onChanged"]);
  assert.deepEqual(Object.keys(page.bridge.cloudAdd), ["state", "start", "reopen", "copyLink", "open", "interest", "sheet", "organization"]);
  await page.bridge.workspaces.places();
  await page.bridge.cloudAdd.state();
  await assert.rejects(page.bridge.workspaces.open("a"), /Choose a place/);
  await assert.rejects(page.bridge.workspaces.add("link"), /Choose what to add/);
  await assert.rejects(page.bridge.cloudAdd.start("pro", "Client B", "rose"), /Continue to checkout/);
  await assert.rejects(page.bridge.cloudAdd.reopen(), /Reopen checkout/);
  await assert.rejects(page.bridge.cloudAdd.copyLink(), /Copy link/);
  await assert.rejects(page.bridge.cloudAdd.open(), /Open/);
  await assert.rejects(page.bridge.cloudAdd.organization("Client B", "rose"), /Create organization/);
  await assert.rejects(page.bridge.workspaces.color("rose"), /Choose a color/, "a page changes its place's colour only from the person's click");
  await assert.rejects(page.bridge.workspaces.recolor("vps", "rose"), /Choose a color/);
  await assert.rejects(page.bridge.workspaces.remove("old"), /Choose Remove from list/, "Remove from list only from the person's click");
  await assert.rejects(page.bridge.workspaces.makeHome("vps"), /Choose Make my home/, "a move starts only from the person's click");
  await page.bridge.workspaces.look();
  assert.deepEqual(page.invoked.at(-1), ["workspaces:look"]);
  const clicked = preload(HOME, { activation: true });
  await clicked.bridge.workspaces.open({ toString: () => "a" });
  await clicked.bridge.workspaces.add("link");
  await clicked.bridge.cloudAdd.start("pro", "Client B", null);
  await clicked.bridge.workspaces.color("rose");
  await clicked.bridge.workspaces.color(null);
  await clicked.bridge.cloudAdd.organization({ toString: () => "Client C" }, null);
  assert.deepEqual(clicked.invoked, [["workspaces:open", "a"], ["workspaces:add", "link"], ["cloud-add:start", "pro", "Client B", null], ["workspaces:color", "rose"], ["workspaces:color", null],
    ["cloud-add:organization", "Client C", null]]);
  await clicked.bridge.cloudAdd.start("team", "Studio", "blue", { toString: () => "app_whats_new_team" });
  assert.deepEqual(clicked.invoked.at(-1), ["cloud-add:start", "team", "Studio", "blue", "app_whats_new_team"], "a source travels as plain text");
  assert.equal(page.bridge.cloudAccount, undefined, "never the account bridge");
  const local = preload(LOCAL);
  await local.bridge.workspaces.open("a");
  assert.deepEqual(local.invoked, [["workspaces:open", "a"]], "this app's own page needs no click check");
});
