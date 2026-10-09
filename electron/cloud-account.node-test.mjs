import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCloudAccountClient, createCloudAccountStore, cloudOrigin, CLOUD_ORIGIN } from "./cloud-account.mjs";

const accessToken = `omc_${"T".repeat(43)}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { for (let i = 0; i < 200; i++) { if (check()) return; await sleep(5); } assert.fail("Fixture did not reach the expected state"); }
async function fixture(t, options = {}) {
  const f = { now: 1_800_000_000_000, requests: [], browsers: [], states: [], saved: null, approved: false, revoked: false,
    sessionStatus: 200, invalidIdentity: false, invalidEntitlement: false, badUrl: false, failWrite: false, slowToken: null,
    entitlement: { plan: "free", status: "inactive", expiresAt: null, version: 0 }, timer: null, delay: null, cloud: undefined, expiresIn: 600,
    disk: { status: 404, body: "<!doctype html>not here" }, x: { status: 404, body: { error: "unsupported" } }, sessionPage: null, sessionError: null, tokenPage: null };
  const identity = () => ({ cloudContractVersion: 1, expiresAt: f.now + 86400_000, device: { id: "fixture-device" }, account: { id: "fixture-account", email: "person@example.test" } });
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    f.requests.push({ route: req.url, method: req.method, token: req.headers.authorization, body });
    const send = (status, data) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
    if (req.url === "/api/cloud/desktop/authorize") return send(201, { cloudContractVersion: 1, deviceCode: "A".repeat(43), userCode: "ABCDE-FGHJK",
      verificationUriComplete: f.badUrl ? "https://untrusted.example.test" : `${f.origin}/cloud/desktop?code=ABCDE-FGHJK`, expiresIn: f.expiresIn, interval: 5 });
    if (req.url === "/api/cloud/desktop/disk" && req.headers.authorization === `Bearer ${accessToken}`) {
      if (typeof f.disk.body === "string") { res.writeHead(f.disk.status, { "content-type": "text/html" }); return res.end(f.disk.body); }
      return send(f.disk.status, f.disk.body);
    }
    if (req.url === "/api/cloud/desktop/services/x" && req.headers.authorization === `Bearer ${accessToken}`) return send(f.x.status, f.x.body);
    if (req.url === "/api/cloud/desktop/token") {
      if (f.tokenPage) { res.writeHead(f.tokenPage, { "content-type": "text/html" }); return res.end("<!doctype html>Just a moment"); }
      if (f.slowToken) await f.slowToken;
      return f.approved ? send(200, { ...identity(), accessToken }) : send(400, { error: "authorization_pending" });
    }
    if (req.url === "/api/cloud/desktop/session" && req.headers.authorization === `Bearer ${accessToken}`) {
      if (req.method === "DELETE") { if (f.sessionPage) { res.writeHead(f.sessionPage, { "content-type": "text/html" }); return res.end("<!doctype html>Attention required"); } if (f.sessionStatus === 503) return send(503, { error: "unavailable" }); f.revoked = true; return send(200, { revoked: true }); }
      if (f.revoked) return send(401, { error: "invalid_token" });
      if (f.sessionPage) { res.writeHead(f.sessionPage, { "content-type": "text/html" }); return res.end("<!doctype html>Attention required"); }
      if (f.sessionError) return send(f.sessionError.status, f.sessionError.body);
      if (f.sessionStatus !== 200) return send(f.sessionStatus, { error: "unavailable" });
      return send(200, { ...identity(), ...(f.invalidIdentity ? { account: { id: "someone-else", email: "other@example.test" } } : {}),
        entitlement: f.invalidEntitlement ? { plan: "pro", status: "active" } : f.entitlement, ...(f.cloud === undefined ? {} : { cloud: f.cloud }) });
    }
    send(404, { error: "not_found" });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  f.origin = `http://127.0.0.1:${server.address().port}`;
  f.client = createCloudAccountClient({ origin: f.origin, fixture: true, deviceName: "Fixture computer", platform: "darwin", appVersion: "0.1.fixture", now: () => f.now,
    store: { read: async () => f.saved, write: async value => { if (f.failWrite) throw new Error("fixture storage failure"); f.saved = structuredClone(value); } },
    openBrowser: async url => { f.browsers.push(url); }, onState: state => f.states.push(state),
    setTimer: (callback, delay) => { f.timer = callback; f.delay = delay; return 1; }, clearTimer: () => { f.timer = null; f.delay = null; }, ...options });
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

