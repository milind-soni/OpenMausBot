import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";

import { createCloudAccountClient } from "./cloud-account.mjs";

const accessToken = `omc_${"T".repeat(43)}`;
const NOW = 1_800_000_000_000;
const HOME = "https://omb-u-1a2b3c4d5e6f.fly.dev", CLIENT_A = "https://omb-c-a.fly.dev", TEAM = "https://omb-t-acme.fly.dev";
const CHECKOUT = "https://test.checkout.dodopayments.com/session/cks_new";
const entry = (over = {}) => ({ id: "c-a", name: "Client A", color: "green", role: "owner", tier: "pro", runsOn: "cloud", status: "ready", origin: CLIENT_A,
  teamId: null, seats: null, renewsAt: null, cancelAtPeriodEnd: false, primary: false, ...over });
const PRIMARY = entry({ id: "c-home", name: "My Cloud", color: null, origin: HOME, primary: true });
const paid = { plan: "pro", tier: "pro", status: "active", expiresAt: NOW + 30 * 86400_000, version: 1 };
const grant = (origin) => ({ cloudContractVersion: 1, origin, code: "ABCD-EFGH-JK23", expiresAt: NOW + 60_000 });

/** A fake Admin: the session says `f.session`, pairing answers `f.pairing(body)`, adding a Cloud answers `f.add(body)`, adding
 * an organization `f.organization(body)`. */
