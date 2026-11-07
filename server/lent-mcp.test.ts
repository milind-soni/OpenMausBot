import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";

import { createLentMcp, isLoopbackUrl, LENT_MCP_PATH, lentLine, needsTheirComputer, type HereChecks, type LentMcpDeps } from "./lent-mcp.ts";
import { PASS } from "./routes/table.ts";
import type { SharedComputers } from "./shared-computers.ts";

const MAC = { environmentId: "11111111-1111-4111-8111-111111111111", label: "Ada's Mac" };
const TURN = { botId: "kiwi", threadId: "t-1", generation: "g-1" };
const local = { type: "http" as const, url: "http://127.0.0.1:19501/mcp", headers: { Authorization: "Bearer saved-header" }, enabled: true, runsOn: MAC };
const notes = { command: "/Users/ada/bin/notes-mcp", args: [], env: { NOTES_TOKEN: "saved-env" }, enabled: true, runsOn: MAC };
const here = (over: Partial<HereChecks> = {}): HereChecks => ({ exists: () => false, program: () => true, answers: async () => false, ...over });

type Online = NonNullable<ReturnType<SharedComputers["runsOn"]>["online"]>;
function fixture(options: { online?: Partial<Online> | null; known?: { lent: boolean } | null; principal?: string | null; servers?: Record<string, unknown>; mcpServers?: string[]; toolScope?: unknown; answer?: (operation: Record<string, unknown>) => unknown; lenders?: ReturnType<SharedComputers["mcpLenders"]>; here?: HereChecks } = {}) {
  const requests: Array<{ operation: Record<string, unknown>; principal: string | null }> = [];
  const online = options.online === null ? null : { id: "mac-1", name: "Ada's Mac", platform: "darwin" as const, terminal: false, mcpServers: true, ...options.online };
  const computers: LentMcpDeps["computers"] = {
    runsOn: (principal) => (principal === "cloud-home" ? { online, known: options.known === null ? null : { name: "Ada's Mac", platform: "darwin", lent: options.known?.lent ?? true } } : { online: null, known: null }),
    mcpLenders: (principal) => (principal === "cloud-home" ? options.lenders ?? [] : []),
    request: async (operation, principal) => {
      requests.push({ operation: operation as Record<string, unknown>, principal });
      const answer = options.answer?.(operation as Record<string, unknown>);
      if (answer instanceof Error) throw answer;
      return answer ?? (operation.action === "mcp_tools" ? { tools: [{ name: "search", description: "Find notes", inputSchema: { type: "object" } }] } : { content: [{ type: "text", text: "found it" }] });
    },
  };
  const minted: string[] = [];
  const lent = createLentMcp({
    cfg: () => ({ mcpServers: options.servers ?? { local, notes } }),
    computers,
    policy: (servers) => servers,
    bot: (id) => (id === "kiwi" ? { id, ...(options.mcpServers ? { mcpServers: options.mcpServers } : {}), toolScope: options.toolScope } : undefined),
    principal: () => (options.principal === undefined ? "cloud-home" : options.principal),
    notice: () => "Someone else wrote in this conversation, so it can't use your Mac. Start a new conversation to use it.",
    refusal: () => "Someone else wrote in this conversation, so it can't use your Mac. Start a new conversation to use it. Only the person can change this.",
    mint: () => { minted.push("token"); return "turn-bearer"; },
    active: () => true,
    origin: "http://127.0.0.1:4242",
    personal: true,
    place: "My Cloud",
    here: options.here ?? here(),
  });
  return { lent, requests, minted };
}

const rpc = (method: string, params: unknown = {}, id = 1) => ({ jsonrpc: "2.0", id, method, params });

async function route(lent: ReturnType<typeof createLentMcp>, path: string, body: unknown, method = "POST") {
  const json = vi.fn();
  const res = Object.assign(new EventEmitter(), { writeHead: vi.fn(function (this: unknown) { return this; }), end: vi.fn() }) as unknown as ServerResponse & { writeHead: ReturnType<typeof vi.fn> };
  const out = await lent.route({ method, path, req: {} as IncomingMessage, res, turn: TURN, readBody: async () => body, json });
  return { out, json, res };
}