test("a failed check keeps the last verified answer (never a malformed one), says so quietly, and changed identity ends access", async t => {
  const f = await fixture(t); await f.connect();
  const paid = { plan: "pro", tier: "max", status: "active", expiresAt: f.now + 3 * 3600_000, version: 1 };
  f.entitlement = paid; await f.client.refresh(); f.sessionStatus = 503;
  // One dropped check is not news: the plan, the Cloud and Connect stay.
  let state = await f.client.refresh();
  assert.equal(state.status, "connected"); assert.deepEqual(state.entitlement, paid); assert.equal(state.checking, undefined); assert.equal(f.saved.token, accessToken);
  // Repeated failures: still the last verified answer, now quietly "checking".
  state = await f.client.refresh();
  assert.equal(state.status, "connected"); assert.deepEqual(state.entitlement, paid); assert.equal(state.checking, true);
  // A malformed answer is a failed check too: never adopted.
  f.sessionStatus = 200; f.invalidEntitlement = true;
  state = await f.client.refresh(); assert.equal(state.status, "connected"); assert.deepEqual(state.entitlement, paid);
  // An answer clears "checking".
  f.invalidEntitlement = false; state = await f.client.refresh(); assert.equal(state.checking, undefined); assert.deepEqual(state.entitlement, paid);
  // A long outage: unavailable, with no entitlement, but the plan last verified is still named.
  f.sessionStatus = 503; await f.client.refresh(); f.now += 15 * 60_000;
  state = f.client.state(); assert.equal(state.status, "unavailable"); assert.equal(state.entitlement, undefined); assert.deepEqual(state.lastPlan, { tier: "max", active: true });
  f.sessionStatus = 200; f.invalidIdentity = true;
  state = await f.client.refresh(); assert.equal(state.status, "reauth-required"); assert.equal(state.message, "access-ended"); assert.equal(state.entitlement, undefined);
  assert.deepEqual(state.lastPlan, { tier: "max", active: true });
});

test("a check that fails is asked again after 15 s, 30 s, then each minute", async t => {
  const f = await fixture(t); await f.connect();
  f.sessionStatus = 503; await f.client.refresh(); assert.equal(f.delay, 15_000);
  for (const delay of [30_000, 60_000, 60_000]) { f.tick(); await until(() => f.timer); assert.equal(f.delay, delay); }
  f.sessionStatus = 200; f.tick(); await until(() => f.timer);
  f.sessionStatus = 503; f.tick(); await until(() => f.timer);
  assert.equal(f.delay, 15_000, "an answer starts the count again");
});

test("a successful re-check never shows anything but the verified plan, and runs well before the answer stops counting", async t => {
  const f = await fixture(t); await f.connect();
  f.entitlement = { plan: "pro", status: "active", expiresAt: f.now + 3 * 3600_000, version: 1 };
  await f.client.refresh();
  assert.ok(f.delay <= 60_000, "next check within a minute");
  assert.ok(f.client.state().verifiedUntil - f.now >= 10 * 60_000, "the answer counts for several checks");
  const before = f.states.length;
  for (let i = 0; i < 3; i++) { f.now += f.delay; f.tick(); await until(() => f.states.length > before + i); }
  assert.deepEqual(f.states.slice(before).map(state => `${state.status}:${state.entitlement?.plan}`), ["connected:pro", "connected:pro", "connected:pro"]);
});

