import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHECKOUT_SOURCES, checkoutDestination, cloudMenuSublabel, createCloudAccountClient, createCloudAccountStore, cloudOrigin, cloudPlanSnapshot, CLOUD_ORIGIN } from "./cloud-account.mjs";

const accessToken = `omc_${"T".repeat(43)}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { for (let i = 0; i < 200; i++) { if (check()) return; await sleep(5); } assert.fail("Fixture did not reach the expected state"); }
async function fixture(t, options = {}) {
  const f = { now: 1_800_000_000_000, requests: [], browsers: [], states: [], saved: null, approved: false, revoked: false,
    sessionStatus: 200, invalidIdentity: false, invalidEntitlement: false, badUrl: false, failWrite: false, slowToken: null,
    entitlement: { plan: "free", status: "inactive", expiresAt: null, version: 0 }, timer: null, delay: null, cloud: undefined, expiresIn: 600,
    disk: { status: 404, body: "<!doctype html>not here" }, x: { status: 404, body: { error: "unsupported" } }, pages: { status: 404, body: { error: "unsupported" } }, sessionPage: null, sessionError: null, tokenPage: null, publicConfig: { status: 404, body: { error: "not_found" } },
    offer: undefined, checkout: { status: 404, body: "<!doctype html>not here" }, interest: { status: 200, body: { ok: true } }, teams: undefined, teamPairing: { status: 404, body: { error: "not_found" } }, moved: { status: 404, body: { error: "not_found" } } };
  const identity = () => ({ cloudContractVersion: 1, expiresAt: f.now + 86400_000, device: { id: "fixture-device" }, account: { id: "fixture-account", email: "person@example.test" } });
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    f.requests.push({ route: req.url, method: req.method, token: req.headers.authorization, version: req.headers["x-openmausbot-version"], body });
    const send = (status, data) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
    if (req.url === "/api/cloud/desktop/authorize") return send(201, { cloudContractVersion: 1, deviceCode: "A".repeat(43), userCode: "ABCDE-FGHJK",
      verificationUriComplete: f.badUrl ? "https://untrusted.example.test" : `${f.origin}/cloud/desktop?code=ABCDE-FGHJK`, expiresIn: f.expiresIn, interval: 5 });
    if (req.url === "/api/public/config" && req.method === "GET") {
      f.requests.at(-1).cookie = req.headers.cookie;
      if (typeof f.publicConfig.body === "string") { res.writeHead(f.publicConfig.status, { "content-type": "text/html" }); return res.end(f.publicConfig.body); }
      return send(f.publicConfig.status, f.publicConfig.body);
    }
    if (req.url === "/api/cloud/desktop/disk" && req.headers.authorization === `Bearer ${accessToken}`) {
      if (typeof f.disk.body === "string") { res.writeHead(f.disk.status, { "content-type": "text/html" }); return res.end(f.disk.body); }
      return send(f.disk.status, f.disk.body);
    }
    if (req.url === "/api/cloud/desktop/services/x" && req.headers.authorization === `Bearer ${accessToken}`) return send(f.x.status, f.x.body);
    if (/^\/api\/cloud\/desktop\/teams\/[^/]+\/pairing$/.test(req.url) && req.method === "POST" && req.headers.authorization === `Bearer ${accessToken}`) return send(f.teamPairing.status, f.teamPairing.body);
    if (req.url === "/api/cloud/desktop/services/pages" && req.headers.authorization === `Bearer ${accessToken}`) return send(f.pages.status, f.pages.body);
    if (req.url === "/api/cloud/desktop/moved" && req.method === "POST" && req.headers.authorization === `Bearer ${accessToken}`) return send(f.moved.status, f.moved.body);
    for (const [route, answer] of [["/api/cloud/desktop/checkout", f.checkout], ["/api/cloud/desktop/interest", f.interest]]) {
      if (req.url !== route || req.method !== "POST" || req.headers.authorization !== `Bearer ${accessToken}`) continue;
      if (typeof answer.body === "string") { res.writeHead(answer.status, { "content-type": "text/html" }); return res.end(answer.body); }
      return send(answer.status, answer.body);
    }
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
        entitlement: f.invalidEntitlement ? { plan: "pro", status: "active" } : f.entitlement, ...(f.cloud === undefined ? {} : { cloud: f.cloud }),
        ...(f.offer === undefined ? {} : { offer: f.offer }), ...(f.teams === undefined ? {} : { teams: f.teams }) });
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
  let state = await f.client.refresh();
  assert.equal(state.status, "connected"); assert.deepEqual(state.entitlement, paid); assert.equal(state.checking, undefined); assert.equal(f.saved.token, accessToken);
  state = await f.client.refresh();
  assert.equal(state.status, "connected"); assert.deepEqual(state.entitlement, paid); assert.equal(state.checking, true);
  f.sessionStatus = 200; f.invalidEntitlement = true;
  state = await f.client.refresh(); assert.equal(state.status, "connected"); assert.deepEqual(state.entitlement, paid);
  f.invalidEntitlement = false; state = await f.client.refresh(); assert.equal(state.checking, undefined); assert.deepEqual(state.entitlement, paid);
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

test("a connection that fails while the Admin says My Cloud can't be reached says why, from the Admin's latest word; otherwise the request's own error", async t => {
  const f = await fixture(t); await f.connect();
  const origin = "https://home-7f3k2.fly.dev", since = f.now - 6 * 60_000;
  f.entitlement = { plan: "pro", tier: "pro", status: "active", expiresAt: f.now + 86_400_000, version: 1 };
  f.cloud = { state: "ready", origin, pairingAvailable: true };
  await f.client.refresh();
  // The Admin can't make a connection code here (the fixture has no pairing route), and says nothing about why.
  await assert.rejects(f.client.pairHome(), { message: "Cloud request failed." });
  // Its health checks found the server down since this app last read the session: the app reads it again and says why.
  f.cloud = { state: "ready", origin, pairingAvailable: true, unreachable: { cause: "host", since } };
  await assert.rejects(f.client.pairHome(), { message: "The server My Cloud runs on is being restarted by our hosting provider. My Cloud and its files are safe, and it comes back on its own, usually within about 20 minutes." });
  assert.deepEqual(f.client.state().machine, { status: "ready", origin, unreachable: { cause: "host", since } });
  f.cloud = { ...f.cloud, unreachable: { cause: "no_answer", since } };
  await assert.rejects(f.client.pairHome(), { message: "My Cloud hasn't answered for a few minutes. Nothing was lost, and we've been told." });
  f.cloud = { state: "ready", origin, pairingAvailable: true };
  await assert.rejects(f.client.pairHome(), { message: "Cloud request failed." });
});

test("a free trial and its AI credit come with a verified session, for display only; an Admin without them changes nothing", async t => {
  const f = await fixture(t); await f.connect();
  const DAY = 86_400_000, endsAt = f.now + 2 * DAY, origin = "https://home-7f3k2.fly.dev";
  const trial = { state: "active", tier: "pro", endsAt, amount: 4900, chargeAt: endsAt, holdUntil: null, deleteAt: null, keep: "none" };
  const credit = { grantedUsd: 5, remainingUsd: 3.2, state: "active" };
  f.entitlement = { plan: "pro", tier: "pro", status: "active", expiresAt: endsAt + 3 * DAY, version: 1 };
  f.cloud = { state: "ready", origin, pairingAvailable: true };
  let state = await f.client.refresh();
  assert.equal(state.trial, undefined); assert.equal(state.credit, undefined);
  assert.deepEqual(cloudPlanSnapshot(state), { status: "paid", tier: "pro" });
  f.cloud = { state: "ready", origin, pairingAvailable: true, trial, credit };
  state = await f.client.refresh();
  assert.deepEqual(state.trial, trial); assert.deepEqual(state.credit, credit); assert.deepEqual(state.machine, { status: "ready", origin });
  assert.equal(state.entitlement.status, "active", "the trial grants nothing; the entitlement does");
  assert.ok(!JSON.stringify(f.saved).includes("trial") && !JSON.stringify(f.saved).includes("credit"), "nothing about a trial is kept beside the sign-in");
  const snapshot = cloudPlanSnapshot(state, { notice: "active" });
  assert.deepEqual(snapshot, { status: "paid", tier: "pro", trial, credit, notice: "active" });
  assert.ok(!JSON.stringify(snapshot).includes("person@example.test") && !JSON.stringify(snapshot).includes("fixture-account"));
  f.cloud = { state: "ready", origin, pairingAvailable: true, trial: { ...trial, state: "paused" }, credit: { ...credit, remainingUsd: 9 } };
  state = await f.client.refresh();
  assert.equal(state.trial, undefined); assert.equal(state.credit, undefined); assert.equal(state.machine.status, "ready"); assert.equal(state.entitlement.status, "active");
  const ended = { ...trial, state: "ended", chargeAt: null, deleteAt: endsAt + 3 * DAY, keep: "checkout" };
  f.entitlement = { plan: "free", status: "inactive", expiresAt: null, version: 2 };
  f.cloud = { state: "stopped", origin: null, pairingAvailable: false, trial: ended };
  state = await f.client.refresh();
  assert.deepEqual(cloudPlanSnapshot(state, { notice: "ended" }), { status: "none", trial: ended, notice: "ended" });
  f.sessionStatus = 503; await f.client.refresh(); f.now += 15 * 60_000;
  assert.equal(f.client.state().trial, undefined);
  assert.deepEqual(cloudPlanSnapshot(f.client.state(), { notice: "ended" }), { status: "none" });
  for (const unverified of [{ status: "unavailable", trial: ended, credit, lastPlan: { tier: "pro", active: true } }, { status: "unavailable", trial: ended, credit },
    { status: "reauth-required", trial: ended, credit }, { status: "signed-out", trial: ended }]) {
    const shown = cloudPlanSnapshot(unverified, { notice: "ended" });
    assert.equal(shown.trial, undefined); assert.equal(shown.credit, undefined); assert.equal(shown.notice, undefined);
  }
  assert.deepEqual(cloudPlanSnapshot({ status: "connected", entitlement: { plan: "free", status: "inactive", expiresAt: null, version: 1 } }, { notice: "ended" }), { status: "none" });
});

const plans = () => [
  { tier: "starter", label: "Starter", price: { currency: "USD", amount: 1500, interval: "month" }, allowances: null },
  { tier: "pro", label: "Pro", price: { currency: "USD", amount: 4900, interval: "month" }, allowances: null },
];
test("what this person may buy: the session's own offer when signed in, else the public plans, read with no sign-in or cookie at most every 10 minutes", async t => {
  const f = await fixture(t);
  const asked = () => f.requests.filter(row => row.route === "/api/public/config");
  assert.equal(await f.client.offer(), null); assert.equal(asked().length, 1);
  assert.equal(await f.client.offer(), null); assert.equal(asked().length, 1, "a failed ask counts for 30 seconds");
  f.now += 30_000; f.publicConfig = { status: 200, body: { name: "OpenMausBot", surface: "cloud", plans: plans(), trial: { days: 7, holdDays: 3, creditUsd: 5 }, refundDays: 14 } };
  const [first, second] = await Promise.all([f.client.offer(), f.client.offer()]);
  assert.deepEqual(first.plans.map(plan => [plan.tier, plan.amount, plan.trialDays]), [["starter", 1500, 7], ["pro", 4900, 7]]);
  assert.deepEqual([first.recommended, first.creditUsd, first.refundDays], ["pro", 5, 14]);
  assert.deepEqual(second, first); assert.equal(asked().length, 2, "one ask at a time");
  f.now += 9 * 60_000; await f.client.offer(); assert.equal(asked().length, 2, "an answer counts for 10 minutes");
  assert.ok(asked().every(row => row.token === undefined && row.cookie === undefined && row.method === "GET" && row.version === undefined));
  for (const publicConfig of [{ status: 200, body: { plans: "pro" } }, { status: 503, body: { error: "down" } }, { status: 403, body: "<!doctype html>Just a moment" }]) {
    f.now += 10 * 60_000; f.publicConfig = publicConfig;
    assert.equal(await f.client.offer(), null, JSON.stringify(publicConfig));
  }
  assert.equal(f.client.state().status, "signed-out"); assert.deepEqual(f.browsers, []);
  f.now += 10 * 60_000; f.publicConfig = { status: 200, body: { plans: plans(), trial: { days: 7 }, refundDays: 14 } };
  f.offer = { plans: plans(), recommended: "pro", refundDays: 14 };
  await f.connect();
  const session = await f.client.offer();
  assert.deepEqual(session.plans.map(plan => plan.trialDays ?? null), [null, null], "this account's own: no trial, whatever the public config says");
  assert.deepEqual(f.client.state().offer, session);
  f.offer = undefined; await f.client.refresh();
  assert.equal(f.client.state().offer, undefined);
  const fallback = await f.client.offer();
  assert.deepEqual(fallback.plans.map(plan => plan.trialDays ?? null), [null, null]); assert.equal(fallback.refundDays, 14);
});

test("Dodo's own checkout page is the only checkout address ever opened", () => {
  assert.equal(checkoutDestination("https://checkout.dodopayments.com/session/cks_123?x=1"), "https://checkout.dodopayments.com/session/cks_123?x=1");
  for (const url of ["https://test.checkout.dodopayments.com/session/cks_123", "http://checkout.dodopayments.com/session/1", "https://checkout.dodopayments.com.evil.test/session/1",
    "https://user:pw@checkout.dodopayments.com/session/1", "https://checkout.dodopayments.com/session/1#x", "https://checkout.dodopayments.com/session/1#",
    "javascript:alert(1)", "file:///etc/passwd", "openmausbot://cloud", "https://evil.example.test/", "", 42, null, `https://checkout.dodopayments.com/${"x".repeat(2100)}`]) {
    assert.equal(checkoutDestination(url), null, String(url));
  }
  assert.equal(checkoutDestination("https://test.checkout.dodopayments.com/session/cks_123", { fixture: true }), "https://test.checkout.dodopayments.com/session/cks_123");
  assert.deepEqual([...CHECKOUT_SOURCES], ["app_card", "app_howto", "app_menu", "app_settings", "app_routines", "app_pages", "update_popup", "app_onboarding"]);
});

