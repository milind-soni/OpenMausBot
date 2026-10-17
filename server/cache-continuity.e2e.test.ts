import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";

// Every advertised operation is synthetic. Only mail_send can write, and its
// destination is a fixed receipt inside the launcher's disposable data dir.
const MCP = `
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const kind = 'mail';
const schema = { type: 'object', properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } }, required: ['to', 'subject', 'body'], additionalProperties: false };
const tools = [{ name: 'mail_send', description: 'Send a synthetic email and record a receipt', inputSchema: schema }];
createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line); if (request.id === undefined) return;
  let result;
  if (request.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: kind, version: '1' } };
  else if (request.method === 'tools/list') result = { tools };
  else if (request.method === 'tools/call') {
    appendFileSync(process.env.FIXTURE_CALLS, JSON.stringify({ kind, name: request.params.name, arguments: request.params.arguments }) + '\\n');
    result = { content: [{ type: 'text', text: 'synthetic receipt for ' + request.params.name }] };
  } else result = { content: [{ type: 'text', text: 'unknown request' }], isError: true };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
});
`;

type Request = { messages: Array<{ role: string; content?: string; tool_calls?: unknown[] }>; tools?: Array<{ function: { name: string; description: string; parameters: unknown } }> };
const frame = (delta: unknown, finish: string | null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const call = (name: string, args: unknown, id: string) => frame({ tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, "tool_calls") + "data: [DONE]\n\n";
const text = (value: string) => frame({ content: value }, "stop") + "data: [DONE]\n\n";

it("preserves a direct chat prefix after a denied tool and requires fresh approval for an explicit retry", async () => {
  const requests: Request[] = [];
  const commands: unknown[] = [];
  let scenario = "plain";
  let step = 0;
  const target = "fixture-recipient@example.invalid";
  const input = { to: target, subject: "Synthetic approval", body: "No real mail leaves this fixture" };
  const provider = createServer(async (req, res) => {
    if (req.url === "/v1/models") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ data: [{ id: "fixture-model" }] })); return; }
    let raw = ""; for await (const chunk of req) raw += chunk;
    const request = JSON.parse(raw) as Request; requests.push(request);
    const send = (body: string) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.end(body); };
    if (scenario === "plain") return send(text("Plain fixture response."));
    if (scenario === "mail") {
      if (step++ === 0) return send(call("mail_mail_send", input, "mail-call"));
      return send(text("Synthetic mail flow finished."));
    }
    throw new Error(`Unexpected scenario ${scenario}`);
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address(); if (!address || typeof address === "string") throw new Error("No provider port");
  let fixture: Awaited<ReturnType<typeof launchVerificationServer>>;
  try { fixture = await launchVerificationServer(); }
  catch (error) {
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    throw error;
  }
  const control = async (args: string[]) => {
    const result = await runControlOmb([...args, "--url", fixture.info.url]) as any;
    commands.push({ command: args, result }); return result;
  };
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", origin: fixture.info.url }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json() as any;
    expect(response.ok, JSON.stringify(result)).toBe(true); return result;
  };
  const receipt = join(fixture.info.dataDir, "synthetic-calls.ndjson");
  const evidencePath = `${fixture.info.logPath}.cache-continuity.json`;
  try {
    await api("PATCH", "/api/config", { openaiCompat: { key: "synthetic-fixture-key", url: `http://127.0.0.1:${address.port}/v1`, model: "fixture-model" } });
    const script = join(fixture.info.dataDir, "synthetic-catalog.mjs"); writeFileSync(script, MCP);
    await api("POST", "/api/mcp/servers", { name: "mail", command: process.execPath, args: [script], env: { FIXTURE_CALLS: receipt }, enabled: true });
    await api("PATCH", "/api/mcp/servers/mail", { enabled: true });
    const { bot } = await control(["new-bot", "--name", "Synthetic email assistant"]);
    await control(["set-model", "--bot", bot.id, "--instance", "openaiCompat", "--model", "fixture-model"]);
    await api("PATCH", `/api/bots/${bot.id}`, { mcpServers: ["mail"], approvalMode: "ask", applyToAllThreads: true, description: "Synthetic email assistant", soul: "Use tools only when asked." });
    const memoryDir = join(fixture.info.dataDir, "workspaces", bot.id); mkdirSync(memoryDir, { recursive: true });
    writeFileSync(join(memoryDir, "MEMORY.md"), "# Memory\n- Only synthetic email tests are permitted.\n");
    const wait = () => control(["wait", "--bot", bot.id, "--task", bot.activeTaskId, "--timeout", "20"]);
    const send = (message: string) => control(["send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", message]);
    await send("Hello."); expect((await wait()).status).toBe("settled");
    const first = requests.at(-1)!;
    const offered = first.tools?.map((tool) => tool.function.name) ?? [];
    expect(offered).toContain("mail_mail_send");
    expect(existsSync(receipt)).toBe(false);
    await send("Please continue our conversation."); expect((await wait()).status).toBe("settled");
    const second = requests.at(-1)!;
    expect(second.messages.slice(0, first.messages.length)).toEqual(first.messages);
    expect(second.messages.length).toBeGreaterThan(first.messages.length);
    const memory = "Only synthetic email tests are permitted.";
    expect(JSON.stringify(second.messages).split(memory)).toHaveLength(2);
    expect(existsSync(receipt)).toBe(false);
    scenario = "mail"; step = 0;
    await send("Attempt the synthetic send-email action.");
    const pending = await wait(); expect(pending.status).toBe("needs-user");
    expect(step).toBe(1);
    expect(existsSync(receipt)).toBe(false);
    const state = await api("GET", "/api/bots");
    const current = state.bots.find((item: any) => item.id === bot.id);
    const card = current.messages.find((item: any) => item.card?.requestId && !item.card.answered)?.card;
    expect(card?.requestId).toBeTruthy();
    expect(JSON.stringify(card)).toContain(target);
    expect(JSON.stringify(card)).toContain("mail_send");
    expect(JSON.stringify(card)).toContain(input.subject);
    await api("POST", `/api/bots/${bot.id}/respond`, { threadId: bot.activeTaskId, requestId: card.requestId, behavior: "deny" });
    expect((await wait()).status).toBe("failed");
    expect(existsSync(receipt)).toBe(false);
    const denied = requests.at(-1)!;
    scenario = "plain";
    await send("Thanks. Keep the synthetic message unsent.");
    expect((await wait()).status).toBe("settled");
    const afterDenial = requests.at(-1)!;
    expect(afterDenial.messages.slice(0, denied.messages.length)).toEqual(denied.messages);
    expect(existsSync(receipt)).toBe(false);
    scenario = "mail"; step = 0;
    await send("Try that synthetic send-email action again.");
    expect((await wait()).status).toBe("needs-user");
    const state2 = await api("GET", "/api/bots");
    const card2 = state2.bots.find((item: any) => item.id === bot.id).messages.find((item: any) => item.card?.requestId && !item.card.answered)?.card;
    expect(card2?.requestId).toBeTruthy();
    expect(card2.requestId).not.toBe(card.requestId);
    await api("POST", `/api/bots/${bot.id}/respond`, { threadId: bot.activeTaskId, requestId: card2.requestId, behavior: "allow" });
    expect((await wait()).status).toBe("settled");
    const calls = readFileSync(receipt, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(calls).toEqual([{ kind: "mail", name: "mail_send", arguments: input }]);
    const messages = await control(["messages", "--bot", bot.id, "--task", bot.activeTaskId, "--limit", "30"]);
    expect(messages.messages.some((item: any) => item.tool?.name?.includes("mail_send") || item.text?.includes("Synthetic mail flow finished"))).toBe(true);
    const evidence = { fixture: fixture.info, commands, providerRequests: requests.map((request) => ({ messages: request.messages, tools: request.tools })), calls, card: { title: card.title, input: card.input }, offered };
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2), { mode: 0o600 });
    console.info(JSON.stringify({ evidencePath, logPath: fixture.info.logPath }));
  } finally {
    await fixture.close(); provider.closeAllConnections(); await new Promise<void>((resolve) => provider.close(() => resolve()));
  }
}, 120_000);
