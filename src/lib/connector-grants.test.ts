import { describe, expect, it } from "vitest";

import {
  classifyConnectorTool,
  connectorGrantsState,
  connectorServiceAccess,
  isConnectorToolGrantShape,
  withServiceGrant,
} from "./connector-grants";

describe("connector grant shapes", () => {
  it("accepts the wildcard and explicit well-formed name lists only", () => {
    expect(isConnectorToolGrantShape({ tools: "*" })).toBe(true);
    expect(isConnectorToolGrantShape({ tools: ["GMAIL_SEND_EMAIL", "SLACK_POST_MESSAGE"] })).toBe(true);
    expect(isConnectorToolGrantShape({ tools: [] })).toBe(false);
    expect(isConnectorToolGrantShape({ tools: ["gmail_send_email"] })).toBe(false);
    expect(isConnectorToolGrantShape({ tools: "GMAIL_SEND_EMAIL" })).toBe(false);
    expect(isConnectorToolGrantShape(null)).toBe(false);
  });
});

describe("verb classes for tool names", () => {
  it("lets the more privileged class win regardless of word order", () => {
    expect(classifyConnectorTool("GMAIL_CREATE_AND_SEND_EMAIL")).toBe("send");
    expect(classifyConnectorTool("SLACK_DELETE_MESSAGE")).toBe("delete");
    expect(classifyConnectorTool("NOTION_CREATE_PAGE")).toBe("draft");
    expect(classifyConnectorTool("GMAIL_FETCH_EMAILS")).toBe("read");
    expect(classifyConnectorTool("SLACK_UPDATE_MESSAGE")).toBe("modify");
  });

  it("returns null for names outside the pattern or without a known verb", () => {
    expect(classifyConnectorTool("gmail_send_email")).toBeNull();
    expect(classifyConnectorTool("GMAIL_SNOOZE_THREAD")).toBeNull();
  });
});

describe("per-service access summaries", () => {
  it("treats an absent record as the legacy all-tools default", () => {
    expect(connectorServiceAccess(undefined, "gmail")).toEqual({ level: "all", count: 0, editable: true });
    expect(connectorServiceAccess(null, "gmail")).toEqual({ level: "all", count: 0, editable: true });
  });

  it("describes wildcards, exact lists and services a record leaves out", () => {
    const record = {
      gmail: { tools: "*" },
      slack: { tools: ["SLACK_POST_MESSAGE", "SLACK_LIST_MESSAGES"] },
    };
    expect(connectorServiceAccess(record, "gmail")).toEqual({ level: "all", count: 0, editable: true });
    expect(connectorServiceAccess(record, "slack")).toEqual({ level: "partial", count: 2, editable: true });
    expect(connectorServiceAccess(record, "notion")).toEqual({ level: "none", count: 0, editable: true });
  });

  it("renders shapes this build cannot read as read-only", () => {
    expect(connectorServiceAccess({ gmail: { tools: { prefix: "GMAIL_" } } }, "gmail"))
      .toEqual({ level: "partial", count: 0, editable: false });
    expect(connectorServiceAccess(["gmail"], "gmail"))
      .toEqual({ level: "partial", count: 0, editable: false });
  });

  it("rides the record-level editable flag even for a wildcard grant", () => {
    const record = { gmail: { tools: "*" }, notion: { tools: { prefix: "NOTION_" } } };
    expect(connectorServiceAccess(record, "gmail")).toEqual({ level: "all", count: 0, editable: false });
  });
});

describe("the Connected apps card state", () => {
  it("lets the off switch beat every grant detail", () => {
    expect(connectorGrantsState({ composio: false, connectorTools: { gmail: { tools: "*" } } })).toBe("off");
  });

  it("separates legacy full, explicit none, tailored partial and unreadable", () => {
    expect(connectorGrantsState({})).toBe("full");
    expect(connectorGrantsState({ connectorTools: {} })).toBe("none");
    expect(connectorGrantsState({ connectorTools: { gmail: { tools: "*" } } })).toBe("partial");
    expect(connectorGrantsState({ connectorTools: ["gmail"] })).toBe("unreadable");
    expect(connectorGrantsState({ connectorTools: { gmail: { tools: 3 } } })).toBe("unreadable");
  });
});

