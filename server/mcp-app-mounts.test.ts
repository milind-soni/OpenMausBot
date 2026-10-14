import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import type { SendTurnInput } from "./contracts.ts";
import { mountChatTools, type ChatToolSession } from "./drivers/chat-mcp-tools.ts";
import { buildMcpServers } from "./drivers/pi.ts";
import { turnStdioMcpServers } from "./drivers/turn-mcp.ts";
import { appMountFor, gateServer, mcpStdioServer } from "./mcp-gate-config.ts";
import type { McpAppReport } from "./mcp-app-observer.ts";

const FAKE_APP = fileURLToPath(new URL("./testing/fake-stdio-app-server.ts", import.meta.url));
const HARNESS = "http://127.0.0.1:8799";
const agents = { command: process.execPath, args: ["agents-proxy.js"], env: { OMB_HARNESS_URL: HARNESS, OMB_COMMS_TOKEN: "comms-fixture" } };
const board = { command: "board-mcp", args: ["--stdio"], env: { BOARD_KEY: "k" } };
const notes = { command: "notes-mcp", args: [], env: {} };
const draw = { type: "http" as const, url: "https://draw.example/mcp", headers: { Authorization: "Bearer d" } };
const docs = { type: "http" as const, url: "https://docs.example/mcp", headers: {} };
const mount = (server: string, extension = true) => ({ server, harnessUrl: HARNESS, token: "comms-fixture", extension });
const APPS = { board: { extension: true }, draw: { extension: true } };

type Turn = Pick<SendTurnInput, "threadId" | "text" | "integrations" | "toolScope">;
const turn = (extra: Partial<Turn> = {}): SendTurnInput => ({ threadId: "t-apps", text: "go", integrations: { agents, custom: { board, notes, draw, docs }, mcpApps: APPS }, ...extra }) as SendTurnInput;
const env = (descriptor: { env?: Record<string, string> } | undefined, key: string) => {
  const value = descriptor?.env?.[key];
  return value === undefined ? undefined : JSON.parse(value);
};

describe("the shared decision", () => {
  it("observes a server only when the turn names it as an app server, mounts it and can report", () => {
    expect(appMountFor("board", turn())).toEqual(mount("board"));
    expect(appMountFor("notes", turn())).toBeUndefined();
    expect(appMountFor("board", turn({ integrations: { agents, custom: { board } } }))).toBeUndefined();
    expect(appMountFor("board", turn({ integrations: { custom: { board }, mcpApps: APPS } }))).toBeUndefined();
    expect(appMountFor("board", turn({ integrations: { agents, custom: {}, mcpApps: APPS } }))).toBeUndefined();
    expect(appMountFor("board", turn({ integrations: { agents, custom: { board }, mcpApps: { board: { extension: false } } } }))).toEqual(mount("board", false));
  });

  it("gates a command app server with no budget or selection, and puts its settings in a private record when asked", () => {
    const gated = gateServer({ name: "board", server: board, threadId: "t", budget: 0, apps: mount("board") })!;
    expect(gated.args[0]).toContain("mcp-gate");
    expect(env(gated, "OMB_GATE_APPS")).toEqual(mount("board"));
    expect(env(gated, "OMB_GATE_UPSTREAM")).toEqual(board);
    expect(gated.env).not.toHaveProperty("OMB_GATE_TOOL_SCOPE");
    const record = `OMB_GATE_CONFIG_${"a".repeat(64)}`;
    const shared = gateServer({ name: "board", server: board, threadId: "t", budget: 0, apps: mount("board"), configEnvName: record })!;
    expect(Object.keys(shared.env)).toEqual([record]);
    expect(JSON.parse(JSON.parse(shared.env[record]!).OMB_GATE_APPS)).toEqual(mount("board"));
    // a private record is still refused for a gate that neither selects nor observes
    expect(() => gateServer({ name: "notes", server: notes, threadId: "t", budget: 5, configEnvName: record })).toThrow(/private MCP gate/);
  });

  it("observes a URL app server in the proxy: alone without a selection, inside a gate that does not observe with one", () => {
    const proxy = gateServer({ name: "draw", server: draw, threadId: "t", budget: 1_000, apps: mount("draw"), directory: true })!;
    expect(proxy.args[0]).toContain("mcp-remote-proxy");
    expect(env(proxy, "OMB_REMOTE_MCP_APPS")).toEqual(mount("draw"));
    expect(env(proxy, "OMB_REMOTE_MCP_DIRECTORY")).toEqual({ name: "draw" });
    const gated = gateServer({ name: "draw", server: draw, threadId: "t", budget: 0, toolScope: { allow: ["mcp:draw:*"] }, apps: mount("draw") })!;
    expect(gated.args[0]).toContain("mcp-gate");
    expect(gated.env).not.toHaveProperty("OMB_GATE_APPS");
    expect(env(env(gated, "OMB_GATE_UPSTREAM"), "OMB_REMOTE_MCP_APPS")).toEqual(mount("draw"));
  });

  it("leaves a server without apps byte for byte as before", () => {
    for (const [server, budget] of [[notes, 0], [notes, 2_000], [docs, 0], [docs, 2_000]] as const) {
      expect(gateServer({ name: "x", server, threadId: "t", budget, apps: undefined })).toEqual(gateServer({ name: "x", server, threadId: "t", budget }));
    }
    expect(mcpStdioServer(docs, { apps: undefined })).toEqual(mcpStdioServer(docs));
  });
});

