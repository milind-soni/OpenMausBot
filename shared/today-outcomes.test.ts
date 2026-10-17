import { describe, expect, it } from "vitest";
import { classifyToolCall, isReportRoutine, minutesSaved, toolApps, type OutcomeCategory } from "./today-outcomes.ts";

const CASES: ReadonlyArray<[string, OutcomeCategory | null]> = [
  ["GMAIL_FETCH_EMAILS", "emailRead"],
  ["mcp__composio__GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID", "emailRead"],
  ["GMAIL_LIST_THREADS", "emailRead"],
  ["GMAIL_ADD_LABEL_TO_EMAIL", "emailRead"],
  ["GMAIL_MOVE_TO_TRASH", "emailRead"],
  ["OUTLOOK_LIST_MESSAGES", "emailRead"],
  ["mcp__claude_ai_Gmail__search_threads", "emailRead"],
  ["GMAIL_GET_PROFILE", null],
  ["GMAIL_LIST_LABELS", null],
  ["GMAIL_LIST_DRAFTS", null],
  ["GMAIL_CREATE_EMAIL_DRAFT", "draft"],
  ["OUTLOOK_CREATE_DRAFT_REPLY", "draft"],
  ["mcp__claude_ai_Gmail__create_draft", "draft"],
  ["GMAIL_SEND_DRAFT", "emailSent"],
  ["GMAIL_SEND_EMAIL", "emailSent"],
  ["GMAIL_REPLY_TO_THREAD", "emailSent"],
  ["OUTLOOK_SEND_EMAIL", "emailSent"],
  ["HUBSPOT_SEND_EMAIL", "emailSent"],
  ["SLACK_SEND_MESSAGE", "message"],
  ["SLACK_SENDS_A_MESSAGE_TO_A_SLACK_CHANNEL", "message"],
  ["SLACK_CHAT_POST_MESSAGE", "message"],
  ["WHATSAPP_SEND_MESSAGE", "message"],
  ["TELEGRAM_SEND_MESSAGE", "message"],
  ["MICROSOFT_TEAMS_TEAMS_POST_CHANNEL_MESSAGE", "message"],
  ["TWITTER_CREATION_OF_A_POST", "message"],
  ["LINKEDIN_CREATE_LINKED_IN_POST", "message"],
  ["SLACK_FETCH_CONVERSATION_HISTORY", null],
  ["NOTION_CREATE_PAGE", "doc"],
  ["NOTION_APPEND_BLOCK_CHILDREN", "doc"],
  ["GOOGLEDOCS_CREATE_DOCUMENT", "doc"],
  ["GOOGLESHEETS_BATCH_UPDATE", "doc"],
  ["WORDPRESS_CREATE_POST", "doc"],
  ["mcp__notion__notion-create-pages", "doc"],
  ["NOTION_QUERY_DATABASE", null],
  ["GOOGLESHEETS_BATCH_GET", null],
  ["HUBSPOT_CREATE_CONTACT", "lead"],
  ["SALESFORCE_CREATE_LEAD", "lead"],
  ["PIPEDRIVE_ADD_A_PERSON", "lead"],
  ["APOLLO_PEOPLE_SEARCH", "lead"],
  ["HUNTER_EMAIL_FINDER", "lead"],
  ["mcp__highlevel__HIGHLEVEL_CREATE_CONTACT", "lead"],
  ["HUBSPOT_LIST_CONTACTS", null],
  ["STRIPE_CREATE_REFUND", "other"],
  ["GOOGLECALENDAR_CREATE_EVENT", "other"],
  ["GITHUB_CREATE_AN_ISSUE", "other"],
  ["COMPOSIO_REMOTE_WORKBENCH", "other"],
  ["GOOGLECALENDAR_FIND_EVENT", null],
  ["COMPOSIO_SEARCH_TOOLS", null],
  ["mcp__composio__COMPOSIO_MANAGE_CONNECTIONS", null],
  ["Bash", null],
  ["Read", null],
  ["WebSearch", null],
  ["git status", null],
  ["post_to_room", null],
  ["mcp__agents__post_to_room", null],
  ["mcp__computer__screenshot", null],
  ["error: Your ChatGPT sign-in has expired", null],
];

describe("the outcome a finished tool call counts as", () => {
  it.each(CASES)("%s", (name, expected) => {
    expect(classifyToolCall(name)).toEqual(expected ? [expected] : []);
  });

  it("reads every app tool a multi-execute call ran from its recorded input", () => {
    const input = JSON.stringify({ tools: [
      { tool_slug: "GMAIL_FETCH_EMAILS", arguments: { query: "is:unread" } },
      { tool_slug: "GMAIL_SEND_EMAIL", arguments: { to: "ada@example.test" } },
      { tool_slug: "GOOGLECALENDAR_FIND_EVENT", arguments: {} },
    ] }, null, 2);
    expect(classifyToolCall("mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL", input)).toEqual(["emailRead", "emailSent"]);
    expect(classifyToolCall("COMPOSIO_MULTI_EXECUTE_TOOL", input)).toEqual(["emailRead", "emailSent"]);
    expect(toolApps("COMPOSIO_MULTI_EXECUTE_TOOL", input)).toEqual(["GMAIL", "GOOGLECALENDAR"]);
  });

  it("reads the slugs of a preview cut short, and counts a call it cannot read once", () => {
    const cut = `{\n  "tools": [\n    {\n      "tool_slug": "SLACK_SEND_MESSAGE",\n      "arguments": {}\n    },\n    {\n      "tool_slug": "NOTION_CREATE_PAGE",\n      "arguments": {\n        "title": "Week${"x".repeat(40)}\n[… preview shortened]`;
    expect(classifyToolCall("COMPOSIO_MULTI_EXECUTE_TOOL", cut)).toEqual(["message", "doc"]);
    expect(classifyToolCall("COMPOSIO_MULTI_EXECUTE_TOOL")).toEqual(["other"]);
    expect(classifyToolCall("COMPOSIO_MULTI_EXECUTE_TOOL", "{\"thought\": \"look things up\"}")).toEqual(["other"]);
  });

  it("names the app a tool belongs to", () => {
    expect(toolApps("mcp__composio__GMAIL_SEND_EMAIL")).toEqual(["GMAIL"]);
    expect(toolApps("mcp__claude_ai_Google_Drive__search_files")).toEqual(["GOOGLEDRIVE"]);
    expect(toolApps("Bash")).toEqual([]);
    expect(toolApps("COMPOSIO_SEARCH_TOOLS")).toEqual([]);
  });
});

describe("reports and the time-saved estimate", () => {
  it.each([["Morning briefing", true], ["Weekly sales report", true], ["Inbox digest", true], ["KPI roundup", true], ["Inbox sweep", false], ["Update CRM", false]] as const)(
    "%s is a report: %s", (name, report) => expect(isReportRoutine(name)).toBe(report));

  it("adds the minutes each outcome stands for", () => {
    expect(minutesSaved({})).toBe(0);
    expect(minutesSaved({ emailRead: 10, draft: 2, emailSent: 3, message: 1, doc: 1, report: 1, lead: 4, other: 5 })).toBe(20 + 10 + 12 + 2 + 10 + 15 + 12 + 5);
  });
});
