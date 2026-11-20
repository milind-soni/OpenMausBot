import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import type { Message } from "../shared/wire.ts";
import { launchVerificationServer, runControlOmb, type VerificationServer } from "./control-omb.ts";

const cliPath = process.argv[2];
assert(cliPath, "Pass the installed Pi CLI path explicitly");
const cli = resolve(cliPath);
assert(existsSync(cli), "Pi CLI must exist");
let fixture: VerificationServer | undefined;
let round = 0;
const payloads: Array<{ messages: Array<{ role: string; content?: unknown }> }> = [];
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const provider = createServer(async (req, res) => {
  if (req.url !== "/v1/chat/completions" || !fixture) { res.writeHead(404).end(); return; }
  let body = "";
  for await (const chunk of req) body += chunk;
  payloads.push(JSON.parse(body));
  const { dataDir } = fixture.info;
  const calls = [
    { name: "bash", arguments: JSON.stringify({ command: `touch ${quote(join(dataDir, "must-not-run"))}`, timeout: 90_000 }) },
    { name: "bash", arguments: JSON.stringify({ command: "echo valid-seconds", timeout: 90 }) },
    { name: "bash", arguments: JSON.stringify({ command: "echo default-timeout" }) },
    { name: "bash", arguments: JSON.stringify({
      command: `${quote(process.execPath)} -e ${quote(`require('node:fs').writeFileSync(${JSON.stringify(join(dataDir, "shell-child.pid"))}, String(process.pid)); setInterval(() => {}, 1000);`)}`,
      timeout: 0.5,
    }) },
  ];
  const toolCalls = round++ === 0;
  const delta = toolCalls
    ? { role: "assistant", tool_calls: calls.map((fn, index) => ({ index, id: `shell-fixture-${index}`, type: "function", function: fn })) }
    : { role: "assistant", content: "Shell timeout fixture finished." };
  const frame = (change: unknown, finishReason: string | null) => `data: ${JSON.stringify({
    id: "fixture", object: "chat.completion.chunk", created: 0, model: "fixture",
    choices: [{ index: 0, delta: change, finish_reason: finishReason }],
  })}\n\n`;
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(frame(delta, null) + frame({}, toolCalls ? "tool_calls" : "stop") + "data: [DONE]\n\n");
});
await new Promise<void>((done) => provider.listen(0, "127.0.0.1", done));

try {
  fixture = await launchVerificationServer({});
  const { url, dataDir } = fixture.info;
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(url + path, {
      method, headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
    });
    const result = await response.json() as any;
    assert.equal(response.status, 200, `${method} ${path}: ${JSON.stringify(result)}`);
    return result;
  };
  const control = (...args: string[]) => runControlOmb([...args, "--url", url]) as Promise<any>;
  const agentDir = join(dataDir, ".pi", "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: {
    baseUrl: `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`,
    api: "openai-completions", apiKey: "synthetic-fixture-key",
    models: [{ id: "fixture", name: "Shell timeout fixture", reasoning: false, input: ["text"], contextWindow: 131072, maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  } } }));
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "fixture", defaultThinkingLevel: "off" }));
  await api("PATCH", "/api/instances/pi", { cli });
  await api("POST", "/api/instances/pi/refresh-models", {});
  const bot = (await control("new-bot", "--name", "Shell timeout probe")).bot;
  const threadId = bot.activeTaskId ?? bot.threadId;
  await control("set-model", "--bot", bot.id, "--task", threadId, "--instance", "pi", "--model", "fixture/fixture");
  await control("send", "--bot", bot.id, "--task", threadId, "--text", "Run the disposable shell timeout fixture.");
  const wait = await control("wait", "--bot", bot.id, "--task", threadId, "--timeout", "30");
  assert.equal(wait.status, "settled", JSON.stringify(wait));
  const messages = await control("messages", "--bot", bot.id, "--task", threadId, "--limit", "20");
  const transcript = (await api("GET", `/api/threads/${threadId}/messages?limit=20`)).messages as Message[];
  const tools = transcript.flatMap((message) => message.tool ? [{ ...message.tool, args: JSON.parse(message.tool.input ?? "{}") }] : []);
  assert.equal(tools.length, 4, JSON.stringify(transcript));
  const blocked = tools.find((tool) => tool.args.timeout === 90_000);
  assert.equal(blocked?.ok, false, JSON.stringify(tools));
  assert.match(blocked.output!, /seconds.*900/);
  assert.equal(existsSync(join(dataDir, "must-not-run")), false);
  assert(tools.some((tool) => tool.ok && /valid-seconds/.test(tool.output!)));
  assert(tools.some((tool) => tool.ok && /default-timeout/.test(tool.output!)));
  const expired = tools.find((tool) => tool.args.timeout === 0.5);
  assert.equal(expired?.ok, false);
  assert.match(expired.output!, /timed out after 0.5 seconds/);
  const childPid = Number(readFileSync(join(dataDir, "shell-child.pid"), "utf8"));
  assert.throws(() => process.kill(childPid, 0), { code: "ESRCH" });
  assert(transcript.some((message) => message.text === "Shell timeout fixture finished."));
  const toolResults = payloads.slice(1).flatMap((payload) => payload.messages
    .filter((message) => message.role === "tool").map((message) => JSON.stringify(message.content)));
  assert(toolResults.some((result) => /seconds.*900/.test(result)), "Pi must receive the rejected timeout");
  assert(toolResults.some((result) => /timed out after 0.5 seconds/.test(result)), "Pi must receive the expired command result");
  const evidence = { fixture: fixture.info, cli, wait, messages, rejectedBeforeExecution: true, timedOutChildStopped: true };
  const evidenceDir = resolve(".omb-scratch/verify-evidence");
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(join(evidenceDir, "pi-shell-timeouts.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} finally {
  await fixture?.close();
  provider.closeAllConnections();
  await new Promise<void>((done) => provider.close(() => done()));
}
