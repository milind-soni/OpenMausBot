import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import { listedColors, parseCloudList } from "./cloud-list.mjs";
import environments from "./environments.cjs";
import { railPlaces } from "./cloud-rail.mjs";
import { createHomePlaces } from "./home-places.mjs";
import { installPlaceLook, pageLook, placeLook, swatchOf } from "./place-look.mjs";

const HOME = "https://omb-u-1a2b3c4d5e6f.fly.dev", CLIENT_A = "https://omb-c-a.fly.dev", TEAM = "https://omb-t-acme.fly.dev", VPS = "https://bots.example.test";
const cloud = (over = {}) => ({ id: "c-a", name: "Client A", color: "green", role: "owner", tier: "pro", runsOn: "cloud", status: "ready", origin: CLIENT_A, teamId: null, primary: false, ...over });
const CLOUDS = parseCloudList([cloud({ id: "c-home", name: "My Cloud", color: null, origin: HOME, primary: true }), cloud(),
  cloud({ id: "c-acme", name: "Acme", color: "amber", teamId: "team-acme", role: "admin", origin: TEAM })]);
const home = { id: "home", kind: "remote", name: "Studio", origin: HOME, home: true, color: "purple" };
const own = { id: "a", kind: "remote", name: "Client A", origin: CLIENT_A, color: "teal", cloud: { id: "c-a", role: "owner" } };
const team = (role = "admin") => ({ id: "acme", kind: "remote", name: "Acme", origin: TEAM, team: { id: "team-acme", role } });
const typed = { id: "vps", kind: "remote", name: "Office", origin: VPS };

test("who changes a place's colour, and where it is kept: the Admin for a Cloud its owner or team admin opens, this app for This computer and a server connected by hand", () => {
  const session = { clouds: CLOUDS, homeOrigin: HOME };
  assert.deepEqual(placeLook(home, session), { name: "Studio", color: "purple", swatch: "violet", change: "admin", cloudId: "c-home" }, "My Cloud: the account's primary Cloud");
  assert.deepEqual(placeLook(own, session), { name: "Client A", color: "teal", swatch: "green", change: "admin", cloudId: "c-a" });
  assert.deepEqual(placeLook(team("admin"), session), { name: "Acme", color: null, swatch: null, change: "admin", cloudId: "c-acme" });
  assert.deepEqual(placeLook(typed, session), { name: "Office", color: null, swatch: null, change: "local" });
  assert.deepEqual(placeLook({ ...typed, color: "orange" }, session).swatch, null, "a colour no swatch has is shown, and none of the six is ticked");
  const member = parseCloudList([...CLOUDS.slice(0, 2), cloud({ id: "c-acme", name: "Acme", teamId: "team-acme", role: "member", origin: TEAM })]);
  assert.deepEqual(placeLook(team("admin"), { clouds: member, homeOrigin: HOME }), { name: "Acme", color: null, swatch: null, change: null, reason: "member" }, "the Admin's role is the word");
  assert.deepEqual(placeLook(team("member"), { clouds: null, homeOrigin: HOME }), { name: "Acme", color: null, swatch: null, change: null, reason: "member" }, "an older Admin: the team's role");
  assert.deepEqual(placeLook(team("owner"), { clouds: null, homeOrigin: HOME }).change, "local", "an older Admin keeps no colours: this app does");
  assert.deepEqual(placeLook(home, { clouds: null, homeOrigin: HOME }).change, "local");
  assert.deepEqual(placeLook(own, { clouds: null, homeOrigin: HOME }), { name: "Client A", color: "teal", swatch: "green", change: null, reason: "signed-out" },
    "another Cloud of theirs while the sign-in is away: a colour saved here alone would be undone");
  assert.deepEqual(placeLook({ ...home, home: undefined }, session).cloudId, "c-home", "My Cloud by its address too");
  for (const none of [null, undefined]) assert.equal(placeLook(none, session), null);
  for (const signedIn of [session, { clouds: null, homeOrigin: null }]) {
    assert.deepEqual(placeLook(environments.savedPlace({ activeId: "local", environments: [] }), signedIn), { name: "This computer", color: null, swatch: null, change: "local" },
      "This computer, signed in or not: plain until the person picks a colour, which this app keeps");
  }
  assert.deepEqual(placeLook({ id: "lab", kind: "local", name: "Lab", dataDir: "/x", color: "teal" }, session), { name: "Lab", color: "teal", swatch: "green", change: "local" },
    "a named folder on this computer has its own");
  assert.deepEqual(pageLook(placeLook(own, session)), { name: "Client A", color: "teal", swatch: "green", change: "admin" }, "the page never sees the Cloud's id");
  assert.deepEqual(["blue", "teal", "yellow", "red", "purple", "orange", null, "url(x)"].map(swatchOf), ["blue", "green", "amber", "rose", "violet", null, null, null]);
});

