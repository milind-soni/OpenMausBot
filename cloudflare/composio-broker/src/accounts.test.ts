import { afterEach, describe, expect, it, vi } from "vitest";

import { presentAccountGrant, verifyAccountGrant } from "./accounts";
import type { InstallationRow } from "./common";
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

  it("lets a bound phone share its account's apps with the person's Cloud, but never adopt another user", async () => {
    harness();
    const phone = await h.install(), desktop = await h.install(), cloud = await h.install();
    expect((await h.bind(phone, ACCOUNT)).status).toBe(200);
    h.account(h.accountOwner(ACCOUNT), "gmail");
    const refused = await post(phone, "/v1/installation/adopt", { code: await share(desktop, phone) });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "This installation's connected apps follow its MausBot account.", code: "account_bound" });
    expect(h.d1.rows("SELECT for_installation FROM user_shares")).toEqual([{ for_installation: phone.id }]);
    expect((await post(cloud, "/v1/installation/adopt", { code: await share(phone, cloud) })).status).toBe(200);
    expect((await me(cloud)).user).toBe((await me(phone)).user);
    expect((await mcpCall(cloud)).accounts).toHaveLength(1);
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