test("while the Cloud is set up, or a payment is being linked, progress is asked for every 15 seconds", async t => {
  const f = await fixture(t); await f.connect();
  f.entitlement = { plan: "pro", status: "active", expiresAt: f.now + 3 * 3600_000, version: 1 };
  f.cloud = { state: "setting_up", setup: { step: "storage", slow: true } };
  let state = await f.client.refresh();
  assert.deepEqual(state.machine, { status: "provisioning", setup: { step: "storage", slow: true } }); assert.equal(f.delay, 15_000);
  f.cloud = null; await f.client.refresh(); assert.equal(f.delay, 15_000, "paid with no Cloud listed yet: setting up");
  f.cloud = { state: "ready", origin: "https://home-7f3k2.fly.dev", disk: { gb: 20, maxGb: 100 } };
  state = await f.client.refresh(); assert.deepEqual(state.machine.disk, { gb: 20, maxGb: 100 }); assert.equal(f.delay, 60_000);
  f.entitlement = { plan: "free", status: "inactive", expiresAt: null, version: 2 };
  f.cloud = { purchase: { state: "confirming", plan: "personal", paidAt: f.now - 60_000 } };
  state = await f.client.refresh();
  assert.deepEqual(state.purchase, { state: "confirming", tier: "personal", paidAt: f.now - 60_000 }); assert.equal(state.entitlement.plan, "free"); assert.equal(f.delay, 15_000);
});

test("active Pro requires a future expiry and free+active is never accepted", async t => {
  const f = await fixture(t); await f.connect();
  const free = f.client.state().entitlement;
  for (const invalid of [
    { plan: "pro", status: "active", expiresAt: null, version: 1 },
    { plan: "pro", status: "active", expiresAt: f.now, version: 1 },
    { plan: "free", status: "active", expiresAt: f.now + 3600_000, version: 1 },
  ]) {
    f.entitlement = invalid; const state = await f.client.refresh();
    assert.equal(state.status, "connected"); assert.deepEqual(state.entitlement, free);
  }
  // With no verified answer to keep, it is unavailable.
  f.now += 15 * 60_000; assert.equal(f.client.state().status, "unavailable"); assert.equal(f.client.state().entitlement, undefined);
});

test("a tier names the paid plan; a missing, unknown or malformed tier never rejects or downgrades it", async t => {
  const warnings = [], f = await fixture(t, { warn: message => warnings.push(message) }); await f.connect();
  const paid = { plan: "pro", status: "active", expiresAt: f.now + 3600_000, version: 1 };
  f.entitlement = paid; assert.deepEqual((await f.client.refresh()).entitlement, paid);
  for (const tier of ["personal", "pro", "max", "team-2026"]) {
    f.entitlement = { ...paid, tier }; assert.deepEqual((await f.client.refresh()).entitlement, { ...paid, tier });
  }
  for (const tier of ["Max", "", "max\n", "2x", "-max", "m".repeat(25), 5, null, {}, ["max"]]) {
    f.entitlement = { ...paid, tier }; const state = await f.client.refresh();
    assert.equal(state.status, "connected"); assert.deepEqual(state.entitlement, paid);
  }
  f.entitlement = { plan: "free", status: "inactive", expiresAt: null, version: 2, tier: "Bad tier" };
  assert.deepEqual((await f.client.refresh()).entitlement, { plan: "free", status: "inactive", expiresAt: null, version: 2 });
  assert.deepEqual(warnings, []);
});

