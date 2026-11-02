import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { createCloudAccountClient } from "./cloud-account.mjs";
import { CLOUD_HOME_NAME, cloudHomeConnectUrl, cloudPlanDisk, cloudUnreachableText, isCloudHomeEntry, parseCloudCredit, parseCloudOffer, parseCloudPower, parseCloudPurchase, parseCloudSummary, parseCloudTeams, teamRoleLabel, CLOUD_TEAM_ROLES, parseCloudTrial, parsePairingGrant, parsePublicOffer, rememberedCloudHome, savedCloudHomeOrigin, withCloudHome, withoutTrial } from "./cloud-home.mjs";
import environments from "./environments.cjs";
import { homeLook, withoutOldCloudHome } from "./cloud-list.mjs";

const NOW = 1_800_000_000_000;
const origin = "https://omb-u-1a2b3c4d5e6f.fly.dev";
const code = "ABCD-EFGH-JK23";

test("the Admin says whether this account may move to its Cloud, and when an ended Cloud it still holds is deleted", () => {
  assert.deepEqual(parseCloudSummary({ state: "ready", origin, moves: true }), { status: "ready", origin, moves: true });
  assert.deepEqual(parseCloudSummary({ state: "ready", origin, moves: "yes" }), { status: "ready", origin });
  assert.deepEqual(parseCloudSummary({ state: "stopped", hold: { until: NOW + 86_400_000 } }), { status: "stopped", hold: { until: NOW + 86_400_000 } });
  assert.deepEqual(parseCloudSummary({ state: "stopped", hold: { until: "soon" } }), { status: "stopped" });
});

test("the Admin's cloud summary becomes one plain machine state", () => {
  assert.deepEqual(parseCloudSummary({ state: "ready", origin, pairingAvailable: true }), { status: "ready", origin });
  assert.deepEqual(parseCloudSummary({ state: "setting_up", origin, pairingAvailable: false }), { status: "provisioning", origin });
  assert.deepEqual(parseCloudSummary({ state: "setting_up", origin: null, pairingAvailable: false }), { status: "provisioning" });
  assert.deepEqual(parseCloudSummary({ state: "payment_problem", origin, pairingAvailable: false }), { status: "payment-problem", origin });
  assert.deepEqual(parseCloudSummary({ state: "stopped", origin: null, pairingAvailable: false }), { status: "stopped" });
  assert.deepEqual(parseCloudSummary({ state: "failed", origin, pairingAvailable: false }), { status: "failed", origin });
  assert.deepEqual(parseCloudSummary({ state: "ready", origin, pairingAvailable: true, allowance: { includedUsd: 25, usedUsd: 25.4, resetsAt: NOW + 86_400_000 } }),
    { status: "ready", origin });
});

test("a Cloud whose plan sleeps carries the Admin's power word; a malformed one is dropped, never the machine", () => {
  const power = { state: "asleep", since: NOW - 60_000, sleeps: true };
  assert.deepEqual(parseCloudSummary({ state: "ready", origin, power }), { status: "ready", origin, power });
  for (const state of ["awake", "waking"]) assert.deepEqual(parseCloudPower({ ...power, state }), { ...power, state });
  assert.deepEqual(parseCloudPower({ ...power, extra: "ignored" }), power);
  for (const bad of [null, "asleep", [], { ...power, state: "sleeping" }, { ...power, state: "toString" }, { ...power, since: "now" }, { ...power, since: 0 },
    { ...power, sleeps: false }, { state: "asleep", since: NOW }]) {
    assert.equal(parseCloudPower(bad), null, JSON.stringify(bad));
    assert.deepEqual(parseCloudSummary({ state: "ready", origin, power: bad }), { status: "ready", origin }, JSON.stringify(bad));
  }
});

test("a malformed summary is no machine at all", () => {
  for (const input of [null, undefined, "ready", [], { state: "running", origin }, { state: "ready" }, { state: "ready", origin: null },
    { state: "ready", origin: "http://omb-u-1a2b3c4d5e6f.fly.dev" }, { state: "ready", origin: `${origin}/pair` },
    { state: "ready", origin: "https://user:pw@omb-u-1a2b3c4d5e6f.fly.dev" }, { state: "ready", origin: "https://localhost" },
    { state: "stopped", origin: "javascript:alert(1)" }, { state: "toString", origin }, { state: "__proto__", origin },
    { state: "allowance_used", origin }]) {
    assert.equal(parseCloudSummary(input), null, JSON.stringify(input));
  }
});

test("a pairing grant is accepted only for the machine it was asked for, fresh and well formed", () => {
  const grant = { cloudContractVersion: 1, origin, code, pairingUrl: `${origin}/pair#code=${code}`, expiresAt: NOW + 300_000, credential: `omb_pair_${"c".repeat(43)}` };
  assert.deepEqual(parsePairingGrant(grant, origin, NOW), { origin, code, expiresAt: NOW + 300_000 });
  for (const bad of [{ ...grant, origin: "https://omb-u-ffffffffffff.fly.dev" }, { ...grant, cloudContractVersion: 2 }, { ...grant, code: "abcd-efgh-jk23" },
    { ...grant, code: "ABCD-EFGH-JK01" }, { ...grant, code: `${code}&x=1` }, { ...grant, expiresAt: NOW }, { ...grant, expiresAt: NOW + 3_600_000 }, null]) {
    assert.equal(parsePairingGrant(bad, origin, NOW), null, JSON.stringify(bad));
  }
});