describe("the ACP family and Muse Code (turn-mcp.ts)", () => {
  it("mounts a command app server behind an observing gate and a URL one behind an observing proxy; the rest as before", () => {
    const servers = Object.fromEntries(turnStdioMcpServers(turn()).map((server) => [server.name, server]));
    expect(servers.board!.args[0]).toContain("mcp-gate");
    expect(env(servers.board, "OMB_GATE_APPS")).toEqual(mount("board"));
    expect(servers.draw!.args[0]).toContain("mcp-remote-proxy");
    expect(env(servers.draw, "OMB_REMOTE_MCP_APPS")).toEqual(mount("draw"));
    const before = Object.fromEntries(turnStdioMcpServers(turn({ integrations: { agents, custom: { board, notes, draw, docs } } })).map((server) => [server.name, server]));
    expect(servers.notes).toEqual(before.notes);
    expect(servers.docs).toEqual(before.docs);
    expect(servers.agents).toEqual(before.agents);
    expect(before.board).toEqual({ name: "board", ...board });
  });

  it("with a selection, gates each server once: the command app server's gate observes, a URL one's gate does not", () => {
    const servers = Object.fromEntries(turnStdioMcpServers(turn({ toolScope: { allow: ["mcp:board:*", "mcp:draw:*", "mcp:agents:*"] } })).map((server) => [server.name, server]));
    expect(Object.keys(servers).sort()).toEqual(["agents", "board", "draw"]);
    expect(env(servers.board, "OMB_GATE_APPS")).toEqual(mount("board"));
    expect(env(servers.board, "OMB_GATE_TOOL_SCOPE")).toBeDefined();
    expect(env(servers.board, "OMB_GATE_UPSTREAM")).toEqual(board);
    expect(servers.draw!.env).not.toHaveProperty("OMB_GATE_APPS");
    expect(env(env(servers.draw, "OMB_GATE_UPSTREAM"), "OMB_REMOTE_MCP_APPS")).toEqual(mount("draw"));
  });
});

describe("Pi", () => {
  it("adds the apps settings to the gate or proxy each server already has", () => {
    const servers = buildMcpServers(turn())!;
    expect(env(servers.board as never, "OMB_GATE_APPS")).toEqual(mount("board"));
    expect(env(servers.draw as never, "OMB_REMOTE_MCP_APPS")).toEqual(mount("draw"));
    expect(env(servers.draw as never, "OMB_REMOTE_MCP_DIRECTORY")).toEqual({ name: "draw" });
    const before = buildMcpServers(turn({ integrations: { agents, custom: { board, notes, draw, docs } } }))!;
    expect(servers.notes).toEqual(before.notes);
    expect(servers.docs).toEqual(before.docs);
    expect(env(before.board as never, "OMB_GATE_APPS")).toBeUndefined();
  });
});

describe("the Chat Completions runtime", () => {
  let harness: Server | undefined;
  let session: ChatToolSession | undefined;
  afterEach(async () => {
    await session?.close().catch(() => {});
    session = undefined;
    if (harness) { harness.closeAllConnections(); await new Promise<void>((resolve) => harness!.close(() => resolve())); }
    harness = undefined;
  });

  const app = (extra: Record<string, string> = {}) => ({ command: process.execPath, args: ["--experimental-strip-types", "--no-warnings", FAKE_APP], env: extra });

  it("never registers an app-only tool, observes a command app server in process, and falls back when it refuses the extension", async () => {
    const reports: McpAppReport[] = [];
    harness = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => { reports.push(JSON.parse(body)); res.writeHead(201).end("{}"); });
    });
    await new Promise<void>((resolve) => harness!.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(harness.address() as AddressInfo).port}`;
    // The agents mount carries the turn's capability; any MCP server stands in for it here.
    const reporting = { ...app(), env: { OMB_HARNESS_URL: url, OMB_COMMS_TOKEN: "comms-fixture" } };
    const controller = new AbortController();
    session = await mountChatTools({ agents: reporting, custom: { board: app(), strict: app({ FAKE_APP_STRICT: "1" }), plain: app() },
      mcpApps: { board: { extension: true }, strict: { extension: true } } }, controller.signal);
    const names = session.definitions.map((definition) => definition.function.name);
    for (const server of ["board", "strict", "plain"]) {
      expect(names.filter((name) => name.startsWith(`${server}_`))).toEqual([`${server}_show_board`, `${server}_paint_board`, `${server}_peek_board`, `${server}_plain_echo`]);
    }
    const result = await session.execute("board_show_board", { cards: 2 }, controller.signal);
    expect(result.text).toContain("Board with 2 cards");
    await session.execute("plain_show_board", {}, controller.signal);
    const deadline = Date.now() + 10_000;
    while (reports.length < 1 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    await new Promise((resolve) => setTimeout(resolve, 200));
    // only the observed server reports, with the whole result
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ tool: "mcp_app", server: "board", serverInfo: { title: "Fake App" }, call: { arguments: { cards: 2 } },
      result: { structuredContent: { cards: 2 } } });
  }, 60_000);
});
