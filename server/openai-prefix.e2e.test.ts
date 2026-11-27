import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { isTitleCall } from "./testing/title-call.ts";

const MCP_FIXTURE = `
import { createInterface } from 'node:readline';
createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const result = request.method === 'initialize' ? { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
    : request.method === 'tools/list' ? { tools: [{ name: 'look_up', description: 'Look a fact up', inputSchema: { type: 'object', properties: { topic: { type: 'string' } }, required: ['topic'], additionalProperties: false } }] }
    : { content: [{ type: 'text', text: 'Fact about ' + request.params.arguments.topic + ': ' + 'detail '.repeat(300) }] };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
});
`;

type ChatRequest = { messages: Array<{ role: string }>; tools?: Array<{ function: { name: string; description?: string } }> };

/** Where `next` stops repeating `previous`, or null when it starts with all of it. */
function divergence(previous: ChatRequest, next: ChatRequest): string | null {
  if (JSON.stringify(previous.tools ?? []) !== JSON.stringify(next.tools ?? [])) return "tool list changed";
  const changed = previous.messages.findIndex((message, index) => JSON.stringify(message) !== JSON.stringify(next.messages[index]));
  return changed < 0 ? null : `message ${changed} of ${previous.messages.length} changed`;
}

it("sends a bot's conversation to an OpenAI-compatible model as requests that only grow at the end, past the old 24 KB history window", async () => {
  const requests: ChatRequest[] = [];
  let answers = 0;
  const upstream = createServer(async (req, res) => {
    if (req.url === "/v1/models") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "fixture-model" }] }));
      return;
    }
    if (req.method !== "POST") { res.writeHead(404).end(); return; }
    let body = "";
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body) as ChatRequest;
    if (isTitleCall(request)) { res.writeHead(500).end(); return; }
    const frame = (delta: unknown, finish: string) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`;
    res.writeHead(200, { "content-type": "text/event-stream" });
    // Requests without tools are the harness's own side calls (summaries, suggestions), not the conversation.
    if (!request.tools?.length) { res.end(frame({ content: "ok" }, "stop")); return; }
    requests.push(request);
    const tool = request.tools.find((entry) => entry.function.description === "Look a fact up")!.function.name;
    if (request.messages.at(-1)?.role === "tool") res.end(frame({ content: `Answer ${++answers}: ${"Here is what I found. ".repeat(200)}` }, "stop"));
    else res.end(frame({ tool_calls: [{ index: 0, id: `call-${requests.length}`, type: "function", function: { name: tool, arguments: '{"topic":"cache"}' } }] }, "tool_calls"));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("fixture provider address missing");
  const fixture = await launchVerificationServer();
  const control = (args: string[]) => runControlOmb([...args, "--url", fixture.info.url]) as Promise<any>;
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method, headers: { "content-type": "application/json", origin: fixture.info.url }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json() as any;
    expect(response.ok, JSON.stringify(result)).toBe(true);
    return result;
  };
  try {
    await api("PATCH", "/api/config", { openaiCompat: { key: "synthetic-fixture-key", url: `http://127.0.0.1:${address.port}/v1`, model: "fixture-model" } });
    await api("POST", "/api/instances/openaiCompat/refresh-models", {});
    const script = join(fixture.info.dataDir, "fixture-mcp.mjs");
    writeFileSync(script, MCP_FIXTURE);
    await api("POST", "/api/mcp/servers", { name: "facts", command: process.execPath, args: [script], env: {}, enabled: true });
    await api("PATCH", "/api/mcp/servers/facts", { enabled: true });
    const { bot } = await control(["new-bot", "--name", "Prefix check"]);
    await control(["set-model", "--bot", bot.id, "--instance", "openaiCompat", "--model", "fixture-model"]);
    await api("PATCH", `/api/bots/${bot.id}`, { mcpServers: ["facts"], approvalMode: "full", soul: "Look facts up before answering." });
    const turns: number[] = [];
    for (let turn = 1; turn <= 8; turn++) {
      turns.push(requests.length);
      expect((await control(["send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", `Question ${turn}: what changed?`])).success).toBe(true);
      const settled = await control(["wait", "--bot", bot.id, "--task", bot.activeTaskId, "--timeout", "30"]);
      expect(settled.status, JSON.stringify(settled.messages?.slice(-3))).toBe("settled");
    }
    expect(requests).toHaveLength(16);
    const history = requests.at(-1)!.messages.reduce((bytes, message) => bytes + Buffer.byteLength(JSON.stringify(message)), 0);
    expect(history).toBeGreaterThan(48_000);
    const changes = requests.slice(1).flatMap((next, index) => {
      const where = divergence(requests[index]!, next);
      return where ? [`request ${index + 2} (turn ${turns.findLastIndex((start) => start <= index + 1) + 1}): ${where}`] : [];
    });
    expect(changes).toEqual([]);
  } finally {
    await fixture.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
}, 180_000);
