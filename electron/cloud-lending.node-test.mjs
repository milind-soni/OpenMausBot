import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { cloudLendingVerdict, createComputerSharing } from "./computer-sharing.mjs";
import { createLendingIndicator } from "./lending-indicator.mjs";
import nativeText from "./native-text.cjs";

const ORIGIN = "https://omb-u-fixture.fly.dev";
const binding = { accountId: "acct_1", origin: ORIGIN };
const env = { id: "my-cloud", name: "My Cloud", origin: ORIGIN };

test("the Cloud verdict: same account and machine run, anything else ends or pauses", () => {
  const connected = { status: "connected", accountId: "acct_1", origin: ORIGIN };
  assert.deepEqual(cloudLendingVerdict(binding, connected, env), { allow: true });
  assert.deepEqual(cloudLendingVerdict(binding, { status: "unavailable", accountId: "acct_1", origin: null }, env), { allow: true });
  assert.deepEqual(cloudLendingVerdict(binding, { status: "signed-out", accountId: null, origin: null }, env), { stop: "signed-out" });
  assert.deepEqual(cloudLendingVerdict(binding, null, env), { pause: "unverified" });
  assert.deepEqual(cloudLendingVerdict(binding, { status: "unavailable", accountId: null, origin: null }, env), { pause: "unverified" });
  assert.deepEqual(cloudLendingVerdict(binding, { ...connected, accountId: "acct_2" }, env), { stop: "account-changed" });
  assert.deepEqual(cloudLendingVerdict(binding, { ...connected, origin: "https://omb-u-other.fly.dev" }, env), { stop: "machine-changed" });
  assert.deepEqual(cloudLendingVerdict(binding, connected, { origin: "https://evil.example" }), { stop: "machine-changed" });
  assert.deepEqual(cloudLendingVerdict(binding, { status: "reauth-required", accountId: "acct_1", origin: null }, env), { pause: "reauth-required" });
  assert.deepEqual(cloudLendingVerdict(undefined, connected, env), { stop: "signed-out" });
  // A saved sign-in still being read at startup is not a sign-out.
  assert.deepEqual(cloudLendingVerdict(binding, { status: "restoring", accountId: null, origin: null }, env), { pause: "restoring" });
});

async function scratch(t) {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "omb-cloud-lending-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function cloudHome({ cloudHome = true, scopes = ["admin", "client"], details = false } = {}) {
  const json = (value, status = 200) => ({ ok: status < 400, status, body: (async function* () { yield Buffer.from(JSON.stringify(value)); })() });
  const state = { paired: true, environmentId: randomUUID(), sessionId: randomUUID(), connects: [], disconnects: 0, disconnectBodies: [], results: [], queue: [], waiting: null };
  const nextJob = () => new Promise(resolve => { state.waiting = resolve; });
  state.push = operation => {
    const job = { id: randomUUID(), operation: { computer_id: state.connects.at(-1).id, ...operation } };
    if (state.waiting) { const wake = state.waiting; state.waiting = null; wake(job); } else state.queue.push(job);
  };
  state.fetch = async (url, init) => {
    const route = new URL(url).pathname;
    if (route === "/api/auth/session") return state.paired ? json({ kind: "session", id: state.sessionId, scopes, ...(cloudHome ? { cloudHome: true } : {}) }) : json({ error: "unauthorized" }, 401);
    if (route === "/.well-known/openmausbot/environment") return json({ environmentId: state.environmentId, capabilities: { sharedComputers: true, ...(details ? { lendingDetails: true } : {}) } });
    const body = init?.body ? JSON.parse(init.body) : {};
    if (route === "/api/shared-computers/connect") { state.connects.push(body); return json({ ok: true }); }
    if (route.endsWith("/poll")) {
      const job = state.queue.shift() ?? await Promise.race([nextJob(), delay(200).then(() => null)]);
      init?.signal?.throwIfAborted();
      return json({ job });
    }
    if (route.endsWith("/lease")) { await state.leaseHeld; return json({ active: true }); }
    if (route.endsWith("/result")) { state.results.push(body.result); return json({ ok: true }); }
    if (route.endsWith("/disconnect")) { state.disconnects++; state.disconnectBodies.push(body); return json({ ok: true }); }
    throw new Error(`no route ${route}`);
  };
  return state;
}

