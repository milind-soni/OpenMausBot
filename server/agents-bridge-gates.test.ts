// A tool selection and the agents tool bridge never meet. A selection is
// enforced by gates that match the name in the call, and a call made through
// the bridge is named use_tool, so wherever a selection is mounted in front
// of the agents server that server is started unbridged, whatever the turn
// decided when it built the integration. These are the mounts, each given an
// integration that WAS asked to bridge: the case of a selection saved between
// a turn's bridge decision and its dispatch (a room turn reads the selection
// last), which nothing but the mount can catch.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolScope } from "../shared/tool-scope.ts";
import type { SendTurnInput } from "./contracts.ts";
import { TOOL_BRIDGE_ENV } from "./drivers/agents-bridge.ts";
import { mountChatTools, type ChatToolSession } from "./drivers/chat-mcp-tools.ts";
import { buildMcpServers } from "./drivers/pi.ts";
import { turnStdioMcpServers } from "./drivers/turn-mcp.ts";
import { gateServer } from "./mcp-gate-config.ts";
import { SPAWNED_PROXIES } from "./proxy-paths.ts";
import { waitForExit } from "./testing/cleanup.ts";
import { childEnv } from "./testing/omb-env.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
type Server = { command: string; args: string[]; env: Record<string, string> };
/** A turn's agents integration as the harness builds it, asked to bridge.
 * Its harness is nowhere: nothing below gets as far as one. */
const BRIDGED: Server = {
  command: process.execPath,
  args: [join(HERE, "drivers", "agents-proxy.ts")],
  env: { OMB_HARNESS_URL: "http://127.0.0.1:9", OMB_BOT_ID: "bot-gated", OMB_THREAD_ID: "thread-gated", OMB_COMMS_TOKEN: "unused", OMB_TURN_DEPTH: "0", [TOOL_BRIDGE_ENV]: "1" },
};
const DENY_VM: ToolScope = { deny: ["mcp:agents:vm_exec"] };
const ONLY_LIST_BOTS: ToolScope = { allow: ["mcp:agents:list_bots"] };
const EXCLUDED = { code: -32602, message: "Tool selection excludes this tool. Check the bot's Access settings." };

type Answer = { id: number; result?: { tools?: Array<{ name: string }>; content?: Array<{ text: string }>; isError?: boolean }; error?: { code: number; message: string } };
type Ask = (method: string, params?: unknown) => Promise<Answer>;

