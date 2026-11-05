import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { accountToolCallRefusal, clearRevokedAccounts, presentAccountGrant, reserveAppLink, revokeAccount, verifyAccountGrant } from "./accounts";
import { connectedAccountsPageSchema, DAY_MS, utcDay, utf8, type InstallationRow } from "./common";
import worker, { createSession } from "./index";
import { adoptSharedUser, shareUser } from "./sharing";
import { accountGrant, brokerHarness, CLOUD_GRANT_SECRET, cloudGrant, message, type Installation } from "./test-harness";

let h: ReturnType<typeof brokerHarness>;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function harness(migrations?: number) {
  h = brokerHarness(migrations === undefined ? {} : { migrations });
  vi.stubGlobal("fetch", h.composio.fetchImpl);
  return h;
}

const ACCOUNT = "Jx3kQ9mZ2pL7vR4tY8wB1nC6dF0hG5sA";
const OTHER = "Pq8wE2rT6yU0iO4pA9sD3fG7hJ1kL5zX";
const ADMIN_SECRET = "test-cloud-grant-secret-0123456789abcdef";
const GRANT_VECTOR = "v1.acct.Jx3kQ9mZ2pL7vR4tY8wB1nC6dF0hG5sA.6f1d2c3b-4a59-4e8f-9a0b-1c2d3e4f5a6b.1800000000.P7t4nUF2_zleQuGefUILWeZiYXrkPuhnRQmgSlJo0os";
const REVOKE_VECTOR = "v1=CxeisAj12Y9Drmez9vama1tp1sqkJ1VlKU-M4a_VVp4";
const soon = Math.floor(Date.now() / 1000) + 3600;
const INVALID_GRANT = { error: "This grant isn't valid. Ask MausBot for a new one.", code: "invalid_grant" };
const GRANT_EXPIRED = { error: "Sign in to MausBot again to keep using connected apps.", code: "grant_expired" };

const post = (owner: Installation, path: string, body: unknown) => h.call(owner, path, { method: "POST", body: JSON.stringify(body) });
const present = (owner: Installation, body: string) => h.call(owner, "/v1/installation/account", { method: "PUT", body });
const me = async (owner: Installation) => (await h.call(owner, "/v1/me")).json() as Promise<{ installationId: string; user: string; shared: boolean }>;
async function share(from: Installation, to: Installation) {
  const response = await post(from, "/v1/installation/share", { for: to.id });
  expect(response.status).toBe(201);
  return ((await response.json()) as { code: string }).code;
}
async function mcpCall(owner: Installation) {
  const response = await h.call(owner, "/v1/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "GMAIL_SEND_EMAIL", arguments: {} } }) });
  const body = await response.json() as { result: { content: Array<{ text: string }> } };
  return JSON.parse(body.result.content[0]!.text) as { user: string; accounts: string[] };
}
const authorize = (owner: Installation, slug: string, body: Record<string, unknown> = {}) =>
  h.call(owner, `/v1/connectors/${slug}/authorize`, { method: "POST", body: JSON.stringify(body) });
const linkBodies = () => h.composio.calls.filter((call) => call.path.endsWith("/link")).map((call) => call.body!);
const rpc = (owner: Installation, message: unknown) => h.call(owner, "/v1/mcp", { method: "POST", body: JSON.stringify(message) });
const toolCall = (owner: Installation) => rpc(owner, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "GMAIL_SEND_EMAIL", arguments: {} } });
const CALL = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "GMAIL_SEND_EMAIL", arguments: {} } };
const LIST = { jsonrpc: "2.0", id: 1, method: "tools/list" };
const sessionBodies = () => h.composio.calls.filter((call) => call.method === "POST" && call.path === "/tool_router/session").map((call) => call.body!);
/** Marks the installation as a paid Cloud's, as the Cloud's server does after registering. */
async function asCloud(owner: Installation) {
  const response = await h.call(owner, "/v1/installation/cloud", { method: "PUT", body: JSON.stringify({ grant: cloudGrant(`machine-${owner.id}`) }) });
  expect(response.status).toBe(200);
}
const forwardedToolCalls = () => h.composio.calls.filter((call) => call.path.endsWith("/mcp") && call.body?.method === "tools/call").length;
/** The Admin's revoke, signed with node:crypto apart from the Worker code it checks. */
function revokeInit(accountId: string, ts = Math.floor(Date.now() / 1000), secret = CLOUD_GRANT_SECRET, signedFor = accountId) {
  const signature = createHmac("sha256", secret).update(`omb-connected-apps-revoke:v1\n${ts}\n${signedFor}`).digest("base64url");
  const headers: Record<string, string> = { "content-type": "application/json", "x-omb-revoke-timestamp": String(ts), "x-omb-revoke-signature": `v1=${signature}` };
  return { method: "POST", body: JSON.stringify({ accountId }), headers };
}
const cron = (scheduledTime = Date.now()) =>
  worker.scheduled!({ scheduledTime, cron: "23 * * * *", noRetry() {} } as never, h.env as never);
async function connected(owner: Installation) {
  const response = await h.call(owner, "/v1/connectors/connected");
  return ((await response.json()) as { services: Record<string, { connected: boolean }> }).services;
}

