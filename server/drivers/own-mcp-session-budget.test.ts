// The native Antigravity CLI's session budget over OpenMausBot's own tools. The golden pins the tool names and schemas,
// descriptions left out, that a default Chief of Staff's session with agents, browser and data shows that CLI; the
// budget itself is held by the tests, so rewording a description needs no new golden.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { TOOL_LIST as BROWSER_TOOLS } from "../browser/tools.ts";
import { CLOUD_COMPUTER_TOOLS } from "../cloud-computer-tools.ts";
import { DATA_TOOLS } from "../data/tools.ts";
import { EMAIL_TOOLS } from "../email/tools.ts";
import { PHONE_TOOLS } from "../phones/tools.ts";
import { SPAWNED_PROXIES } from "../proxy-paths.ts";
import { AGENTS_ENV_HEADER, TOOL_SHARE_HEADER } from "../routes/own-mcp-http-path.ts";
import { cliDrops } from "../testing/cli-tool-drop.ts";
import {
  ANTIGRAVITY_CLI_TOOL_BUDGET, definitionListBytes, fitToolListToShare, PROTECTED_TOOLS, toolListFloorBytes, toolListShare, toolListShareProfile, type ListedTool,
} from "../tool-list-budget.ts";
import { fitToolListForBudget, TOOL_SCHEMA_PROFILE_ENV, toolSchemaProfileFromEnv } from "../tool-schema-profile.ts";
import type { SendTurnInput } from "../contracts.ts";
import { agentsToolList } from "./agents-mcp.ts";
import { antigravityCliToolBudget } from "./antigravity-acp.ts";
import { acpSessionMcpServers } from "./own-mcp-http.ts";
import { sessionToolShares, withSessionToolShares } from "./own-mcp-session-budget.ts";
import { UNKNOWN_LIST_RESERVE } from "./session-tool-budget.ts";
import { TOOL_LIST_SHARE_ENV } from "../tool-list-share.ts";
import { acpMcpServers, type AcpMcpServer } from "./turn-mcp.ts";

const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), "agents-catalog-goldens", "antigravity-cli.tools-list.json");
const UPDATE = process.env.UPDATE_AGENTS_CATALOG_GOLDENS === "1";
/** Where the CLI starts leaving out a session's ~80 tools: kept 58,699 bytes on 1.5.17, between 58,700 and 60,600 on 1.5.16. */
const CLI_DROP_FLOOR = 58_700;

const HARNESS = "http://127.0.0.1:8799";
const CHIEF = { OMB_CHIEF_OF_STAFF: "1", OMB_COMPUTER_SELECTION: "1" };
const NON_CHIEF = { OMB_CHIEF_OF_STAFF: "0", OMB_COMPUTER_SELECTION: "1" };
const FULLEST = { ...CHIEF, OMB_SKILL_AUTHORING_ENABLED: "1", OMB_SHARED_COMPUTERS_ENABLED: "1", OMB_VOICE_NOTES: "1", OMB_X_RESEARCH: "1",
  OMB_RESEARCH: "1", OMB_TEAM_PEOPLE: "1", OMB_TEAM_BOARD: "1", OMB_IMAGE_GENERATION: "1", OMB_APP_HOSTING: "1" };
const agentsList = (env: Record<string, string>) => agentsToolList(env).listed as ListedTool[];
const catalog = (tools: unknown) => tools as readonly ListedTool[];

/** The lists a session shows the CLI: each fitted into the share the session gave it. */
function shown(lists: ReadonlyArray<readonly ListedTool[]>) {
  const { shares, fits } = sessionToolShares(lists, ANTIGRAVITY_CLI_TOOL_BUDGET);
  return { fits, lists: lists.map((tools, index) => fitToolListToShare(tools, shares[index]!)) };
}

const pairs = (record: Record<string, string>) => Object.entries(record).map(([name, value]) => ({ name, value }));
const agentsServer = (settings: Record<string, string>): AcpMcpServer => ({ name: "agents", command: process.execPath, args: [SPAWNED_PROXIES.agents],
  env: pairs({ OMB_HARNESS_URL: HARNESS, OMB_COMMS_TOKEN: "comms", OMB_BOT_ID: "b1", OMB_THREAD_ID: "t1", ...settings }) });
