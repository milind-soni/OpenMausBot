import { describe, expect, it } from "vitest";

import { isOutboundTool, isReadOnlyTool } from "../shared/outbound.ts";

import { providerMcpTool, providerToolAllowKey } from "./provider-tool-allow.ts";

describe("provider MCP tool grants", () => {
  it("parses the server and exact tool from provider-facing names", () => {
    expect(providerMcpTool("mcp__linear__list_issues")).toEqual({ server: "linear", tool: "list_issues" });
    expect(providerMcpTool("mcp__my_server__get_item__v2")).toEqual({ server: "my_server", tool: "get_item__v2" });
    expect(providerMcpTool("Bash")).toBeNull();
    expect(providerMcpTool("mcp____list_issues")).toBeNull();
  });

  it("creates durable keys only for exact read tools", () => {
    const config = { type: "http", url: "https://linear.example/mcp", headers: { Authorization: "secret" } };
    expect(providerToolAllowKey("claude", "mcp__linear__list_issues", config))
      .toMatch(/^provider-tool:claude:linear:list_issues:[a-f0-9]{16}$/);
    expect(providerToolAllowKey("claude", "mcp__linear__save_issue", config)).toBeNull();
    expect(providerToolAllowKey("claude", "mcp__computer__click", config)).toBeNull();
    expect(providerToolAllowKey("", "mcp__linear__list_issues", config)).toBeNull();
  });

  it.each(["pull_request_read", "issue_read"])("remembers GitHub's exact %s dispatcher without changing generic read classification", (tool) => {
    const config = { command: "/opt/worker-tools/github-readonly", args: ["stdio", "--read-only"] };
    const name = `mcp__github-hel1__${tool}`;
    const key = providerToolAllowKey("hel1-codex", name, config);
    expect(key).toMatch(new RegExp(`^provider-tool:hel1-codex:github-hel1:${tool}:[a-f0-9]{16}$`));
    expect(providerToolAllowKey("other-codex", name, config)).not.toBe(key);
    expect(providerToolAllowKey("hel1-codex", `mcp__other-github__${tool}`, config)).not.toBe(key);
    expect(providerToolAllowKey("hel1-codex", name, { ...config, args: ["stdio"] })).not.toBe(key);
    expect(providerToolAllowKey("", name, config)).toBeNull();
    expect(providerToolAllowKey("hel1-codex", tool, config)).toBeNull();
    expect(isReadOnlyTool(name)).toBe(false);
    expect(isOutboundTool(name)).toBe(false);
  });

  it.each([
    "pull_request_write", "issue_write", "pull_request_review_write", "create_pull_request",
    "merge_pull_request", "add_issue_comment", "create_issue", "delete_issue",
    "delete_repository_read", "send_message_read", "transfer_money_read", "pull_request_read_delete",
    "issue_read__send", "pull_request_readwrite", "issue_read_write", "call_tool_read",
  ])("does not remember write actions or read suffix lookalikes: %s", (tool) => {
    expect(providerToolAllowKey("hel1-codex", `mcp__github-hel1__${tool}`, {})).toBeNull();
  });

  it("invalidates a key when the configured server changes", () => {
    const first = providerToolAllowKey("claude", "mcp__linear__list_issues", { url: "https://one.example/mcp" });
    const second = providerToolAllowKey("claude", "mcp__linear__list_issues", { url: "https://two.example/mcp" });
    expect(first).not.toBe(second);
  });
});
