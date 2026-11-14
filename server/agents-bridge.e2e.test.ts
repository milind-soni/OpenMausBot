// The agents tool bridge on a real turn, in an isolated fixture: the saved
// switch reaches the agents proxy a turn is launched with, the prompt says
// so, and the proxy the engine was handed answers find_tool and use_tool
// against the fixture's own harness with that turn's capability, under the
// harness's own gates and limits. And what the harness then calls a bridged
// call: the tool it ran.
//
// The fake engine dumps what it was launched with (its system prompt and its
// MCP servers) and then holds the turn open, so the turn's capability is
// still good while this test starts the dumped agents server itself and
// talks to it the way the engine would. Nothing here touches a person's
// OpenMausBot: the server, its data and its home are the fixture's.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import type { WireMessage } from "../shared/wire.ts";
import { createToolBridge, type BridgeTool } from "./drivers/agents-bridge.ts";
import { gateServer } from "./mcp-gate-config.ts";
import { AGENTS_TOOL_BRIDGE_PROMPT } from "./system-prompt.ts";
import { turnEvidence } from "./turn-outcome.ts";
import { waitForExit } from "./testing/cleanup.ts";
import { hostTimeout } from "./testing/host-timeout.ts";
import { childEnv } from "./testing/omb-env.ts";

type McpServer = { command: string; args: string[]; env: Record<string, string> };
type Launched = { pid: number; systemPrompt: string; mcpConfig: { mcpServers: Record<string, McpServer> } };
type Answer = {
  id: number;
  result?: { tools?: BridgeTool[]; content?: Array<{ text: string }>; isError?: boolean };
  error?: { code: number; message: string };
};
type Ask = (method: string, params?: unknown) => Promise<Answer>;

async function withFixture(run: (helpers: {
  api(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }>;
  control(args: string[]): Promise<any>;
  /** What the fake engine was launched with for the turn just sent. */
  launched(): Promise<Launched>;
  // hang: the engine keeps its turn open until it is interrupted
}) => Promise<void>, engine: Record<string, string> = { FAKE_CLAUDE_MODE: "hang" }) {
  const fixture = await launchVerificationServer({ ...process.env, ...engine });
  try {
    await run({
      api: async (method, path, body) => {
        const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        return { status: response.status, body: await response.json() };
      },
      control: (args) => runControlOmb([...args, "--url", fixture.info.url]),
      launched: async () => {
        await expect.poll(() => existsSync(fixture.fixtureDumpPath), { timeout: 30_000 }).toBe(true);
        const value = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")) as Launched;
        rmSync(fixture.fixtureDumpPath, { force: true });
        return value;
      },
    });
  } finally { await fixture.close(); }
}

/** One MCP server exactly as the engine was told to start it, asked one
 * request at a time: each answer is read off its stdout before the next
 * request is written, as an engine's own calls arrive, so a limit the
 * harness counts is counted in the order asked. */