test("the machine is listed under Servers once, never renamed and never made active", () => {
  const local = { environments: [], activeId: environments.LOCAL_ID };
  assert.equal(withCloudHome(local, null, () => "x"), local);
  assert.equal(withCloudHome(local, { status: "provisioning", origin }, () => "x"), local);
  const listed = withCloudHome(local, { status: "ready", origin }, () => "cloud-1");
  assert.deepEqual(listed, { environments: [{ id: "cloud-1", kind: "remote", name: CLOUD_HOME_NAME, origin, home: true }], activeId: environments.LOCAL_ID });
  const renamed = { ...listed, environments: [{ ...listed.environments[0], name: "Work cloud" }] };
  assert.equal(withCloudHome(renamed, { status: "stopped", origin }, () => "cloud-2"), renamed);
  assert.equal(savedCloudHomeOrigin(renamed), origin, "the hint follows the entry this app listed, whatever it is called");
});

test("the name and colour chosen while it was set up are what it is listed under; anything else is My Cloud in no colour", () => {
  const local = { environments: [], activeId: environments.LOCAL_ID };
  assert.deepEqual(withCloudHome(local, { status: "ready", origin }, () => "cloud-1", { name: "Studio", color: "teal" }).environments,
    [{ id: "cloud-1", kind: "remote", name: "Studio", origin, color: "teal", home: true }]);
  assert.deepEqual(withCloudHome(local, { status: "ready", origin }, () => "cloud-1", { name: "", color: "#ff0000" }).environments,
    [{ id: "cloud-1", kind: "remote", name: CLOUD_HOME_NAME, origin, home: true }]);
  const saved = environments.parseEnvironments(environments.serializeEnvironments(withCloudHome(local, { status: "ready", origin }, () => "cloud-1", { name: "Studio", color: "teal" })));
  assert.deepEqual(saved.environments, [{ id: "cloud-1", kind: "remote", name: "Studio", origin, color: "teal", home: true }]);
  assert.deepEqual(environments.parseEnvironments({ environments: [{ id: "c", origin, color: "url(javascript:x)", home: "yes" }] }).environments,
    [{ id: "c", kind: "remote", name: new URL(origin).host, origin }], "a colour is one of six names; anything else is dropped");
  const recolored = environments.withEnvironmentLook(saved, origin, { name: "Studio two", color: "red" });
  assert.deepEqual(recolored.environments[0], { id: "cloud-1", kind: "remote", name: "Studio two", origin, color: "red", home: true });
  assert.equal(environments.withEnvironmentLook(recolored, origin, { name: "Studio two", color: "red" }), recolored, "nothing to change: the same state");
  assert.equal(environments.withEnvironmentLook(recolored, "https://elsewhere.example", { name: "X", color: "red" }), recolored);
  assert.deepEqual(environments.workspaceSummary({ ...recolored, activeId: "cloud-1" }), { local: false, name: "Studio two", origin, color: "red" });
});

test("connecting uses the pairing page with the code in the hash, or the machine itself", () => {
  assert.equal(cloudHomeConnectUrl({ origin, grant: { origin, code, expiresAt: NOW + 1 } }, NOW), `${origin}/pair#code=${code}`);
  assert.equal(cloudHomeConnectUrl({ origin, grant: { origin, code, expiresAt: NOW } }, NOW), origin);
  assert.equal(cloudHomeConnectUrl({ origin, grant: { origin: "https://other.fly.dev", code, expiresAt: NOW + 1 } }, NOW), origin);
  assert.equal(cloudHomeConnectUrl({ origin, grant: null }, NOW), origin);
  assert.equal(cloudHomeConnectUrl({ origin, grant: { origin, code, expiresAt: NOW + 1 } }, NOW, "phone"), `${origin}/pair?desktop-settings=phone#code=${code}`);
  assert.equal(cloudHomeConnectUrl({ origin, grant: null }, NOW, "phone"), `${origin}/?desktop-settings=phone`);
  assert.equal(cloudHomeConnectUrl({ origin, grant: null }, NOW, "evil"), origin);
  assert.deepEqual(environments.parseHostedWorkspaceLink(`${origin}/pair#code=${code}`), { origin, code, url: `${origin}/pair#code=${code}` });
});