/** A computer-control driver that records calls, never answers `drag` and answers `list_windows` after 1.5 s. */
async function hangingDriver(dir) {
  const calls = path.join(dir, "driver-calls.log");
  const pid = path.join(dir, "driver.pid");
  const script = path.join(dir, "driver.mjs");
  await writeFile(script, `import readline from 'node:readline'; import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(pid)}, String(process.pid));
readline.createInterface({input:process.stdin}).on('line', line => { const m=JSON.parse(line); if(!m.id)return;
if(m.method==='tools/call'){ fs.appendFileSync(${JSON.stringify(calls)}, m.params.name+'\\n'); if(m.params.name==='drag') return; }
const result=m.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{tools:{}}}:m.method==='tools/list'?{tools:[{name:'drag'},{name:'click'},{name:'list_windows'}]}:{content:[{type:'text',text:'ok'}]};
const answer=()=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n'); if(m.params?.name==='list_windows') setTimeout(answer,1500); else answer(); });`);
  return { connection: { mcpCommand: process.execPath, mcpArgs: [script] }, calls, pid };
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function lendingFixture(t, options = {}) {
  const dir = await scratch(t);
  const folderPath = path.join(dir, "Plans");
  await mkdir(folderPath);
  await writeFile(path.join(folderPath, "plan.md"), "from the Mac");
  const home = cloudHome(options.home);
  let cloud = "cloud" in options ? options.cloud : { status: "connected", accountId: "acct_1", origin: ORIGIN };
  let maintainerChecks = 0;
  const summaries = [];
  const leases = [];
  const driver = await hangingDriver(dir);
  const sharing = createComputerSharing({
    file: path.join(dir, "profile", "computer-sharing.json"), fetch: home.fetch, environments: () => [env],
    ...(options.reconnect ? { reconnect: options.reconnect } : {}), ...(options.now ? { now: options.now } : {}),
    // The maintainer flag is off, as for every Cloud Pro user.
    enabled: async () => { maintainerChecks++; return false; },
    cloud: () => cloud, home: path.join(dir, "home"),
    cuaConnection: async () => driver.connection,
    hostControl: options.hostControl ?? (async id => { leases.push(`acquire:${id}`); return { renew: async () => {}, release: async () => { leases.push(`release:${id}`); } }; }),
    onChange: summary => summaries.push(summary),
  });
  t.after(() => sharing.close());
  return { dir, folderPath, home, sharing, driver, summaries, leases, maintainerChecks: () => maintainerChecks, setCloud: next => { cloud = next; } };
}
const connected = async (sharing, count = 1, home) => {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (sharing.cloudState(env).connected && (!home || home.connects.length >= count)) return;
    await delay(20);
  }
  assert.fail(`never connected: ${JSON.stringify(sharing.cloudState(env))}`);
};
const until = async (check, what, ms = 5000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await check()) return; await delay(20); }
  assert.fail(`timed out waiting for ${what}`);
};

test("lends to the person's own Cloud with the maintainer flag off; no terminal unless it is asked for", async t => {
  const { folderPath, home, sharing, maintainerChecks, summaries } = await lendingFixture(t);
  const lent = await sharing.saveCloud(env, { folders: [{ id: randomUUID(), path: folderPath, write: false }], screen: false });
  assert.equal(lent.enabled, true);
  await connected(sharing, 1, home);
  assert.equal(home.connects[0].terminal, false);
  assert.equal(home.connects[0].computer, false);
  home.push({ action: "read_file", folder_id: home.connects[0].folders[0].id, path: "plan.md" });
  home.push({ action: "run_command", command: "id" });
  await until(() => home.results.length === 2, "two results");
  assert.equal(JSON.parse(home.results[0].content[0].text).content, "from the Mac");
  assert.equal(home.results[1].isError, true);
  assert.equal(maintainerChecks(), 0, "a Cloud grant never consults the maintainer flag");
  assert.ok(summaries.some(summary => summary.lending.includes(env.id)));
  assert.deepEqual(sharing.activity(env.id).map(entry => [entry.action, entry.ok]), [["run_command", false], ["read_file", true]]);
});

