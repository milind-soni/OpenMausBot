import { createServer } from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";

// The fixture can only append to one fixed file in the launcher's disposable home: provider arguments cannot select a path.
const MCP_FIXTURE = `
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const result = request.method === 'initialize' ? { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
    : request.method === 'tools/list' ? { tools: [{ name: 'write', description: 'Write the level fixture artifact', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] }
    : request.method === 'tools/call' ? (appendFileSync(process.env.FIXTURE_ARTIFACT, 'write\\n'), { content: [{ type: 'text', text: 'written' }] })
    : {};
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
});
`;

type Case = { name: string; from: "ask" | "full"; to: "ask" | "full"; scope: "thread" | "bot"; card: boolean };
const CASES: Case[] = [
  { name: "raise", from: "ask", to: "full", scope: "thread", card: false },
  { name: "lower", from: "full", to: "ask", scope: "thread", card: true },
  { name: "raise-everywhere", from: "ask", to: "full", scope: "bot", card: false },
  { name: "lower-everywhere", from: "full", to: "ask", scope: "bot", card: true },
];

it("applies a level picked while the bot is working to its next tool call, and leaves the person's card to answer", async () => {
  let release: (() => void) | undefined;
  let held = false;
  const upstream = createServer(async (req, res) => {
    if (req.url === "/v1/models") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "fixture-model" }] }));
      return;
    }
    // Only chat completions carry a body; anything else the server asks the endpoint (its context window, say) is not
    // this fixture's to answer.
    if (req.method !== "POST") { res.statusCode = 404; res.end(); return; }
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text) as { messages: Array<{ role: string }>; tools?: Array<{ function: { name: string; description?: string } }> };
    const first = !body.messages.some((message) => message.role === "tool");
    if (first) await new Promise<void>((resolve) => { release = resolve; held = true; });
    const name = body.tools?.find((tool) => tool.function.description?.includes("level fixture artifact"))?.function.name;
    const delta = first ? { tool_calls: [{ index: 0, id: "write-1", type: "function", function: { name, arguments: "{}" } }] } : { content: "Fixture finished." };
    res.setHeader("content-type", "text/event-stream");
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: first ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("fixture provider address missing");
  const fixture = await launchVerificationServer();
  const { url, dataDir } = fixture.info;
  const control = (args: string[]) => runControlOmb([...args, "--url", url]) as Promise<any>;
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(url + path, { method, headers: { origin: url, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json() as any;
    expect(response.status, `${method} ${path} ${JSON.stringify(value)}`).toBeLessThan(300);
    return value;
  };
  try {
    await api("PATCH", "/api/config", { openaiCompat: { key: "synthetic-fixture-key", url: `http://127.0.0.1:${address.port}/v1`, model: "fixture-model" } });
    await api("POST", "/api/instances/openaiCompat/refresh-models", {});
    const script = join(dataDir, "level-mcp.mjs");
    writeFileSync(script, MCP_FIXTURE);
    for (const c of CASES) {
      held = false;
      const artifact = join(dataDir, `${c.name}-artifact.txt`);
      await api("POST", "/api/mcp/servers", { name: c.name, command: process.execPath, args: [script], env: { FIXTURE_ARTIFACT: artifact }, enabled: true });
      await api("PATCH", `/api/mcp/servers/${c.name}`, { enabled: true });
      const { bot } = await control(["new-bot", "--name", `Level ${c.name}`]);
      await control(["set-model", "--bot", bot.id, "--instance", "openaiCompat", "--model", "fixture-model"]);
      await api("PATCH", `/api/bots/${bot.id}`, { mcpServers: [c.name], approvalMode: c.from, applyToAllThreads: true });
      expect((await control(["send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", "Run the fixture write."])).success).toBe(true);
      await expect.poll(() => held, { timeout: 15_000 }).toBe(true);
      await api("PATCH", c.scope === "thread" ? `/api/bots/${bot.id}/tasks/${bot.activeTaskId}` : `/api/bots/${bot.id}`,
        { approvalMode: c.to, ...(c.scope === "bot" ? { applyToAllThreads: true } : {}) });
      const saved = (await api("GET", "/api/bots?messages=0")).bots.find((row: { id: string }) => row.id === bot.id);
      expect(saved.tasks.find((task: { threadId: string }) => task.threadId === bot.activeTaskId), c.name).toMatchObject({ approvalMode: c.to, busy: true });
      release!();
      let settled = await control(["wait", "--bot", bot.id, "--task", bot.activeTaskId, "--timeout", "20"]);
      if (c.card) {
        expect(settled.status, c.name).toBe("needs-user");
        expect(existsSync(artifact), c.name).toBe(false);
        const messages = (await api("GET", "/api/bots")).bots.find((row: { id: string }) => row.id === bot.id).messages;
        const card = messages.find((message: { card?: { requestId?: string; answered?: unknown } }) => message.card?.requestId && !message.card.answered)?.card;
        expect(card?.requestId, c.name).toBeTruthy();
        await api("POST", `/api/bots/${bot.id}/respond`, { threadId: bot.activeTaskId, requestId: card.requestId, behavior: "deny" });
        settled = await control(["wait", "--bot", bot.id, "--task", bot.activeTaskId, "--timeout", "20"]);
        expect(existsSync(artifact), c.name).toBe(false);
      } else {
        expect(settled.status, c.name).toBe("settled");
        expect(readFileSync(artifact, "utf8"), c.name).toBe("write\n");
      }
    }
  } finally {
    release?.();
    await fixture.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
}, 120_000);
