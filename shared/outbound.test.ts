import { describe, expect, it } from "vitest";

import { OUTBOUND_DEFAULT_CAP, connectorCallsIn, isOutboundTool, normalizeOutboundPolicy, outboundCallsIn } from "./outbound.ts";

describe("isOutboundTool", () => {
  it("flags tools that send, reply, post, publish, invite, share, or move money", () => {
    for (const name of [
      "GMAIL_SEND_EMAIL",
      "GMAIL_REPLY_TO_THREAD",
      "SLACK_SEND_MESSAGE",
      "SLACK_CHAT_POST_MESSAGE",
      "TWITTER_CREATION_OF_A_POST",
      "LINKEDIN_CREATE_LINKED_IN_POST",
      "STRIPE_CREATE_REFUND",
      "GITHUB_CREATE_AN_ISSUE_COMMENT",
      "HUBSPOT_SEND_EMAIL",
      "GOOGLECALENDAR_INVITE_ATTENDEES",
      "mcp__composio__WHATSAPP_SEND_MESSAGE",
      "mcp__claude_ai_Gmail__send_message",
      "mcp__claude_ai_Gmail__reply",
      "mcp__claude_ai_Gmail__forward",
      "mcp__claude_ai_Slack__slack_send_message",
    ]) {
      expect(isOutboundTool(name), name).toBe(true);
    }
  });

  it("leaves reading, searching, drafting, and internal record-keeping alone", () => {
    for (const name of [
      "GMAIL_FETCH_EMAILS",
      "GMAIL_LIST_THREADS",
      "GMAIL_CREATE_EMAIL_DRAFT",
      "SLACK_SEARCH_MESSAGES",
      "REDDIT_GET_POST",
      "STRIPE_LIST_CHARGES",
      "GITHUB_GET_A_PULL_REQUEST",
      "GITHUB_CREATE_AN_ISSUE",
      "LINEAR_CREATE_ISSUE",
      "NOTION_CREATE_PAGE",
      "GOOGLESHEETS_BATCH_UPDATE",
      "GOOGLECALENDAR_CREATE_EVENT",
      "mcp__claude_ai_Gmail__search_threads",
      "mcp__claude_ai_Linear__save_issue",
      "mcp__computer__click",
      "Bash",
      "Read",
      "Edit",
    ]) {
      expect(isOutboundTool(name), name).toBe(false);
    }
  });
});

describe("normalizeOutboundPolicy", () => {
  it("accepts ask and allow with a whole-number daily cap", () => {
    expect(normalizeOutboundPolicy({ policy: "ask" })).toEqual({ policy: "ask", dailyCap: OUTBOUND_DEFAULT_CAP });
    expect(normalizeOutboundPolicy({ policy: "allow", dailyCap: 10 })).toEqual({ policy: "allow", dailyCap: 10 });
  });

  it("refuses anything else", () => {
    expect(normalizeOutboundPolicy({ policy: "yes" })).toBeNull();
    expect(normalizeOutboundPolicy({ policy: "allow", dailyCap: 0 })).toBeNull();
    expect(normalizeOutboundPolicy({ policy: "allow", dailyCap: 2.5 })).toBeNull();
    expect(normalizeOutboundPolicy({ policy: "allow", dailyCap: 100_000 })).toBeNull();
    expect(normalizeOutboundPolicy("allow")).toBeNull();
    expect(normalizeOutboundPolicy(null)).toBeNull();
  });
});

describe("connectorCallsIn", () => {
  // Composio's session exposes a handful of meta tools; the app tools run
  // inside them. The gate has to see through the wrapper or it sees nothing.
  it("returns a direct app tool as itself", () => {
    expect(connectorCallsIn("GMAIL_SEND_EMAIL", { to: "a@b.c" })).toEqual([{ slug: "GMAIL_SEND_EMAIL", arguments: { to: "a@b.c" } }]);
  });

  it("unwraps every tool inside a multi-execute call", () => {
    const calls = connectorCallsIn("COMPOSIO_MULTI_EXECUTE_TOOL", {
      tools: [
        { tool_slug: "GMAIL_FETCH_EMAILS", arguments: { query: "is:unread" } },
        { tool_slug: "SLACK_SEND_MESSAGE", arguments: { channel: "#ops", text: "hi" } },
      ],
      sync_response_to_workbench: false,
    });
    expect(calls.map((call) => call.slug)).toEqual(["GMAIL_FETCH_EMAILS", "SLACK_SEND_MESSAGE"]);
    expect(calls[1].arguments).toEqual({ channel: "#ops", text: "hi" });
  });

  it("reads tool slugs out of workbench code, and treats a raw API proxy as a send", () => {
    const code = 'for id in ids:\n    run_tool("GMAIL_SEND_EMAIL", {"thread_id": id})\nrun_tool("GMAIL_FETCH_EMAILS", {})';
    expect(connectorCallsIn("COMPOSIO_REMOTE_WORKBENCH", { code_to_execute: code }).map((call) => call.slug)).toEqual([
      "GMAIL_SEND_EMAIL",
      "GMAIL_FETCH_EMAILS",
    ]);
    expect(connectorCallsIn("COMPOSIO_REMOTE_WORKBENCH", { code_to_execute: "proxy_execute('POST', 'https://api.x.com')" })
      .map((call) => call.slug)).toEqual(["COMPOSIO_PROXY_EXECUTE"]);
  });

  it("ignores the other meta tools and malformed arguments", () => {
    expect(connectorCallsIn("COMPOSIO_SEARCH_TOOLS", { queries: [{ use_case: "send an email" }] })).toEqual([]);
    expect(connectorCallsIn("COMPOSIO_MULTI_EXECUTE_TOOL", { tools: "nope" })).toEqual([]);
    expect(connectorCallsIn("COMPOSIO_MULTI_EXECUTE_TOOL", undefined)).toEqual([]);
  });
});

describe("outboundCallsIn", () => {
  it("keeps only the calls that send", () => {
    const sends = outboundCallsIn("COMPOSIO_MULTI_EXECUTE_TOOL", {
      tools: [{ tool_slug: "GMAIL_FETCH_EMAILS" }, { tool_slug: "GMAIL_SEND_EMAIL", arguments: { to: "x" } }],
    });
    expect(sends.map((call) => call.slug)).toEqual(["GMAIL_SEND_EMAIL"]);
    expect(outboundCallsIn("GMAIL_FETCH_EMAILS", {})).toEqual([]);
    expect(isOutboundTool("COMPOSIO_PROXY_EXECUTE")).toBe(true);
  });
});