test("signed in, a checkout is the Admin's for this account, opened in the browser only when it is Dodo's; then the session is asked every 3 seconds for 30 minutes", async t => {
  const f = await fixture(t); await f.connect(); f.browsers = [];
  const DODO = "https://test.checkout.dodopayments.com/session/cks_fixture";
  f.checkout = { status: 200, body: { cloudContractVersion: 1, url: DODO } };
  await assert.rejects(f.client.checkout("pro", "app_website"), /Invalid Cloud checkout/);
  await assert.rejects(f.client.checkout("Pro <b>", "app_menu"), /Invalid Cloud checkout/);
  assert.ok(!f.requests.some(row => row.route.endsWith("/checkout")), "nothing is asked for a refused plan or source");
  const result = await f.client.checkout("pro", "app_menu");
  assert.equal(result.outcome, "opened"); assert.deepEqual(f.browsers, [DODO]);
  const request = f.requests.findLast(row => row.route === "/api/cloud/desktop/checkout");
  assert.deepEqual(JSON.parse(request.body), { plan: "pro", source: "app_menu" });
  assert.equal(request.token, `Bearer ${accessToken}`); assert.equal(request.version, "0.1.fixture");
  assert.deepEqual(result.state.checkout, { plan: "pro", startedAt: f.now, link: true }, "main keeps the page; the state only says so");
  assert.ok(!JSON.stringify(f.states).includes("cks_fixture"), "the checkout page never reaches a published state");
  assert.equal(f.client.checkoutLink(), DODO);
  assert.equal(f.client.checkoutPending(), true); assert.equal(f.delay, 3_000);
  f.tick(); await until(() => f.delay !== null && f.requests.filter(row => row.route === "/api/cloud/desktop/session").length >= 2);
  assert.equal(f.delay, 3_000, "still free: asked again in 3 seconds");
  const asked = f.requests.filter(row => row.route === "/api/cloud/desktop/checkout").length;
  for (let i = 0; i < 12; i++) assert.equal((await f.client.reopenCheckout()).outcome, "opened");
  assert.equal(f.requests.filter(row => row.route === "/api/cloud/desktop/checkout").length, asked, "Reopen checkout never asks the Admin for another");
  assert.deepEqual(f.browsers, Array(13).fill(DODO), "the same page each time");
  f.now += 30 * 60_000; assert.equal(f.client.checkoutPending(), false);
  await f.client.refresh(); assert.equal(f.delay, 60_000);
  assert.deepEqual(f.client.state().checkout, { plan: "pro", startedAt: f.now - 30 * 60_000, link: true });
  await f.client.reopenCheckout(); assert.equal(f.browsers.at(-1), DODO);
  assert.equal(f.client.checkoutPending(), true, "reopened after 30 minutes: watched again"); assert.equal(f.delay, 3_000);
  f.entitlement = { plan: "pro", tier: "pro", status: "active", expiresAt: f.now + 3 * 86400_000, version: 1 };
  f.cloud = { state: "setting_up", setup: { step: "storage" } };
  await f.client.refresh(); assert.equal(f.delay, 3_000, "paid and setting up, still watched: every 3 seconds");
  f.cloud = { state: "ready", origin: "https://home-7f3k2.fly.dev" };
  await f.client.refresh(); assert.equal(f.delay, 60_000, "ready: back to every minute");
  f.entitlement = { plan: "free", status: "inactive", expiresAt: null, version: 2 }; f.cloud = undefined; await f.client.refresh();
  for (const url of ["https://evil.example.test/pay", "https://user:pw@test.checkout.dodopayments.com/s", `${DODO}#token`]) {
    f.checkout = { status: 200, body: { cloudContractVersion: 1, url } }; f.browsers = [];
    assert.equal((await f.client.checkout("pro", "app_menu")).outcome, "failed", url); assert.deepEqual(f.browsers, []);
  }
  f.checkout = { status: 200, body: { url: DODO } };
  assert.equal((await f.client.checkout("pro", "app_menu")).outcome, "failed", "no contract version");
  f.checkout = { status: 409, body: { error: "already_subscribed" } }; const sessions = f.requests.filter(row => row.route === "/api/cloud/desktop/session").length;
  assert.equal((await f.client.checkout("pro", "app_menu")).outcome, "conflict");
  assert.equal(f.requests.filter(row => row.route === "/api/cloud/desktop/session").length, sessions + 1);
  f.checkout = { status: 429, body: { error: "rate_limited", interval: 600 } };
  assert.equal((await f.client.checkout("pro", "app_menu")).outcome, "rate-limited");
  for (const status of [502, 503]) { f.checkout = { status, body: { error: "unavailable" } }; assert.equal((await f.client.checkout("pro", "app_menu")).outcome, "failed"); }
  f.checkout = { status: 409, body: "<!doctype html>Conflict page" };
  assert.equal((await f.client.checkout("pro", "app_menu")).outcome, "failed", "a page from in between is not the Admin's 409");
  assert.deepEqual(f.browsers, []);
  f.checkout = { status: 404, body: "<!doctype html>not here" };
  assert.equal((await f.client.checkout("max", "app_card")).outcome, "opened");
  assert.deepEqual(f.browsers, [`${f.origin}/cloud?checkout=start&plan=max&src=app_card`]);
  f.now += 24 * 3600_000; assert.equal(f.client.state().checkout, undefined); assert.equal(f.client.checkoutLink(), null);
});

