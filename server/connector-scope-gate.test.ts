import { describe, expect, it } from "vitest";

import {
  filterConnectorDiscoveryPayload,
  filterConnectorToolsPayload,
  gateConnectorRequests,
  gateConnectorRpc,
} from "./connector-scope-gate.ts";

const grants = {
  gmail: { accountId: "work-account", scopes: ["read", "send"] as const },
  slack: { scopes: ["read"] as const },
};

const call = (name: string, args: Record<string, unknown> = {}) => ({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name, arguments: args },
});

describe("connector scope relay gate", () => {
  it("allows a read and refuses an ungranted write before upstream", () => {
    expect(gateConnectorRpc(call("GMAIL_FETCH_EMAILS"), grants)).toMatchObject({ ok: true });
    const refused = gateConnectorRpc(call("GMAIL_CREATE_EMAIL_DRAFT"), grants);
    expect(refused).toMatchObject({ ok: false, decision: { reason: "scope", required: "draft" } });
    if (!refused.ok) {
      expect(refused.message).toContain("GMAIL_CREATE_EMAIL_DRAFT");
      expect(refused.message).toContain("draft");
      expect(refused.message).not.toContain("gmail (read");
    }
  });

  it("pins a selected account into direct and multi-execute calls", () => {
    const direct = gateConnectorRpc(call("GMAIL_FETCH_EMAILS", { query: "is:unread" }), grants);
    expect(direct).toMatchObject({ ok: true, body: { params: { arguments: { connected_account_id: "work-account" } } } });

    const batch = gateConnectorRpc(call("COMPOSIO_MULTI_EXECUTE_TOOL", {
      tools: [{ tool_slug: "GMAIL_FETCH_EMAILS", arguments: {} }, { tool_slug: "SLACK_SEARCH_MESSAGES", arguments: {} }],
    }), grants);
    expect(batch).toMatchObject({
      ok: true,
      body: { params: { arguments: { tools: [
        { tool_slug: "GMAIL_FETCH_EMAILS", account: "work-account" },
        { tool_slug: "SLACK_SEARCH_MESSAGES" },
      ] } } },
    });
  });

  it("rejects account aliases hidden inside a multi-execute row", () => {
    const refused = gateConnectorRpc(call("COMPOSIO_MULTI_EXECUTE_TOOL", {
      tools: [{
        tool_slug: "GMAIL_FETCH_EMAILS",
        arguments: { connected_account_id: "personal-account" },
      }],
    }), grants);
    expect(refused).toMatchObject({ ok: false, decision: { reason: "account", toolkit: "gmail" } });
  });

  it("rewrites every supplied account alias when pinning a direct call", () => {
    const pinned = gateConnectorRpc(call("GMAIL_FETCH_EMAILS", {
      account_id: "work-account",
      account: "personal-account",
    }), grants);
    expect(pinned).toMatchObject({
      ok: true,
      body: { params: { arguments: {
        account_id: "work-account",
        account: "work-account",
        connected_account_id: "work-account",
      } } },
    });
  });

  it("matches the longest granted toolkit slug when a slug contains underscores", () => {
    const scoped = { google_sheets: { scopes: ["read"] as const } };
    expect(gateConnectorRpc(call("GOOGLE_SHEETS_FETCH_ROWS"), scoped)).toMatchObject({ ok: true });
    expect(gateConnectorRpc(call("GOOGLE_SHEETS_UPDATE_ROW"), scoped)).toMatchObject({
      ok: false,
      decision: { reason: "scope", toolkit: "google_sheets", required: "modify" },
    });
  });

  it("rejects a mixed batch before any member can reach upstream", () => {
    const refused = gateConnectorRpc(call("COMPOSIO_MULTI_EXECUTE_TOOL", {
      tools: [{ tool_slug: "GMAIL_FETCH_EMAILS", arguments: {} }, { tool_slug: "NOTION_SEARCH_PAGES", arguments: {} }],
    }), grants);
    expect(refused).toMatchObject({ ok: false, decision: { reason: "toolkit", toolkit: "notion" } });
  });

  it("constrains unqualified discovery to the granted toolkits", () => {
    const search = gateConnectorRpc(call("COMPOSIO_SEARCH_TOOLS", { query: "mail" }), grants);
    expect(search).toMatchObject({ ok: true, body: { params: { arguments: { query: "mail" } } } });
    expect((search as { ok: true; body: { params: { arguments: Record<string, unknown> } } }).body.params.arguments).not.toHaveProperty("toolkits");
    const outside = gateConnectorRpc(call("COMPOSIO_SEARCH_TOOLS", { toolkits: ["gmail", "notion"] }), grants);
    expect(outside).toMatchObject({ ok: false, decision: { reason: "toolkit", toolkit: "notion" } });
  });

  it("keeps legacy absence permissive but makes an explicit empty map deny-all", () => {
    expect(gateConnectorRpc(call("GMAIL_SEND_EMAIL"), undefined)).toMatchObject({ ok: true });
    expect(gateConnectorRpc(call("GMAIL_SEND_EMAIL"), {})).toMatchObject({ ok: false });
    expect(gateConnectorRpc(call("COMPOSIO_MANAGE_CONNECTIONS", { toolkits: ["gmail"] }), {})).toMatchObject({ ok: false });
    expect(gateConnectorRpc(call("COMPOSIO_MANAGE_CONNECTIONS", { toolkits: ["gmail"] }), grants)).toMatchObject({ ok: false, decision: { reason: "account" } });
    expect(gateConnectorRpc(call("COMPOSIO_MANAGE_CONNECTIONS", { toolkits: [{ toolkit: "gmail", account_id: "work-account" }] }), grants)).toMatchObject({ ok: true });
  });

  it("does not allow a connection card to bootstrap an ungranted toolkit", () => {
    expect(gateConnectorRequests(grants, [{ slug: "gmail", accountId: "work-account" }])).toMatchObject({ ok: true });
    expect(gateConnectorRequests(grants, [{ slug: "gmail" }])).toMatchObject({ ok: false, decision: { reason: "account" } });
    expect(gateConnectorRequests({ gmail: { scopes: ["read"] } }, [{ slug: "gmail" }])).toMatchObject({ ok: true });
    expect(gateConnectorRequests(grants, [{ slug: "notion" }])).toMatchObject({ ok: false, decision: { toolkit: "notion" } });
  });

  it("removes execution and discovery tools from an explicit deny-all list", () => {
    const payload = new TextEncoder().encode(JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      result: { tools: [
        { name: "COMPOSIO_MANAGE_CONNECTIONS" },
        { name: "COMPOSIO_WAIT_FOR_CONNECTIONS" },
        { name: "COMPOSIO_SEARCH_TOOLS" },
        { name: "COMPOSIO_GET_TOOL_SCHEMAS" },
        { name: "COMPOSIO_MULTI_EXECUTE_TOOL" },
      ] },
    }));
    const filtered = JSON.parse(new TextDecoder().decode(filterConnectorToolsPayload(payload, "application/json", {})));
    expect(filtered.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "COMPOSIO_MANAGE_CONNECTIONS",
      "COMPOSIO_WAIT_FOR_CONNECTIONS",
    ]);
  });

  it("filters tool search results embedded in MCP text content", () => {
    const payload = {
      jsonrpc: "2.0",
      result: {
        content: [{
          type: "text",
          text: JSON.stringify({ tools: [
            { tool_slug: "GMAIL_FETCH_EMAILS" },
            { tool_slug: "NOTION_SEARCH_PAGES" },
          ] }),
        }],
      },
    };
    const grants = { gmail: { scopes: ["read"] as const } };
    const filtered = JSON.parse(new TextDecoder().decode(
      filterConnectorDiscoveryPayload(new TextEncoder().encode(JSON.stringify(payload)), "application/json", grants),
    ));
    const result = JSON.parse(filtered.result.content[0].text);
    expect(result.tools).toEqual([{ tool_slug: "GMAIL_FETCH_EMAILS" }]);
  });
});