function ipc({ entry, clouds = CLOUDS, answer = { outcome: "saved" } } = {}) {
  const handlers = new Map(), asked = [], saved = [];
  let state = { activeId: entry?.id ?? "local", environments: entry ? [entry] : [] };
  installPlaceLook({ ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }, guard: handler => handler,
    place: () => environments.savedPlace(state), session: () => ({ clouds, homeOrigin: HOME }),
    setColor: async (id, swatch) => { asked.push([id, swatch]); return answer; },
    save: (id, color) => { saved.push([id, color]); state = environments.withPlaceColor(state, id, color); } });
  return { asked, saved, state: () => state, call: (channel, ...args) => handlers.get(channel)({ sender: {} }, ...args) };
}

test("a page changes only its own place's colour: a Cloud's on the Admin first, then here at once; a member's, an older Admin's and a failure change nothing", async () => {
  const admin = ipc({ entry: own });
  assert.deepEqual(await admin.call("workspaces:look"), { name: "Client A", color: "teal", swatch: "green", change: "admin" });
  assert.deepEqual(await admin.call("workspaces:color", "rose"), { outcome: "saved", look: { name: "Client A", color: "red", swatch: "rose", change: "admin" } });
  assert.deepEqual([admin.asked, admin.saved], [[["c-a", "rose"]], [["a", "red"]]]);
  assert.deepEqual((await admin.call("workspaces:color", "slate")).look.color, null, "slate is the plain one: no colour, the look of today");
  await assert.rejects(admin.call("workspaces:color", "chartreuse"), /Choose one of the colors/);
  await assert.rejects(admin.call("workspaces:color", { toString: () => "rose" }), /Choose one of the colors/);

  const member = ipc({ entry: team("member"), clouds: null });
  assert.deepEqual(await member.call("workspaces:color", "rose"), { outcome: "refused", look: { name: "Acme", color: null, swatch: null, change: null, reason: "member" } });
  assert.deepEqual([member.asked, member.saved], [[], []], "a member's choice reaches neither the Admin nor this app");

  for (const outcome of ["refused", "unsupported", "failed"]) {
    const refused = ipc({ entry: own, answer: { outcome } });
    assert.deepEqual((await refused.call("workspaces:color", "rose")).outcome, outcome);
    assert.deepEqual(refused.saved, [], `${outcome}: nothing saved here, so nothing shows a colour the Admin doesn't keep`);
  }

  const local = ipc({ entry: typed });
  assert.deepEqual(await local.call("workspaces:color", "amber"), { outcome: "saved", look: { name: "Office", color: "yellow", swatch: "amber", change: "local" } });
  assert.deepEqual([local.asked, local.saved], [[], [["vps", "yellow"]]], "a server connected by hand: this app's own");

  for (const clouds of [CLOUDS, null]) {
    const computer = ipc({ entry: null, clouds });
    assert.deepEqual(await computer.call("workspaces:look"), { name: "This computer", color: null, swatch: null, change: "local" }, "this computer's page: plain until a colour is picked");
    assert.deepEqual(await computer.call("workspaces:color", "rose"), { outcome: "saved", look: { name: "This computer", color: "red", swatch: "rose", change: "local" } });
    assert.deepEqual([computer.asked, computer.saved, computer.state().localColor], [[], [["local", "red"]], "red"],
      "this computer's colour is this app's own, kept beside its saved places, whether or not it is signed in to MausBot Cloud");
    assert.deepEqual(await computer.call("workspaces:look"), { name: "This computer", color: "red", swatch: "rose", change: "local" }, "read back as chosen");
    assert.deepEqual(await computer.call("workspaces:color", "slate"), { outcome: "saved", look: { name: "This computer", color: null, swatch: null, change: "local" } }, "None: plain again");
    assert.equal(Object.hasOwn(computer.state(), "localColor"), false);
  }
});

