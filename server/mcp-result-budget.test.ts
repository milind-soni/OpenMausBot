import { describe, expect, it } from "vitest";

import { customMcpServers } from "./config.ts";
import { attachCustomMcp, customMcpResultBudgets } from "./mcp-result-budget.ts";

const cfg = (mcpServers: Record<string, unknown>) =>
  ({ mcpServers }) as Parameters<typeof customMcpServers>[0];

describe("customMcpResultBudgets", () => {
  it("keeps a per-server result budget out of the spec and reports it on its own", () => {
    const config = cfg({
      motion: { command: "effectcraft-mcp", resultBudget: 40_000 },
      raw: { url: "https://raw.example/mcp", resultBudget: 0 },
      plain: { command: "notes-mcp" },
    });
    // the spec an engine mounts never carries a field it might reject
    expect(customMcpServers(config).motion).toEqual({ command: "effectcraft-mcp", args: [], env: {} });
    expect(customMcpResultBudgets(config, ["motion", "raw", "plain", "gone"])).toEqual({ motion: 40_000, raw: 0 });
    expect(customMcpResultBudgets(config, ["plain"])).toEqual({});
  });
});

describe("attachCustomMcp", () => {
  it("adds the servers and only the limits they set, and nothing for no servers", () => {
    const config = cfg({ motion: { command: "effectcraft-mcp", resultBudget: 40_000 }, plain: { command: "notes-mcp" } });
    const servers = customMcpServers(config);
    const withLimit: Parameters<typeof attachCustomMcp>[0] = {};
    attachCustomMcp(withLimit, servers, config);
    expect(withLimit).toEqual({ custom: servers, customResultBudgets: { motion: 40_000 } });
    const withoutLimit: Parameters<typeof attachCustomMcp>[0] = {};
    attachCustomMcp(withoutLimit, { plain: servers.plain }, config);
    expect(withoutLimit).toEqual({ custom: { plain: servers.plain } });
    const none: Parameters<typeof attachCustomMcp>[0] = {};
    attachCustomMcp(none, {}, config);
    expect(none).toEqual({});
  });
});