const harnessServer = (kind: string): AcpMcpServer => ({ name: kind, command: process.execPath, args: [SPAWNED_PROXIES.harnessMcp, kind],
  env: pairs({ OMB_HARNESS_URL: HARNESS, [`OMB_MCP_TOKEN_${kind.toUpperCase()}`]: `${kind}-capability` }) });
const notes: AcpMcpServer = { name: "notes", command: "npx", args: ["notes"], env: [] };
const nativeCli = { agentInfo: { name: "Antigravity ACP Server" } };
const oldRuntime = { agentInfo: { name: "antigravity-acp" } };
/** Every description in a schema, and the schema with none of them. */
function descriptionsIn(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(descriptionsIn);
  if (!node || typeof node !== "object") return [];
  return Object.entries(node).flatMap(([key, value]) => (key === "description" && typeof value === "string" ? [value] : descriptionsIn(value)));
}
function withoutDescriptions(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(withoutDescriptions);
  if (!node || typeof node !== "object") return node;
  return Object.fromEntries(Object.entries(node).filter(([key, value]) => !(key === "description" && typeof value === "string")).map(([key, value]) => [key, withoutDescriptions(value)]));
}
const envOf = (server: AcpMcpServer) => ("env" in server ? Object.fromEntries(server.env.map(({ name, value }) => [name, value])) : {});

describe("a native Antigravity CLI session's own tools", () => {
  const cases: Array<[string, Record<string, string>, string[]]> = [];
  for (const [who, env] of [["non-Chief", NON_CHIEF], ["Chief", CHIEF], ["fullest Chief", FULLEST]] as const) {
    cases.push([`${who}: agents`, env, []], [`${who}: agents + browser`, env, ["browser"]], [`${who}: agents + browser + data`, env, ["browser", "data"]],
      [`${who}: agents + browser + data + cloud computer`, env, ["browser", "data", "computer"]]);
  }
  const catalogs: Record<string, readonly ListedTool[]> = { browser: catalog(BROWSER_TOOLS), data: catalog(DATA_TOOLS), computer: catalog(CLOUD_COMPUTER_TOOLS) };

  it.each(cases)("all reach the model, within the budget: %s", (_name, env, others) => {
    const lists = [agentsList(env), ...others.map((kind) => catalogs[kind]!)];
    const session = shown(lists);
    expect(session.fits).toBe(true);
    const tools = session.lists.flatMap((list) => list.tools);
    expect(definitionListBytes(tools)).toBeLessThanOrEqual(ANTIGRAVITY_CLI_TOOL_BUDGET);
    expect(cliDrops(tools, CLI_DROP_FLOOR)).toEqual([]);
    expect(tools.map((tool) => tool.name)).toEqual(lists.flat().map((tool) => tool.name));
  });

  // The guard that would have caught the bug: these lists as they were sent lose coordinate_bots, and a tool that pushes
  // the default Chief's session past what shortening can absorb fails here before it reaches anyone.
  it("a default Chief of Staff with browser and data loses tools to the CLI unfitted, and keeps every one fitted", () => {
    const lists = [agentsList(CHIEF), catalog(BROWSER_TOOLS), catalog(DATA_TOOLS)];
    expect(cliDrops(lists.flat(), CLI_DROP_FLOOR)).toContain("coordinate_bots");
    const session = shown(lists);
    expect(session.fits).toBe(true);
    expect(cliDrops(session.lists.flatMap((list) => list.tools), CLI_DROP_FLOOR)).toEqual([]);
    // Every tool description of 500 characters or less still whole: shorter means the lists grew; look before lowering.
    expect(session.lists[0]!.level.tools).toBeGreaterThanOrEqual(500);
  });

  it("even with every own server and the fullest Chief, the CLI's largest-first drop never takes a protected tool", () => {
    const lists = [agentsList(FULLEST), catalog(BROWSER_TOOLS), catalog(DATA_TOOLS), catalog(CLOUD_COMPUTER_TOOLS), catalog(EMAIL_TOOLS), catalog(PHONE_TOOLS)];
    const tools = shown(lists).lists.flatMap((list) => list.tools);
    expect(tools.map((tool) => tool.name)).toEqual(lists.flat().map((tool) => tool.name));
    expect(cliDrops(tools, CLI_DROP_FLOOR).filter((name) => PROTECTED_TOOLS.includes(name))).toEqual([]);
  });

  it("matches the golden: a default Chief of Staff's agents, browser and data as the CLI is shown them, words aside", () => {
    const lists = [agentsList(CHIEF), catalog(BROWSER_TOOLS), catalog(DATA_TOOLS)];
    const { shares } = sessionToolShares(lists, ANTIGRAVITY_CLI_TOOL_BUDGET);
    // The agents list as its endpoint serves it under its share, the others as theirs fit their catalogs.
    const served = [agentsList({ ...CHIEF, [TOOL_SCHEMA_PROFILE_ENV]: toolListShareProfile(shares[0]!) }),
      fitToolListToShare(lists[1]!, shares[1]!).tools, fitToolListToShare(lists[2]!, shares[2]!).tools];
    // Every description shown is the start of the tool's own, cut at a sentence or a word.
    served.forEach((tools, index) => tools.forEach((tool, at) => {
      const original = lists[index]![at]!;
      expect(tool.name).toBe(original.name);
      const kept = (tool.description ?? "").replace(/…$/, "");
      expect(original.description?.startsWith(kept), tool.name).toBe(true);
      for (const text of descriptionsIn(tool.inputSchema)) expect(descriptionsIn(original.inputSchema).some((whole) => whole.startsWith(text.replace(/…$/, ""))), tool.name).toBe(true);
    }));
    // Pinned: each tool's name and schema, descriptions left out, so rewording a description never touches it.
    const pinned = Object.fromEntries(["agents", "browser", "data"].map((server, index) =>
      [server, served[index]!.map((tool) => ({ name: tool.name, inputSchema: withoutDescriptions(tool.inputSchema) }))]));
    const text = `${JSON.stringify(pinned, null, 2)}\n`;
    if (UPDATE) writeFileSync(GOLDEN, text);
    expect(text, "The native Antigravity CLI's tool schemas changed. If on purpose, regenerate the golden with "
      + "UPDATE_AGENTS_CATALOG_GOLDENS=1 ./node_modules/.bin/vitest run server/drivers/own-mcp-session-budget.test.ts and review its diff.")
      .toBe(readFileSync(GOLDEN, "utf8").replace(/\r\n/g, "\n"));
  });
});

