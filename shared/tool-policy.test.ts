// The question this module exists to answer correctly: what did the bot
// actually ask to run? With a multiplexer mounted, the tool's own name does
// not say.
import { describe, expect, it } from "vitest";

import { bareToolSlug, innerToolSlugsOf, toolMultiplexes, toolPolicyVerdict } from "./tool-policy.ts";

const BUS_TOOLS = [
  "GOOGLESHEETS_BATCH_GET",
  "GOOGLESHEETS_BATCH_UPDATE",
  "GOOGLESHEETS_LOOKUP_SPREADSHEET_ROW",
  "GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND",
];

const verdict = (tool: string, innerToolSlugs?: string[], allowedToolSlugs = BUS_TOOLS) =>
  toolPolicyVerdict({ tool, innerToolSlugs, allowedToolSlugs });

describe("toolPolicyVerdict: the bus runs without a card", () => {
  it("allows a multiplexed call whose inner tools are all on the list", () => {
    expect(verdict("composio_COMPOSIO_MULTI_EXECUTE_TOOL", ["GOOGLESHEETS_BATCH_GET"]))
      .toEqual({ decision: "allow", reason: "tool policy: GOOGLESHEETS_BATCH_GET" });
    expect(verdict("composio_COMPOSIO_MULTI_EXECUTE_TOOL", [
      "GOOGLESHEETS_LOOKUP_SPREADSHEET_ROW",
      "GOOGLESHEETS_BATCH_UPDATE",
    ]).decision).toBe("allow");
  });

  it("allows a directly named tool", () => {
    expect(verdict("composio_GOOGLESHEETS_BATCH_GET").decision).toBe("allow");
    expect(verdict("mcp__composio__GOOGLESHEETS_BATCH_GET").decision).toBe("allow");
  });
});

describe("toolPolicyVerdict: the wrapper's name is never the grant", () => {
  // This is the whole reason the module reads inner slugs. A policy keyed on
  // the tool name would read as "allow one spreadsheet call" and in fact
  // allow every app the workspace has ever connected.
  it("refuses a multiplexer carrying a tool that is not on the list", () => {
    expect(verdict("composio_COMPOSIO_MULTI_EXECUTE_TOOL", ["INSTAGRAM_CREATE_POST"]))
      .toEqual({ decision: "ask", reason: "INSTAGRAM_CREATE_POST is not on the tool policy list" });
    expect(verdict("composio_COMPOSIO_MULTI_EXECUTE_TOOL", ["GMAIL_SEND_EMAIL"]).decision).toBe("ask");
  });

  it("refuses when ONE of several inner tools is not on the list", () => {
    // The half that was understood must not be approved.
    expect(verdict("composio_COMPOSIO_MULTI_EXECUTE_TOOL", [
      "GOOGLESHEETS_BATCH_GET",
      "INSTAGRAM_CREATE_POST",
    ]).decision).toBe("ask");
  });

  it("refuses a multiplexer listed by its own name", () => {
    // Even if an operator puts the wrapper on the list by mistake.
    expect(verdict("composio_COMPOSIO_MULTI_EXECUTE_TOOL", ["INSTAGRAM_CREATE_POST"],
      ["COMPOSIO_MULTI_EXECUTE_TOOL"]).decision).toBe("ask");
    expect(verdict("composio_COMPOSIO_MULTI_EXECUTE_TOOL", undefined,
      ["COMPOSIO_MULTI_EXECUTE_TOOL"]).decision).toBe("ask");
  });

  it("refuses a multiplexer nested inside a multiplexer", () => {
    expect(verdict("composio_COMPOSIO_MULTI_EXECUTE_TOOL", ["COMPOSIO_EXECUTE_TOOL"]).decision).toBe("ask");
  });

  it("refuses when the arguments could not be read", () => {
    expect(verdict("composio_COMPOSIO_MULTI_EXECUTE_TOOL", undefined).decision).toBe("ask");
    expect(verdict("composio_COMPOSIO_MULTI_EXECUTE_TOOL", []).decision).toBe("ask");
    expect(verdict("composio_COMPOSIO_MULTI_EXECUTE_TOOL", [""]).decision).toBe("ask");
  });
});

