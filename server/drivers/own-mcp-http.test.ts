import { describe, expect, it, vi } from "vitest";

import { SPAWNED_PROXIES } from "../proxy-paths.ts";
import { mountMcpServer } from "./codex-mcp-mount.ts";
import { acpOwnMcpTransport, acpSessionMcpServers, claudeOwnMcpOverHttp, loopbackUnproxied, OWN_MCP_HTTP_ENV, ownMcpHttpEnabled, withLoopbackNoProxy } from "./own-mcp-http.ts";
import type { AcpMcpServer } from "./turn-mcp.ts";

const HARNESS = "http://127.0.0.1:8799";
const agents = { command: process.execPath, args: [SPAWNED_PROXIES.agents], env: { OMB_HARNESS_URL: HARNESS, OMB_COMMS_TOKEN: "comms", OMB_BOT_ID: "b1", OMB_THREAD_ID: "t1", OMB_AGENTS_DEFER_TOOLS: "1", ELECTRON_RUN_AS_NODE: "1" } };
const browser = { command: process.execPath, args: [SPAWNED_PROXIES.harnessMcp, "browser"], env: { OMB_HARNESS_URL: HARNESS, OMB_MCP_TOKEN_BROWSER: "browse", OMB_TOOL_LIMIT: "12" } };
const ogb = { command: process.execPath, args: [SPAWNED_PROXIES.permission, "/tmp/perm.sock"], env: {}, alwaysLoad: true };
const phone = { command: process.execPath, args: ["/app/phone-proxy.js"], env: { OMB_HARNESS_URL: HARNESS, OMB_PHONE_TOKEN: "p" } };
const settings = (header: string) => JSON.parse(Buffer.from(header, "base64url").toString("utf8"));

describe("the setting", () => {
  it("is off unless OMB_OWN_MCP_HTTP=1, everywhere, and always off in the bot box", () => {
    expect(ownMcpHttpEnabled({}, false)).toBe(false);
    expect(ownMcpHttpEnabled({ OMB_CLOUD_ROLE: "home" }, false)).toBe(false);
    expect(ownMcpHttpEnabled({ [OWN_MCP_HTTP_ENV]: "0" }, false)).toBe(false);
    expect(ownMcpHttpEnabled({ [OWN_MCP_HTTP_ENV]: "true" }, false)).toBe(false);
    expect(ownMcpHttpEnabled({ [OWN_MCP_HTTP_ENV]: "1" }, false)).toBe(true);
    expect(ownMcpHttpEnabled({ [OWN_MCP_HTTP_ENV]: "1" }, true)).toBe(false);
  });
});

describe("an engine set up to use a proxy", () => {
  it("reaches this server's loopback URL directly: the loopback names join NO_PROXY and no_proxy, keeping what either held", () => {
    const env: Record<string, string | undefined> = { HTTPS_PROXY: "http://proxy.internal:3128", NO_PROXY: "corp.internal, localhost", no_proxy: ".lan" };
    withLoopbackNoProxy(env);
    expect(env.NO_PROXY).toBe("corp.internal,localhost,.lan,127.0.0.1,::1");
    expect(env.no_proxy).toBe(env.NO_PROXY);
    withLoopbackNoProxy(env);
    expect(env.NO_PROXY).toBe("corp.internal,localhost,.lan,127.0.0.1,::1");
    const bare: Record<string, string | undefined> = {};
    withLoopbackNoProxy(bare);
    expect(bare).toEqual({ NO_PROXY: "127.0.0.1,localhost,::1", no_proxy: "127.0.0.1,localhost,::1" });
  });

  it("is left alone by an ACP engine that keeps the stdio form", () => {
    const env: Record<string, string | undefined> = { NO_PROXY: "corp.internal" };
    expect(loopbackUnproxied(env, false)).toBe(false);
    expect(env).toEqual({ NO_PROXY: "corp.internal" });
    expect(loopbackUnproxied(env, true)).toBe(true);
    expect(env.NO_PROXY).toBe("corp.internal,127.0.0.1,localhost,::1");
  });
});

describe("Claude's --mcp-config", () => {
  it("gets OpenMausBot's own proxies by URL with their capability, settings, tool limit and alwaysLoad; nothing else changes", () => {
    const servers: Record<string, unknown> = { agents: { ...agents, alwaysLoad: true }, browser, ogb, phone, mine: { command: "npx", args: ["my-server"] } };
    expect(claudeOwnMcpOverHttp(servers, true)).toBe(true);
    expect(servers.agents).toEqual({ type: "http", url: `${HARNESS}/api/internal/mcp-http/agents`, alwaysLoad: true,
      headers: { authorization: "Bearer comms", "x-omb-agents-env": expect.any(String) } });
    expect(settings((servers.agents as { headers: Record<string, string> }).headers["x-omb-agents-env"]!)).toEqual({ OMB_BOT_ID: "b1", OMB_THREAD_ID: "t1", OMB_AGENTS_DEFER_TOOLS: "1" });
    expect(servers.browser).toEqual({ type: "http", url: `${HARNESS}/api/internal/mcp-http/browser`, headers: { authorization: "Bearer browse", "x-omb-tool-limit": "12" } });
    expect(servers.ogb).toBe(ogb);
    expect(servers.phone).toBe(phone);
    expect(servers.mine).toEqual({ command: "npx", args: ["my-server"] });
  });

  it("is left as it is with the setting off", () => {
    const servers: Record<string, unknown> = { agents, browser };
    expect(claudeOwnMcpOverHttp(servers, false)).toBe(false);
    expect(servers).toEqual({ agents, browser });
    expect(claudeOwnMcpOverHttp({ phone }, true)).toBe(false);
  });
});