test("a plan newer than the app (personal, max) is paid with that tier, told once, never a lockout", async t => {
  const warnings = [], f = await fixture(t, { warn: message => warnings.push(message) }); await f.connect();
  const paid = { status: "active", expiresAt: f.now + 3600_000, version: 1 };
  f.entitlement = { plan: "max", ...paid };
  assert.deepEqual((await f.client.refresh()).entitlement, { plan: "pro", tier: "max", ...paid });
  await f.client.refresh(); assert.equal(warnings.length, 1); assert.match(warnings[0], /"max"/);
  f.entitlement = { plan: "personal", ...paid, tier: "personal" };
  assert.deepEqual((await f.client.refresh()).entitlement, { plan: "pro", tier: "personal", ...paid }); assert.equal(warnings.length, 2);
  f.entitlement = { plan: "max", ...paid, tier: "Bad" };
  assert.deepEqual((await f.client.refresh()).entitlement, { plan: "pro", tier: "max", ...paid });
  f.entitlement = { plan: "max", status: "inactive", expiresAt: f.now - 1, version: 2 };
  assert.deepEqual((await f.client.refresh()).entitlement, { plan: "pro", tier: "max", status: "inactive", expiresAt: f.now - 1, version: 2 });
  assert.equal(warnings.length, 2);
  // A newer plan gets no exemption from the rest of the checks: each is a failed check, never adopted.
  const kept = f.client.state().entitlement;
  for (const invalid of [{ plan: "max", status: "active", expiresAt: null, version: 1 }, { plan: "max", status: "active", expiresAt: f.now, version: 1 },
    ...["Max", "", "pro ", "m".repeat(25), 5, null].map(plan => ({ plan, ...paid }))]) {
    f.entitlement = invalid; assert.deepEqual((await f.client.refresh()).entitlement, kept);
  }
});

test("a verified answer stops counting at the plan's own expiry or after 15 minutes without a check; cached Pro is never restored", async t => {
  const f = await fixture(t); await f.connect(); f.entitlement = { plan: "pro", status: "active", expiresAt: f.now + 2000, version: 1 };
  await f.client.refresh(); f.now += 2001;
  assert.equal(f.client.state().status, "unavailable"); assert.equal(f.client.state().entitlement, undefined);
  assert.deepEqual(f.client.state().lastPlan, { active: true }, "the plan is still named while it is checked");
  await f.client.refresh(); assert.equal(f.client.state().status, "unavailable");
  f.entitlement = { plan: "pro", status: "inactive", expiresAt: f.now - 1, version: 2 };
  await f.client.refresh(); assert.equal(f.client.state().entitlement.status, "inactive");
  f.now += 15 * 60_000 - 1; assert.equal(f.client.state().entitlement.status, "inactive");
  f.now += 1; assert.equal(f.client.state().entitlement, undefined);
  f.saved.entitlement = { plan: "pro", status: "active", expiresAt: null, version: 999 }; f.sessionStatus = 503;
  await f.client.start(); assert.equal(f.client.state().entitlement, undefined); assert.equal(f.client.state().status, "unavailable");
});

test("the plan hint is saved for display only, follows the verified plan, and is gone with the sign-in", async t => {
  const f = await fixture(t); await f.connect();
  assert.equal(f.saved.planHint, undefined, "a free account saves no plan");
  f.entitlement = { plan: "pro", tier: "personal", status: "active", expiresAt: f.now + 3600_000, version: 1 };
  await f.client.refresh(); assert.deepEqual(f.saved.planHint, { tier: "personal", active: true }); assert.equal(f.saved.entitlement, undefined);
  // Restored offline: named, but nothing is active and nothing is verified.
  f.sessionStatus = 503; f.client.close();
  const restored = await fixture(t); restored.saved = { ...f.saved, origin: restored.origin }; restored.sessionStatus = 503;
  const state = await restored.client.start();
  assert.equal(state.status, "unavailable"); assert.equal(state.entitlement, undefined); assert.deepEqual(state.lastPlan, { tier: "personal", active: true });
  // A malformed hint is no hint.
  const odd = await fixture(t); odd.saved = { ...f.saved, origin: odd.origin, planHint: { tier: "<b>", active: "yes" } }; odd.sessionStatus = 503;
  assert.equal((await odd.client.start()).lastPlan, undefined);
  restored.sessionStatus = 200; restored.entitlement = { plan: "free", status: "inactive", expiresAt: null, version: 2 };
  await restored.client.refresh(); assert.equal(restored.saved.planHint, undefined);
  await restored.client.signOut(); assert.equal(restored.saved, null); assert.equal(restored.client.state().lastPlan, undefined);
});