test("the terminal is lent only when asked for with exactly true: the bots can then run commands here, it is listed in Activity, and it does not outlive the switch", async t => {
  const { folderPath, home, sharing } = await lendingFixture(t);
  const folders = [{ id: randomUUID(), path: folderPath, write: false }];
  assert.equal((await sharing.saveCloud(env, { folders, screen: false, terminal: "true" })).terminal, false, "only a real true counts");
  const lent = await sharing.saveCloud(env, { folders, screen: false, terminal: true });
  assert.equal(lent.terminal, true);
  await connected(sharing, 2, home);
  assert.equal(home.connects.at(-1).terminal, true);
  home.push({ action: "run_command", command: "echo fixture-terminal" });
  await until(() => home.results.length === 1, "the command result");
  assert.notEqual(home.results[0].isError, true);
  assert.match(home.results[0].content[0].text, /fixture-terminal/);
  assert.deepEqual(sharing.activity(env.id).map(entry => [entry.action, entry.ok]), [["run_command", true]]);
  // The terminal alone is a grant; turning lending off reports no terminal, and a plain save never brings it back.
  assert.equal((await sharing.saveCloud(env, { folders: [], screen: false, terminal: true })).enabled, true);
  sharing.revoke(env);
  assert.equal(sharing.cloudState(env).terminal, false);
  assert.equal((await sharing.saveCloud(env, { folders, screen: false })).terminal, false);
  await assert.rejects(sharing.saveCloud(env, { folders: [], screen: false }), /terminal/);
});

test("refuses to lend unless the Cloud sign-in is verified for this exact machine, and never to a server that is not a Cloud home", async t => {
  const folder = async dir => [{ id: randomUUID(), path: dir, write: false }];
  for (const cloud of [null, { status: "signed-out", accountId: null, origin: null }, { status: "unavailable", accountId: "acct_1", origin: null }, { status: "connected", accountId: "acct_1", origin: "https://omb-u-other.fly.dev" }]) {
    const { folderPath, sharing, home } = await lendingFixture(t, { cloud });
    await assert.rejects(sharing.saveCloud(env, { folders: await folder(folderPath), screen: false }), /Open My Cloud first/);
    assert.equal(home.connects.length, 0);
    assert.equal(sharing.cloudState(env).enabled, false);
  }
  for (const home of [{ cloudHome: false }, { scopes: ["client"] }]) {
    const { folderPath, sharing, home: server } = await lendingFixture(t, { home });
    await assert.rejects(sharing.saveCloud(env, { folders: await folder(folderPath), screen: false }), /not My Cloud/);
    assert.equal(server.connects.length, 0);
  }
});

test("a switch turned on before the first connect waits, then binds to that Cloud when this Mac signs in there", async t => {
  const { folderPath, home, sharing } = await lendingFixture(t);
  home.paired = false;
  const lent = await sharing.saveCloud(env, { folders: [{ id: randomUUID(), path: folderPath, write: true }], screen: false });
  assert.equal(lent.enabled, true);
  await until(() => sharing.cloudState(env).problem === "connect-first", "connect-first");
  assert.equal(home.connects.length, 0);
  home.paired = true; // Connect to my Cloud paired this desktop
  await until(() => home.connects.length === 1, "first connect", 8000);
  assert.equal(home.connects[0].environmentId, home.environmentId);
});