test("the purchase is over once its Cloud was opened, announced or shown ready: the checkout says done, once", async t => {
  const f = await fixture(t); await f.connect();
  f.checkout = { status: 200, body: { cloudContractVersion: 1, url: "https://test.checkout.dodopayments.com/session/cks_done" } };
  await f.client.checkout("pro", "app_menu");
  const published = f.states.length;
  f.client.checkoutDone();
  assert.deepEqual(f.client.state().checkout, { plan: "pro", startedAt: f.now, link: true, done: true });
  assert.equal(f.states.length, published + 1, "the page hears it");
  f.client.checkoutDone(); assert.equal(f.states.length, published + 1, "once");
  const none = await fixture(t); none.client.checkoutDone(); assert.equal(none.client.state().checkout, undefined, "nothing to end");
});

test("after a restart mid-checkout, the checkout the Admin still holds is watched from first sight like this app's own", async t => {
  const f = await fixture(t); await f.connect();
  f.offer = { plans: plans(), recommended: "pro", trialDays: 7, checkout: { plan: "starter", openUntil: f.now + 3600_000 } };
  const seen = await f.client.refresh();
  assert.deepEqual(seen.checkout, { plan: "starter", startedAt: f.now }, "no page is kept: no link");
  assert.equal(f.client.checkoutPending(), true, "watched: focus reads the session at once");
  assert.equal(f.delay, 3_000, "every 3 seconds");
  f.now += 10 * 60_000; await f.client.refresh();
  assert.equal(f.client.state().checkout.startedAt, f.now - 10 * 60_000, "first sight, not every sight");
  f.now += 20 * 60_000; await f.client.refresh();
  assert.equal(f.client.checkoutPending(), false, "30 minutes at most"); assert.equal(f.delay, 60_000);
  f.browsers = []; const DODO = "https://test.checkout.dodopayments.com/session/cks_held";
  f.checkout = { status: 200, body: { cloudContractVersion: 1, url: DODO } };
  assert.equal((await f.client.reopenCheckout("pro", "app_card")).outcome, "opened");
  assert.deepEqual(JSON.parse(f.requests.findLast(row => row.route === "/api/cloud/desktop/checkout").body), { plan: "starter", source: "app_card" },
    "the plan the Admin holds, under the page's source");
  assert.deepEqual(f.browsers, [DODO]);
  const paid = await fixture(t); await paid.connect();
  paid.entitlement = { plan: "pro", tier: "pro", status: "active", expiresAt: paid.now + 86400_000, version: 1 };
  paid.offer = { plans: plans(), recommended: "pro", checkout: { plan: "pro", openUntil: paid.now + 3600_000 } };
  assert.equal((await paid.client.refresh()).checkout, undefined, "nothing to watch once paid");
});

