import { describe, expect, it } from "vitest";

import { APP_TOOLS, appToolAnswer, appToolCall, appToolEntries, appToolsFor } from "./connector-app-tools.ts";

const CONNECTED = ["gmail", "googlecalendar", "github"];
const READS = ["gmail.search_emails", "gmail.read_email", "gmail.read_email_thread", "gmail.list_drafts", "gmail.read_draft", "googlecalendar.list_events", "googlecalendar.list_calendars"];

describe("the connected-app tools a bot gets", () => {
  it("are its connected apps' tools, and only the reads of an app it may only read", () => {
    expect(appToolsFor({}, CONNECTED)).toEqual(APP_TOOLS.map((tool) => tool.name));
    expect(appToolsFor({ connectorScopes: { apps: { gmail: "read", googlecalendar: "read" } }, connectorTools: { gmail: { tools: "*" }, googlecalendar: { tools: "*" } } }, CONNECTED)).toEqual(READS);
    expect(appToolsFor({ connectorScopes: { apps: { gmail: "write" } }, connectorTools: { gmail: { tools: "*" } } }, CONNECTED))
      .toEqual(APP_TOOLS.filter(tool => tool.name.startsWith("gmail.")).map(tool => tool.name));
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
    expect(appToolEntries(READS, "plain").map((entry) => entry.name)).toEqual(READS.map(name => name.replace(".", "_")));
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
  it("keeps draft identity and threading when replacing a reply", () => {
    const input = { draft_id: "r123", to: "support@example.test", subject: "Re: Account", body: "Revised reply", thread_id: "t123" };
    const update = appToolCall("gmail_update_draft", input);
    expect(update?.slug).toBe("GMAIL_UPDATE_DRAFT");
    expect(update?.frame(1)).toMatchObject({ params: { arguments: { tools: [{ tool_slug: "GMAIL_UPDATE_DRAFT", arguments: {
      user_id: "me", draft_id: "r123", recipient_email: "support@example.test", subject: "Re: Account", body: "Revised reply", thread_id: "t123",
    } }] } } });
    expect(appToolsFor({ connectorTools: { gmail: { tools: ["GMAIL_CREATE_EMAIL_DRAFT"] } } }, ["gmail"])).toEqual(["gmail.create_draft"]);
  });

  it("drafts a reply with its thread id and no subject, so Composio keeps it in that thread", () => {
    const reply = appToolCall("gmail.create_draft", { to: "ada@example.test", body: "Sounds good", thread_id: " t99 " });
    expect(reply?.slug).toBe("GMAIL_CREATE_EMAIL_DRAFT");
    const item = (reply!.frame(1) as { params: { arguments: { tools: Array<Record<string, unknown>> } } }).params.arguments.tools[0]!;
    expect(item.tool_slug).toBe("GMAIL_CREATE_EMAIL_DRAFT");
    expect(item.arguments).toEqual({ user_id: "me", recipient_email: "ada@example.test", body: "Sounds good", thread_id: "t99" });
    expect((appToolEntries(["gmail.create_draft"], "dotted")[0]!.inputSchema as { required: string[] }).required).toEqual(["to", "body"]);
  });

  it("still sends the subject a new draft names", () => {
    expect(appToolCall("gmail.create_draft", { to: "ada@example.test", subject: "Quote", body: "Here it is" })?.frame(1)).toMatchObject({
      params: { arguments: { tools: [{ tool_slug: "GMAIL_CREATE_EMAIL_DRAFT", arguments: { user_id: "me", recipient_email: "ada@example.test", subject: "Quote", body: "Here it is" } }] } },
    });
  });

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

  it("names the connected account the bot chose, so an account limit can be met through the shortcut too", () => {
    for (const tool of APP_TOOLS) {
      const [entry] = appToolEntries([tool.name], "plain");
      expect((entry!.inputSchema as { properties: Record<string, unknown> }).properties.account).toMatchObject({ type: "string" });
    }
    expect(appToolCall("gmail.search_emails", { query: "is:unread", account: " ca_home " })?.frame(1)).toMatchObject({ params: { arguments: { tools: [{
      tool_slug: "GMAIL_FETCH_EMAILS", account: "ca_home", arguments: { query: "is:unread" },
    }] } } });
    const item = (appToolCall("googlecalendar.list_events", { account: "" })!.frame(1) as { params: { arguments: { tools: Array<Record<string, unknown>> } } }).params.arguments.tools[0]!;
    expect(item).not.toHaveProperty("account");
    expect(item.arguments).not.toHaveProperty("account");
  });

  it("answers with the tool's own data, and passes a refusal or failure through as it came", () => {
    const ok = { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify({ successful: true, data: { results: [{ tool_slug: "GMAIL_FETCH_EMAILS", response: { successful: true, data: { messages: [{ messageId: "m1" }] } } }] } }) }] } };
    expect(appToolAnswer("GMAIL_FETCH_EMAILS", ok)).toEqual({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify({ messages: [{ messageId: "m1" }] }) }] } });
    const refused = { jsonrpc: "2.0", id: 1, result: { isError: true, content: [{ type: "text", text: "\"GMAIL_SEND_EMAIL\" is not granted to this bot. This call was not performed." }] } };
    expect(appToolAnswer("GMAIL_SEND_EMAIL", refused)).toBe(refused);
  });
});
