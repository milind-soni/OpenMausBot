import { describe, expect, it } from "vitest";

import type { SendTurnInput } from "../contracts.ts";
import { SPAWNED_PROXIES } from "../proxy-paths.ts";
import { AGENTS_ENV_HEADER } from "../routes/own-mcp-http-path.ts";
import { TOOL_LIMIT_ENV, TOOL_LIMIT_HEADER } from "../tool-count-limit.ts";
import { TOOL_SCHEMA_PROFILE_ENV } from "../tool-schema-profile.ts";
import { agentsToolList } from "./agents-mcp.ts";
import { acpMcpServers, ownMcpOverHttp } from "./turn-mcp.ts";

const HARNESS = "http://127.0.0.1:8799";
const turn = (extra: Partial<SendTurnInput> = {}): SendTurnInput => ({
  threadId: "t1",
  text: "x",
  integrations: {
    agents: { command: "/usr/local/bin/node", args: ["/app/dist-server/drivers/agents-proxy.js"],
      env: { OMB_HARNESS_URL: HARNESS, OMB_COMMS_TOKEN: "agents-capability", OMB_BOT_ID: "chief", OMB_THREAD_ID: "t1", OMB_CHIEF_OF_STAFF: "1", NODE_OPTIONS: "--x" } },
    browser: { command: "/usr/local/bin/node", args: ["/app/dist-server/harness-mcp-proxy.js", "browser"],
      env: { OMB_HARNESS_URL: HARNESS, OMB_MCP_TOKEN_BROWSER: "browser-capability" } },
    data: { command: "node", args: ["--experimental-strip-types", "/src/server/harness-mcp-proxy.ts", "data"],
      env: { OMB_HARNESS_URL: HARNESS, OMB_MCP_TOKEN_DATA: "data-capability" } },
    custom: { notes: { command: "npx", args: ["-y", "notes-mcp"], env: { NOTES_KEY: "k" } } },
  },
  ...extra,
} as SendTurnInput);

describe("OpenMausBot's own MCP servers for an engine that reaches servers by URL", () => {
  it("turns each own proxy into this server's endpoint with the same capability, and leaves the person's servers as they are", () => {
    const servers = acpMcpServers(turn(), { http: true });
    expect(servers.map((server) => [server.name, "url" in server ? server.url : server.command])).toEqual([
      ["agents", `${HARNESS}/api/internal/mcp-http/agents`],
      ["browser", `${HARNESS}/api/internal/mcp-http/browser`],
      ["data", `${HARNESS}/api/internal/mcp-http/data`],
      ["notes", "npx"],
    ]);
    const agents = servers[0] as { type: string; headers: Array<{ name: string; value: string }> };
    expect(agents.type).toBe("http");
    const header = (name: string) => agents.headers.find((entry) => entry.name === name)?.value;
    expect(header("authorization")).toBe("Bearer agents-capability");
    expect(JSON.parse(Buffer.from(header(AGENTS_ENV_HEADER)!, "base64url").toString("utf8")))
      .toEqual({ OMB_BOT_ID: "chief", OMB_THREAD_ID: "t1", OMB_CHIEF_OF_STAFF: "1" });
    expect((servers[1] as { headers: unknown }).headers).toEqual([{ name: "authorization", value: "Bearer browser-capability" }]);
  });

  it("keeps every proxy process for an engine that does not, and for any server behind a tool-selection gate", () => {
    expect(acpMcpServers(turn()).every((server) => "command" in server)).toBe(true);
    const scoped = acpMcpServers(turn({ toolScope: { allow: ["mcp:*"] } }), { http: true });
    expect(scoped.every((server) => "command" in server)).toBe(true);
  });

  it("recognises only a proxy that reaches this server on loopback and carries its capability", () => {
    const browser = { name: "browser", command: "node", args: ["/app/dist-server/harness-mcp-proxy.js", "browser"], env: { OMB_HARNESS_URL: HARNESS } };
    expect(ownMcpOverHttp(browser)).toBeNull();
    expect(ownMcpOverHttp({ ...browser, env: { OMB_HARNESS_URL: "http://203.0.113.9:8799", OMB_MCP_TOKEN_BROWSER: "c" } })).toBeNull();
    expect(ownMcpOverHttp({ ...browser, args: ["/app/dist-server/harness-mcp-proxy.js", "shell"], env: { OMB_HARNESS_URL: HARNESS, OMB_MCP_TOKEN_BROWSER: "c" } })).toBeNull();
    expect(ownMcpOverHttp({ name: "x", command: "node", args: ["/tmp/my-agents-proxy.js.bak"], env: { OMB_HARNESS_URL: HARNESS, OMB_COMMS_TOKEN: "c" } })).toBeNull();
  });
});

