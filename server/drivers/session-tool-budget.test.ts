// The native Antigravity CLI's session budget over every server of a session: OpenMausBot's own, the connected apps and
// the person's own servers behind OpenMausBot's relays. The CLI leaves out a session's largest tools first once their
// definitions pass its budget (kept about 58,700 bytes of ~100 tools on 1.5.16 to 1.5.18), which reads as "every tool
// over about 950 bytes is dropped" once a connected-apps server adds dozens of tools.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { TOOL_LIST as BROWSER_TOOLS } from "../browser/tools.ts";
import { DATA_TOOLS } from "../data/tools.ts";
import { fitToolList } from "../mcp-tool-schema.ts";
import { SPAWNED_PROXIES } from "../proxy-paths.ts";
import { TOOL_SHARE_HEADER } from "../routes/own-mcp-http-path.ts";
import { cliDrops } from "../testing/cli-tool-drop.ts";
import { whopLikeCatalog } from "../testing/whop-like-catalog.ts";
import { workspaceAppsLikeCatalog } from "../testing/workspace-apps-like-catalog.ts";
import {
  ANTIGRAVITY_CLI_TOOL_BUDGET, ANTIGRAVITY_CLI_TOOL_LIMIT, COORDINATION_TOOLS, definitionListBytes, toolListFloorBytes, toolsForShareProfile, type ListedTool,
} from "../tool-list-budget.ts";
import { TOOL_LIST_RECORD_ENV, TOOL_LIST_SHARE_ENV, toolsForSessionShare } from "../tool-list-share.ts";
import { TOOL_SCHEMA_PROFILE_ENV, toolSchemaProfile } from "../tool-schema-profile.ts";
import { agentsToolList } from "./agents-mcp.ts";
import { antigravityCliTakesHttpMcp, antigravityCliToolBudget } from "./antigravity-acp.ts";
import { acpSessionMcpServers } from "./own-mcp-http.ts";
import { withSessionToolShares } from "./own-mcp-session-budget.ts";
import { SESSION_TOOL_BUDGET_ENV, UNKNOWN_LIST_RESERVE, withSessionToolBudget } from "./session-tool-budget.ts";
import { acpMcpServers, type AcpMcpServer } from "./turn-mcp.ts";
import type { SendTurnInput } from "../contracts.ts";

const CLI_DROP_FLOOR = 58_700;
const HARNESS = "http://127.0.0.1:8799";
const CHIEF = { OMB_CHIEF_OF_STAFF: "1", OMB_COMPUTER_SELECTION: "1" };
const gemini = toolSchemaProfile("gemini")!;
type Stdio = Extract<AcpMcpServer, { command: string }>;

const pairs = (record: Record<string, string>) => Object.entries(record).map(([name, value]) => ({ name, value }));
const envOf = (server: AcpMcpServer) => ("command" in server ? Object.fromEntries(server.env.map(({ name, value }) => [name, value])) : {});
const agents: Stdio = { name: "agents", command: process.execPath, args: [SPAWNED_PROXIES.agents],
  env: pairs({ OMB_HARNESS_URL: HARNESS, OMB_COMMS_TOKEN: "comms", OMB_BOT_ID: "b1", OMB_THREAD_ID: "t1", ...CHIEF }) };
const harness = (kind: string): Stdio => ({ name: kind, command: process.execPath, args: [SPAWNED_PROXIES.harnessMcp, kind],
  env: pairs({ OMB_HARNESS_URL: HARNESS, [`OMB_MCP_TOKEN_${kind.toUpperCase()}`]: `${kind}-capability`, [TOOL_SCHEMA_PROFILE_ENV]: "gemini" }) });
const relay = (name: string, script: string): Stdio => ({ name, command: process.execPath, args: [script], env: pairs({ OMB_BOT_ID: "b1", [TOOL_SCHEMA_PROFILE_ENV]: "gemini" }) });
const composio = relay("composio", SPAWNED_PROXIES.connectors);
const workspace = relay("workspace", SPAWNED_PROXIES.mcpGate);

