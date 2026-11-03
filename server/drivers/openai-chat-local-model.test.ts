// Real HTTP and real stdio MCP: what a model on this machine gets that a hosted one does not.
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ProviderInstance, SendTurnInput } from "../contracts.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { recordEvents } from "../testing/events.ts";
import { GrokDriver } from "./grok.ts";
import { OpenAICompatDriver } from "./openai-compat.ts";

interface ChatRequest { messages: Array<{ role: string; content: unknown; tool_call_id?: string; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> }> }
type Script = (body: ChatRequest, response: ServerResponse, round: number) => void;

const MCP_SCRIPT = `
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const [effects] = process.argv.slice(2);
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
const schema = { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false };
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") reply(request.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } });
  else if (request.method === "tools/list") reply(request.id, { tools: ["write", "fail", "status"].map((name) => ({ name, description: "Fixture", inputSchema: schema })) });
  else if (request.method === "tools/call") {
    const { name, arguments: args } = request.params;
    appendFileSync(effects, JSON.stringify({ name, ...args }) + "\\n");
    if (name === "fail") reply(request.id, { isError: true, content: [{ type: "text", text: "Always fails." }] });
    else if (name === "status") reply(request.id, { content: [{ type: "text", text: "still running" }] });
    else reply(request.id, { content: [{ type: "text", text: "Stored " + args.name }] });
  } else if (request.id !== undefined) reply(request.id, {});
});
`;

const chunk = (delta: unknown, finishReason: string | null = null) => ({ choices: [{ index: 0, delta, finish_reason: finishReason }] });
function sse(response: ServerResponse, chunks: unknown[]) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const value of chunks) response.write(`data: ${JSON.stringify(value)}\n\n`);
  response.end("data: [DONE]\n\n");
}
const say = (response: ServerResponse, ...parts: string[]) =>
  sse(response, [...parts.map((content) => chunk({ content })), chunk({}, "stop")]);