test("another server behind the Cloud's address (a replaced machine) ends lending instead of adopting it", async t => {
  const { dir, folderPath, home, sharing } = await lendingFixture(t);
  await sharing.saveCloud(env, { folders: [{ id: randomUUID(), path: folderPath, write: false }], screen: false });
  await connected(sharing, 1, home);
  sharing.close();
  home.environmentId = randomUUID();
  const restarted = createComputerSharing({
    file: path.join(dir, "profile", "computer-sharing.json"), fetch: home.fetch, environments: () => [env], enabled: async () => false,
    cloud: () => ({ status: "connected", accountId: "acct_1", origin: ORIGIN }), home: path.join(dir, "home"), cuaConnection: async () => null,
  });
  t.after(() => restarted.close());
  restarted.start({ maintainer: false });
  await until(() => restarted.cloudState(env).problem === "machine-changed", "machine-changed");
  assert.equal(restarted.cloudState(env).enabled, false);
  // Why it stopped outlives the app: after another restart the switch still says why and since when.
  restarted.close();
  const later = createComputerSharing({
    file: path.join(dir, "profile", "computer-sharing.json"), fetch: home.fetch, environments: () => [env], enabled: async () => false,
    cloud: () => ({ status: "connected", accountId: "acct_1", origin: ORIGIN }), home: path.join(dir, "home"), cuaConnection: async () => null,
  });
  t.after(() => later.close());
  later.start({ maintainer: false });
  const stopped = later.cloudState(env);
  assert.equal(stopped.enabled, false);
  assert.equal(stopped.stopped.reason, "machine-changed");
  assert.ok(Math.abs(stopped.stopped.at - Date.now()) < 60_000);
  assert.equal(stopped.screen, false);
  assert.equal(stopped.folders.length, 1, "the choices are kept, so the same can be lent again in one click");
  assert.equal(home.connects.length, 1);
});

test("signing out of OMB Cloud ends lending at once and cancels an action already running", async t => {
  const { home, sharing, driver, leases, setCloud } = await lendingFixture(t);
  await sharing.saveCloud(env, { folders: [], screen: true });
  await connected(sharing, 1, home);
  home.push({ action: "computer_call", tool_name: "drag", arguments: {} });
  await until(async () => (await readFile(driver.calls, "utf8").catch(() => "")).includes("drag"), "the drag to start");
  assert.equal(sharing.cloudState(env).busy, true);
  const pid = Number(await readFile(driver.pid, "utf8"));
  setCloud({ status: "signed-out", accountId: null, origin: null });
  sharing.cloudChanged();
  const state = sharing.cloudState(env);
  assert.equal(state.enabled, false);
  assert.equal(state.problem, "signed-out");
  await until(() => !alive(pid), "the driver transport to be closed");
  await until(() => leases.some(entry => entry.startsWith("release:")), "the screen lease to be released");
  assert.ok(home.disconnects >= 1);
  setCloud({ status: "connected", accountId: "acct_1", origin: ORIGIN });
  sharing.cloudChanged();
  await delay(100);
  assert.equal(sharing.cloudState(env).enabled, false);
  assert.equal(home.connects.length, 1);
});

/** This computer's screen lock as the desktop server keeps it, renewed with "acquire" as main renews it. */
function screenLock() {
  let holder = null;
  const take = id => {
    if (holder !== null && holder !== id) throw new Error("This computer is in use locally or held by a person. Wait, then observe it again before acting.");
    holder = id;
  };
  const lock = {
    renewHeld: undefined,
    holder: () => holder,
    hostControl: async id => { take(id); return { renew: async () => { await lock.renewHeld; take(id); }, release: async () => { if (holder === id) holder = null; } }; },
  };
  return lock;
}

for (const stalled of ["the Cloud's lease answer", "the renew"]) {
  test(`a screen call that ends while ${stalled} is on its way leaves the screen free for the next call`, async t => {
    const lock = screenLock();
    const { home, sharing, driver } = await lendingFixture(t, { hostControl: lock.hostControl });
    await sharing.saveCloud(env, { folders: [], screen: true });
    await connected(sharing, 1, home);
    home.push({ action: "computer_call", tool_name: "list_windows", arguments: {} });
    await until(async () => (await readFile(driver.calls, "utf8").catch(() => "")).includes("list_windows"), "the slow call to start");
    let answer;
    const held = new Promise(resolve => { answer = resolve; });
    if (stalled === "the renew") lock.renewHeld = held; else home.leaseHeld = held;
    await delay(1600);
    answer();
    await until(() => home.results.length === 1, "the slow call to finish");
    await delay(200);
    home.push({ action: "computer_call", tool_name: "click", arguments: {} });
    await until(() => home.results.length === 2, "the click");
    assert.deepEqual(home.results.map(result => result.isError === true ? result.content[0].text : "ok"), ["ok", "ok"]);
    assert.equal(lock.holder(), null, "the finished calls no longer hold the screen");
  });
}

