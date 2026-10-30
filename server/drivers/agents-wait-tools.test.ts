import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ToolCallContext } from "./agents-call.ts";
import { availableTools, catalogProfileFromEnv } from "./agents-catalog.ts";
import type { Json } from "./agents-client.ts";
import { agentsMcp } from "./agents-mcp.ts";
import { callWaitTool, WAIT_TOOL_DEFINITIONS, WAIT_TOOL_NAMES } from "./agents-wait-tools.ts";
import { WAIT_KINDS } from "../../shared/waits.ts";

type Reply = { ok: boolean; status: number; body: Record<string, unknown> };

function setup(reply: Reply = { ok: true, status: 200, body: { text: "ok" } }) {
  const calls: Array<[string, RequestInit | undefined]> = [];
  const client = { apiResponse: async (path: string, init?: RequestInit) => { calls.push([path, init]); return reply; } };
  return { calls, context: { botId: "scout", threadId: "t1", client } as unknown as ToolCallContext };
}

describe("wait tools", () => {
  it("sends wait_until's arguments unchanged to the waits route and returns its words", async () => {
    const { calls, context } = setup({ ok: true, status: 201, body: { text: "Waiting for the build (wait id w1)…" } });
    expect(await callWaitTool("wait_until", { label: "the build", kind: "file_exists", path: "/r" }, context)).toEqual({ text: "Waiting for the build (wait id w1)…" });
    expect(calls).toEqual([["/api/internal/waits", { method: "POST", body: JSON.stringify({ label: "the build", kind: "file_exists", path: "/r" }) }]]);
  });

  it("marks a refusal as an error in the route's words", async () => {
    const { context } = setup({ ok: false, status: 403, body: { error: "Only the person can set up or stop a wait…" } });
    expect(await callWaitTool("wait_until", {}, context)).toEqual({ text: "Only the person can set up or stop a wait…", isError: true });
  });

  it("lists with a GET and cancels by id", async () => {
    const { calls, context } = setup();
    await callWaitTool("list_waits", {}, context);
    await callWaitTool("cancel_wait", { id: "w1" }, context);
    expect(calls).toEqual([["/api/internal/waits", undefined], ["/api/internal/waits/cancel", { method: "POST", body: '{"id":"w1"}' }]]);
  });

  it("defines the three tools in order, with follow_up and never then", () => {
    expect(WAIT_TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual(["wait_until", "list_waits", "cancel_wait"]);
    expect([...WAIT_TOOL_NAMES]).toEqual(["wait_until", "list_waits", "cancel_wait"]);
    const waitUntil = WAIT_TOOL_DEFINITIONS.find((tool) => tool.name === "wait_until")!;
    const properties = (waitUntil.inputSchema as unknown as { properties: Record<string, { enum?: string[] }> }).properties;
    expect(Object.keys(properties)).toEqual(["label", "kind", "url", "text", "path", "process", "bot", "follow_up", "hours"]);
    expect(properties.kind!.enum).toEqual([...WAIT_KINDS]);
    expect(JSON.stringify(WAIT_TOOL_DEFINITIONS)).not.toMatch(/"then"|with then|give then/);
  });

  it("tells the model in few words: no AI while waiting, every kind, follow_up, 1 to 168 hours and a noun-phrase label", () => {
    const [waitUntil, list] = WAIT_TOOL_DEFINITIONS;
    const properties = (waitUntil!.inputSchema as unknown as { properties: Record<string, { description?: string }> }).properties;
    expect(waitUntil!.description).toContain("No AI runs while you wait");
    expect(waitUntil!.description).toContain("(default 24, 1-168)");
    for (const prefix of ["url_*", "file_*", "process_*", "bot_idle"]) expect(properties.kind!.description).toContain(prefix);
    expect(properties.follow_up!.description).toMatch(/^Only if the person asked for something to be done then.*You carry it out here\.$/);
    expect(properties.label!.description).toBe('A noun phrase in the person\'s words, e.g. "the build".');
    expect(list!.description).toMatch(/^Your waits in this chat that have not ended/);
    // The advertised bytes ride every turn that lists it: the catalog wire test budgets them, this keeps them small.
    const [advertised] = availableTools(catalogProfileFromEnv({ OMB_BOT_ID: "scout" })).filter((tool) => tool.name === "wait_until");
    expect(JSON.stringify(advertised).length).toBeLessThan(1_100);
  });
});

const waitNames = (env: Record<string, string>) =>
  availableTools(catalogProfileFromEnv({ OMB_BOT_ID: "scout", OMB_CHIEF_OF_STAFF: "1", ...env })).map((tool) => tool.name).filter((name) => WAIT_TOOL_NAMES.has(name));

describe("which wait tools a conversation is listed", () => {
  // The list is the same on every turn of a chat, so the provider's cached prompt carries over whether a wait is open or not.
  it("lists a direct chat all three, with or without a wait in it", () => {
    expect(waitNames({})).toEqual(["wait_until", "list_waits", "cancel_wait"]);
  });

  it("marks list_waits read-only, and nothing else of the three", () => {
    const tools = availableTools(catalogProfileFromEnv({ OMB_BOT_ID: "scout" })).filter((tool) => WAIT_TOOL_NAMES.has(tool.name));
    expect(tools.map((tool) => [tool.name, Boolean((tool as { annotations?: { readOnlyHint?: boolean } }).annotations?.readOnlyHint)]))
      .toEqual([["wait_until", false], ["list_waits", true], ["cancel_wait", false]]);
  });

  it("lists a room none of them: a room holds no wait", () => {
    expect(waitNames({ OMB_ROOM: "1" })).toEqual([]);
  });
});

describe("the wait tools in a chat with no wait", () => {
  let server: Server;
  let url = "";
  const reached: string[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url?.startsWith("/api/internal/waits")) reached.push(`${req.method} ${req.url}`);
      const [status, body] = req.url === "/api/internal/waits/cancel"
        ? [404, { error: "You are not waiting for anything in this chat, so there is nothing to cancel." }]
        : [200, { text: "You are not waiting for anything in this chat." }];
      req.resume();
      req.on("end", () => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const send = (env: Record<string, string>, method: string, params?: Json) =>
    agentsMcp({ OMB_BOT_ID: "scout", OMB_THREAD_ID: "t1", OMB_COMMS_TOKEN: "token", OMB_HARNESS_URL: url, ...env })(
      { jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) } as Json,
    ) as Promise<{ result?: { tools?: Array<{ name: string }>; content?: Array<{ text: string }>; isError?: boolean }; error?: { message: string } }>;
  const answer = async (env: Record<string, string>, name: string, args: Json = {}) => {
    const reply = await send(env, "tools/call", { name, arguments: args });
    return reply.error ? { error: reply.error.message } : { text: reply.result!.content![0]!.text, isError: reply.result!.isError };
  };

  it("lists them, and they answer plainly that there is nothing to list or cancel", async () => {
    const listed = (await send({}, "tools/list")).result!.tools!.map((tool) => tool.name);
    expect(listed).toEqual(expect.arrayContaining(["wait_until", "list_waits", "cancel_wait"]));
    reached.length = 0;
    expect(await answer({}, "list_waits")).toEqual({ text: "You are not waiting for anything in this chat.", isError: false });
    expect(await answer({}, "cancel_wait", { id: "w1" })).toEqual({ text: "You are not waiting for anything in this chat, so there is nothing to cancel.", isError: true });
    expect(reached).toEqual(["GET /api/internal/waits", "POST /api/internal/waits/cancel"]);
  });

  it("runs through use_tool on a bridged turn, whose find_tool offers them with or without a wait", async () => {
    const bridged = { OMB_AGENTS_TOOL_BRIDGE: "1" };
    const found = (JSON.parse((await answer(bridged, "find_tool", { query: "cancel_wait" })).text!) as { matches: Array<{ name: string }> })
      .matches.map((match) => match.name);
    expect(found).toContain("cancel_wait");
    expect(await answer(bridged, "use_tool", { name: "cancel_wait", arguments: { id: "w1" } }))
      .toEqual({ text: "You are not waiting for anything in this chat, so there is nothing to cancel.", isError: true });
    expect(await answer(bridged, "use_tool", { name: "list_waits" })).toEqual({ text: "You are not waiting for anything in this chat.", isError: false });
  });

  it("refuses the wait tools in a room as tools the room is not given", async () => {
    reached.length = 0;
    expect(await answer({ OMB_ROOM: "1" }, "cancel_wait", { id: "w1" })).toEqual({ error: "Unknown tool: cancel_wait" });
    expect(await answer({ OMB_ROOM: "1" }, "list_waits")).toEqual({ error: "Unknown tool: list_waits" });
    expect(reached).toEqual([]);
  });
});
