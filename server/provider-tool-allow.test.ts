import { describe, expect, it } from "vitest";

import { providerMcpTool, providerToolAllowKey, providerToolConfig, legacyProviderToolAllowKey, rememberedProviderTool } from "./provider-tool-allow.ts";

describe("provider MCP tool grants", () => {
  it("parses the server and exact tool from provider-facing names", () => {
    expect(providerMcpTool("mcp__linear__list_issues")).toEqual({ server: "linear", tool: "list_issues" });
    expect(providerMcpTool("mcp__my_server__get_item__v2")).toEqual({ server: "my_server", tool: "get_item__v2" });
    expect(providerMcpTool("Bash")).toBeNull();
    expect(providerMcpTool("mcp____list_issues")).toBeNull();
  });

  it("creates durable keys for exact non-send tools", () => {
    const config = { type: "http", url: "https://linear.example/mcp", headers: { Authorization: "secret" } };
    expect(providerToolAllowKey("claude", "mcp__linear__list_issues", config))
      .toMatch(/^provider-tool:claude:linear:list_issues:[a-f0-9]{16}$/);
    expect(providerToolAllowKey("claude", "mcp__linear__save_issue", config)).toMatch(/^provider-tool:claude:linear:save_issue:/);
    expect(providerToolAllowKey("claude", "mcp__gmail__send_email", config)).toBeNull();
    expect(providerToolAllowKey("claude", "mcp__computer__click", config)).toBeNull();
    expect(providerToolAllowKey("", "mcp__linear__list_issues", config)).toBeNull();
  });

  it("invalidates a key when the configured server changes", () => {
    const first = providerToolAllowKey("claude", "mcp__linear__list_issues", { url: "https://one.example/mcp" });
    const second = providerToolAllowKey("claude", "mcp__linear__list_issues", { url: "https://two.example/mcp" });
    expect(first).not.toBe(second);
  });
});

it.each(["COMPOSIO_MULTI_EXECUTE_TOOL", "COMPOSIO_REMOTE_BASH_TOOL"])("remembers built-in %s independently of rotating turn tokens", tool => {
  const name = `mcp__composio__${tool}`;
  const first = providerToolAllowKey("kimi", name, providerToolConfig("composio", {}));
  expect(first).toBeTruthy();
  expect(providerToolAllowKey("kimi", name, providerToolConfig("composio", {}))).toBe(first);
  expect(providerToolConfig("unmounted", {})).toBeUndefined();
});
it("keeps canonical keys stable and accepts existing saved read grants", () => {
  const config = { url: "https://brain.example", headers: { B: "b", A: "a" } };
  const name = "mcp__brain__read";
  const current = providerToolAllowKey("claude", name, config);
  const legacy = legacyProviderToolAllowKey("claude", name, config);
  expect(current).toBe(providerToolAllowKey("claude", name, { headers: { A: "a", B: "b" }, url: "https://brain.example" }));
  expect(rememberedProviderTool([legacy!], current, legacy)).toBe(true);
  expect(rememberedProviderTool([], current, legacy)).toBe(false);
  expect(rememberedProviderTool([legacy!], providerToolAllowKey("claude", "mcp__brain__remember", config), null)).toBe(false);
});

it("keeps an approved tool on the bot after a restart and on a new explicitly Ask task", async () => {
  const { Store } = await import("./store.ts");
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
  const bot = store.createBot({ name: "Persistent grants fixture" });
  const tool = "mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL";
  const key = providerToolAllowKey("fixture", tool, providerToolConfig("composio", {}))!;
  store.patchBot(bot.id, { alwaysAllow: [key] });
  const loaded = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
  const task = loaded.createTask(bot.id, "Later Ask task", false, undefined, undefined, "ask");
  expect(task?.alwaysAllow).toEqual([]);
  expect(rememberedProviderTool(loaded.bot(bot.id)?.alwaysAllow, key, null)).toBe(true);
});
