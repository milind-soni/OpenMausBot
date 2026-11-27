// A server of the person's own (this desktop paired there as its admin) gets this computer once the person allows it, with
// no maintainer flag: the popup after pairing and Settings' switch (server-lending.mjs), what is lent, Not now, Stop,
// Pause, a new pairing, and the pairings that never count as their own.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { createComputerSharing, ownServerSession } from "./computer-sharing.mjs";
import { createLendingIndicator } from "./lending-indicator.mjs";
import { installServerLending } from "./server-lending.mjs";
import { ownServerRefusal } from "./own-server-refusal.mjs";
import { cloudPageSenderAllowed } from "./cloud-home.mjs";
import { screenStatus } from "./screen-status.mjs";

const GARAGE = "http://192.168.1.20:8799";
const garage = { id: "garage", name: "Garage", origin: GARAGE, kind: "remote" };

const until = async (check, what, ms = 5000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await check()) return; await delay(10); }
  assert.fail(`timed out waiting for ${what}`);
};

async function scratch(t) {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "omb-lend-own-server-")));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  return dir;
}

/** A self-hosted server as this desktop's sign-in there sees it: `scopes`, whether nobody else signs in there (`own`, which
 * the server says only to its one owner, with what it takes from them), and whether it is a team's or a Cloud. Its public
 * description offers no lending, as before pairing. */
function selfHosted({ scopes = ["admin", "client"], own = true, extra = {}, mcp = true, caller = false } = {}) {
  const json = (value, status = 200) => ({ ok: status < 400, status, headers: { get: () => null }, body: (async function* () { yield Buffer.from(JSON.stringify(value)); })() });
  const state = { environmentId: randomUUID(), sessionId: randomUUID(), scopes, own, extra, connects: [], disconnects: [], polls: 0 };
  state.fetch = async (url, init) => {
    const route = new URL(url).pathname;
    const owner = state.own && state.scopes.includes("admin");
    if (route === "/api/auth/session") return json({ kind: "session", id: state.sessionId, scopes: state.scopes, ...(owner ? { own: true, lending: { sharedComputers: true, lendingDetails: true, fileEdits: true, ...(mcp ? { lentMcp: true } : {}), ...(mcp && caller ? { mcpCaller: true } : {}) } } : {}), ...state.extra });
    if (route === "/.well-known/openmausbot/environment") return json({ environmentId: state.environmentId, capabilities: { remoteSessions: true } });
    const body = init?.body ? JSON.parse(init.body) : {};
    if (route === "/api/shared-computers/connect") { state.connects.push(body); return json({ ok: true }); }
    if (route.endsWith("/poll")) {
      state.polls++;
      await delay(50, undefined, { signal: init?.signal }).catch(() => {});
      init?.signal?.throwIfAborted();
      return json({ job: null });
    }
    if (route.endsWith("/disconnect")) { state.disconnects.push(body); return json({ ok: true }); }
    return json({ ok: true });
  };
  return state;
}

/** This desktop with the maintainer flag off, lending as main wires it; `restart()` is the app opening again. */
async function desktop(t, server, { ownClouds = () => [] } = {}) {
  const dir = await scratch(t);
  const file = path.join(dir, "profile", "computer-sharing.json");
  const summaries = [];
  const make = () => createComputerSharing({ file, environments: () => [garage], enabled: async () => false, home: path.join(dir, "home"), cuaConnection: async () => null,
    fetch: (url, init) => server.fetch(url, init), ownClouds, localEnvironments: () => [server.environmentId], onChange: summary => summaries.push(summary) });
  let sharing = make();
  t.after(() => sharing.close());
  return { file, summaries, get sharing() { return sharing; }, restart: () => { sharing.close(); sharing = make(); sharing.start({ maintainer: false }); return sharing; } };
}

