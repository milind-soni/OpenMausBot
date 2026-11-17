import { afterEach, describe, expect, it, vi } from "vitest";

import { brokerHarness, message, type Installation } from "./test-harness";

let h: ReturnType<typeof brokerHarness>;

afterEach(() => vi.unstubAllGlobals());

function harness(migrations?: number) {
  h = brokerHarness(migrations === undefined ? {} : { migrations });
  vi.stubGlobal("fetch", h.composio.fetchImpl);
  return h;
}

const TABLES = {
  installations: "id",
  trigger_bindings: "installation_id",
  events: "installation_id",
  event_drops: "installation_id",
  app_event_days: "installation_id",
};

const erase = (owner: Installation) => h.call(owner, "/v1/installation", { method: "DELETE" });
const post = (owner: Installation, path: string, body: unknown) => h.call(owner, path, { method: "POST", body: JSON.stringify(body) });
const alive = async (owner: Installation) => (await h.call(owner, "/v1/me")).status === 200;

function rowCounts(installationId: string) {
  const counts: Record<string, number> = {};
  for (const [table, column] of Object.entries(TABLES)) {
    counts[table] = h.d1.rows(`SELECT 1 FROM ${table} WHERE ${column} = ?`, installationId).length;
  }
  counts.user_shares = h.d1.rows("SELECT 1 FROM user_shares WHERE from_installation = ?1 OR for_installation = ?1", installationId).length;
  return counts;
}

const NOTHING = { installations: 0, trigger_bindings: 0, events: 0, event_drops: 0, app_event_days: 0, user_shares: 0 };

/** One row in every table, an acked event and a share code in each direction, the way the routes leave them. */
async function populated(partner: Installation) {
  const owner = await h.install();
  const account = h.account(owner, "gmail");
  const { body: trigger } = await h.createTrigger(owner, account);
  expect((await h.deliver(message(trigger.triggerId, owner.userId))).status).toBe(200);
  const { events } = await (await h.poll(owner)).json() as { events: Array<{ seq: number }> };
  await h.poll(owner, `after=${events[0]!.seq}`);
  expect((await h.deliver(message(trigger.triggerId, owner.userId))).status).toBe(200);
  h.d1.db.prepare("INSERT INTO event_drops (installation_id, composio_trigger_id, reason, dropped, last_dropped_at) VALUES (?, ?, 'queue_full', 1, 1)").run(owner.id, trigger.triggerId);
  expect((await post(owner, "/v1/installation/share", { for: partner.id })).status).toBe(201);
  expect((await post(partner, "/v1/installation/share", { for: owner.id })).status).toBe(201);
  return { owner, account, triggerId: trigger.triggerId };
}

async function shared() {
  const desktop = await h.install(), cloud = await h.install();
  const gmail = h.account(desktop, "gmail");
  const { code } = await (await post(desktop, "/v1/installation/share", { for: cloud.id })).json() as { code: string };
  expect((await post(cloud, "/v1/installation/adopt", { code })).status).toBe(200);
  return { desktop, cloud, gmail };
}