/** What each relayed server really lists, after the gemini profile its relay applies first. */
const LISTS: Record<string, readonly ListedTool[]> = {
  composio: fitToolList(workspaceAppsLikeCatalog(), gemini) as ListedTool[],
  workspace: fitToolList(whopLikeCatalog().slice(0, 30), gemini) as ListedTool[],
};
const OWN: Record<string, readonly ListedTool[]> = { agents: agentsToolList(CHIEF).listed as ListedTool[], browser: BROWSER_TOOLS, data: DATA_TOOLS as readonly ListedTool[] };

/** Each server's list as the engine is shown it under the planned servers: own servers by their profile, relays by
 * their share (recording as they go). */
function shown(planned: AcpMcpServer[]): Record<string, ListedTool[]> {
  return Object.fromEntries(planned.map((server) => {
    const env = envOf(server);
    const tools = server.name in OWN ? toolsForShareProfile(OWN[server.name]!, env[TOOL_SCHEMA_PROFILE_ENV]) : toolsForSessionShare(LISTS[server.name]!, env);
    return [server.name, tools as ListedTool[]];
  }));
}
const flat = (lists: Record<string, ListedTool[]>) => Object.entries(lists).flatMap(([server, tools]) => tools.map((tool) => ({ ...tool, name: `${server}/${tool.name}` })));

function plan(servers: AcpMcpServer[], recordsDir: string, env: NodeJS.ProcessEnv = {}) {
  const logged: string[] = [];
  return { planned: withSessionToolBudget(servers, ANTIGRAVITY_CLI_TOOL_BUDGET, { env, recordsDir, log: (line) => logged.push(line) }), logged };
}