const accessToken = `omc_${"T".repeat(43)}`;
async function admin(t) {
  const f = { now: NOW, cloud: undefined, pairing: null, pairingStatus: 200, requests: [], states: [], saved: null, timer: null,
    entitlement: { plan: "pro", status: "active", expiresAt: NOW + 30 * 86_400_000, version: 3 } };
  const identity = () => ({ cloudContractVersion: 1, expiresAt: f.now + 86_400_000, device: { id: "fixture-device" }, account: { id: "fixture-account", email: "person@example.test" } });
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) {}
    f.requests.push(`${req.method} ${req.url} ${req.headers.authorization === `Bearer ${accessToken}` ? "token" : "anonymous"}`);
    const send = (status, data) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
    if (req.url === "/api/cloud/desktop/authorize") return send(201, { cloudContractVersion: 1, deviceCode: "A".repeat(43), userCode: "ABCDE-FGHJK",
      verificationUriComplete: `${f.origin}/cloud/desktop?code=ABCDE-FGHJK`, expiresIn: 600, interval: 5 });
    if (req.url === "/api/cloud/desktop/token") return send(200, { ...identity(), accessToken });
    if (req.headers.authorization !== `Bearer ${accessToken}`) return send(401, { error: "invalid_token" });
    if (req.url === "/api/cloud/desktop/session") return send(200, { ...identity(), entitlement: f.entitlement, cloud: f.cloud ?? null });
    if (req.url === "/api/cloud/desktop/pairing" && req.method === "POST") {
      return f.pairingStatus === 200 ? send(200, { cloudContractVersion: 1, ...f.pairing }) : send(f.pairingStatus, { error: "Your Cloud is not ready yet." });
    }
    send(404, { error: "not_found" });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  f.origin = `http://127.0.0.1:${server.address().port}`;
  f.client = createCloudAccountClient({ origin: f.origin, fixture: true, deviceName: "Fixture computer", platform: "darwin", appVersion: "0.1.fixture", now: () => f.now,
    store: { read: async () => f.saved, write: async value => { f.saved = structuredClone(value); } },
    openBrowser: async () => {}, onState: state => f.states.push(state),
    setTimer: callback => { f.timer = callback; return 1; }, clearTimer: () => { f.timer = null; } });
  f.connect = async () => { await f.client.begin(); f.timer(); for (let i = 0; i < 200 && f.client.state().status !== "connected"; i++) await new Promise(r => setTimeout(r, 5)); };
  t.after(async () => { f.client.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return f;
}

test("signed out, the app asks nothing about a Cloud machine and offers nothing to join", async t => {
  const f = await admin(t);
  assert.equal((await f.client.start()).status, "signed-out");
  assert.deepEqual(f.requests, []);
  assert.equal(f.client.homeTarget(), null);
  await assert.rejects(f.client.pairHome(), /not ready/);
  assert.deepEqual(f.requests, []);
});

test("the session's machine reaches the page as state and address; a code is minted only on request", async t => {
  const f = await admin(t);
  f.cloud = { state: "setting_up", origin, pairingAvailable: false };
  await f.connect();
  assert.deepEqual(f.client.state().machine, { status: "provisioning", origin });
  assert.equal(f.client.homeTarget(), null);

  f.cloud = { state: "ready", origin, pairingAvailable: true };
  assert.deepEqual((await f.client.refresh()).machine, { status: "ready", origin });
  assert.deepEqual(f.client.homeTarget(), { origin });
  assert.ok(!f.requests.some(line => line.includes("/pairing")), "reading the session never mints a code");

  f.pairing = { origin, code, pairingUrl: `${origin}/pair#code=${code}`, expiresAt: NOW + 300_000, credential: `omb_pair_${"c".repeat(43)}` };
  assert.deepEqual(await f.client.pairHome(), { origin, code, expiresAt: NOW + 300_000 });
  assert.equal(f.requests.filter(line => line === "POST /api/cloud/desktop/pairing token").length, 1);
  assert.ok(!JSON.stringify(f.states).includes(code), "the code never reaches a renderer snapshot");
  assert.ok(!JSON.stringify(f.saved).includes(code), "the code is never persisted");
});

test("a grant for another machine or an Admin refusal never connects", async t => {
  const f = await admin(t);
  f.cloud = { state: "ready", origin, pairingAvailable: true };
  await f.connect();
  f.pairing = { origin: "https://omb-u-ffffffffffff.fly.dev", code, expiresAt: NOW + 300_000 };
  await assert.rejects(f.client.pairHome(), /Invalid Cloud pairing response/);
  f.pairingStatus = 409;
  await assert.rejects(f.client.pairHome(), error => error.status === 409);
});

test("stopped, unpaid and failed machines show plainly and cannot be joined", async t => {
  const f = await admin(t);
  f.cloud = { state: "payment_problem", origin, pairingAvailable: false };
  f.entitlement = { plan: "free", status: "inactive", expiresAt: null, version: 4 };
  await f.connect();
  assert.deepEqual(f.client.state().machine, { status: "payment-problem", origin });
  assert.equal(f.client.homeTarget(), null);
  for (const [state, status] of [["stopped", "stopped"], ["failed", "failed"]]) {
    f.cloud = { state, origin, pairingAvailable: false };
    assert.deepEqual((await f.client.refresh()).machine, { status, origin });
    assert.equal(f.client.homeTarget(), null);
  }
  f.entitlement = { plan: "pro", status: "active", expiresAt: NOW + 30 * 86_400_000, version: 5 };
  f.cloud = { state: "ready", origin, pairingAvailable: true };
  assert.deepEqual((await f.client.refresh()).machine, { status: "ready", origin });
  assert.deepEqual(f.client.homeTarget(), { origin });
});

test("signing out forgets the machine", async t => {
  const f = await admin(t);
  f.cloud = { state: "ready", origin, pairingAvailable: true };
  await f.connect();
  await f.client.signOut();
  assert.equal(f.client.state().machine, undefined);
  assert.equal(f.client.homeTarget(), null);
});

test("main lists the machine from verified states only, and connects without a dialog", async () => {
  const source = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  const start = source.indexOf("function rememberCloudHome("), end = source.indexOf("async function forgetEnvironment(", start);
  assert.ok(start > 0 && end > start);
  const persisted = [], navigated = [], dialogs = [], probes = [];
  let client, look = null;
  const context = vm.createContext({
    environmentsState: { environments: [], activeId: environments.LOCAL_ID },
    persistEnvironments: next => { persisted.push(next); context.environmentsState = next; },
    navigateMainWindow: url => navigated.push(url), withCloudHome, withoutOldCloudHome, homeLook, withActive: environments.withActive, cloudLook: { pending: () => look },
    randomUUID: () => "cloud-home-id", slog: () => {}, Date: { now: () => NOW }, AbortSignal: { timeout: ms => ({ timeoutMs: ms }) },
    session: { defaultSession: { fetch: async (url, init) => { probes.push([url, init.credentials, init.signal.timeoutMs]); return { ok: false, json: async () => ({}) }; } } },
    dialog: { showMessageBox: async () => { dialogs.push(1); return { response: 1 }; } },
    ensureCloudAccount: () => client,
  });
  vm.runInContext(`${source.slice(start, end)}; this.rememberCloudHome = rememberCloudHome; this.connectCloudHome = connectCloudHome; this.activateCloud = activateCloud;`, context);
  context.rememberCloudHome({ status: "unavailable", machine: { status: "ready", origin } });
  context.rememberCloudHome({ status: "signed-out" });
  assert.deepEqual(persisted, []);
  look = { name: "Studio", color: "purple" };
  context.rememberCloudHome({ status: "connected", machine: { status: "ready", origin } });
  context.rememberCloudHome({ status: "connected", machine: { status: "ready", origin } });
  assert.equal(persisted.length, 1);
  assert.equal(context.environmentsState.activeId, environments.LOCAL_ID);
  assert.deepEqual([context.environmentsState.environments[0].name, context.environmentsState.environments[0].color], ["Studio", "purple"], "listed as named while it was set up");
  context.environmentsState = { environments: [], activeId: environments.LOCAL_ID }; look = null;

  // Every open goes through the home window (home-window.mjs), which looks nothing up before the Admin says ready.
  const opened = [], state = { status: "connected" };
  let done = 0, refuse = false;
  client = { state: () => state, checkoutDone: () => done++ };
  context.cloudAccount = client;
  context.homeWindow = { openCloud: async (open) => { opened.push(open); if (refuse) throw new Error("My Cloud is not ready to connect yet."); } };
  assert.equal(await context.connectCloudHome(), state, "the renderer gets the sign-in's state back, as before");
  await context.connectCloudHome("phone");
  assert.deepEqual(opened, [null, "phone"]);
  assert.deepEqual([navigated, probes, done], [[], [], 0], "main itself neither loads nor asks My Cloud");
  context.activateCloud(origin);
  assert.equal(done, 1, "opened: the purchase is over");
  assert.equal(context.environmentsState.activeId, "cloud-home-id");
  refuse = true;
  await assert.rejects(context.connectCloudHome(), /not ready/);
  assert.deepEqual(dialogs, []);
});

test("why a ready Cloud can't be reached is read when the Admin sends it, and says so plainly; a malformed reason is dropped, never the machine", () => {
  const host = { cause: "host", since: NOW - 6 * 60_000 }, quiet = { cause: "no_answer", since: NOW - 16 * 60_000 };
  assert.deepEqual(parseCloudSummary({ state: "ready", origin, pairingAvailable: true, unreachable: host }), { status: "ready", origin, unreachable: host });
  assert.deepEqual(parseCloudSummary({ state: "ready", origin, unreachable: quiet }), { status: "ready", origin, unreachable: quiet });
  for (const unreachable of [{ cause: "reboot", since: NOW }, { cause: "host" }, { cause: "host", since: "now" }, { cause: "toString", since: NOW }, "host", null, []])
    assert.deepEqual(parseCloudSummary({ state: "ready", origin, unreachable }), { status: "ready", origin }, JSON.stringify(unreachable));
  assert.deepEqual(parseCloudSummary({ state: "stopped", unreachable: host }), { status: "stopped" });
  const connected = machine => ({ status: "connected", machine });
  assert.equal(cloudUnreachableText(connected({ status: "ready", origin, unreachable: host })),
    "The server My Cloud runs on is being restarted by our hosting provider. My Cloud and its files are safe, and it comes back on its own, usually within about 20 minutes.");
  assert.equal(cloudUnreachableText(connected({ status: "ready", origin, unreachable: quiet }), origin), "My Cloud hasn't answered for a few minutes. Nothing was lost, and we've been told.");
  assert.equal(cloudUnreachableText(connected({ status: "ready", origin, unreachable: host }), "https://elsewhere.example.test"), null);
  assert.equal(cloudUnreachableText(connected({ status: "ready", origin })), null);
  assert.equal(cloudUnreachableText({ status: "unavailable", machine: { status: "ready", origin, unreachable: host } }), null);
  assert.equal(cloudUnreachableText(null), null);
  assert.ok(!/Fly/.test(cloudUnreachableText(connected({ status: "ready", origin, unreachable: host }))));
});

test("setup progress, a failed setup's next try and the disk are read when the Admin sends them, and never cost the machine", () => {
  assert.deepEqual(parseCloudSummary({ state: "setting_up", setup: { step: "starting", slow: true } }), { status: "provisioning", setup: { step: "starting", slow: true } });
  assert.deepEqual(parseCloudSummary({ state: "setting_up", setup: { step: "checking", slow: "yes" } }), { status: "provisioning", setup: { step: "checking" } });
  for (const setup of [{ step: "booting" }, { step: "constructor" }, "storage", null, []]) assert.deepEqual(parseCloudSummary({ state: "setting_up", setup }), { status: "provisioning" });
  assert.deepEqual(parseCloudSummary({ state: "ready", origin, setup: { step: "storage" }, retryAt: NOW }), { status: "ready", origin });
  assert.deepEqual(parseCloudSummary({ state: "failed", retryAt: NOW + 60_000 }), { status: "failed", retryAt: NOW + 60_000 });
  assert.deepEqual(parseCloudSummary({ state: "failed", retryAt: "soon" }), { status: "failed" });
  assert.deepEqual(parseCloudSummary({ state: "ready", origin, disk: { gb: 20, maxGb: 100 } }), { status: "ready", origin, disk: { gb: 20, maxGb: 100 } });
  for (const disk of [{ gb: 20, maxGb: 10 }, { gb: 0, maxGb: 10 }, { gb: 10.5, maxGb: 20 }, { gb: 10 }, "10"]) assert.deepEqual(parseCloudSummary({ state: "ready", origin, disk }), { status: "ready", origin });
});

test("a payment being linked is read on its own, and only in its two known states", () => {
  assert.deepEqual(parseCloudPurchase({ state: "confirming", plan: "max", paidAt: NOW }), { state: "confirming", tier: "max", paidAt: NOW });
  assert.deepEqual(parseCloudPurchase({ state: "held", plan: "Max <b>", paidAt: -1 }), { state: "held" });
  for (const input of [null, undefined, "held", { state: "claimed" }, { state: "active", plan: "pro" }, []]) assert.equal(parseCloudPurchase(input), null);
});

test("a free trial is read in the Admin's five states, with only what is well formed; anything else is no trial", () => {
  const DAY = 86_400_000, endsAt = NOW + 2 * DAY;
  const active = { state: "active", tier: "pro", endsAt, amount: 4900, chargeAt: endsAt, holdUntil: null, deleteAt: null, keep: "none" };
  assert.deepEqual(parseCloudTrial(active), active);
  const ending = { state: "ending", tier: "max", endsAt, amount: 9900, chargeAt: null, holdUntil: null, deleteAt: endsAt + 3 * DAY, keep: "portal" };
  assert.deepEqual(parseCloudTrial(ending), ending);
  for (const state of ["processing", "late", "ended"]) assert.equal(parseCloudTrial({ ...active, state })?.state, state);
  assert.equal(parseCloudTrial({ ...active, tier: "team-2027" }).tier, "team-2027");
  assert.deepEqual(parseCloudTrial({ ...active, tier: "Pro <b>", amount: 49.5, chargeAt: "soon", holdUntil: -1, deleteAt: {} }),
    { state: "active", endsAt, amount: null, chargeAt: null, holdUntil: null, deleteAt: null, keep: "none" });
  assert.deepEqual(parseCloudTrial({ state: "late", endsAt, keep: "portal" }),
    { state: "late", endsAt, amount: null, chargeAt: null, holdUntil: null, deleteAt: null, keep: "portal" });
  assert.deepEqual(parseCloudTrial({ ...active, personalAmount: 2900 }), { ...active, personalAmount: 2900 });
  for (const personalAmount of [29.5, -1, "2900", 0, 20_000_000]) assert.equal("personalAmount" in parseCloudTrial({ ...active, personalAmount }), false, String(personalAmount));
  assert.deepEqual(parseCloudTrial({ ...active, switchTo: { tier: "starter", amount: 1500, label: "Starter <b>" } }), { ...active, switchTo: { tier: "starter", amount: 1500 } });
  assert.deepEqual(parseCloudTrial({ ...active, switchTo: { tier: "personal", amount: 2900 }, personalAmount: 2900 }),
    { ...active, switchTo: { tier: "personal", amount: 2900 }, personalAmount: 2900 }, "while Personal is the way down, an Admin says it both ways");
  for (const switchTo of [null, "starter", [], {}, { tier: "starter" }, { amount: 1500 }, { tier: "team", amount: 1500 }, { tier: "Starter", amount: 1500 },
    { tier: "toString", amount: 1500 }, { tier: ["starter"], amount: 1500 }, { tier: "starter", amount: 15.5 }, { tier: "starter", amount: 0 }, { tier: "starter", amount: -1 },
    { tier: "starter", amount: "1500" }, { tier: "starter", amount: 20_000_000 }]) {
    assert.equal("switchTo" in parseCloudTrial({ ...active, switchTo }), false, JSON.stringify(switchTo));
  }
  for (const input of [null, undefined, "active", [], { ...active, state: "paused" }, { ...active, state: "toString" }, { ...active, state: ["active"] },
    { ...active, endsAt: 0 }, { ...active, endsAt: "2026-10-15" }, { ...active, endsAt: 1.5 }, { ...active, keep: "refund" }, { ...active, keep: undefined }]) {
    assert.equal(parseCloudTrial(input), null, JSON.stringify(input));
  }
});

test("the trial's AI credit is read only when it adds up, and only while it lasts", () => {
  assert.deepEqual(parseCloudCredit({ grantedUsd: 5, remainingUsd: 3.2, state: "active" }), { grantedUsd: 5, remainingUsd: 3.2, state: "active" });
  assert.deepEqual(parseCloudCredit({ grantedUsd: 5, remainingUsd: 0, state: "used_up", spentUsd: 5 }), { grantedUsd: 5, remainingUsd: 0, state: "used_up" });
  for (const input of [null, "5", [], { grantedUsd: 5, remainingUsd: 3, state: "ended" }, { grantedUsd: 0, remainingUsd: 0, state: "active" },
    { grantedUsd: 5, remainingUsd: 6, state: "active" }, { grantedUsd: 5, remainingUsd: -1, state: "active" }, { grantedUsd: "5", remainingUsd: 3, state: "active" },
    { grantedUsd: Infinity, remainingUsd: 3, state: "active" }, { grantedUsd: 5, remainingUsd: Number.NaN, state: "active" }, { grantedUsd: 5, state: "active" }]) {
    assert.equal(parseCloudCredit(input), null, JSON.stringify(input));
  }
});

const allowances = (computers, diskGb, maxDiskGb = diskGb) => ({ cpus: computers, cpuKind: "shared", memoryMb: computers * 1024, diskGb, maxDiskGb, computers, computerHours: computers * 50, voiceCharacters: 100_000 });
const catalog = () => [
  { tier: "starter", label: "Starter", price: { currency: "USD", amount: 1500, interval: "month", regularAmount: null, note: null }, allowances: allowances(1, 10) },
  { tier: "pro", label: "Pro", price: { currency: "USD", amount: 4900, interval: "month", regularAmount: 8900, note: "Launch price, then $89/month." }, allowances: allowances(4, 40, 50) },
  { tier: "max", label: "Max", price: { currency: "USD", amount: 9900, interval: "month", regularAmount: null, note: null }, allowances: allowances(8, 80, 100) },
];

test("the session's offer is this account's: its plans, the preselected one, and the trial's extras only with a trial", () => {
  const offer = parseCloudOffer({ plans: catalog(), recommended: "pro", trialDays: 7, creditUsd: 5, refundDays: 14, reminderDays: 2, checkout: { plan: "pro", openUntil: NOW + 3600_000 } });
  assert.ok(offer.plans.every(plan => !("sleeps" in plan.allowances)), "a plan says nothing about sleeping unless the Admin does");
  assert.deepEqual(offer.plans.map(plan => [plan.tier, plan.label, plan.amount, plan.trialDays]), [["starter", "Starter", 1500, 7], ["pro", "Pro", 4900, 7], ["max", "Max", 9900, 7]]);
  assert.deepEqual(offer.plans[1].allowances, { cpus: 4, cpuKind: "shared", memoryMb: 4096, diskGb: 40, maxDiskGb: 50, computers: 4, computerHours: 200, voiceCharacters: 100_000 });
  assert.equal(offer.recommended, "pro");
  assert.deepEqual([offer.creditUsd, offer.refundDays, offer.reminderDays], [5, 14, 2]);
  assert.deepEqual(offer.checkout, { plan: "pro", openUntil: NOW + 3600_000 });
  assert.ok(!JSON.stringify(offer).includes("8900") && !JSON.stringify(offer).includes("Launch"));
  const perPlan = parseCloudOffer({ plans: catalog().map(plan => plan.tier === "max" ? plan : { ...plan, trialDays: 7 }), trialDays: 7, creditUsd: 5 });
  assert.deepEqual(perPlan.plans.map(plan => plan.trialDays ?? null), [7, 7, null]);
  const paid = parseCloudOffer({ plans: catalog(), creditUsd: 5, reminderDays: 2, refundDays: 14 });
  assert.deepEqual(paid.plans.map(plan => plan.trialDays ?? null), [null, null, null]);
  assert.deepEqual([paid.creditUsd, paid.reminderDays, paid.refundDays], [undefined, undefined, 14]);
  assert.equal(parseCloudOffer({ plans: catalog(), recommended: "team" }).recommended, "pro");
  assert.equal(parseCloudOffer({ plans: catalog().filter(plan => plan.tier !== "pro") }).recommended, "starter");
});

test("an Admin that still sells Personal: this app sells no Personal, preselects Pro instead, and watches no checkout of it", () => {
  const personal = { tier: "personal", label: "Personal", price: { currency: "USD", amount: 2900, interval: "month" }, allowances: allowances(2, 10, 20) };
  const [starter, pro, max] = catalog(), older = [starter, personal, pro, max];
  for (const recommended of ["pro", "personal", undefined]) {
    const offer = parseCloudOffer({ plans: older, recommended, trialDays: 7, checkout: { plan: "personal", openUntil: NOW + 3600_000 } });
    assert.deepEqual(offer.plans.map(plan => plan.tier), ["starter", "pro", "max"], String(recommended));
    assert.equal(offer.recommended, "pro", String(recommended));
    assert.equal(offer.checkout, undefined, String(recommended));
  }
  assert.equal(parseCloudOffer({ plans: [starter, personal, max], recommended: "personal" }).recommended, "starter", "with no Pro, the first plan left");
  assert.deepEqual(parsePublicOffer({ plans: older, trial: { days: 7 } }).plans.map(plan => plan.tier), ["starter", "pro", "max"]);
});

test("a plan's swap, backup days and CPU kind come along when the Admin lists them, and are left out when they are malformed", () => {
  const listed = parseCloudOffer({ plans: [{ ...catalog()[1], allowances: { ...allowances(4, 10, 100), swapMb: 4096, snapshotDays: 14 } }] });
  assert.deepEqual(listed.plans[0].allowances, { cpus: 4, cpuKind: "shared", memoryMb: 4096, diskGb: 10, maxDiskGb: 100, computers: 4, computerHours: 200, voiceCharacters: 100_000,
    swapMb: 4096, snapshotDays: 14 });
  for (const extra of [{ swapMb: 0 }, { swapMb: -1 }, { swapMb: "4096" }, { snapshotDays: 0 }, { snapshotDays: 400 }, { snapshotDays: 7.5 }, { cpuKind: "gpu" }, { cpuKind: null }]) {
    const plan = parseCloudOffer({ plans: [{ ...catalog()[1], allowances: { ...allowances(4, 10, 100), ...extra } }] }).plans[0];
    assert.deepEqual(Object.keys(plan.allowances).filter(key => ["swapMb", "snapshotDays"].includes(key) || (key === "cpuKind" && "cpuKind" in extra)), [], JSON.stringify(extra));
  }
});

test("a malformed offer is no offer, and a malformed plan or extra is left out, never trusted in part", () => {
  for (const input of [null, undefined, "offer", [], {}, { plans: [] }, { plans: "pro" }, { plans: [{ tier: "pro" }] },
    { plans: [{ tier: "pro", price: { currency: "EUR", amount: 4900, interval: "month" } }] },
    { plans: [{ tier: "pro", price: { currency: "USD", amount: 4900, interval: "year" } }] },
    { plans: [{ tier: "Pro <b>", price: { currency: "USD", amount: 4900, interval: "month" } }] },
    { plans: [{ tier: "pro", price: { currency: "USD", amount: 49.5, interval: "month" } }] },
    { plans: [{ tier: "pro", price: { currency: "USD", amount: 0, interval: "month" } }] }]) {
    assert.equal(parseCloudOffer(input), null, JSON.stringify(input));
  }
  const [starter, pro] = catalog();
  const offer = parseCloudOffer({ plans: [starter, { ...pro, label: "Pro <script>", allowances: { cpus: "4" }, trialDays: 99 }, { ...pro }, { tier: "team", price: null }],
    trialDays: 0, creditUsd: 500, refundDays: 400, reminderDays: 2, checkout: { plan: "max", openUntil: NOW } });
  assert.deepEqual(offer.plans, [{ tier: "starter", label: "Starter", amount: 1500, allowances: { cpus: 1, cpuKind: "shared", memoryMb: 1024, diskGb: 10, maxDiskGb: 10, computers: 1, computerHours: 50,
    voiceCharacters: 100_000 } },
    { tier: "pro", amount: 4900 }]);
  assert.equal(offer.checkout, undefined); assert.equal(offer.refundDays, undefined); assert.equal(offer.creditUsd, undefined);
});

test("the public offer is the catalog, with the free trial for new customers when the Admin says so", () => {
  const offer = parsePublicOffer({ name: "OpenMausBot", surface: "cloud", plans: catalog(), trial: { days: 7, holdDays: 3, creditUsd: 5, reminderDays: 2 }, refundDays: 14 });
  assert.deepEqual(offer.plans.map(plan => plan.trialDays), [7, 7, 7]);
  assert.deepEqual([offer.recommended, offer.creditUsd, offer.reminderDays, offer.refundDays, offer.checkout], ["pro", 5, 2, 14, undefined]);
  const today = parsePublicOffer({ plans: catalog() });
  assert.deepEqual(today.plans.map(plan => plan.trialDays ?? null), [null, null, null]);
  assert.equal(today.creditUsd, undefined); assert.equal(today.refundDays, undefined);
  for (const config of [null, "config", { trial: { days: 7 } }, { plans: [], trial: { days: 7 } }]) assert.equal(parsePublicOffer(config), null);
  for (const trial of [{ days: 0 }, { days: 31 }, { days: "7" }, { days: 7.5 }]) {
    assert.deepEqual(parsePublicOffer({ plans: catalog(), trial }).plans.map(plan => plan.trialDays ?? null), [null, null, null], JSON.stringify(trial));
  }
  const plain = withoutTrial(offer);
  assert.deepEqual(plain.plans.map(plan => plan.trialDays ?? null), [null, null, null]);
  assert.deepEqual([plain.creditUsd, plain.reminderDays, plain.refundDays], [undefined, undefined, 14]);
  assert.equal(withoutTrial(null), null);
});

test("a plan's disk is only what the Admin says; without its word a move is measured against today's free space", () => {
  const GB = 1024 ** 3, paid = tier => ({ status: "connected", entitlement: { plan: "pro", ...(tier ? { tier } : {}), status: "active", expiresAt: NOW + 1, version: 1 } });
  for (const tier of ["personal", "pro", undefined, "max", "team"]) assert.equal(cloudPlanDisk({ ...paid(tier), machine: { status: "ready", origin } }), null);
  assert.deepEqual(cloudPlanDisk({ ...paid("pro"), machine: { status: "ready", origin, disk: { gb: 10, maxGb: 50 } } }), { volumeBytes: 10 * GB, maxBytes: 50 * GB });
  assert.deepEqual(cloudPlanDisk({ ...paid("max"), machine: { status: "ready", origin, disk: { gb: 30, maxGb: 80 } } }), { volumeBytes: 30 * GB, maxBytes: 80 * GB, largest: true });
  for (const state of [null, { status: "signed-out" }, { status: "unavailable", lastPlan: { tier: "max", active: true } },
    { status: "connected", entitlement: { plan: "free", status: "inactive", expiresAt: null, version: 0 }, machine: { status: "ready", origin, disk: { gb: 10, maxGb: 10 } } }]) assert.equal(cloudPlanDisk(state), null);
});

test("the Cloud's address is remembered through a failed check for the same account, and forgotten otherwise", () => {
  const account = { id: "a1", email: "person@example.test" };
  let known = rememberedCloudHome(null, { status: "connected", account, machine: { status: "ready", origin } });
  assert.deepEqual(known, { accountId: "a1", origin });
  known = rememberedCloudHome(known, { status: "unavailable", account });
  assert.deepEqual(known, { accountId: "a1", origin });
  known = rememberedCloudHome(known, { status: "reauth-required", account });
  assert.deepEqual(known, { accountId: "a1", origin });
  assert.equal(rememberedCloudHome(known, { status: "connected", account: { id: "a2", email: "other@example.test" } }), null);
  assert.deepEqual(rememberedCloudHome(known, { status: "connected", account, machine: { status: "stopped" } }), { accountId: "a1", origin });
  assert.equal(rememberedCloudHome(known, { status: "connected", account }), null);
  assert.equal(rememberedCloudHome(known, { status: "signed-out" }), null);
  assert.equal(isCloudHomeEntry({ origin }, { remembered: known }), true);
  assert.equal(isCloudHomeEntry({ origin }, { homeOrigin: origin }), true);
  assert.equal(isCloudHomeEntry({ origin: "https://other.example.test" }, { homeOrigin: origin, remembered: known }), false);
  assert.equal(isCloudHomeEntry({ origin }, {}), false);
});

test("the Server menu opens My Cloud through the Cloud's own connection, never a pairing-code page", async () => {
  const source = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  const start = source.indexOf("let rememberedHome = null;"), end = source.indexOf("const organizationEntry = createOrganizationEntry", start);
  assert.ok(start > 0 && end > start);
  const calls = [];
  let connect = async () => { calls.push("connect"); }, signedIn = false;
  const entry = { id: "cloud", name: CLOUD_HOME_NAME, origin }, other = { id: "vps", name: "VPS", origin: "https://vps.example.test" };
  const context = vm.createContext({
    environmentsState: { environments: [entry, other], activeId: environments.LOCAL_ID }, LOCAL_ID: environments.LOCAL_ID,
    cloudAccount: { homeTarget: () => ({ origin }), state: () => ({}) }, isCloudHomeEntry, slog: () => {},
    connectCloudHome: (...args) => connect(...args), cloudHomeSignedIn: async () => signedIn,
    openCloudSettings: async () => { calls.push("settings"); },
    persistEnvironments: next => { calls.push(`active:${next.activeId}`); context.environmentsState = next; }, withActive: environments.withActive,
    navigateMainWindow: url => calls.push(`navigate:${url}`), activeOrigin: () => context.environmentsState.environments.find(e => e.id === context.environmentsState.activeId)?.origin,
    homeWindow: { cloudOrigin: () => null, asking: () => false }, showHome: async (options) => { calls.push(options ? `home:${JSON.stringify(options)}` : "home"); },
    homePlaces: { remember: (place) => calls.push(`remember:${JSON.stringify(place)}`) },
    runningDataDir: "/data", desktopDataDir: () => "/data",
  });
  vm.runInContext(`${source.slice(start, end)}; this.switchEnvironment = switchEnvironment; this.remember = value => { rememberedHome = value; };`, context);
  await context.switchEnvironment("cloud");
  assert.deepEqual(calls, ["remember:null", "connect"]);
  calls.length = 0; await context.switchEnvironment("vps");
  assert.deepEqual(calls, ["remember:null", "active:vps", `navigate:${other.origin}`], "another server: the remembered team is let go");
  const acme = { id: "acme", name: "Acme", origin: "https://omb-u-acme.fly.dev", team: { id: "team-acme", role: "member" } };
  context.environmentsState = { environments: [entry, other, acme], activeId: environments.LOCAL_ID };
  calls.length = 0; await context.switchEnvironment("acme");
  assert.deepEqual(calls, ['home:{"place":{"team":"team-acme","name":"Acme"}}'], "a team opens through the home window's team pairing, never a plain navigation");
  context.environmentsState = { environments: [entry, other, acme], activeId: "acme" };
  context.homeWindow = { cloudOrigin: () => origin, asking: () => false };
  calls.length = 0; await context.switchEnvironment("cloud");
  assert.deepEqual(calls, ["remember:null", 'home:{"place":"cloud"}'], "back to My Cloud from a team: My Cloud itself, remembered");
  context.homeWindow = { cloudOrigin: () => null, asking: () => false };
  context.environmentsState = { environments: [entry, other], activeId: environments.LOCAL_ID };
  context.environmentsState = { environments: [entry, other], activeId: environments.LOCAL_ID };
  context.cloudAccount = { homeTarget: () => null, state: () => ({ status: "connected", machine: { status: "stopped" } }) }; context.remember({ accountId: "a1", origin });
  connect = async () => { calls.push("connect"); throw new Error("Your Cloud is not ready to connect yet."); };
  calls.length = 0; await context.switchEnvironment("cloud");
  assert.deepEqual(calls, ["remember:null", "connect", "settings"], "not signed in there: Settings → OMB Cloud says what to do next");
  signedIn = true; calls.length = 0; await context.switchEnvironment("cloud");
  assert.deepEqual(calls, ["remember:null", "connect", "active:cloud", `navigate:${origin}`], "signed in there already: it opens as any server does");
  context.cloudAccount = null; context.environmentsState = { environments: [entry, other], activeId: environments.LOCAL_ID };
  calls.length = 0; await context.switchEnvironment("cloud");
  assert.deepEqual(calls, ["remember:null", "active:cloud", `navigate:${origin}`]);
  context.homeWindow = { cloudOrigin: () => origin, asking: () => false }; context.environmentsState = { environments: [entry, other], activeId: "vps" };
  calls.length = 0; await context.switchEnvironment("cloud");
  assert.deepEqual(calls, ["remember:null", 'home:{"place":"cloud"}'], "once My Cloud is home, choosing it shows home the one way every window does");

  // A My Cloud entry saved before, for the address the Admin is setting up again: never loaded by its address.
  context.homeWindow = { cloudOrigin: () => null, asking: () => false }; context.remember(null);
  context.cloudAccount = { homeTarget: () => null, state: () => ({ status: "connected", machine: { status: "provisioning", origin } }) };
  context.environmentsState = { environments: [entry, other], activeId: environments.LOCAL_ID };
  connect = async () => { calls.push("connect"); };
  calls.length = 0; await context.switchEnvironment("cloud");
  assert.deepEqual(calls, ["remember:null", "connect"], "the home window's setup screen, until the Admin says ready");
  // That screen is this computer's own page: This computer is already the Server menu's choice, and still leaves it.
  calls.length = 0; await context.switchEnvironment(environments.LOCAL_ID);
  assert.deepEqual(calls, [], "nothing asked for: choosing the server shown changes nothing");
  context.homeWindow = { cloudOrigin: () => null, asking: () => true };
  calls.length = 0; await context.switchEnvironment(environments.LOCAL_ID);
  assert.deepEqual(calls.slice(0, 2), ["remember:null", `active:${environments.LOCAL_ID}`]);
  assert.match(calls[2], /^navigate:/);
});

test("the session's teams are read with their role and their Cloud as the machine summary; a malformed team is left out whole, and a team twice is read once", () => {
  const team = { id: "team-1", name: "Acme", role: "admin", machine: { state: "ready", origin, pairingAvailable: true, status: "ready" } };
  assert.deepEqual(parseCloudTeams([team]), [{ id: "team-1", name: "Acme", role: "admin", machine: { status: "ready", origin } }]);
  assert.deepEqual(parseCloudTeams([{ ...team, machine: null }]), [{ id: "team-1", name: "Acme", role: "admin", machine: null }], "no machine yet");
  assert.deepEqual(parseCloudTeams([{ ...team, machine: { state: "stopped", origin: null, hold: { until: NOW + 1 } } }])[0].machine, { status: "stopped", hold: { until: NOW + 1 } });
  assert.deepEqual(parseCloudTeams([{ ...team, machine: { state: "what" } }])[0].machine, null, "a malformed machine is no machine, never the team's loss");
  assert.deepEqual(parseCloudTeams([{ ...team, name: "  Acme   Inc  " }])[0].name, "Acme Inc");
  assert.deepEqual(parseCloudTeams([team, { ...team, name: "Again" }]).length, 1, "the same id twice");
  for (const bad of [{ ...team, role: "god" }, { ...team, name: "" }, { ...team, id: "" }, { ...team, id: "../x" }, { ...team, id: 7 }, { ...team, name: 7 }, null, "team", []]) {
    assert.deepEqual(parseCloudTeams([bad]), [], JSON.stringify(bad));
  }
  for (const none of [undefined, null, {}, "x", 3]) assert.deepEqual(parseCloudTeams(none), [], String(none));
  assert.deepEqual(CLOUD_TEAM_ROLES, ["owner", "admin", "member"]);
  assert.deepEqual(["owner", "admin", "member", "x", undefined].map(teamRoleLabel), ["Super admin", "Admin", "User", "User", "User"]);
});