describe("toolPolicyVerdict: a send is never this policy's to approve", () => {
  // autoVerdict's outbound guard cannot catch these: it sees ACP's category,
  // "other", and isOutboundTool("other") is false. So the refusal has to live
  // here too, even though the relay's gate would also stop the send.
  it("refuses an outbound inner tool even when the operator listed it", () => {
    expect(toolPolicyVerdict({
      tool: "composio_COMPOSIO_MULTI_EXECUTE_TOOL",
      innerToolSlugs: ["GMAIL_SEND_EMAIL"],
      allowedToolSlugs: ["GMAIL_SEND_EMAIL"],
    })).toEqual({ decision: "ask", reason: "GMAIL_SEND_EMAIL sends something, which this policy never approves" });
  });

  it("refuses when one of several inner tools sends", () => {
    expect(toolPolicyVerdict({
      tool: "composio_COMPOSIO_MULTI_EXECUTE_TOOL",
      innerToolSlugs: ["GOOGLESHEETS_BATCH_GET", "GMAIL_SEND_EMAIL"],
      allowedToolSlugs: ["GOOGLESHEETS_BATCH_GET", "GMAIL_SEND_EMAIL"],
    }).decision).toBe("ask");
  });

  it("refuses a directly named outbound tool on the list", () => {
    expect(verdict("composio_GMAIL_SEND_EMAIL", undefined, ["GMAIL_SEND_EMAIL"]).decision).toBe("ask");
  });

  it("still allows a listed read", () => {
    expect(verdict("composio_COMPOSIO_MULTI_EXECUTE_TOOL", ["GOOGLESHEETS_BATCH_GET"]).decision).toBe("allow");
  });
});

describe("toolPolicyVerdict: off by default, and fail closed", () => {
  it("asks when no list is configured", () => {
    expect(verdict("composio_GOOGLESHEETS_BATCH_GET", undefined, []))
      .toEqual({ decision: "ask", reason: "no tool policy configured" });
  });

  it("asks for any tool that is not listed", () => {
    expect(verdict("composio_GMAIL_SEND_EMAIL").decision).toBe("ask");
    expect(verdict("composio_COMPOSIO_SEARCH_TOOLS").decision).toBe("ask");
    expect(verdict("").decision).toBe("ask");
  });
});

describe("bareToolSlug / toolMultiplexes", () => {
  it("strips provider prefixes so a grant cannot be smuggled past", () => {
    expect(bareToolSlug("composio_COMPOSIO_MULTI_EXECUTE_TOOL")).toBe("COMPOSIO_MULTI_EXECUTE_TOOL");
    expect(bareToolSlug("mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL")).toBe("COMPOSIO_MULTI_EXECUTE_TOOL");
    expect(toolMultiplexes("mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL")).toBe(true);
    expect(toolMultiplexes("composio_GOOGLESHEETS_BATCH_GET")).toBe(false);
  });
});

describe("innerToolSlugsOf: the shape the engine really sends", () => {
  it("reads the observed Composio frame", () => {
    // Captured 2026-10-10 from a request.opened on this machine.
    expect(innerToolSlugsOf({
      arguments: {
        current_step: "CREATING_SPREADSHEET",
        session_id: "face",
        thought: "Create a new Google Spreadsheet titled Agent Bus",
        tools: [{ arguments: { title: "Agent Bus" }, tool_slug: "GOOGLESHEETS_CREATE_GOOGLE_SHEET1" }],
      },
    })).toEqual(["GOOGLESHEETS_CREATE_GOOGLE_SHEET1"]);
  });

  it("reads the same shape without the arguments wrapper", () => {
    expect(innerToolSlugsOf({ tools: [{ tool_slug: "GOOGLESHEETS_BATCH_GET" }] }))
      .toEqual(["GOOGLESHEETS_BATCH_GET"]);
    expect(innerToolSlugsOf({ tool_slug: "GOOGLESHEETS_BATCH_GET" })).toEqual(["GOOGLESHEETS_BATCH_GET"]);
  });

  it("fails the whole read rather than returning a partial list", () => {
    // A partial list would approve the entries it understood.
    expect(innerToolSlugsOf({ tools: [{ tool_slug: "GOOGLESHEETS_BATCH_GET" }, { tool_slug: 42 }] })).toBeUndefined();
    expect(innerToolSlugsOf({ tools: [{ tool_slug: "GOOGLESHEETS_BATCH_GET" }, "not an object"] })).toBeUndefined();
    expect(innerToolSlugsOf({ tools: [{ tool_slug: "  " }] })).toBeUndefined();
  });

  it("returns undefined for a shape it does not recognise", () => {
    expect(innerToolSlugsOf(undefined)).toBeUndefined();
    expect(innerToolSlugsOf(null)).toBeUndefined();
    expect(innerToolSlugsOf("ls")).toBeUndefined();
    expect(innerToolSlugsOf([{ tool_slug: "X" }])).toBeUndefined();
    expect(innerToolSlugsOf({ command: "ls -la" })).toBeUndefined();
  });

  it("reads an empty tools array as empty, not as unreadable", () => {
    // The policy refuses both, but they are different facts.
    expect(innerToolSlugsOf({ tools: [] })).toEqual([]);
  });
});