describe("the session's tool budget over every server", () => {
  const session = [agents, harness("browser"), harness("data"), composio];

  it("a Chief with 74 connected-app tools: without it the CLI leaves out a whole size class, Drive, Docs and Photos with own tools", () => {
    const ownOnly = withSessionToolShares(session, ANTIGRAVITY_CLI_TOOL_BUDGET, () => {});
    const lists = { ...shown(ownOnly.filter((server) => server.name in OWN)), composio: [...LISTS.composio!] };
    const dropped = cliDrops(flat(lists), CLI_DROP_FLOOR);
    expect(dropped).toEqual(expect.arrayContaining(["agents/trigger", "composio/GOOGLEDRIVE_FIND_FILE", "composio/GOOGLEDOCS_CREATE_DOCUMENT"]));
    expect(dropped.some((name) => name.startsWith("composio/GMAIL_"))).toBe(false);
  });

  it("first session, nothing recorded: the relay is set aside what the own servers leave at their shortest, and nothing is dropped", () => {
    const recordsDir = mkdtempSync(join(tmpdir(), "stb-"));
    const { planned } = plan(session, recordsDir);
    const ownFloor = Object.values(OWN).reduce((sum, tools) => sum + toolListFloorBytes(tools), 0);
    const share = Number(envOf(planned[3]!)[TOOL_LIST_SHARE_ENV]);
    expect(share).toBeGreaterThanOrEqual(ANTIGRAVITY_CLI_TOOL_BUDGET - ownFloor - 2);
    expect(share).toBeGreaterThanOrEqual(UNKNOWN_LIST_RESERVE);
    const lists = shown(planned);
    expect(Object.fromEntries(Object.entries(lists).map(([server, tools]) => [server, tools.map((tool) => tool.name)])))
      .toEqual({ ...Object.fromEntries(Object.entries(OWN).map(([server, tools]) => [server, tools.map((tool) => tool.name)])), composio: LISTS.composio!.map((tool) => tool.name) });
    expect(cliDrops(flat(lists), CLI_DROP_FLOOR)).toEqual([]);
  });

  it("next session: the relay's record sizes every share at one cut, and still nothing is dropped", () => {
    const recordsDir = mkdtempSync(join(tmpdir(), "stb-"));
    shown(plan(session, recordsDir).planned);
    const { planned } = plan(session, recordsDir);
    const lists = shown(planned);
    expect(flat(lists)).toHaveLength(Object.values(OWN).flat().length + LISTS.composio!.length);
    expect(cliDrops(flat(lists), CLI_DROP_FLOOR)).toEqual([]);
    for (const [server, tools] of Object.entries(lists)) {
      const before = server in OWN ? OWN[server]! : LISTS[server]!;
      tools.forEach((tool, index) => {
        expect(tool.name).toBe(before[index]!.name);
        expect((tool.inputSchema as { required?: unknown }).required).toEqual((before[index]!.inputSchema as { required?: unknown }).required);
      });
    }
  });

  it("a session that cannot fit even at its shortest leaves out its servers' least important tools itself, never a coordination tool", () => {
    const recordsDir = mkdtempSync(join(tmpdir(), "stb-"));
    const big = [...session, workspace];
    LISTS.workspace = fitToolList(whopLikeCatalog().slice(0, 120), gemini) as ListedTool[];
    try {
      shown(plan(big, recordsDir).planned);
      const { planned, logged } = plan(big, recordsDir);
      const lists = shown(planned);
      expect(flat(lists).length).toBeLessThan(Object.values(OWN).flat().length + LISTS.composio!.length + LISTS.workspace.length);
      for (const name of COORDINATION_TOOLS) expect(lists.agents!.map((tool) => tool.name)).toContain(name);
      const all = Object.values(lists).flat();
      expect(definitionListBytes(all)).toBeLessThanOrEqual(ANTIGRAVITY_CLI_TOOL_LIMIT);
      expect(cliDrops(all, ANTIGRAVITY_CLI_TOOL_LIMIT)).toEqual([]);
      expect(logged).toEqual([expect.stringMatching(/^\[mcp\] this session's MCP tools \(agents, browser, data, composio, workspace\) come to \d+ bytes at their shortest, \d+ over the 55000-byte tool budget; each server leaves out its least important tools to fit its share$/)]);
    } finally {
      LISTS.workspace = fitToolList(whopLikeCatalog().slice(0, 30), gemini) as ListedTool[];
    }
  });

  it("gives every relay its share and a record path in its environment, any earlier one replaced; own servers keep theirs in the profile", () => {
    const recordsDir = mkdtempSync(join(tmpdir(), "stb-"));
    const stale = { ...composio, env: [...composio.env, { name: TOOL_LIST_SHARE_ENV, value: "1" }] };
    const { planned } = plan([agents, harness("browser"), stale, workspace], recordsDir);
    for (const server of planned.slice(2)) {
      const env = envOf(server);
      expect(("command" in server ? server.env : []).filter(({ name }) => name === TOOL_LIST_SHARE_ENV)).toHaveLength(1);
      expect(Number(env[TOOL_LIST_SHARE_ENV])).toBeGreaterThan(UNKNOWN_LIST_RESERVE - 1);
      expect(env[TOOL_LIST_RECORD_ENV]).toMatch(new RegExp(`^${recordsDir.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}`));
      expect(env[TOOL_SCHEMA_PROFILE_ENV]).toBe("gemini");
    }
    expect(envOf(planned[0]!)[TOOL_SCHEMA_PROFILE_ENV]).toMatch(/^listShare:\d+$/);
    expect(envOf(planned[0]!)[TOOL_LIST_RECORD_ENV]).toBeUndefined();
  });

  it("OMB_SESSION_TOOL_BUDGET=0 shares the budget among own servers only, as before, and leaves every relay alone", () => {
    const recordsDir = mkdtempSync(join(tmpdir(), "stb-"));
    const { planned } = plan(session, recordsDir, { [SESSION_TOOL_BUDGET_ENV]: "0" });
    expect(planned).toEqual(withSessionToolShares(session, ANTIGRAVITY_CLI_TOOL_BUDGET, () => {}));
    expect(planned[3]).toBe(composio);
  });

  it("counts a server it does not relay without touching it, and says so", () => {
    const notes: Stdio = { name: "notes", command: "npx", args: ["notes-mcp"], env: [] };
    const { planned, logged } = plan([agents, notes], mkdtempSync(join(tmpdir(), "stb-")));
    expect(planned[1]).toBe(notes);
    expect(logged).toContain(`[mcp] notes: not relayed by OpenMausBot, so not fitted to the session's tool budget (${UNKNOWN_LIST_RESERVE} bytes set aside each)`);
  });

  it("names the recorded tools the CLI refuses for their name, whatever their size", () => {
    const recordsDir = mkdtempSync(join(tmpdir(), "stb-"));
    const long = { name: `GOOGLEDRIVE_${"X".repeat(50)}`, description: "d", inputSchema: { type: "object" } };
    toolsForSessionShare([long], envOf(plan([composio], recordsDir).planned[0]!));
    const { logged } = plan([composio], recordsDir);
    expect(logged).toContain(`[mcp] composio: the engine refuses 1 tool(s) whose name as mcp_composio_<tool> is over 64 characters or not [a-zA-Z0-9_-]: ${long.name}`);
  });

  it("reaches the relays by stdio and own servers by URL or stdio alike, OMB_OWN_MCP_HTTP=0 included", () => {
    const init = { agentInfo: { name: "Antigravity ACP Server" } };
    for (const transport of ["advertised", "stdio"] as const) {
      const sent = acpSessionMcpServers(session, transport, init, antigravityCliTakesHttpMcp, antigravityCliToolBudget);
      const browser = sent.find((server) => server.name === "browser")!;
      if (transport === "advertised") expect("headers" in browser && browser.headers.some(({ name }) => name === TOOL_SHARE_HEADER)).toBe(true);
      else expect(envOf(browser)[TOOL_SCHEMA_PROFILE_ENV]).toMatch(/^listShare:\d+$/);
      expect(Number(envOf(sent.find((server) => server.name === "composio")!)[TOOL_LIST_SHARE_ENV])).toBeGreaterThan(0);
    }
    expect(acpSessionMcpServers(session, "stdio", { agentInfo: { name: "antigravity-acp" } }, antigravityCliTakesHttpMcp, antigravityCliToolBudget)).toBe(session);
  });

  it("is within the budget in the definitions the CLI writes, every own list included", () => {
    const recordsDir = mkdtempSync(join(tmpdir(), "stb-"));
    shown(plan(session, recordsDir).planned);
    const lists = shown(plan(session, recordsDir).planned);
    expect(definitionListBytes(flat(lists))).toBeLessThan(CLI_DROP_FLOOR);
  });

  it("with a tool selection, every server behind the gate: own servers still sized by their lists, the connected apps given the rest", () => {
    const turn = {
      threadId: "t1", text: "x", toolScope: { allow: ["mcp:agents:*", "mcp:browser:*", "mcp:data:*", "mcp:composio:*", "native:*"] },
      integrations: {
        agents: { command: process.execPath, args: [SPAWNED_PROXIES.agents], env: { ...envOf(agents) } },
        browser: { command: process.execPath, args: [SPAWNED_PROXIES.harnessMcp, "browser"], env: { OMB_HARNESS_URL: HARNESS, OMB_MCP_TOKEN_BROWSER: "b" } },
        data: { command: process.execPath, args: [SPAWNED_PROXIES.harnessMcp, "data"], env: { OMB_HARNESS_URL: HARNESS, OMB_MCP_TOKEN_DATA: "d" } },
        composio: { command: process.execPath, args: [SPAWNED_PROXIES.connectors], env: { OMB_BOT_ID: "b1" } },
      },
    } as SendTurnInput;
    const built = acpMcpServers(turn, { engine: "antigravityAgent" });
    expect(built.every((server) => "command" in server && server.args[0] === SPAWNED_PROXIES.mcpGate)).toBe(true);
    const sent = acpSessionMcpServers(built, "advertised", { agentInfo: { name: "Antigravity ACP Server" } }, antigravityCliTakesHttpMcp, antigravityCliToolBudget);
    const share = (name: string) => Number(envOf(sent.find((server) => server.name === name)!)[TOOL_LIST_SHARE_ENV]);
    for (const [name, tools] of Object.entries(OWN)) expect(share(name)).toBeGreaterThanOrEqual(toolListFloorBytes(tools));
    expect(share("composio")).toBeGreaterThan(UNKNOWN_LIST_RESERVE);
    expect(["agents", "browser", "data", "composio"].reduce((sum, name) => sum + share(name), 0)).toBeLessThanOrEqual(ANTIGRAVITY_CLI_TOOL_BUDGET);
  });
});