describe("which new servers need the person's own computer", () => {
  it("a loopback address nothing here answers, never one this server answers or an address on the internet", async () => {
    for (const url of ["http://127.0.0.1:19501/mcp", "http://localhost:3000/mcp", "http://[::1]:8080/mcp", "https://127.0.0.2/mcp"]) expect(isLoopbackUrl(url), url).toBe(true);
    for (const url of ["https://mcp.linear.app/mcp", "http://192.168.1.4/mcp", "http://127.0.0.1.example.com/mcp", "ftp://127.0.0.1/x", "not a url"]) expect(isLoopbackUrl(url), url).toBe(false);
    const server = { type: "http" as const, url: "http://127.0.0.1:19501/mcp", headers: {}, enabled: true };
    expect(await needsTheirComputer(server, here())).toBe(true);
    expect(await needsTheirComputer(server, here({ answers: async () => true })), "a service on this server is this server's").toBe(false);
    expect(await needsTheirComputer({ ...server, url: "https://mcp.linear.app/mcp" }, here())).toBe(false);
  });

  it("a command that is a path here lacks, a program here lacks, or one that reads a path in their home folder", async () => {
    const stdio = (command: string, args: string[] = [], env: Record<string, string> = {}) => ({ command, args, env, enabled: true });
    expect(await needsTheirComputer(stdio("/Users/ada/bin/notes-mcp"), here())).toBe(true);
    expect(await needsTheirComputer(stdio("/usr/bin/node", ["server.js"]), here({ exists: (path) => path === "/usr/bin/node" }))).toBe(false);
    expect(await needsTheirComputer(stdio("obsidian-mcp"), here({ program: () => false }))).toBe(true);
    expect(await needsTheirComputer(stdio("npx", ["-y", "notes-mcp"]), here())).toBe(false);
    expect(await needsTheirComputer(stdio("node", ["/Users/ada/notes/server.js"]), here())).toBe(true);
    expect(await needsTheirComputer(stdio("npx", ["-y", "fs-mcp", "--root=C:\\Users\\Ada\\Notes"]), here())).toBe(true);
    expect(await needsTheirComputer(stdio("npx", ["-y", "fs-mcp"], { NOTES_DIR: "/home/ada/notes" }), here())).toBe(true);
    expect(await needsTheirComputer(stdio("node", ["/data/server.js"]), here()), "a path outside a home folder may be this server's own").toBe(false);
  });
});

