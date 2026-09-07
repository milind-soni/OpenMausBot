import { describe, expect, it } from "vitest";

import {
  connectorAccessDecision,
  describeConnectorScopes,
  isReadOnlyAction,
  normalizeConnectorScopes,
  toolkitOf,
} from "./connector-scopes.ts";

describe("toolkitOf", () => {
  it("takes the toolkit from a Composio slug, lower-cased", () => {
    expect(toolkitOf("GMAIL_SEND_EMAIL")).toBe("gmail");
    expect(toolkitOf("GOOGLESHEETS_BATCH_UPDATE")).toBe("googlesheets");
    expect(toolkitOf("COMPOSIO_PROXY_EXECUTE")).toBe("composio");
  });
});

describe("isReadOnlyAction", () => {
  it("treats a read verb first as reading, everything else as writing", () => {
    expect(isReadOnlyAction("GMAIL_FETCH_EMAILS")).toBe(true);
    expect(isReadOnlyAction("SLACK_SEARCH_MESSAGES")).toBe(true);
    expect(isReadOnlyAction("GITHUB_GET_A_PULL_REQUEST")).toBe(true);
    expect(isReadOnlyAction("GMAIL_SEND_EMAIL")).toBe(false);
    expect(isReadOnlyAction("GOOGLESHEETS_BATCH_UPDATE")).toBe(false);
    expect(isReadOnlyAction("GMAIL_CREATE_EMAIL_DRAFT")).toBe(false);
    expect(isReadOnlyAction("COMPOSIO_PROXY_EXECUTE")).toBe(false);
  });
});

describe("normalizeConnectorScopes", () => {
  it("accepts a map of lower-case toolkit slugs to read or write", () => {
    expect(normalizeConnectorScopes({ apps: { Gmail: "read", slack: "write" } })).toEqual({ apps: { gmail: "read", slack: "write" } });
    expect(normalizeConnectorScopes({ apps: {} })).toEqual({ apps: {} });
  });

  it("refuses anything else", () => {
    expect(normalizeConnectorScopes({ apps: { gmail: "admin" } })).toBeNull();
    expect(normalizeConnectorScopes({ apps: { "bad slug!": "read" } })).toBeNull();
    expect(normalizeConnectorScopes({ apps: [] })).toBeNull();
    expect(normalizeConnectorScopes("gmail")).toBeNull();
  });
});

describe("connectorAccessDecision", () => {
  const calls = (...slugs: string[]) => slugs.map((slug) => ({ slug }));

  it("allows everything when the bot has no scopes", () => {
    expect(connectorAccessDecision(undefined, calls("GMAIL_SEND_EMAIL", "STRIPE_CREATE_REFUND"))).toEqual({ ok: true });
  });

  it("refuses an app that is not listed", () => {
    expect(connectorAccessDecision({ apps: { slack: "write" } }, calls("SLACK_SEARCH_MESSAGES", "GMAIL_FETCH_EMAILS"))).toEqual({
      ok: false,
      slug: "GMAIL_FETCH_EMAILS",
      toolkit: "gmail",
      reason: "app",
    });
  });

  it("refuses a write on a read-only app, and allows the read", () => {
    expect(connectorAccessDecision({ apps: { gmail: "read" } }, calls("GMAIL_FETCH_EMAILS"))).toEqual({ ok: true });
    expect(connectorAccessDecision({ apps: { gmail: "read" } }, calls("GMAIL_SEND_EMAIL"))).toEqual({
      ok: false,
      slug: "GMAIL_SEND_EMAIL",
      toolkit: "gmail",
      reason: "write",
    });
  });

  it("never lets a raw API proxy through a scoped bot", () => {
    expect(connectorAccessDecision({ apps: { gmail: "write" } }, calls("COMPOSIO_PROXY_EXECUTE"))).toMatchObject({ ok: false, reason: "app" });
  });
});

describe("describeConnectorScopes", () => {
  it("says what the bot may use, for its prompt", () => {
    expect(describeConnectorScopes(undefined)).toBe("");
    expect(describeConnectorScopes({ apps: {} })).toMatch(/no connected apps/i);
    const text = describeConnectorScopes({ apps: { gmail: "read", slack: "write" } });
    expect(text).toContain("gmail (read only)");
    expect(text).toContain("slack (read and write)");
  });
});
