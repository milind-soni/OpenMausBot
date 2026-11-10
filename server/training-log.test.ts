import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { SendTurnInput } from "./contracts.ts";
import { OpenAICompatDriver } from "./drivers/openai-compat.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { recordEvents } from "./testing/events.ts";
import { TRAINING_LIMITS, TrainingLog, trainingLog, type TrainingRow, type TrainingStepRow } from "./training-log.ts";

const TOKEN = `ghp_${"a".repeat(36)}`;
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), "omb-training-"));
  cleanups.push(() => removeTempDir(dir));
  return dir;
}

const rowsIn = (dir: string): TrainingRow[] => readdirSync(dir).filter((name) => name.endsWith(".jsonl")).sort()
  .flatMap((name) => readFileSync(join(dir, name), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as TrainingRow));

const info = (turnId: string) => ({ threadId: "t1", botId: "b1", turnId, round: 0, model: "m", driverKind: "openai-compat", local: true, safeText: (text: string) => text.split("sk-held-key").join("[redacted]") });

describe("the training log", () => {
  it("keeps nothing, and copies nothing, while off", () => {
    const dir = folder();
    const log = new TrainingLog();
    log.configure({ dir, mode: () => "off" });
    expect(log.capture([{ role: "user", content: "hi" }], [])).toBeNull();
    log.step({ messages: [], tools: [] }, info("turn1"), { text: "hello", toolCalls: [] });
    expect(readdirSync(dir)).toEqual([]);
  });

  it("keeps the request as it was sent, the answer and the turn's outcome, with secrets and images taken out", () => {
    const dir = folder();
    const log = new TrainingLog();
    log.configure({ dir, mode: () => "local", now: () => Date.UTC(2026, 10, 9, 12) });
    const messages: Array<Record<string, unknown>> = [
      { role: "system", content: "You are MausBot." },
      { role: "user", content: [{ type: "text", text: `my token is ${TOKEN}` }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] },
    ];
    const request = log.capture(messages, [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }]);
    messages.push({ role: "assistant", content: "changed after the request" });
    log.step(request, info("turn1"), { text: "", toolCalls: [{ id: "c1", function: { name: "read_file", arguments: '{"path":"a","key":"sk-held-key"}' } }], finishReason: "tool_calls" });
    log.outcome({ threadId: "t1", turnId: "turn1", ok: true, stopReason: null });
    log.outcome({ threadId: "t1", turnId: "never-recorded", ok: true });
    const rows = rowsIn(dir);
    expect(rows.map((row) => row.kind)).toEqual(["step", "outcome"]);
    const step = rows[0] as TrainingStepRow;
    expect(step.messages).toEqual([{ role: "system", content: "You are MausBot." }, { role: "user", content: expect.stringContaining("[image]") }]);
    expect(step.completion.tool_calls).toEqual([{ id: "c1", type: "function", function: { name: "read_file", arguments: expect.any(String) } }]);
    expect(step.tools).toHaveLength(1);
    const text = JSON.stringify(rows);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("sk-held-key");
    expect(text).not.toContain("base64,AAAA");
    expect(statSync(join(dir, "2026-11-09.jsonl")).mode & 0o777).toBe(0o600);
    expect(log.summary()).toMatchObject({ mode: "local", steps: 1, turns: 1, days: 1 });
  });

  it("drops days past 30, then the oldest past the folder's cap, and deletes everything on request", () => {
    const dir = folder();
    let now = Date.UTC(2026, 10, 9);
    const log = new TrainingLog();
    log.configure({ dir, mode: () => "local", now: () => now });
    writeFileSync(join(dir, "2026-09-01.jsonl"), "{}\n");
    writeFileSync(join(dir, "2026-11-08.jsonl"), "{}\n");
    log.sweep();
    expect(log.days()).toEqual(["2026-11-08.jsonl"]);
    log.step(log.capture([{ role: "user", content: "x".repeat(TRAINING_LIMITS.rowBytes + 1) }], []), info("big"), { text: "", toolCalls: [] });
    expect(log.days()).toEqual(["2026-11-08.jsonl"]);
    now += 1;
    log.clear();
    expect(log.days()).toEqual([]);
  });
});

