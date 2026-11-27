import { afterEach, describe, expect, it, vi } from "vitest";

import { brokerHarness, message, type Installation } from "./test-harness";

let h: ReturnType<typeof brokerHarness>;

afterEach(() => vi.unstubAllGlobals());

function harness(migrations?: number) {
  h = brokerHarness(migrations === undefined ? {} : { migrations });
  vi.stubGlobal("fetch", h.composio.fetchImpl);
  return h;
}

const post = (owner: Installation, path: string, body: unknown) => h.call(owner, path, { method: "POST", body: JSON.stringify(body) });
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

describe("a desktop shares its connected apps with the person's own Cloud", () => {
  it("lets only the installation the code names act as the desktop's Composio user, once", async () => {
    harness();
    const desktop = await h.install(), cloud = await h.install(), stranger = await h.install();
    const gmail = h.account(desktop, "gmail");
    const work = h.account(desktop, "gmail");
    expect((await me(cloud)).user).not.toBe((await me(desktop)).user);

    const code = await share(desktop, cloud);
    expect((await post(stranger, "/v1/installation/adopt", { code })).status).toBe(404);
    const adopted = await post(cloud, "/v1/installation/adopt", { code });
    expect(adopted.status).toBe(200);
    await expect(adopted.json()).resolves.toEqual({ shared: true, user: (await me(desktop)).user });
    expect((await post(cloud, "/v1/installation/adopt", { code })).status).toBe(404);
    expect(await me(cloud)).toEqual({ installationId: cloud.id, user: (await me(desktop)).user, shared: true });

    const connected = await (await h.call(cloud, "/v1/connectors/connected")).json() as { services: Record<string, { connected: boolean; accounts: Array<{ id: string }> }> };
    expect(connected.services.gmail?.connected).toBe(true);
    expect(connected.services.gmail?.accounts.map((account) => account.id).sort()).toEqual([gmail, work].sort());
    // Tools run as the desktop's user: the Cloud's Session is that user's, and reaches its accounts.
    expect(await mcpCall(cloud)).toEqual({ tool: "GMAIL_SEND_EMAIL", user: desktop.userId, accounts: [gmail, work] });
    expect([...h.composio.sessions.values()].filter((session) => session.user_id === cloud.userId)).toEqual([]);
    // The stranger never reached it.
    expect((await me(stranger)).shared).toBe(false);
    expect(await mcpCall(stranger)).toMatchObject({ user: stranger.userId, accounts: [] });
  });

  it("an app connected on either side afterwards is there on both", async () => {
    harness();
    const desktop = await h.install(), cloud = await h.install();
    expect((await post(cloud, "/v1/installation/adopt", { code: await share(desktop, cloud) })).status).toBe(200);
    const link = await h.call(cloud, "/v1/connectors/notion/authorize", { method: "POST" });
    expect(link.status).toBe(200);
    h.account({ ...cloud, userId: desktop.userId }, "notion");
    const status = await (await h.call(desktop, "/v1/connectors?services=notion")).json() as { services: Record<string, { connected: boolean }> };
    expect(status.services.notion?.connected).toBe(true);
  });

  it("keeps a Cloud's own connected apps: it does not adopt while it has any, and the code is spent", async () => {
    harness();
    const desktop = await h.install(), cloud = await h.install();
    h.account(desktop, "gmail");
    const slack = h.account(cloud, "slack");
    h.account(cloud, "notion", "INITIATED");
    const code = await share(desktop, cloud);
    const refused = await post(cloud, "/v1/installation/adopt", { code });
    expect(refused.status).toBe(409);
    await expect(refused.json()).resolves.toMatchObject({ code: "has_connections", toolkits: ["slack"] });
    expect((await post(cloud, "/v1/installation/adopt", { code })).status).toBe(404);
    expect(await me(cloud)).toMatchObject({ shared: false, user: expect.not.stringMatching((await me(desktop)).user) });
    expect(await mcpCall(cloud)).toEqual({ tool: "GMAIL_SEND_EMAIL", user: cloud.userId, accounts: [slack] });
  });

  it("refuses an expired code, a code for itself, an unknown installation and malformed bodies", async () => {
    harness();
    const desktop = await h.install(), cloud = await h.install();
    const code = await share(desktop, cloud);
    h.d1.db.prepare("UPDATE user_shares SET expires_at = 0").run();
    expect((await post(cloud, "/v1/installation/adopt", { code })).status).toBe(404);
    expect((await post(desktop, "/v1/installation/share", { for: desktop.id })).status).toBe(400);
    expect((await post(desktop, "/v1/installation/share", { for: "00000000-0000-4000-8000-000000000000" })).status).toBe(404);
    expect((await post(desktop, "/v1/installation/share", { for: "not-an-installation" })).status).toBe(400);
    expect((await post(cloud, "/v1/installation/adopt", { code: "nope" })).status).toBe(400);
    expect(h.d1.rows("SELECT code_hash FROM user_shares")).toEqual([]);
    expect(h.d1.rows<{ code_hash: string }>("SELECT code_hash FROM user_shares").some((row) => row.code_hash === code)).toBe(false);
  });

  it("stores only the code's hash", async () => {
    harness();
    const desktop = await h.install(), cloud = await h.install();
    const code = await share(desktop, cloud);
    expect(JSON.stringify(h.d1.rows("SELECT * FROM user_shares"))).not.toContain(code);
  });

  it("two installations acting as one user keep each other's triggers and both get their events", async () => {
    harness();
    const desktop = await h.install(), cloud = await h.install();
    const gmail = h.account(desktop, "gmail");
    const { body: created } = await h.createTrigger(desktop, gmail);
    expect((await post(cloud, "/v1/installation/adopt", { code: await share(desktop, cloud) })).status).toBe(200);

    const listed = await (await h.call(cloud, "/v1/triggers")).json() as { unbound: Array<{ triggerId: string }> };
    expect(listed.unbound).toEqual([]);
    await expect((await h.call(cloud, `/v1/triggers/${created.triggerId}`, { method: "DELETE" })).json()).resolves.toEqual({ removed: 0 });
    expect(h.composio.instances.has(created.triggerId)).toBe(true);

    const { body: same } = await h.createTrigger(cloud, gmail);
    expect(same.triggerId).toBe(created.triggerId);
    expect((await h.deliver(message(created.triggerId, desktop.userId))).status).toBe(200);
    expect(h.queued(desktop.id)).toHaveLength(1);
    expect(h.queued(cloud.id)).toHaveLength(1);
  });

  it("an event naming another user is still refused for a sharing installation", async () => {
    harness();
    const desktop = await h.install(), cloud = await h.install();
    const gmail = h.account(desktop, "gmail");
    expect((await post(cloud, "/v1/installation/adopt", { code: await share(desktop, cloud) })).status).toBe(200);
    const { body: created } = await h.createTrigger(cloud, gmail);
    expect((await h.deliver(message(created.triggerId, cloud.userId))).status).toBe(200);
    expect(h.queued(cloud.id)).toEqual([]);
  });

  it("keeps working on a database that has not run migration 0004", async () => {
    harness(3);
    const desktop = await h.install(), cloud = await h.install();
    h.account(desktop, "gmail");
    // No user to share, so a desktop never tries.
    expect(await me(desktop)).toEqual({ installationId: desktop.id });
    expect((await h.call(desktop, "/v1/connectors/connected")).status).toBe(200);
    expect((await post(desktop, "/v1/installation/share", { for: cloud.id })).status).toBe(503);
  });
});
