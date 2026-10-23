// Why a name the bridge does not know comes back from use_tool as a failed
// tool result and not as the JSON-RPC error a direct call gets: on the
// chat-completions runtime a protocol error on tools/call is a broken
// transport, and ends the turn on the spot (chat-mcp-tools.ts closes the
// session, openai-chat.ts rethrows). A model that guessed a name wrong must
// be told so and carry on, on exactly the engines that have no tool search of
// their own. One whole turn, through the real driver and the real proxy.
import { randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, expect, it } from "vitest";

import type { SendTurnInput } from "../contracts.ts";
import { recordEvents } from "../testing/events.ts";
import { TOOL_BRIDGE_ENV } from "./agents-bridge.ts";
import { OpenAICompatDriver } from "./openai-compat.ts";

interface ChatRequest {
  messages: Array<{ role: string; content: unknown; tool_call_id?: string }>;
  tools?: Array<{ function: { name: string } }>;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const sse = (response: ServerResponse, delta: unknown, finishReason: string) => {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`);
  response.end("data: [DONE]\n\n");
};
const calls = (response: ServerResponse, id: string, name: string, args: unknown) =>
  sse(response, { content: null, tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, "tool_calls");

it("a bridged turn on the chat-completions runtime carries on after use_tool names a tool it does not have", async () => {
  // The model: a wrong guess, then a search, then its answer.
  const requests: ChatRequest[] = [];
  const provider = createServer(async (request, response) => {
    if (request.url === "/v1/models") {
      response.setHeader("content-type", "application/json");
      response.end('{"data":[]}');
      return;
    }
    let data = "";
    for await (const part of request) data += part.toString();
    requests.push(JSON.parse(data) as ChatRequest);
    if (requests.length === 1) calls(response, "call_guess", "agents_call_tool", { name: "use_tool", arguments: { name: "schedule_task", arguments: { every: "morning" } } });
    else if (requests.length === 2) calls(response, "call_search", "agents_call_tool", { name: "find_tool", arguments: { query: "schedule a recurring task every morning" } });
    else sse(response, { content: "The tool for that is create_trigger." }, "stop");
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  if (!address || typeof address === "string") throw new Error("the provider did not bind TCP");
  const instance = await OpenAICompatDriver.create({
    instanceId: randomUUID(), displayName: "Bridge fixture", enabled: true,
    config: { url: `http://127.0.0.1:${address.port}/v1`, apiKeyEnv: "FIXTURE_CHAT_KEY" },
    environment: { FIXTURE_CHAT_KEY: "fixture-key" },
  });
  const recorder = recordEvents(instance.adapter);
  cleanups.push(async () => {
    recorder.stop();
    await instance.dispose();
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  });

  // The agents proxy as the harness mounts it for a bridged turn. Neither
  // call below gets as far as a harness, so there is none.
  const agents: NonNullable<SendTurnInput["integrations"]>["agents"] = {
    command: process.execPath,
    args: [join(dirname(fileURLToPath(import.meta.url)), "agents-proxy.ts")],
    env: { OMB_HARNESS_URL: "http://127.0.0.1:9", OMB_BOT_ID: "bot-chat", OMB_THREAD_ID: "thread-chat", OMB_COMMS_TOKEN: "unused", OMB_TURN_DEPTH: "0", [TOOL_BRIDGE_ENV]: "1" },
  };
  const threadId = randomUUID();
  await instance.adapter.sendTurn({ threadId, text: "Schedule my morning brief.", model: "fixture-model", integrations: { agents } });
  const completed = await recorder.until((event) => event.type === "turn.completed");

  // The model was handed the bridged list.
  const handed = requests[0]!.tools!.map((tool) => tool.function.name);
  expect(handed).toEqual(expect.arrayContaining(["agents_search_tools", "agents_describe_tool", "agents_call_tool"]));
  expect(handed).not.toContain("agents_create_trigger");

  // The wrong guess came back as a failed call it could read...
  expect(requests[1]!.messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "call_guess" });
  expect(JSON.parse(requests[1]!.messages.at(-1)!.content as string)).toEqual({ ok: false, result: "Unknown tool: schedule_task" });
  // ...and the turn went on: the search ran and answered, and the model had its say.
  expect(requests).toHaveLength(3);
  const searched = JSON.parse(requests[2]!.messages.at(-1)!.content as string) as { ok: boolean; result: string };
  expect(searched.ok).toBe(true);
  expect((JSON.parse(searched.result) as { matches: Array<{ name: string }> }).matches[0]!.name).toBe("create_trigger");
  const tools = recorder.events.flatMap((event) => event.type === "item.completed" && event.itemType === "tool" ? [event.ok] : []);
  expect(tools).toEqual([false, true]);
  expect(recorder.events.some((event) => event.type === "item.completed" && event.itemType === "assistant_text" && event.text === "The tool for that is create_trigger.")).toBe(true);

  // It ends the way any turn with a failed tool call ends on this runtime,
  // not as a transport that broke under it.
  const errors = recorder.events.flatMap((event) => event.type === "runtime.error" ? [event.message] : []);
  expect(errors.join("\n")).not.toMatch(/MCP request failed|MCP session closed|execution outcome may be uncertain/);
  expect(completed).toMatchObject({ ok: false });
  expect(errors).toEqual([expect.stringContaining("One or more tool operations failed or were denied")]);
}, 30_000);
