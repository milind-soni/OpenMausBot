// "Let my Cloud use this Mac" on the Mac side: the real connector and
// executor against a scripted Cloud home. Lending is bound to the signed-in
// Cloud account and its machine, never to the maintainer flag; signing out,
// another account or another machine ends it and cancels running work; Stop
// lending is instant; the menu-bar indicator follows it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { cloudLendingVerdict, createComputerSharing } from "./computer-sharing.mjs";
import { createLendingIndicator } from "./lending-indicator.mjs";

const ORIGIN = "https://omb-u-fixture.fly.dev";
const binding = { accountId: "acct_1", origin: ORIGIN };
const env = { id: "my-cloud", name: "My Cloud", origin: ORIGIN };

test("the Cloud verdict: same account and machine run, anything else ends or pauses", () => {
  const connected = { status: "connected", accountId: "acct_1", origin: ORIGIN };
  assert.deepEqual(cloudLendingVerdict(binding, connected, env), { allow: true });
  // A minute-by-minute re-verification or an unreachable Admin does not stop lending.
  assert.deepEqual(cloudLendingVerdict(binding, { status: "unavailable", accountId: "acct_1", origin: null }, env), { allow: true });
  assert.deepEqual(cloudLendingVerdict(binding, { status: "signed-out", accountId: null, origin: null }, env), { stop: "signed-out" });
  // A sign-in that cannot be read right now (no Cloud client yet, a failed
  // restore) pauses; it never ends lending the person turned on.
  assert.deepEqual(cloudLendingVerdict(binding, null, env), { pause: "unverified" });
  assert.deepEqual(cloudLendingVerdict(binding, { status: "unavailable", accountId: null, origin: null }, env), { pause: "unverified" });
  assert.deepEqual(cloudLendingVerdict(binding, { ...connected, accountId: "acct_2" }, env), { stop: "account-changed" });
  assert.deepEqual(cloudLendingVerdict(binding, { ...connected, origin: "https://omb-u-other.fly.dev" }, env), { stop: "machine-changed" });
  assert.deepEqual(cloudLendingVerdict(binding, connected, { origin: "https://evil.example" }), { stop: "machine-changed" });
  assert.deepEqual(cloudLendingVerdict(binding, { status: "reauth-required", accountId: "acct_1", origin: null }, env), { pause: "reauth-required" });
  assert.deepEqual(cloudLendingVerdict(undefined, connected, env), { stop: "signed-out" });
});

