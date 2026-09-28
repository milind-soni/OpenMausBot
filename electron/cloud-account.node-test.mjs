import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCloudAccountClient, createCloudAccountStore, cloudOrigin, CLOUD_ORIGIN } from "./cloud-account.mjs";

const accessToken = `omc_${"T".repeat(43)}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { for (let i = 0; i < 200; i++) { if (check()) return; await sleep(5); } assert.fail("Fixture did not reach the expected state"); }
async function fixture(t, options = {}) {
  const f = { now: 1_800_000_000_000, requests: [], browsers: [], states: [], saved: null, approved: false, revoked: false,
    sessionStatus: 200, invalidIdentity: false, invalidEntitlement: false, badUrl: false, failWrite: false, slowToken: null,
    entitlement: { plan: "free", status: "inactive", expiresAt: null, version: 0 }, timer: null };
  const identity = () => ({ cloudContractVersion: 1, expiresAt: f.now + 86400_000, device: { id: "fixture-device" }, account: { id: "fixture-account", email: "person@example.test" } });
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    f.requests.push({ route: req.url, method: req.method, token: req.headers.authorization, body });
    const send = (status, data) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
    if (req.url === "/api/cloud/desktop/authorize") return send(201, { cloudContractVersion: 1, deviceCode: "A".repeat(43), userCode: "ABCDE-FGHJK",
      verificationUriComplete: f.badUrl ? "https://untrusted.example.test" : `${f.origin}/cloud/desktop?code=ABCDE-FGHJK`, expiresIn: 600, interval: 5 });
    if (req.url === "/api/cloud/desktop/token") {
      if (f.slowToken) await f.slowToken;
      return f.approved ? send(200, { ...identity(), accessToken }) : send(400, { error: "authorization_pending" });
    }
    if (req.url === "/api/cloud/desktop/session" && req.headers.authorization === `Bearer ${accessToken}`) {
      if (req.method === "DELETE") { if (f.sessionStatus === 503) return send(503, { error: "unavailable" }); f.revoked = true; return send(200, { revoked: true }); }
      if (f.revoked) return send(401, { error: "invalid_token" });
      if (f.sessionStatus !== 200) return send(f.sessionStatus, { error: "unavailable" });
      return send(200, { ...identity(), ...(f.invalidIdentity ? { account: { id: "someone-else", email: "other@example.test" } } : {}),
        entitlement: f.invalidEntitlement ? { plan: "pro", status: "active" } : f.entitlement });
    }
    send(404, { error: "not_found" });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  f.origin = `http://127.0.0.1:${server.address().port}`;
  f.client = createCloudAccountClient({ origin: f.origin, fixture: true, deviceName: "Fixture computer", platform: "darwin", appVersion: "0.1.fixture", now: () => f.now,
    store: { read: async () => f.saved, write: async value => { if (f.failWrite) throw new Error("fixture storage failure"); f.saved = structuredClone(value); } },
    openBrowser: async url => { f.browsers.push(url); }, onState: state => f.states.push(state),
    setTimer: callback => { f.timer = callback; return 1; }, clearTimer: () => { f.timer = null; }, ...options });
  f.tick = () => { const callback = f.timer; assert.ok(callback); f.timer = null; callback(); };
  f.connect = async () => { await f.client.begin(); f.approved = true; f.tick(); await until(() => f.client.state().status === "connected"); };
  t.after(async () => { f.client.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return f;
}

test("Cloud origin is fixed; only explicit fixtures can use loopback", () => {
  assert.equal(cloudOrigin(), CLOUD_ORIGIN);
  for (const value of ["https://attacker.example.test", "http://127.0.0.1:1234", `${CLOUD_ORIGIN}/`, `${CLOUD_ORIGIN}/?paid=true`]) assert.throws(() => cloudOrigin(value));
  assert.equal(cloudOrigin("http://127.0.0.1:1234", true), "http://127.0.0.1:1234");
  assert.throws(() => cloudOrigin("https://attacker.example.test", true));
});

test("fresh startup stays local with no enrollment, browser, or network; explicit sign-in uses private polling", async t => {
  const f = await fixture(t);
  assert.equal((await f.client.start()).status, "signed-out"); assert.deepEqual(f.requests, []); assert.deepEqual(f.browsers, []);
  await f.client.begin("https://attacker.example.test");
  assert.equal(f.browsers[0], `${f.origin}/cloud/desktop?code=ABCDE-FGHJK`);
  assert.equal(f.client.state().enrollment.userCode, "ABCDE-FGHJK");
  f.approved = true; f.tick(); await until(() => f.client.state().status === "connected");
  assert.equal(f.saved.token, accessToken); assert.equal(f.saved.entitlement, undefined);
  assert.equal(f.client.state().entitlement.plan, "free");
  assert.ok(!JSON.stringify(f.states).includes(accessToken)); assert.ok(!JSON.stringify(f.states).includes("A".repeat(43)));
  assert.equal(f.requests.find(row => row.route.endsWith("/session")).token, `Bearer ${accessToken}`);
});

test("checkout/browser return cannot activate Pro; only refreshed server state can, and revocation removes it", async t => {
  const f = await fixture(t); await f.connect();
  await f.client.openDashboard("https://attacker.example.test?paid=true");
  assert.equal(f.browsers.at(-1), `${f.origin}/cloud`); assert.equal(f.client.state().entitlement.plan, "free");
  f.entitlement = { plan: "pro", status: "active", expiresAt: f.now + 3600_000, version: 1 };
  assert.equal(f.client.state().entitlement.plan, "free");
  assert.equal((await f.client.refresh()).entitlement.plan, "pro");
  f.revoked = true;
  assert.equal((await f.client.refresh()).status, "reauth-required"); assert.equal(f.client.state().entitlement, undefined);
});

test("network errors, malformed entitlements and changed identity fail closed without clearing local account data", async t => {
  const f = await fixture(t); await f.connect(); f.entitlement = { plan: "pro", status: "active", expiresAt: f.now + 3600_000, version: 1 };
  await f.client.refresh(); f.sessionStatus = 503;
  assert.equal((await f.client.refresh()).status, "unavailable"); assert.equal(f.client.state().entitlement, undefined); assert.equal(f.saved.token, accessToken);
  f.sessionStatus = 200; f.invalidEntitlement = true;
  assert.equal((await f.client.refresh()).status, "unavailable"); assert.equal(f.client.state().entitlement, undefined);
  f.invalidEntitlement = false; f.invalidIdentity = true;
  assert.equal((await f.client.refresh()).status, "reauth-required"); assert.equal(f.client.state().entitlement, undefined);
});

test("active Pro requires a future expiry and free+active is never accepted", async t => {
  const f = await fixture(t); await f.connect();
  for (const invalid of [
    { plan: "pro", status: "active", expiresAt: null, version: 1 },
    { plan: "pro", status: "active", expiresAt: f.now, version: 1 },
    { plan: "free", status: "active", expiresAt: f.now + 3600_000, version: 1 },
  ]) {
    f.entitlement = invalid; assert.equal((await f.client.refresh()).status, "unavailable"); assert.equal(f.client.state().entitlement, undefined);
  }
});

test("verified status expires after one minute even if a timer has not run; cached Pro is never restored", async t => {
  const f = await fixture(t); await f.connect(); f.entitlement = { plan: "pro", status: "active", expiresAt: f.now + 2000, version: 1 };
  await f.client.refresh(); f.now += 2001;
  assert.equal(f.client.state().status, "unavailable"); assert.equal(f.client.state().entitlement, undefined);
  await f.client.refresh(); assert.equal(f.client.state().status, "unavailable");
  f.entitlement = { plan: "pro", status: "inactive", expiresAt: f.now - 1, version: 2 };
  await f.client.refresh(); assert.equal(f.client.state().entitlement.status, "inactive");
  f.now += 60_001; assert.equal(f.client.state().entitlement, undefined);
  f.saved.entitlement = { plan: "pro", status: "active", expiresAt: null, version: 999 }; f.sessionStatus = 503;
  await f.client.start(); assert.equal(f.client.state().entitlement, undefined);
});

test("sign-out durably forgets personal Cloud and revokes only its credential; offline revocation is disclosed", async t => {
  const f = await fixture(t); await f.connect();
  const signedOut = await f.client.signOut();
  assert.equal(signedOut.status, "signed-out"); assert.equal(f.saved, null); assert.equal(f.revoked, true);
  assert.equal(f.requests.filter(row => row.method === "DELETE").length, 1);
  assert.ok(f.requests.every(row => row.route.startsWith("/api/cloud/desktop/")));
  f.revoked = false; await f.connect(); f.sessionStatus = 503;
  assert.equal((await f.client.signOut()).message, "signout-local-only"); assert.equal(f.saved, null);
});

test("failed durable sign-out blocks reconnect until cleanup succeeds", async t => {
  const f = await fixture(t); await f.connect(); f.failWrite = true;
  assert.equal((await f.client.signOut()).message, "signout-storage-failed");
  await assert.rejects(f.client.begin(), /Sign out/); assert.equal(f.client.state().entitlement, undefined);
  f.failWrite = false; await f.client.signOut(); assert.equal(f.saved, null);
});

test("startup restoration cannot race a new sign-in, and failed token persistence revokes the issued credential", async t => {
  let resolveRead;
  const f = await fixture(t, { store: { read: () => new Promise(resolve => { resolveRead = resolve; }), write: async () => {} } });
  const restoring = f.client.start(); await assert.rejects(f.client.begin(), /Sign out/);
  resolveRead(null); await restoring; assert.deepEqual(f.requests, []);
  const broken = await fixture(t); broken.failWrite = true; await broken.client.begin(); broken.approved = true; broken.tick();
  await until(() => broken.revoked); await until(() => broken.client.state().message === "signout-storage-failed");
  assert.equal(broken.client.state().entitlement, undefined); assert.equal(broken.saved, null);
});

test("invalid browser URLs are refused and cancellation cannot persist a late issued token", async t => {
  const f = await fixture(t, { fetch: (url, options) => fetch(url, { ...options, signal: undefined }) });
  f.badUrl = true; assert.equal((await f.client.begin()).status, "signed-out"); assert.deepEqual(f.browsers, []);
  f.badUrl = false; await f.client.begin(); f.approved = true;
  let release; f.slowToken = new Promise(resolve => { release = resolve; }); f.tick();
  await until(() => f.requests.some(row => row.route.endsWith("/token")));
  await f.client.cancel(); release(); await until(() => f.revoked);
  assert.equal(f.saved, null); assert.equal(f.client.state().status, "signed-out");
  await f.client.reopen(); assert.equal(f.browsers.length, 1);
});

test("Cloud records use separate encrypted atomic storage, not plaintext or saved entitlements", async t => {
  const directory = await mkdtemp(join(tmpdir(), "omb-cloud-record-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "cloud-account.bin"); let unlocked = true;
  // The fixture substitutes encryption; it does not use the user's keychain.
  const store = createCloudAccountStore({ file, encryption: { available: async () => unlocked,
    encrypt: value => Buffer.from(value).map(byte => byte ^ 0x55), decrypt: value => Buffer.from(value).map(byte => byte ^ 0x55).toString() } });
  await store.write({ token: accessToken }); assert.deepEqual(await store.read(), { token: accessToken });
  assert.ok(!(await readFile(file)).toString().includes(accessToken));
  unlocked = false; await assert.rejects(store.read()); await store.write(null); assert.equal(await store.read(), null);
});

test("cancelling during the encrypted write queues deletion after it and cannot restore the grant", async t => {
  const directory = await mkdtemp(join(tmpdir(), "omb-cloud-cancel-")); t.after(() => rm(directory, { recursive: true, force: true }));
  let release, writing = false; const gate = new Promise(resolve => { release = resolve; });
  const store = createCloudAccountStore({ file: join(directory, "cloud-account.bin"), encryption: { available: async () => true,
    encrypt: async value => { writing = true; await gate; return Buffer.from(value); }, decrypt: value => value.toString() } });
  const f = await fixture(t, { store }); await f.client.begin(); f.approved = true; f.tick(); await until(() => writing);
  const cancellation = f.client.cancel(); release(); await cancellation; await until(() => f.revoked);
  assert.equal(await store.read(), null); assert.equal(f.client.state().status, "signed-out"); assert.equal(f.client.state().entitlement, undefined);
});
