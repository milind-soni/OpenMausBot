import { describe, expect, it } from "vitest";

import type { SendTurnInput } from "../contracts.ts";
import { SPAWNED_PROXIES } from "../proxy-paths.ts";
import { AGENTS_ENV_HEADER } from "../routes/own-mcp-http-path.ts";
import { TOOL_SCHEMA_PROFILE_ENV } from "../tool-schema-profile.ts";
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