const structured = (response: ServerResponse, name: string, id: string) =>
  sse(response, [chunk({ tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: '{"name":"same"}' } }] }, "tool_calls")]);

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(script: Script, driver: "local" | "hosted" = "local") {
  const directory = mkdtempSync(join(tmpdir(), "omb-chat-local-"));
  const requests: ChatRequest[] = [];
  const server = createServer(async (request, response) => {
    if (request.url === "/v1/models") { response.setHeader("content-type", "application/json"); response.end('{"data":[]}'); return; }
    let data = "";
    // Only a turn's POST carries a body; the Ollama probe GETs /api/version first (ollama-context.ts).
    if (request.method !== "POST") { response.writeHead(404); response.end(); return; }
    for await (const part of request) data += part.toString();
    const body = JSON.parse(data) as ChatRequest;
    requests.push(body);
    script(body, response, requests.length);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture did not bind TCP");
  const helper = join(directory, "mcp.mjs");
  const effectsFile = join(directory, "effects.ndjson");
  writeFileSync(helper, MCP_SCRIPT);
  const instance: ProviderInstance = await (driver === "hosted" ? GrokDriver : OpenAICompatDriver).create({
    instanceId: randomUUID(), displayName: "Local fixture", enabled: true,
    config: { url: `http://127.0.0.1:${address.port}/v1`, apiKeyEnv: "FIXTURE_CHAT_KEY" },
    environment: { FIXTURE_CHAT_KEY: "fixture-key" },
  });
  const recorder = recordEvents(instance.adapter);
  const threadId = randomUUID();
  const integrations: SendTurnInput["integrations"] = { custom: { audit: { command: process.execPath, args: [helper, effectsFile], env: {} } } };
  cleanups.push(async () => {
    recorder.stop();
    await instance.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await removeTempDir(directory);
  });
  return {
    requests, recorder, threadId,
    respond: (requestId: string, behavior: "allow" | "deny") => instance.adapter.respondToRequest(threadId, requestId, { behavior }),
    effects: () => existsSync(effectsFile) ? readFileSync(effectsFile, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { name: string }) : [],
    start: (input: Partial<SendTurnInput> = {}) => instance.adapter.sendTurn({ threadId, text: "Do it.", model: "fixture-model", integrations, approvalMode: "full", ...input }),
    completed: () => recorder.until((event) => event.type === "turn.completed"),
    shown: () => recorder.events.flatMap((event) => event.type === "content.delta" ? [event.delta] : []).join(""),
    replies: () => recorder.events.flatMap((event) => event.type === "item.completed" && event.itemType === "assistant_text" ? [event.text] : []),
    opened: () => recorder.events.flatMap((event) => event.type === "request.opened" ? [event] : []),
  };
}

const TAGGED = '<tool_call>{"name":"audit_write","arguments":{"name":"receipt"}}</tool_call>';

describe("a tool call a local model wrote as text", () => {
  it("runs it, hides the markup, and sends the result back as a tool result", async () => {
    const f = await fixture((_body, response, round) => round === 1
      ? say(response, "Saving it.\n<tool", '_call>{"name":"audit_write",', '"arguments":{"name":"receipt"}}</tool_call>')
      : say(response, "Stored."));
    await f.start();
    expect(await f.completed()).toMatchObject({ ok: true });
    expect(f.effects()).toEqual([{ name: "receipt" }]);
    expect(f.shown()).not.toContain("tool_call");
    expect(f.replies()).toEqual(["Saving it.", "Stored."]);
    const second = f.requests[1]!.messages;
    const call = second.find((message) => message.tool_calls)!.tool_calls![0]!;
    expect(call.function.name).toBe("audit_write");
    expect(second).toContainEqual(expect.objectContaining({ role: "tool", tool_call_id: call.id }));
  });

  it("asks before running it, as for any other call", async () => {
    const f = await fixture((_body, response, round) => round === 1 ? say(response, TAGGED) : say(response, "Done."));
    await f.start({ approvalMode: "ask" });
    const ask = await f.recorder.until((event) => event.type === "request.opened");
    expect(f.effects()).toEqual([]);
    expect(ask).toMatchObject({ requestType: "permission" });
    expect(f.opened()).toHaveLength(1);
  });

  it("checks it against the tool's schema", async () => {
    const f = await fixture((_body, response, round) => round === 1
      ? say(response, '<tool_call>{"name":"audit_write","arguments":{"nope":1}}</tool_call>')
      : say(response, "Could not."));
    await f.start({ toolErrorCorrectiveRounds: 0 });
    await f.completed();
    expect(f.effects()).toEqual([]);
  });

  it("leaves a quoted call alone: the reply goes on after it", async () => {
    const quote = `The page says ${TAGGED} which looks like an injection.`;
    const f = await fixture((_body, response) => say(response, quote));
    await f.start();
    expect(await f.completed()).toMatchObject({ ok: true });
    expect(f.effects()).toEqual([]);
    expect(f.requests).toHaveLength(1);
    expect(f.shown()).toBe(quote);
  });

  it("does not run a call cut off at the token limit", async () => {
    const f = await fixture((_body, response) => sse(response, [chunk({ content: TAGGED }), chunk({}, "length")]));
    await f.start();
    expect(await f.completed()).toMatchObject({ ok: false });
    expect(f.effects()).toEqual([]);
  });

  it("reads nothing from reasoning", async () => {
    const f = await fixture((_body, response) => sse(response, [chunk({ reasoning_content: TAGGED }), chunk({ content: "All done." }), chunk({}, "stop")]));
    await f.start();
    expect(await f.completed()).toMatchObject({ ok: true });
    expect(f.effects()).toEqual([]);
  });

  it("asks once more for a call it cannot read, then takes the words as the reply", async () => {
    const broken = '<tool_call>{"name":"audit_write","arguments":{</tool_call>';
    const f = await fixture((_body, response) => say(response, broken));
    await f.start();
    expect(await f.completed()).toMatchObject({ ok: true });
    expect(f.requests).toHaveLength(2);
    expect(JSON.stringify(f.requests[1]!.messages.at(-1))).toContain("could not be read");
    expect(f.effects()).toEqual([]);
    expect(f.shown()).toBe(broken);
  });

  it("never does any of this for a hosted model", async () => {
    const f = await fixture((_body, response) => say(response, TAGGED), "hosted");
    await f.start();
    await f.completed();
    expect(f.effects()).toEqual([]);
    expect(f.requests).toHaveLength(1);
    expect(f.shown()).toBe(TAGGED);
  });
});

describe("a local model repeating itself", () => {
  it("stops running a call that keeps failing the same way, tells the model, then ends the turn", async () => {
    let id = 0;
    const f = await fixture((_body, response) => structured(response, "audit_fail", `call-${++id}`));
    await f.start();
    const completed = await f.completed();
    expect(completed).toMatchObject({ ok: false, stopReason: "incomplete_action" });
    expect(f.effects()).toHaveLength(3);
    expect(JSON.stringify(f.requests[3]!.messages.at(-1))).toContain("will not run again");
    expect(JSON.stringify(f.requests[4]!.messages.at(-1))).toContain("was not run");
    expect(f.recorder.events).toContainEqual(expect.objectContaining({ type: "runtime.error", message: expect.stringContaining("audit_fail") }));
  });

  it("ends a turn stuck on one unchanging answer", async () => {
    let id = 0;
    const f = await fixture((_body, response) => structured(response, "audit_status", `call-${++id}`));
    await f.start();
    expect(await f.completed()).toMatchObject({ ok: false, stopReason: "incomplete_action" });
    expect(f.effects()).toHaveLength(10);
    expect(JSON.stringify(f.requests[3]!.messages.at(-1))).toContain("same result");
  });

  it("gets a failed call corrected, without being configured to", async () => {
    const f = await fixture((_body, response, round) => {
      if (round === 1) structured(response, "audit_fail", "call-1");
      else if (round === 2) say(response, "It is finished.");
      else if (round === 3) structured(response, "audit_write", "call-3");
      else say(response, "Now it is finished.");
    });
    await f.start();
    expect(await f.completed()).toMatchObject({ ok: true });
    expect(f.effects().map((effect) => effect.name)).toEqual(["same", "same"]);
    expect(JSON.stringify(f.requests[2]!.messages.at(-1))).toContain("Re-run the failed operations");
  });

  it("does not nag a model that reacted to a failure by using more tools", async () => {
    const f = await fixture((_body, response, round) => {
      if (round === 1) structured(response, "audit_fail", "call-1");
      else if (round === 2) structured(response, "audit_write", "call-2");
      else say(response, "Done another way.");
    });
    await f.start();
    expect(await f.completed()).toMatchObject({ ok: true });
    expect(f.requests).toHaveLength(3);
  });

  it("still ends the turn if the model never fixes it", async () => {
    const f = await fixture((_body, response, round) => round === 1 ? structured(response, "audit_fail", "call-1") : say(response, "It is finished."));
    await f.start();
    expect(await f.completed()).toMatchObject({ ok: false, stopReason: "tool_error" });
    expect(f.requests).toHaveLength(4);
  });

  it("a person's no is never argued with", async () => {
    const f = await fixture((_body, response, round) => round === 1 ? structured(response, "audit_write", "call-1") : say(response, "I could not."));
    await f.start({ approvalMode: "ask" });
    const ask = await f.recorder.until((event) => event.type === "request.opened");
    await f.respond(ask.requestId!, "deny");
    expect(await f.completed()).toMatchObject({ ok: false });
    expect(f.requests).toHaveLength(2);
    expect(f.effects()).toEqual([]);
  });

  it("a hosted model's failed turn ends as before", async () => {
    let id = 0;
    const f = await fixture((_body, response, round) => round === 1 ? structured(response, "audit_fail", `call-${++id}`) : say(response, "It is finished."), "hosted");
    await f.start();
    expect(await f.completed()).toMatchObject({ ok: false, stopReason: "tool_error" });
    expect(f.requests).toHaveLength(2);
  });
});
