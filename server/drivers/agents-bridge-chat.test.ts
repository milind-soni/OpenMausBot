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
    // Only a turn's POST carries a body; the Ollama probe GETs /api/version first (ollama-context.ts).
    if (request.method !== "POST") { response.writeHead(404); response.end(); return; }
    for await (const part of request) data += part.toString();
    requests.push(JSON.parse(data) as ChatRequest);
    if (requests.length === 1) calls(response, "call_guess", "agents_use_tool", { name: "schedule_task", arguments: { every: "morning" } });
    else if (requests.length === 2) calls(response, "call_search", "agents_find_tool", { query: "schedule a recurring task every morning" });
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
    env: { OMB_HARNESS_URL: "http://127.0.0.1:9", OMB_BOT_ID: "bot-chat", OMB_THREAD_ID: "thread-chat", OMB_COMMS_TOKEN: "unused", [TOOL_BRIDGE_ENV]: "1" },
  };
  const threadId = randomUUID();
  await instance.adapter.sendTurn({ threadId, text: "Schedule my morning brief.", model: "fixture-model", integrations: { agents } });
  const completed = await recorder.until((event) => event.type === "turn.completed");

  // The model was handed the bridged list.
  const handed = requests[0]!.tools!.map((tool) => tool.function.name);
  expect(handed).toEqual(expect.arrayContaining(["agents_coordinate_bots", "agents_find_tool", "agents_use_tool"]));
  expect(handed).not.toContain("agents_create_trigger");

  // The wrong guess came back as a failed call it could read...
  expect(requests[1]!.messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "call_guess" });
  expect(JSON.parse(requests[1]!.messages.at(-1)!.content as string)).toEqual({ ok: false, result: "Unknown tool: schedule_task" });
  // ...and the turn went on: the search ran and answered, and the model had its say.
  expect(requests).toHaveLength(3);
  const searched = JSON.parse(requests[2]!.messages.at(-1)!.content as string) as { ok: boolean; result: string };
  expect(searched.ok).toBe(true);
  expect((JSON.parse(searched.result) as { matches: Array<{ name: string }> }).matches[0]!.name).toBe("trigger");
  const tools = recorder.events.flatMap((event) => event.type === "item.completed" && event.itemType === "tool" ? [event.ok] : []);
  expect(tools).toEqual([false, true]);
  expect(recorder.events.some((event) => event.type === "item.completed" && event.itemType === "assistant_text" && event.text === "The tool for that is create_trigger.")).toBe(true);

  // This fixture is on this machine, so the model counts as local: having searched and answered, it is not failed for
  // its first guess, and nothing reads as a transport that broke under it.
  const errors = recorder.events.flatMap((event) => event.type === "runtime.error" ? [event.message] : []);
  expect(completed).toMatchObject({ ok: true });
  expect(errors).toEqual([]);
}, 30_000);

it("does not fail a turn that ends after a hand-off refused only because nothing was left to do", async () => {
  // One whole turn: the bot hands a message to a teammate that no longer waits on an answer, is told so, and finishes.
  const detail = "nothing of Scout's waits on an answer as a1: it was answered or its work ended. Send it without answers if it still needs doing";
  const requests: ChatRequest[] = [];
  const provider = createServer(async (request, response) => {
    if (request.url === "/v1/models") {
      response.setHeader("content-type", "application/json");
      response.end('{"data":[]}');
      return;
    }
    let data = "";
    if (request.method !== "POST") { response.writeHead(404); response.end(); return; }
    for await (const part of request) data += part.toString();
    requests.push(JSON.parse(data) as ChatRequest);
    if (requests.length === 1) calls(response, "call_handoff", "agents_coordinate_bots", { bot_ids: ["bot-scout"], message: "Thanks, looks good", answers: "a1" });
    else sse(response, { content: "Nothing is left to do for @Scout; finishing here." }, "stop");
  });
  // The harness as the proxy reaches it: this hand-off is refused for what is left to do, not for anything that broke.
  const harness = createServer(async (request, response) => {
    let data = "";
    for await (const part of request) data += part.toString();
    response.setHeader("content-type", "application/json");
    if (request.url !== "/api/internal/coordinate-bots") { response.end("{}"); return; }
    response.statusCode = 409;
    response.end(JSON.stringify({ receipts: [{ botId: "bot-scout", outcome: "failed", detail, instructionOnly: true }], error: detail, instructionOnly: true }));
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  await new Promise<void>((resolve) => harness.listen(0, "127.0.0.1", resolve));
  const providerAddress = provider.address(), harnessAddress = harness.address();
  if (!providerAddress || typeof providerAddress === "string" || !harnessAddress || typeof harnessAddress === "string") throw new Error("a fixture did not bind TCP");
  const instance = await OpenAICompatDriver.create({
    instanceId: randomUUID(), displayName: "Refusal fixture", enabled: true,
    config: { url: `http://127.0.0.1:${providerAddress.port}/v1`, apiKeyEnv: "FIXTURE_CHAT_KEY" },
    environment: { FIXTURE_CHAT_KEY: "fixture-key" },
  });
  const recorder = recordEvents(instance.adapter);
  cleanups.push(async () => {
    recorder.stop();
    await instance.dispose();
    for (const server of [provider, harness]) { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
  const agents: NonNullable<SendTurnInput["integrations"]>["agents"] = {
    command: process.execPath,
    args: [join(dirname(fileURLToPath(import.meta.url)), "agents-proxy.ts")],
    env: { OMB_HARNESS_URL: `http://127.0.0.1:${harnessAddress.port}`, OMB_BOT_ID: "bot-chat", OMB_THREAD_ID: "thread-chat", OMB_COMMS_TOKEN: "unused" },
  };
  await instance.adapter.sendTurn({ threadId: randomUUID(), text: "Answer Scout's question.", model: "fixture-model", integrations: { agents } });
  const completed = await recorder.until((event) => event.type === "turn.completed");

  // The refusal reached the model as an ordinary result it can read...
  expect(requests[1]!.messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "call_handoff" });
  expect(JSON.parse(requests[1]!.messages.at(-1)!.content as string)).toEqual({ ok: true, result: detail });
  // ...so the turn it ended on is a success, not "Stopped because the tool call ... failed".
  expect(completed).toMatchObject({ ok: true });
  expect(recorder.events.filter((event) => event.type === "runtime.error")).toEqual([]);
}, 30_000);