test("before a saved sign-in is read, nobody is signed out; with none, signed out plainly", async t => {
  const f = await fixture(t);
  assert.deepEqual(f.client.state(), { status: "signed-out", message: "restoring" });
  assert.deepEqual(await f.client.start(), { status: "signed-out" });
});

test("a sign-in that reached its end asks to sign in again, keeps the plan, and starts the new one without showing signed out", async t => {
  const f = await fixture(t); await f.connect();
  f.entitlement = { plan: "pro", tier: "max", status: "active", expiresAt: f.now + 40 * 86400_000, version: 1 };
  await f.client.refresh();
  await assert.rejects(f.client.signInAgain(), /still signed in/);
  f.now += 86400_000 + 1;
  // Even before a check runs, the state says so.
  assert.equal(f.client.state().status, "reauth-required"); assert.equal(f.client.state().message, "expired");
  const ended = await f.client.refresh();
  assert.equal(ended.status, "reauth-required"); assert.equal(ended.message, "expired"); assert.deepEqual(ended.lastPlan, { tier: "max", active: true });
  assert.equal(ended.entitlement, undefined);
  const before = f.states.length, browsers = f.browsers.length;
  const next = await f.client.signInAgain();
  assert.equal(next.status, "connecting"); assert.equal(next.enrollment.userCode, "ABCDE-FGHJK");
  assert.ok(f.states.slice(before).every(state => state.status === "connecting"), "never signed out in between");
  assert.equal(f.browsers.length, browsers + 1); assert.equal(f.saved, null);
  f.revoked = false; f.tick(); await until(() => f.client.state().status === "connected");
  assert.equal(f.saved.token, accessToken);
});

test("the sign-in code may last up to 30 minutes, no longer", async t => {
  const f = await fixture(t); f.expiresIn = 900;
  const state = await f.client.begin(); assert.equal(state.enrollment.expiresAt, f.now + 900_000);
  await f.client.cancel();
  const g = await fixture(t); g.expiresIn = 1801;
  assert.equal((await g.client.begin()).message, "signin-failed");
});

test("only the Admin's own answer ends a sign-in: a 401/403 page from in between is a failed check", async t => {
  const f = await fixture(t); await f.connect();
  const paid = { plan: "pro", tier: "max", status: "active", expiresAt: f.now + 3 * 3600_000, version: 1 };
  f.entitlement = paid; await f.client.refresh();
  // A firewall or bot-check page (Cloudflare serves cloud.openmausbot.com).
  f.sessionPage = 403;
  let state = await f.client.refresh();
  assert.equal(state.status, "connected"); assert.deepEqual(state.entitlement, paid); assert.equal(state.checking, undefined);
  f.sessionPage = 401; state = await f.client.refresh();
  assert.equal(state.status, "connected"); assert.equal(state.checking, true); assert.equal(f.saved.token, accessToken);
  // A JSON 403 that is not about the sign-in (a wrong origin) does not end it either.
  f.sessionPage = null; f.sessionError = { status: 403, body: { error: "invalid_origin" } };
  state = await f.client.refresh(); assert.equal(state.status, "connected"); assert.deepEqual(state.entitlement, paid);
  // The Admin's own "invalid_token": sign in again, the plan still named.
  f.sessionError = { status: 401, body: { error: "invalid_token" } };
  state = await f.client.refresh(); assert.equal(state.status, "reauth-required"); assert.equal(state.message, "access-ended");
  assert.deepEqual(state.lastPlan, { tier: "max", active: true });
  assert.ok(!f.requests.some(row => row.method === "DELETE"));
});

test("a page from in between during sign-in keeps waiting for the approval", async t => {
  const f = await fixture(t);
  await f.client.begin();
  f.tokenPage = 403; f.tick();
  await until(() => f.requests.some(row => row.route.endsWith("/token")) && f.timer);
  assert.equal(f.client.state().status, "connecting"); assert.equal(f.client.state().enrollment.userCode, "ABCDE-FGHJK");
  f.tokenPage = null; f.approved = true; f.tick();
  await until(() => f.client.state().status === "connected");
});

