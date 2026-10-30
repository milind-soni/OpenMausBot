import { describe, expect, it } from "vitest";

import { APP_TOOLS, appToolAnswer, appToolCall, appToolEntries, appToolsFor } from "./connector-app-tools.ts";

const CONNECTED = ["gmail", "googlecalendar", "github"];
const READS = ["gmail.search_emails", "gmail.read_email", "gmail.read_email_thread", "googlecalendar.list_events", "googlecalendar.list_calendars"];

describe("the connected-app tools a bot gets", () => {
  it("are its connected apps' tools, and only the reads of an app it may only read", () => {
    expect(appToolsFor({}, CONNECTED)).toEqual(APP_TOOLS.map((tool) => tool.name));
    expect(appToolsFor({ connectorScopes: { apps: { gmail: "read", googlecalendar: "read" } }, connectorTools: { gmail: { tools: "*" }, googlecalendar: { tools: "*" } } }, CONNECTED)).toEqual(READS);
    expect(appToolsFor({ connectorScopes: { apps: { gmail: "write" } }, connectorTools: { gmail: { tools: "*" } } }, CONNECTED))
      .toEqual(["gmail.search_emails", "gmail.read_email", "gmail.read_email_thread", "gmail.create_draft", "gmail.send_email"]);
  });

  it("never offers an app that is not connected, not granted, or granted other tools only", () => {
    expect(appToolsFor({}, ["github"])).toEqual([]);
    expect(appToolsFor({ connectorTools: {} }, CONNECTED)).toEqual([]);
    expect(appToolsFor({ connectorTools: { gmail: { tools: ["GMAIL_FETCH_EMAILS"] } } }, CONNECTED)).toEqual(["gmail.search_emails"]);
    expect(appToolsFor({ connectorScopes: { apps: {} } }, CONNECTED)).toEqual([]);
  });
});

describe("how an engine sees them", () => {
  it("lists them under the dotted names for an engine that finds tools by their own name, and with an underscore elsewhere", () => {
    expect(appToolEntries(["gmail.search_emails"], "dotted").map((entry) => entry.name)).toEqual(["gmail.search_emails"]);
    expect(appToolEntries(READS, "plain").map((entry) => entry.name)).toEqual(["gmail_search_emails", "gmail_read_email", "gmail_read_email_thread", "googlecalendar_list_events", "googlecalendar_list_calendars"]);
  });

  it("keeps every schema one flat object, the shape every engine's converter keeps", () => {
    const serialized = JSON.stringify(appToolEntries(APP_TOOLS.map((tool) => tool.name), "plain"));
    expect(serialized).not.toMatch(/"(oneOf|anyOf|allOf|const|format)"/);
    for (const entry of appToolEntries(APP_TOOLS.map((tool) => tool.name), "plain")) {
      expect(entry.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
      expect(String(entry.description).length).toBeLessThan(500);
    }
  });
});

describe("a call to one", () => {
  it("runs its Composio tool through the multi-execute tool, by either name, with the arguments it takes", () => {
    const call = appToolCall("gmail.search_emails", { query: "from:ada@example.test", max_results: "5" });
    expect(call?.slug).toBe("GMAIL_FETCH_EMAILS");
    expect(call?.frame(9)).toEqual({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { tools: [{
      tool_slug: "GMAIL_FETCH_EMAILS", arguments: { user_id: "me", query: "from:ada@example.test", max_results: 5, include_payload: false, verbose: false },
    }] } } });
    expect(appToolCall("GMAIL_READ_EMAIL_THREAD", { thread_id: "t1" })?.frame(1)).toMatchObject({ params: { arguments: { tools: [{ tool_slug: "GMAIL_FETCH_MESSAGE_BY_THREAD_ID", arguments: { user_id: "me", thread_id: "t1" } }] } } });
    expect(appToolCall("gmail_send_email", { to: "ada@example.test, max@example.test", subject: "Hi", body: "Hello" })?.frame(1))
      .toMatchObject({ params: { arguments: { tools: [{ tool_slug: "GMAIL_SEND_EMAIL", arguments: { recipient_email: "ada@example.test", extra_recipients: ["max@example.test"], subject: "Hi", body: "Hello" } }] } } });
    expect(appToolCall("COMPOSIO_SEARCH_TOOLS", {})).toBeNull();
  });

  it("answers with the tool's own data, and passes a refusal or failure through as it came", () => {
    const ok = { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify({ successful: true, data: { results: [{ tool_slug: "GMAIL_FETCH_EMAILS", response: { successful: true, data: { messages: [{ messageId: "m1" }] } } }] } }) }] } };
    expect(appToolAnswer("GMAIL_FETCH_EMAILS", ok)).toEqual({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify({ messages: [{ messageId: "m1" }] }) }] } });
    const refused = { jsonrpc: "2.0", id: 1, result: { isError: true, content: [{ type: "text", text: "\"GMAIL_SEND_EMAIL\" is not granted to this bot. This call was not performed." }] } };
    expect(appToolAnswer("GMAIL_SEND_EMAIL", refused)).toBe(refused);
  });
});
