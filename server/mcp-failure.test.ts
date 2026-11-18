import { describe, expect, it } from "vitest";

import { mcpFailureKind, mcpServerOfTool, mcpToolProblem } from "./mcp-failure.ts";

describe("why an MCP step failed", () => {
  it.each([
    ['The MCP server "mail" needs a sign-in before its tools work, and nobody has signed in (HTTP 401), so nothing ran.', "sign-in"],
    ['The MCP server "mail" refused the sign-in or key it was sent (HTTP 401), so nothing ran.', "refused"],
    ['MCP server "mail" needs authentication', "sign-in"],
    ['MCP server "mail" needs additional permissions (scope: "x")', "sign-in"],
    ['MCP server "mail" rejected the Authorization header in its config', "refused"],
    ['MCP server "mail" is not connected: boom', "cant-connect"],
    ['MCP server "mail" session expired', "cant-connect"],
    ['Dynamic Client Registration rejected (HTTP 404): {"error":"not_found"}', "sign-in"],
    ["HTTP 401 dialing http://127.0.0.1:18080/b/REDACTED/mcp-mail", "sign-in"],
    ["HTTP 403 dialing http://127.0.0.1:18080/b/REDACTED/mcp-mail", "refused"],
    ["HTTP 404 dialing http://127.0.0.1:18080/b/REDACTED/mcp-mail", "not-found"],
    ["HTTP 504 dialing http://127.0.0.1:18080/b/REDACTED/mcp-mail", "timeout"],
    ["Error dialing http://127.0.0.1:18080/b/REDACTED/mcp-mail", "cant-connect"],
    ["TypeError dialing http://127.0.0.1:18080/b/REDACTED/mcp-mail (ECONNREFUSED)", "cant-connect"],
    ["ECONNREFUSED: Unable to connect. Is the computer able to access the url?", "cant-connect"],
    ["MCP error -32001: Request timed out", "timeout"],
    ["MCP error -32000: Connection closed", "cant-connect"],
    ["MCP error -32603: This MCP server refused its credentials (HTTP 401). If it uses a sign-in", "refused"],
    ["This MCP server's address was not found (HTTP 404). Check its URL.", "not-found"],
    ["Could not reach this MCP server. Check its URL and that it is online.", "cant-connect"],
    ["MCP request timed out; execution outcome may be uncertain", "timeout"],
    ["MCP server exited before the session closed", "cant-connect"],
    ["<tool_use_error>MCP server \"mail\" needs authentication</tool_use_error>", "sign-in"],
  ] as const)("%s", (output, kind) => {
    expect(mcpFailureKind(output)).toBe(kind);
  });

  it.each([
    ["the chat runtime's result", JSON.stringify({ ok: false, result: "MCP request timed out; execution outcome may be uncertain" }, null, 2), "timeout"],
    ["MCP's own content list", JSON.stringify([{ type: "text", text: 'MCP server "mail" needs authentication' }], null, 2), "sign-in"],
    ["a chat-runtime tool's own error", JSON.stringify({ ok: false, result: "Thread not found" }, null, 2), null],
  ])("reads through %s", (_label, output, kind) => {
    expect(mcpFailureKind(output)).toBe(kind);
  });

  it.each(["Thread not found", "Invalid query: HTTP 401 from example.com", "The page answered 404", "Request failed because the mailbox is full"])("leaves the tool's own error alone: %s", (output) => {
    expect(mcpFailureKind(output)).toBeNull();
  });
});

describe("which server a step belongs to", () => {
  const servers = ["mail", "mail-work", "my.notes"];
  it.each([
    ["mcp__mail__search", "mail"],
    ["mcp__mail-work__search", "mail-work"],
    ["mail__search", "mail"],
    ["mail.search", "mail"],
    ["mail_search", "mail"],
    ["my_notes_read", "my.notes"],
  ])("%s", (tool, server) => { expect(mcpServerOfTool(tool, servers)).toBe(server); });

  it.each(["mcp__agents__list_bots", "Bash", "mailbox_search"])("none for %s", (tool) => { expect(mcpServerOfTool(tool, servers)).toBeUndefined(); });
});

describe("the line a person reads", () => {
  const servers = ["mail"];
  it("names the server, the reason and what to do", () => {
    expect(mcpToolProblem("mcp__mail__search", false, 'The MCP server "mail" needs a sign-in before its tools work.', servers))
      .toEqual({ problem: "mail needs you to sign in before its tools work. Open Apps → MCP servers and sign in to it." });
    expect(mcpToolProblem("mcp__mail__search", false, "TypeError dialing http://127.0.0.1:18080/b/REDACTED/mcp-mail (ECONNREFUSED)", servers))
      .toEqual({ problem: "Couldn't connect to mail. Test it in Apps → MCP servers to see why." });
  });

  it.each([
    ["a step that worked", "mcp__mail__search", true, "MCP request timed out"],
    ["a step with no output", "mcp__mail__search", false, undefined],
    ["a tool's own error", "mcp__mail__search", false, "Thread not found"],
    ["a tool of no configured server", "Bash", false, "MCP request timed out"],
  ])("has none for %s", (_label, tool, ok, output) => {
    expect(mcpToolProblem(tool, ok, output, servers)).toEqual({});
  });
});
