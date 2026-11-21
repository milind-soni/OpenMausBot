import { describe, expect, it } from "vitest";

import { providerMcpTool, providerToolAllowKey, providerToolConfig, savedToolGrant } from "./provider-tool-allow.ts";

describe("provider MCP tool grants", () => {
  it("parses the server and exact tool from provider-facing names", () => {
    expect(providerMcpTool("mcp__linear__list_issues")).toEqual({ server: "linear", tool: "list_issues" });
    expect(providerMcpTool("mcp__my_server__get_item__v2")).toEqual({ server: "my_server", tool: "get_item__v2" });
    expect(providerMcpTool("Bash")).toBeNull();
    expect(providerMcpTool("mcp____list_issues")).toBeNull();
  });

  it("creates durable keys for exact tools that send nothing and drive no computer or phone", () => {
    const config = { type: "http", url: "https://linear.example/mcp", headers: { Authorization: "secret" } };
    expect(providerToolAllowKey("claude", "mcp__linear__list_issues", config))
      .toMatch(/^provider-tool:claude:linear:list_issues:[a-f0-9]{16}$/);
    expect(providerToolAllowKey("claude", "mcp__linear__save_issue", config)).toMatch(/^provider-tool:claude:linear:save_issue:[a-f0-9]{16}$/);
    expect(providerToolAllowKey("claude", "mcp__gmail__send_email", config)).toBeNull();
    expect(providerToolAllowKey("claude", "mcp__linear__create_comment", config)).toBeNull();
    expect(providerToolAllowKey("claude", "mcp__telnyx__invoke_api_endpoint", config)).toBeNull();
    expect(providerToolAllowKey("claude", "mcp__computer__click", config)).toBeNull();
    expect(providerToolAllowKey("claude", "mcp__phone__tap", { builtin: "phone" })).toBeNull();
    expect(providerToolAllowKey("codex", "mcp__openmausbot_phone__tap_text", config)).toBeNull();
    expect(providerToolAllowKey("claude", "mcp__agents__shared_computer", { builtin: "agents" })).toBeNull();
    expect(providerToolAllowKey("claude", "mcp__agents__list_bots", { builtin: "agents" })).toMatch(/^provider-tool:claude:agents:list_bots:/);
    expect(providerToolAllowKey("", "mcp__linear__list_issues", config)).toBeNull();
    expect(providerToolAllowKey("claude", "mcp__linear__list_issues", undefined)).toBeNull();
  });

  it("names a built-in bridge, never its turn token, and nothing for a server neither configured nor built in", () => {
    expect(providerToolConfig("composio", {})).toEqual({ builtin: "composio" });
    expect(providerToolConfig("own_apps", {})).toEqual({ builtin: "own_apps" });
    expect(providerToolConfig("phone", {})).toBeUndefined();
    expect(providerToolConfig("computer", {})).toBeUndefined();
    expect(providerToolConfig("unmounted", {})).toBeUndefined();
    const linear = { url: "https://linear.example/mcp" };
    expect(providerToolConfig("linear", { linear })).toBe(linear);
    const tool = "mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL";
    const first = providerToolAllowKey("kimi", tool, providerToolConfig("composio", {}));
    expect(first).toMatch(/^provider-tool:kimi:composio:COMPOSIO_MULTI_EXECUTE_TOOL:/);
    expect(providerToolAllowKey("kimi", tool, providerToolConfig("composio", {}))).toBe(first);
    expect(providerToolAllowKey("kimi", "mcp__composio__GMAIL_SEND_EMAIL", providerToolConfig("composio", {}))).toBeNull();
  });

  it("invalidates a key when the configured server changes", () => {
    const first = providerToolAllowKey("claude", "mcp__linear__list_issues", { url: "https://one.example/mcp" });
    const second = providerToolAllowKey("claude", "mcp__linear__list_issues", { url: "https://two.example/mcp" });
    expect(first).not.toBe(second);
  });

  it("finds a grant in the thread's list or its bot's, and nothing for a tool with no key", () => {
    const key = providerToolAllowKey("claude", "mcp__linear__save_issue", { url: "https://linear.example/mcp" })!;
    expect(savedToolGrant(key, [], [key])).toBe(true);
    expect(savedToolGrant(key, [key], undefined)).toBe(true);
    expect(savedToolGrant(key, [], [])).toBe(false);
    expect(savedToolGrant(key.replace(":save_issue:", ":delete_issue:"), [key], [key])).toBe(false);
    expect(savedToolGrant(null, [key], [key])).toBe(false);
  });

  it("keeps a saved grant on the bot when a thread starts with an empty list of its own", async () => {
    const { Store } = await import("./store.ts");
    const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
    const bot = store.createBot({ name: "Saved grants fixture" });
    const key = providerToolAllowKey("fixture", "mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL", providerToolConfig("composio", {}))!;
    store.patchBot(bot.id, { alwaysAllow: [key] });
    const task = store.createTask(bot.id, "Later Ask thread", false, undefined, undefined, "ask");
    expect(task?.alwaysAllow).toEqual([]);
    expect(savedToolGrant(key, task?.alwaysAllow, store.bot(bot.id)?.alwaysAllow)).toBe(true);
  });
});