test("Reopen checkout with no page kept (the browser sign-in led to checkout) asks the Admin once, then keeps its page", async t => {
  const f = await fixture(t);
  const DODO = "https://test.checkout.dodopayments.com/session/cks_reopened";
  f.checkout = { status: 200, body: { cloudContractVersion: 1, url: DODO } }; f.offer = { plans: plans(), recommended: "pro", trialDays: 7 };
  await f.client.checkout("pro", "app_card");
  f.approved = true; f.tick(); await until(() => f.client.state().status === "connected");
  assert.equal(f.client.checkoutLink(), null); assert.equal(f.client.state().checkout.link, undefined);
  f.browsers = [];
  assert.equal((await f.client.reopenCheckout("max", "app_menu")).outcome, "opened");
  assert.deepEqual(JSON.parse(f.requests.findLast(row => row.route === "/api/cloud/desktop/checkout").body), { plan: "pro", source: "app_card" }, "the plan chosen here, not the page's word");
  await f.client.reopenCheckout("max", "app_menu");
  assert.equal(f.requests.filter(row => row.route === "/api/cloud/desktop/checkout").length, 1);
  assert.deepEqual(f.browsers, [DODO, DODO]);
});

test("signed out, a checkout is a sign-in first: the verified link only gains the intent, and a failed sign-in forgets it", async t => {
  const f = await fixture(t);
  f.offer = { plans: plans(), recommended: "pro", trialDays: 7 };
  const result = await f.client.checkout("pro", "app_card");
  assert.equal(result.outcome, "signing-in"); assert.equal(result.state.status, "connecting");
  assert.deepEqual(f.browsers, [`${f.origin}/cloud/desktop?code=ABCDE-FGHJK&next=checkout&plan=pro&src=app_card`]);
  assert.deepEqual(result.state.checkout, { plan: "pro", startedAt: f.now, signIn: true });
  assert.ok(!f.requests.some(row => row.route.endsWith("/checkout")), "no checkout before the sign-in");
  await f.client.reopen(); assert.equal(f.browsers.at(-1), f.browsers[0]);
  f.approved = true; f.tick(); await until(() => f.client.state().status === "connected");
  assert.deepEqual(f.client.state().checkout, { plan: "pro", startedAt: result.state.checkout.startedAt, signIn: true });
  assert.equal(f.browsers.length, 2, "nothing more is opened: the approved page leads to checkout");
  assert.ok(!f.requests.some(row => row.route.endsWith("/checkout")));
  await f.client.signOut(); assert.equal(f.client.state().checkout, undefined, "signing out forgets it");
  const old = await fixture(t);
  await old.client.checkout("max", "app_menu");
  old.approved = true; old.tick(); await until(() => old.browsers.length === 2);
  assert.deepEqual(old.browsers, [`${old.origin}/cloud/desktop?code=ABCDE-FGHJK&next=checkout&plan=max&src=app_menu`, `${old.origin}/cloud?checkout=start&plan=max&src=app_menu`]);
  const payer = await fixture(t);
  payer.entitlement = { plan: "pro", tier: "pro", status: "active", expiresAt: payer.now + 30 * 86400_000, version: 1 };
  await payer.client.checkout("pro", "app_card");
  payer.approved = true; payer.tick(); await until(() => payer.client.state().status === "connected");
  assert.equal(payer.browsers.length, 1);
  assert.equal(payer.client.state().checkout, undefined);
  const bad = await fixture(t); bad.badUrl = true;
  assert.equal((await bad.client.checkout("pro", "app_card")).state.status, "signed-out");
  assert.deepEqual(bad.browsers, []); assert.equal(bad.client.state().checkout, undefined);
});