async function withServer(server: McpServer, run: (ask: Ask) => Promise<void>): Promise<void> {
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
  child.on("exit", (code) => stopped(`the agents server exited (${code}) before answering`));
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
const textOf = (answer: Answer) => answer.result!.content![0]!.text;
const call = (ask: Ask, name: string, args: unknown) => ask("tools/call", { name, arguments: args });
const use = (ask: Ask, name: string, args?: unknown) => call(ask, "use_tool", { name, ...(args === undefined ? {} : { arguments: args }) });
/** A bridged call that was refused: a failed tool call the model reads,
 * never a protocol error, and its words. */
const refusalOf = (answer: Answer): string => {
  expect(answer.error).toBeUndefined();
  expect(answer.result!.isError).toBe(true);
  return textOf(answer);
};

it("keeps a turn on the whole catalog until the switch is on, then mounts the bridge and says so, in a chat and in a room", async () => {
  await withFixture(async ({ api, control, launched }) => {
    const { bot } = await control(["new-bot", "--name", "Bridge fixture"]);
    const { bot: teammate } = await control(["new-bot", "--name", "Bridge teammate"]);

    // Off by default: the whole catalog, no bridge tools, nothing in the prompt.
    await control(["send", "--bot", bot.id, "--text", "Stay active."]);
    const before = await launched();
    const unbridged = before.mcpConfig.mcpServers.agents!;
    expect(unbridged.env.OMB_AGENTS_TOOL_BRIDGE).toBe("0");
    expect(before.systemPrompt).not.toContain("find_tool");
    let whole: BridgeTool[] = [];
    await withServer(unbridged, async (ask) => {
      whole = (await ask("tools/list")).result!.tools!;
      expect(whole.map((tool) => tool.name)).toEqual(expect.arrayContaining(["coordinate_bots", "trigger", "trigger_info", "session_search"]));
      expect(whole.map((tool) => tool.name)).not.toEqual(expect.arrayContaining(["find_tool"]));
      expect(whole.length).toBeGreaterThan(25);
      // the bridge's two names mean nothing to a turn that does not have it
      expect((await call(ask, "use_tool", { name: "list_triggers" })).error).toEqual({ code: -32602, message: "Unknown tool: use_tool" });
    });
    await control(["interrupt", "--bot", bot.id]);
    await control(["wait", "--bot", bot.id, "--timeout", "30"]);

    // Switched on in the saved settings: the next turn is launched bridged.
    expect((await api("PATCH", "/api/config", { features: { agentsToolBridge: true } })).status).toBe(200);
    await control(["send", "--bot", bot.id, "--text", "Stay active again."]);
    const after = await launched();
    expect(after.pid).not.toBe(before.pid);
    const bridged = after.mcpConfig.mcpServers.agents!;
    expect(bridged.env.OMB_AGENTS_TOOL_BRIDGE).toBe("1");
    expect(after.systemPrompt).toContain(AGENTS_TOOL_BRIDGE_PROMPT);
    // the rest of the prompt still names its tools as it did; the one rule covers them
    for (const prompt of [before.systemPrompt, after.systemPrompt]) expect(prompt).toContain("set it up with trigger action=create in this turn");
    // said once
    expect(after.systemPrompt.split(AGENTS_TOOL_BRIDGE_PROMPT)).toHaveLength(2);
    // a fixture bot is not a Chief of Staff, so create_bot is not one of its tools
    expect(bridged.env.OMB_CHIEF_OF_STAFF).toBe("0");

    // While that turn is open its capability is good: the proxy the engine
    // was handed answers through the fixture's own harness.
    await withServer(bridged, async (ask) => {
      const list = await ask("tools/list");
      // exactly what the bridge makes of this turn's own unbridged list
      expect(JSON.stringify(list.result!.tools)).toBe(JSON.stringify(createToolBridge(whole).listed));
      expect(namesOf(list).slice(-2)).toEqual(["find_tool", "use_tool"]);
      expect(namesOf(list)).toEqual(expect.arrayContaining(["coordinate_bots", "post_to_room", "memory_update", "request_sign_in"]));
      expect(namesOf(list)).not.toEqual(expect.arrayContaining(["trigger"]));
      expect(JSON.stringify(list.result!.tools).length).toBeLessThan(JSON.stringify(whole).length / 2);

      // found from how a person would ask, with the schema the whole catalog lists
      const found = (JSON.parse(textOf(await call(ask, "find_tool", { query: "what routines do I have" }))) as { matches: BridgeTool[] }).matches;
      expect(found[0]!.name).toBe("trigger_info");
      expect(found[0]!.inputSchema).toEqual(whole.find((tool) => tool.name === "trigger_info")!.inputSchema);
      // then run: the harness itself answered, with this turn's capability,
      // what it answers the same tool called by its own name
      const routines = await use(ask, "list_triggers");
      expect(routines.result!.isError).toBeFalsy();
      expect(textOf(routines)).toMatch(/^This bot has no triggers\. Current time: /);
      expect(textOf(await call(ask, "list_triggers", {})).replace(/Current time: [^\n]*/, "")).toBe(textOf(routines).replace(/Current time: [^\n]*/, ""));

      // a name outside this turn's profile; arguments the tool's schema refuses;
      // an outward action, which keeps its own name
      expect(refusalOf(await use(ask, "create_bot", { name: "Scout", role: "Ops", instructions: "Work." }))).toBe("Unknown tool: create_bot");
      expect((await call(ask, "create_bot", { name: "Scout", role: "Ops", instructions: "Work." })).error).toEqual({ code: -32602, message: "Unknown tool: create_bot" });
      // arguments the tool will not take are refused by the tool, in the words a direct call gets
      const misfit = await use(ask, "session_read", { thread_id: 7 });
      expect(refusalOf(misfit)).toBe(textOf(await call(ask, "session_read", { thread_id: 7 })));
      expect(refusalOf(await use(ask, "post_to_room", { group_id: "room-1", message: "Shipped." }))).toContain("post_to_room is in your tool list: call it directly");

      // A parameter only a Chief may pass. The bridged list leaves it out of
      // this bot's schema and use_tool checks no schema, so it is the harness
      // that refuses it, as it refuses the same call made directly.
      const other = { title: "Lead", reason: "asked", for_bot_id: teammate.id };
      const refused = await use(ask, "propose_profile", other);
      expect(refusalOf(refused)).toContain("only a section's Chief of Staff can change another bot's profile");
      expect(refused.result).toEqual((await call(ask, "propose_profile", other)).result);
    });
    // A tool selection saved after this turn decided to bridge is the one in
    // force when the turn is mounted (a room turn reads it last). The mount
    // then starts this very integration unbridged behind its gate: the whole
    // catalog but what the selection leaves out, and no way round it.
    await withServer(gateServer({ name: "agents", server: bridged, threadId: bot.activeTaskId, budget: 0, toolScope: { deny: ["mcp:agents:vm_exec"] } })!, async (ask) => {
      const names = namesOf(await ask("tools/list"));
      for (const absent of ["find_tool", "use_tool", "vm_exec"]) expect(names, absent).not.toContain(absent);
      expect(names).toEqual(whole.map((tool) => tool.name).filter((name) => name !== "vm_exec"));
      expect((await call(ask, "vm_exec", { command: "true" })).error).toEqual({ code: -32602, message: "Tool selection excludes this tool. Check the bot's Access settings." });
      expect((await use(ask, "vm_exec", { command: "true" })).error).toEqual({ code: -32602, message: "Tool selection excludes this tool. Check the bot's Access settings." });
      expect((await use(ask, "list_triggers")).error).toEqual({ code: -32602, message: "Unknown tool: use_tool" });
      // and what the selection allows still reaches the harness
      expect(textOf(await call(ask, "list_triggers", {}))).toMatch(/^This bot has no triggers\. Current time: /);
    });
    // the prompt this turn was given is still true of that mount: it speaks of the bridge tools only if they are listed
    expect(after.systemPrompt).toContain(" If find_tool and use_tool are in your tool list, ");
    await control(["interrupt", "--bot", bot.id]);
    await control(["wait", "--bot", bot.id, "--timeout", "30"]);

    // A room turn is built by its own code path; it gets the same.
    const { channel } = await control(["new-channel", "--name", "Bridge room", "--members", bot.id]);
    await control(["send-channel", "--channel", channel.id, "--text", "Stay active in this room."]);
    const room = await launched();
    expect(room.mcpConfig.mcpServers.agents!.env.OMB_AGENTS_TOOL_BRIDGE).toBe("1");
    // A room refuses widgets, pages and a computer pick, so its turn is not listed them.
    expect(room.mcpConfig.mcpServers.agents!.env).toMatchObject({ OMB_ROOM: "1", OMB_COMPUTER_SELECTION: "0" });
    expect(after.mcpConfig.mcpServers.agents!.env.OMB_ROOM).toBe("0");
    expect(room.systemPrompt).toContain(AGENTS_TOOL_BRIDGE_PROMPT);
    await control(["interrupt", "--channel", channel.id]);
    await control(["wait", "--channel", channel.id, "--timeout", "30"]);
  });
}, hostTimeout(90_000));

it("leaves every gate and limit where it was: a tool selection, a Chief-only tool and the per-turn thread limit hold for a bridged call as for a direct one", async () => {
  await withFixture(async ({ api, control, launched }) => {
    expect((await api("PATCH", "/api/config", { features: { agentsToolBridge: true } })).status).toBe(200);

    // A bot with a tool selection keeps the whole catalog behind its gate,
    // which refuses the excluded tool by its own name; there is no bridge to
    // carry the call past it.
    const { bot: selected } = await control(["new-bot", "--name", "Selected bridge fixture"]);
    const toolScope = { deny: ["mcp:agents:vm_exec"] };
    expect((await api("PATCH", `/api/bots/${selected.id}`, { toolScope })).status).toBe(200);
    await control(["send", "--bot", selected.id, "--text", "Stay active."]);
    const gatedTurn = await launched();
    // With a selection the engine is handed the gate, which starts the proxy.
    const gate = gatedTurn.mcpConfig.mcpServers.agents!;
    expect(JSON.parse(gate.env.OMB_GATE_TOOL_SCOPE!)).toEqual(toolScope);
    expect((JSON.parse(gate.env.OMB_GATE_UPSTREAM!) as McpServer).env.OMB_AGENTS_TOOL_BRIDGE).toBe("0");
    expect(gatedTurn.systemPrompt).not.toContain("find_tool");
    await withServer(gate, async (ask) => {
      const list = await ask("tools/list");
      // the whole catalog but the one tool the selection leaves out, and no way round it
      expect(namesOf(list)).toEqual(expect.arrayContaining(["coordinate_bots", "trigger", "list_rooms", "post_to_room"]));
      for (const name of ["vm_exec", "find_tool", "use_tool"]) expect(namesOf(list), name).not.toContain(name);
      expect((await call(ask, "vm_exec", { command: "true" })).error).toEqual({ code: -32602, message: "Tool selection excludes this tool. Check the bot's Access settings." });
      expect((await use(ask, "vm_exec", { command: "true" })).error).toEqual({ code: -32602, message: "Tool selection excludes this tool. Check the bot's Access settings." });
      expect((await use(ask, "list_triggers")).error).toEqual({ code: -32602, message: "Unknown tool: use_tool" });
    });
    await control(["interrupt", "--bot", selected.id]);
    await control(["wait", "--bot", selected.id, "--timeout", "30"]);

    // A bot with no selection is bridged.
    const { bot } = await control(["new-bot", "--name", "Limits bridge fixture"]);
    await control(["send", "--bot", bot.id, "--text", "Stay active."]);
    const turn = await launched();
    const bridged = turn.mcpConfig.mcpServers.agents!;
    expect(bridged.env.OMB_AGENTS_TOOL_BRIDGE).toBe("1");
    expect(bridged.env.OMB_BOT_ID).toBe(bot.id);

    // The harness refuses a Chief-only tool to this bot whatever its proxy
    // lists. Started as if it were a Chief's, the proxy lets the call
    // through, and the harness's own refusal comes back the same both ways.
    await withServer({ ...bridged, env: { ...bridged.env, OMB_CHIEF_OF_STAFF: "1" } }, async (ask) => {
      const scout = { name: "Scout", role: "Ops", instructions: "Work." };
      const direct = await call(ask, "create_bot", scout);
      const throughBridge = await use(ask, "create_bot", scout);
      expect(refusalOf(throughBridge)).toContain("only a section's Chief of Staff can create operator bots");
      expect(throughBridge.result).toEqual(direct.result);
    });

    // One count for the turn, kept by the harness: threads opened directly
    // and through use_tool draw on the same five, and the sixth is refused
    // in the same words either way.
    await withServer(bridged, async (ask) => {
      const job = (n: number) => ({ title: `Bridge job ${n}`, message: `Do job ${n}.` });
      for (const n of [1, 2]) expect((await call(ask, "start_thread", job(n))).result!.isError, `direct ${n}`).toBeFalsy();
      for (const n of [3, 4, 5]) {
        const opened = await use(ask, "start_thread", job(n));
        expect(opened.result!.isError, `bridged ${n}`).toBeFalsy();
        expect(textOf(opened)).toContain(`Opened thread #Bridge job ${n} on yourself`);
      }
      const sixth = await use(ask, "start_thread", job(6));
      expect(refusalOf(sixth)).toContain("You have already opened 5 threads this turn, which is the limit");
      expect((await call(ask, "start_thread", job(6))).result).toEqual(sixth.result);
    });
    await control(["interrupt", "--bot", bot.id]);
  });
}, hostTimeout(120_000));

it("knows a bridged call by the tool it ran, in the activity row, the work summary and the restart policy's evidence, and leaves an unbridged turn's rows alone", async () => {
  // What an engine reports for a turn that used the bridge: every call but
  // the last two is named use_tool. The post is one the proxy would have
  // refused; it is scripted as done to show what the restart policy would see.
  const calls = [
    { name: "mcp__agents__use_tool", input: { name: "list_triggers", arguments: {} }, output: "This bot has no triggers.", ok: true },
    { name: "mcp__agents__use_tool", input: { name: "post_to_room", arguments: { group_id: "room-1", message: "Shipped." } }, output: "Posted.", ok: true },
    { name: "mcp__agents__use_tool", input: { name: "schedule_task", arguments: {} }, output: "Unknown tool: schedule_task", ok: false },
    { name: "mcp__agents__use_tool", input: { arguments: { name: "vm_exec" } }, output: "use_tool needs a name", ok: false },
    { name: "mcp__agents__find_tool", input: { query: "what routines do I have" }, output: "{}", ok: true },
    { name: "mcp__agents__list_bots", input: {}, output: "No other bots.", ok: true },
  ];
  await withFixture(async ({ api, control }) => {
    const { bot } = await control(["new-bot", "--name", "Bridge names fixture"]);
    /** One turn's tool rows and its work summary. */
    const turn = async (text: string) => {
      await control(["send", "--bot", bot.id, "--text", text]);
      expect((await control(["wait", "--bot", bot.id, "--timeout", "30"])).status).toBe("settled");
      const { messages } = (await api("GET", `/api/threads/${bot.activeTaskId}/messages?limit=100`)).body as { messages: WireMessage[] };
      const latest = messages.findLast((message) => message.kind === "digest")!;
      return { rows: messages.filter((message) => message.kind === "activity" && message.tool?.itemId && message.turnId === latest.turnId), digest: latest.digest! };
    };

    // The switch is off: this turn's agents server lists its whole catalog,
    // so a tool called use_tool is not the bridge's, whatever it names. Every
    // row keeps the name it came with.
    const unbridged = await turn("Use your tools.");
    expect(unbridged.rows.map((row) => row.tool!.name)).toEqual(calls.map((call) => call.name));
    expect(Object.fromEntries(unbridged.digest.tools.map((tool) => [tool.name, tool.count]))).toEqual({
      "mcp__agents__use_tool": 4,
      "mcp__agents__find_tool": 1,
      "mcp__agents__list_bots": 1,
    });
    expect(turnEvidence(unbridged.rows as never)).not.toHaveProperty("outward");

    // Switched on, the same calls on a bridged turn: one that named a tool of
    // the catalog reads as that tool; one that named none, or no tool there
    // is, keeps the name it came with.
    expect((await api("PATCH", "/api/config", { features: { agentsToolBridge: true } })).status).toBe(200);
    const bridged = await turn("Use your tools again.");
    expect(bridged.rows.map((row) => row.tool!.name)).toEqual([
      "mcp__agents__list_triggers",
      "mcp__agents__post_to_room",
      "mcp__agents__use_tool",
      "mcp__agents__use_tool",
      "mcp__agents__find_tool",
      "mcp__agents__list_bots",
    ]);
    expect(bridged.rows.map((row) => row.tool!.ok)).toEqual([true, true, false, false, true, true]);
    // the work summary counts them the same way
    expect(Object.fromEntries(bridged.digest.tools.map((tool) => [tool.name, [tool.count, tool.failed]]))).toEqual({
      "mcp__agents__list_triggers": [1, 0],
      "mcp__agents__post_to_room": [1, 0],
      "mcp__agents__use_tool": [2, 2],
      "mcp__agents__find_tool": [1, 0],
      "mcp__agents__list_bots": [1, 0],
    });
    // and the restart policy sees that something was posted, which it could not under the name use_tool
    expect(turnEvidence(bridged.rows as never)).toMatchObject({ toolCalls: 6, okToolCalls: 4, outward: ["mcp__agents__post_to_room"] });

    // The bot's Activity log is read back from the event log, which keeps the
    // call as the engine reported it. It names each of those calls by the
    // tool it ran too, on both turns: the title says whose tool it was, and
    // that is all there is to go on after the fact.
    const { rows } = (await api("GET", `/api/bots/${bot.id}/activity`)).body as { rows: Array<{ tool: string; app: string | null; label: string; outcome: string }> };
    const logged = (tool: string) => rows.filter((row) => row.tool === tool).map(({ app, label, outcome }) => ({ app, label, outcome }));
    expect(logged("mcp__agents__list_triggers")).toEqual([{ app: "Team", label: "List triggers", outcome: "ran" }, { app: "Team", label: "List triggers", outcome: "ran" }]);
    expect(logged("mcp__agents__post_to_room")).toHaveLength(2);
    // what named no tool of the catalog is still a use_tool call, there as here
    expect(logged("mcp__agents__use_tool")).toEqual(Array.from({ length: 4 }, () => ({ app: "Team", label: "Use tool", outcome: "failed" })));
  }, { FAKE_CLAUDE_TOOL_CALLS: JSON.stringify(calls) });
}, hostTimeout(90_000));
