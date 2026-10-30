import { describe, expect, it } from "vitest";

import { customServerGate, gateQueryTools, gateServer, hasOwnResultBudget, mcpStdioServer, resultBudget, serverResultBudget } from "./mcp-gate-config.ts";
import { DEFAULT_RESULT_BUDGET } from "./mcp-trim.ts";

const server = { command: "example-mcp", args: ["--stdio"], env: { TOKEN: "disposable-test-token" } };
const input = { name: "notes", server, threadId: "disposable-thread", budget: 0 };
const remote = { type: "http" as const, url: "https://mcp.example.test/mcp", headers: { Authorization: "Bearer disposable-remote-token" } };

describe("MCP scope configuration", () => {
  it("preserves the legacy budget-zero escape hatch only when selection is absent", () => {
    expect(gateServer(input)).toBeNull();
    const gated = gateServer({ ...input, toolScope: { allow: [] } });
    expect(gated).not.toBeNull();
    expect(JSON.parse(gated!.env.OMB_GATE_TOOL_SCOPE)).toEqual({ allow: [] });
    expect(gated!.env.OMB_GATE_BUDGET).toBe("0");
    expect(JSON.parse(gated!.env.OMB_GATE_UPSTREAM)).toEqual(server);
    expect(gated!.args.join(" ")).not.toContain("disposable-test-token");
  });

  it("rejects malformed scopes and unmountable scoped servers instead of returning a bypass", () => {
    expect(() => gateServer({ ...input, toolScope: { allow: null } as never })).toThrow(/tool selection/i);
    expect(() => gateServer({ ...input, server: {}, toolScope: { allow: [] } })).toThrow(/MCP server/i);
  });
});

describe("result budget", () => {
  it("uses a server's own budget, else the environment's, else the default", () => {
    expect(resultBudget({})).toBe(DEFAULT_RESULT_BUDGET);
    expect(serverResultBudget("motion", { motion: 40_000 }, {})).toBe(40_000);
    // 0 is a real setting (never trim), not a missing one
    expect(serverResultBudget("motion", { motion: 0 }, { OMB_MCP_RESULT_BUDGET: "12000" })).toBe(0);
    expect(serverResultBudget("notes", { motion: 40_000 }, { OMB_MCP_RESULT_BUDGET: "12000" })).toBe(12_000);
    expect(serverResultBudget("notes", undefined, {})).toBe(DEFAULT_RESULT_BUDGET);
    // an inherited name is not a setting
    expect(serverResultBudget("toString", {}, {})).toBe(DEFAULT_RESULT_BUDGET);
  });

  it("hands the gate the budget it was given", () => {
    expect(gateServer({ ...input, budget: 40_000 })!.env.OMB_GATE_BUDGET).toBe("40000");
  });
});