async function admin(t) {
  const f = { requests: [], browsers: [], timer: null, delay: null,
    session: { cloud: { state: "ready", origin: HOME, pairingAvailable: true } },
    pairing: () => [200, grant(HOME)], add: () => [404, { error: "not_found" }], patch: () => [404, { error: "not_found" }], organization: () => [404, { error: "not_found" }],
    hide: () => [404, { error: "Not found." }] };
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    const parsed = body ? JSON.parse(body) : undefined;
    f.requests.push({ route: req.url, method: req.method, body: parsed });
    const send = ([status, data]) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
    if (req.headers.authorization !== `Bearer ${accessToken}`) return send([401, { error: "invalid_token" }]);
    if (req.url === "/api/cloud/desktop/session") return send([200, { cloudContractVersion: 1, expiresAt: NOW + 86400_000, device: { id: "device-1" },
      account: { id: "acct-1", email: "person@example.test" }, entitlement: paid, ...f.session }]);
    if (req.url === "/api/cloud/desktop/pairing" && req.method === "POST") return send(f.pairing(parsed));
    if (req.url === "/api/cloud/desktop/clouds" && req.method === "POST") return send(f.add(parsed));
    if (req.url === "/api/cloud/desktop/organizations" && req.method === "POST") return send(f.organization(parsed));
    if (req.url.startsWith("/api/cloud/desktop/clouds/") && req.method === "PATCH") return send(f.patch(decodeURIComponent(req.url.slice("/api/cloud/desktop/clouds/".length)), parsed));
    if (req.url.startsWith("/api/cloud/desktop/clouds/") && req.url.endsWith("/hide") && req.method === "POST") return send(f.hide(decodeURIComponent(req.url.slice("/api/cloud/desktop/clouds/".length, -"/hide".length)), parsed));
    if (req.url === "/api/public/config") return send([200, { plans: [{ tier: "pro", price: { currency: "USD", interval: "month", amount: 4900 } }], trial: { days: 7 } }]);
    send([404, { error: "not_found" }]);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  f.origin = `http://127.0.0.1:${server.address().port}`;
  const saved = { origin: f.origin, token: accessToken, expiresAt: NOW + 86400_000, device: { id: "device-1" }, account: { id: "acct-1", email: "person@example.test" } };
  f.client = createCloudAccountClient({ origin: f.origin, fixture: true, deviceName: "Fixture computer", platform: "darwin", appVersion: "0.1.fixture", now: () => NOW,
    store: { read: async () => saved, write: async () => {} }, openBrowser: async url => { f.browsers.push(url); },
    setTimer: (callback, delay) => { f.timer = callback; f.delay = delay; return 1; }, clearTimer: () => { f.timer = null; f.delay = null; } });
  t.after(async () => { f.client.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return f;
}

test("an Admin without the list of Clouds: the session reads exactly as before, nothing to add, no other Cloud to pair", async t => {
  const f = await admin(t);
  const state = await f.client.start();
  assert.equal(state.status, "connected");
  for (const key of ["clouds", "addCloud", "adding"]) assert.equal(state[key], undefined, key);
  assert.equal(f.client.isOwnCloud(HOME), true, "My Cloud is the person's own");
  assert.equal(f.client.isOwnCloud(CLIENT_A), false);
  await assert.rejects(f.client.pairHome("c-a"), error => error.gone === true);
  assert.equal(f.requests.some(row => row.route.endsWith("/pairing")), false, "never asked");
  assert.deepEqual(await f.client.pairHome(), { origin: HOME, code: "ABCD-EFGH-JK23", expiresAt: NOW + 60_000 });
  assert.deepEqual(f.requests.at(-1).body, {}, "My Cloud's pairing sends the same empty body an older Admin knows");
  assert.deepEqual(await f.client.addCloud({ tier: "pro", name: "Client B" }), { outcome: "unsupported" });
  assert.equal(f.requests.some(row => row.route.endsWith("/clouds")), false);
});

test("the session's Clouds: each other own Cloud pairs with its id, and only a grant for its own address is taken", async t => {
  const f = await admin(t);
  f.session = { ...f.session, clouds: [PRIMARY, entry(), entry({ id: "c-team", name: "Acme", teamId: "team-acme", role: "member", origin: TEAM })], canAdd: true };
  const state = await f.client.start();
  assert.deepEqual(state.clouds.map(cloud => cloud.id), ["c-home", "c-a", "c-team"]);
  assert.deepEqual(state.addCloud, { canAdd: true });
  assert.equal(state.latestVersion, undefined, "no newest release named: none");
  f.session = { ...f.session, latestVersion: "0.1.130" };
  assert.equal((await f.client.refresh()).latestVersion, "0.1.130");
  f.session = { ...f.session, latestVersion: "<script>" };
  assert.equal((await f.client.refresh()).latestVersion, undefined);
  assert.deepEqual([HOME, CLIENT_A, TEAM, "https://evil.example.test", null].map(origin => f.client.isOwnCloud(origin)), [true, true, false, false, false], "a team's Cloud is not the person's own");
  f.pairing = body => [200, grant(body?.cloudId === "c-a" ? CLIENT_A : HOME)];
  assert.deepEqual(await f.client.pairHome("c-a"), { origin: CLIENT_A, code: "ABCD-EFGH-JK23", expiresAt: NOW + 60_000 });
  assert.deepEqual(f.requests.at(-1).body, { cloudId: "c-a" });
  f.pairing = () => [200, grant(HOME)];
  await assert.rejects(f.client.pairHome("c-a"), /Invalid Cloud pairing response/, "a grant for another address is never taken");
  await assert.rejects(f.client.pairHome("c-team"), error => error.gone === true, "a team's Cloud pairs through its team, never here");
  f.pairing = () => [404, { error: "not_found" }];
  await assert.rejects(f.client.pairHome("c-a"), error => error.gone === true && /no longer one of your Clouds/.test(error.message));
  f.pairing = () => [409, { error: "not_running" }];
  await assert.rejects(f.client.pairHome("c-a"), /isn't running right now/);
  f.session = { ...f.session, clouds: [PRIMARY, entry({ status: "setting_up", origin: null })] };
  await f.client.refresh();
  await assert.rejects(f.client.pairHome("c-a"), /isn't ready to open yet/);
  assert.equal(f.delay, 15_000, "a Cloud of theirs being set up is checked every 15 s");
});

test("the Admin's word on each of the person's Clouds by its address: My Cloud's `cloud.power`, another's from the Clouds list", async t => {
  const f = await admin(t);
  f.session = { cloud: { state: "ready", origin: HOME, pairingAvailable: true, power: { state: "awake", since: 5, sleeps: true } },
    clouds: [PRIMARY, entry({ power: { state: "asleep", since: 7, sleeps: true } }), entry({ id: "c-b", name: "Client B", origin: "https://omb-c-b.fly.dev" })] };
  await f.client.start();
  assert.deepEqual(f.client.powerOf(HOME), { state: "awake", since: 5, sleeps: true });
  assert.deepEqual(f.client.powerOf(CLIENT_A), { state: "asleep", since: 7, sleeps: true });
  assert.equal(f.client.powerOf("https://omb-c-b.fly.dev"), null, "a Cloud whose plan never sleeps");
  assert.equal(f.client.powerOf(TEAM), null, "nothing the session lists");
  assert.equal(f.client.powerOf(""), null);
});

test("buying another Cloud: the plan, the name and the swatch go to the Admin, its own checkout opens, and the session is followed every 3 s", async t => {
  const f = await admin(t);
  f.session = { ...f.session, clouds: [PRIMARY] };
  await f.client.start();
  await assert.rejects(f.client.addCloud({ tier: "pro", name: "" }), /Invalid Cloud/);
  await assert.rejects(f.client.addCloud({ tier: "pro", name: "Client B", color: "url(x)" }), /Invalid Cloud/);
  await assert.rejects(f.client.addCloud({ tier: "pro", interval: "week", name: "Client B" }), /Invalid Cloud/);
  await assert.rejects(f.client.addCloud({ tier: "pro", name: "Client B", source: "https://evil.example.test" }), /Invalid Cloud/, "a source is one of the app's own");
  f.add = () => [200, { cloudId: "c-b", checkoutUrl: "https://evil.example.test/pay" }];
  assert.deepEqual(await f.client.addCloud({ tier: "pro", name: "Client B", color: "rose" }), { outcome: "failed" }, "only Dodo's own checkout ever opens");
  assert.deepEqual(f.browsers, []);
  f.add = () => [200, { cloudContractVersion: 1, cloudId: "c-b", checkoutUrl: CHECKOUT }];
  const opened = await f.client.addCloud({ tier: "pro", name: "  Client   B ", color: "rose" });
  assert.equal(opened.outcome, "opened");
  assert.deepEqual(f.requests.at(-1).body, { tier: "pro", interval: "month", name: "Client B", color: "rose" });
  assert.deepEqual(f.browsers, [CHECKOUT]);
  assert.deepEqual(opened.state.adding, { cloudId: "c-b", name: "Client B", color: "rose", tier: "pro", startedAt: NOW, link: true });
  assert.equal(JSON.stringify(opened.state).includes(CHECKOUT), false, "the checkout page stays in main");
  assert.equal(f.client.addLink(), CHECKOUT);
  assert.equal(f.delay, 3_000);
  f.add = () => [409, { error: "checkout_conflict", addBlocked: "cap" }];
  await f.client.addCloud({ tier: "pro", name: "Client C", source: "app_whats_new_team" });
  assert.deepEqual(f.requests.at(-1).body, { tier: "pro", interval: "month", name: "Client C", source: "app_whats_new_team" }, "where the person started, for the Admin's funnel");
  f.session = { ...f.session, clouds: [PRIMARY, entry({ id: "c-b", name: "Client B", status: "checkout", origin: null })] };
  f.timer(); await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(f.delay, 3_000, "still waiting for the payment");
  f.session = { ...f.session, clouds: [PRIMARY, entry({ id: "c-b", name: "Client B", status: "setting_up", origin: null })] };
  await f.client.refresh();
  assert.equal(f.delay, 15_000, "paid: setting up");
  assert.equal(await f.client.reopenAdd(), true);
  assert.deepEqual(f.browsers, [CHECKOUT, CHECKOUT], "Reopen opens the same page, never a new one");
  f.client.addDone();
  assert.equal(f.client.state().adding.done, true);
});

test("the Admin's word on adding: a cap or another open checkout, too many at once, or an Admin without the route", async t => {
  const f = await admin(t);
  f.session = { ...f.session, clouds: [PRIMARY], canAdd: false, addBlocked: "cap" };
  await f.client.start();
  assert.deepEqual(f.client.state().addCloud, { canAdd: false, blocked: "cap" });
  assert.deepEqual(await f.client.addCloud({ tier: "pro", name: "Client B" }), { outcome: "blocked", blocked: "cap" }, "the session's word: nothing is asked");
  assert.equal(f.requests.some(row => row.route.endsWith("/clouds")), false);
  f.session = { ...f.session, canAdd: undefined, addBlocked: undefined };
  await f.client.refresh();
  for (const [answer, outcome] of [
    [[409, { error: "checkout_conflict", addBlocked: "cap" }], { outcome: "blocked", blocked: "cap" }],
    [[503, { error: "temporarily_unavailable", addBlocked: "signups_closed", interval: 60 }], { outcome: "blocked", blocked: "signups_closed" }],
    [[429, { error: "rate_limited", addBlocked: "rate", interval: 600 }], { outcome: "blocked", blocked: "rate" }],
    [[409, { error: "blocked", addBlocked: "mystery" }], { outcome: "blocked", blocked: "cap" }],
    [[429, { error: "rate_limited" }], { outcome: "blocked", blocked: "rate" }],
    [[503, { error: "temporarily_unavailable" }], { outcome: "failed" }],
    [[404, { error: "not_found" }], { outcome: "unsupported" }],
    [[500, { error: "oops" }], { outcome: "failed" }],
  ]) {
    f.add = () => answer;
    assert.deepEqual(await f.client.addCloud({ tier: "pro", name: "Client B" }), outcome, JSON.stringify(answer));
  }
  assert.deepEqual(f.browsers, []);
  assert.equal(f.client.state().adding, undefined, "no checkout kept from a refusal that names none");
});

test("another Cloud's checkout still open: the Admin's page for it is kept here to reopen or copy, never opened by itself", async t => {
  const f = await admin(t);
  f.session = { ...f.session, clouds: [PRIMARY, entry({ id: "c-b", name: "Client B", status: "checkout", origin: null, color: "violet" })] };
  await f.client.start();
  assert.equal(await f.client.reopenAdd(), false, "watched, with no page of its own yet");
  f.add = () => [409, { error: "checkout_conflict", addBlocked: "checkout_open", checkoutUrl: CHECKOUT }];
  assert.deepEqual(await f.client.addCloud({ tier: "max", name: "Client C" }), { outcome: "blocked", blocked: "checkout_open" });
  assert.deepEqual(f.browsers, [], "the person asked for another Cloud, not this one: nothing opens by itself");
  assert.deepEqual(f.client.state().adding, { cloudId: "c-b", name: "Client B", color: "violet", tier: "pro", startedAt: NOW, link: true });
  assert.equal(f.client.addLink(), CHECKOUT);
  assert.equal(await f.client.reopenAdd(), true);
  assert.deepEqual(f.browsers, [CHECKOUT]);
  const fresh = await admin(t);
  fresh.session = { ...fresh.session, clouds: [PRIMARY] };
  await fresh.client.start();
  fresh.add = () => [409, { error: "checkout_conflict", addBlocked: "checkout_open", checkoutUrl: "https://evil.example.test/pay" }];
  assert.deepEqual(await fresh.client.addCloud({ tier: "pro", name: "Client B" }), { outcome: "blocked", blocked: "checkout_open" });
  assert.equal(fresh.client.state().adding, undefined, "only Dodo's own checkout page is ever kept");
});

test("a Cloud waiting at checkout that this app did not open (it restarted mid-checkout) is followed as its own, at the usual pace", async t => {
  const f = await admin(t);
  f.session = { ...f.session, clouds: [PRIMARY, entry({ id: "c-b", name: "Client B", status: "checkout", origin: null, color: "violet" })] };
  const state = await f.client.start();
  assert.deepEqual(state.adding, { cloudId: "c-b", name: "Client B", color: "violet", tier: "pro", startedAt: NOW });
  assert.equal(f.delay, 60_000, "a checkout this app did not open is not polled every few seconds");
  assert.equal(await f.client.reopenAdd(), false, "no page kept here to reopen");
});

test("a Cloud's colour is the Admin's: PATCH with the swatch, then the session read again; someone else's say, an older Admin and a signed-in server are said plainly", async t => {
  const f = await admin(t);
  const MINI = entry({ id: "s-mini", name: "Mac mini", runsOn: "server", managed: false, status: "ready", origin: "https://mini.example.ts.net" });
  f.session = { ...f.session, clouds: [PRIMARY, entry(), MINI] };
  await f.client.start();
  assert.equal(f.client.isOwnCloud("https://mini.example.ts.net"), false, "a server that only signed in is no Cloud of theirs");
  f.patch = (id, body) => {
    f.session = { ...f.session, clouds: [PRIMARY, entry({ color: body.color }), MINI] };
    return [200, { cloudContractVersion: 1, cloud: entry({ color: body.color }) }];
  };
  const reads = () => f.requests.filter(row => row.route === "/api/cloud/desktop/session").length, before = reads();
  assert.deepEqual(await f.client.setCloudColor("c-a", "rose"), { outcome: "saved" });
  assert.deepEqual(f.requests.find(row => row.method === "PATCH"), { route: "/api/cloud/desktop/clouds/c-a", method: "PATCH", body: { color: "rose" } });
  assert.equal(reads(), before + 1, "the session is read again, so every place follows the Admin");
  assert.equal(f.client.state().clouds.find(cloud => cloud.id === "c-a").color, "rose");
  await f.client.setCloudColor("c-home", null);
  assert.deepEqual(f.requests.at(-2).body, { color: null }, "none: the plain look");
  f.patch = () => [403, { error: "forbidden" }];
  assert.deepEqual(await f.client.setCloudColor("c-a", "blue"), { outcome: "refused" });
  for (const status of [404, 405, 501]) {
    f.patch = () => [status, { error: "not_found" }];
    assert.deepEqual(await f.client.setCloudColor("c-a", "blue"), { outcome: "unsupported" }, String(status));
  }
  f.patch = () => [500, { error: "server_error" }];
  assert.deepEqual(await f.client.setCloudColor("c-a", "blue"), { outcome: "failed" });
  const patches = f.requests.filter(row => row.method === "PATCH").length;
  assert.deepEqual(await f.client.setCloudColor("s-mini", "blue"), { outcome: "unsupported" }, "a server that only signed in has no Cloud colour to change");
  assert.deepEqual(await f.client.setCloudColor("c-gone", "blue"), { outcome: "unsupported" });
  assert.equal(f.requests.filter(row => row.method === "PATCH").length, patches, "neither was asked");
  await assert.rejects(f.client.setCloudColor("c-a", "chartreuse"), /Invalid Cloud color/);
  await assert.rejects(f.client.setCloudColor("../c-a", "blue"), /Invalid Cloud color/);
});

test("Remove from list: only a Cloud the session says is removable is asked about, by its id, then the session is read again; the Admin's no, a Cloud gone and an older Admin are said plainly", async t => {
  const f = await admin(t);
  const ENDED = entry({ id: "c-old", name: "Old Cloud", status: "ended", origin: "https://omb-c-old.fly.dev", deleteAfter: NOW + 2 * 86400_000, removable: true });
  f.session = { ...f.session, clouds: [PRIMARY, entry(), ENDED, entry({ id: "c-team", name: "Acme", teamId: "team-acme", role: "owner", origin: TEAM, status: "ended", removable: true })] };
  const state = await f.client.start();
  assert.deepEqual(state.clouds.map(cloud => [cloud.id, cloud.removable ?? false, cloud.deleteAfter ?? null]),
    [["c-home", false, null], ["c-a", false, null], ["c-old", true, NOW + 2 * 86400_000], ["c-team", false, null]], "a team's Cloud is never removable here, whatever an Admin says");
  // Never asked about a Cloud the session doesn't say is removable: a running one, a team's, or one not listed.
  for (const id of ["c-a", "c-team", "c-home", "c-gone"]) assert.deepEqual(await f.client.hideCloud(id), { outcome: "unsupported" }, id);
  assert.equal(f.requests.some(row => row.route.endsWith("/hide")), false, "none of those reached the Admin");
  await assert.rejects(f.client.hideCloud("../c-old"), /Invalid Cloud to remove/);
  f.hide = (id) => { f.session = { ...f.session, clouds: f.session.clouds.filter(cloud => cloud.id !== id) }; return [200, { cloudContractVersion: 1, hidden: true }]; };
  const reads = () => f.requests.filter(row => row.route === "/api/cloud/desktop/session").length, before = reads();
  assert.deepEqual(await f.client.hideCloud("c-old"), { outcome: "removed" });
  assert.deepEqual(f.requests.find(row => row.route.endsWith("/hide")), { route: "/api/cloud/desktop/clouds/c-old/hide", method: "POST", body: {} });
  assert.equal(reads(), before + 1, "the session is read again, so every list here follows the Admin");
  assert.deepEqual(f.client.state().clouds.map(cloud => cloud.id), ["c-home", "c-a", "c-team"]);
  const again = (answer) => { f.session = { ...f.session, clouds: [PRIMARY, ENDED] }; f.hide = () => answer; return f.client.refresh().then(() => f.client.hideCloud("c-old")); };
  assert.deepEqual(await again([409, { error: "not_removable", errorDescription: "Only a Cloud of your own that has ended…" }]), { outcome: "refused" });
  assert.deepEqual(await again([404, { error: "not_found", errorDescription: "There is no such Cloud on your account." }]), { outcome: "gone" });
  for (const answer of [[404, { error: "Not found." }], [405, { error: "invalid_method" }], [501, { error: "unsupported" }]]) {
    assert.deepEqual(await again(answer), { outcome: "unsupported" }, JSON.stringify(answer));
  }
  assert.deepEqual(await again([500, { error: "server_error" }]), { outcome: "failed" });
});

const PLAN = "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a", ORGANIZATION = "3c4d5e6f-7a8b-4c9d-8e1f-2a3b4c5d6e7f";
test("a new organization on the Team plan this account pays for: its name and swatch go to the Admin, nothing opens, and the session is read again", async t => {
  const f = await admin(t);
  f.session = { ...f.session, clouds: [PRIMARY, entry({ id: PLAN, name: "Agency", tier: "team", origin: TEAM, teamId: "team-1", primary: false })],
    organizations: { planCloudId: PLAN, canAdd: true, count: 1, max: 10, seats: { used: 3, limit: 20 } } };
  await f.client.start();
  assert.deepEqual(f.client.state().organizations, { planCloudId: PLAN, canAdd: true, count: 1, max: 10 });
  await assert.rejects(f.client.addOrganization({ name: "" }), /Invalid organization/);
  await assert.rejects(f.client.addOrganization({ name: "Client B", color: "url(x)" }), /Invalid organization/);
  assert.equal(f.requests.some(row => row.route.endsWith("/organizations")), false, "nothing malformed is sent");
  f.organization = body => [201, { cloudContractVersion: 1, cloud: entry({ id: ORGANIZATION, name: body.name, color: body.color, tier: "team", status: "setting_up", origin: null, teamId: "team-2" }) }];
  const reads = f.requests.filter(row => row.route.endsWith("/session")).length;
  assert.deepEqual(await f.client.addOrganization({ name: "  Client   B ", color: "rose" }), { outcome: "added", cloudId: ORGANIZATION });
  assert.deepEqual(f.requests.find(row => row.route.endsWith("/organizations")), { route: "/api/cloud/desktop/organizations", method: "POST", body: { name: "Client B", color: "rose" } });
  assert.equal(f.requests.filter(row => row.route.endsWith("/session")).length, reads + 1, "the rail then shows it being set up");
  assert.deepEqual(f.browsers, [], "no checkout: the plan already pays for it");
  await f.client.addOrganization({ name: "Client C" });
  assert.deepEqual(f.requests.filter(row => row.route.endsWith("/organizations")).at(-1).body, { name: "Client C" }, "no swatch: the Admin picks one");
});

test("the Admin's word on a new organization: the name is taken, the plan has as many as it can or isn't running, too many at once, or an Admin without them", async t => {
  const f = await admin(t);
  await f.client.start();
  assert.deepEqual(await f.client.addOrganization({ name: "Client B" }), { outcome: "unsupported" }, "no organizations in the session: nothing is asked");
  assert.equal(f.requests.some(row => row.route.endsWith("/organizations")), false);
  f.session = { ...f.session, clouds: [PRIMARY], organizations: { planCloudId: PLAN, canAdd: true, count: 2, max: 10, seats: { used: 3, limit: 5 } } };
  await f.client.refresh();
  for (const [answer, outcome] of [
    [[409, { error: "name_taken" }], { outcome: "taken" }],
    [[409, { error: "organization_unavailable", addBlocked: "limit" }], { outcome: "blocked", blocked: "limit" }],
    [[409, { error: "organization_unavailable", addBlocked: "no_team_plan" }], { outcome: "blocked", blocked: "no_team_plan" }],
    [[409, { error: "organization_unavailable", addBlocked: "mystery" }], { outcome: "failed" }],
    [[429, { error: "rate_limited", interval: 60 }], { outcome: "blocked", blocked: "rate" }],
    [[404, { error: "not_found" }], { outcome: "unsupported" }],
    [[400, { error: "invalid_request" }], { outcome: "failed" }],
    [[500, { error: "oops" }], { outcome: "failed" }],
  ]) {
    f.organization = () => answer;
    assert.deepEqual(await f.client.addOrganization({ name: "Client B" }), outcome, JSON.stringify(answer));
  }
  assert.deepEqual(f.browsers, []);
});
