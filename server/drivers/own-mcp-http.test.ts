import { describe, expect, it, vi } from "vitest";

import { SPAWNED_PROXIES } from "../proxy-paths.ts";
import { mountMcpServer } from "./codex-mcp-mount.ts";
import { acpOwnMcpOverHttp, claudeOwnMcpOverHttp, noteAcpMcpHttp, OWN_MCP_HTTP_ENV, ownMcpHttpEnabled } from "./own-mcp-http.ts";

const HARNESS = "http://127.0.0.1:8799";
const agents = { command: process.execPath, args: [SPAWNED_PROXIES.agents], env: { OMB_HARNESS_URL: HARNESS, OMB_COMMS_TOKEN: "comms", OMB_BOT_ID: "b1", OMB_THREAD_ID: "t1", OMB_AGENTS_DEFER_TOOLS: "1", ELECTRON_RUN_AS_NODE: "1" } };
const browser = { command: process.execPath, args: [SPAWNED_PROXIES.harnessMcp, "browser"], env: { OMB_HARNESS_URL: HARNESS, OMB_MCP_TOKEN_BROWSER: "browse", OMB_TOOL_LIMIT: "12" } };
const ogb = { command: process.execPath, args: [SPAWNED_PROXIES.permission, "/tmp/perm.sock"], env: {}, alwaysLoad: true };
const phone = { command: process.execPath, args: ["/app/phone-proxy.js"], env: { OMB_HARNESS_URL: HARNESS, OMB_PHONE_TOKEN: "p" } };
const settings = (header: string) => JSON.parse(Buffer.from(header, "base64url").toString("utf8"));

describe("the setting", () => {
  it("is on for a self-hosted Linux server, off on the desktop app, a Cloud, macOS and Windows, and off in the bot box", () => {
    expect(ownMcpHttpEnabled({}, "linux", false)).toBe(true);
    expect(ownMcpHttpEnabled({ OMB_DESKTOP_PARENT: "1" }, "linux", false)).toBe(false);
    expect(ownMcpHttpEnabled({ OMB_CLOUD_ROLE: "home" }, "linux", false)).toBe(false);
    expect(ownMcpHttpEnabled({}, "darwin", false)).toBe(false);
    expect(ownMcpHttpEnabled({}, "win32", false)).toBe(false);
    expect(ownMcpHttpEnabled({ [OWN_MCP_HTTP_ENV]: "1" }, "darwin", false)).toBe(true);
    expect(ownMcpHttpEnabled({ [OWN_MCP_HTTP_ENV]: "0" }, "linux", false)).toBe(false);
    expect(ownMcpHttpEnabled({ [OWN_MCP_HTTP_ENV]: "1" }, "linux", true)).toBe(false);
  });
});

describe("Claude's --mcp-config", () => {
  it("gets OpenMausBot's own proxies by URL with their capability, settings, tool limit and alwaysLoad; nothing else changes", () => {
    const servers: Record<string, unknown> = { agents: { ...agents, alwaysLoad: true }, browser, ogb, phone, mine: { command: "npx", args: ["my-server"] } };
    claudeOwnMcpOverHttp(servers, true);
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
    claudeOwnMcpOverHttp(servers, false);
    expect(servers).toEqual({ agents, browser });
  });
});

describe("Codex's own servers", () => {
  it("mount by URL with the token named, never written, in argv", () => {
    vi.stubEnv(OWN_MCP_HTTP_ENV, "1");
    try {
      const args: string[] = [];
      const env: Record<string, string | undefined> = {};
      mountMcpServer(args, env, "agents", agents, "approve");
      const joined = args.join(" ");
      expect(joined).toContain(`mcp_servers.agents.url="${HARNESS}/api/internal/mcp-http/agents"`);
      expect(joined).toContain('mcp_servers.agents.bearer_token_env_var="OMB_COMMS_TOKEN"');
      expect(joined).toContain('mcp_servers.agents.http_headers={ "x-omb-agents-env" = ');
      expect(joined).toContain('mcp_servers.agents.default_tools_approval_mode="approve"');
      expect(joined).not.toContain("comms");
      expect(joined).not.toContain("command=");
      expect(env.OMB_COMMS_TOKEN).toBe("comms");
      const stdio: string[] = [];
      mountMcpServer(stdio, {}, "notes", { command: "npx", args: ["notes"], env: { KEY: "k" } });
      expect(stdio.join(" ")).toContain('mcp_servers.notes.command="npx"');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("an ACP engine", () => {
  it("gets the URL form once its agent said it takes MCP servers by URL, and not when its servers come from its launcher", () => {
    expect(acpOwnMcpOverHttp("gemini-test", false, true)).toBe(false);
    noteAcpMcpHttp("gemini-test", { agentCapabilities: { mcpCapabilities: { http: true, sse: false } } });
    expect(acpOwnMcpOverHttp("gemini-test", false, true)).toBe(true);
    expect(acpOwnMcpOverHttp("gemini-test", true, true)).toBe(false);
    expect(acpOwnMcpOverHttp("gemini-test", false, false)).toBe(false);
    noteAcpMcpHttp("gemini-test", { agentCapabilities: {} });
    expect(acpOwnMcpOverHttp("gemini-test", false, true)).toBe(false);
  });
});
