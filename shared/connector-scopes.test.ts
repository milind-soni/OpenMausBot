import { describe, expect, it } from "vitest";

import {
  CONNECTOR_SCOPES,
  classifyTool,
  evaluateConnectorCall,
  normalizeConnectorGrants,
  type ConnectorGrants,
} from "./connector-scopes.ts";

describe("connector tool classification", () => {
  it("exposes the five explicit verb classes", () => {
    expect(CONNECTOR_SCOPES).toEqual(["read", "draft", "send", "modify", "delete"]);
  });

  it.each([
    ["GMAIL_FETCH_EMAILS", "read"],
    ["GMAIL_LIST_THREADS", "read"],
    ["GMAIL_CREATE_EMAIL_DRAFT", "draft"],
    ["GMAIL_SEND_EMAIL", "send"],
    ["SLACK_SENDS_A_MESSAGE_TO_A_SLACK_CHANNEL", "send"],
    ["GITHUB_UPDATE_A_REPOSITORY", "modify"],
    ["GITHUB_DELETE_A_REPOSITORY", "delete"],
    ["NOTION_ADD_PAGE_CONTENT", "modify"],
  ] as const)("classifies %s as %s", (name, scope) => {
    expect(classifyTool(name)).toBe(scope);
  });

  it("is case-insensitive and ignores generated filler words", () => {
    expect(classifyTool("slack_sends_a_message_to_a_slack_channel")).toBe("send");
    expect(classifyTool("github_update_the_repository")).toBe("modify");
  });

  it("fails closed for an unrecognized tool", () => {
    expect(classifyTool("ACME_FROBNICATE_WIDGET")).toBe("delete");
  });
});

describe("connector grants", () => {
  it("normalizes and validates account-pinned grants", () => {
    expect(normalizeConnectorGrants({
      Gmail: { accountId: "work-account", scopes: ["read", "send"] },
      slack: { scopes: ["read"] },
    })).toEqual({
      gmail: { accountId: "work-account", scopes: ["read", "send"] },
      slack: { scopes: ["read"] },
    });
  });

  it("rejects malformed grants and duplicate scopes", () => {
    expect(normalizeConnectorGrants(null)).toBeNull();
    expect(normalizeConnectorGrants({ gmail: { scopes: ["admin"] } })).toBeNull();
    expect(normalizeConnectorGrants({ gmail: { scopes: ["read", "read"] } })).toBeNull();
    expect(normalizeConnectorGrants({ "bad slug!": { scopes: ["read"] } })).toBeNull();
    expect(normalizeConnectorGrants({ gmail: { accountId: "bad account!", scopes: ["read"] } })).toBeNull();
  });

  it("allows only the granted toolkit, verb, and selected account", () => {
    const grants: ConnectorGrants = {
      gmail: { accountId: "work-account", scopes: ["read", "send"] },
    };
    expect(evaluateConnectorCall(grants, "gmail", "GMAIL_FETCH_EMAILS", "work-account")).toEqual({ ok: true });
    expect(evaluateConnectorCall(grants, "gmail", "GMAIL_SEND_EMAIL", "work-account")).toEqual({ ok: true });
    expect(evaluateConnectorCall(grants, "gmail", "GMAIL_CREATE_EMAIL_DRAFT", "work-account")).toMatchObject({
      ok: false,
      reason: "scope",
      required: "draft",
    });
    expect(evaluateConnectorCall(grants, "gmail", "GMAIL_FETCH_EMAILS", "personal-account")).toMatchObject({
      ok: false,
      reason: "account",
    });
    expect(evaluateConnectorCall(grants, "slack", "SLACK_SEARCH_MESSAGES")).toMatchObject({
      ok: false,
      reason: "toolkit",
    });
  });

  it("treats an explicit empty grant map as no access but preserves legacy absence", () => {
    expect(evaluateConnectorCall(undefined, "gmail", "GMAIL_SEND_EMAIL")).toEqual({ ok: true });
    expect(evaluateConnectorCall({}, "gmail", "GMAIL_SEND_EMAIL")).toMatchObject({ ok: false, reason: "toolkit" });
  });

  it("fails closed for inherited object keys instead of treating them as grants", () => {
    expect(evaluateConnectorCall({}, "constructor", "CONSTRUCTOR_FETCH_RECORDS")).toMatchObject({
      ok: false,
      reason: "toolkit",
      toolkit: "constructor",
    });
  });

  it("rejects case-colliding toolkit keys instead of silently choosing one grant", () => {
    expect(normalizeConnectorGrants({
      Gmail: { scopes: ["read"] },
      gmail: { scopes: ["delete"] },
    })).toBeNull();
  });
});