describe("saving a grant", () => {
  const apps = ["gmail", "slack", "notion"] as const;

  it("keeps the other connected apps at All tools when the record does not exist yet", () => {
    // An absent record means every app keeps every tool. Restricting one app
    // must not silently empty the rest.
    expect(withServiceGrant(undefined, "gmail", { tools: ["GMAIL_SEND_EMAIL"] }, apps)).toEqual({
      gmail: { tools: ["GMAIL_SEND_EMAIL"] },
      slack: { tools: "*" },
      notion: { tools: "*" },
    });
  });

  it("keeps the other connected apps at All tools when the first grant is a wildcard", () => {
    expect(withServiceGrant(null, "slack", { tools: "*" }, apps)).toEqual({
      gmail: { tools: "*" },
      slack: { tools: "*" },
      notion: { tools: "*" },
    });
  });

  it("leaves an existing record exactly as it was for the other apps", () => {
    const current = { gmail: { tools: "*" }, slack: { tools: ["SLACK_POST_MESSAGE"] } };
    expect(withServiceGrant(current, "gmail", { tools: ["GMAIL_FETCH_EMAILS"] }, apps)).toEqual({
      gmail: { tools: ["GMAIL_FETCH_EMAILS"] },
      slack: { tools: ["SLACK_POST_MESSAGE"] },
    });
  });

  it("still removes a service the person turns off, even after seeding", () => {
    const seeded = withServiceGrant(undefined, "gmail", { tools: "*" }, apps);
    expect(withServiceGrant(seeded, "notion", null, apps)).toEqual({
      gmail: { tools: "*" },
      slack: { tools: "*" },
    });
  });
});

describe("editing one service's grant", () => {
  it("creates the record on a first grant and keeps other services intact", () => {
    expect(withServiceGrant(undefined, "gmail", { tools: ["GMAIL_SEND_EMAIL"] }))
      .toEqual({ gmail: { tools: ["GMAIL_SEND_EMAIL"] } });
    expect(withServiceGrant(null, "gmail", { tools: ["GMAIL_SEND_EMAIL"] }))
      .toEqual({ gmail: { tools: ["GMAIL_SEND_EMAIL"] } });
    expect(withServiceGrant({ slack: { tools: "*" } }, "gmail", { tools: ["GMAIL_SEND_EMAIL"] }))
      .toEqual({ slack: { tools: "*" }, gmail: { tools: ["GMAIL_SEND_EMAIL"] } });
  });

  it("toggles All tools and back to the remembered explicit list", () => {
    const explicit = withServiceGrant(undefined, "gmail", { tools: ["GMAIL_FETCH_EMAILS", "GMAIL_SEND_EMAIL"] });
    const all = withServiceGrant(explicit, "gmail", { tools: "*" });
    expect(all).toEqual({ gmail: { tools: "*" } });
    expect(withServiceGrant(all, "gmail", { tools: ["GMAIL_FETCH_EMAILS", "GMAIL_SEND_EMAIL"] }))
      .toEqual({ gmail: { tools: ["GMAIL_FETCH_EMAILS", "GMAIL_SEND_EMAIL"] } });
  });

  it("removing the last explicit list keeps the record as the no-tools {}", () => {
    expect(withServiceGrant({ gmail: { tools: ["GMAIL_SEND_EMAIL"] } }, "gmail", null)).toEqual({});
  });

  it("refuses to edit a record it cannot read", () => {
    expect(withServiceGrant(["gmail"], "gmail", { tools: "*" })).toBeUndefined();
    expect(withServiceGrant({ gmail: { tools: 3 } }, "gmail", { tools: "*" })).toBeUndefined();
  });
});