test("growing the Cloud's disk: an Admin without it says so, a size over the plan is refused, and a grown disk is reported", async t => {
  const f = await fixture(t);
  await assert.rejects(f.client.growDisk(20), /not ready/);
  await f.connect();
  assert.deepEqual(await f.client.growDisk(20), { supported: false });
  f.disk = { status: 405, body: { error: "method" } }; assert.deepEqual(await f.client.growDisk(20), { supported: false });
  f.disk = { status: 422, body: { error: "over the plan's disk" } }; assert.deepEqual(await f.client.growDisk(200), { supported: true, refused: true });
  f.disk = { status: 200, body: { disk: { gb: 20, maxGb: 100 } } }; assert.deepEqual(await f.client.growDisk(20), { supported: true, disk: { gb: 20, maxGb: 100 } });
  f.disk = { status: 200, body: { disk: { gb: 0, maxGb: 100 } } }; await assert.rejects(f.client.growDisk(20), /Invalid/);
  f.disk = { status: 500, body: { error: "down" } }; await assert.rejects(f.client.growDisk(20));
  await assert.rejects(f.client.growDisk(0), /Invalid/);
  const body = JSON.parse(f.requests.filter(row => row.route.endsWith("/disk")).at(-1).body);
  assert.deepEqual(body, { sizeGb: 20 });
});

