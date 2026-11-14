import { afterEach, describe, expect, it, vi } from "vitest";

import type { brokerHarness, Installation } from "./test-harness";

afterEach(() => vi.unstubAllGlobals());

const sendEmail = (h: ReturnType<typeof brokerHarness>, owner: Installation) => h.call(owner, "/v1/mcp", {
  method: "POST",
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "GMAIL_SEND_EMAIL", arguments: {} } }),
});

async function emailResult(response: Response) {
  expect(response.status).toBe(200);
  const body = await response.json() as { result: { content: Array<{ text: string }> } };
  return JSON.parse(body.result.content[0]!.text);
}

async function sharingFixture() {
  vi.resetModules();
  const { brokerHarness } = await import("./test-harness");
  const h = brokerHarness();
  vi.stubGlobal("fetch", h.composio.fetchImpl);
  const desktop = await h.install(), cloud = await h.install();
  const gmail = h.account(desktop);
  const share = await h.call(desktop, "/v1/installation/share", { method: "POST", body: JSON.stringify({ for: cloud.id }) });
  expect(share.status).toBe(201);
  const { code } = await share.json() as { code: string };
  const adopt = async (otherIsolate = false) => {
    const init = { method: "POST", body: JSON.stringify({ code }) };
    if (!otherIsolate) return h.call(cloud, "/v1/installation/adopt", init);
    vi.resetModules();
    const { default: worker } = await import("./index");
    return worker.fetch(new Request("https://broker.test/v1/installation/adopt", {
      ...init, headers: { authorization: `Bearer ${cloud.token}` },
    }), h.env as never, h.ctx as never);
  };
  return { h, desktop, cloud, gmail, adopt };
}

describe("Composio session identity across account adoption", () => {
  it.each(["creation", "lookup"])("retries a session %s that finishes after adoption", async (operation) => {
    const { h, desktop, cloud, gmail, adopt } = await sharingFixture();
    if (operation === "lookup") await emailResult(await sendEmail(h, cloud));
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let held = false;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const response = await h.composio.fetchImpl(input, init);
      const path = new URL(String(input)).pathname;
      if (!held && (operation === "creation"
        ? path.endsWith("/tool_router/session") && init?.method === "POST"
        : /\/tool_router\/session\/[^/]+$/.test(path))) {
        held = true;
        started.resolve();
        await release.promise;
      }
      return response;
    });

    const pending = operation === "creation" ? sendEmail(h, cloud) : h.call(cloud, "/v1/connectors/connected");
    await started.promise;
    try {
      expect((await adopt()).status).toBe(200);
    } finally {
      release.resolve();
    }
    const response = await pending;
    if (operation === "creation") {
      expect(await emailResult(response)).toMatchObject({ user: desktop.userId, accounts: [gmail] });
    } else {
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ services: { gmail: { connected: true } } });
    }
    expect(await emailResult(await sendEmail(h, cloud))).toMatchObject({ user: desktop.userId, accounts: [gmail] });
    const [row] = h.d1.rows<{ session_id: string }>("SELECT session_id FROM installations WHERE id = ?", cloud.id);
    expect(h.composio.sessions.get(row.session_id)?.user_id).toBe(desktop.userId);
  });

  it("rejects a cached session belonging to the installation's previous user", async () => {
    const { h, desktop, cloud, gmail, adopt } = await sharingFixture();
    await emailResult(await sendEmail(h, cloud));
    const [old] = h.d1.rows<{ session_id: string }>("SELECT session_id FROM installations WHERE id = ?", cloud.id);
    expect((await adopt(true)).status).toBe(200);
    h.d1.db.prepare("UPDATE installations SET session_id = ? WHERE id = ?").run(old.session_id, cloud.id);

    expect(await emailResult(await sendEmail(h, cloud))).toMatchObject({ user: desktop.userId, accounts: [gmail] });
  });
});