describe("a server that runs on the person's computer, in a turn", () => {
  it("mounts each one the turn's lent computer can run as a server at this server's address, with no saved key in it", () => {
    const { lent, minted } = fixture({ online: { terminal: true } });
    const mounted = lent.mounts({ id: "kiwi" }, TURN);
    expect(mounted).toEqual({
      local: { type: "http", url: `http://127.0.0.1:4242${LENT_MCP_PATH}local`, headers: { authorization: "Bearer turn-bearer" } },
      notes: { type: "http", url: `http://127.0.0.1:4242${LENT_MCP_PATH}notes`, headers: { authorization: "Bearer turn-bearer" } },
    });
    expect(JSON.stringify(mounted)).not.toMatch(/saved-header|saved-env|notes-mcp/);
    expect(minted).toHaveLength(1);
  });

  it("leaves out what can't be reached now and says why in plain words: offline, no longer lent, never lent, too old, no terminal", () => {
    const say = (options: Parameters<typeof fixture>[0]) => {
      const { lent } = fixture(options);
      return [Object.keys(lent.mounts({ id: "kiwi" }, TURN)), Object.fromEntries(lent.lines({ id: "kiwi" }, TURN))];
    };
    expect(say({ online: null })).toEqual([[], {
      local: "local runs on your Mac (Ada's Mac), which is offline right now: OpenMausBot on it is closed, or the Mac is asleep or off.",
      notes: "notes runs on your Mac (Ada's Mac), which is offline right now: OpenMausBot on it is closed, or the Mac is asleep or off.",
    }]);
    expect(say({ online: null, known: { lent: false } })[1]).toMatchObject({ local: "local runs on your Mac (Ada's Mac), which no longer lends itself to My Cloud: OpenMausBot on it is paused or signed out." });
    expect(say({ online: null, known: null })[1]).toMatchObject({ local: "local runs on Ada's Mac, which isn't lent to My Cloud: it works once OpenMausBot is open on that computer and signed in to My Cloud." });
    expect(say({ online: { mcpServers: false } })[1]).toMatchObject({ local: "local runs on your Mac (Ada's Mac), whose OpenMausBot is too old to run it for My Cloud: update OpenMausBot on that Mac." });
    expect(say({})).toEqual([["local"], { notes: "notes starts a program on your Mac (Ada's Mac), which doesn't let My Cloud run programs right now: turn on \"Let Clouds run commands on this Mac\" from the OpenMausBot icon on that Mac." }]);
  });

  it("an address with no port of its own, 1024 or higher, is refused here in plain words before any job goes out", async () => {
    const line = (name: string) => `${name} runs on your Mac (Ada's Mac), which reaches only an MCP server on its own port, 1024 or higher, at that Mac's address: save ${name} with the port its server listens on.`;
    const servers = { local, web: { ...local, url: "http://127.0.0.1/mcp" }, tls: { ...local, url: "https://localhost/mcp" }, low: { ...local, url: "http://[::1]:1023/mcp" } };
    const { lent, requests } = fixture({ servers });
    expect(Object.keys(lent.mounts({ id: "kiwi" }, TURN))).toEqual(["local"]);
    expect(Object.fromEntries(lent.lines({ id: "kiwi" }, TURN))).toEqual({ web: line("web"), tls: line("tls"), low: line("low") });
    const called = await route(lent, `${LENT_MCP_PATH}web`, rpc("tools/call", { name: "search" }));
    expect(called.json.mock.calls[0]![2].result).toEqual({ content: [{ type: "text", text: line("web") }], isError: true });
    expect(await lent.test("low", servers.low, "cloud-home", new AbortController().signal)).toEqual({ status: 409, error: line("low") });
    expect(requests.map((request) => (request.operation.server as { url: string }).url)).toEqual(["http://127.0.0.1:19501/mcp"]);
  });

  it("a bot with no server on another computer costs its turn nothing: the lending gate isn't asked", () => {
    const asked = vi.fn(() => "cloud-home");
    const lent = createLentMcp({ cfg: () => ({ mcpServers: { web: { type: "http", url: "https://mcp.example.com/mcp", headers: {}, enabled: true } } }), computers: { runsOn: vi.fn(), mcpLenders: vi.fn(), request: vi.fn() } as unknown as LentMcpDeps["computers"],
      policy: (servers) => servers, bot: () => ({ id: "kiwi" }), principal: asked, notice: vi.fn(), refusal: vi.fn(), mint: vi.fn(), active: () => true, origin: "http://127.0.0.1:1", personal: true, place: "My Cloud" });
    expect(lent.mounts({ id: "kiwi" }, TURN)).toEqual({});
    expect(lent.lines({ id: "kiwi" }, TURN)).toEqual(new Map());
    expect(asked).not.toHaveBeenCalled();
  });

  it("mounts nothing for a turn that can't use the lent computer, and says why", () => {
    const { lent, minted } = fixture({ principal: null });
    expect(lent.mounts({ id: "kiwi" }, TURN)).toEqual({});
    expect(minted).toEqual([]);
    expect(lent.lines({ id: "kiwi" }, TURN).get("local")).toBe("local runs on Ada's Mac. Someone else wrote in this conversation, so it can't use your Mac. Start a new conversation to use it.");
  });

  it("only the bot's own servers: off, another bot's, left out of its list or its tool selection are never mounted", () => {
    const servers = { local, off: { ...local, enabled: false }, theirs: { ...notes, bot: "other" }, here: { ...local, runsOn: undefined }, unlisted: local, unselected: local };
    const bot = { id: "kiwi", mcpServers: ["local", "off", "theirs", "here", "unselected"], toolScope: { deny: ["mcp:unselected:*"] } };
    const { lent } = fixture({ servers, online: { terminal: true } });
    expect(Object.keys(lent.mounts(bot, TURN))).toEqual(["local"]);
  });
});

