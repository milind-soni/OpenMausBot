import { describe, expect, it } from "vitest";

import {
  DIRECT_APPS,
  directAppByName,
  directAppCardState,
  directAppCreateBody,
  directAppRedirectUri,
} from "./direct-apps.ts";
import { mcpOAuthRedirectUri } from "./mcp-oauth-redirect.ts";

describe("direct app authorization", () => {
  it("puts Outlook mail ahead of Gmail, then Slack", () => {
    expect(DIRECT_APPS.map((app) => app.name)).toEqual(["outlook", "gmail", "slack"]);
    expect(directAppByName("outlook")?.transport).toBe("graph");
    expect(directAppByName("outlook")?.scopes).toEqual([
      "offline_access",
      "https://graph.microsoft.com/Mail.ReadWrite",
      "https://graph.microsoft.com/Mail.Send",
    ]);
    expect(JSON.stringify(DIRECT_APPS)).not.toContain("workiq");
    expect(directAppByName("gmail")?.url).toBe("https://gmailmcp.googleapis.com/mcp/v1");
    expect(directAppByName("slack")?.url).toBe("https://mcp.slack.com/mcp");
    expect(directAppByName("gmail")?.scopes).toEqual([
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.compose",
    ]);
    expect(directAppByName("slack")?.scopes).toEqual([]);
    expect(directAppByName("gmail")?.draftsOnly).toBe(true);
    expect(directAppCreateBody(directAppByName("outlook")!, { clientId: "id", clientSecret: "secret" })).toEqual({
      ok: false,
      error: "not-mcp",
    });
  });

  it("shows a stable loopback redirect before the server is saved", () => {
    const gmail = directAppByName("gmail");
    expect(gmail).toBeTruthy();
    expect(directAppRedirectUri(gmail!)).toBe(mcpOAuthRedirectUri(gmail!.url));
    expect(directAppRedirectUri(gmail!)).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp-oauth\/callback$/);
  });

  it("refuses a grant with no client credentials", () => {
    const gmail = directAppByName("gmail")!;
    expect(directAppCreateBody(gmail, { clientId: "  ", clientSecret: "secret" })).toEqual({ ok: false, error: "client-id" });
    expect(directAppCreateBody(gmail, { clientId: "id", clientSecret: "" })).toEqual({ ok: false, error: "client-secret" });
  });

  it("builds one server per app and sends Gmail's scopes only", () => {
    const gmail = directAppCreateBody(directAppByName("gmail")!, { clientId: " google ", clientSecret: " secret " });
    expect(gmail).toEqual({
      ok: true,
      body: {
        name: "gmail",
        type: "http",
        url: "https://gmailmcp.googleapis.com/mcp/v1",
        headers: {},
        oauth: {
          clientId: "google",
          clientSecret: "secret",
          scopes: [
            "https://www.googleapis.com/auth/gmail.readonly",
            "https://www.googleapis.com/auth/gmail.compose",
          ],
        },
      },
    });
    const slack = directAppCreateBody(directAppByName("slack")!, { clientId: "slack-app", clientSecret: "shhh" });
    expect(slack.ok && slack.body.oauth).toEqual({ clientId: "slack-app", clientSecret: "shhh" });
  });

  it("does not treat a same-name server on another address as this app", () => {
    const gmail = directAppByName("gmail")!;
    expect(directAppCardState(gmail, [])).toEqual({ kind: "create" });
    expect(directAppCardState(gmail, [{ name: "gmail", url: "https://example.test/mcp", enabled: true }])).toEqual({ kind: "name-taken" });
    expect(directAppCardState(gmail, [{ name: "gmail", url: gmail.url, enabled: false, auth: "needs-sign-in" }])).toEqual({
      kind: "ready",
      enabled: false,
      auth: "needs-sign-in",
    });
  });
});
