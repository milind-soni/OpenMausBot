import { afterEach, describe, expect, it, vi } from "vitest";

import { brokerHarness } from "./test-harness";

afterEach(() => vi.unstubAllGlobals());

describe.each(["connected_accounts", "toolkits"])("broker %s inventory", (walker) => {
  it.each(["repeated cursor", "cursor cycle", "page cap", "missing items", "invalid items", "HTTP failure", "missing item identity",
    "missing account id", "invalid account id", "missing slug", "empty slug", "invalid slug",
    ...(walker === "toolkits" ? ["missing selected account", "missing selected id", "invalid selected id"] : [])])(
    "returns unavailable on %s while a retained account remains reachable", async (failure) => {
      const h = brokerHarness();
      vi.stubGlobal("fetch", h.composio.fetchImpl);
      try {
        const owner = await h.install();
        const gmail = h.account(owner);
        vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
          const url = new URL(String(input));
          if (url.pathname.endsWith(`/${walker}`)) {
            const malformed: Record<string, unknown> = walker === "connected_accounts" ? {
              "missing item identity": {}, "missing account id": { toolkit: { slug: "gmail" } },
              "invalid account id": { id: "bad id", toolkit: { slug: "gmail" } },
              "missing slug": { id: "ca_gmail", toolkit: {} },
              "empty slug": { id: "ca_gmail", toolkit: { slug: "" } },
              "invalid slug": { id: "ca_gmail", toolkit: { slug: " " } },
            } : {
              "missing item identity": {}, "missing slug": { is_no_auth: true },
              "empty slug": { slug: "", is_no_auth: true }, "invalid slug": { slug: " ", is_no_auth: true },
              "missing selected account": { slug: "gmail" },
              "missing selected id": { slug: "gmail", connected_account: {} },
              "invalid selected id": { slug: "gmail", connected_account: { id: "bad id" } },
              "missing account id": { slug: "gmail", connected_account: null },
              "invalid account id": { slug: "gmail", is_no_auth: true, connected_account: { id: "bad id" } },
            };
            if (Object.hasOwn(malformed, failure)) return Response.json({ items: [malformed[failure]] });
            const cursor = url.searchParams.get("cursor");
            if (failure === "missing items") return Response.json({});
            if (failure === "invalid items") return Response.json({ items: {} });
            if (failure === "HTTP failure") return Response.json({ error: "synthetic outage" }, { status: 503 });
            const next = failure === "page cap" ? `${Number(cursor ?? 0) + 1}`
              : failure === "cursor cycle" && cursor === "a" ? "b" : "a";
            return Response.json({ items: [], next_cursor: next });
          }
          if (url.pathname.endsWith("/connected_accounts") || url.pathname.endsWith("/toolkits")) {
            return Response.json({ items: [] });
          }
          return h.composio.fetchImpl(input, init);
        });
        const inventory = await h.call(owner, "/v1/connectors/connected");
        vi.stubGlobal("fetch", h.composio.fetchImpl);
        const rpc = await h.call(owner, "/v1/mcp", {
          method: "POST",
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "GMAIL_SEND_EMAIL", arguments: {} } }),
        });
        const result = await rpc.json() as { result: { content: Array<{ text: string }> } };
        expect(JSON.parse(result.result.content[0]!.text)).toMatchObject({ accounts: [gmail] });
        expect(inventory.status).toBe(503);
        await expect(inventory.json()).resolves.toMatchObject({ error: expect.any(String) });

        const recovered = await h.call(owner, "/v1/connectors/connected");
        expect(recovered.status).toBe(200);
        await expect(recovered.json()).resolves.toMatchObject({ services: { gmail: { connected: true } } });
      } finally {
        h.d1.db.close();
      }
    },
  );
});

it("proves completeness for a legitimately empty installation", async () => {
  const h = brokerHarness();
  vi.stubGlobal("fetch", h.composio.fetchImpl);
  try {
    const owner = await h.install();
    const response = await h.call(owner, "/v1/connectors/connected");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ configured: true, services: {}, complete: true });
  } finally {
    h.d1.db.close();
  }
});