describe("DELETE /v1/installation", () => {
  it("erases every table's rows and what the installation created at Composio, then the token is dead", async () => {
    harness();
    const partner = await h.install();
    const { owner, account, triggerId } = await populated(partner);
    const before = rowCounts(owner.id);
    expect(before.installations).toBe(1);
    expect(before.trigger_bindings).toBe(1);
    expect(before.events).toBe(2);
    expect(before.event_drops).toBe(1);
    expect(before.app_event_days).toBe(1);
    expect(before.user_shares).toBe(2);
    const orphan = h.composio.accounts.find((candidate) => candidate.id === account)!;
    expect(orphan.user_id).toBe(owner.userId);

    const erased = await erase(owner);
    expect(erased.status).toBe(200);
    await expect(erased.json()).resolves.toEqual({ erased: true, sharedUserKept: false });

    expect(rowCounts(owner.id)).toEqual(NOTHING);
    expect(h.composio.instances.has(triggerId)).toBe(false);
    expect(h.composio.accounts).toEqual([]);
    const accountDelete = h.composio.calls.find((call) => call.method === "DELETE" && call.path === `/connected_accounts/${account}`);
    expect(accountDelete?.query.get("revoke_on_delete")).toBe("true");

    expect(await alive(owner)).toBe(false);
    expect((await erase(owner)).status).toBe(401);
  });

  it("deletes triggers before the connected accounts they read from", async () => {
    harness();
    const owner = await h.install();
    const account = h.account(owner);
    await h.createTrigger(owner, account);
    await erase(owner);
    const order = h.composio.calls.filter((call) => call.method === "DELETE").map((call) => call.path.split("/")[1]);
    expect(order).toEqual(["trigger_instances", "connected_accounts"]);
  });

  it("removes an instance of its Composio user that no installation binds", async () => {
    harness();
    const owner = await h.install();
    const account = h.account(owner);
    const { body: trigger } = await h.createTrigger(owner, account);
    h.d1.db.prepare("DELETE FROM trigger_bindings WHERE composio_trigger_id = ?").run(trigger.triggerId);
    expect((await erase(owner)).status).toBe(200);
    expect(h.composio.instances.size).toBe(0);
  });

  it("leaves another installation's rows, accounts, triggers and codes alone", async () => {
    harness();
    const partner = await h.install();
    const { owner } = await populated(partner);
    const other = await populated(partner);
    const untouched = rowCounts(other.owner.id);
    const shares = h.d1.rows("SELECT code_hash FROM user_shares WHERE from_installation = ?", other.owner.id);

    expect((await erase(owner)).status).toBe(200);

    expect(rowCounts(other.owner.id)).toEqual(untouched);
    expect(h.d1.rows("SELECT code_hash FROM user_shares WHERE from_installation = ?", other.owner.id)).toEqual(shares);
    expect(h.composio.accounts.map((account) => account.id)).toEqual([other.account]);
    expect([...h.composio.instances.keys()]).toEqual([other.triggerId]);
    expect(await alive(other.owner)).toBe(true);
    expect(await alive(partner)).toBe(true);
  });

  it("refuses a missing, malformed or unknown token and erases nothing", async () => {
    harness();
    const owner = await h.install();
    const account = h.account(owner);
    expect((await h.fetch("/v1/installation", { method: "DELETE" })).status).toBe(401);
    expect((await h.fetch("/v1/installation", { method: "DELETE", headers: { authorization: "Bearer nope" } })).status).toBe(401);
    expect((await erase({ ...owner, token: "f".repeat(64) })).status).toBe(401);
    expect(rowCounts(owner.id).installations).toBe(1);
    expect(h.composio.accounts.map((candidate) => candidate.id)).toEqual([account]);
    expect(h.composio.calls.filter((call) => call.method === "DELETE")).toEqual([]);
  });

  it("answers 429 when rate limited, before touching anything", async () => {
    harness();
    const owner = await h.install();
    const account = h.account(owner);
    h.env.SESSION_LIMITER.limit = async () => ({ success: false });
    expect((await erase(owner)).status).toBe(429);
    expect(h.composio.accounts.map((candidate) => candidate.id)).toEqual([account]);
    expect(rowCounts(owner.id).installations).toBe(1);
  });
});