test("only this desktop's admin pairing on a server that is no Cloud, team or hosted workspace counts as the person's own", () => {
  const owner = { kind: "session", id: randomUUID(), scopes: ["admin", "client"], own: true };
  assert.equal(ownServerSession(owner), true);
  assert.equal(ownServerSession({ ...owner, own: undefined }), false, "a server others sign in to");
  assert.equal(ownServerSession({ ...owner, scopes: ["client"] }), false, "a narrower pairing");
  assert.equal(ownServerSession({ ...owner, scopes: undefined }), false);
  assert.equal(ownServerSession({ ...owner, team: { id: "t", role: "admin" } }), false, "a team's server");
  assert.equal(ownServerSession({ ...owner, cloudHome: true }), false, "a Cloud is lent by its own rules");
  assert.equal(ownServerSession({ ...owner, hosted: true }), false);
  assert.equal(ownServerSession({ ...owner, kind: "loopback" }), false);
  // Why not, in one word the app turns into one line.
  assert.equal(ownServerRefusal(owner), null);
  assert.equal(ownServerRefusal({ ...owner, own: undefined }), "shared");
  assert.equal(ownServerRefusal({ ...owner, scopes: ["client"] }), "not-owner");
  assert.equal(ownServerRefusal({ ...owner, team: { id: "t", role: "admin" } }), "team");
  assert.equal(ownServerRefusal({ ...owner, cloudHome: true }), "cloud");
  assert.equal(ownServerRefusal(undefined), "not-owner");
});

test("ownRefusal asks the server itself: its own when it is, why not when it isn't", async t => {
  const mine = await desktop(t, selfHosted());
  assert.equal(await mine.sharing.ownRefusal(garage), null);
  const shared = await desktop(t, selfHosted({ own: false }));
  assert.equal(await shared.sharing.ownRefusal(garage), "shared");
  const narrow = await desktop(t, selfHosted({ scopes: ["client"] }));
  assert.equal(await narrow.sharing.ownRefusal(garage), "not-owner");
  const team = await desktop(t, selfHosted({ extra: { team: { id: "t", role: "admin" } } }));
  assert.equal(await team.sharing.ownRefusal(garage), "team");
});

test("once the person allows it, a server of their own gets the apps on the screen and its MCP servers, with the maintainer flag off; no folder or terminal unless chosen", async t => {
  const server = selfHosted();
  const mac = await desktop(t, server);
  const info = await mac.sharing.ownOffer(garage);
  assert.deepEqual(info, { sessionId: server.sessionId, environmentId: server.environmentId });
  assert.equal(server.connects.length, 0, "asking lends nothing");
  const lent = await mac.sharing.lendOwn(garage, { folders: [], terminal: false, computer: true });
  assert.equal(lent.own, true);
  assert.equal(lent.enabled, true);
  await until(() => server.connects.length === 1 && mac.sharing.state(garage.id).connected, "the server to take this computer");
  const [connect] = server.connects;
  assert.deepEqual({ computer: connect.computer, terminal: connect.terminal, folders: connect.folders, mcpServers: connect.mcpServers, environments: connect.environments, fileEdits: connect.fileEdits },
    { computer: true, terminal: false, folders: [], mcpServers: true, environments: [server.environmentId], fileEdits: true });
  assert.equal("internet" in connect || "chrome" in connect, false, "the device link is a Cloud's alone");
  assert.equal("mcpCaller" in connect, false, "an older server refuses fields it does not know");
  assert.equal(await mac.sharing.ownOffer(garage), null, "answered for this pairing");
  assert.deepEqual(mac.summaries.at(-1).lending, [garage.id]);
  assert.deepEqual(mac.summaries.at(-1).clouds, ["Garage"], "the menu-bar item names it like a Cloud");
  assert.equal(mac.summaries.at(-1).terminalSwitch, false, "the Clouds' terminal switch stays out of the menu without a Cloud");
});

test("a server of their own that takes an MCP call's caller hears that this computer passes it on", async t => {
  const server = selfHosted({ caller: true });
  const mac = await desktop(t, server);
  await mac.sharing.ownOffer(garage);
  await mac.sharing.lendOwn(garage, { folders: [], terminal: false, computer: true });
  await until(() => server.connects.length === 1 && mac.sharing.state(garage.id).connected, "the server to take this computer");
  assert.deepEqual({ mcpServers: server.connects[0].mcpServers, mcpCaller: server.connects[0].mcpCaller }, { mcpServers: true, mcpCaller: true });
});