describe("Codex's own servers", () => {
  it("mount by URL with the token named, never written, in argv", () => {
    vi.stubEnv(OWN_MCP_HTTP_ENV, "1");
    try {
      const args: string[] = [];
      const env: Record<string, string | undefined> = { NO_PROXY: "corp.internal" };
      mountMcpServer(args, env, "agents", agents, "approve");
      const joined = args.join(" ");
      expect(joined).toContain(`mcp_servers.agents.url="${HARNESS}/api/internal/mcp-http/agents"`);
      expect(joined).toContain('mcp_servers.agents.bearer_token_env_var="OMB_COMMS_TOKEN"');
      expect(joined).toContain('mcp_servers.agents.http_headers={ "x-omb-agents-env" = ');
      expect(joined).toContain('mcp_servers.agents.default_tools_approval_mode="approve"');
      expect(joined).not.toContain("comms");
      expect(joined).not.toContain("command=");
      expect(env.OMB_COMMS_TOKEN).toBe("comms");
      expect([env.NO_PROXY, env.no_proxy]).toEqual(["corp.internal,127.0.0.1,localhost,::1", "corp.internal,127.0.0.1,localhost,::1"]);
      const stdio: string[] = [];
      const stdioEnv: Record<string, string | undefined> = {};
      mountMcpServer(stdio, stdioEnv, "notes", { command: "npx", args: ["notes"], env: { KEY: "k" } });
      expect(stdio.join(" ")).toContain('mcp_servers.notes.command="npx"');
      expect(stdioEnv.NO_PROXY).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("an ACP engine", () => {
  it("takes the URL form by its driver's choice, by the setting outside the box, never with OMB_OWN_MCP_HTTP=0 or launcher-owned servers", () => {
    expect(acpOwnMcpTransport({}, {}, false)).toBe("stdio");
    expect(acpOwnMcpTransport({}, { [OWN_MCP_HTTP_ENV]: "1" }, false)).toBe("advertised");
    expect(acpOwnMcpTransport({}, { [OWN_MCP_HTTP_ENV]: "1" }, true)).toBe("stdio");
    for (const boxed of [false, true]) {
      expect(acpOwnMcpTransport({ ownMcpOverHttp: "advertised" }, {}, boxed)).toBe("advertised");
      expect(acpOwnMcpTransport({ ownMcpOverHttp: true }, {}, boxed)).toBe("http");
      expect(acpOwnMcpTransport({ ownMcpOverHttp: "advertised" }, { [OWN_MCP_HTTP_ENV]: "0" }, boxed)).toBe("stdio");
      expect(acpOwnMcpTransport({ ownMcpOverHttp: true }, { [OWN_MCP_HTTP_ENV]: "0" }, boxed)).toBe("stdio");
    }
    expect(acpOwnMcpTransport({ ownMcpOverHttp: "advertised", mcpServersFromLaunch: true }, {}, false)).toBe("stdio");
  });

  it("sends a session its own servers by URL only when that session's agent said it takes them, the person's as they were", () => {
    const pairs = (record: Record<string, string>) => Object.entries(record).map(([name, value]) => ({ name, value }));
    const harnessServer = (kind: string) => ({ name: kind, command: process.execPath, args: [SPAWNED_PROXIES.harnessMcp, kind],
      env: pairs({ OMB_HARNESS_URL: HARNESS, [`OMB_MCP_TOKEN_${kind.toUpperCase()}`]: `${kind}-capability` }) });
    const servers: AcpMcpServer[] = [
      { name: "agents", command: agents.command, args: agents.args, env: pairs(agents.env) },
      { name: "browser", command: browser.command, args: browser.args, env: pairs(browser.env) },
      ...["computer", "data", "email", "device"].map(harnessServer),
      { name: "phone", command: phone.command, args: phone.args, env: pairs(phone.env) },
      { name: "ogb", command: ogb.command, args: ogb.args, env: [] },
      { name: "notes", command: "npx", args: ["notes"], env: [] },
    ];
    const http = { agentCapabilities: { mcpCapabilities: { http: true, sse: false } } };
    expect(acpSessionMcpServers(servers, "advertised", { agentCapabilities: {} })).toBe(servers);
    expect(acpSessionMcpServers(servers, "advertised", { agentCapabilities: { mcpCapabilities: { http: "yes" } } })).toBe(servers);
    expect(acpSessionMcpServers(servers, "stdio", http)).toBe(servers);
    const sent = acpSessionMcpServers(servers, "advertised", http);
    expect(sent.map((server) => "type" in server ? `${server.name}:${server.url}` : server.name)).toEqual([
      ...["agents", "browser", "computer", "data", "email", "device"].map((name) => `${name}:${HARNESS}/api/internal/mcp-http/${name}`),
      "phone", "ogb", "notes"]);
    expect(sent.slice(6)).toEqual(servers.slice(6));
    for (const kind of ["computer", "data", "email", "device"]) {
      expect((sent.find((server) => server.name === kind) as Extract<AcpMcpServer, { type: "http" }>).headers).toEqual([{ name: "authorization", value: `Bearer ${kind}-capability` }]);
    }
    const own = sent[1] as Extract<AcpMcpServer, { type: "http" }>;
    expect(own.headers).toEqual([{ name: "authorization", value: "Bearer browse" }, { name: "x-omb-tool-limit", value: "12" }]);
    const agentsHeaders = Object.fromEntries((sent[0] as Extract<AcpMcpServer, { type: "http" }>).headers.map(({ name, value }) => [name, value]));
    expect(agentsHeaders.authorization).toBe("Bearer comms");
    expect(settings(Object.values(agentsHeaders).find((value) => value !== "Bearer comms")!)).toMatchObject({ OMB_BOT_ID: "b1", OMB_THREAD_ID: "t1" });
  });
});
