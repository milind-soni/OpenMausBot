import { describe, expect, it } from "vitest";

import type { ConnectorToolGrant } from "../shared/wire.ts";
import {
  COMPOSIO_MULTI_EXECUTE_TOOL,
  connectorCallFromFrame,
  connectorRefusalText,
  connectorUnrecognizedText,
  evaluateConnectorTools,
  serviceSlugFor,
} from "./connector-verdict.ts";

const toolsCall = (name: string, args: unknown) => ({
  jsonrpc: "2.0",
  id: 7,
  method: "tools/call",
  params: { name, arguments: args },
});

const multiExecute = (args: unknown) => toolsCall(COMPOSIO_MULTI_EXECUTE_TOOL, args);

describe("connectorCallFromFrame", () => {
  it("passes non-tool traffic and meta-tools through untouched", () => {
    expect(connectorCallFromFrame({ jsonrpc: "2.0", id: 1, method: "initialize" })).toEqual({ kind: "passthrough" });
    expect(connectorCallFromFrame({ jsonrpc: "2.0", id: 2, method: "tools/list" })).toEqual({ kind: "passthrough" });
    expect(connectorCallFromFrame(null)).toEqual({ kind: "passthrough" });
    expect(connectorCallFromFrame("notifications/initialized")).toEqual({ kind: "passthrough" });
    // Discovery and connection meta-tools keep their existing flows.
    expect(connectorCallFromFrame(toolsCall("COMPOSIO_SEARCH_TOOLS", { query: "gmail" }))).toEqual({ kind: "passthrough" });
    expect(connectorCallFromFrame(toolsCall("COMPOSIO_GET_TOOL_SCHEMAS", { tools: ["GMAIL_SEND_EMAIL"] })))
      .toEqual({ kind: "passthrough" });
    expect(connectorCallFromFrame(toolsCall("GMAIL_MANAGE_CONNECTIONS", {}))).toEqual({ kind: "passthrough" });
    expect(connectorCallFromFrame(toolsCall("SLACK_WAIT_FOR_CONNECTIONS", {}))).toEqual({ kind: "passthrough" });
  });

  it("reads a direct per-toolkit call", () => {
    expect(connectorCallFromFrame(toolsCall("GMAIL_SEND_EMAIL", { to: "a@b.c" })))
      .toEqual({ kind: "tools", invoked: "GMAIL_SEND_EMAIL", names: ["GMAIL_SEND_EMAIL"] });
  });

  it("reads every target from MULTI_EXECUTE, single and batched", () => {
    expect(connectorCallFromFrame(multiExecute({
      tools: [{ tool_slug: "GMAIL_SEND_EMAIL", arguments: {} }, { tool_slug: "SLACK_POST_MESSAGE", arguments: {} }],
      sync_response_to_workbench: false,
    }))).toEqual({
      kind: "tools",
      invoked: COMPOSIO_MULTI_EXECUTE_TOOL,
      names: ["GMAIL_SEND_EMAIL", "SLACK_POST_MESSAGE"],
    });
    expect(connectorCallFromFrame(multiExecute({
      tools: [{ tool_slug: "GMAIL_SEND_EMAIL", arguments: {} }],
      sync_response_to_workbench: false,
    }))).toEqual({ kind: "tools", invoked: COMPOSIO_MULTI_EXECUTE_TOOL, names: ["GMAIL_SEND_EMAIL"] });
    // The legacy single-object form still names exactly one tool.
    expect(connectorCallFromFrame(multiExecute({ tool_slug: "GMAIL_SEND_EMAIL", arguments: {} })))
      .toEqual({ kind: "tools", invoked: COMPOSIO_MULTI_EXECUTE_TOOL, names: ["GMAIL_SEND_EMAIL"] });
  });

  it("denies unrecognized shapes by default", () => {
    expect(connectorCallFromFrame(multiExecute({ sync_response_to_workbench: false })).kind).toBe("unrecognized");
    expect(connectorCallFromFrame(multiExecute({ tools: "GMAIL_SEND_EMAIL" })).kind).toBe("unrecognized");
    expect(connectorCallFromFrame(multiExecute({ tools: [] })).kind).toBe("unrecognized");
    expect(connectorCallFromFrame(multiExecute({ tools: [{ arguments: {} }] })).kind).toBe("unrecognized");
    expect(connectorCallFromFrame(multiExecute({ tools: [{ tool_slug: 42, arguments: {} }] })).kind).toBe("unrecognized");
    expect(connectorCallFromFrame(multiExecute("send the email")).kind).toBe("unrecognized");
    expect(connectorCallFromFrame(multiExecute(null)).kind).toBe("unrecognized");
    // A direct name that is not a Composio tool name cannot be checked.
    expect(connectorCallFromFrame(toolsCall("gmail_send_email", {})).kind).toBe("unrecognized");
    expect(connectorCallFromFrame({ jsonrpc: "2.0", id: 3, method: "tools/call", params: {} }).kind)
      .toBe("unrecognized");
    expect(connectorCallFromFrame({ jsonrpc: "2.0", id: 4, method: "tools/call" }).kind).toBe("unrecognized");
  });
});