test("a narrower pairing, a server others sign in to, a team's server or a Cloud is never asked about and is never lent", async t => {
  for (const [what, server] of [["client scope", selfHosted({ scopes: ["client"] })], ["others sign in there", selfHosted({ own: false })], ["team", selfHosted({ extra: { team: { id: "t", role: "admin" } } })], ["Cloud", selfHosted({ extra: { cloudHome: true } })]]) {
    const mac = await desktop(t, server);
    assert.equal(await mac.sharing.ownServer(garage), null, what);
    assert.equal(await mac.sharing.ownOffer(garage), false, what);
    await assert.rejects(mac.sharing.lendOwn(garage, { computer: true }), /Only your own server can use this computer/, what);
    await delay(30);
    assert.equal(server.connects.length, 0, what);
    assert.equal(mac.sharing.state(garage.id).enabled, false, what);
  }
});

test("Not now lends nothing and this pairing is not asked again; pairing again asks again", async t => {
  const server = selfHosted();
  const mac = await desktop(t, server);
  const info = await mac.sharing.ownOffer(garage);
  mac.sharing.declineOwn(garage, info);
  assert.equal(await mac.sharing.ownOffer(garage), null);
  mac.restart();
  await delay(50);
  assert.equal(server.connects.length, 0);
  assert.equal(mac.sharing.state(garage.id).enabled, false);
  server.sessionId = randomUUID();
  assert.deepEqual(await mac.sharing.ownOffer(garage), { sessionId: server.sessionId, environmentId: server.environmentId });
});

test("Stop ends it at once: the server is told, polling stops, and it stays off after the app opens again", async t => {
  const server = selfHosted();
  const mac = await desktop(t, server);
  await mac.sharing.lendOwn(garage, { computer: true });
  await until(() => server.polls > 0, "the first poll");
  const stopped = mac.sharing.revoke(garage);
  assert.equal(stopped.enabled, false);
  await until(() => server.disconnects.length === 1, "the server to be told");
  const polls = server.polls;
  await delay(150);
  assert.equal(server.polls, polls, "nothing polls after Stop");
  mac.restart();
  await delay(80);
  assert.equal(server.connects.length, 1, "Stop lasts across restarts");
  assert.equal(await mac.sharing.ownOffer(garage), null, "Stop is an answer too");
});

test("a new pairing of the same server keeps lending; that server getting other people, or another server behind the address, ends it", async t => {
  const server = selfHosted();
  const mac = await desktop(t, server);
  await mac.sharing.lendOwn(garage, { computer: true });
  await until(() => server.connects.length === 1, "lending to start");
  server.sessionId = randomUUID();
  mac.restart();
  await until(() => server.connects.length === 2, "lending to go on after pairing again");
  assert.equal(JSON.parse(await readFile(mac.file, "utf8")).records.garage.sessionId, server.sessionId, "bound to the new pairing");

  server.own = false;
  mac.restart();
  await until(() => mac.sharing.state(garage.id).problem === "not-own", "lending to end");
  assert.equal(mac.sharing.state(garage.id).enabled, false);
  assert.equal(server.connects.length, 2, "nothing is lent to a narrower pairing");

  const other = selfHosted();
  const moved = await desktop(t, other);
  await moved.sharing.lendOwn(garage, { computer: true });
  await until(() => other.connects.length === 1, "lending to start");
  other.environmentId = randomUUID();
  moved.restart();
  await until(() => moved.sharing.state(garage.id).problem === "machine-changed", "lending to another server to end");
  assert.equal(other.connects.length, 1);
});

test("Pause holds a server of the person's own as it holds Clouds, across restarts, and Resume lends again", async t => {
  const server = selfHosted();
  const mac = await desktop(t, server);
  await mac.sharing.lendOwn(garage, { computer: true });
  await until(() => server.connects.length === 1, "lending to start");
  mac.sharing.pause();
  assert.equal(mac.sharing.state(garage.id).problem, "paused", "Pause is instant, as for a Cloud");
  await until(() => server.disconnects.length === 1, "the server to be told");
  assert.equal(mac.sharing.state(garage.id).paused, true);
  assert.deepEqual({ paused: mac.summaries.at(-1).paused, clouds: mac.summaries.at(-1).clouds, lending: mac.summaries.at(-1).lending }, { paused: true, clouds: ["Garage"], lending: [] });
  mac.restart();
  await delay(80);
  assert.equal(server.connects.length, 1, "still paused after the app opens again");
  assert.equal(server.disconnects.length, 1, "nothing even dials it while paused");
  await mac.sharing.resume();
  await until(() => server.connects.length === 2, "Resume to lend again");
});

