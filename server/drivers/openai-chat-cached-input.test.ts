import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { ledgerCost } from "../model-prices.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { recordEvents } from "../testing/events.ts";
import { startFakeHttpMcp } from "../testing/fake-http-mcp-server.ts";
import { usageTotals } from "../usage-caps.ts";
import { appendUsage, readUsage } from "../usage-ledger.ts";
import { createTraceRecorder } from "../usage-trace/recorder.ts";
import { flushSpans } from "../usage-trace/spans.ts";
import { OpenAICompatDriver } from "./openai-compat.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const MODEL = "fixture-cached-model";
const prices = { [MODEL]: { inputPerMillion: 10, cachedInputPerMillion: 1, outputPerMillion: 20 } };
const cases = [
  { name: "JSON cache hits across rounds", stream: false, cached: [800, 400], expected: 1_200, cost: 0.0132, tokens: 1_000 },
  { name: "SSE cache hits across rounds", stream: true, cached: [800, 400], expected: 1_200, cost: 0.0132, tokens: 1_000 },
  { name: "explicit zero first reported later", stream: false, cached: [undefined, 0], expected: 0, cost: 0.024, tokens: 2_200 },
  { name: "unknown cache usage", stream: true, cached: [undefined, undefined], expected: undefined, cost: 0.024, tokens: 2_200 },
  { name: "cache hits first reported later", stream: false, cached: [undefined, 400], expected: 400, cost: 0.0204, tokens: 1_800 },
  { name: "cache usage omitted by a later round", stream: true, cached: [800, undefined], expected: 800, cost: 0.0168, tokens: 1_400 },
  { name: "negative cache usage after valid usage", stream: false, cached: [800, -100], expected: 800, cost: 0.0168, tokens: 1_400 },
  { name: "a nonnumeric cache count", stream: true, cached: ["800", undefined], expected: undefined, cost: 0.024, tokens: 2_200 },
  { name: "cache counts greater than input", stream: false, cached: [1_200, 1_200], expected: 2_400, cost: 0.006, tokens: 200 },
];

it.each(cases)("books $name through runtime events into the ledger and caps", async ({ stream, cached, expected, cost, tokens }) => {
  const dataDir = mkdtempSync(join(tmpdir(), "omb-chat-cached-input-"));
  cleanups.push(async () => { await flushSpans(dataDir); await removeTempDir(dataDir); });
  const remote = await startFakeHttpMcp({ tools: [{ name: "read_notes", inputSchema: { type: "object", properties: {} } }] });
  cleanups.push(() => remote.close());
  let rounds = 0;
  const server = createServer(async (request, response) => {
    if (request.url === "/v1/models") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: [{ id: MODEL }] }));
      return;
    }
    if (request.url !== "/v1/chat/completions" || request.method !== "POST") { response.writeHead(404); response.end(); return; }
    for await (const _part of request) {}
    const round = rounds++, last = round > 0;
    const usage = { prompt_tokens: 1_000, completion_tokens: 100,
      ...(cached[round] === undefined ? {} : { prompt_tokens_details: { cached_tokens: cached[round] } }) };
    const message = last ? { role: "assistant", content: "The notes are ready." } : {
      role: "assistant", content: null,
      tool_calls: [{ id: "read-1", type: "function", function: { name: "notes_read_notes", arguments: "{}" } }],
    };
    const finish_reason = last ? "stop" : "tool_calls";
    response.setHeader("content-type", stream ? "text/event-stream" : "application/json");
    if (!stream) response.end(JSON.stringify({ choices: [{ index: 0, message, finish_reason }], usage }));
    else {
      const delta = last ? { content: message.content } : { tool_calls: message.tool_calls!.map((call, index) => ({ ...call, index })) };
      response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\ndata: ${JSON.stringify({ choices: [], usage })}\n\ndata: [DONE]\n\n`);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture did not bind TCP");
  const instance = await OpenAICompatDriver.create({ instanceId: randomUUID(), displayName: "Cache fixture", enabled: true,
    config: { url: `http://127.0.0.1:${address.port}/v1`, model: MODEL, apiKeyEnv: "FIXTURE_CHAT_KEY" }, environment: { FIXTURE_CHAT_KEY: "fixture-chat-key" } });
  cleanups.push(() => instance.dispose());
  const events = recordEvents(instance.adapter), trace = createTraceRecorder({ dataDir });
  const threadId = randomUUID(), unobserve = instance.adapter.onEvent(trace.observe);
  cleanups.push(() => { events.stop(); unobserve(); trace.settle(threadId); });
  await instance.adapter.sendTurn({ threadId, model: MODEL, text: "Read my notes.", approvalMode: "full",
    integrations: { custom: { notes: { type: "http", url: remote.url, headers: {} } } } });
  const completed = await events.until((event) => event.type === "turn.completed");
  expect(completed).toMatchObject({ ok: true });
  if (completed.type !== "turn.completed" || !completed.usage) throw new Error("turn did not report usage");
  expect(rounds).toBe(2);
  expect(remote.calls).toHaveLength(1);

  const now = new Date();
  const row = { at: now.toISOString(), botId: "bot", botName: "Bot", threadId, instanceId: instance.instanceId,
    driverKind: "openai-compat", model: MODEL, ...completed.usage, costUsd: null, trigger: { kind: "owner" as const } };
  const priced = { ...row, ...ledgerCost(row, prices), ...trace.settle(threadId) };
  expect(await appendUsage(dataDir, priced)).toBe(true);
  const booked = readUsage(dataDir, { from: new Date(now.getTime() - 1), to: new Date(now.getTime() + 1) });
  expect(booked).toHaveLength(1);
  expect(booked[0]!.costUsd).toBeCloseTo(cost, 10);
  expect(booked[0]).toMatchObject({ input: 2_000, output: 200, usageStatus: expected === undefined ? "partial" : "complete" });
  if (expected === undefined) expect(booked[0]).not.toHaveProperty("cachedInput");
  else expect(booked[0]!.cachedInput).toBe(expected);
  expect(usageTotals(dataDir, now).server.day).toEqual({ usd: cost, tokens });
  const updates = events.events.filter((event) => event.type === "thread.token-usage.updated");
  expect(updates).toHaveLength(2);
  expect(updates.at(-1)).toMatchObject({ input: 2_000, output: 200, contextTokens: 1_100 });
  if (expected === undefined) expect(updates.at(-1)).not.toHaveProperty("cachedInput");
  else expect(updates.at(-1)).toHaveProperty("cachedInput", expected);
});