describe("tool directory configuration", () => {
  it("asks the remote proxy for a directory only when the caller does", () => {
    expect(mcpStdioServer(remote)!.env).not.toHaveProperty("OMB_REMOTE_MCP_DIRECTORY");
    const scope = { allow: ["mcp:whop:*"], deny: ["mcp:whop:payments_create"] };
    const searched = mcpStdioServer(remote, { directory: { name: "whop", toolScope: scope } })!;
    expect(searched.args).toHaveLength(1);
    expect(searched.args![0]).toContain("mcp-remote-proxy");
    expect(JSON.parse(searched.env!.OMB_REMOTE_MCP_DIRECTORY)).toEqual({ name: "whop", toolScope: scope });
    expect(JSON.parse(mcpStdioServer(remote, { directory: { name: "whop" } })!.env!.OMB_REMOTE_MCP_DIRECTORY)).toEqual({ name: "whop" });
    expect(mcpStdioServer(server, { directory: { name: "notes" } })).toBe(server);
  });

  it("keeps a shared environment's settings in one private record", () => {
    const record = `OMB_REMOTE_MCP_CONFIG_${"0".repeat(64)}`;
    const proxy = mcpStdioServer(remote, { nodeEnv: { ELECTRON_RUN_AS_NODE: "1" }, directory: { name: "whop" }, configEnvName: record })!;
    expect(proxy.args!.slice(1)).toEqual(["--config-env", record]);
    expect(Object.keys(proxy.env!).sort()).toEqual(["ELECTRON_RUN_AS_NODE", record]);
    const settings = JSON.parse(proxy.env![record]);
    expect(JSON.parse(settings.OMB_REMOTE_MCP_SERVER)).toEqual(remote);
    expect(JSON.parse(settings.OMB_REMOTE_MCP_DIRECTORY)).toEqual({ name: "whop" });
    expect(proxy.args!.join(" ")).not.toContain("disposable-remote-token");
  });

  it("hands the proxy the network settings its engine might strip, and makes fetch use them", () => {
    const sourceEnv = { HTTPS_PROXY: "http://proxy.example.test:3128", no_proxy: "localhost", NODE_EXTRA_CA_CERTS: "/etc/corp-ca.pem",
      SSL_CERT_FILE: "/etc/ssl/cert.pem", PATH: "/usr/bin", UNRELATED_SECRET: "not-for-the-proxy" };
    const proxy = mcpStdioServer(remote, { sourceEnv })!;
    expect(proxy.env).toMatchObject({ HTTPS_PROXY: "http://proxy.example.test:3128", NODE_EXTRA_CA_CERTS: "/etc/corp-ca.pem", SSL_CERT_FILE: "/etc/ssl/cert.pem", NODE_USE_ENV_PROXY: "1" });
    expect(proxy.env!.NO_PROXY).toBe("localhost,127.0.0.1,::1,[::1]");
    expect(proxy.env!.no_proxy).toBe("localhost,127.0.0.1,::1,[::1]");
    const merged = mcpStdioServer(remote, { sourceEnv: { HTTP_PROXY: "http://proxy.example.test:3128", NO_PROXY: "corp.internal, .example.org", no_proxy: "build.local" } })!;
    expect(merged.env!.NO_PROXY).toBe("build.local,corp.internal,.example.org,localhost,127.0.0.1,::1,[::1]");
    expect(merged.env!.no_proxy).toBe(merged.env!.NO_PROXY);
    expect(proxy.env).not.toHaveProperty("UNRELATED_SECRET");
    expect(proxy.env).not.toHaveProperty("PATH");
    expect(mcpStdioServer(remote, { sourceEnv: { NODE_EXTRA_CA_CERTS: "/etc/corp-ca.pem" } })!.env).toEqual({ NODE_EXTRA_CA_CERTS: "/etc/corp-ca.pem", OMB_REMOTE_MCP_SERVER: JSON.stringify(remote) });
    const record = `OMB_REMOTE_MCP_CONFIG_${"0".repeat(64)}`;
    expect(Object.keys(mcpStdioServer(remote, { sourceEnv, configEnvName: record })!.env!).sort()).toEqual(
      ["HTTPS_PROXY", "NODE_EXTRA_CA_CERTS", "NODE_USE_ENV_PROXY", "NO_PROXY", "SSL_CERT_FILE", "no_proxy", record].sort());
    const gated = gateServer({ name: "whop", server: remote, threadId: "disposable-thread", budget: 0, toolScope: { allow: [] }, sourceEnv })!;
    expect(JSON.parse(gated.env.OMB_GATE_UPSTREAM).env).toMatchObject({ HTTPS_PROXY: "http://proxy.example.test:3128", NODE_USE_ENV_PROXY: "1" });
  });

  // Node 24's fetch hangs on a plain http:// request through an env proxy; https:// goes through CONNECT.
  it("switches the proxy on for an https server only; an http server is reached directly", () => {
    const http = { ...remote, url: "http://mcp.example.test/mcp" };
    for (const sourceEnv of [{ HTTP_PROXY: "http://proxy.example.test:3128" }, { HTTPS_PROXY: "http://proxy.example.test:3128", no_proxy: "corp.internal" }]) {
      const secure = mcpStdioServer(remote, { sourceEnv })!.env!;
      expect(secure.NODE_USE_ENV_PROXY).toBe("1");
      // Node matches an IPv6 host bracketed: only "[::1]" exempts https://[::1]
      expect(secure.NO_PROXY!.split(",")).toEqual(expect.arrayContaining(["localhost", "127.0.0.1", "::1", "[::1]"]));
      expect(secure.no_proxy).toBe(secure.NO_PROXY);
      const plain = mcpStdioServer(http, { sourceEnv })!.env!;
      expect(plain.NODE_USE_ENV_PROXY).toBe("0");
      expect(plain.NO_PROXY).toBeUndefined();
      expect(plain.no_proxy).toBe(sourceEnv.no_proxy);
      for (const descriptor of [
        gateServer({ name: "whop", server: http, threadId: "disposable-thread", budget: 0, toolScope: { allow: [] }, sourceEnv })!,
        gateServer({ name: "whop", server: http, threadId: "disposable-thread", budget: 0, toolScope: { allow: [] }, directory: true, sourceEnv })!,
      ]) expect(JSON.parse(descriptor.env.OMB_GATE_UPSTREAM).env.NODE_USE_ENV_PROXY).toBe("0");
      expect(JSON.parse(gateServer({ name: "whop", server: remote, threadId: "disposable-thread", budget: 0, toolScope: { allow: [] }, sourceEnv })!.env.OMB_GATE_UPSTREAM).env.NODE_USE_ENV_PROXY).toBe("1");
    }
    expect(mcpStdioServer(http, { sourceEnv: { NODE_USE_ENV_PROXY: "1" } })!.env!.NODE_USE_ENV_PROXY).toBe("0");
    expect(mcpStdioServer(http, { sourceEnv: {} })!.env).not.toHaveProperty("NODE_USE_ENV_PROXY");
    expect(mcpStdioServer({ ...remote, type: "sse", url: "http://mcp.example.test/sse" }, { sourceEnv: { HTTPS_PROXY: "http://p:1" } })!.env!.NODE_USE_ENV_PROXY).toBe("0");
    expect(mcpStdioServer({ ...remote, type: "sse", url: "https://mcp.example.test/sse" }, { sourceEnv: { HTTPS_PROXY: "http://p:1" } })!.env!.NODE_USE_ENV_PROXY).toBe("1");
  });

  it("refuses settings the proxy could not read", () => {
    expect(() => mcpStdioServer(remote, { configEnvName: "OMB_REMOTE_MCP_SERVER" })).toThrow(/private MCP proxy/);
    expect(() => mcpStdioServer(remote, { directory: { name: "Not A Name" } })).toThrow(/tool search/);
    expect(() => mcpStdioServer(remote, { directory: { name: "whop", toolScope: { allow: null } as never } })).toThrow(/tool search/);
  });

  it("puts a scoped directory inside the gate, which looks through call_tool", () => {
    const scope = { allow: ["mcp:whop:payments_list"] };
    const gated = gateServer({ name: "whop", server: remote, threadId: "disposable-thread", budget: 0, toolScope: scope, directory: true })!;
    expect(gated.args[0]).toContain("mcp-gate");
    expect(gated.env.OMB_GATE_DIRECTORY).toBe("1");
    const upstream = JSON.parse(gated.env.OMB_GATE_UPSTREAM);
    expect(upstream.args[0]).toContain("mcp-remote-proxy");
    expect(JSON.parse(upstream.env.OMB_REMOTE_MCP_DIRECTORY)).toEqual({ name: "whop", toolScope: scope });
    const plain = gateServer({ name: "whop", server: remote, threadId: "disposable-thread", budget: 0, toolScope: scope })!;
    expect(plain.env).not.toHaveProperty("OMB_GATE_DIRECTORY");
    expect(JSON.parse(plain.env.OMB_GATE_UPSTREAM).env).not.toHaveProperty("OMB_REMOTE_MCP_DIRECTORY");
    expect(gateServer({ ...input, toolScope: { allow: [] }, directory: true })!.env).not.toHaveProperty("OMB_GATE_DIRECTORY");
    expect(gateServer({ name: "whop", server: remote, threadId: "disposable-thread", budget: 8_000, directory: true })).toBeNull();
  });

  it("gates an unselected URL server only when its own result limit is set", () => {
    expect(hasOwnResultBudget("whop", { whop: 40_000 })).toBe(true);
    expect(hasOwnResultBudget("whop", { whop: 0 })).toBe(false);
    expect(hasOwnResultBudget("whop", { other: 40_000 })).toBe(false);
    expect(hasOwnResultBudget("whop", undefined)).toBe(false);
    const gated = gateServer({ name: "whop", server: remote, threadId: "disposable-thread", budget: 40_000, gateRemote: true, directory: true })!;
    expect(gated.env.OMB_GATE_BUDGET).toBe("40000");
    expect(gated.env).not.toHaveProperty("OMB_GATE_TOOL_SCOPE");
    expect(JSON.parse(gated.env.OMB_GATE_UPSTREAM).args[0]).toContain("mcp-remote-proxy");
    // 0 = never trim: nothing to gate
    expect(gateServer({ name: "whop", server: remote, threadId: "disposable-thread", budget: 0, gateRemote: true })).toBeNull();
  });

  it("gives a person's own server its limit and leaves an engine's server alone", () => {
    const env = { OMB_MCP_RESULT_BUDGET: "12000" };
    expect(customServerGate("whop", true, { whop: 40_000 }, env)).toEqual({ budget: 40_000, gateRemote: true });
    expect(customServerGate("whop", true, { whop: 0 }, env)).toEqual({ budget: 0, gateRemote: false });
    expect(customServerGate("notes", true, { whop: 40_000 }, env)).toEqual({ budget: 12_000, gateRemote: false });
    expect(customServerGate("whop", false, { whop: 40_000 }, env)).toEqual({ budget: 0, gateRemote: false });
  });
});