test("this app's version rides on every signed-in request, and interest is one POST for this account", async t => {
  const f = await fixture(t); await f.connect();
  assert.equal(JSON.parse(f.requests.find(row => row.route.endsWith("/authorize")).body).appVersion, "0.1.fixture");
  assert.ok(f.requests.filter(row => row.route.endsWith("/session")).every(row => row.version === "0.1.fixture"));
  assert.ok(f.requests.filter(row => !row.token).every(row => row.version === undefined), "never on a request without the sign-in");
  await f.client.interest("another_cloud");
  const interest = f.requests.find(row => row.route.endsWith("/interest"));
  assert.deepEqual(JSON.parse(interest.body), { kind: "another_cloud" }); assert.equal(interest.token, `Bearer ${accessToken}`);
  await assert.rejects(f.client.interest("something_else"), /Invalid Cloud interest/);
  f.interest = { status: 503, body: { error: "unavailable" } };
  await assert.rejects(f.client.interest("another_cloud"));
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
  f.sessionStatus = 503; f.client.close();
  const restored = await fixture(t); restored.saved = { ...f.saved, origin: restored.origin }; restored.sessionStatus = 503;
  const state = await restored.client.start();
  assert.equal(state.status, "unavailable"); assert.equal(state.entitlement, undefined); assert.deepEqual(state.lastPlan, { tier: "personal", active: true });
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
  f.sessionPage = null; f.sessionError = { status: 403, body: { error: "invalid_origin" } };
  state = await f.client.refresh(); assert.equal(state.status, "connected"); assert.deepEqual(state.entitlement, paid);
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

test("pages access: this sign-in's own pages token on any plan, null without the service, never a URL off the Cloud's origin", async t => {
  const f = await fixture(t);
  const before = f.requests.length;
  assert.equal(await f.client.pagesAccess(), null);
  assert.equal(f.requests.length, before);
  await f.connect();
  const token = `omb_pd_${"a".repeat(43)}`, url = `${f.origin}/api/cloud/pages/token`;
  f.pages = { status: 200, body: { cloudContractVersion: 1, url, token } };
  assert.deepEqual(await f.client.pagesAccess(), { url, token });
  assert.ok(f.requests.some(r => r.route === "/api/cloud/desktop/services/pages" && r.method === "POST" && r.token === `Bearer ${accessToken}`));
  f.pages = { status: 404, body: { error: "unsupported" } }; assert.equal(await f.client.pagesAccess(), null);
  f.pages = { status: 200, body: { cloudContractVersion: 1, url: "https://elsewhere.example.test/api/cloud/pages/token", token } }; await assert.rejects(f.client.pagesAccess(), /Invalid/);
  f.pages = { status: 200, body: { cloudContractVersion: 1, url, token: `omb_xd_${"a".repeat(43)}` } }; await assert.rejects(f.client.pagesAccess(), /Invalid/);
  f.pages = { status: 500, body: { error: "down" } }; await assert.rejects(f.client.pagesAccess());
});

test("My Cloud's line in the server menus says what is true now: the trial's end while it is ahead, always on while paid for, stopped when not, nothing when unknown", () => {
  const date = value => new Date(value).toISOString().slice(0, 10);
  const connected = (extra = {}) => ({ status: "connected", account: { id: "a", email: "a@example.test" }, entitlement: { plan: "pro", tier: "pro", status: "active", expiresAt: 2e12, version: 1 }, ...extra });
  const ends = Date.UTC(2026, 9, 15);
  assert.equal(cloudMenuSublabel(connected({ trial: { state: "active", endsAt: ends } }), date), "Free trial until 2026-10-15");
  assert.equal(cloudMenuSublabel(connected({ trial: { state: "ending", endsAt: ends } }), date), "Free trial until 2026-10-15");
  assert.equal(cloudMenuSublabel(connected({ trial: { state: "processing", endsAt: ends } }), date), "Always on");
  assert.equal(cloudMenuSublabel(connected(), date), "Always on");
  const inactive = { plan: "pro", tier: "pro", status: "inactive", expiresAt: null, version: 2 };
  for (const state of [connected({ entitlement: inactive, trial: { state: "ended", endsAt: ends }, machine: { status: "stopped" } }),
    connected({ entitlement: inactive, trial: { state: "late", endsAt: ends } }), connected({ entitlement: inactive, machine: { status: "payment-problem" } }),
    connected({ entitlement: { plan: "free", status: "inactive", expiresAt: null, version: 3 }, machine: { status: "stopped" } })]) assert.equal(cloudMenuSublabel(state, date), "Stopped");
  for (const state of [null, { status: "signed-out" }, { status: "reauth-required", message: "expired", lastPlan: { tier: "pro", active: true } }, { status: "unavailable" },
    connected({ entitlement: { plan: "free", status: "inactive", expiresAt: null, version: 1 } })]) assert.equal(cloudMenuSublabel(state, date), null);
});

test("the session's teams come with a verified session, each with its Cloud; a team pairing is asked of the Admin's team route for the team's own address, and 404 means the person is no longer in it", async t => {
  const f = await fixture(t); await f.connect();
  const origin = "https://omb-u-acme.fly.dev", code = "AAAA-BBBB-CCCC";
  assert.equal(f.client.state().teams, undefined, "in no team: nothing added");
  f.teams = [{ id: "team-acme", name: "Acme", role: "member", machine: { state: "ready", origin, pairingAvailable: true, status: "ready" } }, { id: "team-x", name: "Later", role: "admin", machine: null }];
  await f.client.refresh();
  assert.deepEqual(f.client.state().teams, [{ id: "team-acme", name: "Acme", role: "member", machine: { status: "ready", origin } }, { id: "team-x", name: "Later", role: "admin", machine: null }]);
  assert.equal(f.client.homeTarget(), null, "a team's Cloud is never My Cloud");
  await assert.rejects(f.client.pairTeam("team-x"), { message: "Later isn't ready to open yet." });
  await assert.rejects(f.client.pairTeam("team-nope"), { gone: true });
  f.teamPairing = { status: 200, body: { cloudContractVersion: 1, origin, code, pairingUrl: `${origin}/pair#code=${code}`, expiresAt: f.now + 300_000, credential: "omb_pair_x" } };
  assert.deepEqual(await f.client.pairTeam("team-acme"), { origin, code, expiresAt: f.now + 300_000 });
  const asked = f.requests.filter(request => request.route.includes("/teams/"));
  assert.deepEqual(asked.map(request => [request.route, request.method, request.token]), [["/api/cloud/desktop/teams/team-acme/pairing", "POST", `Bearer ${accessToken}`]]);
  f.teamPairing = { status: 200, body: { cloudContractVersion: 1, origin: "https://other.fly.dev", code, expiresAt: f.now + 300_000 } };
  await assert.rejects(f.client.pairTeam("team-acme"), { message: "Invalid Cloud pairing response." }, "a code for another address never connects");
  f.teamPairing = { status: 409, body: { error: "cloud_unavailable" } };
  await assert.rejects(f.client.pairTeam("team-acme"), { message: "Acme isn't running right now." });
  f.teamPairing = { status: 404, body: { error: "not_found" } };
  f.teams = [];
  await assert.rejects(f.client.pairTeam("team-acme"), { gone: true, message: "You're no longer in Acme." });
  await until(() => f.client.state().teams === undefined);
  f.teams = undefined; await f.client.refresh();
  assert.equal(f.client.state().teams, undefined, "an older Admin: no teams");
});

test("this computer tells the Admin its move is done, and asks for an ended Cloud's export, as itself; as before when it can't say", async t => {
  const f = await fixture(t), computer = "C".repeat(43);
  assert.equal(await f.client.reportMove({ installation: computer }), false, "nobody signed in");
  await f.connect();
  assert.equal(await f.client.reportMove({ installation: computer }), false, "an Admin that can't take it yet");
  f.moved = { status: 200, body: { cloudContractVersion: 1, recorded: true } };
  assert.equal(await f.client.reportMove({ installation: computer }), true);
  const said = f.requests.findLast(r => r.route === "/api/cloud/desktop/moved");
  assert.deepEqual([said.method, said.token, JSON.parse(said.body)], ["POST", `Bearer ${accessToken}`, { installation: computer }]);
  f.moved = { status: 409, body: { error: "not_moved" } };
  await assert.rejects(f.client.reportMove({ installation: computer }));
  await assert.rejects(f.client.exportHome({ installation: computer }));
  assert.deepEqual(JSON.parse(f.requests.findLast(r => r.route === "/api/cloud/desktop/export").body), { installation: computer });
  await assert.rejects(f.client.exportHome());
  assert.deepEqual(JSON.parse(f.requests.findLast(r => r.route === "/api/cloud/desktop/export").body), {});
});