describe("a chat engine's turn while training data is kept", () => {
  const MCP = `
import { createInterface } from "node:readline";
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") reply(request.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } });
  else if (request.method === "tools/list") reply(request.id, { tools: [{ name: "write", description: "Store a name", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } }] });
  else if (request.method === "tools/call") reply(request.id, { content: [{ type: "text", text: "Stored " + request.params.arguments.name }] });
  else if (request.id !== undefined) reply(request.id, {});
});`;

  function sse(response: ServerResponse, chunks: unknown[]) {
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const value of chunks) response.write(`data: ${JSON.stringify(value)}\n\n`);
    response.end("data: [DONE]\n\n");
  }
  const chunk = (delta: unknown, finishReason: string | null = null) => ({ choices: [{ index: 0, delta, finish_reason: finishReason }] });

  async function turn(mode: "off" | "local") {
    const dir = folder();
    trainingLog.configure({ dir: join(dir, "training"), mode: () => mode });
    cleanups.push(() => trainingLog.configure({ dir: join(dir, "training"), mode: () => "off" }));
    let round = 0;
    const server = createServer(async (request, response) => {
      if (request.method !== "POST") { response.setHeader("content-type", "application/json"); response.end('{"data":[]}'); return; }
      for await (const _part of request) { /* the body is what the log keeps; the fixture only answers */ }
      if (++round === 1) sse(response, [chunk({ tool_calls: [{ index: 0, id: "call1", type: "function", function: { name: "audit_write", arguments: '{"name":"receipt"}' } }] }, "tool_calls")]);
      else sse(response, [chunk({ content: "Stored it." }), chunk({}, "stop")]);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture did not bind");
    writeFileSync(join(dir, "mcp.mjs"), MCP);
    const instance = await OpenAICompatDriver.create({
      instanceId: randomUUID(), displayName: "Fixture", enabled: true,
      config: { url: `http://127.0.0.1:${address.port}/v1`, apiKeyEnv: "FIXTURE_CHAT_KEY" }, environment: { FIXTURE_CHAT_KEY: "fixture-key" },
    });
    const events = recordEvents(instance.adapter);
    cleanups.push(async () => { events.stop(); await instance.dispose(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
    const integrations: SendTurnInput["integrations"] = { custom: { audit: { command: process.execPath, args: [join(dir, "mcp.mjs")], env: {} } } };
    await instance.adapter.sendTurn({ threadId: "thread-1", botId: "bot-1", text: "Store the receipt.", model: "fixture-model", integrations, approvalMode: "full" });
    const completed = await events.until((event) => event.type === "turn.completed");
    // index.ts hands every turn.completed to the log, as the bus does there.
    if (completed.type === "turn.completed") trainingLog.outcome({ threadId: completed.threadId, turnId: completed.turnId, ok: completed.ok, stopReason: completed.stopReason });
    return trainingLog.days().flatMap((day) => trainingLog.rows(day));
  }

  it("keeps each step: the call the model made, then the tool's result and the answer, then the outcome", async () => {
    const rows = await turn("local");
    expect(rows.map((row) => row.kind)).toEqual(["step", "step", "outcome"]);
    const [first, second] = rows as TrainingStepRow[];
    expect(first!.messages.at(-1)).toMatchObject({ role: "user", content: "Store the receipt." });
    expect(first!.tools.map((tool) => (tool as { function: { name: string } }).function.name)).toContain("audit_write");
    expect(first!.completion.tool_calls?.[0]).toMatchObject({ function: { name: "audit_write", arguments: '{"name":"receipt"}' } });
    expect(second!.messages).toContainEqual(expect.objectContaining({ role: "tool", tool_call_id: "call1" }));
    expect(second!.completion.content).toBe("Stored it.");
    expect(rows[2]).toMatchObject({ kind: "outcome", ok: true, turnId: first!.turnId });
    expect(JSON.stringify(rows)).not.toContain("fixture-key");
  });

  it("keeps nothing while off", async () => {
    expect(await turn("off")).toEqual([]);
  });
});