test("the menu-bar item keeps its Clouds' terminal switch only while a Cloud is signed in here", () => {
  const menus = [];
  const tray = createLendingIndicator({ Tray: class { setToolTip() {} setTitle() {} setContextMenu(menu) { menus.push(menu); } on() {} isDestroyed() { return false; } destroy() {} },
    Menu: { buildFromTemplate: items => items }, nativeImage: { createFromPath: () => ({ resize: () => ({}) }) }, iconPath: "", onPause() {}, onResume() {}, onActivity() {}, onTerminal() {}, device: "Mac" });
  const labels = () => menus.at(-1).map(item => item.label);
  tray.update({ clouds: ["Garage"], terminalSwitch: false });
  assert.deepEqual(labels(), ["Garage can use this Mac", undefined, "Pause", "See activity"]);
  tray.update({ clouds: ["My Cloud", "Garage"], terminalSwitch: true });
  assert.ok(labels().includes("Let Clouds run commands on this Mac"));
});

/** main's channels and popup, with this desktop's lending and native dialogs stood in for. */
function mainLending({ response = 1, own = true, flag = false, offer, refusal = "shared", openSettings = () => {}, screen = async () => ({ ready: true, lent: true, reason: null, fix: null }), now = () => 1_000 } = {}) {
  const handlers = new Map(), calls = { lent: [], declined: [], saved: [], revoked: [], boxes: [] };
  const win = { isDestroyed: () => false, webContents: { getURL: () => `${GARAGE}/` } };
  const info = { sessionId: randomUUID(), environmentId: randomUUID() };
  const records = {};
  const controller = {
    state: id => records[id] ?? { enabled: false, folders: [], terminal: false, computer: false },
    ownServer: async () => (own ? info : null),
    ownRefusal: async () => (own ? null : refusal),
    ownOffer: async () => (offer !== undefined ? offer : own ? info : false),
    lendOwn: async (env, grant) => { calls.lent.push([env.id, grant]); records[env.id] = { enabled: true, own: true, ...grant }; return records[env.id]; },
    declineOwn: (env, seen) => { calls.declined.push([env.id, seen]); },
    revoke: env => { calls.revoked.push(env.id); records[env.id] = { ...records[env.id], enabled: false }; return records[env.id]; },
    identity: async () => info, save: async (env, grant) => { calls.saved.push([env.id, grant]); return {}; }, observe: async () => info, decline: () => {}, activity: () => [],
  };
  const dialog = { showMessageBox: async (...args) => { calls.boxes.push(args.at(-1)); return { response }; } };
  const lending = installServerLending({ ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }, guard: (_channel, handler) => handler, sharing: () => controller,
    dialogs: { chooseFolder: async () => null, confirmServerAccess: async () => true }, validate: async folders => folders ?? [], dialog, window: () => win,
    saved: id => { if (id !== garage.id) throw new Error("unknown"); return garage; }, candidate: env => !env.cloud && !env.team && !env.home, flag: async () => flag,
    environments: () => [garage, { id: "acme", name: "Acme", origin: "https://omb-t-acme.fly.dev", team: { id: "t" } }], active: () => garage, openSettings,
    // This app's own page sends an empty event here; the server's own page sends { page: env }.
    local: event => !event?.page && !event?.other, page: event => event?.page ?? null, screen, allowScreen: async () => { calls.allowScreen = (calls.allowScreen ?? 0) + 1; }, now });
  return { handlers, calls, lending, win, info };
}