/** One MCP server as an engine would start it, asked one request at a time. */
async function withServer(server: Server, run: (ask: Ask) => Promise<void>): Promise<void> {
  const child = spawn(server.command, server.args, { env: childEnv(server.env), stdio: ["pipe", "pipe", "inherit"] });
  const waiting = new Map<number, { resolve(answer: Answer): void; reject(error: Error): void }>();
  let buffer = "";
  let nextId = 1;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const answer = JSON.parse(buffer.slice(0, newline)) as Answer;
      buffer = buffer.slice(newline + 1);
      waiting.get(answer.id)?.resolve(answer);
      waiting.delete(answer.id);
    }
  });
  const stopped = (why: string) => { for (const entry of waiting.values()) entry.reject(new Error(why)); waiting.clear(); };
  child.on("error", (error) => stopped(String(error)));
  child.on("exit", (code) => stopped(`the server exited (${code}) before answering`));
  try {
    await run((method, params) => new Promise<Answer>((resolve, reject) => {
      const id = nextId++;
      waiting.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) })}\n`);
    }));
  } finally {
    await waitForExit(child, { signal: "SIGTERM" });
  }
}

const namesOf = (answer: Answer) => answer.result!.tools!.map((tool) => tool.name);
const call = (ask: Ask, name: string, args: unknown) => ask("tools/call", { name, arguments: args });
const use = (ask: Ask, name: string, args: unknown = {}) => call(ask, "use_tool", { name, arguments: args });
/** The server a gate was told to start. */
const upstreamOf = (gate: { env: Record<string, string> }, configEnvName?: string): Server =>
  JSON.parse((configEnvName ? JSON.parse(gate.env[configEnvName]!) as Record<string, string> : gate.env).OMB_GATE_UPSTREAM!) as Server;

describe("a gate's upstream", () => {
  const mount = (toolScope: ToolScope | undefined, extra: Partial<Parameters<typeof gateServer>[0]> = {}) =>
    gateServer({ name: "agents", server: BRIDGED, threadId: "thread-gated", budget: 0, toolScope, ...extra });

  it("is the agents server unbridged whenever there is a selection, whatever the integration says", () => {
    for (const toolScope of [DENY_VM, ONLY_LIST_BOTS, { allow: ["mcp:agents:*"] }, { allow: [] }, {}] satisfies ToolScope[]) {
      const upstream = upstreamOf(mount(toolScope)!);
      expect(upstream.env[TOOL_BRIDGE_ENV], JSON.stringify(toolScope)).toBe("0");
      // and nothing else about it is touched
      expect(upstream, JSON.stringify(toolScope)).toEqual({ ...BRIDGED, env: { ...BRIDGED.env, [TOOL_BRIDGE_ENV]: "0" } });
    }
    // Codex hands each mount its settings under a private name
    const configEnvName = `OMB_GATE_CONFIG_${"a".repeat(64)}`;
    expect(upstreamOf(mount(DENY_VM, { configEnvName })!, configEnvName).env[TOOL_BRIDGE_ENV]).toBe("0");
    // the integration the turn holds is not rewritten: the prompt was built from it
    expect(BRIDGED.env[TOOL_BRIDGE_ENV]).toBe("1");
  });

  it("is left alone without a selection: there is no name to match, so nothing to protect", () => {
    // no selection and nothing to trim: no gate at all
    expect(mount(undefined)).toBeNull();
    // a gate that only trims results relays every call as it came
    expect(upstreamOf(mount(undefined, { budget: 12_000 })!)).toEqual(BRIDGED);
  });

  it("touches no other server, whatever is in its environment", () => {
    const other: Server = { command: "npx", args: ["some-server"], env: { TOKEN: "t", [TOOL_BRIDGE_ENV]: "1" } };
    expect(upstreamOf(gateServer({ name: "notes", server: other, threadId: "thread-gated", budget: 0, toolScope: { allow: ["mcp:notes:*"] } })!)).toEqual(other);
    expect(other.env[TOOL_BRIDGE_ENV]).toBe("1");
  });
});

describe("every mount that puts a selection in front of the agents server", () => {
  const turn = (toolScope?: ToolScope): SendTurnInput => ({ threadId: "thread-gated", text: "hi", integrations: { agents: BRIDGED }, ...(toolScope ? { toolScope } : {}) });

  it("the ACP mounts start it unbridged, and bridged as built without one", () => {
    const gated = turnStdioMcpServers(turn(DENY_VM)).find((server) => server.name === "agents")!;
    expect(gated.args).toEqual([SPAWNED_PROXIES.mcpGate]);
    expect(upstreamOf(gated).env[TOOL_BRIDGE_ENV]).toBe("0");
    expect(turnStdioMcpServers(turn()).find((server) => server.name === "agents")!.env[TOOL_BRIDGE_ENV]).toBe("1");
  });

  it("Pi's mount starts it unbridged, and bridged as built without one", () => {
    const gated = buildMcpServers(turn(DENY_VM))!.agents as Server;
    expect(gated.args).toEqual([SPAWNED_PROXIES.mcpGate]);
    expect(upstreamOf(gated).env[TOOL_BRIDGE_ENV]).toBe("0");
    expect((buildMcpServers(turn())!.agents as Server).env[TOOL_BRIDGE_ENV]).toBe("1");
  });

  describe("the chat runtime's own selection", () => {
    let session: ChatToolSession | undefined;
    afterEach(async () => { await session?.close(); session = undefined; });
    const mounted = async (toolScope?: ToolScope) => {
      session = await mountChatTools({ agents: BRIDGED }, new AbortController().signal, false, toolScope);
      return session.definitions.map((definition) => definition.function.name);
    };

    it("lists the whole catalog but what the selection leaves out, with no bridge tools", async () => {
      const names = await mounted(DENY_VM);
      for (const absent of ["agents_find_tool", "agents_use_tool", "agents_vm_exec"]) expect(names, absent).not.toContain(absent);
      expect(names).toEqual(["agents_search_tools", "agents_describe_tool", "agents_call_tool"]);
      // still OpenMausBot's own server, which never asks
      expect(session!.view("agents_call_tool", { name: "list_triggers", arguments: {} })).toMatchObject({ ask: false });
      expect(() => session!.validate("agents_use_tool", { name: "vm_exec" })).toThrow("not advertised for this turn");
    });

    it("lists only what an allow-list names, so the bridge tools cannot be lost to it", async () => {
      expect(await mounted(ONLY_LIST_BOTS)).toEqual(["agents_list_bots"]);
    });

    it("is bridged as built when the bot has no selection", async () => {
      const names = await mounted();
      expect(names).toEqual(["agents_search_tools", "agents_describe_tool", "agents_call_tool"]);
      expect(names).not.toContain("agents_create_trigger");
      expect(session!.view("agents_call_tool", { name: "use_tool", arguments: { name: "list_triggers", arguments: {} } })).toMatchObject({ ask: false });
    });
  });
});

describe("the gate and the proxy as processes", () => {
  it("a deny over a proxy that was asked to bridge: no bridge tools, the denied tool refused, use_tool unknown", async () => {
    // The reproduction from the review: before the mount unbridged the
    // proxy, use_tool({ name: "vm_exec" }) passed this gate and ran.
    await withServer(gateServer({ name: "agents", server: BRIDGED, threadId: "thread-gated", budget: 0, toolScope: DENY_VM })!, async (ask) => {
      const names = namesOf(await ask("tools/list"));
      for (const absent of ["find_tool", "use_tool", "vm_exec"]) expect(names, absent).not.toContain(absent);
      expect(names).toEqual(expect.arrayContaining(["coordinate_bots", "create_trigger", "list_triggers", "post_to_room"]));
      expect(names.length).toBeGreaterThan(20);
      expect((await call(ask, "vm_exec", { command: "true" })).error).toEqual(EXCLUDED);
      // through use_tool the gate refuses it by the tool it names, and for any
      // other tool there is no use_tool behind the gate to call
      expect((await use(ask, "vm_exec", { command: "true" })).error).toEqual(EXCLUDED);
      expect((await use(ask, "list_triggers")).error).toEqual({ code: -32602, message: "Unknown tool: use_tool" });
      expect((await call(ask, "find_tool", { query: "run a shell command" })).error).toEqual({ code: -32602, message: "Unknown tool: find_tool" });
    });
  });

  it("an allow-list over one: exactly the allowed tools, and neither bridge tool to be hidden by it", async () => {
    await withServer(gateServer({ name: "agents", server: BRIDGED, threadId: "thread-gated", budget: 0, toolScope: ONLY_LIST_BOTS })!, async (ask) => {
      expect(namesOf(await ask("tools/list"))).toEqual(["list_bots"]);
      expect((await use(ask, "list_triggers")).error).toEqual(EXCLUDED);
      expect((await call(ask, "find_tool", { query: "routines" })).error).toEqual(EXCLUDED);
    });
  });

  it("judges a use_tool call by the tool it names too, should a bridged proxy ever answer behind a selection", async () => {
    // Not reachable through gateServer any more. Started by hand, as a mount
    // that forgot would start it.
    const forgetful = (toolScope: ToolScope): Server => ({
      command: process.execPath,
      args: [SPAWNED_PROXIES.mcpGate],
      env: { OMB_GATE_NAME: "agents", OMB_GATE_UPSTREAM: JSON.stringify(BRIDGED), OMB_GATE_BUDGET: "0", OMB_GATE_TOOL_SCOPE: JSON.stringify(toolScope) },
    });
    await withServer(forgetful(DENY_VM), async (ask) => {
      expect(namesOf(await ask("tools/list")).slice(-2)).toEqual(["find_tool", "use_tool"]);
      expect((await use(ask, "vm_exec", { command: "true" })).error).toEqual(EXCLUDED);
      // a tool the selection does not exclude goes through to the proxy, which has its own answer
      const unknown = await use(ask, "made_up");
      expect(unknown.error).toBeUndefined();
      expect(unknown.result).toMatchObject({ isError: true, content: [{ type: "text", text: "Unknown tool: made_up" }] });
      // a search runs nothing and names no tool to judge
      expect((await call(ask, "find_tool", { query: "run a shell command in the VM" })).result!.isError).toBe(false);
    });
    // with an allow-list, naming the two bridge tools does not let a tool outside it through
    await withServer(forgetful({ allow: ["mcp:agents:use_tool", "mcp:agents:find_tool", "mcp:agents:list_triggers"] }), async (ask) => {
      expect((await use(ask, "vm_exec", { command: "true" })).error).toEqual(EXCLUDED);
      expect((await use(ask, "start_thread", { title: "t", message: "m" })).error).toEqual(EXCLUDED);
    });
  });
});
