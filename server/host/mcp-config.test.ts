import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { DATA_DIR, type AppConfig } from "../config.ts";
import { McpOAuthManager } from "../mcp-oauth.ts";
import { listMcpServers, type StoredMcpServer } from "../mcp-registry.ts";
import { createMcpConfig } from "./mcp-config.ts";
import type { TeamConnectionsHost } from "./team-connections-host.ts";

const remote = (url = "https://data.example.com/mcp"): StoredMcpServer => ({ type: "http", url, headers: {}, enabled: false }) as StoredMcpServer;

function fixture(options: { refuse?: (name: string) => string | undefined } = {}) {
  const cfg: Pick<AppConfig, "mcpServers" | "postiz"> = { mcpServers: {} };
  const mcpOAuth = new McpOAuthManager({ file: join(DATA_DIR, "mcp-config-oauth.json") });
  const forget = vi.spyOn(mcpOAuth, "forget");
  const changed = vi.fn();
  let busy = false;
  const config = createMcpConfig({
    cfg,
    sessions: { isLive: () => true },
    mcpOAuth,
    teamConnections: { personMcp: () => [], people: {} as TeamConnectionsHost["people"] },
    cloudHome: null,
    fallbackPublicUrl: null,
    mcpConfigBusy: { get: () => busy, set: (value) => { busy = value; } },
    mcpServerResponse: () => ({ servers: listMcpServers(cfg.mcpServers) }),
    mcpPolicyRefusal: (name) => options.refuse?.(name),
    persistMcpServers: (next) => { cfg.mcpServers = next; },
    savedCustomDomain: () => null,
    changed,
  });
  return { cfg, config, changed, forget, setBusy: (value: boolean) => { busy = value; } };
}

describe("shared MCP config", () => {
  it("enabling a server the policy refuses returns 403 managed_policy and leaves it off", () => {
    const { cfg, config } = fixture({ refuse: (name) => name === "blocked" ? "Your admin hasn't approved this server." : undefined });
    cfg.mcpServers = { blocked: remote() as never };
    expect(config.setEnabled("blocked", true)).toEqual({ status: 403, error: "Your admin hasn't approved this server.", code: "managed_policy" });
    expect(cfg.mcpServers.blocked).toMatchObject({ enabled: false });
  });

  it("every successful add, replace, setEnabled and remove calls changed() once", () => {
    const { config, changed } = fixture();
    const results = [
      config.add("warehouse", remote()),
      config.replace("warehouse", remote("https://other.example.com/mcp")),
      config.setEnabled("warehouse", true),
      config.setApps("warehouse", false),
      config.remove("warehouse"),
    ];
    expect(results.map((result) => result.status)).toEqual([201, 200, 200, 200, 200]);
    expect(changed).toHaveBeenCalledTimes(5);
    expect(config.remove("warehouse").status).toBe(404);
    expect(changed).toHaveBeenCalledTimes(5);
  });

  it("a write while busy returns 409 \"MCP servers are already being updated.\"", () => {
    const { config, changed, setBusy } = fixture();
    setBusy(true);
    expect(config.add("warehouse", remote())).toEqual({ status: 409, error: "MCP servers are already being updated." });
    expect(changed).not.toHaveBeenCalled();
  });

  it("replace to a new url forgets the sign-in", () => {
    const { config, forget } = fixture();
    config.add("warehouse", remote());
    config.replace("warehouse", remote());
    expect(forget).not.toHaveBeenCalled();
    config.replace("warehouse", remote("https://elsewhere.example.com/mcp"));
    expect(forget).toHaveBeenCalledWith("warehouse");
  });
});
