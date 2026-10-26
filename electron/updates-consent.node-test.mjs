import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createCloudAccountClient } from "./cloud-account.mjs";
import { createDesktopPrefs, registerDesktopPrefs } from "./desktop-prefs.mjs";
import { createUpdatesConsent, parseUpdatesConsent, registerUpdatesConsent, UPDATES_CONSENT_VERSION } from "./updates-consent.mjs";

// The real Cloud client and desktop prefs against a fake Admin on loopback: what this computer keeps, and what reaches
// the Admin's consent endpoints (account: GET/POST /api/cloud/desktop/updates-consent; no account: POST /api/updates-consent).
const accessToken = `omc_${"T".repeat(43)}`;
const RECEIPT = "R".repeat(43);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { for (let i = 0; i < 200; i++) { if (check()) return; await sleep(5); } assert.fail("did not reach the expected state"); }

async function world(t) {
  const f = { now: 1_800_000_000_000, approved: false, supported: true, down: false, account: null, requests: [], saved: null, timer: null, available: true, gate: null };
  const identity = () => ({ cloudContractVersion: 1, expiresAt: f.now + 86400_000, device: { id: "device-1" }, account: { id: "account-1", email: "person@example.test" } });
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined, bearer = req.headers.authorization === `Bearer ${accessToken}`;
    const send = (status, data) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
    if (req.url === "/api/cloud/desktop/authorize") return send(201, { cloudContractVersion: 1, deviceCode: "A".repeat(43), userCode: "ABCDE-FGHJK",
      verificationUriComplete: `${f.origin}/cloud/desktop?code=ABCDE-FGHJK`, expiresIn: 600, interval: 5 });
    if (req.url === "/api/cloud/desktop/token") return f.approved ? send(200, { ...identity(), accessToken }) : send(400, { error: "authorization_pending" });
    if (req.url === "/api/cloud/desktop/session" && bearer) return send(200, { ...identity(), entitlement: { plan: "free", status: "inactive", expiresAt: null, version: 0 }, cloud: null });
    if (req.url === "/api/cloud/desktop/updates-consent" || req.url === "/api/updates-consent") {
      f.requests.push({ method: req.method, path: req.url, bearer, body });
      await f.gate;
      if (f.down) return send(503, { error: "unavailable" });
      if (!f.supported) return send(404, { error: "Not found." });
      if (req.url === "/api/updates-consent") {
        if (body.status === "opted_in") return send(200, { receipt: RECEIPT });
        return body.receipt === RECEIPT ? send(200, { ok: true }) : send(404, { error: "unknown_receipt" });
      }
      if (!bearer) return send(401, { error: "invalid_token" });
      if (req.method === "POST") f.account = { status: body.status, textVersion: body.textVersion, source: "desktop", decidedAt: f.now };
      return send(200, { cloudContractVersion: 1, consent: f.account });
    }
    send(404, { error: "not_found" });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  f.origin = `http://127.0.0.1:${server.address().port}`;
  f.client = createCloudAccountClient({ origin: f.origin, fixture: true, deviceName: "Fixture computer", platform: "darwin", appVersion: "0.1.125", now: () => f.now,
    store: { read: async () => f.signIn ?? null, write: async value => { f.signIn = structuredClone(value); } }, openBrowser: async () => {},
    setTimer: callback => { f.timer = callback; return 1; }, clearTimer: () => { f.timer = null; } });
  /** A launch of the app: its prefs read from the saved file, and the consent over them. */
  f.launch = () => {
    f.prefs = createDesktopPrefs({ read: () => f.saved, write: value => { f.saved = structuredClone(value); }, now: () => f.now });
    f.consent = createUpdatesConsent({ prefs: f.prefs, account: () => f.client, available: async () => f.available, now: () => f.now });
    return f.consent;
  };
  f.signInNow = async () => {
    await f.client.begin(); f.approved = true;
    const tick = f.timer; f.timer = null; tick();
    await until(() => f.client.state().status === "connected");
  };
  f.launch();
  t.after(async () => { f.client.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return f;
}

test("signed out: asked once; No thanks is kept on this computer, never asked again after a restart, and nothing is sent", async t => {
  const f = await world(t);
  assert.deepEqual(await f.consent.state(), { available: true, due: true, status: null, signedIn: false, email: null, version: UPDATES_CONSENT_VERSION });
  const answered = await f.consent.choose({ status: "declined" });
  assert.equal(answered.due, false); assert.equal(answered.status, "declined");
  assert.deepEqual(f.requests, [], "a no-account No thanks has nothing to send");
  assert.deepEqual(f.saved.updatesConsent, { status: "declined", version: UPDATES_CONSENT_VERSION, at: f.now });
  f.launch();
  assert.equal((await f.consent.state()).due, false, "never asked again on this computer");
});

test("signed out with an email: Yes goes to the no-account endpoint with the text version and this install's id; turning it off withdraws with the receipt", async t => {
  const f = await world(t);
  await assert.rejects(f.consent.choose({ status: "opted_in", email: "not an email" }), /valid email/);
  assert.equal(f.saved?.updatesConsent, undefined, "nothing kept for a refused address");
  const answered = await f.consent.choose({ status: "opted_in", email: " Person@Example.TEST " });
  assert.deepEqual(answered, { available: true, due: false, status: "opted_in", signedIn: false, email: "person@example.test", version: UPDATES_CONSENT_VERSION });
  const installId = f.saved.installId;
  assert.match(installId, /^[A-Za-z0-9_-]{32}$/);
  assert.deepEqual(f.requests, [{ method: "POST", path: "/api/updates-consent", bearer: false,
    body: { status: "opted_in", email: "person@example.test", installId, textVersion: UPDATES_CONSENT_VERSION } }]);
  assert.deepEqual(f.saved.updatesConsent, { status: "opted_in", version: UPDATES_CONSENT_VERSION, at: f.now, email: "person@example.test", receipt: RECEIPT });
  const off = await f.consent.choose({ status: "withdrawn" });
  assert.equal(off.status, "withdrawn"); assert.equal(off.email, null);
  assert.deepEqual(f.requests.at(-1), { method: "POST", path: "/api/updates-consent", bearer: false, body: { status: "withdrawn", receipt: RECEIPT } });
  assert.equal(f.saved.updatesConsent.pending, undefined);
});

test("an Admin without the endpoints (404) or down: the answer stays here as pending and is sent on a later launch", async t => {
  const f = await world(t);
  f.supported = false;
  const answered = await f.consent.choose({ status: "opted_in", email: "person@example.test" });
  assert.equal(answered.status, "opted_in"); assert.equal(answered.due, false, "never asked twice because the Admin was missing");
  assert.equal(f.saved.updatesConsent.pending, true);
  assert.equal(f.saved.updatesConsent.receipt, undefined);
  f.launch(); f.down = true;
  await f.consent.sync().catch(() => {});
  assert.equal(f.saved.updatesConsent.pending, true, "a 503 keeps it pending too");
  f.launch(); f.down = false; f.supported = true;
  assert.equal((await f.consent.state()).due, false);
  assert.equal(f.saved.updatesConsent.pending, undefined);
  assert.equal(f.saved.updatesConsent.receipt, RECEIPT);
  assert.deepEqual(f.requests.filter(request => request.path === "/api/updates-consent").map(request => request.body.email), ["person@example.test", "person@example.test", "person@example.test"]);
});

test("signed in: one tap is recorded on the account, and the account's own answer (from the Cloud page) means no question here", async t => {
  const f = await world(t);
  await f.signInNow();
  assert.deepEqual(await f.consent.state(), { available: true, due: true, status: null, signedIn: true, email: "person@example.test", version: UPDATES_CONSENT_VERSION });
  await assert.rejects(f.consent.choose({ status: "subscribed" }), /opted_in, declined or withdrawn/);
  const answered = await f.consent.choose({ status: "opted_in", email: "ignored@example.test" });
  assert.deepEqual(answered, { available: true, due: false, status: "opted_in", signedIn: true, email: "person@example.test", version: UPDATES_CONSENT_VERSION });
  assert.deepEqual(f.requests.filter(request => request.method === "POST"), [{ method: "POST", path: "/api/cloud/desktop/updates-consent", bearer: true,
    body: { status: "opted_in", textVersion: UPDATES_CONSENT_VERSION } }]);
  assert.deepEqual(f.saved.updatesConsent, { status: "opted_in", version: UPDATES_CONSENT_VERSION, at: f.now, account: "account-1" });

  // Another computer, the same account, which answered on the Cloud page: nothing is asked, and its answer shows here.
  f.saved = null; f.account = { status: "withdrawn", textVersion: "2026-10-23", source: "cloud_page", decidedAt: f.now };
  f.launch();
  assert.deepEqual(await f.consent.state(), { available: true, due: false, status: "withdrawn", signedIn: true, email: "person@example.test", version: UPDATES_CONSENT_VERSION });
});

test("an answer given while signed out is carried over to an account that has none, with no second question", async t => {
  const f = await world(t);
  await f.consent.choose({ status: "opted_in" });
  assert.deepEqual(f.requests, [], "Yes without an email waits for an account");
  await f.signInNow();
  f.consent.accountChanged(f.client.state());
  await until(() => f.account !== null);
  assert.deepEqual(f.requests.filter(request => request.method === "POST").map(request => request.body), [{ status: "opted_in", textVersion: UPDATES_CONSENT_VERSION }]);
  assert.equal((await f.consent.state()).due, false);
  assert.equal(f.saved.updatesConsent.account, "account-1");
  // An account that already answered keeps its own answer.
  const g = await world(t);
  await g.consent.choose({ status: "declined" });
  g.account = { status: "opted_in", textVersion: "2026-10-23", source: "cloud_page", decidedAt: g.now };
  await g.signInNow();
  assert.equal((await g.consent.state()).status, "opted_in");
  assert.deepEqual(g.requests.filter(request => request.method === "POST"), []);
});

test("a new answer given while the previous one is still on its way wins on this computer and reaches the Admin", async t => {
  /** Holds the Admin's reply to the first answer until the second answer is saved here. */
  const overtake = async (f, first, second) => {
    let release; f.gate = new Promise(resolve => { release = resolve; });
    const sending = f.consent.choose(first);
    await until(() => f.requests.length === 1);
    const changing = f.consent.choose(second);
    await until(() => f.saved.updatesConsent.status === second.status);
    f.gate = null; release();
    await Promise.all([sending, changing]);
  };
  const f = await world(t);
  await f.signInNow();
  await overtake(f, { status: "opted_in" }, { status: "withdrawn" });
  assert.deepEqual(f.requests.filter(request => request.method === "POST").map(request => request.body),
    [{ status: "opted_in", textVersion: UPDATES_CONSENT_VERSION }, { status: "withdrawn", textVersion: UPDATES_CONSENT_VERSION }]);
  assert.equal(f.account.status, "withdrawn");
  assert.deepEqual(f.saved.updatesConsent, { status: "withdrawn", version: UPDATES_CONSENT_VERSION, at: f.now, account: "account-1" });

  // Signed out: the receipt that arrives for the earlier Yes is what withdraws it.
  const g = await world(t);
  await overtake(g, { status: "opted_in", email: "person@example.test" }, { status: "withdrawn" });
  assert.deepEqual(g.requests.map(request => request.body), [
    { status: "opted_in", email: "person@example.test", installId: g.saved.installId, textVersion: UPDATES_CONSENT_VERSION },
    { status: "withdrawn", receipt: RECEIPT }]);
  assert.deepEqual(g.saved.updatesConsent, { status: "withdrawn", version: UPDATES_CONSENT_VERSION, at: g.now, email: "person@example.test", receipt: RECEIPT });
});

test("nothing is asked or sent where it isn't available: a branded build, or no Cloud sign-in in this app", async t => {
  const f = await world(t);
  f.available = false;
  assert.deepEqual(await f.consent.state(), { available: false, due: false, status: null, signedIn: false, email: null, version: UPDATES_CONSENT_VERSION });
  await assert.rejects(f.consent.choose({ status: "opted_in", email: "person@example.test" }), /not available/);
  await f.consent.sync();
  assert.deepEqual(f.requests, []);
  const none = createUpdatesConsent({ prefs: createDesktopPrefs({ read: () => null, write: () => {} }), account: () => null, available: async () => true });
  assert.equal((await none.state()).available, false);
});

test("the record on disk: only a whole, known answer is kept", () => {
  for (const value of [null, "opted_in", [], { status: "subscribed", version: "2026-10-23", at: 1 }, { status: "opted_in", version: "", at: 1 }, { status: "declined", version: "2026-10-23", at: -1 }])
    assert.equal(parseUpdatesConsent(value), null, JSON.stringify(value));
  assert.deepEqual(parseUpdatesConsent({ status: "opted_in", version: "2026-10-23", at: 5, email: "a@b.test", receipt: "short", account: "x\n", pending: "yes", extra: 1 }),
    { status: "opted_in", version: "2026-10-23", at: 5, email: "a@b.test" });
  let saved = null;
  const prefs = createDesktopPrefs({ read: () => saved, write: value => { saved = structuredClone(value); } });
  assert.equal(prefs.setUpdatesConsent({ status: "maybe" }), false);
  assert.equal(saved, null);
  const id = prefs.installId();
  assert.equal(prefs.installId(), id, "one id per install");
  assert.equal(createDesktopPrefs({ read: () => saved, write: () => {} }).installId(), id, "kept across launches");
});

test("only this computer's page and My Cloud's own page may ask or answer; main wires it through the desktop prefs", async () => {
  const handlers = new Map(), calls = [];
  const consent = { state: async () => { calls.push("state"); return { due: true }; }, choose: async choice => { calls.push(choice); return { due: false }; } };
  registerUpdatesConsent({ ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }, page: event => event.page, consent });
  assert.deepEqual([...handlers.keys()], ["updates-consent:state", "updates-consent:choose"]);
  for (const page of ["server", null]) {
    await assert.rejects(async () => handlers.get("updates-consent:state")({ page }), /only available in this app's window/);
    await assert.rejects(async () => handlers.get("updates-consent:choose")({ page }, { status: "opted_in" }), /only available/);
  }
  assert.deepEqual(await handlers.get("updates-consent:state")({ page: "local" }), { due: true });
  assert.deepEqual(await handlers.get("updates-consent:choose")({ page: "cloud" }, { status: "declined" }), { due: false });
  assert.deepEqual(calls, ["state", { status: "declined" }]);

  const channels = new Set();
  const ipcMain = { handle: channel => channels.add(channel), on: channel => channels.add(channel) };
  const base = { ipcMain, read: () => null, write: () => {}, page: () => "local", cloudOffered: async () => false };
  assert.equal(registerDesktopPrefs(base), null, "no Cloud client: no question");
  assert.equal(channels.has("updates-consent:state"), false);
  const wired = registerDesktopPrefs({ ...base, cloudAccount: () => null });
  assert.equal(typeof wired.accountChanged, "function");
  assert.ok(channels.has("updates-consent:state") && channels.has("updates-consent:choose"));
});