test("another Cloud account or another machine ends lending; a sign-in that needs renewing only pauses it", async t => {
  {
    const { folderPath, home, sharing, setCloud } = await lendingFixture(t);
    await sharing.saveCloud(env, { folders: [{ id: randomUUID(), path: folderPath, write: false }], screen: false });
    await connected(sharing, 1, home);
    setCloud({ status: "connected", accountId: "acct_2", origin: ORIGIN });
    sharing.cloudChanged();
    assert.deepEqual([sharing.cloudState(env).enabled, sharing.cloudState(env).problem], [false, "account-changed"]);
  }
  {
    const { folderPath, home, sharing, setCloud } = await lendingFixture(t);
    await sharing.saveCloud(env, { folders: [{ id: randomUUID(), path: folderPath, write: false }], screen: false });
    await connected(sharing, 1, home);
    setCloud({ status: "connected", accountId: "acct_1", origin: "https://omb-u-new.fly.dev" });
    sharing.cloudChanged();
    assert.deepEqual([sharing.cloudState(env).enabled, sharing.cloudState(env).problem], [false, "machine-changed"]);
  }
  {
    const { folderPath, home, sharing, setCloud } = await lendingFixture(t);
    await sharing.saveCloud(env, { folders: [{ id: randomUUID(), path: folderPath, write: false }], screen: false });
    await connected(sharing, 1, home);
    setCloud({ status: "reauth-required", accountId: "acct_1", origin: null });
    sharing.cloudChanged();
    assert.deepEqual([sharing.cloudState(env).enabled, sharing.cloudState(env).connected, sharing.cloudState(env).problem], [true, false, "paused"]);
    assert.ok(home.disconnects >= 1, "the Cloud stops seeing it while paused");
    await until(() => home.disconnectBodies.length >= 1, "the pause to reach the Cloud");
    assert.ok(home.disconnectBodies.every(body => body.paused === true), "a pause tells the Cloud it is still lent");
    setCloud({ status: "connected", accountId: "acct_1", origin: ORIGIN });
    sharing.cloudChanged();
    await connected(sharing, 2, home);
  }
});

test("Stop lending is instant: the Cloud is told, running work is cancelled, and nothing more runs", async t => {
  const { home, sharing, driver, summaries } = await lendingFixture(t);
  await sharing.saveCloud(env, { folders: [], screen: true });
  await connected(sharing, 1, home);
  home.push({ action: "computer_call", tool_name: "drag", arguments: {} });
  await until(async () => (await readFile(driver.calls, "utf8").catch(() => "")).includes("drag"), "the drag to start");
  assert.ok(summaries.some(summary => summary.busy?.env === env.id), "the indicator heard that the Cloud is using the Mac");
  const pid = Number(await readFile(driver.pid, "utf8"));
  const stopped = sharing.revoke(env);
  assert.equal(stopped.enabled, false);
  await until(() => !alive(pid), "the driver transport to be closed");
  await until(() => home.disconnects >= 1, "the Cloud to be told");
  assert.deepEqual(home.disconnectBodies, [{}], "Stop lending is no pause");
  home.push({ action: "computer_call", tool_name: "click", arguments: {} });
  await delay(300);
  assert.equal((await readFile(driver.calls, "utf8")).trim(), "drag");
  assert.deepEqual(summaries.at(-1), { lending: [], busy: null });
});