test("after pairing a server of the person's own, no popup: the add form's switch, when on, lends the apps on the screen", async () => {
  const quiet = mainLending({ response: 0 });
  await quiet.lending.offer(quiet.win);
  assert.deepEqual(quiet.calls.boxes, [], "the question lives in the add form and on the server's row, never in a popup");
  assert.deepEqual(quiet.calls.lent, []);

  const wished = mainLending({ response: 1 });
  assert.equal(await wished.handlers.get("lend:wish")({}, "192.168.1.20:8799", true), true);
  await wished.lending.offer(wished.win);
  assert.deepEqual(wished.calls.boxes, [], "the switch was the person's answer");
  assert.deepEqual(wished.calls.lent, [["garage", { folders: [], terminal: false, computer: true }]]);
  await wished.lending.offer(wished.win);
  assert.equal(wished.calls.lent.length, 1, "a wish is used once");

  const unwished = mainLending();
  await unwished.handlers.get("lend:wish")({}, "http://192.168.1.20:8799", true);
  await unwished.handlers.get("lend:wish")({}, "http://192.168.1.20:8799", false);
  await unwished.lending.offer(unwished.win);
  assert.deepEqual(unwished.calls.lent, [], "the switch turned off again");

  let clock = 1_000;
  const stale = mainLending({ now: () => clock });
  await stale.handlers.get("lend:wish")({}, "192.168.1.20", true);
  clock += 11 * 60_000;
  await stale.lending.offer(stale.win);
  assert.deepEqual(stale.calls.lent, [], "an old wish lends nothing");

  const typed = mainLending();
  await typed.handlers.get("lend:wish")({}, "192.168.1.20", true);
  await typed.handlers.get("lend:wish")({}, "192.168.1.2", true);
  await typed.lending.offer(typed.win);
  assert.deepEqual(typed.calls.lent, [], "only the address as last typed is wished for");

  const elsewhere = mainLending();
  await elsewhere.handlers.get("lend:wish")({}, "other.example", true);
  await elsewhere.lending.offer(elsewhere.win);
  assert.deepEqual(elsewhere.calls.lent, [], "a wish is for the server it was typed for");
  await assert.rejects(elsewhere.handlers.get("lend:wish")({ page: garage }, "192.168.1.20", true), /main desktop window/, "a server's page can't wish itself lent");

  const answered = mainLending({ response: 0, offer: null });
  await answered.handlers.get("lend:wish")({}, "192.168.1.20", true);
  await answered.lending.offer(answered.win);
  assert.deepEqual(answered.calls.lent, [], "a pairing already answered keeps its answer");

  const notOwn = mainLending({ response: 0, own: false });
  await notOwn.lending.offer(notOwn.win);
  assert.deepEqual(notOwn.calls.boxes, [], "another server is asked about only while the maintainer flag is on");
  assert.deepEqual(notOwn.calls.lent, []);
});

test("Settings: each server of the person's own has the switch, which asks the same popup; turning it off needs no flag", async () => {
  const { handlers, calls } = mainLending({ response: 0 });
  assert.deepEqual(await handlers.get("sharing:servers")({}), [{ id: "garage", enabled: false, connected: false, paused: false }], "never the team's server");
  assert.equal((await handlers.get("sharing:state")({}, "garage")).own, true, "its state reads without the maintainer flag");
  const lent = await handlers.get("sharing:allow")({}, "garage");
  assert.equal(lent.enabled, true);
  assert.equal(calls.boxes[0].message, "Let Garage use this computer?");
  assert.deepEqual(calls.lent, [["garage", { folders: [], terminal: false, computer: true }]]);
  await handlers.get("sharing:save")({}, "garage", { folders: [], terminal: true, computer: true });
  assert.deepEqual(calls.lent.at(-1), ["garage", { folders: [], terminal: true, computer: true }], "a change lends as theirs, never through the maintainer path");
  assert.deepEqual(calls.saved, []);
  await handlers.get("sharing:revoke")({}, "garage");
  assert.deepEqual(calls.revoked, ["garage"]);

  const declined = mainLending({ response: 1 });
  assert.equal(await declined.handlers.get("sharing:allow")({}, "garage"), null);
  assert.deepEqual(declined.calls.lent, []);

  const other = mainLending({ own: false });
  await assert.rejects(other.handlers.get("sharing:allow")({}, "garage"), /Only your own server/);
  await assert.rejects(other.handlers.get("sharing:state")({}, "garage"), /turned off on this server/, "another server still needs the maintainer flag");
  assert.deepEqual(await other.handlers.get("sharing:servers")({}), []);
  await other.handlers.get("sharing:revoke")({}, "garage");
  assert.deepEqual(other.calls.revoked, ["garage"], "stopping never needs a flag");
});

