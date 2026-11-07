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

/** A self-hosted server as this desktop's sign-in there sees it: `scopes`, and whether it is a team's or a Cloud. */
function selfHosted({ scopes = ["admin", "client"], extra = {}, mcp = true } = {}) {
  const json = (value, status = 200) => ({ ok: status < 400, status, headers: { get: () => null }, body: (async function* () { yield Buffer.from(JSON.stringify(value)); })() });
  const state = { environmentId: randomUUID(), sessionId: randomUUID(), scopes, extra, connects: [], disconnects: [], polls: 0 };
  state.fetch = async (url, init) => {
    const route = new URL(url).pathname;
    if (route === "/api/auth/session") return json({ kind: "session", id: state.sessionId, scopes: state.scopes, ...state.extra });
    if (route === "/.well-known/openmausbot/environment") return json({ environmentId: state.environmentId, capabilities: { sharedComputers: true, lendingDetails: true, fileEdits: true, ...(mcp ? { lentMcp: true } : {}) } });
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
  const owner = { kind: "session", id: randomUUID(), scopes: ["admin", "client"] };
  assert.equal(ownServerSession(owner), true);
  assert.equal(ownServerSession({ ...owner, scopes: ["client"] }), false, "a narrower pairing");
  assert.equal(ownServerSession({ ...owner, scopes: undefined }), false);
  assert.equal(ownServerSession({ ...owner, team: { id: "t", role: "admin" } }), false, "a team's server");
  assert.equal(ownServerSession({ ...owner, cloudHome: true }), false, "a Cloud is lent by its own rules");
  assert.equal(ownServerSession({ ...owner, hosted: true }), false);
  assert.equal(ownServerSession({ ...owner, kind: "loopback" }), false);
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
  assert.equal(await mac.sharing.ownOffer(garage), null, "answered for this pairing");
  assert.deepEqual(mac.summaries.at(-1).lending, [garage.id]);
  assert.deepEqual(mac.summaries.at(-1).clouds, ["Garage"], "the menu-bar item names it like a Cloud");
  assert.equal(mac.summaries.at(-1).terminalSwitch, false, "the Clouds' terminal switch stays out of the menu without a Cloud");
});

test("a narrower pairing, a team's server or a Cloud is never asked about and is never lent", async t => {
  for (const [what, server] of [["client scope", selfHosted({ scopes: ["client"] })], ["team", selfHosted({ extra: { team: { id: "t", role: "admin" } } })], ["Cloud", selfHosted({ extra: { cloudHome: true } })]]) {
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

test("a new pairing of the same server keeps lending; that server dropping the owner pairing, or another server behind the address, ends it", async t => {
  const server = selfHosted();
  const mac = await desktop(t, server);
  await mac.sharing.lendOwn(garage, { computer: true });
  await until(() => server.connects.length === 1, "lending to start");
  server.sessionId = randomUUID();
  mac.restart();
  await until(() => server.connects.length === 2, "lending to go on after pairing again");
  assert.equal(JSON.parse(await readFile(mac.file, "utf8")).records.garage.sessionId, server.sessionId, "bound to the new pairing");

  server.scopes = ["client"];
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
function mainLending({ response = 1, own = true, flag = false, offer } = {}) {
  const handlers = new Map(), calls = { lent: [], declined: [], saved: [], revoked: [], boxes: [] };
  const win = { isDestroyed: () => false, webContents: { getURL: () => `${GARAGE}/` } };
  const info = { sessionId: randomUUID(), environmentId: randomUUID() };
  const records = {};
  const controller = {
    state: id => records[id] ?? { enabled: false, folders: [], terminal: false, computer: false },
    ownServer: async () => (own ? info : null),
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
    environments: () => [garage, { id: "acme", name: "Acme", origin: "https://omb-t-acme.fly.dev", team: { id: "t" } }], active: () => garage });
  return { handlers, calls, lending, win, info };
}

test("right after pairing a server of the person's own, one popup in main's own dialog: Allow lends the apps on the screen, Not now nothing", async () => {
  const allowed = mainLending({ response: 0 });
  await allowed.lending.offer(allowed.win);
  assert.equal(allowed.calls.boxes.length, 1);
  assert.deepEqual(allowed.calls.boxes[0], { type: "question", message: "Let Garage use this computer?", detail: allowed.calls.boxes[0].detail, buttons: ["Allow", "Not now"], defaultId: 1, cancelId: 1 });
  assert.match(allowed.calls.boxes[0].detail, /apps on your screen.*folders you choose and run commands in a terminal/s);
  assert.deepEqual(allowed.calls.lent, [["garage", { folders: [], terminal: false, computer: true }]]);

  const notNow = mainLending({ response: 1 });
  await notNow.lending.offer(notNow.win);
  assert.deepEqual(notNow.calls.lent, []);
  assert.deepEqual(notNow.calls.declined, [["garage", notNow.info]]);

  const answered = mainLending({ response: 0, offer: null });
  await answered.lending.offer(answered.win);
  assert.deepEqual(answered.calls.boxes, [], "a pairing already answered is never asked again");

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
