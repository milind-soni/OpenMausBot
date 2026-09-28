import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { createCloudAccountClient } from "./cloud-account.mjs";
import { CLOUD_HOME_NAME, cloudHomeConnectUrl, parseCloudSummary, parsePairingGrant, withCloudHome } from "./cloud-home.mjs";
import environments from "./environments.cjs";

const NOW = 1_800_000_000_000;
const origin = "https://omb-u-1a2b3c4d5e6f.fly.dev";
const code = "ABCD-EFGH-JK23";

test("the Admin's cloud summary becomes one plain machine state", () => {
  assert.deepEqual(parseCloudSummary({ state: "ready", origin, pairingAvailable: true }), { status: "ready", origin });
  assert.deepEqual(parseCloudSummary({ state: "setting_up", origin, pairingAvailable: false }), { status: "provisioning", origin });
  assert.deepEqual(parseCloudSummary({ state: "setting_up", origin: null, pairingAvailable: false }), { status: "provisioning" });
  assert.deepEqual(parseCloudSummary({ state: "payment_problem", origin, pairingAvailable: false }), { status: "payment-problem", origin });
  assert.deepEqual(parseCloudSummary({ state: "stopped", origin: null, pairingAvailable: false }), { status: "stopped" });
  assert.deepEqual(parseCloudSummary({ state: "failed", origin, pairingAvailable: false }), { status: "failed", origin });
  // Cloud Pro includes no AI: an allowance an older Admin still sends changes nothing.
  assert.deepEqual(parseCloudSummary({ state: "ready", origin, pairingAvailable: true, allowance: { includedUsd: 25, usedUsd: 25.4, resetsAt: NOW + 86_400_000 } }),
    { status: "ready", origin });
});

test("a malformed summary is no machine at all", () => {
  for (const input of [null, undefined, "ready", [], { state: "running", origin }, { state: "ready" }, { state: "ready", origin: null },
    { state: "ready", origin: "http://omb-u-1a2b3c4d5e6f.fly.dev" }, { state: "ready", origin: `${origin}/pair` },
    { state: "ready", origin: "https://user:pw@omb-u-1a2b3c4d5e6f.fly.dev" }, { state: "ready", origin: "https://localhost" },
    { state: "stopped", origin: "javascript:alert(1)" }, { state: "toString", origin }, { state: "__proto__", origin },
    // an included-AI state from before Cloud Pro dropped included AI
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
  assert.deepEqual(listed, { environments: [{ id: "cloud-1", name: CLOUD_HOME_NAME, origin }], activeId: environments.LOCAL_ID });
  const renamed = { ...listed, environments: [{ ...listed.environments[0], name: "Work cloud" }] };
  assert.equal(withCloudHome(renamed, { status: "stopped", origin }, () => "cloud-2"), renamed);
});

test("connecting uses the pairing page with the code in the hash, or the machine itself", () => {
  assert.equal(cloudHomeConnectUrl({ origin, grant: { origin, code, expiresAt: NOW + 1 } }, NOW), `${origin}/pair#code=${code}`);
  assert.equal(cloudHomeConnectUrl({ origin, grant: { origin, code, expiresAt: NOW } }, NOW), origin);
  assert.equal(cloudHomeConnectUrl({ origin, grant: { origin: "https://other.fly.dev", code, expiresAt: NOW + 1 } }, NOW), origin);
  assert.equal(cloudHomeConnectUrl({ origin, grant: null }, NOW), origin);
  // The link the existing Connect-to-a-server flow accepts.
  assert.deepEqual(environments.parseHostedWorkspaceLink(`${origin}/pair#code=${code}`), { origin, code, url: `${origin}/pair#code=${code}` });
});

const accessToken = `omc_${"T".repeat(43)}`;
async function admin(t) {
  const f = { now: NOW, cloud: undefined, pairing: null, pairingStatus: 200, requests: [], states: [], saved: null, timer: null,
    entitlement: { plan: "pro", status: "active", expiresAt: NOW + 30 * 86_400_000, version: 3 } };
  const identity = () => ({ cloudContractVersion: 1, expiresAt: f.now + 86_400_000, device: { id: "fixture-device" }, account: { id: "fixture-account", email: "person@example.test" } });
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain */ }
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
  let client, signedIn = false;
  const context = vm.createContext({
    environmentsState: { environments: [], activeId: environments.LOCAL_ID },
    persistEnvironments: next => { persisted.push(next); context.environmentsState = next; },
    navigateMainWindow: url => navigated.push(url), withCloudHome, cloudHomeConnectUrl, withActive: environments.withActive,
    randomUUID: () => "cloud-home-id", slog: () => {}, Date: { now: () => NOW }, AbortSignal,
    session: { defaultSession: { fetch: async (url, init) => { probes.push([url, init.credentials]); return { ok: signedIn, json: async () => ({ kind: signedIn ? "session" : undefined }) }; } } },
    dialog: { showMessageBox: async () => { dialogs.push(1); return { response: 1 }; } },
    ensureCloudAccount: () => client,
  });
  vm.runInContext(`${source.slice(start, end)}; this.rememberCloudHome = rememberCloudHome; this.connectCloudHome = connectCloudHome;`, context);
  context.rememberCloudHome({ status: "unavailable", machine: { status: "ready", origin } });
  context.rememberCloudHome({ status: "signed-out" });
  assert.deepEqual(persisted, []);
  context.rememberCloudHome({ status: "connected", machine: { status: "ready", origin } });
  context.rememberCloudHome({ status: "connected", machine: { status: "ready", origin } });
  assert.equal(persisted.length, 1);
  assert.equal(context.environmentsState.activeId, environments.LOCAL_ID);

  let minted = 0;
  client = { homeTarget: () => ({ origin }), pairHome: async () => { minted++; return { origin, code, expiresAt: NOW + 1 }; }, state: () => ({ status: "connected" }) };
  await context.connectCloudHome();
  assert.deepEqual(probes, [[`${origin}/api/auth/session`, "include"]]);
  assert.deepEqual(navigated, [`${origin}/pair#code=${code}`]);
  assert.equal(context.environmentsState.activeId, "cloud-home-id");
  assert.equal(minted, 1);
  // Already signed in there: switch without minting another code.
  signedIn = true;
  await context.connectCloudHome();
  assert.deepEqual(navigated.at(-1), origin);
  assert.equal(minted, 1);
  assert.deepEqual(dialogs, []);
  client = { homeTarget: () => null, pairHome: async () => { minted++; }, state: () => ({ status: "connected" }) };
  await assert.rejects(context.connectCloudHome(), /not ready/);
  assert.equal(minted, 1);
});