describe("serviceSlugFor", () => {
  it("maps a tool name to its service slug", () => {
    expect(serviceSlugFor("GMAIL_SEND_EMAIL")).toBe("gmail");
    expect(serviceSlugFor("SLACK_POST_MESSAGE")).toBe("slack");
    expect(serviceSlugFor("GMAIL")).toBeNull();
    expect(serviceSlugFor("_SEND")).toBeNull();
  });
});

describe("evaluateConnectorTools", () => {
  it("passes everything for a legacy bot with no grants record", () => {
    const verdict = evaluateConnectorTools(["GMAIL_SEND_EMAIL", "SLACK_POST_MESSAGE"], undefined);
    expect(verdict).toMatchObject({ allowed: true, legacy: true, rule: "composio" });
  });

  it("denies everything when the grants record is empty", () => {
    const verdict = evaluateConnectorTools(["GMAIL_SEND_EMAIL"], {});
    expect(verdict.allowed).toBe(false);
    expect(verdict.denials).toEqual([{ tool: "GMAIL_SEND_EMAIL", service: "gmail", onGrantedService: false }]);
  });

  it("allows only the exact tools a service's list names", () => {
    const grants: Record<string, ConnectorToolGrant> = { gmail: { tools: ["GMAIL_SEND_EMAIL"] } };
    expect(evaluateConnectorTools(["GMAIL_SEND_EMAIL"], grants)).toMatchObject({
      allowed: true,
      rule: "connectorTools.gmail",
    });
    expect(evaluateConnectorTools(["GMAIL_FETCH_EMAILS"], grants).denials).toEqual([
      { tool: "GMAIL_FETCH_EMAILS", service: "gmail", onGrantedService: true },
    ]);
    expect(evaluateConnectorTools(["SLACK_POST_MESSAGE"], grants).denials).toEqual([
      { tool: "SLACK_POST_MESSAGE", service: "slack", onGrantedService: false },
    ]);
  });

  it("widens to every tool on a star-granted service and denies others", () => {
    const grants: Record<string, ConnectorToolGrant> = { gmail: { tools: "*" } };
    expect(evaluateConnectorTools(["GMAIL_SEND_EMAIL", "GMAIL_FETCH_EMAILS"], grants).allowed).toBe(true);
    expect(evaluateConnectorTools(["SLACK_POST_MESSAGE"], grants).allowed).toBe(false);
  });

  it("denies a name that maps to no service and judges a batch once per distinct tool", () => {
    const grants: Record<string, ConnectorToolGrant> = { gmail: { tools: "*" } };
    const verdict = evaluateConnectorTools(["GMAIL_SEND_EMAIL", "GMAIL_SEND_EMAIL", "GMAIL"], grants);
    expect(verdict.allowed).toBe(false);
    expect(verdict.denials).toEqual([{ tool: "GMAIL", service: null, onGrantedService: false }]);
  });
});

describe("refusal text", () => {
  it("names the refused tools and the person, never the grants", () => {
    const grants: Record<string, ConnectorToolGrant> = {
      gmail: { tools: "*" },
      slack: { tools: ["SLACK_POST_MESSAGE"] },
    };
    const verdict = evaluateConnectorTools(["SLACK_CREATE_CHANNEL"], grants);
    const text = connectorRefusalText(verdict.denials);
    expect(text).toContain("SLACK_CREATE_CHANNEL");
    expect(text).toContain("Ask the person");
    // Enumerating what the bot could have called teaches it to probe.
    expect(text).not.toContain("SLACK_POST_MESSAGE");
    expect(text).not.toContain("GMAIL");
  });

  it("names every refused tool in a batch", () => {
    const text = connectorRefusalText([
      { tool: "SLACK_CREATE_CHANNEL", service: "slack", onGrantedService: true },
      { tool: "NOTION_CREATE_PAGE", service: "notion", onGrantedService: false },
    ]);
    expect(text).toContain("SLACK_CREATE_CHANNEL");
    expect(text).toContain("NOTION_CREATE_PAGE");
    expect(text).toContain("are not granted");
  });

  it("explains an unrecognized shape without pointing at any tool list", () => {
    const text = connectorUnrecognizedText(COMPOSIO_MULTI_EXECUTE_TOOL, "the tools list was empty");
    expect(text).toContain(COMPOSIO_MULTI_EXECUTE_TOOL);
    expect(text).toContain("the tools list was empty");
    expect(text).toContain("Ask the person");
  });
});