test("sign-out durably forgets personal Cloud and revokes only its credential; offline revocation is disclosed", async t => {
  const f = await fixture(t); await f.connect();
  const signedOut = await f.client.signOut();
  assert.equal(signedOut.status, "signed-out"); assert.equal(f.saved, null); assert.equal(f.revoked, true);
  assert.equal(f.requests.filter(row => row.method === "DELETE").length, 1);
  assert.ok(f.requests.every(row => row.route.startsWith("/api/cloud/desktop/")));
  f.revoked = false; await f.connect(); f.sessionStatus = 503;
  assert.equal((await f.client.signOut()).message, "signout-local-only"); assert.equal(f.saved, null);
  // A 403 page from in between (a firewall) revoked nothing: it is disclosed, never taken as done.
  f.sessionStatus = 200; await f.connect(); f.sessionPage = 403;
  assert.equal((await f.client.signOut()).message, "signout-local-only"); assert.equal(f.revoked, false);
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

test("a saved Cloud sign-in is read back after a restart with Electron 43's decrypt shape ({ shouldReEncrypt, result })", async t => {
  const directory = await mkdtemp(join(tmpdir(), "omb-cloud-electron43-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "cloud-account.bin");
  // Exactly what safeStorage.decryptStringAsync resolves to in Electron 43, not a bare string.
  const electron43 = { available: async () => true, encrypt: async value => Buffer.from(value).map(byte => byte ^ 0x55),
    decrypt: async value => ({ shouldReEncrypt: false, result: Buffer.from(value).map(byte => byte ^ 0x55).toString() }) };
  await createCloudAccountStore({ file, encryption: electron43 }).write({ token: accessToken });
  // A new store over the same file stands in for the next app launch.
  assert.deepEqual(await createCloudAccountStore({ file, encryption: electron43 }).read(), { token: accessToken });
});

/** Electron 43's safeStorage shape over a one-byte key. `lock.locked` stands in for a locked keychain. */
const electron43Store = (file, lock = { locked: false }, decrypt) => createCloudAccountStore({ file, encryption: { available: async () => !lock.locked,
  encrypt: async value => Buffer.from(value).map(byte => byte ^ 0x55),
  decrypt: decrypt ?? (async value => ({ shouldReEncrypt: false, result: Buffer.from(value).map(byte => byte ^ 0x55).toString() })) } });
const savedSignIn = f => ({ origin: f.origin, token: accessToken, expiresAt: f.now + 86400_000, device: { id: "fixture-device" }, account: { id: "fixture-account", email: "person@example.test" } });

test("a saved Cloud sign-in that can never be read is removed, and signing in again is the one next step", async t => {
  const directory = await mkdtemp(join(tmpdir(), "omb-cloud-unreadable-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "cloud-account.bin");
  for (const decrypt of [
    // This computer's key no longer opens it (Windows after a reinstall onto a new profile).
    async () => { throw new Error("Error while decrypting the ciphertext provided to safeStorage.decryptString."); },
    // It opens to something that is not JSON, or to JSON that is not a sign-in.
    async () => ({ shouldReEncrypt: false, result: "not json" }),
    async () => ({ shouldReEncrypt: false, result: JSON.stringify({ token: "not-a-cloud-token" }) }),
  ]) {
    const f = await fixture(t, { store: electron43Store(file, undefined, decrypt) });
    await electron43Store(file).write(savedSignIn(f));
    assert.deepEqual(await f.client.start(), { status: "signed-out", message: "restore-removed" });
    await assert.rejects(stat(file), { code: "ENOENT" });
    assert.equal(f.timer, null, "nothing is read again");
    assert.equal((await f.client.begin()).status, "connecting");
  }
});

test("a locked keychain never removes the saved Cloud sign-in: it is read again, sooner then each minute, until it opens", async t => {
  const directory = await mkdtemp(join(tmpdir(), "omb-cloud-locked-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "cloud-account.bin"), lock = { locked: false };
  const f = await fixture(t, { store: electron43Store(file, lock) });
  await electron43Store(file).write(savedSignIn(f));
  lock.locked = true;
  assert.deepEqual(await f.client.start(), { status: "unavailable", message: "restore-failed" });
  assert.equal(f.delay, 15_000);
  await assert.rejects(f.client.begin(), /Sign out/);
  for (const delay of [30_000, 60_000, 60_000]) { f.tick(); await until(() => f.timer); assert.equal(f.delay, delay); }
  assert.ok((await stat(file)).isFile(), "a locked sign-in is never removed");
  assert.equal(f.states.filter(state => state.message === "restore-failed").length, 1, "said once, not on every try");
  lock.locked = false; f.tick();
  await until(() => f.client.state().status === "connected");
  assert.equal(f.client.state().account.email, "person@example.test");
});

test("a decrypt answer in a shape this app does not know is never taken for an unreadable sign-in", async t => {
  const directory = await mkdtemp(join(tmpdir(), "omb-cloud-shape-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "cloud-account.bin");
  const f = await fixture(t, { store: electron43Store(file, undefined, async () => ({ shouldReEncrypt: false })) });
  await electron43Store(file).write(savedSignIn(f));
  assert.deepEqual(await f.client.start(), { status: "unavailable", message: "restore-failed" });
  assert.ok((await stat(file)).isFile());
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

test("X research access: this sign-in's own relay token, null without a plan or the service, never a URL off the Cloud's origin", async t => {
  const f = await fixture(t);
  const before = f.requests.length;
  assert.equal(await f.client.xResearchAccess(), null);
  assert.equal(f.requests.length, before);
  await f.connect();
  const token = `omb_xd_${"a".repeat(43)}`, url = `${f.origin}/api/cloud/services/x`;
  f.x = { status: 200, body: { cloudContractVersion: 1, url, token } };
  assert.deepEqual(await f.client.xResearchAccess(), { url, token });
  assert.ok(f.requests.some(r => r.route === "/api/cloud/desktop/services/x" && r.method === "POST" && r.token === `Bearer ${accessToken}`));
  f.x = { status: 402, body: { error: "subscription_inactive" } }; assert.equal(await f.client.xResearchAccess(), null);
  f.x = { status: 404, body: { error: "unsupported" } }; assert.equal(await f.client.xResearchAccess(), null);
  f.x = { status: 200, body: { cloudContractVersion: 1, url: "https://elsewhere.example.test/api/cloud/services/x", token } }; await assert.rejects(f.client.xResearchAccess(), /Invalid/);
  f.x = { status: 200, body: { cloudContractVersion: 1, url, token: "short" } }; await assert.rejects(f.client.xResearchAccess(), /Invalid/);
  f.x = { status: 500, body: { error: "down" } }; await assert.rejects(f.client.xResearchAccess());
});
