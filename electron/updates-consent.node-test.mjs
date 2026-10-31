import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createCloudAccountClient } from "./cloud-account.mjs";
import { createDesktopPrefs, registerDesktopPrefs } from "./desktop-prefs.mjs";
import { createUpdatesConsent, parseUpdatesConsent, registerUpdatesConsent, UPDATES_CONSENT_VERSION } from "./updates-consent.mjs";

// The real Cloud client and desktop prefs against a fake Admin on loopback: what this computer keeps, and what reaches
// the Admin's consent endpoints (account: GET/POST /api/cloud/desktop/updates-consent; no account: POST /api/updates-consent).
const accessToken = `omc_${"T".repeat(43)}`;
/** The fake Admin's receipt for an email-only opt-in: one per address, so a withdrawal shows which email it reached. */
const receiptOf = email => Buffer.from(email).toString("base64url").slice(0, 43).padEnd(43, "_");
const RECEIPT = receiptOf("person@example.test");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { for (let i = 0; i < 200; i++) { if (check()) return; await sleep(5); } assert.fail("did not reach the expected state"); }

async function world(t) {
  const f = { now: 1_800_000_000_000, approved: false, supported: true, down: false, account: null, accountId: "account-1", accessToken, requests: [], saved: null, timer: null, available: true, gate: null };
  const identity = () => ({ cloudContractVersion: 1, expiresAt: f.now + 86400_000, device: { id: "device-1" }, account: { id: f.accountId, email: "person@example.test" } });
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined, bearer = req.headers.authorization === `Bearer ${f.accessToken}`;
    const send = (status, data) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
    if (req.url === "/api/cloud/desktop/authorize") return send(201, { cloudContractVersion: 1, deviceCode: "A".repeat(43), userCode: "ABCDE-FGHJK",
      verificationUriComplete: `${f.origin}/cloud/desktop?code=ABCDE-FGHJK`, expiresIn: 600, interval: 5 });
    if (req.url === "/api/cloud/desktop/token") return f.approved ? send(200, { ...identity(), accessToken: f.accessToken }) : send(400, { error: "authorization_pending" });
    if (req.url === "/api/cloud/desktop/session" && bearer) return send(200, { ...identity(), entitlement: { plan: "free", status: "inactive", expiresAt: null, version: 0 }, cloud: null });
    if (req.url === "/api/cloud/desktop/updates-consent" || req.url === "/api/updates-consent") {
      f.requests.push({ method: req.method, path: req.url, bearer, body });
      const previous = f.account;
      await f.gate;
      if (f.down) return send(503, { error: "unavailable" });
      if (!f.supported) return send(404, { error: "Not found." });
      if (req.url === "/api/updates-consent") {
        if (body.status === "opted_in") {
          if (f.failOptIns > 0) { f.failOptIns--; return send(503, { error: "unavailable" }); }
          f.emails.set(body.email, "opted_in"); return send(200, { receipt: receiptOf(body.email) });
        }
        if (f.failWithdrawals > 0) { f.failWithdrawals--; return send(503, { error: "unavailable" }); }
        const email = [...f.emails.keys()].find(known => receiptOf(known) === body.receipt);
        if (!email) return send(404, { error: "unknown_receipt" });
        f.emails.set(email, body.status);
        return send(200, { ok: true });
      }
      if (!bearer) return send(401, { error: "invalid_token" });
      if (req.method === "POST" && f.failAccountPosts > 0) { f.failAccountPosts--; return send(503, { error: "unavailable" }); }
      if (req.method === "POST") f.account = { status: body.status, textVersion: body.textVersion, source: "desktop", decidedAt: f.now };
      return send(200, { cloudContractVersion: 1, consent: req.method === "GET" ? previous : f.account });
    }
    send(404, { error: "not_found" });
  });
  Object.assign(f, { failWithdrawals: 0, failOptIns: 0, emails: new Map() });
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