describe("sharing out a session's budget", () => {
  it("gives each list what it comes to at one cut for all, plus its part of what is left, within the budget", () => {
    const lists = [agentsList(CHIEF), catalog(BROWSER_TOOLS), catalog(DATA_TOOLS)];
    const { shares, bytes, fits } = sessionToolShares(lists, ANTIGRAVITY_CLI_TOOL_BUDGET);
    expect(fits).toBe(true);
    expect(bytes).toBeLessThanOrEqual(ANTIGRAVITY_CLI_TOOL_BUDGET);
    expect(shares.reduce((sum, share) => sum + share, 0)).toBeLessThanOrEqual(ANTIGRAVITY_CLI_TOOL_BUDGET);
    expect(shares.every((share, index) => fitToolListToShare(lists[index]!, share).fits)).toBe(true);
  });

  it("gives lists that fit whole more than they need, and splits a budget they cannot fit by size", () => {
    const small = [{ name: "a", description: "x".repeat(100) }, { name: "b", description: "y".repeat(300) }];
    const { shares, fits } = sessionToolShares([small.slice(0, 1), small.slice(1)], 10_000);
    expect(fits).toBe(true);
    expect(shares[0]! + shares[1]!).toBeLessThanOrEqual(10_000);
    expect(shares[1]! / shares[0]!).toBeCloseTo(definitionListBytes(small.slice(1)) / definitionListBytes(small.slice(0, 1)), 1);
    const over = sessionToolShares([agentsList(FULLEST)], 10_000);
    expect(over).toMatchObject({ fits: false, shares: [10_000] });
  });

  it("sets OpenMausBot's own servers' shares in OMB_TOOL_SCHEMA_PROFILE, any earlier profile replaced, and leaves the person's servers alone", () => {
    const servers = [agentsServer({ ...CHIEF, [TOOL_SCHEMA_PROFILE_ENV]: "gemini" }), harnessServer("browser"), harnessServer("data"), notes];
    const shared = withSessionToolShares(servers, ANTIGRAVITY_CLI_TOOL_BUDGET);
    expect(shared[3]).toBe(notes);
    const shares = shared.slice(0, 3).map((server) => toolListShare(envOf(server)[TOOL_SCHEMA_PROFILE_ENV]));
    expect(shares).toEqual(sessionToolShares([agentsList(CHIEF), catalog(BROWSER_TOOLS), catalog(DATA_TOOLS)], ANTIGRAVITY_CLI_TOOL_BUDGET).shares);
    expect(shared.slice(0, 3).map((server) => ("env" in server ? server.env.filter(({ name }) => name === TOOL_SCHEMA_PROFILE_ENV).length : 0))).toEqual([1, 1, 1]);
  });

  it("logs one line when the session cannot fit, by how much, and which servers it did not count", () => {
    const logged: string[] = [];
    withSessionToolShares([agentsServer(FULLEST), ...["browser", "data", "computer", "email", "device"].map(harnessServer), notes], 40_000, (line) => logged.push(line));
    expect(logged).toEqual([expect.stringMatching(/^\[mcp\] this session's own MCP tools \(agents, browser, data, computer, email, device\) come to (\d+) bytes at their shortest, \d+ over the 40000-byte tool budget; the engine leaves out its largest tools first \(notes not counted\)$/)]);
    expect(withSessionToolShares([notes], 40_000, (line) => logged.push(line))).toEqual([notes]);
    expect(logged).toHaveLength(1);
  });
});

describe("which sessions share a budget", () => {
  const servers = [agentsServer(CHIEF), harnessServer("browser"), harnessServer("data"), notes];
  const takesUrls = () => true;

  it("only the native CLI's: the pinned runtime and every other agent send their servers as before", () => {
    expect(antigravityCliToolBudget(nativeCli)).toBe(ANTIGRAVITY_CLI_TOOL_BUDGET);
    for (const init of [oldRuntime, {}, null, { agentInfo: { name: "Google Antigravity" } }]) expect(antigravityCliToolBudget(init)).toBeUndefined();
    expect(acpSessionMcpServers(servers, "advertised", oldRuntime, takesUrls, antigravityCliToolBudget))
      .toEqual(acpSessionMcpServers(servers, "advertised", oldRuntime, takesUrls));
    expect(acpSessionMcpServers(servers, "stdio", oldRuntime, takesUrls, antigravityCliToolBudget)).toBe(servers);
  });

  it("reaches each own server by URL: the agents share in its settings header, each harness server's in its own header", () => {
    const sent = acpSessionMcpServers(servers, "advertised", nativeCli, takesUrls, antigravityCliToolBudget);
    const header = (server: AcpMcpServer, name: string) => ("headers" in server ? server.headers.find((entry) => entry.name === name)?.value : undefined);
    const agentsSettings = JSON.parse(Buffer.from(header(sent[0]!, AGENTS_ENV_HEADER)!, "base64url").toString("utf8")) as Record<string, string>;
    // The person's server, not relayed by OpenMausBot, is counted at a reserve and sent as it is.
    const expected = sessionToolShares([agentsList(CHIEF), catalog(BROWSER_TOOLS), catalog(DATA_TOOLS), UNKNOWN_LIST_RESERVE], ANTIGRAVITY_CLI_TOOL_BUDGET).shares;
    expect(toolListShare(agentsSettings[TOOL_SCHEMA_PROFILE_ENV])).toBe(expected[0]);
    expect([header(sent[1]!, TOOL_SHARE_HEADER), header(sent[2]!, TOOL_SHARE_HEADER)].map(toolListShare)).toEqual(expected.slice(1, 3));
    expect(sent[3]).toBe(notes);
  });

  it("reaches each own server as a stdio proxy too, with OMB_OWN_MCP_HTTP=0", () => {
    const sent = acpSessionMcpServers(servers, "stdio", nativeCli, takesUrls, antigravityCliToolBudget);
    expect(sent.slice(0, 3).map((server) => toolListShare(envOf(server)[TOOL_SCHEMA_PROFILE_ENV]))).toEqual(
      sessionToolShares([agentsList(CHIEF), catalog(BROWSER_TOOLS), catalog(DATA_TOOLS), UNKNOWN_LIST_RESERVE], ANTIGRAVITY_CLI_TOOL_BUDGET).shares.slice(0, 3));
  });
});

describe("on Antigravity, beside the Gemini engines' schema profile", () => {
  // As the ACP driver builds an Antigravity turn's servers: every one carries the gemini profile, and the person's stdio
  // server goes through the MCP gate, which fits each of its tools.
  const turn = {
    threadId: "t1", text: "x",
    integrations: {
      agents: { command: process.execPath, args: [SPAWNED_PROXIES.agents], env: { OMB_HARNESS_URL: HARNESS, OMB_COMMS_TOKEN: "comms", OMB_BOT_ID: "b1", OMB_THREAD_ID: "t1", ...CHIEF } },
      browser: { command: process.execPath, args: [SPAWNED_PROXIES.harnessMcp, "browser"], env: { OMB_HARNESS_URL: HARNESS, OMB_MCP_TOKEN_BROWSER: "browser-capability" } },
      data: { command: process.execPath, args: [SPAWNED_PROXIES.harnessMcp, "data"], env: { OMB_HARNESS_URL: HARNESS, OMB_MCP_TOKEN_DATA: "data-capability" } },
      custom: { notes: { command: "npx", args: ["-y", "notes-mcp"], env: {} } },
    },
  } as SendTurnInput;
  const built = acpMcpServers(turn, { engine: "antigravityAgent" });
  const header = (server: AcpMcpServer, name: string) => ("headers" in server ? server.headers.find((entry) => entry.name === name)?.value : undefined);
  const settingsOf = (server: AcpMcpServer) => JSON.parse(Buffer.from(header(server, AGENTS_ENV_HEADER)!, "base64url").toString("utf8")) as Record<string, string>;

  it("starts from the gemini profile on every server, the person's behind the gate", () => {
    expect(built.map((server) => envOf(server)[TOOL_SCHEMA_PROFILE_ENV])).toEqual(["gemini", "gemini", "gemini", "gemini"]);
    expect((built[3] as { args: string[] }).args[0]).toBe(SPAWNED_PROXIES.mcpGate);
  });

  it("the native CLI: one trim of OpenMausBot's own servers, the session's shares in place of gemini, and the person's gate given the rest", () => {
    const logged: string[] = [];
    const sent = acpSessionMcpServers(built, "advertised", nativeCli, () => true, antigravityCliToolBudget);
    // The gate has no record yet: it is set aside what the own lists leave at their shortest.
    const own = [agentsList(CHIEF), catalog(BROWSER_TOOLS), catalog(DATA_TOOLS)];
    const reserve = ANTIGRAVITY_CLI_TOOL_BUDGET - own.reduce((sum, tools) => sum + toolListFloorBytes(tools), 0);
    const shares = sessionToolShares([...own, reserve], ANTIGRAVITY_CLI_TOOL_BUDGET).shares;
    const agentsSettings = settingsOf(sent[0]!);
    expect(toolListShare(agentsSettings[TOOL_SCHEMA_PROFILE_ENV])).toBe(shares[0]);
    expect([header(sent[1]!, TOOL_SHARE_HEADER), header(sent[2]!, TOOL_SHARE_HEADER)].map(toolListShare)).toEqual(shares.slice(1, 3));
    expect(JSON.stringify(sent.slice(0, 3))).not.toContain("gemini");
    const gate = envOf(sent[3]!);
    expect(Number(gate[TOOL_LIST_SHARE_ENV])).toBe(shares[3]);
    expect(gate[TOOL_SCHEMA_PROFILE_ENV]).toBe("gemini");
    expect({ ...sent[3]!, env: (sent[3] as { env: unknown[] }).env.slice(0, -2) }).toEqual(built[3]);
    // The agents endpoint under that share serves exactly the session's fit: gemini's own list budget does not run on top.
    const env = { ...agentsSettings, OMB_HARNESS_URL: HARNESS, OMB_COMMS_TOKEN: "comms" };
    const served = agentsToolList(env).listed as ListedTool[];
    expect(toolSchemaProfileFromEnv(env)).toBeUndefined();
    expect(fitToolListForBudget(served, toolSchemaProfileFromEnv(env), (line) => logged.push(line))).toEqual(served);
    expect(logged).toEqual([]);
    expect(definitionListBytes(served)).toBeLessThanOrEqual(shares[0]!);
    expect(served.map((tool) => tool.name)).toEqual(agentsList(CHIEF).map((tool) => tool.name));
  });

  it("the pinned runtime: every server keeps the gemini profile, and the agents list is gemini's fit alone", () => {
    const sent = acpSessionMcpServers(built, "advertised", oldRuntime, () => false, antigravityCliToolBudget);
    expect(sent).toBe(built);
    const env = envOf(sent[0]!);
    expect(agentsToolList(env).listed).toEqual(agentsToolList({ ...env, [TOOL_SCHEMA_PROFILE_ENV]: "" }).listed);
    expect(toolSchemaProfileFromEnv(env)?.id).toBe("gemini");
  });
});