test("quitting the app pauses lending; it never switches it off, even mid-reconnect", async t => {
  const { dir, folderPath, home, sharing } = await lendingFixture(t);
  await sharing.saveCloud(env, { folders: [{ id: randomUUID(), path: folderPath, write: false }], screen: false });
  await connected(sharing, 1, home);
  // The Cloud answers slowly, so the app quits while this Mac is still checking which Cloud it is talking to.
  const answer = home.fetch;
  let identityStarted;
  const started = new Promise(resolve => { identityStarted = resolve; });
  home.fetch = async (url, init) => {
    if (new URL(url).pathname === "/api/auth/session") { identityStarted(); await delay(200); }
    return answer(url, init);
  };
  const restarted = createComputerSharing({
    file: path.join(dir, "profile", "computer-sharing.json"), fetch: (...args) => home.fetch(...args), environments: () => [env], enabled: async () => false,
    cloud: () => ({ status: "connected", accountId: "acct_1", origin: ORIGIN }), home: path.join(dir, "home"), cuaConnection: async () => null,
  });
  sharing.close();
  restarted.start({ maintainer: false });
  await started;
  restarted.close();
  await delay(400);
  const after = createComputerSharing({
    file: path.join(dir, "profile", "computer-sharing.json"), fetch: answer, environments: () => [env], enabled: async () => false,
    cloud: () => ({ status: "connected", accountId: "acct_1", origin: ORIGIN }), home: path.join(dir, "home"), cuaConnection: async () => null,
  });
  t.after(() => after.close());
  assert.equal(after.cloudState(env).enabled, true, "the next launch still lends");
});

test("the menu-bar indicator exists only while lending, reads In use while bots use the Mac, and turns lending off", () => {
  const trays = [];
  class Tray {
    constructor() { this.destroyed = false; this.title = ""; this.menu = null; trays.push(this); }
    on() {} setToolTip(value) { this.tip = value; } setTitle(value) { this.title = value; }
    setContextMenu(menu) { this.menu = menu; } isDestroyed() { return this.destroyed; } destroy() { this.destroyed = true; }
  }
  const Menu = { buildFromTemplate: items => items };
  const nativeImage = { createFromPath: () => ({ resize: () => ({}) }) };
  let stops = 0, opens = 0;
  const indicator = createLendingIndicator({ Tray, Menu, nativeImage, iconPath: "icon.png", onStop: () => stops++, onOpen: () => opens++, device: "Mac" });
  indicator.update({ lending: false, busy: false });
  assert.equal(trays.length, 0, "nothing in the menu bar while nothing is lent");
  indicator.update({ lending: true, busy: false });
  assert.equal(trays.length, 1);
  assert.equal(trays[0].title, "");
  assert.equal(trays[0].menu[0].label, "Your bots can use this Mac");
  indicator.update({ lending: true, busy: true });
  assert.equal(trays.length, 1);
  assert.equal(trays[0].title, "In use");
  assert.equal(trays[0].menu[0].label, "Your bots are using this Mac now");
  trays[0].menu.find(item => item.label === "Stop sharing").click();
  trays[0].menu.find(item => item.label === "Sharing settings…").click();
  assert.deepEqual([stops, opens], [1, 1]);
  indicator.update({ lending: false, busy: true });
  assert.equal(trays[0].destroyed, true, "gone as soon as lending ends");
});

test("the menu-bar indicator speaks the app's language and says it again when the language changes", () => {
  const trays = [];
  class Tray {
    constructor() { this.destroyed = false; trays.push(this); }
    on() {} setToolTip(value) { this.tip = value; } setTitle(value) { this.title = value; }
    setContextMenu(menu) { this.menu = menu; } isDestroyed() { return this.destroyed; } destroy() { this.destroyed = true; }
  }
  const text = nativeText.createNativeText({ saved: "en" });
  const indicator = createLendingIndicator({ Tray, Menu: { buildFromTemplate: items => items }, nativeImage: { createFromPath: () => ({ resize: () => ({}) }) },
    iconPath: "icon.png", onStop: () => {}, onOpen: () => {}, device: "computer", t: text.t });
  indicator.relabel();
  assert.equal(trays.length, 0, "nothing to say while nothing is lent");
  indicator.update({ lending: true, busy: true });
  assert.equal(trays[0].menu[0].label, "Your bots are using this computer now");
  text.set("pt-br");
  indicator.relabel();
  assert.equal(trays.length, 1, "the same icon");
  assert.deepEqual([trays[0].menu[0].label, trays[0].title, trays[0].tip], ["Seus bots estão usando este computador agora", "Em uso", "OpenMausBot: em uso pelos seus bots"]);
  assert.deepEqual(trays[0].menu.slice(2).map(item => item.label), ["Parar de compartilhar", "Configurações de compartilhamento…"]);
});