describe("the gate's own query tool", () => {
  const server = { command: "npx", args: ["shop"] };
  const configEnvName = `OMB_GATE_CONFIG_${"a".repeat(64)}`;

  it("is named for each mount that is a trimming gate, whatever carries its configuration", () => {
    const trimming = gateServer({ name: "shop", server, threadId: "t", budget: 8_000 })!;
    const scopedOnly = gateServer({ name: "notes", server, threadId: "t", budget: 0, toolScope: { allow: ["mcp:notes:*"] } })!;
    const private_ = gateServer({ name: "files", server, threadId: "t", budget: 0, toolScope: { allow: ["mcp:files:*"] }, configEnvName })!;
    const privateTrimming = { ...private_, env: { [configEnvName]: JSON.stringify({ ...JSON.parse(private_.env[configEnvName]!), OMB_GATE_BUDGET: "500" }) } };
    expect(gateQueryTools({ shop: trimming, notes: scopedOnly, files: private_, docs: server, ogb: { command: "node", args: ["perm-proxy.js"] },
      lookalike: { ...server, env: { OMB_GATE_BUDGET: "8000" } } }))
      .toEqual(["mcp__shop__query_result"]);
    expect(gateQueryTools({ files: privateTrimming, broken: { args: trimming.args, env: {} } })).toEqual(["mcp__files__query_result"]);
  });
});
