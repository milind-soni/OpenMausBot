import { describe, expect, it } from "vitest";

import {
  connectorAccessDecision,
  describeConnectorScopes,
  grantScopedApps,
  isReadOnlyAction,
  normalizeConnectorScopes,
  toolkitOf,
  widensConnectorScopes,
} from "./connector-scopes.ts";

describe("toolkitOf", () => {
  it("takes the toolkit from a Composio slug, lower-cased", () => {
    expect(toolkitOf("GMAIL_SEND_EMAIL")).toBe("gmail");
    expect(toolkitOf("GOOGLESHEETS_BATCH_UPDATE")).toBe("googlesheets");
    expect(toolkitOf("COMPOSIO_PROXY_EXECUTE")).toBe("composio");
    expect(toolkitOf("_1PASSWORD_GET_ITEM")).toBe("_1password");
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
    expect(isReadOnlyAction("_1PASSWORD_GET_ITEM")).toBe(true);
    expect(isReadOnlyAction("_1PASSWORD_LIST_ITEMS")).toBe(true);
    expect(isReadOnlyAction("_1PASSWORD_CREATE_ITEM")).toBe(false);
  });

  it("takes the second word as the verb only for toolkits that name the resource first", () => {
    expect(isReadOnlyAction("HIGHLEVEL_MCP_CONTACTS_GET_CONTACTS", "highlevel_mcp")).toBe(true);
    expect(isReadOnlyAction("HIGHLEVEL_MCP_CONTACTS_GET_CONTACTS")).toBe(true);
    expect(isReadOnlyAction("HIGHLEVEL_MCP_CONTACTS_ADD_TAGS", "highlevel_mcp")).toBe(false);
    expect(isReadOnlyAction("MAILCHIMP_CREATE_LIST")).toBe(false);
    expect(isReadOnlyAction("SOMEAPP_CONTACTS_GET_CONTACTS")).toBe(false);
    expect(isReadOnlyAction("HIGHLEVEL_MCP_CONTACTS_GET_CONTACTS", "highlevel")).toBe(false);
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
  it("uses the full connected service slug for underscored read-only apps", () => {
    expect(connectorAccessDecision({ apps: { bland_ai: "read" } }, [{ slug: "BLAND_AI_GET_CALL" }], ["bland", "bland_ai"])).toEqual({ ok: true });
    expect(connectorAccessDecision({ apps: { bland_ai: "read" } }, [{ slug: "BLAND_AI_SEND_CALL" }], ["bland_ai"])).toMatchObject({ ok: false, reason: "write" });
  });
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

  it("never treats inherited dictionary properties as app grants", () => {
    expect(connectorAccessDecision({ apps: {} }, calls("CONSTRUCTOR_SEND_EMAIL"))).toMatchObject({ ok: false, reason: "app" });
    expect(normalizeConnectorScopes(JSON.parse('{"apps":{"__proto__":"read"}}'))).toBeNull();
    const scoped = normalizeConnectorScopes({ apps: { constructor: "read" } })!;
    expect(Object.keys(scoped.apps)).toEqual(["constructor"]);
    expect(connectorAccessDecision(scoped, calls("CONSTRUCTOR_SEND_EMAIL"))).toMatchObject({ ok: false, reason: "write" });
    expect(connectorAccessDecision(scoped, calls("CONSTRUCTOR_GET_EMAIL"))).toEqual({ ok: true });
  });

  it("refuses a write on a read-only app, and allows the read", () => {
    expect(connectorAccessDecision({ apps: { gmail: "read" } }, calls("GMAIL_FETCH_EMAILS"))).toEqual({ ok: true });
    expect(connectorAccessDecision({ apps: { gmail: "read" } }, calls("GMAIL_SEND_EMAIL"))).toEqual({
      ok: false,
      slug: "GMAIL_SEND_EMAIL",
      toolkit: "gmail",
      reason: "write",
    });
    expect(connectorAccessDecision({ apps: { _1password: "read" } }, calls("_1PASSWORD_GET_ITEM"))).toEqual({ ok: true });
    expect(connectorAccessDecision({ apps: { _1password: "read" } }, calls("_1PASSWORD_CREATE_ITEM"))).toEqual({
      ok: false,
      slug: "_1PASSWORD_CREATE_ITEM",
      toolkit: "_1password",
      reason: "write",
    });
  });

  it("reads HighLevel MCP actions, which name the resource before the verb, on a read-only grant", () => {
    const highlevel = { apps: { highlevel_mcp: "read" as const } };
    for (const slug of ["HIGHLEVEL_MCP_CONTACTS_GET_CONTACTS", "HIGHLEVEL_MCP_OPPORTUNITIES_GET_PIPELINES", "HIGHLEVEL_MCP_OPPORTUNITIES_SEARCH_OPPORTUNITY"]) {
      expect(connectorAccessDecision(highlevel, calls(slug), ["highlevel_mcp"])).toEqual({ ok: true });
    }
    for (const slug of ["HIGHLEVEL_MCP_CONTACTS_UPDATE_CONTACT", "HIGHLEVEL_MCP_CONVERSATIONS_SEND_A_NEW_MESSAGE", "HIGHLEVEL_MCP_SOCIAL_MEDIA_POSTING_GET_POSTS"]) {
      expect(connectorAccessDecision(highlevel, calls(slug), ["highlevel_mcp"])).toMatchObject({ ok: false, reason: "write" });
    }
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

describe("grantScopedApps", () => {
  it("gives every tool to an app the scopes turn on and the tool list leaves out, and nothing else", () => {
    const bot: Parameters<typeof grantScopedApps>[0] = { connectorTools: {}, connectorScopes: { apps: { gmail: "read" } } };
    expect(grantScopedApps(bot)).toBe(true);
    expect(bot.connectorTools).toEqual({ gmail: { tools: "*" } });
    expect(grantScopedApps(bot), "once").toBe(false);
    const listed = { connectorTools: { gmail: { tools: ["GMAIL_FETCH_EMAILS"] } }, connectorScopes: { apps: { gmail: "write" as const } } };
    expect(grantScopedApps(listed)).toBe(false);
    expect(listed.connectorTools).toEqual({ gmail: { tools: ["GMAIL_FETCH_EMAILS"] } });
  });

  it("leaves a bot with no tool list or no scopes alone: every app, or what its list says", () => {
    const legacy = { connectorScopes: { apps: { gmail: "read" as const } } };
    expect(grantScopedApps(legacy)).toBe(false);
    expect(legacy).not.toHaveProperty("connectorTools");
    const off = { connectorTools: {} };
    expect(grantScopedApps(off)).toBe(false);
    expect(off.connectorTools).toEqual({});
  });
});

describe("per-account limits", () => {
  const scopes = normalizeConnectorScopes({ apps: { gmail: "write", slack: "read" }, accounts: { gmail: ["ca_work"] } })!;

  it("keeps an account list, and refuses an empty or malformed one", () => {
    expect(scopes.accounts).toEqual({ gmail: ["ca_work"] });
    expect(normalizeConnectorScopes({ apps: { gmail: "read" }, accounts: { gmail: [] } })).toBeNull();
    expect(normalizeConnectorScopes({ apps: { gmail: "read" }, accounts: { gmail: ["bad id"] } })).toBeNull();
    expect(normalizeConnectorScopes({ apps: { gmail: "read" }, accounts: ["ca_work"] })).toBeNull();
    expect(normalizeConnectorScopes({ apps: { gmail: "read" }, accounts: {} })).toEqual({ apps: { gmail: "read" } });
  });

  it("drops a limit for an app the bot may not use", () => {
    expect(normalizeConnectorScopes({ apps: { slack: "read" }, accounts: { gmail: ["ca_work"] } })).toEqual({ apps: { slack: "read" } });
  });

  it("allows a call naming an allowed account id", () => {
    expect(connectorAccessDecision(scopes, [{ slug: "GMAIL_SEND_EMAIL", account: "ca_work" }])).toEqual({ ok: true });
  });

  it("refuses another account, an alias, or none", () => {
    const refused = { ok: false, slug: "GMAIL_SEND_EMAIL", toolkit: "gmail", reason: "account", allowed: ["ca_work"] };
    expect(connectorAccessDecision(scopes, [{ slug: "GMAIL_SEND_EMAIL", account: "ca_home" }])).toEqual(refused);
    expect(connectorAccessDecision(scopes, [{ slug: "GMAIL_SEND_EMAIL", account: "work" }])).toEqual(refused);
    expect(connectorAccessDecision(scopes, [{ slug: "GMAIL_SEND_EMAIL", account: "CA_WORK" }])).toEqual(refused);
    expect(connectorAccessDecision(scopes, [{ slug: "GMAIL_SEND_EMAIL" }])).toEqual(refused);
  });

  it("leaves apps without a limit, and bots without limits, alone", () => {
    expect(connectorAccessDecision(scopes, [{ slug: "SLACK_LIST_CHANNELS" }])).toEqual({ ok: true });
    expect(connectorAccessDecision({ apps: { gmail: "write" } }, [{ slug: "GMAIL_SEND_EMAIL", account: "ca_home" }])).toEqual({ ok: true });
    expect(connectorAccessDecision(undefined, [{ slug: "GMAIL_SEND_EMAIL" }])).toEqual({ ok: true });
  });

  it("refuses a whole batch when one call uses a forbidden account", () => {
    const calls = [{ slug: "GMAIL_FETCH_EMAILS", account: "ca_work" }, { slug: "GMAIL_SEND_EMAIL", account: "ca_home" }];
    expect(connectorAccessDecision(scopes, calls).ok).toBe(false);
  });

  it("tells the bot which account to name", () => {
    expect(describeConnectorScopes(scopes)).toContain('In gmail, use only account id "ca_work", and name it in each call\'s account field.');
    expect(describeConnectorScopes({ apps: { gmail: "read" } })).not.toContain("account");
  });

  it("counts a dropped limit or an added account as widening", () => {
    const two = { apps: { gmail: "write" as const, slack: "read" as const }, accounts: { gmail: ["ca_work", "ca_home"] } };
    expect(widensConnectorScopes(scopes, two)).toBe(true);
    expect(widensConnectorScopes(scopes, { apps: { gmail: "write", slack: "read" } })).toBe(true);
    expect(widensConnectorScopes(two, scopes)).toBe(false);
    expect(widensConnectorScopes(scopes, { apps: { slack: "read" } })).toBe(false);
    expect(widensConnectorScopes({ apps: { gmail: "write", slack: "read" } }, scopes)).toBe(false);
  });

  it("counts removed limits, a new app or read raised to write as widening, and nothing for an unscoped bot", () => {
    expect(widensConnectorScopes(scopes, undefined)).toBe(true);
    expect(widensConnectorScopes({ apps: { gmail: "read" } }, { apps: { gmail: "read", slack: "read" } })).toBe(true);
    expect(widensConnectorScopes({ apps: { gmail: "read" } }, { apps: { gmail: "write" } })).toBe(true);
    expect(widensConnectorScopes({ apps: { gmail: "write" } }, { apps: { gmail: "read" } })).toBe(false);
    expect(widensConnectorScopes(undefined, scopes)).toBe(false);
  });
});

it.each(["_1password", "_" + "a".repeat(63), " _1PASSWORD "])("normalizes toolkit scope %s", (slug) => {
  expect(normalizeConnectorScopes({ apps: { [slug]: "read" } })).toEqual({ apps: { [slug.trim().toLowerCase()]: "read" } });
});
it.each(["", "-x", "Bad Slug", "a/b", "__proto__", "a".repeat(65)])("rejects invalid toolkit scope %s", (slug) => {
  expect(normalizeConnectorScopes({ apps: { [slug]: "read" } })).toBeNull();
});