describe("a phone's installation bound to its MausBot account", () => {
  it("verifies the Admin's account grant recipe and nothing altered", async () => {
    expect(await verifyAccountGrant(GRANT_VECTOR, ADMIN_SECRET)).toEqual({ accountId: ACCOUNT, installationId: "6f1d2c3b-4a59-4e8f-9a0b-1c2d3e4f5a6b", exp: 1800000000 });
    for (const altered of [GRANT_VECTOR.replace("Jx3k", "Kx3k"), GRANT_VECTOR.replace("6f1d2c3b", "7f1d2c3b"),
      GRANT_VECTOR.replace("1800000000", "1800000001"), `${GRANT_VECTOR.slice(0, -1)}x`, cloudGrant("3f9c2a4e-8b1d-4c6e-9a7f-2d5e8c1b0a93", ADMIN_SECRET)])
      expect(await verifyAccountGrant(altered, ADMIN_SECRET)).toBeNull();
    expect(await verifyAccountGrant(GRANT_VECTOR, `${ADMIN_SECRET}x`)).toBeNull();
  });

  it("binds every phone of an account to the account's Composio user, apart from desktops", async () => {
    harness();
    const phoneA = await h.install(), phoneB = await h.install(), desktop = await h.install();
    const bound = await h.bind(phoneA, ACCOUNT);
    expect(bound.status).toBe(200);
    expect((await h.bind(phoneB, ACCOUNT)).status).toBe(200);
    expect(await bound.json()).toEqual({ accountUntil: expect.any(Number), appLimit: 3, user: (await me(phoneB)).user });
    expect((await me(desktop)).user).not.toBe((await me(phoneA)).user);
    h.account(h.accountOwner(ACCOUNT), "gmail");
    expect((await mcpCall(phoneA)).user).toBe(`omb_acct_${ACCOUNT}`);
    expect((await connected(phoneB)).gmail?.connected).toBe(true);
    expect(await connected(desktop)).toEqual({});
    // A sign-in removed on one phone is gone from the other.
    await expect((await h.call(phoneB, "/v1/connectors/gmail", { method: "DELETE" })).json()).resolves.toEqual({ removed: 1 });
    expect(await connected(phoneA)).toEqual({});
  });

  it("refuses a grant for another installation, an expired or forged one, and a second account on a bound installation", async () => {
    harness();
    const phone = await h.install(), other = await h.install();
    const past = Math.floor(Date.now() / 1000) - 1;
    for (const grant of [accountGrant(ACCOUNT, other.id, soon), accountGrant(ACCOUNT, phone.id, past),
      accountGrant(ACCOUNT, phone.id, soon, "other-secret"), cloudGrant("3f9c2a4e-8b1d-4c6e-9a7f-2d5e8c1b0a93")]) {
      const refused = await present(phone, JSON.stringify({ grant }));
      expect(refused.status).toBe(403);
      expect(await refused.json()).toEqual(INVALID_GRANT);
    }
    for (const body of ["not json", JSON.stringify({ grant: 5 }), JSON.stringify({ grant: accountGrant(ACCOUNT, phone.id, soon), extra: 1 }), " ".repeat(1025)]) {
      expect((await present(phone, body)).status).toBe(403);
    }
    expect((await me(phone)).shared).toBe(false);

    expect((await h.bind(phone, ACCOUNT)).status).toBe(200);
    const before = h.d1.rows("SELECT * FROM installations WHERE id = ?", phone.id);
    const mismatch = await h.bind(phone, OTHER);
    expect(mismatch.status).toBe(409);
    expect(await mismatch.json()).toEqual({ error: "This installation belongs to another MausBot account.", code: "account_mismatch" });
    expect(h.d1.rows("SELECT account_id FROM installations WHERE id = ?", phone.id)).toEqual([{ account_id: ACCOUNT }]);
    expect(h.d1.rows("SELECT * FROM installations WHERE id = ?", phone.id)).toEqual(before);

    h.env.CLOUD_GRANT_SECRET = undefined;
    const unsupported = await h.bind(other, ACCOUNT);
    expect(unsupported.status).toBe(503);
    expect(await unsupported.json()).toEqual({ error: "Connected apps for MausBot accounts are not set up on this service.", code: "unsupported" });
  });

  it("refuses a deleted account's grant, and an installation disabled after it was authenticated, in the same statement", async () => {
    harness();
    const phone = await h.install(), late = await h.install();
    h.d1.db.prepare("INSERT INTO revoked_accounts (account_id, revoked_at) VALUES (?, ?)").run(OTHER, Date.now());
    const revoked = await h.bind(phone, OTHER);
    expect(revoked.status).toBe(403);
    expect(await revoked.json()).toEqual({ error: "This MausBot account was deleted.", code: "account_revoked" });
    expect(h.d1.rows("SELECT account_id, shared_user_id FROM installations WHERE id = ?", phone.id)).toEqual([{ account_id: null, shared_user_id: null }]);

    const row = h.d1.rows<InstallationRow>("SELECT * FROM installations WHERE id = ?", late.id)[0]!;
    h.d1.db.prepare("UPDATE installations SET disabled_at = ? WHERE id = ?").run(Date.now(), late.id);
    const request = new Request("https://broker.test/v1/installation/account", { method: "PUT", body: JSON.stringify({ grant: accountGrant(ACCOUNT, late.id, soon) }) });
    const disabled = await presentAccountGrant(request, row, h.env as never);
    expect(disabled.status).toBe(401);
    expect(h.d1.rows("SELECT account_id FROM installations WHERE id = ?", late.id)).toEqual([{ account_id: null }]);
  });

  it("stops a bound installation whose grant ran out until a fresh one arrives, and still answers /v1/me", async () => {
    harness();
    const phone = await h.install(), desktop = await h.install();
    expect((await h.bind(phone, ACCOUNT)).status).toBe(200);
    h.d1.db.prepare("UPDATE installations SET account_until = ? WHERE id = ?").run(Date.now() - 1, phone.id);
    for (const response of [await h.call(phone, "/v1/connectors/connected"), await h.call(phone, "/v1/mcp", { method: "POST", body: "{}" }),
      await h.call(phone, "/v1/events", { headers: { "x-omb-poller": "poller-main-0001" } })]) {
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual(GRANT_EXPIRED);
    }
    expect((await h.call(phone, "/v1/me")).status).toBe(200);
    expect((await h.bind(phone, ACCOUNT)).status).toBe(200);
    expect((await h.call(phone, "/v1/connectors/connected")).status).toBe(200);
    h.d1.db.prepare("UPDATE installations SET account_until = ? WHERE id = ?").run(Date.now() - 1, desktop.id);
    expect((await h.call(desktop, "/v1/connectors/connected")).status).toBe(200);
  });

  it("lets a bound phone share its account's apps only with a MausBot Cloud, and never adopt another user", async () => {
    harness();
    const phone = await h.install(), desktop = await h.install(), cloud = await h.install();
    expect((await h.bind(phone, ACCOUNT)).status).toBe(200);
    const notCloud = await post(phone, "/v1/installation/share", { for: desktop.id });
    expect(notCloud.status).toBe(403);
    expect(await notCloud.json()).toEqual({ error: "A MausBot account's connected apps can be shared only with a MausBot Cloud.", code: "cloud_only" });
    expect(h.d1.rows("SELECT * FROM user_shares")).toEqual([]);
    await asCloud(cloud);
    h.account(h.accountOwner(ACCOUNT), "gmail");
    const refused = await post(phone, "/v1/installation/adopt", { code: await share(desktop, phone) });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "This installation's connected apps follow its MausBot account.", code: "account_bound" });
    expect(h.d1.rows("SELECT for_installation FROM user_shares")).toEqual([{ for_installation: phone.id }]);
    expect((await post(cloud, "/v1/installation/adopt", { code: await share(phone, cloud) })).status).toBe(200);
    expect((await me(cloud)).user).toBe((await me(phone)).user);
    expect((await mcpCall(cloud)).accounts).toHaveLength(1);
  });

  it("keeps a Cloud that adopted an account's apps from sharing them on with anything but a Cloud", async () => {
    harness();
    const phone = await h.install(), cloud = await h.install(), desktop = await h.install(), cloud2 = await h.install();
    await h.bind(phone, ACCOUNT);
    await asCloud(cloud); await asCloud(cloud2);
    expect((await post(cloud, "/v1/installation/adopt", { code: await share(phone, cloud) })).status).toBe(200);
    const refused = await post(cloud, "/v1/installation/share", { for: desktop.id });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: "A MausBot account's connected apps can be shared only with a MausBot Cloud.", code: "cloud_only" });
    expect(h.d1.rows("SELECT * FROM user_shares")).toEqual([]);
    expect((await post(cloud2, "/v1/installation/adopt", { code: await share(cloud, cloud2) })).status).toBe(200);
  });

  it("refuses a grant that outlives the Admin's 24 hours by more than 300 s", async () => {
    harness();
    const phone = await h.install();
    const now = Math.floor(Date.now() / 1000);
    const refused = await present(phone, JSON.stringify({ grant: accountGrant(ACCOUNT, phone.id, now + 86_400 + 360) }));
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual(INVALID_GRANT);
    expect(h.d1.rows("SELECT account_id FROM installations WHERE id = ?", phone.id)).toEqual([{ account_id: null }]);
    expect((await h.bind(phone, ACCOUNT, now + 86_400 + 240)).status).toBe(200);
  });

  it("refuses an adopt that loses the race to a bind, leaving the account's user in place", async () => {
    harness();
    const phone = await h.install(), desktop = await h.install();
    const code = await share(desktop, phone);
    const authenticated = h.d1.rows<InstallationRow>("SELECT * FROM installations WHERE id = ?", phone.id)[0]!;
    expect((await h.bind(phone, ACCOUNT)).status).toBe(200);
    const request = new Request("https://broker.test/v1/installation/adopt", { method: "POST", body: JSON.stringify({ code }) });
    const adopted = await adoptSharedUser(request, authenticated, h.env as never);
    expect(adopted.ok).toBe(false);
    expect(adopted.response.status).toBe(409);
    expect(await adopted.response.json()).toEqual({ error: "This installation's connected apps follow its MausBot account.", code: "account_bound" });
    expect(h.d1.rows("SELECT shared_user_id FROM installations WHERE id = ?", phone.id)).toEqual([{ shared_user_id: `omb_acct_${ACCOUNT}` }]);
  });

  it("starts a fresh Session without connection management every time a phone binds", async () => {
    harness();
    const phone = await h.install();
    await h.bind(phone, ACCOUNT);
    // A Session with management on, as code without the allowance made it.
    const managed = await createSession(h.env as never, `omb_acct_${ACCOUNT}`);
    h.d1.db.prepare("UPDATE installations SET session_id = ? WHERE id = ?").run(managed.sessionId, phone.id);
    expect((await h.bind(phone, ACCOUNT)).status).toBe(200);
    expect(h.d1.rows("SELECT session_id FROM installations WHERE id = ?", phone.id)).toEqual([{ session_id: null }]);
    expect((await h.call(phone, "/v1/connectors/connected")).status).toBe(200);
    expect(sessionBodies().at(-1)?.manage_connections).toEqual({ enable: false });
  });

  it("fails closed for a bound phone's tool calls and sign-ins on a database without migration 0007", async () => {
    harness(6);
    const phone = await h.install();
    expect((await h.bind(phone, ACCOUNT)).status).toBe(200);
    expect((await rpc(phone, LIST)).status).toBe(200);
    expect((await rpc(phone, CALL)).status).toBe(503);
    expect(forwardedToolCalls()).toBe(0);
    expect((await authorize(phone, "gmail")).status).toBe(503);
    expect(linkBodies()).toEqual([]);
  });

  it("keeps unbound installations working on a database without migration 0006", async () => {
    harness(5);
    const desktop = await h.install(), cloud = await h.install();
    h.account(desktop, "gmail");
    expect((await me(desktop)).user).toEqual(expect.any(String));
    expect((await connected(desktop)).gmail?.connected).toBe(true);
    expect((await mcpCall(desktop)).user).toBe(desktop.userId);
    expect((await post(cloud, "/v1/installation/adopt", { code: await share(desktop, cloud) })).status).toBe(200);
    const unsupported = await h.bind(desktop, ACCOUNT);
    expect(unsupported.status).toBe(503);
    expect(await unsupported.json()).toMatchObject({ code: "unsupported" });
    expect((await h.call(cloud, "/v1/installation", { method: "DELETE" })).status).toBe(200);
    expect((await h.call(cloud, "/v1/me")).status).toBe(401);
  });
});