test("the switch: one tap on this app's own page lends and stops at once; a server's own page gets main's popup first", async () => {
  const here = mainLending({ response: 1 });
  assert.deepEqual(await here.handlers.get("lend:state")({}, "garage"), { name: "Garage", lendable: true, on: false, connected: false, paused: false });
  const on = await here.handlers.get("lend:set")({}, "garage", true);
  assert.equal(on.on, true);
  assert.deepEqual(here.calls.boxes, [], "no popup from this app's own page");
  assert.deepEqual(here.calls.lent, [["garage", { folders: [], terminal: false, computer: true }]]);
  assert.equal((await here.handlers.get("lend:set")({}, "garage", false)).on, false);
  assert.deepEqual(here.calls.revoked, ["garage"]);

  // The server's own page (its Screen panel): about that server only, whatever id it sends.
  const page = mainLending({ response: 1 });
  assert.equal((await page.handlers.get("lend:set")({ page: garage }, "acme", true)).on, false, "Not now lends nothing");
  assert.equal(page.calls.boxes[0].message, "Let Garage use this computer?");
  assert.equal(page.calls.boxes[0].defaultId, 1);
  const allowed = mainLending({ response: 0 });
  assert.equal((await allowed.handlers.get("lend:set")({ page: garage }, null, true)).on, true);
  assert.equal((await allowed.handlers.get("lend:set")({ page: garage }, null, false)).on, false, "stopping is one tap");
  assert.equal(allowed.calls.boxes.length, 1);
  const stranger = mainLending();
  await assert.rejects(stranger.handlers.get("lend:state")({ page: null, other: true }, "garage"), /main desktop window/);

  // Who may lend is unchanged: a server that isn't their own is never lent, from anywhere.
  const notOwn = mainLending({ own: false });
  await assert.rejects(notOwn.handlers.get("lend:set")({}, "garage", true), /Only your own server/);
  assert.deepEqual(notOwn.calls.lent, []);
});

test("Choose what it can use on a server's own page opens This computer's Settings for that server only, once it is lent", async () => {
  const opened = [];
  const page = mainLending({ response: 0, openSettings: id => opened.push(id) });
  assert.equal(await page.handlers.get("lend:choose")({ page: garage }, "acme"), false, "nothing to choose before it is lent");
  assert.deepEqual(opened, []);
  await page.handlers.get("lend:set")({ page: garage }, null, true);
  assert.equal(await page.handlers.get("lend:choose")({ page: garage }, "acme"), true);
  assert.deepEqual(opened, ["garage"], "the page's own server, whatever id it sends");
  await assert.rejects(page.handlers.get("lend:choose")({ page: null, other: true }, "garage"), /main desktop window/);
  const notOwn = mainLending({ own: false, openSettings: id => opened.push(id) });
  assert.equal(await notOwn.handlers.get("lend:choose")({ page: garage }, null), false);
  assert.deepEqual(opened, ["garage"]);
});

