import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { createServer, Server, type IncomingMessage, type ServerResponse } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { LinkOpened, LinkStream, McpOpen } from "../electron/device-link-protocol.mjs";
import { commandFingerprint } from "../electron/lent-mcp.mjs";
import { json, readBody } from "./harness/http.ts";
import { createLentMcp, isLoopbackUrl, LENT_MCP_PATH, lentLine, linkProblem, needsTheirComputer, type HereChecks, type LentMcp, type LentMcpDeps } from "./lent-mcp.ts";
import { StdioSessions } from "./lent-mcp-stdio.ts";
import { PASS } from "./routes/table.ts";
import type { SharedComputers } from "./shared-computers.ts";
import { startFakeHttpMcp } from "./testing/fake-http-mcp-server.ts";

const MAC = { environmentId: "11111111-1111-4111-8111-111111111111", label: "Ada's Mac" };
const TURN = { botId: "kiwi", threadId: "t-1", generation: "g-1" };
const local = { type: "http" as const, url: "http://127.0.0.1:19501/mcp", headers: { Authorization: "Bearer saved-header" }, enabled: true, runsOn: MAC };
const notes = { command: "/Users/ada/bin/notes-mcp", args: [], env: { NOTES_TOKEN: "saved-env" }, enabled: true, runsOn: MAC };
const here = (over: Partial<HereChecks> = {}): HereChecks => ({ exists: () => false, program: () => true, answers: async () => false, ...over });