describe("a Composio user another installation also uses", () => {
  it("keeps the connected accounts when the desktop erases first, then removes them with the last installation", async () => {
    harness();
    const { desktop, cloud, gmail } = await shared();
    const { body: sharedTrigger } = await h.createTrigger(desktop, gmail, { query: "both" });
    expect((await h.createTrigger(cloud, gmail, { query: "both" })).body.triggerId).toBe(sharedTrigger.triggerId);
    const { body: desktopOnly } = await h.createTrigger(desktop, gmail, { query: "desktop only" });
    const { body: cloudOnly } = await h.createTrigger(cloud, gmail, { query: "cloud only" });

    const erased = await erase(desktop);
    expect(erased.status).toBe(200);
    await expect(erased.json()).resolves.toEqual({ erased: true, sharedUserKept: true });

    expect(rowCounts(desktop.id)).toEqual(NOTHING);
    expect(h.composio.calls.some((call) => call.method === "DELETE" && call.path.startsWith("/connected_accounts/"))).toBe(false);
    expect(h.composio.accounts.map((account) => account.id)).toEqual([gmail]);
    expect(h.composio.instances.has(sharedTrigger.triggerId)).toBe(true);
    expect(h.composio.instances.has(cloudOnly.triggerId)).toBe(true);
    expect(h.composio.instances.has(desktopOnly.triggerId)).toBe(false);
    const status = await (await h.call(cloud, "/v1/connectors?services=gmail")).json() as { services: Record<string, { connected: boolean }> };
    expect(status.services.gmail?.connected).toBe(true);
    expect(await alive(cloud)).toBe(true);

    const last = await erase(cloud);
    await expect(last.json()).resolves.toEqual({ erased: true, sharedUserKept: false });
    expect(h.composio.accounts).toEqual([]);
    expect(h.composio.instances.size).toBe(0);
    expect(h.d1.rows("SELECT * FROM installations")).toEqual([]);
  });

  it("keeps the shared user when the Cloud erases first, and removes the Cloud's own leftover accounts", async () => {
    harness();
    const { desktop, cloud, gmail } = await shared();
    const leftover = h.account(cloud, "notion", "INITIATED");

    const erased = await erase(cloud);
    await expect(erased.json()).resolves.toEqual({ erased: true, sharedUserKept: true });

    expect(h.composio.accounts.map((account) => account.id)).toEqual([gmail]);
    expect(h.composio.calls.some((call) => call.method === "DELETE" && call.path === `/connected_accounts/${leftover}`)).toBe(true);
    expect(await alive(desktop)).toBe(true);
  });

  it("treats a disabled installation as no longer using the user", async () => {
    harness();
    const { desktop, cloud } = await shared();
    h.d1.db.prepare("UPDATE installations SET disabled_at = 1 WHERE id = ?").run(cloud.id);
    await expect((await erase(desktop)).json()).resolves.toEqual({ erased: true, sharedUserKept: false });
    expect(h.composio.accounts).toEqual([]);
  });

  it("spends a code still out, so nobody adopts a user being erased", async () => {
    harness();
    const desktop = await h.install(), cloud = await h.install();
    h.account(desktop, "gmail");
    const { code } = await (await post(desktop, "/v1/installation/share", { for: cloud.id })).json() as { code: string };
    expect((await erase(desktop)).status).toBe(200);
    expect((await post(cloud, "/v1/installation/adopt", { code })).status).toBe(404);
    expect(h.composio.accounts).toEqual([]);
  });

  it("does not delete an account Composio lists under another user", async () => {
    harness();
    const owner = await h.install(), stranger = await h.install();
    const theirs = h.account(stranger, "gmail");
    const listing = h.composio.fetchImpl;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/connected_accounts") && (init?.method ?? "GET") === "GET") {
        return Response.json({ items: [{ id: theirs, user_id: stranger.userId, status: "ACTIVE", toolkit: { slug: "gmail" } }], next_cursor: null });
      }
      return listing(input, init);
    });
    expect((await erase(owner)).status).toBe(200);
    expect(h.composio.accounts.map((account) => account.id)).toEqual([theirs]);
  });

  it("does not delete an account or trigger Composio lists without saying whose it is", async () => {
    harness();
    const owner = await h.install(), stranger = await h.install();
    const theirs = h.account(stranger, "gmail");
    const trigger = "ti_unattributed";
    const listing = h.composio.fetchImpl;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if ((init?.method ?? "GET") === "GET" && url.pathname.endsWith("/connected_accounts")) {
        return Response.json({ items: [{ id: theirs, status: "ACTIVE", toolkit: { slug: "gmail" } }], next_cursor: null });
      }
      if ((init?.method ?? "GET") === "GET" && url.pathname.endsWith("/trigger_instances/active")) {
        return Response.json({ items: [{ id: trigger, trigger_name: "GMAIL_NEW_GMAIL_MESSAGE" }], next_cursor: null });
      }
      return listing(input, init);
    });
    expect((await erase(owner)).status).toBe(200);
    expect(h.composio.accounts.map((account) => account.id)).toEqual([theirs]);
    expect(h.composio.calls.filter((call) => call.method === "DELETE")).toEqual([]);
  });
});