describe("the MCP endpoint a turn's engine reaches", () => {
  it("answers initialize and ping itself, and lists and calls tools on the lent computer with the server as saved", async () => {
    const { lent, requests } = fixture();
    expect((await route(lent, `${LENT_MCP_PATH}local`, rpc("initialize", { protocolVersion: "2025-06-18" }))).json).toHaveBeenCalledWith(expect.anything(), 200, { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "openmausbot-local", version: "1" } } });
    expect(requests).toEqual([]);
    const notification = await route(lent, `${LENT_MCP_PATH}local`, { jsonrpc: "2.0", method: "notifications/initialized" });
    expect(notification.res.writeHead).toHaveBeenCalledWith(202);
    const listed = await route(lent, `${LENT_MCP_PATH}local`, rpc("tools/list"));
    expect(listed.json).toHaveBeenCalledWith(expect.anything(), 200, { jsonrpc: "2.0", id: 1, result: { tools: [{ name: "search", description: "Find notes", inputSchema: { type: "object" } }] } });
    const called = await route(lent, `${LENT_MCP_PATH}local`, rpc("tools/call", { name: "search", arguments: { q: "plan" } }, 2));
    expect(called.json).toHaveBeenCalledWith(expect.anything(), 200, { jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "found it" }] } });
    expect(requests).toEqual([
      { principal: "cloud-home", operation: { computer_id: "mac-1", action: "mcp_tools", server: { name: "local", url: "http://127.0.0.1:19501/mcp", type: "http", headers: { Authorization: "Bearer saved-header" } } } },
      { principal: "cloud-home", operation: { computer_id: "mac-1", action: "mcp_call", server: { name: "local", url: "http://127.0.0.1:19501/mcp", type: "http", headers: { Authorization: "Bearer saved-header" } }, tool_name: "search", arguments: { q: "plan" } } },
    ]);
    expect((await route(lent, `${LENT_MCP_PATH}local`, rpc("tools/list"))).json, "listed again within ten minutes: kept").toHaveBeenCalled();
    expect(requests.filter((request) => request.operation.action === "mcp_tools")).toHaveLength(1);
  });

  it("refuses a server that isn't this bot's now, a turn that can't use the computer, and an offline computer, with no job sent", async () => {
    const quiet = fixture();
    const unknown = await route(quiet.lent, `${LENT_MCP_PATH}evil`, rpc("tools/call", { name: "x" }));
    expect(unknown.json.mock.calls[0]![2]).toEqual({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "evil isn't one of your MCP servers on another computer now." }], isError: true } });
    for (const name of ["__proto__", "constructor", "local/../notes"]) {
      expect((await route(quiet.lent, `${LENT_MCP_PATH}${name}`, rpc("tools/list"))).json.mock.calls[0]![2].error.message).toContain("isn't one of your MCP servers");
    }
    const refused = fixture({ principal: null });
    const call = await route(refused.lent, `${LENT_MCP_PATH}local`, rpc("tools/call", { name: "search" }));
    expect(call.json.mock.calls[0]![2].result.content[0].text).toContain("Only the person can change this.");
    const list = await route(refused.lent, `${LENT_MCP_PATH}local`, rpc("tools/list"));
    expect(list.json.mock.calls[0]![2].error.message, "listing raises no card").not.toContain("Only the person");
    const away = fixture({ online: null });
    const offline = await route(away.lent, `${LENT_MCP_PATH}local`, rpc("tools/call", { name: "search" }));
    expect(offline.json.mock.calls[0]![2].result).toEqual({ content: [{ type: "text", text: "local runs on your Mac (Ada's Mac), which is offline right now: OpenMausBot on it is closed, or the Mac is asleep or off." }], isError: true });
    expect([...quiet.requests, ...refused.requests, ...away.requests]).toEqual([]);
  });

  it("passes on the computer's refusal and a failed listing, takes POST only and leaves other paths alone", async () => {
    const { lent } = fixture({ answer: (operation) => (operation.action === "mcp_tools" ? { content: [{ type: "text", text: "local is not answering at 127.0.0.1:19501 on this computer" }], isError: true } : new Error("Ada's Mac is busy")) });
    const listed = await route(lent, `${LENT_MCP_PATH}local`, rpc("tools/list"));
    expect(listed.json.mock.calls[0]![2]).toEqual({ jsonrpc: "2.0", id: 1, error: { code: -32603, message: "local is not answering at 127.0.0.1:19501 on this computer" } });
    const called = await route(lent, `${LENT_MCP_PATH}local`, rpc("tools/call", { name: "search" }));
    expect(called.json.mock.calls[0]![2].result).toEqual({ content: [{ type: "text", text: "Ada's Mac is busy" }], isError: true });
    expect((await route(lent, `${LENT_MCP_PATH}local`, null, "GET")).res.writeHead).toHaveBeenCalledWith(405, { allow: "POST" });
    expect((await route(lent, "/api/internal/shared-computers", {})).out).toBe(PASS);
    expect((await route(lent, `${LENT_MCP_PATH}local`, rpc("resources/list"))).json.mock.calls[0]![2].error.code).toBe(-32601);
  });
});

