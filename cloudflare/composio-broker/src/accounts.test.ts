import { afterEach, describe, expect, it, vi } from "vitest";

import { accountToolCallRefusal, presentAccountGrant, reserveAppLink, verifyAccountGrant } from "./accounts";
import { DAY_MS, utcDay, utf8, type InstallationRow } from "./common";
import { createSession } from "./index";
import { adoptSharedUser } from "./sharing";
import { accountGrant, brokerHarness, cloudGrant, type Installation } from "./test-harness";

let h: ReturnType<typeof brokerHarness>;

afterEach(() => vi.unstubAllGlobals());

function harness(migrations?: number) {
  h = brokerHarness(migrations === undefined ? {} : { migrations });
  vi.stubGlobal("fetch", h.composio.fetchImpl);
  return h;
}

const ACCOUNT = "Jx3kQ9mZ2pL7vR4tY8wB1nC6dF0hG5sA";
const OTHER = "Pq8wE2rT6yU0iO4pA9sD3fG7hJ1kL5zX";
const ADMIN_SECRET = "test-cloud-grant-secret-0123456789abcdef";
const GRANT_VECTOR = "v1.acct.Jx3kQ9mZ2pL7vR4tY8wB1nC6dF0hG5sA.6f1d2c3b-4a59-4e8f-9a0b-1c2d3e4f5a6b.1800000000.P7t4nUF2_zleQuGefUILWeZiYXrkPuhnRQmgSlJo0os";
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