describe("the MCP servers a Kimi Code turn gets", () => {
  const env = (server: ReturnType<typeof acpMcpServers>[number]) =>
    Object.fromEntries(("env" in server ? server.env : []).map(({ name, value }) => [name, value]));
  const withRemote = (extra: Partial<SendTurnInput> = {}) => {
    const base = turn(extra);
    return { ...base, integrations: { ...base.integrations, custom: { ...base.integrations!.custom, docs: { type: "http", url: "https://mcp.example.com/mcp", headers: {} } } } } as SendTurnInput;
  };

  it("carry Moonshot's schema profile on every server, with the person's stdio server behind the gate that fits it", () => {
    const servers = acpMcpServers(withRemote(), { engine: "kimiAgent" });
    expect(servers.map((server) => server.name)).toEqual(["agents", "browser", "data", "notes", "docs"]);
    for (const server of servers) expect([server.name, env(server)[TOOL_SCHEMA_PROFILE_ENV]]).toEqual([server.name, "moonshot"]);
    const notes = servers.find((server) => server.name === "notes") as { command: string; args: string[] };
    expect(notes.args).toEqual([SPAWNED_PROXIES.mcpGate]);
    expect(JSON.parse(env(servers[3]!).OMB_GATE_UPSTREAM!)).toEqual({ command: "npx", args: ["-y", "notes-mcp"], env: { NOTES_KEY: "k" } });
    expect((servers[4] as { args: string[] }).args).toEqual([SPAWNED_PROXIES.mcpRemote]);
  });

  it("keeps the profile on every server behind a tool-selection gate too", () => {
    const servers = acpMcpServers(turn({ toolScope: { allow: ["mcp:*"] } }), { engine: "kimiAgent" });
    for (const server of servers) {
      expect((server as { args: string[] }).args).toEqual([SPAWNED_PROXIES.mcpGate]);
      expect(env(server)[TOOL_SCHEMA_PROFILE_ENV]).toBe("moonshot");
    }
  });

  it("are unchanged for every other engine", () => {
    for (const engine of [undefined, "opencodeGo", "grokAgent", "qwenAgent"]) {
      const servers = acpMcpServers(withRemote(), { engine });
      expect(servers.some((server) => TOOL_SCHEMA_PROFILE_ENV in env(server))).toBe(false);
      expect(servers.find((server) => server.name === "notes")).toEqual({ name: "notes", command: "npx", args: ["-y", "notes-mcp"], env: [{ name: "NOTES_KEY", value: "k" }] });
    }
  });
});

describe("the MCP servers of a turn whose model takes a limited number of tools", () => {
  const env = (server: ReturnType<typeof acpMcpServers>[number]) =>
    Object.fromEntries(("env" in server ? server.env : []).map(({ name, value }) => [name, value]));
  const header = (server: ReturnType<typeof acpMcpServers>[number], name: string) =>
    ("headers" in server ? server.headers : []).find((entry) => entry.name === name)?.value;
  const agentsTools = agentsToolList(turn().integrations!.agents!.env).listed.length;

  it("keeps the agents server's whole list and shares the rest evenly, each over the way that server reads it", () => {
    const servers = acpMcpServers(turn(), { http: true, toolBudget: agentsTools + 10 });
    expect(servers.map((server) => server.name)).toEqual(["agents", "browser", "data", "notes"]);
    const agents = JSON.parse(Buffer.from(header(servers[0]!, AGENTS_ENV_HEADER)!, "base64url").toString("utf8"));
    expect(agents[TOOL_LIMIT_ENV]).toBe(String(agentsTools));
    expect([header(servers[1]!, TOOL_LIMIT_HEADER), header(servers[2]!, TOOL_LIMIT_HEADER)]).toEqual(["4", "3"]);
    const notes = servers[3] as { args: string[] };
    expect(notes.args).toEqual([SPAWNED_PROXIES.mcpGate]);
    expect(env(servers[3]!)[TOOL_LIMIT_ENV]).toBe("3");
    expect(JSON.parse(env(servers[3]!).OMB_GATE_UPSTREAM!)).toEqual({ command: "npx", args: ["-y", "notes-mcp"], env: { NOTES_KEY: "k" } });
  });

  it("trims the agents server too when the budget is smaller than its list", () => {
    const servers = acpMcpServers(turn(), { toolBudget: 5 });
    expect(servers.map((server) => env(server)[TOOL_LIMIT_ENV])).toEqual(["5", "0", "0", "0"]);
  });

  it("leaves every server as it was without a limit", () => {
    for (const server of acpMcpServers(turn(), { http: true })) {
      expect(env(server)[TOOL_LIMIT_ENV]).toBeUndefined();
      expect(header(server, TOOL_LIMIT_HEADER)).toBeUndefined();
    }
  });
});
