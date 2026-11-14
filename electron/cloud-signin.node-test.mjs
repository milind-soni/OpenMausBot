import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { createCloudAccountClient } from "./cloud-account.mjs";
import { cleanCode, cleanEmail, parseSignInStart, SIGN_IN_TRIES, signInIdentity, startFailure, verifyFailure } from "./cloud-signin.mjs";

const accessToken = `omc_${"E".repeat(43)}`, ATTEMPT = "a".repeat(43), CODE = "48201937";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { for (let i = 0; i < 200; i++) { if (check()) return; await sleep(5); } assert.fail("Fixture did not reach the expected state"); }
/** A fixture Admin with the phone apps' email-code routes (openmaus-cloud server/cloud-app-signin.ts) and the desktop session. */
async function fixture(t, options = {}) {
  const f = { now: 1_800_000_000_000, requests: [], saved: null, states: [], browsers: [], code: CODE, wrong: 0,
    start: null, verify: null, entitlement: { plan: "free", status: "inactive", expiresAt: null, version: 0 } };
  const identity = () => ({ cloudContractVersion: 1, expiresAt: f.now + 30 * 86400_000, device: { id: "email-device" }, account: { id: "email-account", email: "person@example.test" } });
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    f.requests.push({ route: req.url, method: req.method, token: req.headers.authorization, origin: req.headers.origin, type: req.headers["content-type"], body });
    const send = (status, data) => { res.writeHead(status, { "content-type": typeof data === "string" ? "text/html" : "application/json" }); res.end(typeof data === "string" ? data : JSON.stringify(data)); };
    if (req.url === "/api/cloud/app/sign-in/start" && req.method === "POST") {
      if (f.start) return send(f.start.status, f.start.body);
      return send(200, { cloudContractVersion: 1, attempt: ATTEMPT, expiresIn: 600, resendAfter: 30, signupOpen: true });
    }
    if (req.url === "/api/cloud/app/sign-in/verify" && req.method === "POST") {
      if (f.verifyGate) await f.verifyGate;
      if (f.verify) return send(f.verify.status, f.verify.body);
      const input = JSON.parse(body);
      if (input.attempt !== ATTEMPT) return send(410, { error: "expired", errorDescription: "This sign-in expired or was already used. Start again in the app." });
      if (input.code !== f.code) { f.wrong++; return send(400, { error: "invalid_code", errorDescription: "That code isn’t right. Check the email and try again." }); }
      return send(200, { ...identity(), accessToken });
    }
    if (req.url === "/api/cloud/desktop/session" && req.headers.authorization === `Bearer ${accessToken}`) {
      if (req.method === "DELETE") return send(200, { ok: true });
      return send(200, { ...identity(), entitlement: f.entitlement, cloud: null });
    }
    if (req.url === "/api/cloud/desktop/authorize") return send(201, { cloudContractVersion: 1, deviceCode: "A".repeat(43), userCode: "ABCDE-FGHJK",
      verificationUriComplete: `${f.origin}/cloud/desktop?code=ABCDE-FGHJK`, expiresIn: 600, interval: 5 });
    send(404, { error: "not_found" });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  f.origin = `http://127.0.0.1:${server.address().port}`;
  f.client = createCloudAccountClient({ origin: f.origin, fixture: true, deviceName: "Fixture computer", platform: "darwin", appVersion: "0.1.113", now: () => f.now,
    store: { read: async () => f.saved, write: async value => { if (f.failWrite) throw new Error("fixture storage failure"); f.saved = structuredClone(value); } },
    openBrowser: async url => { f.browsers.push(url); }, onState: state => f.states.push(state), setTimer: () => 1, clearTimer: () => {}, ...options });
  await f.client.start();
  t.after(async () => { f.client.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return f;
}

test("the email, the code and the Admin's answers are read strictly", () => {
  assert.equal(cleanEmail("  Person@Example.TEST "), "person@example.test");
  for (const bad of ["", "person", "person@", "@example.test", "person@example", "per son@example.test", "per\u0000son@example.test", `${"a".repeat(250)}@example.test`, 42, null]) {
    assert.equal(cleanEmail(bad), null, String(bad));
  }
  assert.equal(cleanCode("4820 1937"), CODE); assert.equal(cleanCode("4820-1937"), CODE);
  for (const bad of ["4820193", "482019370", "4820193a", "", null, 48201937]) assert.equal(cleanCode(bad), null, String(bad));
  assert.deepEqual(signInIdentity({ deviceName: "Mac", platform: "darwin", appVersion: "0.1.113" }), { deviceName: "Mac", platform: "darwin", appVersion: "0.1.113" });
  assert.equal(signInIdentity({ deviceName: "Mac", platform: "ios", appVersion: "1" }), null, "this app signs in as a desktop only");
  assert.equal(signInIdentity({ deviceName: "Mac", platform: "linux", appVersion: "dev build!" }).appVersion, "0.0.0");
  assert.deepEqual(parseSignInStart({ cloudContractVersion: 1, attempt: ATTEMPT, expiresIn: 600, resendAfter: 30 }), { attempt: ATTEMPT, expiresIn: 600, resendAfter: 30, signupOpen: true });
  assert.equal(parseSignInStart({ cloudContractVersion: 1, attempt: ATTEMPT, expiresIn: 600, signupOpen: false }).signupOpen, false);
  for (const bad of [null, { attempt: ATTEMPT, expiresIn: 600 }, { cloudContractVersion: 1, attempt: "short", expiresIn: 600 }, { cloudContractVersion: 1, attempt: ATTEMPT, expiresIn: 5 }]) {
    assert.equal(parseSignInStart(bad), null, JSON.stringify(bad));
  }
  const admin = (status, code) => Object.assign(new Error("x"), { status, code });
  assert.deepEqual([admin(403, "sso"), admin(429, "rate_limited"), admin(404, "unsupported"), Object.assign(new Error("x"), { status: 404, opaque: true }), admin(400, "invalid_request"), admin(503, "x"), new TypeError("fetch failed")].map(startFailure),
    ["sso", "rate-limited", "browser", "browser", "invalid-email", "failed", "failed"]);
  assert.deepEqual([admin(400, "invalid_code"), admin(410, "expired"), admin(403, "sso"), admin(403, "two_factor"), admin(403, "signup_closed"), admin(403, "device_limit"), admin(429, "rate_limited"),
    Object.assign(new Error("x"), { status: 403, opaque: true })].map(verifyFailure), ["wrong-code", "expired", "sso", "two-factor", "signup-closed", "device-limit", "rate-limited", "failed"]);
});

test("happy path: the code is sent, the right code signs this computer in with the token stored like the browser sign-in's", async t => {
  const f = await fixture(t);
  const sent = await f.client.emailStart(" Person@Example.TEST ");
  assert.deepEqual(sent, { outcome: "sent", email: "person@example.test", expiresAt: f.now + 600_000, resendAt: f.now + 30_000, signupOpen: true });
  const start = f.requests.find(row => row.route === "/api/cloud/app/sign-in/start");
  assert.deepEqual(JSON.parse(start.body), { email: "person@example.test", deviceName: "Fixture computer", platform: "darwin", appVersion: "0.1.113" });
  assert.equal(start.type, "application/json"); assert.equal(start.origin, undefined, "no Origin: the Admin refuses a cross-origin one");
  assert.equal(f.client.state().status, "signed-out", "nothing is signed in until the code is checked");
  const verified = await f.client.emailVerify("4820 1937");
  assert.equal(verified.outcome, "signed-in"); assert.equal(verified.state.status, "connected");
  assert.deepEqual(JSON.parse(f.requests.find(row => row.route === "/api/cloud/app/sign-in/verify").body), { attempt: ATTEMPT, code: CODE });
  assert.equal(f.saved.token, accessToken, "stored where the browser sign-in's token goes"); assert.equal(f.saved.origin, f.origin);
  assert.equal(f.requests.findLast(row => row.route === "/api/cloud/desktop/session").token, `Bearer ${accessToken}`);
  assert.deepEqual(f.client.state().account, { id: "email-account", email: "person@example.test" });
  for (const secret of [accessToken, ATTEMPT]) {
    assert.ok(!JSON.stringify([sent, verified, f.states]).includes(secret), "the page never sees the token or the attempt");
  }
  assert.deepEqual(f.browsers, [], "no browser at all");
  assert.equal((await f.client.emailVerify(CODE)).outcome, "expired", "an attempt is used once");
  await assert.rejects(f.client.emailStart("person@example.test"), /Sign out before/, "signed in: no second sign-in");
});

test("with new accounts closed the Admin still answers \"sent\" (only an existing address gets mail), and the page is told", async t => {
  const f = await fixture(t);
  f.start = { status: 200, body: { cloudContractVersion: 1, attempt: ATTEMPT, expiresIn: 600, resendAfter: 30, signupOpen: false } };
  assert.deepEqual(await f.client.emailStart("new@example.test"), { outcome: "sent", email: "new@example.test", expiresAt: f.now + 600_000, resendAt: f.now + 30_000, signupOpen: false });
});

test("a wrong code says the tries left; the last one asks for a new code; nothing is stored", async t => {
  const f = await fixture(t);
  await f.client.emailStart("person@example.test");
  for (let left = SIGN_IN_TRIES - 1; left > 0; left--) assert.deepEqual(await f.client.emailVerify("11111111"), { outcome: "wrong-code", triesLeft: left });
  assert.deepEqual(await f.client.emailVerify("11111111"), { outcome: "expired" }, "the fifth wrong code uses the code up");
  assert.equal(f.wrong, SIGN_IN_TRIES);
  const asked = f.requests.length;
  assert.deepEqual(await f.client.emailVerify(CODE), { outcome: "expired" }); assert.equal(f.requests.length, asked, "not asked again");
  assert.equal(f.saved, null); assert.equal(f.client.state().status, "signed-out");
  await f.client.emailStart("person@example.test");
  assert.deepEqual(await f.client.emailVerify("123"), { outcome: "wrong-code", triesLeft: SIGN_IN_TRIES }, "not 8 digits: not sent, no try used");
  assert.equal(f.requests.filter(row => row.route.endsWith("/verify")).length, SIGN_IN_TRIES);
  assert.equal((await f.client.emailVerify(CODE)).outcome, "signed-in", "a new code works");
});

test("single sign-on is told at the start (no code is sent) and falls back to the browser approval", async t => {
  const f = await fixture(t);
  f.start = { status: 403, body: { error: "sso", errorDescription: "Your organization signs in with single sign-on." } };
  assert.deepEqual(await f.client.emailStart("person@company.test"), { outcome: "sso" });
  assert.deepEqual(await f.client.emailVerify(CODE), { outcome: "expired" }, "no attempt was kept");
  const browser = await f.client.begin();
  assert.equal(browser.status, "connecting"); assert.deepEqual(f.browsers, [`${f.origin}/cloud/desktop?code=ABCDE-FGHJK`]);
  const g = await fixture(t);
  await g.client.emailStart("person@company.test");
  g.verify = { status: 403, body: { error: "sso", errorDescription: "Your organization signs in with single sign-on." } };
  assert.deepEqual(await g.client.emailVerify(CODE), { outcome: "sso" });
  assert.equal(g.saved, null);
});

test("limits, an expired code and the Admin's refusals each come back as one plain outcome; an Admin without the route means the browser", async t => {
  const f = await fixture(t);
  f.start = { status: 429, body: { error: "rate_limited", errorDescription: "Too many codes were sent to that address. Try again later.", interval: 60 } };
  assert.deepEqual(await f.client.emailStart("person@example.test"), { outcome: "rate-limited" });
  f.start = { status: 404, body: { error: "unsupported", errorDescription: "Sign in on the Cloud page in your browser." } };
  assert.deepEqual(await f.client.emailStart("person@example.test"), { outcome: "browser" });
  f.start = { status: 404, body: "<!doctype html>Not found" };
  assert.deepEqual(await f.client.emailStart("person@example.test"), { outcome: "browser" });
  f.start = { status: 502, body: "<!doctype html>Bad gateway" };
  assert.deepEqual(await f.client.emailStart("person@example.test"), { outcome: "failed" });
  f.start = { status: 200, body: { cloudContractVersion: 1, attempt: "not-an-attempt", expiresIn: 600 } };
  assert.deepEqual(await f.client.emailStart("person@example.test"), { outcome: "failed" });
  const asked = f.requests.length;
  assert.deepEqual(await f.client.emailStart("not an email"), { outcome: "invalid-email" }); assert.equal(f.requests.length, asked);
  f.start = null;
  for (const [status, error, outcome] of [[410, "expired", "expired"], [403, "two_factor", "two-factor"], [403, "signup_closed", "signup-closed"],
    [403, "device_limit", "device-limit"], [429, "rate_limited", "rate-limited"]]) {
    await f.client.emailStart("person@example.test");
    f.verify = { status, body: { error, errorDescription: "x" } };
    assert.deepEqual(await f.client.emailVerify(CODE), { outcome }, error);
  }
  f.verify = null;
  await f.client.emailStart("person@example.test");
  f.now += 600_001;
  assert.deepEqual(await f.client.emailVerify(CODE), { outcome: "expired" }, "past its ten minutes: not asked");
  assert.equal(f.saved, null);
});

test("a refused Resend keeps the code already sent; a successful one replaces it; another address drops it", async t => {
  const f = await fixture(t);
  await f.client.emailStart("person@example.test");
  for (const refusal of [{ status: 429, body: { error: "rate_limited", errorDescription: "x", interval: 60 } }, { status: 502, body: "<!doctype html>Bad gateway" }]) {
    f.start = refusal;
    assert.notEqual((await f.client.emailStart("person@example.test")).outcome, "sent");
  }
  f.start = null;
  assert.equal((await f.client.emailVerify(CODE)).outcome, "signed-in", "the first code still works");
  const g = await fixture(t);
  await g.client.emailStart("person@example.test");
  g.start = { status: 429, body: { error: "rate_limited", errorDescription: "x", interval: 60 } };
  await g.client.emailStart("other@example.test");
  assert.deepEqual(await g.client.emailVerify(CODE), { outcome: "expired" }, "a code for another address is not this one's");
  assert.equal(g.requests.filter(row => row.route.endsWith("/verify")).length, 0);
});

test("cancelled while the code is checked: a token the Admin issued anyway is revoked, nothing is stored or signed in", async t => {
  const f = await fixture(t);
  await f.client.emailStart("person@example.test");
  let release = () => {};
  f.verifyGate = new Promise(resolve => { release = resolve; });
  const verifying = f.client.emailVerify(CODE);
  await until(() => f.requests.some(row => row.route.endsWith("/verify")));
  f.client.emailCancel();
  release();
  assert.deepEqual(await verifying, { outcome: "failed" });
  const revoked = f.requests.find(row => row.route === "/api/cloud/desktop/session" && row.method === "DELETE");
  assert.ok(revoked, "the issued token was revoked"); assert.equal(revoked.token, `Bearer ${accessToken}`);
  assert.equal(f.saved, null); assert.notEqual(f.client.state().status, "connected");
});

test("a token that cannot be stored is revoked and nothing is signed in; cancelling forgets the attempt", async t => {
  const f = await fixture(t);
  await f.client.emailStart("person@example.test");
  f.failWrite = true;
  assert.deepEqual(await f.client.emailVerify(CODE), { outcome: "failed" });
  await until(() => f.requests.some(row => row.route === "/api/cloud/desktop/session" && row.method === "DELETE"));
  assert.notEqual(f.client.state().status, "connected");
  const g = await fixture(t);
  await g.client.emailStart("person@example.test");
  g.client.emailCancel();
  assert.deepEqual(await g.client.emailVerify(CODE), { outcome: "expired" });
  assert.equal(g.requests.filter(row => row.route.endsWith("/verify")).length, 0);
});