test("a server that can't be lent to says why in one word; a Cloud or team never asks the server", async () => {
  for (const refusal of ["shared", "not-owner", "old", "team", "cloud", "unreachable"]) {
    const { handlers } = mainLending({ own: false, refusal });
    assert.deepEqual(await handlers.get("lend:state")({}, "garage"), { name: "Garage", lendable: false, why: refusal });
  }
  const flagged = mainLending({ own: false, flag: true });
  assert.deepEqual(await flagged.handlers.get("lend:state")({}, "garage"), { name: "Garage", lendable: false, why: "settings" });
  const team = { id: "acme", name: "Acme", origin: "https://omb-t-acme.fly.dev", team: { id: "t" } };
  assert.deepEqual(await mainLending().handlers.get("lend:state")({ page: team }), { name: "Acme", lendable: false, why: "team" });
  const cloud = { id: "home", name: "My Cloud", origin: "https://omb-h.fly.dev", home: true };
  assert.deepEqual(await mainLending().handlers.get("lend:state")({ page: cloud }), { name: "My Cloud", lendable: false, why: "cloud" });
  // A Cloud's or a team's page changes nothing: no stop written on its grant, no system prompt for the screen.
  for (const page of [team, cloud]) {
    const quiet = mainLending({ response: 0 });
    await quiet.handlers.get("lend:set")({ page }, null, false);
    await assert.rejects(quiet.handlers.get("lend:set")({ page }, null, true), /Only your own server/);
    await quiet.handlers.get("lend:allow-screen")({ page }, null);
    assert.deepEqual(quiet.calls.revoked, []);
    assert.deepEqual(quiet.calls.lent, []);
    assert.equal(quiet.calls.allowScreen, undefined);
    assert.deepEqual(quiet.calls.boxes, []);
  }
  const off = mainLending();
  await off.handlers.get("lend:allow-screen")({}, "garage");
  assert.equal(off.calls.allowScreen, undefined, "nothing is asked of the system while the switch is off");
});

test("on, its apps and screen as the system allows them: macOS asks for its two permissions, Windows needs nothing more", async () => {
  // The same computer control state, as screen-status.mjs reads it on each system.
  const missing = { status: "unavailable", reason: "Accessibility and Screen Recording required" };
  const mac = mainLending({ screen: async () => screenStatus({ platform: "darwin", connection: missing }) });
  await mac.handlers.get("lend:set")({}, "garage", true);
  assert.deepEqual(await mac.handlers.get("lend:state")({}, "garage"), { name: "Garage", lendable: true, on: true, connected: false, paused: false, screen: "permissions" });
  await mac.handlers.get("lend:allow-screen")({}, "garage");
  assert.equal(mac.calls.allowScreen, 1);
  const ready = { status: "ready", path: "/x", socket: "/tmp/cua.sock", version: "0.45.4" };
  const windows = mainLending({ screen: async () => screenStatus({ platform: "win32", connection: { ...ready, socket: "\\\\.\\pipe\\cua-omb-1" } }) });
  await windows.handlers.get("lend:set")({}, "garage", true);
  const view = await windows.handlers.get("lend:state")({}, "garage");
  assert.equal(view.on, true);
  assert.equal(view.screen === undefined || view.screen !== "permissions", true, "Windows never asks for macOS's permissions");
  const blocked = mainLending({ screen: async () => screenStatus({ platform: "win32", connection: { status: "unavailable", reason: "spawn cua-driver.exe EACCES" } }) });
  await blocked.handlers.get("lend:set")({}, "garage", true);
  assert.notEqual((await blocked.handlers.get("lend:state")({}, "garage")).screen, "permissions");
});

test("main wires the switch's senders as tested here: this app's own page, or the main frame of the active server's page", async () => {
  const main = await readFile(new URL("./main.mjs", import.meta.url), "utf8");
  assert.match(main, /installServerLending\(\{[\s\S]{0,1500}?local: event => cloudPageAsking\(event\) === "local"/);
  assert.match(main, /page: event => \{ const env = activeEnvironment\(environmentsState\); return env\?\.origin && env\.kind !== "local" && activePageOrigin\(event\) === env\.origin \? env : null; \}/);
  // activePageOrigin is cloudPageSenderAllowed for the active origin: only the window's main frame, on that origin.
  const mainFrame = { url: `${GARAGE}/chat` }, contents = { mainFrame };
  const page = event => (cloudPageSenderAllowed(event, { contents, homeOrigin: GARAGE, activeOrigin: GARAGE }) ? garage : null);
  assert.equal(page({ sender: contents, senderFrame: mainFrame }), garage);
  assert.equal(page({ sender: contents, senderFrame: { url: `${GARAGE}/frame` } }), null, "a frame inside the page");
  assert.equal(page({ sender: contents, senderFrame: Object.assign(mainFrame, { url: "https://evil.example/" }) }), null, "another origin");
  assert.equal(page({ sender: {}, senderFrame: mainFrame }), null, "another window");
});
