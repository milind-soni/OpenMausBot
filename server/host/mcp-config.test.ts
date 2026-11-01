import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { DATA_DIR, type AppConfig } from "../config.ts";
import * as probeModule from "../mcp-probe.ts";
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

  it("every successful add, replace, setEnabled and remove calls changed() once", async () => {
    const { config, changed } = fixture();
    const steps = [
      () => config.add("warehouse", remote()),
      () => config.replace("warehouse", remote("https://other.example.com/mcp")),
      () => config.setEnabled("warehouse", true),
      () => config.setApps("warehouse", false),
      () => config.addMany(async () => ({ servers: { nightwatch: remote("https://nightwatch.example.com/mcp") } })),
      () => config.remove("warehouse"),
    ];
    for (const [index, step] of steps.entries()) {
      changed.mockClear();
      expect((await step()).status, `step ${index}`).toBeLessThan(300);
      expect(changed, `step ${index}`).toHaveBeenCalledTimes(1);
    }
    changed.mockClear();
    expect(config.remove("warehouse").status).toBe(404);
    expect(changed).not.toHaveBeenCalled();
  });

  it("an import holds the flag while its body is read, so another writer is refused until it ends", async () => {
    const { config, cfg } = fixture();
    let finish!: () => void;
    const body = new Promise<void>((resolve) => { finish = resolve; });
    const importing = config.addMany(async () => { await body; return { servers: { nightwatch: remote("https://nightwatch.example.com/mcp") } }; });
    expect(config.add("warehouse", remote())).toEqual({ status: 409, error: "MCP servers are already being updated." });
    expect(await config.addMany(async () => ({ servers: {} }))).toEqual({ status: 409, error: "MCP servers are already being updated." });
    finish();
    expect((await importing).status).toBe(201);
    expect(Object.keys(cfg.mcpServers ?? {})).toEqual(["nightwatch"]);
    expect(config.add("warehouse", remote()).status).toBe(201);
  });

  it("an import that fails while reading its body lets the next writer in", async () => {
    const { config } = fixture();
    await expect(config.addMany(async () => { throw new Error("body too large"); })).rejects.toThrow("body too large");
    expect(config.add("warehouse", remote()).status).toBe(201);
  });

  it("bringing in several servers is all or none and keeps the taken-name and policy refusals", async () => {
    const { cfg, config, changed } = fixture({ refuse: (name) => name === "blocked" ? "Not allowed here." : undefined });
    config.add("warehouse", remote());
    changed.mockClear();
    expect((await config.addMany(async () => ({ servers: { warehouse: remote(), fresh: remote("https://f.example.com/mcp") } }))).status).toBe(409);
    expect(await config.addMany(async () => ({ servers: { fresh: remote("https://f.example.com/mcp"), blocked: remote("https://b.example.com/mcp") } }))).toMatchObject({ status: 403, code: "managed_policy" });
    expect(Object.keys(cfg.mcpServers ?? {})).toEqual(["warehouse"]);
    expect(changed).not.toHaveBeenCalled();
  });

  it("tests as a bot when asked to, so a command server runs in that bot's folder", async () => {
    const { cfg, config } = fixture();
    cfg.mcpServers = { notes: { command: "definitely-not-a-real-program-xyz", args: [], env: {}, enabled: true } as never };
    const probe = vi.spyOn(probeModule, "probeMcpServer").mockResolvedValue({ ok: true, tools: [] });
    await config.test("notes", { signal: new AbortController().signal, asBot: { id: "bot-1", cwd: "/tmp/bot-1" } });
    expect(probe.mock.calls[0]?.[3]).toMatchObject({ asBot: { id: "bot-1", cwd: "/tmp/bot-1" } });
    probe.mockRestore();
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
