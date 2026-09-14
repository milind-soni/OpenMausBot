import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";

// The fixture can only write one fixed file, provided by the test inside the
// launcher's disposable home. Provider-supplied arguments cannot select a path.
const MCP_FIXTURE = `
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
if (process.env.FIXTURE_STARTED) writeFileSync(process.env.FIXTURE_STARTED, 'started');
const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result;
  if (request.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } };
  else if (request.method === 'tools/list') result = { tools: [{ name: 'write_file', description: 'Write the disposable verification artifact', inputSchema: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'], additionalProperties: false } }] };
  else if (request.method === 'tools/call' && request.params.name === 'write_file') {
    writeFileSync(process.env.FIXTURE_ARTIFACT, request.params.arguments.content);
    result = { content: [{ type: 'text', text: 'created verification artifact' }] };
  } else result = { content: [{ type: 'text', text: 'Unknown fixture operation' }], isError: true };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
});
`;

type ChatMessage = { role: string; content?: string; tool_call_id?: string; tool_calls?: Array<{ id: string }> };
type ChatRequest = {
  messages: ChatMessage[];
  tools?: Array<{ function: { name: string; description?: string } }>;
};

it("runs structured MCP calls through real harness approval and continuation, preserving text and cancellation", async () => {
  const requests: ChatRequest[] = [];
  let scenario = "allow";
  const upstream = createServer(async (req, res) => {
    if (req.url === "/v1/models") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "fixture-model" }] }));
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body) as ChatRequest;
    requests.push(request);
    if (scenario === "tools-off" && "tools" in request) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "This fixture model supports text only." } }));
      return;
    }
    const toolResult = request.messages.find((message) => message.role === "tool");
    const name = request.tools?.find((tool) => tool.function.description?.includes("disposable verification artifact"))?.function.name;
    const call = { index: 0, id: "fixture-call", type: "function", function: { name: name ?? "fixture_write_file", arguments: '{"content":"verified"}' } };
    const frame = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (toolResult) {
      res.end(frame({ content: scenario === "allow" ? "The artifact was created." : "The operation was denied." }, "stop") + "data: [DONE]\n\n");
    } else if (scenario === "text" || scenario === "ordinary" || scenario === "tools-off") {
      res.end(frame({ content: scenario === "text" ? JSON.stringify(call) : "Hello from the fixture." }, "stop") + "data: [DONE]\n\n");
    } else {
      // Arguments arrive across events, and are only valid JSON when joined.
      res.write(frame({ tool_calls: [{ ...call, function: { name: call.function.name, arguments: '{"content":' } }] }, null));
      res.end(frame({ tool_calls: [{ index: 0, function: { arguments: '"verified"}' } }] }, "tool_calls") + "data: [DONE]\n\n");
    }
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("fixture provider address missing");
  const fixture = await launchVerificationServer().catch(async (error) => {
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    throw error;
  });
  const evidence: unknown[] = [{ fixture: fixture.info }];
  const control = async (args: string[]) => {
    const result = await runControlOmb([...args, "--url", fixture.info.url]) as any;
    evidence.push({ command: args, result });
    return result;
  };
  const api = async (method: string, path: string, body?: unknown, expectedStatus?: number) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method, headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json() as any;
    if (expectedStatus !== undefined) expect(response.status, JSON.stringify(result)).toBe(expectedStatus);
    else expect(response.ok, JSON.stringify(result)).toBe(true);
    return result;
  };
  try {
    await api("PATCH", "/api/config", { openaiCompat: { key: "synthetic-fixture-key", url: `http://127.0.0.1:${address.port}/v1`, model: "fixture-model" } });
    const mcpScript = join(fixture.info.dataDir, "fixture-mcp.mjs");
    writeFileSync(mcpScript, MCP_FIXTURE);
    for (const mode of ["allow", "deny", "cancel", "text", "ordinary", "tools-off"]) {
      scenario = mode;
      const artifact = join(fixture.info.dataDir, `${mode}-artifact.txt`);
      const startupMarker = join(fixture.info.dataDir, `${mode}-mcp-started.txt`);
      await api("POST", "/api/mcp/servers", { name: mode, command: process.execPath, args: [mcpScript], env: { FIXTURE_ARTIFACT: artifact, FIXTURE_STARTED: startupMarker }, enabled: true });
      if (mode === "tools-off") {
        await api("PATCH", "/api/instances/openaiCompat", { tools: "false" }, 400);
        await api("PATCH", "/api/instances/claude", { tools: false }, 400);
        const changed = await api("PATCH", "/api/instances/openaiCompat", { tools: false });
        const instance = changed.instances.find((item: any) => item.instanceId === "openaiCompat");
        expect(instance.capabilities).toMatchObject({ agentsMcp: false, composioMcp: false });
      }
      await api("PATCH", `/api/mcp/servers/${mode}`, { enabled: true });
      const { bot } = await control(["new-bot", "--name", `API tool ${mode}`]);
      await control(["set-model", "--bot", bot.id, "--instance", "openaiCompat", "--model", "fixture-model"]);
      await api("PATCH", `/api/bots/${bot.id}`, { mcpServers: [mode], description: "Verification assistant", soul: "Use structured tools when an operation is requested." });
      const memoryDirectory = join(fixture.info.dataDir, "workspaces", bot.id);
      mkdirSync(memoryDirectory, { recursive: true });
      writeFileSync(join(memoryDirectory, "MEMORY.md"), "# Memory\n- Fixture prefers concise replies.\n");
      const before = requests.length;
      expect((await control(["send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", "Write the verification artifact if a structured tool is requested."])).success).toBe(true);
      const wait = () => control(["wait", "--bot", bot.id, "--task", bot.activeTaskId, "--timeout", "20"]);
      let settled = await wait();
      if (["allow", "deny", "cancel"].includes(mode)) {
        expect(settled.status, JSON.stringify({ tools: requests[before]?.tools?.map((tool) => tool.function.name), messages: settled.messages })).toBe("needs-user");
        expect(existsSync(artifact)).toBe(false);
        expect(requests).toHaveLength(before + 1);
        const state = await api("GET", "/api/bots");
        const current = state.bots.find((item: any) => item.id === bot.id);
        const card = current.messages.find((message: any) => message.card?.requestId && !message.card.answered)?.card;
        expect(card?.requestId).toBeTruthy();
        if (mode === "cancel") await control(["interrupt", "--bot", bot.id, "--task", bot.activeTaskId]);
        else await api("POST", `/api/bots/${bot.id}/respond`, { threadId: bot.activeTaskId, requestId: card.requestId, behavior: mode });
        settled = await wait();
      }
      const messages = await control(["messages", "--bot", bot.id, "--task", bot.activeTaskId, "--limit", "20"]);
      const system = requests[before]!.messages.find((message) => message.role === "system")?.content ?? "";
      expect(system).toContain("Fixture prefers concise replies.");
      expect(system).not.toContain("update it with your file tools");
      expect(system).not.toContain("File locations for this bot");
      expect(system).not.toContain("read its exact SKILL.md path above with your file tools");
      if (mode === "allow" || mode === "deny") {
        expect(requests).toHaveLength(before + 2);
        const continued = requests[before + 1]!;
        const result = continued.messages.find((message) => message.role === "tool");
        expect(result?.tool_call_id).toBe("fixture-call");
        expect(continued.messages.some((message) => message.role === "assistant" && message.tool_calls?.some((call) => call.id === result?.tool_call_id))).toBe(true);
        if (mode === "allow") {
          expect(settled.status).toBe("settled");
          expect(readFileSync(artifact, "utf8")).toBe("verified");
          expect(result?.content).toContain("created verification artifact");
          expect(messages.messages.some((message: any) => message.text?.includes("The artifact was created."))).toBe(true);
        } else {
          expect(settled.status).toBe("failed");
          expect(result?.content).toMatch(/denied/i);
          expect(existsSync(artifact)).toBe(false);
        }
      } else {
        expect(requests).toHaveLength(before + 1);
        expect(existsSync(artifact)).toBe(false);
        if (mode === "cancel") {
          expect(messages.messages.some((message: any) => message.card?.dismissed && message.card.answered === "deny")).toBe(true);
          expect(messages.messages.some((message: any) => message.tool?.ok === false)).toBe(true);
        } else expect(settled.status).toBe("settled");
        if (mode === "text") expect(messages.messages.some((message: any) => message.text?.includes("fixture-call"))).toBe(true);
      }
      if (mode === "tools-off") {
        expect(requests[before]).not.toHaveProperty("tools");
        expect(existsSync(startupMarker)).toBe(false);
        expect(system).not.toContain("Use memory_update");
        expect(system).not.toContain("session_search tool");
        expect(system).not.toContain("The user also added an MCP server");
        expect(messages.messages.some((message: any) => message.tool || message.card)).toBe(false);
      }
      evidence.push({ scenario: mode, status: settled.status, artifactExists: existsSync(artifact), completionRequests: requests.length - before, mcpStarted: existsSync(startupMarker) });
      if (mode === "ordinary" || mode === "tools-off") {
        const preview = await api("GET", `/api/bots/${bot.id}/system-prompt`);
        const previewText = JSON.stringify(preview.sections);
        expect(previewText).toContain("Fixture prefers concise replies.");
        expect(previewText).not.toContain("update it with your file tools");
        const { group } = await api("POST", "/api/groups", {
          name: "API memory room", memberIds: [bot.id],
          setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } },
        });
        await control(["send-channel", "--channel", group.id, "--text", "Greet this room."]);
        expect((await control(["wait", "--channel", group.id, "--timeout", "20"])).status).toBe("settled");
        const roomSystem = requests.at(-1)!.messages.find((message) => message.role === "system")?.content ?? "";
        expect(roomSystem).toContain("Fixture prefers concise replies.");
        expect(roomSystem).not.toContain("File locations for this bot");
        expect(roomSystem).not.toContain("update it with your file tools");
        await control(["messages", "--channel", group.id, "--limit", "10"]);
        if (mode === "tools-off") {
          expect(requests.at(-1)).not.toHaveProperty("tools");
          expect(existsSync(startupMarker)).toBe(false);
          expect(roomSystem).not.toContain("Use memory_update");
          expect(previewText).not.toContain("Use memory_update");
        }
      }
    }
  } finally {
    const evidencePath = `${fixture.info.logPath}.openai-tools.json`;
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2), { mode: 0o600 });
    console.info(JSON.stringify({ evidencePath }));
    await fixture.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
}, 120_000);