type Online = NonNullable<ReturnType<SharedComputers["runsOn"]>["online"]>;
function fixture(options: { online?: Partial<Online> | null; known?: { lent: boolean } | null; principal?: string | null; servers?: Record<string, unknown>; mcpServers?: string[]; toolScope?: unknown; answer?: (operation: Record<string, unknown>) => unknown; lenders?: ReturnType<SharedComputers["mcpLenders"]>; here?: HereChecks; links?: LentMcpDeps["links"]; active?: () => boolean } = {}) {
  const requests: Array<{ operation: Record<string, unknown>; principal: string | null }> = [];
  const online = options.online === null ? null : { id: "mac-1", name: "Ada's Mac", platform: "darwin" as const, terminal: false, mcpServers: true, mcpLink: null, ...options.online };
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
    links: options.links ?? { mcpRoute: () => null },
    policy: (servers) => servers,
    bot: (id) => (id === "kiwi" ? { id, ...(options.mcpServers ? { mcpServers: options.mcpServers } : {}), toolScope: options.toolScope } : undefined),
    principal: () => (options.principal === undefined ? "cloud-home" : options.principal),
    notice: () => "Someone else wrote in this conversation, so it can't use your Mac. Start a new conversation to use it.",
    refusal: () => "Someone else wrote in this conversation, so it can't use your Mac. Start a new conversation to use it. Only the person can change this.",
    mint: () => { minted.push("token"); return "turn-bearer"; },
    active: options.active ?? (() => true),
    origin: "http://127.0.0.1:4242",
    personal: true,
    place: "My Cloud",
    here: options.here ?? here(),
  });
  return { lent, requests, minted, computers };
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
    const lent = createLentMcp({ cfg: () => ({ mcpServers: { web: { type: "http", url: "https://mcp.example.com/mcp", headers: {}, enabled: true } } }), computers: { runsOn: vi.fn(), mcpLenders: vi.fn(), request: vi.fn() } as unknown as LentMcpDeps["computers"], links: { mcpRoute: vi.fn() },
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
  });

  it("with no computer lent, refuses a server that needs one and still saves one My Cloud answers", async () => {
    const none = fixture();
    expect(await none.lent.place(address, { principal: "cloud-home" })).toEqual({ ok: false, error: "That address is on the person's own computer, and no computer is lent to My Cloud now. Ask them to lend their Mac or PC, then add it again." });
    const command = { command: "notes-mcp", args: [], env: {}, enabled: true };
    const missing = fixture({ here: here({ program: () => false }) });
    expect(await missing.lent.place(command, { principal: "cloud-home" })).toEqual({ ok: false, error: "This command runs on the person's own computer, and no computer is lent to My Cloud now. Ask them to lend their Mac or PC with its terminal, then add it again." });
    const answered = fixture({ here: here({ answers: async () => true }) });
    expect(await answered.lent.place(address, { principal: "cloud-home" })).toEqual({ ok: true, server: address });
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

it("the words for a server the computer's link can't run now", () => {
  const mac = { computer: "Ada's Mac", device: "Mac" as const };
  const words = { personal: true, place: "My Cloud" };
  expect(lentLine("local", { kind: "not-lending", ...mac }, words)).toBe("local runs on your Mac (Ada's Mac), which isn't lending its MCP servers to My Cloud: turn on \"Let My Cloud use your MCP servers on this Mac\" from the OpenMausBot icon on that Mac.");
  expect(lentLine("local", { kind: "needs-approval", ...mac }, words)).toBe("Allow local on your Mac (Ada's Mac): a prompt is waiting there. Then try again.");
  expect(lentLine("local", { kind: "declined", ...mac }, words)).toBe("On your Mac (Ada's Mac), the person didn't allow local. Ask them before trying again.");
  expect(lentLine("local", { kind: "no-server", ...mac }, words)).toBe("Your Mac (Ada's Mac) has no definition of local to run.");
  expect(lentLine("local", { kind: "no-server", computer: "studio", device: "PC" }, { ...words, personal: false })).toBe("studio has no definition of local to run.");
  expect(lentLine("local", { kind: "changed", ...mac }, words)).toBe("local changed since the person allowed it on your Mac (Ada's Mac): a new prompt is waiting there.");
  expect(lentLine("local", { kind: "unreachable", ...mac }, words)).toBe("local on your Mac (Ada's Mac) didn't answer. Check that it is running there.");
  expect(lentLine("local", { kind: "no-link", ...mac }, words)).toBe("local runs on your Mac (Ada's Mac), whose connection to My Cloud isn't up yet: try again in a moment. If it stays this way, the network there may be blocking it.");
  expect(lentLine("local", { kind: "no-window", ...mac }, words)).toBe("Open OpenMausBot on your Mac (Ada's Mac), then try again: it asks there before My Cloud uses local.");
  expect(lentLine("notes", { kind: "cant-start", ...mac }, words)).toBe("notes couldn't start on your Mac (Ada's Mac): its program may not be installed there, or it stopped as soon as it started.");
  const problems = [null, { refused: "not-lent" }, { refused: "needs-approval" }, { refused: "declined" }, { refused: "no-window" }, { failed: "no-server" }, { failed: "changed" }, { failed: "spawn-failed" },
    { refused: "API_KEY=sk-secret" }, { refused: "toString" }, { refused: "spawn-failed" }, { failed: "no-window" }, { failed: "bad-port" }, { failed: "busy" }, { failed: "timeout" }, { gone: true }] as const;
  expect(problems.map((opened) => linkProblem(opened))).toEqual(["no-link", "not-lending", "needs-approval", "declined", "no-window", "no-server", "changed", "cant-start",
    "unreachable", "unreachable", "unreachable", "unreachable", "unreachable", "unreachable", "unreachable", "unreachable"]);
});

describe("a computer that lends its MCP servers over its link", () => {
  const FAKE_STDIO = fileURLToPath(new URL("./testing/fake-stdio-mcp.mjs", import.meta.url));
  const initialize = rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "engine", version: "1" } });
  const signal = new AbortController().signal;
  const cleanups: Array<() => unknown> = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  type Refusal = Exclude<LinkOpened, LinkStream>;
  const exited = (child: ChildProcess) => (child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : once(child, "exit"));

  /** The computer's end of the link: a URL server's stream is a connection to its port, a command server's a fresh fake
   * stdio child. `before` may hold an open or refuse it. */
  function computer(before: (target: McpOpen) => Promise<Refusal | void> | Refusal | void = () => {}) {
    const opened: McpOpen[] = [];
    const children: ChildProcess[] = [];
    cleanups.push(() => { for (const child of children) child.kill(); });
    const route = {
      async open(target: McpOpen): Promise<LinkOpened> {
        opened.push(target);
        const refused = await before(target);
        if (refused) return refused;
        return {
          join(socket) {
            if ("port" in target) {
              const server = connect(target.port, "127.0.0.1");
              server.on("error", () => socket.destroy());
              server.pipe(socket);
              socket.pipe(server);
              socket.on("close", () => server.destroy());
              return;
            }
            const child = spawn(process.execPath, [FAKE_STDIO], { stdio: ["pipe", "pipe", "ignore"] });
            children.push(child);
            child.stdout.pipe(socket);
            socket.pipe(child.stdin);
            socket.on("close", () => child.kill());
            child.on("exit", () => socket.destroy());
          },
          cancel() {},
        };
      },
    };
    return { opened, children, links: { mcpRoute: vi.fn((_person: string, _computer: string) => route) } };
  }

  /** A turn's engine: the route served on loopback, as the internal route serves it to the turn's bearer. */
  async function engine(lent: LentMcp, turn = { ...TURN }) {
    const server = createServer((req, res) => {
      const path = new URL(req.url ?? "/", "http://cloud.test").pathname;
      void lent.route({ method: req.method ?? "GET", path, req, res, turn, readBody: () => readBody(req), json })
        .then((out) => { if (out === PASS) json(res, 404, {}); }, (error: { status?: number }) => json(res, error.status ?? 500, {}));
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    cleanups.push(() => { lent.close(); server.closeAllConnections(); server.close(); });
    const at = `http://127.0.0.1:${(server.address() as AddressInfo).port}${LENT_MCP_PATH}`;
    const send = (name: string, method: string, body?: unknown, session?: string | null) => fetch(at + name, {
      method,
      headers: { authorization: "Bearer turn-bearer", accept: "application/json, text/event-stream", "content-type": "application/json", ...(session ? { "mcp-session-id": session } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const post = async (name: string, body: unknown, session?: string | null) => {
      const answer = await send(name, "POST", body, session);
      const text = await answer.text();
      return { status: answer.status, session: answer.headers.get("mcp-session-id"), body: text ? JSON.parse(text) : null };
    };
    return { turn, send, post };
  }

  it("a computer that lends mcp is reached over its link: tools/list and tools/call for a URL server go through with its saved headers, no job is queued", async () => {
    const mac = await startFakeHttpMcp({ requireHeader: { name: "authorization", value: "Bearer saved-header" }, tools: [{ name: "read_notes" }] });
    cleanups.push(() => mac.close());
    const link = computer();
    const { lent, requests } = fixture({ online: { mcpLink: true }, servers: { local: { ...local, url: mac.url } }, links: link.links });
    expect(lent.mounts({ id: "kiwi" }, TURN)).toEqual({ local: { type: "http", url: `http://127.0.0.1:4242${LENT_MCP_PATH}local`, headers: { authorization: "Bearer turn-bearer" } } });

    const { post, send } = await engine(lent);
    const started = await post("local", initialize);
    expect(started).toMatchObject({ status: 200, session: "fake-session", body: { result: { serverInfo: { name: "fake-http-mcp" } } } });
    expect((await post("local", rpc("tools/list", {}, 2), started.session)).body.result.tools).toEqual([{ name: "read_notes" }]);
    expect((await post("local", rpc("tools/call", { name: "read_notes", arguments: {} }, 3), started.session)).body.result).toEqual({ content: [{ type: "text", text: "remote execution recorded" }] });

    expect(mac.seenHeaders.map((headers) => headers.authorization)).toEqual(["Bearer saved-header", "Bearer saved-header", "Bearer saved-header"]);
    expect(JSON.stringify(mac.seenHeaders), "the turn's bearer never leaves My Cloud").not.toContain("turn-bearer");
    const port = Number(new URL(mac.url).port);
    expect(link.opened).toEqual([{ name: "local", port }, { name: "local", port }, { name: "local", port }]);
    expect(link.links.mcpRoute).toHaveBeenCalledWith("cloud-home", "mac-1");
    expect((await send("local", "PUT", {})).status).toBe(405);
    expect(link.opened).toHaveLength(3);
    expect(requests).toEqual([]);
  });

  it("a command server gets one stdio session per engine session; the thread's next turn initializing it ends the previous turn's; DELETE ends one; an emptied thread leaves the map", async () => {
    const link = computer();
    const { lent, requests } = fixture({ online: { mcpLink: true }, links: link.links });
    const { turn, post, send } = await engine(lent);
    const first = await post("notes", initialize);
    const second = await post("notes", initialize);
    expect(first).toMatchObject({ status: 200, body: { result: { serverInfo: { name: "fake-stdio" } } } });
    expect(second.session).not.toBe(first.session);
    expect(link.children).toHaveLength(2);
    const fingerprint = commandFingerprint({ command: notes.command, args: [], env: { NOTES_TOKEN: "saved-env" } });
    expect(link.opened).toEqual([{ name: "notes", fingerprint }, { name: "notes", fingerprint }]);
    expect(JSON.stringify(link.opened), "the definition is the computer's to fetch").not.toContain("saved-env");
    expect((await post("notes", rpc("tools/call", { name: "echo", arguments: { text: "hi" } }, 2), first.session)).body.result).toEqual({ content: [{ type: "text", text: "hi" }] });

    turn.generation = "g-2";
    const third = await post("notes", initialize);
    const fourth = await post("notes", initialize);
    await Promise.all(link.children.slice(0, 2).map(exited));
    expect((await post("notes", rpc("tools/list", {}, 3), first.session)).status, "the previous turn's session is gone").toBe(404);
    expect((await post("notes", rpc("tools/list", {}, 4), third.session)).body.result.tools).toHaveLength(1);

    const closes = vi.spyOn(StdioSessions.prototype, "close");
    expect((await send("notes", "DELETE", undefined, third.session)).status).toBe(200);
    await exited(link.children[2]!);
    expect(closes, "one session is left").not.toHaveBeenCalled();
    link.children[3]!.kill();
    await vi.waitFor(() => expect(closes, "the emptied thread's sessions are closed and forgotten").toHaveBeenCalledTimes(1));
    expect((await post("notes", rpc("tools/list", {}, 5), fourth.session)).status).toBe(404);

    expect((await post("notes", initialize)).status, "the thread starts again from nothing").toBe(200);
    lent.close();
    await exited(link.children[4]!);
    expect(requests).toEqual([]);
  });

  it("a command session that opens after the thread's next turn took its server ends at once", async () => {
    let release = () => {};
    const held = new Promise<void>((done) => { release = done; });
    let opens = 0;
    const link = computer(async () => { if (opens++ === 0) await held; });
    const { lent } = fixture({ online: { mcpLink: true }, links: link.links });
    const { turn, post } = await engine(lent);
    const late = post("notes", initialize);
    await vi.waitFor(() => expect(link.opened).toHaveLength(1));
    turn.generation = "g-2";
    const current = await post("notes", initialize);
    release();
    expect((await late).status).toBe(502);
    await vi.waitFor(() => expect(link.children).toHaveLength(2));
    await exited(link.children[1]!);
    expect((await post("notes", rpc("tools/list", {}, 2), current.session)).status).toBe(200);
  });

  it("a thread's command sessions end when its server is on another computer now", async () => {
    const link = computer();
    const { lent, computers } = fixture({ online: { mcpLink: true }, links: link.links });
    const { post } = await engine(lent);
    const first = await post("notes", initialize);
    computers.runsOn("cloud-home", MAC).online!.id = "mac-2";
    expect((await post("notes", rpc("tools/list", {}, 2), first.session)).status).toBe(404);
    await exited(link.children[0]!);
  });

  it("route answers a refused open as the bot reads it", async () => {
    let refusal: Refusal = { refused: "needs-approval" };
    const link = computer(() => refusal);
    const { lent } = fixture({ online: { mcpLink: true }, links: link.links });
    const { post } = await engine(lent);
    const called = await post("local", rpc("tools/call", { name: "search" }), "fake-session");
    expect(called).toMatchObject({ status: 200, body: { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "Allow local on your Mac (Ada's Mac): a prompt is waiting there. Then try again." }], isError: true } } });
    refusal = { refused: "declined" };
    const listed = await post("local", rpc("tools/list", {}, 2));
    expect(listed.body).toEqual({ jsonrpc: "2.0", id: 2, error: { code: -32603, message: "On your Mac (Ada's Mac), the person didn't allow local. Ask them before trying again." } });
    expect(link.opened).toHaveLength(2);
  });

  it("a refused initialize is answered on My Cloud with the line as instructions, and that session is answered here without opening", async () => {
    const line = (name: string) => `Allow ${name} on your Mac (Ada's Mac): a prompt is waiting there. Then try again.`;
    for (const name of ["local", "notes"]) {
      const link = computer(() => ({ refused: "needs-approval" }));
      const { lent } = fixture({ online: { mcpLink: true }, links: link.links });
      const { post, send } = await engine(lent);
      const started = await post(name, initialize);
      expect(started, name).toEqual({ status: 200, session: "refused-needs-approval", body: { jsonrpc: "2.0", id: 1, result: {
        protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: `openmausbot-${name}`, version: "1" }, instructions: line(name) } } });
      expect((await post(name, rpc("tools/list", {}, 2), started.session)).body).toEqual({ jsonrpc: "2.0", id: 2, result: { tools: [] } });
      expect((await post(name, rpc("tools/call", { name: "search" }, 3), started.session)).body.result).toEqual({ content: [{ type: "text", text: line(name) }], isError: true });
      expect((await post(name, rpc("ping", {}, 4), started.session)).body.result).toEqual({});
      expect((await post(name, { jsonrpc: "2.0", method: "notifications/initialized" }, started.session)).status).toBe(202);
      expect((await send(name, "GET", undefined, started.session)).status).toBe(405);
      expect((await send(name, "DELETE", undefined, started.session)).status).toBe(200);
      expect(link.opened, name).toHaveLength(1);
    }
  });

  it("a computer with no window to ask in, a command refused as spawn-failed and one that ends before its first byte are each answered in their own words, and their refused sessions keep them", async () => {
    const quiet: LinkStream = { join: (socket) => socket.end(), cancel() {} };
    const cases: Array<[LinkOpened, string, string]> = [
      [{ refused: "no-window" }, "refused-no-window", "Open OpenMausBot on your Mac (Ada's Mac), then try again: it asks there before My Cloud uses notes."],
      [{ failed: "spawn-failed" }, "refused-cant-start", "notes couldn't start on your Mac (Ada's Mac): its program may not be installed there, or it stopped as soon as it started."],
      [quiet, "refused-cant-start", "notes couldn't start on your Mac (Ada's Mac): its program may not be installed there, or it stopped as soon as it started."],
    ];
    for (const [opened, session, line] of cases) {
      const { lent } = fixture({ online: { mcpLink: true }, links: { mcpRoute: () => ({ open: async () => opened }) } });
      const { post } = await engine(lent);
      const started = await post("notes", initialize);
      expect(started, session).toMatchObject({ status: 200, session, body: { result: { instructions: line } } });
      expect((await post("notes", rpc("tools/call", { name: "search" }, 2), started.session)).body.result).toEqual({ content: [{ type: "text", text: line }], isError: true });
    }
  });

  it("a computer online with no link up yet is answered as no-link, and its refused session keeps that word", async () => {
    const { lent } = fixture({ online: { mcpLink: true } });
    const { post } = await engine(lent);
    const line = "notes runs on your Mac (Ada's Mac), whose connection to My Cloud isn't up yet: try again in a moment. If it stays this way, the network there may be blocking it.";
    expect((await post("notes", rpc("tools/call", { name: "search" }))).body.result).toEqual({ content: [{ type: "text", text: line }], isError: true });
    const started = await post("notes", initialize);
    expect(started).toMatchObject({ session: "refused-no-link", body: { result: { instructions: line } } });
    expect((await post("notes", rpc("tools/call", { name: "search" }, 2), started.session)).body.result.content[0].text).toBe(line);
  });

  it("a turn that ends while its open is pending gets 401 and the stream is cancelled before anything reaches the server", async () => {
    const mac = await startFakeHttpMcp({ tools: [{ name: "read_notes" }] });
    cleanups.push(() => mac.close());
    let active = true;
    const cancelled: string[] = [];
    const link = computer(() => { active = false; });
    const route = link.links.mcpRoute("cloud-home", "mac-1");
    link.links.mcpRoute.mockClear();
    link.links.mcpRoute.mockImplementation(() => ({ open: async (target: McpOpen) => {
      const opened = await route.open(target);
      return "join" in opened ? { join: opened.join, cancel: () => cancelled.push(target.name) } : opened;
    } }));
    const { lent } = fixture({ online: { mcpLink: true }, servers: { local: { ...local, url: mac.url }, notes }, links: link.links, active: () => active });
    const { send } = await engine(lent);
    expect((await send("local", "POST", rpc("tools/list"))).status).toBe(401);
    active = true;
    expect((await send("notes", "POST", initialize)).status).toBe(401);
    expect(cancelled).toEqual(["local", "notes"]);
    expect(mac.seenPaths).toEqual([]);
    expect(link.children).toEqual([]);
  });

  it("each open of a command server carries the fingerprint of its definition as saved now", async () => {
    const link = computer();
    const servers: Record<string, unknown> = { notes };
    const { lent } = fixture({ online: { mcpLink: true }, servers, links: link.links });
    const { post } = await engine(lent);
    expect((await post("notes", initialize)).status).toBe(200);
    servers.notes = { ...notes, args: ["--vault", "work"] };
    expect((await post("notes", initialize)).status).toBe(200);
    expect(link.opened).toEqual([
      { name: "notes", fingerprint: commandFingerprint({ command: notes.command, args: [], env: notes.env }) },
      { name: "notes", fingerprint: commandFingerprint({ command: notes.command, args: ["--vault", "work"], env: notes.env }) },
    ]);
  });

  it("a refused answer keeps the body's shape: a one-element batch gets a one-element array, a body with no JSON-RPC message 400", async () => {
    const { lent } = fixture({ online: { mcpLink: true }, links: computer(() => ({ refused: "declined" })).links });
    const { post } = await engine(lent);
    const line = "On your Mac (Ada's Mac), the person didn't allow local. Ask them before trying again.";
    expect((await post("local", [rpc("tools/list")], "fake-session")).body).toEqual([{ jsonrpc: "2.0", id: 1, error: { code: -32603, message: line } }]);
    expect((await post("local", { hello: "there" }, "fake-session")).status).toBe(400);
    expect((await post("notes", [initialize])).body).toMatchObject([{ id: 1, result: { instructions: "On your Mac (Ada's Mac), the person didn't allow notes. Ask them before trying again." } }]);
    expect((await post("notes", { hello: "there" }, "refused-declined")).status).toBe(400);
    expect((await post("notes", { jsonrpc: "2.0", method: "notifications/initialized" }, "refused-declined")).status).toBe(202);
  });

  it("a computer with the switch off is not-lending: mounts leaves it out, lines says so, nothing is opened", async () => {
    const link = computer();
    const { lent, requests } = fixture({ online: { mcpLink: false, terminal: true }, links: link.links });
    const line = (name: string) => `${name} runs on your Mac (Ada's Mac), which isn't lending its MCP servers to My Cloud: turn on "Let My Cloud use your MCP servers on this Mac" from the OpenMausBot icon on that Mac.`;
    expect(lent.mounts({ id: "kiwi" }, TURN)).toEqual({});
    expect(Object.fromEntries(lent.lines({ id: "kiwi" }, TURN))).toEqual({ local: line("local"), notes: line("notes") });
    const called = await route(lent, `${LENT_MCP_PATH}notes`, rpc("tools/call", { name: "search" }));
    expect(called.json.mock.calls[0]![2].result).toEqual({ content: [{ type: "text", text: line("notes") }], isError: true });
    expect(await lent.test("local", local, "cloud-home", signal)).toEqual({ status: 409, error: line("local") });
    expect(link.links.mcpRoute).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
  });

  it("the port rule holds on the link path too, and no-terminal only on the job path", () => {
    const servers = { local, web: { ...local, url: "http://127.0.0.1/mcp" }, notes };
    const port = "web runs on your Mac (Ada's Mac), which reaches only an MCP server on its own port, 1024 or higher, at that Mac's address: save web with the port its server listens on.";
    const linked = fixture({ online: { mcpLink: true, terminal: false }, servers, links: computer().links }).lent;
    expect(Object.keys(linked.mounts({ id: "kiwi" }, TURN))).toEqual(["local", "notes"]);
    expect(Object.fromEntries(linked.lines({ id: "kiwi" }, TURN))).toEqual({ web: port });
    const jobs = fixture({ online: { terminal: false }, servers }).lent;
    expect(Object.keys(jobs.mounts({ id: "kiwi" }, TURN))).toEqual(["local"]);
    expect(Object.fromEntries(jobs.lines({ id: "kiwi" }, TURN))).toEqual({ web: port, notes: expect.stringContaining("doesn't let My Cloud run programs") });
  });

  it("a URL server on the old SSE transport mounts with type sse on the link path; a job-path computer still mounts it as http", () => {
    const servers = { old: { ...local, type: "sse" as const, url: "http://127.0.0.1:19501/sse" } };
    expect(fixture({ online: { mcpLink: true }, servers, links: computer().links }).lent.mounts({ id: "kiwi" }, TURN)).toMatchObject({ old: { type: "sse" } });
    expect(fixture({ servers }).lent.mounts({ id: "kiwi" }, TURN)).toMatchObject({ old: { type: "http" } });
  });

  it("a request after the turn ended is refused without opening", async () => {
    const link = computer();
    const { lent } = fixture({ online: { mcpLink: true }, links: link.links, active: () => false });
    const { send } = await engine(lent);
    expect((await send("local", "POST", initialize)).status).toBe(401);
    expect((await send("notes", "POST", initialize)).status).toBe(401);
    expect(link.opened).toEqual([]);
  });

  it("test on the stream path probes the server through an ephemeral loopback door that answers 404 without its token, and reports the open's problem", async () => {
    const mac = await startFakeHttpMcp({ transport: "sse", requireHeader: { name: "authorization", value: "Bearer saved-header" }, tools: [{ name: "read_notes", description: "Read saved notes" }] });
    cleanups.push(() => mac.close());
    const old = { ...local, type: "sse" as const, url: mac.url };
    const listening = vi.spyOn(Server.prototype, "listen");
    const doors: number[] = [];
    const link = computer(async () => {
      for (const door of (listening.mock.contexts as Server[]).filter((server) => server.listening)) {
        const { port } = door.address() as AddressInfo;
        doors.push((await fetch(`http://127.0.0.1:${port}/`)).status, (await fetch(`http://127.0.0.1:${port}/${"0".repeat(64)}/`)).status);
      }
    });
    const { lent, requests } = fixture({ online: { mcpLink: true }, servers: { old, notes }, links: link.links });
    expect(await lent.test("old", old, "cloud-home", signal)).toEqual({ status: 200, body: { ok: true, tools: [{ name: "read_notes", description: "Read saved notes" }] } });
    expect(mac.seenPaths).toEqual(expect.arrayContaining(["/sse", expect.stringMatching(/^\/messages/)]));
    expect(mac.seenHeaders.every((headers) => headers.authorization === "Bearer saved-header")).toBe(true);
    expect(await lent.test("notes", notes, "cloud-home", signal)).toEqual({ status: 200, body: { ok: true, tools: [{ name: "echo", description: "Says the text back" }] } });
    await exited(link.children[0]!);
    expect(doors.length).toBeGreaterThan(2);
    expect(doors.every((status) => status === 404)).toBe(true);
    expect(requests).toEqual([]);
    listening.mockRestore();

    const declined = fixture({ online: { mcpLink: true }, links: computer(() => ({ refused: "declined" })).links }).lent;
    expect(await declined.test("local", local, "cloud-home", signal)).toEqual({ status: 200, body: { ok: false, reason: "unreachable", error: "On your Mac (Ada's Mac), the person didn't allow local. Ask them before trying again." } });
    const waiting = fixture({ online: { mcpLink: true }, links: computer(() => ({ refused: "needs-approval" })).links }).lent;
    expect(await waiting.test("notes", notes, "cloud-home", signal)).toEqual({ status: 200, body: { ok: false, reason: "unreachable", error: "Allow notes on your Mac (Ada's Mac): a prompt is waiting there. Then try again." } });
    const linkless = fixture({ online: { mcpLink: true } }).lent;
    expect(await linkless.test("notes", notes, "cloud-home", signal)).toEqual({ status: 200, body: { ok: false, reason: "unreachable", error: "notes runs on your Mac (Ada's Mac), whose connection to My Cloud isn't up yet: try again in a moment. If it stays this way, the network there may be blocking it." } });
  });

  it("definition serves a command server's definition for its own computer and nothing for a URL server or another computer", () => {
    const { lent } = fixture({ online: { mcpLink: true }, servers: { local, notes, off: { ...notes, enabled: false } } });
    expect(lent.definition("cloud-home", "mac-1", "notes")).toEqual({ name: "notes", command: "/Users/ada/bin/notes-mcp", args: [], env: { NOTES_TOKEN: "saved-env" } });
    for (const [principal, computerId, name] of [["cloud-home", "mac-1", "local"], ["cloud-home", "pc-2", "notes"], ["someone-else", "mac-1", "notes"], ["cloud-home", "mac-1", "off"], ["cloud-home", "mac-1", "missing"], ["cloud-home", "mac-1", "__proto__"]]) {
      expect(lent.definition(principal!, computerId!, name!), `${principal} ${computerId} ${name}`).toBeNull();
    }
  });

  it("an older computer (mcpLink null) still takes the job path", async () => {
    const link = computer();
    const { lent, requests } = fixture({ online: { terminal: true }, links: link.links });
    expect(lent.mounts({ id: "kiwi" }, TURN)).toMatchObject({ local: { type: "http" }, notes: { type: "http" } });
    const called = await route(lent, `${LENT_MCP_PATH}notes`, rpc("tools/call", { name: "search" }));
    expect(called.json.mock.calls[0]![2].result).toEqual({ content: [{ type: "text", text: "found it" }] });
    expect(requests.map((request) => request.operation.action)).toContain("mcp_call");
    expect(link.links.mcpRoute).not.toHaveBeenCalled();

    const switching = fixture({ online: { terminal: true }, links: link.links });
    const json = vi.fn();
    const readBody = async () => { switching.computers.runsOn("cloud-home", MAC).online!.mcpLink = true; return rpc("tools/call", { name: "search" }); };
    await switching.lent.route({ method: "POST", path: `${LENT_MCP_PATH}notes`, req: {} as IncomingMessage, res: {} as ServerResponse, turn: TURN, readBody, json });
    expect(json.mock.calls[0]![2].result.isError, "a computer that starts lending over its link while a call arrives gets no job").toBe(true);
    expect(switching.requests).toEqual([]);
  });
});