describe("a free MausBot account's allowance and its hosted sign-in callback", () => {
  it("lets an account connect three apps, refuses a fourth with app_limit, and still allows another sign-in to an app it has", async () => {
    harness();
    const phone = await h.install(), tablet = await h.install(), desktop = await h.install();
    await h.bind(phone, ACCOUNT); await h.bind(tablet, ACCOUNT);
    const acct = h.accountOwner(ACCOUNT);
    h.account(acct, "gmail"); h.account(acct, "slack"); h.account(acct, "notion", "INITIATED");
    expect((await authorize(phone, "notion")).status).toBe(200);          // a sign-in not finished does not count
    h.account(acct, "notion");
    const refused = await authorize(tablet, "linear");                     // the other phone of the account counts the same apps
    expect(refused.status).toBe(402);
    expect(await refused.json()).toEqual({ error: expect.any(String), code: "app_limit", limit: 3, apps: ["gmail", "notion", "slack"] });
    expect(linkBodies().some(body => body.toolkit === "linear")).toBe(false);
    expect((await authorize(phone, "gmail", { alias: "Work" })).status).toBe(200);
    for (const slug of ["gmail", "slack", "notion"]) h.account(desktop, slug);
    expect((await authorize(desktop, "linear")).status).toBe(200);         // desktops have no allowance
  });

  it("counts only an account's working apps, not sign-ins that never finished or stopped working", async () => {
    harness();
    const phone = await h.install();
    await h.bind(phone, OTHER);
    const acct = h.accountOwner(OTHER);
    h.account(acct, "gmail"); h.account(acct, "slack"); h.account(acct, "notion", "INITIATED"); h.account(acct, "linear", "EXPIRED");
    expect((await authorize(phone, "jira")).status).toBe(200);
  });

  it("counts the sign-ins an account opened in the last 15 minutes, once per app, across its phones", async () => {
    harness();
    const phone = await h.install(), tablet = await h.install();
    await h.bind(phone, ACCOUNT); await h.bind(tablet, ACCOUNT);
    for (const [owner, slug] of [[phone, "gmail"], [tablet, "gmail"], [phone, "slack"], [tablet, "notion"]] as const) {
      expect((await authorize(owner, slug)).status).toBe(200);
    }
    const refused = await authorize(phone, "linear");
    expect(refused.status).toBe(402);
    expect(await refused.json()).toEqual({ error: expect.any(String), code: "app_limit", limit: 3, apps: ["gmail", "notion", "slack"] });
    expect(linkBodies().some((body) => body.toolkit === "linear")).toBe(false);
    expect((await authorize(tablet, "slack")).status).toBe(200);           // an app already opened stays allowed
    h.d1.db.prepare("UPDATE account_links SET minted_at = ? WHERE toolkit = 'notion'").run(Date.now() - 15 * 60_000 - 1);
    expect((await authorize(phone, "linear")).status).toBe(200);
  });

  it("lets at most three new apps through when an account's phones open them at the same moment", async () => {
    harness();
    const phone = await h.install(), tablet = await h.install();
    await h.bind(phone, ACCOUNT); await h.bind(tablet, ACCOUNT);
    const opened = await Promise.all(["gmail", "slack", "notion", "linear", "jira"].map((slug, index) => authorize(index % 2 ? tablet : phone, slug)));
    expect(opened.map((response) => response.status).sort()).toEqual([200, 200, 200, 402, 402]);
    expect(linkBodies()).toHaveLength(3);
    // Five claims that reach the database in the same tick.
    const claims = await Promise.all(["asana", "jira", "linear", "notion", "slack"].map((slug) => reserveAppLink(h.env as never, OTHER, [], slug)));
    expect(claims.filter((claim) => claim === null)).toHaveLength(3);
  });

  it("refuses to start an account's connection while Composio can't list its apps, without asking for a link", async () => {
    harness();
    const phone = await h.install(), desktop = await h.install();
    await h.bind(phone, ACCOUNT);
    h.composio.fail(503, (call) => call.method === "GET" && call.path === "/connected_accounts");
    const refused = await authorize(phone, "gmail");
    expect(refused.status).toBe(502);
    expect(await refused.json()).toEqual({ error: "Connected apps can't be checked right now. Try again in a minute.", code: "provider_error" });
    expect(linkBodies()).toEqual([]);
    // A desktop still degrades to a first-account link, as before.
    h.composio.fail(503, (call) => call.method === "GET" && call.path === "/connected_accounts");
    expect((await authorize(desktop, "gmail")).status).toBe(200);
  });

  it("sends an account's hosted sign-in back to openmausbot://connected-apps/done whatever the caller asks, and a desktop's nowhere", async () => {
    harness();
    const phone = await h.install(), desktop = await h.install();
    await h.bind(phone, ACCOUNT);
    const phoneLink = await authorize(phone, "gmail", { callback_url: "https://evil.example/steal" });
    expect(phoneLink.status).toBe(200);
    expect(await phoneLink.json()).toEqual({ url: expect.stringMatching(/^https:\/\/backend\.composio\.dev\//) });
    expect(linkBodies()[0]).toEqual({ toolkit: "gmail", callback_url: "openmausbot://connected-apps/done" });
    expect((await authorize(desktop, "gmail", { callback_url: "https://evil.example/steal" })).status).toBe(200);
    expect(linkBodies()[1]).toEqual({ toolkit: "gmail" });
  });

  it("creates an account's Session without connection management, so a bot cannot connect past the allowance", async () => {
    harness();
    const phone = await h.install(), desktop = await h.install();
    await h.bind(phone, ACCOUNT);
    expect((await h.call(phone, "/v1/connectors/connected")).status).toBe(200);
    expect((await h.call(desktop, "/v1/connectors/connected")).status).toBe(200);
    const sessions = h.composio.calls.filter((call) => call.method === "POST" && call.path === "/tool_router/session").map((call) => call.body!);
    expect(sessions.find((body) => body.user_id === `omb_acct_${ACCOUNT}`)?.manage_connections).toEqual({ enable: false });
    expect(sessions.find((body) => body.user_id === desktop.userId)?.manage_connections)
      .toEqual({ enable: true, enable_wait_for_connections: true, enable_connection_removal: true });
  });

  it("caps an account's tool calls per UTC day across its phones, even when they call at once", async () => {
    harness();
    h.env.ACCOUNT_DAILY_TOOL_CALLS = "3";
    const phone = await h.install(), tablet = await h.install(), other = await h.install();
    await h.bind(phone, ACCOUNT); await h.bind(tablet, ACCOUNT);
    h.account(h.accountOwner(ACCOUNT), "gmail");
    expect((await rpc(phone, LIST)).status).toBe(200);
    const statuses = (await Promise.all([phone, tablet, phone, tablet, phone].map(toolCall))).map((response) => response.status);
    expect(statuses.sort()).toEqual([200, 200, 200, 429, 429]);
    expect(forwardedToolCalls()).toBe(3);
    const refused = await toolCall(tablet);
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({
      error: "A free MausBot account makes up to 3 connected-app tool calls a day. Try again tomorrow, or get MausBot Cloud for more.",
      code: "daily_limit",
    });
    expect((await rpc(phone, LIST)).status).toBe(200);

    // The next UTC day starts the count again, and a batch counts every call in it.
    h.d1.db.prepare("UPDATE account_tool_calls SET day = '2000-01-01'").run();
    expect((await rpc(phone, [CALL, CALL])).status).toBe(200);
    expect((await rpc(tablet, [CALL, CALL])).status).toBe(429);
    expect((await toolCall(tablet)).status).toBe(200);

    // Five calls that reach the counter in the same tick: exactly the cap passes.
    await h.bind(other, OTHER);
    const bound = h.d1.rows<InstallationRow>("SELECT * FROM installations WHERE id = ?", other.id)[0]!;
    const refusals = await Promise.all(Array.from({ length: 5 }, () => accountToolCallRefusal(utf8(JSON.stringify(CALL)), bound, h.env as never)));
    expect(refusals.filter((refusal) => refusal === null)).toHaveLength(3);
  });

  it("never moves an account's day backwards, or past its cap, when a call carries a stale clock", async () => {
    harness();
    h.env.ACCOUNT_DAILY_TOOL_CALLS = "2";
    const phone = await h.install();
    await h.bind(phone, ACCOUNT);
    const bound = h.d1.rows<InstallationRow>("SELECT * FROM installations WHERE id = ?", phone.id)[0]!;
    const count = (at: number) => accountToolCallRefusal(utf8(JSON.stringify(CALL)), bound, h.env as never, at);
    const now = Date.now();
    expect(await count(now + DAY_MS)).toBeNull();
    expect(await count(now)).toBeNull();
    expect(h.d1.rows("SELECT day, calls FROM account_tool_calls")).toEqual([{ day: utcDay(now + DAY_MS), calls: 2 }]);
    expect((await count(now))?.status).toBe(429);
    expect(h.d1.rows("SELECT day, calls FROM account_tool_calls")).toEqual([{ day: utcDay(now + DAY_MS), calls: 2 }]);
  });

  it("refuses a bound phone's MCP body that isn't JSON, which could hide an uncounted call", async () => {
    harness();
    const phone = await h.install();
    await h.bind(phone, ACCOUNT);
    const refused = await h.call(phone, "/v1/mcp", { method: "POST", body: "not json" });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: "This request isn't valid JSON.", code: "invalid_request" });
  });

  it("never counts a desktop's tool calls, or a Cloud's that shares the account's apps", async () => {
    harness();
    h.env.ACCOUNT_DAILY_TOOL_CALLS = "1";
    const phone = await h.install(), desktop = await h.install(), cloud = await h.install();
    await h.bind(phone, ACCOUNT);
    await asCloud(cloud);
    expect((await post(cloud, "/v1/installation/adopt", { code: await share(phone, cloud) })).status).toBe(200);
    h.account(h.accountOwner(ACCOUNT), "gmail"); h.account(desktop, "gmail");
    for (const owner of [desktop, desktop, cloud, cloud]) expect((await toolCall(owner)).status).toBe(200);
    expect(h.d1.rows("SELECT * FROM account_tool_calls")).toEqual([]);
  });

  it("allows 300 tool calls a day unless configured otherwise", async () => {
    harness();
    const phone = await h.install();
    await h.bind(phone, ACCOUNT);
    expect((await toolCall(phone)).status).toBe(200);
    h.d1.db.prepare("UPDATE account_tool_calls SET calls = 299").run();
    expect((await toolCall(phone)).status).toBe(200);
    expect((await toolCall(phone)).status).toBe(429);
  });
});

describe("an installation ending itself", () => {
  it("refuses its token from then on, answers a repeat the same, and leaves the account's other phones alone", async () => {
    harness();
    const phone = await h.install(), other = await h.install();
    await h.bind(phone, ACCOUNT);
    await h.bind(other, ACCOUNT);
    const ended = await h.call(phone, "/v1/installation", { method: "DELETE" });
    expect(ended.status).toBe(200);
    expect(await ended.json()).toEqual({ ended: true });
    const [{ disabled_at: disabledAt }] = h.d1.rows<{ disabled_at: number }>("SELECT disabled_at FROM installations WHERE id = ?", phone.id);
    expect(disabledAt).toEqual(expect.any(Number));
    for (const response of [await h.call(phone, "/v1/me"), await h.call(phone, "/v1/connectors/connected"), await h.bind(phone, ACCOUNT)]) {
      expect(response.status).toBe(401);
    }
    const again = await h.call(phone, "/v1/installation", { method: "DELETE" });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ended: true });
    expect(h.d1.rows("SELECT disabled_at FROM installations WHERE id = ?", phone.id)).toEqual([{ disabled_at: disabledAt }]);
    expect((await h.call(other, "/v1/connectors/connected")).status).toBe(200);
  });

  it("lets a phone whose grant ran out sign out, and refuses an unknown or missing token", async () => {
    harness();
    const phone = await h.install();
    await h.bind(phone, ACCOUNT);
    h.d1.db.prepare("UPDATE installations SET account_until = ? WHERE id = ?").run(Date.now() - 1, phone.id);
    expect((await h.call(phone, "/v1/installation", { method: "DELETE" })).status).toBe(200);
    expect((await h.call({ ...phone, token: "0".repeat(64) }, "/v1/installation", { method: "DELETE" })).status).toBe(401);
    expect((await h.fetch("/v1/installation", { method: "DELETE" })).status).toBe(401);
  });
});