describe("a Composio failure can be retried", () => {
  const DELETE_TRIGGER = (call: { method: string; path: string }) => call.method === "DELETE" && call.path.startsWith("/trigger_instances/manage/");
  const DELETE_ACCOUNT = (call: { method: string; path: string }) => call.method === "DELETE" && call.path.startsWith("/connected_accounts/");
  const LIST_ACCOUNTS = (call: { method: string; path: string }) => call.method === "GET" && call.path === "/connected_accounts";

  for (const [name, status, match, expected] of [
    ["deleting a trigger", 500, DELETE_TRIGGER, 502],
    ["deleting a connected account", 500, DELETE_ACCOUNT, 502],
    ["listing connected accounts", 500, LIST_ACCOUNTS, 503],
  ] as const) {
    it(`keeps the token and answers an error when ${name} fails, and the retry finishes`, async () => {
      harness();
      const partner = await h.install();
      const { owner, triggerId } = await populated(partner);
      h.composio.fail(status, match);

      const failed = await erase(owner);
      expect(failed.status).toBe(expected);
      await expect(failed.json()).resolves.toHaveProperty("error");
      expect(await alive(owner)).toBe(true);
      expect(rowCounts(owner.id).installations).toBe(1);
      expect(rowCounts(owner.id).events).toBe(2);

      expect((await erase(owner)).status).toBe(200);
      expect(rowCounts(owner.id)).toEqual(NOTHING);
      expect(h.composio.instances.has(triggerId)).toBe(false);
      expect(h.composio.accounts).toEqual([]);
      expect(await alive(owner)).toBe(false);
    });
  }

  it("keeps the token when Composio cannot be reached at all", async () => {
    harness();
    const owner = await h.install();
    h.account(owner);
    vi.stubGlobal("fetch", async () => { throw new Error("connection reset"); });
    expect((await erase(owner)).status).toBe(503);
    expect(await alive(owner)).toBe(true);
    vi.stubGlobal("fetch", h.composio.fetchImpl);
    expect((await erase(owner)).status).toBe(200);
    expect(await alive(owner)).toBe(false);
  });

  it("treats what Composio already removed as done", async () => {
    harness();
    const owner = await h.install();
    const account = h.account(owner);
    const { body: trigger } = await h.createTrigger(owner, account);
    h.composio.instances.delete(trigger.triggerId);
    expect((await erase(owner)).status).toBe(200);
    expect(await alive(owner)).toBe(false);
    expect(h.composio.accounts).toEqual([]);
  });

  it("finishes a large erase over several calls, the token working until the last", async () => {
    harness();
    const owner = await h.install();
    for (let index = 0; index < 35; index += 1) {
      const account = h.account(owner, `toolkit${index}`);
      const instance = `ti_many_${index}`;
      h.composio.instances.set(instance, { id: instance, trigger_name: "GMAIL_EMAIL_SENT", connected_account_id: account, user_id: owner.userId, trigger_config: {}, disabled_at: null });
      h.d1.db.prepare("INSERT INTO trigger_bindings (installation_id, composio_trigger_id, toolkit, trigger_slug, connected_account_id, created_at) VALUES (?, ?, 'gmail', 'GMAIL_EMAIL_SENT', ?, 1)").run(owner.id, instance, account);
    }
    let calls = 0;
    let response: Response;
    do {
      calls += 1;
      expect(await alive(owner)).toBe(true);
      const before = h.composio.calls.filter((call) => call.method === "DELETE").length;
      response = await erase(owner);
      expect(h.composio.calls.filter((call) => call.method === "DELETE").length - before).toBeLessThanOrEqual(30);
      if (response.status === 202) await expect(response.json()).resolves.toEqual({ erased: false, more: true });
    } while (response.status === 202 && calls < 10);
    expect(response.status).toBe(200);
    expect(calls).toBeGreaterThan(1);
    expect(rowCounts(owner.id)).toEqual(NOTHING);
    expect(h.composio.accounts).toEqual([]);
    expect(h.composio.instances.size).toBe(0);
  });

  it("answers an error and changes nothing on a database that has not run migration 0004", async () => {
    harness(3);
    const owner = await h.install();
    const account = h.account(owner);
    expect((await erase(owner)).status).toBe(503);
    expect(await alive(owner)).toBe(true);
    expect(h.composio.accounts.map((candidate) => candidate.id)).toEqual([account]);
    expect(h.composio.calls.filter((call) => call.method === "DELETE")).toEqual([]);
  });
});