async function scratch(t) {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "omb-cloud-lending-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A Cloud home that answers the desktop's own session and hands out the
 * queued jobs; `paired` says whether this desktop is signed in there yet. */
function cloudHome({ cloudHome = true, scopes = ["admin", "client"] } = {}) {
  const json = (value, status = 200) => ({ ok: status < 400, status, body: (async function* () { yield Buffer.from(JSON.stringify(value)); })() });
  const state = { paired: true, environmentId: randomUUID(), sessionId: randomUUID(), connects: [], disconnects: 0, results: [], queue: [], waiting: null };
  const nextJob = () => new Promise(resolve => { state.waiting = resolve; });
  state.push = operation => {
    const job = { id: randomUUID(), operation: { computer_id: state.connects.at(-1).id, ...operation } };
    if (state.waiting) { const wake = state.waiting; state.waiting = null; wake(job); } else state.queue.push(job);
  };
  state.fetch = async (url, init) => {
    const route = new URL(url).pathname;
    if (route === "/api/auth/session") return state.paired ? json({ kind: "session", id: state.sessionId, scopes, ...(cloudHome ? { cloudHome: true } : {}) }) : json({ error: "unauthorized" }, 401);
    if (route === "/.well-known/openmausbot/environment") return json({ environmentId: state.environmentId, capabilities: { sharedComputers: true } });
    const body = init?.body ? JSON.parse(init.body) : {};
    if (route === "/api/shared-computers/connect") { state.connects.push(body); return json({ ok: true }); }
    if (route.endsWith("/poll")) {
      const job = state.queue.shift() ?? await Promise.race([nextJob(), delay(200).then(() => null)]);
      init?.signal?.throwIfAborted();
      return json({ job });
    }
    if (route.endsWith("/lease")) return json({ active: true });
    if (route.endsWith("/result")) { state.results.push(body.result); return json({ ok: true }); }
    if (route.endsWith("/disconnect")) { state.disconnects++; return json({ ok: true }); }
    throw new Error(`no route ${route}`);
  };
  return state;
}

/** A computer-control driver that records calls and never answers `drag`. */
async function hangingDriver(dir) {
  const calls = path.join(dir, "driver-calls.log");
  const pid = path.join(dir, "driver.pid");
  const script = path.join(dir, "driver.mjs");
  await writeFile(script, `import readline from 'node:readline'; import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(pid)}, String(process.pid));
readline.createInterface({input:process.stdin}).on('line', line => { const m=JSON.parse(line); if(!m.id)return;
if(m.method==='tools/call'){ fs.appendFileSync(${JSON.stringify(calls)}, m.params.name+'\\n'); if(m.params.name==='drag') return; }
const result=m.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{tools:{}}}:m.method==='tools/list'?{tools:[{name:'drag'},{name:'click'}]}:{content:[{type:'text',text:'ok'}]};
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n'); });`);
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
    // The maintainer flag is off, as for every Cloud Pro user.
    enabled: async () => { maintainerChecks++; return false; },
    cloud: () => cloud, home: path.join(dir, "home"),
    cuaConnection: async () => driver.connection,
    hostControl: async id => { leases.push(`acquire:${id}`); return { renew: async () => {}, release: async () => { leases.push(`release:${id}`); } }; },
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

test("lends to the person's own Cloud with the maintainer flag off; never a terminal", async t => {
  const { folderPath, home, sharing, maintainerChecks, summaries } = await lendingFixture(t);
  const lent = await sharing.saveCloud(env, { folders: [{ id: randomUUID(), path: folderPath, write: false }], screen: false, terminal: true });
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
  // It stays off: signing back in does not lend again by itself.
  setCloud({ status: "connected", accountId: "acct_1", origin: ORIGIN });
  sharing.cloudChanged();
  await delay(100);
  assert.equal(sharing.cloudState(env).enabled, false);
  assert.equal(home.connects.length, 1);
});

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
  home.push({ action: "computer_call", tool_name: "click", arguments: {} });
  await delay(300);
  assert.equal((await readFile(driver.calls, "utf8")).trim(), "drag");
  assert.deepEqual(summaries.at(-1), { lending: [], busy: null });
});

test("quitting the app pauses lending; it never switches it off, even mid-reconnect", async t => {
  const { dir, folderPath, home, sharing } = await lendingFixture(t);
  await sharing.saveCloud(env, { folders: [{ id: randomUUID(), path: folderPath, write: false }], screen: false });
  await connected(sharing, 1, home);
  // The Cloud answers slowly: the app quits while this Mac is checking which
  // Cloud it is talking to (a reconnect, e.g. after the Mac woke up).
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

test("the menu-bar indicator exists only while lending, says when the Cloud is using the Mac, and stops lending", () => {
  const trays = [];
  class Tray {
    constructor() { this.destroyed = false; this.title = ""; this.menu = null; trays.push(this); }
    on() {} setToolTip(value) { this.tip = value; } setTitle(value) { this.title = value; }
    setContextMenu(menu) { this.menu = menu; } isDestroyed() { return this.destroyed; } destroy() { this.destroyed = true; }
  }
  const Menu = { buildFromTemplate: items => items };
  const nativeImage = { createFromPath: () => ({ resize: () => ({}) }) };
  let stops = 0, opens = 0;
  const indicator = createLendingIndicator({ Tray, Menu, nativeImage, iconPath: "icon.png", onStop: () => stops++, onOpen: () => opens++ });
  indicator.update({ lending: false, busy: false });
  assert.equal(trays.length, 0, "nothing in the menu bar while nothing is lent");
  indicator.update({ lending: true, busy: false });
  assert.equal(trays.length, 1);
  assert.equal(trays[0].title, "");
  assert.match(trays[0].menu[0].label, /can use this computer/);
  indicator.update({ lending: true, busy: true });
  assert.equal(trays.length, 1);
  assert.equal(trays[0].title, "In use");
  assert.match(trays[0].menu[0].label, /using this computer now/);
  trays[0].menu.find(item => item.label === "Stop lending").click();
  trays[0].menu.find(item => item.label === "Lending settings…").click();
  assert.deepEqual([stops, opens], [1, 1]);
  indicator.update({ lending: false, busy: true });
  assert.equal(trays[0].destroyed, true, "gone as soon as lending ends");
});