async function overtake(f, first, second) {
  let release; f.gate = new Promise(resolve => { release = resolve; });
  const sending = f.consent.choose(first);
  await until(() => f.requests.length === 1);
  const changing = f.consent.choose(second);
  await until(() => Object.entries(second).every(([key, value]) => f.saved.updatesConsent[key] === value));
  f.gate = null; release();
  await Promise.all([sending, changing]);
}

test("a new answer given while the previous one is still on its way wins on this computer and reaches the Admin", async t => {
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

test("a slow account A consent read cannot overwrite account B's withdrawal", async t => {
  const f = await world(t);
  f.saved = { updatesConsent: { status: "opted_in", version: UPDATES_CONSENT_VERSION, at: f.now, pending: true } };
  f.launch();
  await f.signInNow();
  const held = Promise.withResolvers();
  t.after(() => held.resolve());
  f.gate = held.promise;
  const syncing = f.consent.sync();
  await until(() => f.requests.length === 1);
  await f.client.signOut();
  f.accountId = "account-2";
  f.accessToken = `omc_${"B".repeat(43)}`;
  f.account = { status: "withdrawn", textVersion: UPDATES_CONSENT_VERSION, source: "cloud_page", decidedAt: f.now };
  await f.signInNow();
  f.gate = null;
  held.resolve();
  await syncing;
  assert.equal(f.account.status, "withdrawn");
  assert.deepEqual(f.requests.map(({ method }) => method), ["GET", "GET"]);
  assert.deepEqual(f.saved.updatesConsent, { status: "withdrawn", version: UPDATES_CONSENT_VERSION, at: f.now, account: "account-2" });
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
  assert.deepEqual(parseUpdatesConsent({ status: "withdrawn", version: "2026-10-23", at: 5, replacedReceipts: [RECEIPT, "short", 7, RECEIPT] }),
    { status: "withdrawn", version: "2026-10-23", at: 5, replacedReceipts: [RECEIPT] });
  assert.deepEqual(parseUpdatesConsent({ status: "withdrawn", version: "2026-10-23", at: 5, replacedReceipts: RECEIPT }), { status: "withdrawn", version: "2026-10-23", at: 5 });
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

test("signed out, an overtaken email is withdrawn before its replacement even after a failed withdrawal", async t => {
  const h = await world(t);
  await overtake(h, { status: "opted_in", email: "old@example.test" }, { status: "opted_in", email: "new@example.test" });
  assert.deepEqual(h.requests.map(request => request.body), [
    { status: "opted_in", email: "old@example.test", installId: h.saved.installId, textVersion: UPDATES_CONSENT_VERSION },
    { status: "withdrawn", receipt: receiptOf("old@example.test") },
    { status: "opted_in", email: "new@example.test", installId: h.saved.installId, textVersion: UPDATES_CONSENT_VERSION }]);
  assert.deepEqual(h.saved.updatesConsent, { status: "opted_in", version: UPDATES_CONSENT_VERSION, at: h.now, email: "new@example.test", receipt: receiptOf("new@example.test") });

  // A failed withdrawal keeps the earlier receipt, and the next launch withdraws it before the new email is sent.
  const k = await world(t);
  k.failWithdrawals = 2;
  await overtake(k, { status: "opted_in", email: "old@example.test" }, { status: "opted_in", email: "new@example.test" });
  assert.deepEqual(k.saved.updatesConsent, { status: "opted_in", version: UPDATES_CONSENT_VERSION, at: k.now, email: "new@example.test", replacedReceipts: [receiptOf("old@example.test")], receiptEmails: { [receiptOf("old@example.test")]: "old@example.test" }, pending: true });
  k.launch();
  await k.consent.sync();
  assert.deepEqual(k.requests.map(request => request.body), [
    { status: "opted_in", email: "old@example.test", installId: k.saved.installId, textVersion: UPDATES_CONSENT_VERSION },
    { status: "withdrawn", receipt: receiptOf("old@example.test") },
    { status: "withdrawn", receipt: receiptOf("old@example.test") },
    { status: "withdrawn", receipt: receiptOf("old@example.test") },
    { status: "opted_in", email: "new@example.test", installId: k.saved.installId, textVersion: UPDATES_CONSENT_VERSION }]);
  assert.deepEqual(k.saved.updatesConsent, { status: "opted_in", version: UPDATES_CONSENT_VERSION, at: k.now, email: "new@example.test", receipt: receiptOf("new@example.test") });
});

test("signed out, the same email opts in again: a failed submission keeps the active opt-in and its receipt", async t => {
  for (const email of [" Person@Example.TEST ", undefined]) await t.test(email ?? "saved email", async t => {
    const f = await world(t);
    await f.consent.choose({ status: "opted_in", email: "person@example.test" });
    f.failOptIns = 1;
    await f.consent.choose({ status: "opted_in", email });
    assert.equal(f.emails.get("person@example.test"), "opted_in");
    assert.deepEqual(f.saved.updatesConsent, { status: "opted_in", version: UPDATES_CONSENT_VERSION, at: f.now,
      email: "person@example.test", receipt: RECEIPT, pending: true });
    f.launch();
    await f.consent.sync();
    assert.equal(f.saved.updatesConsent.pending, undefined);
    assert.deepEqual(f.requests.map(request => request.body), Array(3).fill({ status: "opted_in",
      email: "person@example.test", installId: f.saved.installId, textVersion: UPDATES_CONSENT_VERSION }));
    await f.consent.choose({ status: "withdrawn" });
    assert.equal(f.emails.get("person@example.test"), "withdrawn");
  });
});

test("signed out, an overlapping same-email opt-in keeps the active receipt when the final submission fails", async t => {
  for (const email of [" Person@Example.TEST ", undefined]) await t.test(email ?? "saved email", async t => {
    const f = await world(t);
    await f.consent.choose({ status: "opted_in", email: "person@example.test" });
    const repeated = Promise.withResolvers(), final = Promise.withResolvers();
    t.after(() => { repeated.resolve(); final.resolve(); });
    f.gate = repeated.promise;
    const sending = f.consent.choose({ status: "opted_in", email: "person@example.test" });
    await until(() => f.requests.length === 2);
    f.now++;
    const changing = f.consent.choose({ status: "opted_in", email });
    await until(() => f.saved.updatesConsent.at === f.now);
    f.gate = final.promise;
    repeated.resolve();
    await until(() => f.requests.length === 3);
    f.failOptIns = 1;
    f.gate = null;
    final.resolve();
    await Promise.all([sending, changing]);
    assert.equal(f.emails.get("person@example.test"), "opted_in");
    assert.deepEqual(f.saved.updatesConsent, { status: "opted_in", version: UPDATES_CONSENT_VERSION, at: f.now,
      email: "person@example.test", receipt: RECEIPT, pending: true });
    assert.deepEqual(f.requests.map(request => request.body.status), ["opted_in", "opted_in", "opted_in"]);
    f.launch();
    await f.consent.sync();
    assert.equal(f.saved.updatesConsent.pending, undefined);
    await f.consent.choose({ status: "withdrawn" });
    assert.equal(f.emails.get("person@example.test"), "withdrawn");
  });
});

test("signed out, opting back in to the same email retries a pending withdrawal before subscribing", async t => {
  const f = await world(t);
  await f.consent.choose({ status: "opted_in", email: "person@example.test" });
  f.failWithdrawals = 1;
  await f.consent.choose({ status: "withdrawn" });
  assert.equal(f.saved.updatesConsent.pending, true);
  await f.consent.choose({ status: "opted_in", email: "person@example.test" });
  assert.deepEqual(f.requests.map(request => request.body.status), ["opted_in", "withdrawn", "withdrawn", "opted_in"]);
  assert.equal(f.emails.get("person@example.test"), "opted_in");
  assert.equal(f.saved.updatesConsent.pending, undefined);
  assert.equal(f.saved.updatesConsent.receipt, RECEIPT);
});

test("signed out, a new email chosen later: the earlier email is withdrawn before the new one is sent", async t => {
  const f = await world(t);
  await f.consent.choose({ status: "opted_in", email: "old@example.test" });
  await f.consent.choose({ status: "opted_in", email: "new@example.test" });
  assert.deepEqual(Object.fromEntries(f.emails), { "old@example.test": "withdrawn", "new@example.test": "opted_in" });
  assert.deepEqual(f.saved.updatesConsent, { status: "opted_in", version: UPDATES_CONSENT_VERSION, at: f.now, email: "new@example.test", receipt: receiptOf("new@example.test") });
});

test("signed out, offline: a withdrawal not sent yet still reaches the Admin when a new email follows it", async t => {
  const f = await world(t);
  await f.consent.choose({ status: "opted_in", email: "old@example.test" });
  f.down = true;
  await f.consent.choose({ status: "withdrawn" });
  await f.consent.choose({ status: "opted_in", email: "new@example.test" });
  f.down = false;
  f.launch();
  await f.consent.sync();
  assert.deepEqual(Object.fromEntries(f.emails), { "old@example.test": "withdrawn", "new@example.test": "opted_in" });
  assert.deepEqual(f.saved.updatesConsent, { status: "opted_in", version: UPDATES_CONSENT_VERSION, at: f.now, email: "new@example.test", receipt: receiptOf("new@example.test") });
});

test("an email-only opt-in is withdrawn once the person signs in and the account holds the answer", async t => {
  const f = await world(t);
  await f.consent.choose({ status: "opted_in", email: "old@example.test" });
  await f.signInNow();
  await f.consent.sync();
  assert.equal(f.account.status, "opted_in", "an account without an answer gets this computer's");
  assert.deepEqual(Object.fromEntries(f.emails), { "old@example.test": "withdrawn" });
  assert.deepEqual(f.saved.updatesConsent, { status: "opted_in", version: UPDATES_CONSENT_VERSION, at: f.now, account: "account-1", email: "old@example.test" });

  const g = await world(t);
  await g.consent.choose({ status: "opted_in", email: "old@example.test" });
  g.account = { status: "declined", textVersion: "2026-10-23", source: "cloud_page", decidedAt: g.now };
  await g.signInNow();
  await g.consent.sync();
  assert.deepEqual(Object.fromEntries(g.emails), { "old@example.test": "withdrawn" }, "an account's own answer replaces it too");
  assert.equal(g.saved.updatesConsent.status, "declined");
});

test("a matching account answer queues an older email receipt until its withdrawal succeeds", async t => {
  for (const status of ["opted_in", "declined", "withdrawn"]) await t.test(status, async t => {
    const f = await world(t);
    await f.consent.choose({ status: "opted_in", email: "old@example.test" });
    f.prefs.setUpdatesConsent({ ...f.saved.updatesConsent, status, account: "account-1" });
    f.account = { status, textVersion: "2026-10-24", source: "cloud_page", decidedAt: f.now };
    await f.signInNow();
    f.now++;
    f.failWithdrawals = 1;
    await assert.rejects(f.consent.sync(), /Cloud request failed/);
    assert.equal(f.emails.get("old@example.test"), "opted_in");
    assert.deepEqual(f.saved.updatesConsent, { status, version: "2026-10-24", at: f.now,
      account: "account-1", email: "old@example.test", replacedReceipts: [receiptOf("old@example.test")], receiptEmails: { [receiptOf("old@example.test")]: "old@example.test" } });
    f.launch();
    await f.consent.sync();
    assert.equal(f.emails.get("old@example.test"), "withdrawn");
    assert.equal(f.saved.updatesConsent.replacedReceipts, undefined);
    assert.deepEqual(f.requests.filter(request => request.method === "POST").map(request => request.body), [
      { status: "opted_in", email: "old@example.test", installId: f.saved.installId, textVersion: UPDATES_CONSENT_VERSION },
      { status: "withdrawn", receipt: receiptOf("old@example.test") },
      { status: "withdrawn", receipt: receiptOf("old@example.test") }]);
  });
});

test("signing in while an email opt-in is on its way: an answer given on the account still withdraws the email", async t => {
  const f = await world(t);
  let release; f.gate = new Promise(resolve => { release = resolve; });
  const sending = f.consent.choose({ status: "opted_in", email: "old@example.test" });
  await until(() => f.requests.length === 1);
  await f.signInNow();
  const changing = f.consent.choose({ status: "declined" });
  await until(() => f.saved.updatesConsent.status === "declined");
  f.gate = null; release();
  await Promise.all([sending, changing]);
  await f.consent.sync();
  assert.equal(f.account.status, "declined");
  assert.deepEqual(Object.fromEntries(f.emails), { "old@example.test": "withdrawn" });
  assert.equal(f.saved.updatesConsent.pending, undefined);
});

test("an account without a choice never inherits another account's answer", async t => {
  for (const status of ["opted_in", "declined", "withdrawn"]) for (const pending of [false, true])
    await t.test(`${status}, pending=${pending}`, async t => {
      const f = await world(t);
      await f.signInNow();
      f.down = pending;
      await f.consent.choose({ status });
      f.down = false;
      const accountAnswer = structuredClone(f.saved.updatesConsent);
      await f.client.signOut();
      f.accountId = "account-2";
      f.accessToken = `omc_${"B".repeat(43)}`;
      f.account = null;
      await f.signInNow();
      const first = f.requests.length;
      for (const restart of [false, true]) {
        if (restart) f.launch();
        const state = await f.consent.state();
        assert.equal(f.account, null, "no answer is posted on behalf of the new account");
        assert.equal(state.due, true);
        assert.equal(state.status, null);
        assert.deepEqual(f.saved.updatesConsent, accountAnswer, "the other account's answer is preserved");
      }
      assert.deepEqual(f.requests.slice(first).map(({ method }) => method), ["GET", "GET"]);
      await f.consent.choose({ status: "withdrawn" });
      assert.equal(f.account.status, "withdrawn");
      assert.equal(f.saved.updatesConsent.account, "account-2");
    });
});

test("signed out, returning to an email while its repeated opt-in is in flight never withdraws the active receipt", async t => {
  for (const failures of [1, 0]) await t.test(`final opt-in failures=${failures}`, async t => {
    const f = await world(t);
    await f.consent.choose({ status: "opted_in", email: "person@example.test" });
    const repeated = Promise.withResolvers(), final = Promise.withResolvers();
    t.after(() => { repeated.resolve(); final.resolve(); });
    f.gate = repeated.promise;
    const sending = f.consent.choose({ status: "opted_in", email: "person@example.test" });
    await until(() => f.requests.length === 2);
    const replacing = f.consent.choose({ status: "opted_in", email: "other@example.test" });
    await until(() => f.saved.updatesConsent.email === "other@example.test");
    const returning = f.consent.choose({ status: "opted_in", email: "person@example.test" });
    await until(() => f.saved.updatesConsent.email === "person@example.test");
    f.gate = final.promise;
    repeated.resolve();
    await until(() => f.requests.length === 3);
    f.failOptIns = failures;
    f.gate = null;
    final.resolve();
    await Promise.all([sending, replacing, returning]);
    assert.equal(f.emails.get("person@example.test"), "opted_in");
    assert.deepEqual(f.requests.map(request => request.body.status), ["opted_in", "opted_in", "opted_in"]);
    assert.deepEqual(f.saved.updatesConsent, { status: "opted_in", version: UPDATES_CONSENT_VERSION, at: f.now,
      email: "person@example.test", receipt: RECEIPT, ...(failures ? { pending: true } : {}) });
    f.launch();
    await f.consent.sync();
    assert.equal(f.emails.get("person@example.test"), "opted_in");
    assert.equal(f.saved.updatesConsent.pending, undefined);
    assert.equal(f.requests.some(request => request.body.status === "withdrawn"), false);
    await f.consent.choose({ status: "withdrawn" });
    assert.equal(f.emails.get("person@example.test"), "withdrawn");
  });
});

test("an unanswered account withdraws another account's retained email receipt without inheriting its answer", async t => {
  for (const status of ["opted_in", "declined", "withdrawn"]) for (const pending of [false, true])
    await t.test(`${status}, pending=${pending}`, async t => {
      const f = await world(t);
      await f.consent.choose({ status: "opted_in", email: "old@example.test" });
      const ownerAnswer = { status, version: UPDATES_CONSENT_VERSION, at: f.now, account: "account-1",
        email: "old@example.test", ...(pending ? { pending: true } : {}) };
      f.prefs.setUpdatesConsent({ ...ownerAnswer, receipt: receiptOf("old@example.test") });
      f.accountId = "account-2";
      f.accessToken = `omc_${"B".repeat(43)}`;
      await f.signInNow();
      const held = Promise.withResolvers();
      t.after(() => held.resolve());
      f.gate = held.promise;
      const syncing = f.consent.sync().catch(error => error);
      await until(() => f.requests.length === 2);
      assert.equal(f.requests[1].method, "GET");
      f.failWithdrawals = 1;
      f.gate = null;
      held.resolve();
      await syncing;
      assert.equal(f.account, null);
      assert.equal(f.emails.get("old@example.test"), "opted_in");
      const afterFailure = structuredClone(f.saved.updatesConsent);
      f.launch();
      await f.consent.sync();
      assert.equal(f.emails.get("old@example.test"), "withdrawn");
      assert.deepEqual(afterFailure, { ...ownerAnswer, replacedReceipts: [receiptOf("old@example.test")], receiptEmails: { [receiptOf("old@example.test")]: "old@example.test" } });
      assert.deepEqual(f.saved.updatesConsent, ownerAnswer);
      const state = await f.consent.state();
      assert.equal(state.due, true);
      assert.equal(state.status, null);
      assert.equal(f.account, null);
      assert.deepEqual(f.requests.filter(request => request.path === "/api/cloud/desktop/updates-consent").map(request => request.method), ["GET", "GET", "GET"]);
      assert.deepEqual(f.requests.filter(request => request.method === "POST").map(request => request.body), [
        { status: "opted_in", email: "old@example.test", installId: f.saved.installId, textVersion: UPDATES_CONSENT_VERSION },
        { status: "withdrawn", receipt: receiptOf("old@example.test") },
        { status: "withdrawn", receipt: receiptOf("old@example.test") }]);
    });
});

test("a failed account withdrawal survives another account's answer and restarts until its owner retries", async t => {
  for (const choice of [null, "opted_in"]) await t.test(choice ?? "read only", async t => {
    const f = await world(t);
    await f.signInNow();
    await f.consent.choose({ status: "opted_in" });
    const original = structuredClone(f.account), held = Promise.withResolvers();
    t.after(() => held.resolve());
    const first = f.requests.length;
    f.gate = held.promise;
    const withdrawing = f.consent.choose({ status: "withdrawn" });
    await until(() => f.requests.length === first + 1);
    await f.client.signOut();
    f.accountId = "account-2";
    f.accessToken = `omc_${"B".repeat(43)}`;
    f.account = { status: "declined", textVersion: UPDATES_CONSENT_VERSION, source: "cloud_page", decidedAt: f.now };
    await f.signInNow();
    f.failAccountPosts = 1;
    f.gate = null;
    held.resolve();
    await withdrawing;
    assert.deepEqual(f.requests.slice(first).map(({ method }) => method), ["POST", "GET"]);
    assert.equal(f.account.status, "declined");
    assert.equal((await f.consent.state()).status, "declined");
    if (choice) {
      f.failAccountPosts = 1;
      await f.consent.choose({ status: choice });
      assert.equal(f.account.status, "declined");
    }
    f.launch();
    await f.consent.sync();
    assert.equal(f.account.status, choice ?? "declined");
    await f.client.signOut();
    f.accountId = "account-1";
    f.accessToken = accessToken;
    f.account = original;
    await f.signInNow();
    f.failAccountPosts = 1;
    await assert.rejects(f.consent.sync(), /Cloud request failed/);
    f.launch();
    const retry = f.requests.length;
    f.consent.accountChanged(f.client.state());
    await f.consent.sync();
    assert.equal(f.account.status, "withdrawn");
    assert.deepEqual(f.requests.slice(retry).map(({ method, body }) => ({ method, body })), [
      { method: "POST", body: { status: "withdrawn", textVersion: UPDATES_CONSENT_VERSION } }]);
    assert.equal(f.saved.updatesConsent.pending, undefined);
  });
});

test("signed out, returning to a queued email after restart never withdraws its active opt-in when resubmission fails", async t => {
  for (const legacy of [false, true]) await t.test(`legacy queue=${legacy}`, async t => {
    const f = await world(t);
    await f.consent.choose({ status: "opted_in", email: "person@example.test" });
    f.failWithdrawals = 1;
    await f.consent.choose({ status: "opted_in", email: "other@example.test" });
    assert.equal(f.emails.get("person@example.test"), "opted_in");
    assert.equal(f.saved.updatesConsent.pending, true);
    if (legacy) delete f.saved.updatesConsent.receiptEmails;
    f.launch();
    const held = Promise.withResolvers(), first = f.requests.length;
    t.after(() => held.resolve());
    f.gate = held.promise;
    const returning = f.consent.choose({ status: "opted_in", email: " Person@Example.TEST " });
    await until(() => f.requests.length === first + 1);
    f.failOptIns = 1;
    f.gate = null;
    held.resolve();
    await returning;
    assert.equal(f.emails.get("person@example.test"), "opted_in");
    assert.deepEqual(f.saved.updatesConsent, { status: "opted_in", version: UPDATES_CONSENT_VERSION, at: f.now,
      email: "person@example.test", ...(legacy ? { replacedReceipts: [RECEIPT] } : { receipt: RECEIPT }), pending: true });
    assert.deepEqual(f.requests.slice(first).map(request => request.body.status), ["opted_in"]);
    f.launch();
    await f.consent.sync();
    assert.equal(f.emails.get("person@example.test"), "opted_in");
    assert.equal(f.saved.updatesConsent.pending, undefined);
    await f.consent.choose({ status: "withdrawn" });
    assert.equal(f.emails.get("person@example.test"), "withdrawn");
  });
});

test("a successful account post clears its pending choice even if another account is current", async t => {
  for (const answerOnB of [false, true]) await t.test(`answer on B=${answerOnB}`, async t => {
    let saved = null, current = "account-1";
    const statuses = new Map([["account-1", "opted_in"], ["account-2", "declined"]]), sent = [];
    const held = Promise.withResolvers();
    t.after(() => held.resolve());
    const client = {
      state: () => ({ status: "connected", account: { id: current, email: "person@example.test" } }),
      async updatesConsent() {
        sent.push({ method: "GET", account: current });
        return { cloudContractVersion: 1, consent: { status: statuses.get(current), textVersion: UPDATES_CONSENT_VERSION } };
      },
      async recordUpdatesConsent(status) {
        const account = current;
        sent.push({ method: "POST", account, status });
        if (account === "account-1" && status === "withdrawn") await held.promise;
        statuses.set(account, status);
      },
    };
    const prefs = createDesktopPrefs({ read: () => saved, write: value => { saved = structuredClone(value); } });
    const consent = createUpdatesConsent({ prefs, account: () => client, available: () => true });
    await consent.choose({ status: "opted_in" });
    const withdrawing = consent.choose({ status: "withdrawn" });
    await until(() => sent.length === 2);
    current = "account-2";
    const changing = answerOnB ? consent.choose({ status: "opted_in" }) : null;
    if (changing) await until(() => saved.updatesConsent.account === current);
    held.resolve();
    await Promise.all([withdrawing, changing]);
    statuses.set("account-1", "opted_in");
    current = "account-1";
    const first = sent.length;
    await consent.sync();
    assert.equal(statuses.get("account-1"), "opted_in");
    assert.deepEqual(sent.slice(first), [{ method: "GET", account: "account-1" }]);
  });
});
