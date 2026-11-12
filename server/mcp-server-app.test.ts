import { describe, expect, it } from "vitest";

import { CURATED_CONNECTOR_SLUGS } from "../shared/connector-curated.ts";
import { knownMcpServerApp } from "./mcp-server-app.ts";

describe("the connected app an MCP server stands for", () => {
  it.each([
    ["any name", "https://gmailmcp.googleapis.com/mcp/v1", "gmail"],
    ["any name", "https://calendarmcp.googleapis.com/mcp/v1", "googlecalendar"],
    ["Gmail-work", "https://gmailmcp.googleapis.com/mcp/v1", "gmail"],
    ["gmail", "https://mcp.example/gmail", "gmail"],
    ["Gmail_MCP", "https://mcp.example/", "gmail"],
    ["google-calendar", "https://mcp.example/", "googlecalendar"],
    ["googlecalendar-mcp", "https://mcp.example/", "googlecalendar"],
    ["gcal", "not a url", "googlecalendar"],
  ])("knows %s at %s as %s", (name, url, slug) => {
    expect(knownMcpServerApp(name, url)?.slug).toBe(slug);
  });

  it.each([
    ["mail", "https://mail.example/mcp"],
    ["gmailer", "https://mail.example/mcp"],
    ["my-gmail", "https://mail.example/mcp"],
    ["Gmail-work", "https://mail.example/mcp"],
    ["gmail-filters", "https://mail.example/mcp"],
    ["gmail_to_notion", "https://mail.example/mcp"],
    ["gmail2", "https://mail.example/mcp"],
    ["gcal2notion", "https://cal.example/mcp"],
    ["calendar", "https://cal.example/mcp"],
    ["drive", "https://drivemcp.googleapis.com/mcp/v1"],
    ["anything", "https://gmailmcp.googleapis.com.example/mcp"],
  ])("leaves %s at %s alone", (name, url) => {
    expect(knownMcpServerApp(name, url)).toBeNull();
  });

  it("names only apps the connected-apps catalog has", () => {
    for (const [name, url] of [["gmail", ""], ["gcal", ""]] as const) {
      expect(CURATED_CONNECTOR_SLUGS).toContain(knownMcpServerApp(name, url)!.slug);
    }
  });
});