test("Stop lending is remembered as the person's own choice, with when, and a new lend clears it", async t => {
  const { folderPath, home, sharing } = await lendingFixture(t);
  await sharing.saveCloud(env, { folders: [{ id: randomUUID(), path: folderPath, write: false }], screen: true });
  await connected(sharing, 1, home);
  assert.equal(sharing.cloudState(env).stopped, undefined);
  sharing.revoke(env);
  assert.equal(sharing.cloudState(env).stopped.reason, "you");
  assert.equal(sharing.cloudState(env).screen, true);
  await sharing.saveCloud(env, { folders: sharing.cloudState(env).folders, screen: true });
  assert.equal(sharing.cloudState(env).enabled, true);
  assert.equal(sharing.cloudState(env).stopped, undefined);
});

test("a Computer access grant on My Cloud's entry shows as lent, terminal and all, says when it cannot run, and Stop lending ends it", async t => {
  const dir = await scratch(t);
  const file = path.join(dir, "profile", "computer-sharing.json");
  await mkdir(path.dirname(file), { recursive: true });
  // What Settings → Servers → Computer access saved for My Cloud's entry before it left that entry: no Cloud binding.
  await writeFile(file, JSON.stringify({ version: 1, records: { [env.id]: { id: randomUUID(), secret: "c".repeat(64), enabled: true, sessionId: randomUUID(), environmentId: randomUUID(), folders: [], terminal: true, computer: true } } }));
  const home = cloudHome();
  const sharing = createComputerSharing({ file, fetch: home.fetch, environments: () => [env], enabled: async () => false,
    cloud: () => ({ status: "connected", accountId: "acct_1", origin: ORIGIN }), home: path.join(dir, "home"), cuaConnection: async () => null });
  t.after(() => sharing.close());
  sharing.start({ maintainer: false });
  const state = sharing.cloudState(env);
  assert.deepEqual([state.enabled, state.via, state.terminal, state.screen, state.problem], [true, "access", true, true, "access-off"]);
  sharing.revoke(env);
  assert.equal(sharing.cloudState(env).enabled, false);
  assert.equal(sharing.cloudState(env).via, undefined);
});

test("tells My Cloud its platform only when that Cloud takes it, so its bots say PC on Windows and Mac only on a Mac", async t => {
  for (const details of [true, false]) {
    const { folderPath, home, sharing } = await lendingFixture(t, { home: { details } });
    await sharing.saveCloud(env, { folders: [{ id: randomUUID(), path: folderPath, write: false }], screen: false });
    await connected(sharing, 1, home);
    if (details) assert.equal(home.connects[0].platform, process.platform);
    else assert.equal("platform" in home.connects[0], false, "an older Cloud refuses fields it does not know");
  }
});

test("signs back in to My Cloud by itself when its session there ended, and tries again only after 15 minutes", async t => {
  let calls = 0;
  const signIn = { home: null };
  const { folderPath, home, sharing } = await lendingFixture(t, { reconnect: async origin => { calls++; assert.equal(origin, ORIGIN); signIn.home.paired = true; return true; } });
  signIn.home = home;
  home.paired = false;
  await sharing.saveCloud(env, { folders: [{ id: randomUUID(), path: folderPath, write: false }], screen: false });
  await connected(sharing, 1, home);
  assert.equal(calls, 1);

  let tries = 0;
  const stuck = await lendingFixture(t, { now: () => 1_000_000, reconnect: async () => { tries++; return false; } });
  stuck.home.paired = false;
  await stuck.sharing.saveCloud(env, { folders: [{ id: randomUUID(), path: stuck.folderPath, write: false }], screen: false });
  await until(() => stuck.sharing.cloudState(env).problem === "connect-first", "connect-first");
  await delay(5_600);
  assert.equal(tries, 1, "a failed sign-in is not retried every few seconds");
  assert.equal(stuck.sharing.cloudState(env).problem, "connect-first");
});