describe("a deleted MausBot account", () => {
  it("accepts the Admin's revoke signature recipe", async () => {
    harness(); h.env.CLOUD_GRANT_SECRET = ADMIN_SECRET;
    expect(revokeInit(ACCOUNT, 1800000000, ADMIN_SECRET).headers["x-omb-revoke-signature"]).toBe(REVOKE_VECTOR);
    const request = new Request("https://broker.test/v1/accounts/revoke", { method: "POST", body: JSON.stringify({ accountId: ACCOUNT }),
      headers: { "content-type": "application/json", "x-omb-revoke-timestamp": "1800000000", "x-omb-revoke-signature": REVOKE_VECTOR } });
    expect((await revokeAccount(request, h.env as never, h.ctx, 1_800_000_000_000)).status).toBe(202);
  });

  it("revokes an account: its phones stop at once, its queued events and share codes go, its sign-ins are deleted, and an older grant is refused", async () => {
    harness();
    const phone = await h.install(), cloud = await h.install(), desktop = await h.install();
    await h.bind(phone, ACCOUNT);
    await asCloud(cloud);
    const gmail = h.account(h.accountOwner(ACCOUNT), "gmail");
    const { body: trigger } = await h.createTrigger(phone, gmail);
    expect((await h.deliver(message(trigger.triggerId, `omb_acct_${ACCOUNT}`))).status).toBe(200);
    expect(h.queued(phone.id)).toHaveLength(1);
    const pending = await share(phone, cloud), early = accountGrant(ACCOUNT, desktop.id, soon);
    await share(desktop, phone);
    const revoked = await h.fetch("/v1/accounts/revoke", revokeInit(ACCOUNT));
    expect(revoked.status).toBe(202);
    expect(await revoked.json()).toEqual({ revoked: true, installations: 1 });
    await Promise.all(h.background);
    expect((await h.call(phone, "/v1/connectors/connected")).status).toBe(401);
    expect(h.queued(phone.id)).toEqual([]);
    expect((await post(cloud, "/v1/installation/adopt", { code: pending })).status).toBe(404);
    expect(h.d1.rows("SELECT * FROM user_shares")).toEqual([]);
    expect(h.composio.calls.some(call => call.method === "DELETE" && call.path === `/connected_accounts/${gmail}` && call.query.get("revoke_on_delete") === "true")).toBe(true);
    expect(h.composio.accounts.filter(account => account.user_id === `omb_acct_${ACCOUNT}`)).toEqual([]);
    const late = await h.call(desktop, "/v1/installation/account", { method: "PUT", body: JSON.stringify({ grant: early }) });
    expect(late.status).toBe(403);
    expect(await late.json()).toMatchObject({ code: "account_revoked" });
    expect((await h.call(desktop, "/v1/connectors/connected")).status).toBe(200);
    const again = await h.fetch("/v1/accounts/revoke", revokeInit(ACCOUNT));   // again: harmless
    expect(again.status).toBe(202);
    expect(await again.json()).toEqual({ revoked: true, installations: 0 });
  });

  it("revokes every installation acting as the account's user, including a Cloud that adopted it and one that adopted from that Cloud", async () => {
    harness();
    const phone = await h.install(), cloud = await h.install(), desktop = await h.install(), other = await h.install();
    await h.bind(phone, ACCOUNT);
    for (const owner of [cloud, desktop, other]) await asCloud(owner);
    expect((await post(cloud, "/v1/installation/adopt", { code: await share(phone, cloud) })).status).toBe(200);
    expect((await post(desktop, "/v1/installation/adopt", { code: await share(cloud, desktop) })).status).toBe(200);
    const gmail = h.account(h.accountOwner(ACCOUNT), "gmail");
    const { body: trigger } = await h.createTrigger(cloud, gmail);
    expect((await h.deliver(message(trigger.triggerId, `omb_acct_${ACCOUNT}`))).status).toBe(200);
    expect(h.queued(cloud.id)).toHaveLength(1);
    const forOther = await share(cloud, other);
    for (const owner of [phone, cloud, desktop]) await connected(owner);
    const sessions = () => h.d1.rows<{ session_id: string | null }>("SELECT session_id FROM installations WHERE id IN (?, ?, ?)", phone.id, cloud.id, desktop.id);
    expect(sessions().every((row) => row.session_id)).toBe(true);
    const revoked = await h.fetch("/v1/accounts/revoke", revokeInit(ACCOUNT));
    expect(await revoked.json()).toEqual({ revoked: true, installations: 3 });
    for (const owner of [phone, cloud, desktop]) expect((await h.call(owner, "/v1/connectors/connected")).status).toBe(401);
    expect(h.queued(cloud.id)).toEqual([]);
    expect(h.d1.rows("SELECT * FROM trigger_bindings")).toEqual([]);
    expect(sessions()).toEqual([{ session_id: null }, { session_id: null }, { session_id: null }]);
    expect((await post(other, "/v1/installation/adopt", { code: forOther })).status).toBe(404);
    expect((await h.call(other, "/v1/connectors/connected")).status).toBe(200);
  });

  it("refuses a revoke that is unsigned, stale, signed for another account or with another secret, and answers 503 without CLOUD_GRANT_SECRET", async () => {
    harness();
    const phone = await h.install();
    await h.bind(phone, ACCOUNT);
    const now = Math.floor(Date.now() / 1000);
    const unsigned = revokeInit(ACCOUNT);
    delete unsigned.headers["x-omb-revoke-signature"];
    for (const init of [unsigned, revokeInit(ACCOUNT, now - 301), revokeInit(ACCOUNT, now + 301), revokeInit(ACCOUNT, now, CLOUD_GRANT_SECRET, OTHER),
      revokeInit(ACCOUNT, now, "other-secret"), { ...revokeInit(ACCOUNT), body: JSON.stringify({ accountId: ACCOUNT, extra: 1 }) },
      { ...revokeInit(ACCOUNT), body: "not json" }, revokeInit("a"), { ...revokeInit(ACCOUNT), body: JSON.stringify({ accountId: ACCOUNT }) + " ".repeat(1024) }]) {
      const refused = await h.fetch("/v1/accounts/revoke", init);
      expect(refused.status).toBe(401);
      expect(await refused.json()).toEqual({ error: "unauthorized" });
    }
    expect(h.d1.rows("SELECT * FROM revoked_accounts")).toEqual([]);
    expect((await h.call(phone, "/v1/connectors/connected")).status).toBe(200);
    expect((await h.fetch("/v1/accounts/revoke", revokeInit(ACCOUNT, now - 299))).status).toBe(202);
    h.env.CLOUD_GRANT_SECRET = undefined;
    const unsupported = await h.fetch("/v1/accounts/revoke", revokeInit(ACCOUNT));
    expect(unsupported.status).toBe(503);
    expect(await unsupported.json()).toEqual({ error: "Account revocation is not set up on this service.", code: "unsupported" });
  });

  it("keeps a revoke while Composio is down and finishes deleting the sign-ins on the hourly run", async () => {
    harness();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const phone = await h.install();
    await h.bind(phone, ACCOUNT);
    const gmail = h.account(h.accountOwner(ACCOUNT), "gmail");
    h.composio.fail(503, (call) => call.path === "/connected_accounts");
    expect((await h.fetch("/v1/accounts/revoke", revokeInit(ACCOUNT))).status).toBe(202);
    await Promise.all(h.background);
    expect((await h.call(phone, "/v1/connectors/connected")).status).toBe(401);
    expect(h.composio.accounts.map((account) => account.id)).toEqual([gmail]);
    expect(h.d1.rows("SELECT cleared_at FROM revoked_accounts")).toEqual([{ cleared_at: null }]);
    expect(warn.mock.calls.map(([line]) => JSON.parse(String(line)))).toContainEqual({ message: "revoked account cleanup failed", accountId: ACCOUNT, status: 503 });
    await cron();
    expect(h.composio.accounts).toEqual([]);
    expect(h.d1.rows("SELECT cleared_at FROM revoked_accounts")).toEqual([{ cleared_at: null }]);
    await cron();
    expect(h.d1.rows("SELECT cleared_at FROM revoked_accounts")).toEqual([{ cleared_at: expect.any(Number) }]);
  });

  it("spends at most 8 Composio requests a run on four revoked accounts, the ones tried longest ago first", async () => {
    harness();
    for (const [index, accountId] of ["acct_e", "acct_d", "acct_c", "acct_b", "acct_a"].entries()) {
      h.d1.db.prepare("INSERT INTO revoked_accounts (account_id, revoked_at) VALUES (?, ?)").run(accountId, 5 - index);
    }
    for (let app = 0; app < 10; app += 1) h.account(h.accountOwner("acct_a"), `app${app}`);
    const cleared = () => h.d1.rows<{ account_id: string }>("SELECT account_id FROM revoked_accounts WHERE cleared_at IS NOT NULL ORDER BY account_id").map((row) => row.account_id);
    const run = (at: number) => clearRevokedAccounts(h.env as never, at);
    await run(1_000);
    expect(h.composio.calls).toHaveLength(8);              // the oldest: 1 listing + 7 deletes
    expect(h.composio.accounts).toHaveLength(3);
    await run(2_000);                                       // it goes to the back
    expect(h.composio.calls).toHaveLength(12);
    expect(cleared()).toEqual(["acct_b", "acct_c", "acct_d", "acct_e"]);
    expect(h.composio.accounts).toHaveLength(3);
    await run(3_000);
    expect(h.composio.calls).toHaveLength(16);
    expect(h.composio.accounts).toEqual([]);
    await run(4_000);
    expect(cleared()).toEqual(["acct_a", "acct_b", "acct_c", "acct_d", "acct_e"]);
  });

  it("keeps an account uncleared while Composio fails to delete its sign-ins, and logs the status", async () => {
    harness();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    h.d1.db.prepare("INSERT INTO revoked_accounts (account_id, revoked_at) VALUES (?, ?)").run(ACCOUNT, 1);
    const gmail = h.account(h.accountOwner(ACCOUNT), "gmail");
    h.composio.fail(500, (call) => call.method === "DELETE");
    await clearRevokedAccounts(h.env as never);
    expect(h.composio.accounts.map((account) => account.id)).toEqual([gmail]);
    expect(h.d1.rows("SELECT cleared_at FROM revoked_accounts")).toEqual([{ cleared_at: null }]);
    expect(warn.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([{ message: "revoked account cleanup failed", accountId: ACCOUNT, status: 500 }]);
    await clearRevokedAccounts(h.env as never);
    await clearRevokedAccounts(h.env as never);
    expect(h.composio.accounts).toEqual([]);
    expect(h.d1.rows("SELECT cleared_at FROM revoked_accounts")).toEqual([{ cleared_at: expect.any(Number) }]);
  });

  it("deletes only the revoked account's own sign-ins even if Composio's listing ignores its user filter", async () => {
    harness();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    h.d1.db.prepare("INSERT INTO revoked_accounts (account_id, revoked_at) VALUES (?, ?)").run(ACCOUNT, 1);
    const desktop = await h.install();
    const gmail = h.account(h.accountOwner(ACCOUNT), "gmail"), theirs = h.account(desktop, "gmail");
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      // Every sign-in of every user, whatever user_ids asked for.
      if ((init?.method ?? "GET") === "GET" && url.pathname.endsWith("/connected_accounts")) return Response.json({ items: h.composio.accounts, next_cursor: null });
      return h.composio.fetchImpl(input, init);
    });
    await clearRevokedAccounts(h.env as never);
    await clearRevokedAccounts(h.env as never);
    expect(h.composio.accounts.map((account) => account.id)).toEqual([theirs]);
    expect(h.composio.calls.filter((call) => call.method === "DELETE").map((call) => call.path)).toEqual([`/connected_accounts/${gmail}`]);
    // A listing that still holds someone else's sign-in is no proof the account's own are gone.
    expect(h.d1.rows("SELECT cleared_at FROM revoked_accounts")).toEqual([{ cleared_at: null }]);
    const lines = warn.mock.calls.map(([line]) => String(line));
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      { message: "revoked account cleanup skipped another user's sign-ins", skipped: 1 },
      { message: "revoked account cleanup skipped another user's sign-ins", skipped: 1 },
    ]);
    for (const id of [theirs, desktop.userId, ACCOUNT]) expect(lines.join("\n")).not.toContain(id);
  });

  it("still reads a sign-in listing whose item has no user, so no listing breaks for desktops or Clouds", () => {
    expect(connectedAccountsPageSchema.safeParse({ items: [{ id: "ca_1", user_id: null }], next_cursor: null }).success).toBe(true);
  });

  it("finishes deleting a revoked account's sign-ins even when the rest of the hourly run fails", async () => {
    harness();
    h.d1.db.prepare("INSERT INTO revoked_accounts (account_id, revoked_at) VALUES (?, ?)").run(ACCOUNT, 1);
    h.account(h.accountOwner(ACCOUNT), "gmail");
    h.env.DB.batch = async () => { throw new Error("D1 is down"); };
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return h.composio.fetchImpl(input, init);
    });
    await expect(cron()).rejects.toThrow("D1 is down");
    expect(h.composio.accounts).toEqual([]);
  });

  it("logs a cleanup that can't read its revoked accounts", async () => {
    harness();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const prepare = h.env.DB.prepare;
    h.env.DB.prepare = (sql: string) => sql.includes("FROM revoked_accounts WHERE cleared_at IS NULL")
      ? { ...prepare(sql), all: async () => { throw new Error("D1_ERROR: database is locked"); } } as never
      : prepare(sql);
    await clearRevokedAccounts(h.env as never);
    expect(warn.mock.calls.map(([line]) => JSON.parse(String(line))))
      .toEqual([{ message: "revoked account cleanup failed", status: null, error: "D1_ERROR: database is locked" }]);
  });

  it("refuses an adopt of the account's user once the account is revoked, even while the adopt waits on Composio", async () => {
    harness();
    const phone = await h.install(), cloud = await h.install();
    await h.bind(phone, ACCOUNT);
    await asCloud(cloud);
    const code = await share(phone, cloud);
    let revokeDuringWait = true;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      if (revokeDuringWait && String(input).includes(`user_ids=${cloud.userId}`)) {
        revokeDuringWait = false;
        expect(await (await h.fetch("/v1/accounts/revoke", revokeInit(ACCOUNT))).json()).toEqual({ revoked: true, installations: 1 });
      }
      return h.composio.fetchImpl(input, init);
    });
    const adopted = await post(cloud, "/v1/installation/adopt", { code });
    expect(revokeDuringWait).toBe(false);
    expect(adopted.status).toBe(404);
    expect(await adopted.json()).toEqual({ error: "This sharing code is no longer valid." });
    expect(h.d1.rows("SELECT shared_user_id, disabled_at FROM installations WHERE id = ?", cloud.id)).toEqual([{ shared_user_id: null, disabled_at: null }]);
  });

  it("refuses an adopt of a code a phone minted just after its account was revoked", async () => {
    harness();
    const phone = await h.install(), cloud = await h.install();
    await h.bind(phone, ACCOUNT);
    await asCloud(cloud);
    const authenticated = h.d1.rows<InstallationRow>("SELECT * FROM installations WHERE id = ?", phone.id)[0]!;
    expect((await h.fetch("/v1/accounts/revoke", revokeInit(ACCOUNT))).status).toBe(202);
    const request = new Request("https://broker.test/v1/installation/share", { method: "POST", body: JSON.stringify({ for: cloud.id }) });
    const minted = await shareUser(request, authenticated, h.env as never);
    expect(minted.status).toBe(201);
    const adopted = await post(cloud, "/v1/installation/adopt", { code: ((await minted.json()) as { code: string }).code });
    expect(adopted.status).toBe(404);
    expect(await adopted.json()).toEqual({ error: "This sharing code is no longer valid." });
    expect(h.d1.rows("SELECT shared_user_id FROM installations WHERE id = ?", cloud.id)).toEqual([{ shared_user_id: null }]);
  });

  it("takes a sign-in another cleanup run deleted first as deleted", async () => {
    harness();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    h.d1.db.prepare("INSERT INTO revoked_accounts (account_id, revoked_at) VALUES (?, ?)").run(ACCOUNT, 1);
    h.account(h.accountOwner(ACCOUNT), "gmail");
    await Promise.all([clearRevokedAccounts(h.env as never), clearRevokedAccounts(h.env as never)]);
    expect(h.composio.calls.filter((call) => call.method === "DELETE")).toHaveLength(2);
    expect(warn).not.toHaveBeenCalled();
  });

  it("answers a revoke 503 and still expires app events on the hourly run on a database without migration 0006", async () => {
    harness(5);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const desktop = await h.install();
    const refused = await h.fetch("/v1/accounts/revoke", revokeInit(ACCOUNT));
    expect(refused.status).toBe(503);
    expect(await refused.json()).toEqual({ error: "service unavailable" });
    expect(h.background).toEqual([]);
    const { body: trigger } = await h.createTrigger(desktop, h.account(desktop, "gmail"));
    expect((await h.deliver(message(trigger.triggerId, desktop.userId))).status).toBe(200);
    expect(h.queued(desktop.id)).toHaveLength(1);
    await cron(Date.now() + 8 * DAY_MS);
    expect(h.queued()).toEqual([]);
    expect(warn.mock.calls.filter(([line]) => String(line).includes("revoked account cleanup failed"))).toEqual([]);
  });
});