describe("Test, and adding a server that needs the person's computer", () => {
  it("Test lists the tools on the computer it runs on, or says plainly why it can't, never 'could not reach'", async () => {
    const signal = new AbortController().signal;
    expect(await fixture().lent.test("local", local, "cloud-home", signal)).toEqual({ status: 200, body: { ok: true, tools: [{ name: "search", description: "Find notes" }] } });
    const offline = await fixture({ online: null }).lent.test("local", local, "cloud-home", signal);
    expect(offline).toEqual({ status: 409, error: "local runs on your Mac (Ada's Mac), which is offline right now: OpenMausBot on it is closed, or the Mac is asleep or off." });
    expect(await fixture().lent.test("notes", notes, "cloud-home", signal)).toMatchObject({ status: 409, error: expect.stringContaining("doesn't let My Cloud run programs") });
    expect(await fixture().lent.test("local", local, null, signal)).toEqual({ status: 409, error: "local runs on Ada's Mac, so it is checked there the next time one of your conversations uses it." });
    const failing = fixture({ answer: () => ({ content: [{ type: "text", text: "local is not answering at 127.0.0.1:19501 on this computer" }], isError: true }) });
    expect(await failing.lent.test("local", local, "cloud-home", signal)).toEqual({ status: 200, body: { ok: false, reason: "unreachable", error: "local is not answering at 127.0.0.1:19501 on this computer" } });
  });

  const lender = (name: string, session: string, environmentId: string, seen: number) => ({ id: `${name}-id`, name, platform: "darwin" as const, session, environmentId, seen });
  const address = { type: "http" as const, url: "http://127.0.0.1:19501/mcp", headers: {}, enabled: true };

  it("marks a new loopback or local server as running on the one lent computer, and nothing else", async () => {
    const one = fixture({ lenders: [lender("Ada's Mac", "s-mac", MAC.environmentId, 2)] });
    expect(await one.lent.place(address, { principal: "cloud-home" })).toEqual({ ok: true, server: { ...address, runsOn: MAC } });
    const internet = { ...address, url: "https://mcp.linear.app/mcp" };
    expect(await one.lent.place(internet, { principal: "cloud-home" })).toEqual({ ok: true, server: internet });
    expect(await one.lent.place(address, { principal: null }), "a team Cloud, or a turn that can't use the computer").toEqual({ ok: true, server: address });
    const kept = { ...address, runsOn: { environmentId: "22222222-2222-4222-8222-222222222222", label: "Studio" } };
    expect(await one.lent.place(kept, { principal: "cloud-home" })).toEqual({ ok: true, server: kept });
    expect(await fixture().lent.place(address, { principal: "cloud-home" }), "nothing lent now: it stays as added").toEqual({ ok: true, server: address });
  });

  it("refuses a loopback address for the lent computer on a port below 1024 or with none, saying how to add it", async () => {
    const one = fixture({ lenders: [lender("Ada's Mac", "s-mac", MAC.environmentId, 2)] });
    for (const url of ["http://127.0.0.1/mcp", "http://localhost:80/mcp", "https://[::1]/mcp", "http://127.0.0.1:1023/mcp"]) {
      expect(await one.lent.place({ ...address, url }, { principal: "cloud-home" }), url).toEqual({ ok: false, error: "This server runs on the person's own computer, which reaches only an MCP server on its own port, 1024 or higher: add it again with the port its server listens on in its address." });
    }
    expect(await one.lent.place({ ...address, url: "http://localhost:19501/mcp" }, { principal: "cloud-home" })).toMatchObject({ ok: true, server: { runsOn: MAC } });
  });

  it("with several lent: the one named, else the one the adder is on, else the newest for the person, else the bot asks", async () => {
    const studio = "33333333-3333-4333-8333-333333333333";
    const { lent } = fixture({ lenders: [lender("Studio", "s-studio", studio, 3), lender("Ada's Mac", "s-mac", MAC.environmentId, 2)] });
    expect(await lent.place(address, { principal: "cloud-home", computer: "ada's mac" })).toMatchObject({ server: { runsOn: MAC } });
    expect(await lent.place(address, { principal: "cloud-home", computer: "Laptop" })).toEqual({ ok: false, error: "No computer called Laptop is lent to My Cloud now. These are: Studio, Ada's Mac." });
    expect(await lent.place(address, { principal: "cloud-home", session: "s-mac" })).toMatchObject({ server: { runsOn: MAC } });
    expect(await lent.place(address, { principal: "cloud-home", session: "s-phone", newest: true })).toMatchObject({ server: { runsOn: { environmentId: studio, label: "Studio" } } });
    expect(await lent.place(address, { principal: "cloud-home" })).toEqual({ ok: false, error: "This server runs on the person's own computer, and several are lent to My Cloud: Studio, Ada's Mac. Ask the person which one in one short question, then add it again with computer set to its name." });
  });
});

it("the words for each case", () => {
  const words = { personal: false, place: "this server" };
  expect(lentLine("notes", { kind: "offline", computer: "MILIND-PC", device: "PC" }, words)).toBe("notes runs on MILIND-PC, which is offline right now: OpenMausBot on it is closed, or the PC is asleep or off.");
  expect(lentLine("notes", { kind: "offline", computer: "MILIND-PC", device: "PC" }, { ...words, personal: true })).toBe("notes runs on your PC (MILIND-PC), which is offline right now: OpenMausBot on it is closed, or the PC is asleep or off.");
});