test("main's own wiring: This computer's page reads and changes its own colour, kept with this app's saved places, no Admin asked", async () => {
  const source = readFileSync(new URL("./main.mjs", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const start = source.indexOf("installPlaceLook({ ipcMain, guard: workspaceOnly"), end = source.indexOf('ipcMain.handle("sharing:state"', start);
  assert.ok(start >= 0 && end > start, "main installs the colour's channels");
  const handlers = new Map(), persisted = [];
  const context = vm.createContext({ installPlaceLook, savedPlace: environments.savedPlace, withPlaceColor: environments.withPlaceColor,
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }, workspaceOnly: handler => handler,
    environmentsState: { environments: [typed], activeId: "local" }, desktopRemoteAccess: null, cloudAccount: null, myCloud: () => null,
    ensureCloudAccount: () => { throw new Error("This computer's colour never asks the Admin"); },
    persistEnvironments: next => { persisted.push(next); context.environmentsState = next; },
    chromeRail: { owns: () => false }, railList: () => [] });
  vm.runInContext(source.slice(start, end), context);
  const call = (channel, ...args) => handlers.get(channel)({ sender: {} }, ...args);
  assert.deepEqual(await call("workspaces:look"), { name: "This computer", color: null, swatch: null, change: "local" }, "plain until a colour is picked");
  assert.deepEqual((await call("workspaces:color", "amber")).look, { name: "This computer", color: "yellow", swatch: "amber", change: "local" });
  assert.deepEqual([persisted.length, context.environmentsState.localColor, context.environmentsState.environments], [1, "yellow", [typed]],
    "kept beside the saved places, signed out of MausBot Cloud");
  assert.equal(environments.parseEnvironments(environments.serializeEnvironments(context.environmentsState)).localColor, "yellow", "and in the file");
  assert.deepEqual((await call("workspaces:color", "slate")).look.color, null, "None");
  assert.equal(Object.hasOwn(context.environmentsState, "localColor"), false);
});

test("the window's rail changes the colour of any place it lists, whatever its server runs: this app's for This computer and a server connected by hand, the Admin's for a Cloud and a signed-in server; never from a page, never an unlisted place", async () => {
  const handlers = new Map(), asked = [], saved = [], RAIL = { id: "rail" };
  const clouds = parseCloudList([CLOUDS[0], CLOUDS[1], cloud({ id: "c-acme", name: "Acme", teamId: "team-acme", role: "member", origin: TEAM }),
    cloud({ id: "s-mini", name: "Mac mini", color: null, tier: null, runsOn: "server", managed: false, status: "ready", origin: null })]);
  let state = { activeId: "home", environments: [home, own, team("member"), typed] };
  const listed = () => railPlaces({ saved: state, home: null, mine: HOME, state: { status: "connected", clouds } });
  installPlaceLook({ ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }, guard: handler => handler,
    place: () => state.environments.find(candidate => candidate.id === state.activeId) ?? null, session: () => ({ clouds, homeOrigin: HOME }),
    setColor: async (id, swatch) => { asked.push([id, swatch]); return { outcome: "saved" }; },
    save: (id, color) => { saved.push([id, color]); state = environments.withPlaceColor(state, id, color); },
    rail: { owns: event => event.sender === RAIL, places: listed, saved: id => environments.savedPlace(state, id) } });
  const recolor = (sender, ...args) => handlers.get("workspaces:recolor")({ sender }, ...args);
  assert.deepEqual(await recolor(RAIL, "vps", "amber"), { outcome: "saved", look: { name: "Office", color: "yellow", swatch: "amber", change: "local" } },
    "a server connected by hand, whatever release it runs: this app keeps it");
  assert.deepEqual(listed().find(place => place.id === "vps").paint, { swatch: "amber" }, "its circle follows");
  assert.equal((await recolor(RAIL, "a", "rose")).outcome, "saved");
  assert.equal((await recolor(RAIL, "signed-in:s-mini", "blue")).outcome, "saved");
  assert.deepEqual(asked, [["c-a", "rose"], ["s-mini", "blue"]], "a Cloud's and a signed-in server's on the Admin");
  assert.deepEqual(saved, [["vps", "yellow"], ["a", "red"]], "a signed-in server not saved here has nothing here to change");
  assert.deepEqual(await recolor(RAIL, "acme", "rose"), { outcome: "refused", look: { name: "Acme", color: null, swatch: null, change: null, reason: "member" } });
  assert.equal(asked.length, 2, "a member's choice reaches nobody");
  assert.throws(() => recolor({ id: "page" }, "vps", "rose"), /only available to the window's rail/, "no place's page, not even this computer's");
  await assert.rejects(recolor(RAIL, "somewhere", "rose"), /isn't here/);
  await assert.rejects(recolor(RAIL, "vps", "chartreuse"), /Choose one of the colors/);
  assert.deepEqual(listed()[0], { id: "local", name: "This computer", color: null, kind: "computer", opens: true, paint: { swatch: null } }, "This computer's circle: plain, with a menu");
  assert.deepEqual(await recolor(RAIL, "local", "violet"), { outcome: "saved", look: { name: "This computer", color: "purple", swatch: "violet", change: "local" } });
  assert.deepEqual([asked.length, saved.at(-1), state.localColor], [2, ["local", "purple"], "purple"], "This computer's from its circle: this app's own, no Admin asked");
  assert.deepEqual(listed()[0], { id: "local", name: "This computer", color: "purple", kind: "computer", opens: true, paint: { swatch: "violet" } }, "its circle follows");
});

test("a saved place's colour: set, cleared to none, an unknown one ignored; the Admin's for My Cloud and teams once chosen there", () => {
  const state = { activeId: "home", environments: [home, own, team("member"), typed, { id: "lab", kind: "local", name: "Lab", dataDir: "/x" }] };
  const red = environments.withPlaceColor(state, "vps", "red");
  assert.equal(red.environments.find(entry => entry.id === "vps").color, "red");
  assert.equal(environments.withPlaceColor(red, "vps", "red"), red, "the same state when nothing changes");
  assert.equal(Object.hasOwn(environments.withPlaceColor(red, "vps", null).environments.find(entry => entry.id === "vps"), "color"), false);
  for (const [id, color] of [["vps", "chartreuse"], ["local", "url(x)"], ["lab", "teal;"], ["gone", "red"]]) assert.equal(environments.withPlaceColor(state, id, color), state, `${id} ${color}`);

  const looks = listedColors(parseCloudList([cloud({ id: "c-home", name: "My Cloud", color: "rose", origin: HOME, primary: true }),
    cloud({ id: "c-acme", name: "Acme", color: "slate", teamId: "team-acme", role: "member", origin: TEAM })]));
  const listed = environments.withListedColors({ ...state, environments: state.environments.map(entry => (entry.id === "acme" ? { ...entry, color: "blue" } : entry)) }, looks, HOME);
  assert.deepEqual(listed.environments.map(entry => [entry.id, entry.color ?? null]), [["home", "red"], ["a", "teal"], ["acme", null], ["vps", null], ["lab", null]]);
  assert.equal(environments.withListedColors(state, listedColors(parseCloudList([cloud({ id: "c-home", name: "My Cloud", color: null, origin: HOME, primary: true })])), HOME), state,
    "none chosen on the Admin yet: the colour picked when the Cloud was set up stays");
});

test("This computer's colour: none in a file written before there was one, kept beside the saved places once picked, cleared by None, and kept when a server is forgotten", () => {
  const before = environments.parseEnvironments(JSON.stringify({ version: 2, environments: [typed], activeId: "local" }));
  assert.deepEqual([environments.savedPlace(before).color, Object.hasOwn(before, "localColor")], [undefined, false], "someone updating sees no change: plain");
  const teal = environments.withPlaceColor(before, "local", "teal");
  assert.deepEqual([teal.localColor, teal.environments], ["teal", before.environments], "no saved place is made for it");
  assert.equal(environments.withPlaceColor(teal, "local", "teal"), teal, "the same state when nothing changes");
  const written = environments.serializeEnvironments(teal);
  assert.equal(JSON.parse(written).localColor, "teal");
  assert.deepEqual(environments.parseEnvironments(written), teal, "read back after a restart");
  const none = environments.withPlaceColor(teal, "local", null);
  assert.deepEqual([Object.hasOwn(none, "localColor"), Object.hasOwn(JSON.parse(environments.serializeEnvironments(none)), "localColor")], [false, false], "None: plain again, and nothing left in the file");
  assert.equal(environments.withoutEnvironment(teal, "vps").localColor, "teal", "forgetting a server keeps it");
  assert.equal(environments.parseEnvironments(JSON.stringify({ version: 2, environments: [], activeId: "local", localColor: "url(x)" })).localColor, undefined,
    "a colour this app doesn't draw is never read");

  const lab = environments.withPlaceColor({ ...teal, environments: [...teal.environments, { id: "lab", kind: "local", name: "Lab", dataDir: "/x" }] }, "lab", "purple");
  assert.deepEqual([environments.savedPlace(lab, "lab").color, lab.localColor], ["purple", "teal"], "a named folder on this computer keeps a colour of its own");
  assert.equal(environments.parseEnvironments(environments.serializeEnvironments(lab)).environments.find(entry => entry.id === "lab").color, "purple");
  const row = id => environments.workspaceMenuTemplate(lab, { onSwitch() {}, onConnect() {}, onForget() {}, iconFor: color => `dot:${color}` }).find(item => item.id === id);
  assert.deepEqual([row("workspace-local").icon, row("workspace-lab").icon], ["dot:teal", "dot:purple"], "the switcher shows each one's dot, as it does a server's");
  assert.equal("icon" in environments.workspaceMenuTemplate(before, { onSwitch() {}, onConnect() {}, onForget() {}, iconFor: color => `dot:${color}` }).find(item => item.id === "workspace-local"), false);
});

test("home places: the session's colours reach the saved places, and a team member sees the colour its admins chose", () => {
  let state = { activeId: "home", environments: [home, team("member")] };
  const places = createHomePlaces({ store: { read: () => ({}), write() {} }, environments: () => state, persist: next => { state = next; }, makeId: () => "new", homeOrigin: () => HOME });
  places.sync({ status: "connected", teams: [{ id: "team-acme", name: "Acme", role: "member", machine: { status: "ready", origin: TEAM } }],
    clouds: parseCloudList([cloud({ id: "c-home", name: "My Cloud", color: "green", origin: HOME, primary: true }), cloud({ id: "c-acme", name: "Acme", color: "violet", teamId: "team-acme", role: "member", origin: TEAM })]) });
  assert.deepEqual(state.environments.map(entry => [entry.id, entry.color]), [["home", "teal"], ["acme", "purple"]]);
  const before = state;
  places.sync({ status: "connected", teams: [{ id: "team-acme", name: "Acme", role: "member", machine: { status: "ready", origin: TEAM } }] });
  assert.equal(state, before, "an older Admin lists no colours: the saved ones stay");
});
