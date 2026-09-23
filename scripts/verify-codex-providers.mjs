// Optional native Codex smoke with loopback Responses APIs and an inert MCP
// computer. No credentials, real model inference, or desktop control is used.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "omb-codex-providers-"));
process.env.OMB_DATA_DIR = join(root, "data");
const { CodexDriver } = await import("../server/drivers/codex.ts");
const { recordEvents } = await import("../server/testing/events.ts");
const evidence = { routes: [], turns: [] };
const gatewayUrl = process.env.PROBE_GATEWAY_URL;
if (gatewayUrl) assert.match(gatewayUrl, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
const routes = gatewayUrl
  ? [{ name: "azure", model: "azure-gpt" }, { name: "google", model: "gemini-3.8-flash" }, { name: "bedrock", model: "bedrock-claude" }]
  : [{ name: "alpha", model: "fixture-model" }, { name: "beta", model: "fixture-model" }];
const evidencePath = `${root}.json`;
const instances = [];
const computer = join(root, "computer.mjs");
writeFileSync(computer, `
import { createInterface } from "node:readline";
createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result = {};
  if (request.method === "initialize") result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "inert-computer", version: "1" } };
  if (request.method === "tools/list") result = { tools: [{ name: "screenshot", description: "Read a synthetic fixture desktop; never touches a real computer.", inputSchema: { type: "object", properties: {}, additionalProperties: false } }] };
  if (request.method === "tools/call") result = { content: [
    { type: "text", text: "SYNTHETIC_DESKTOP_CAPTURE" },
    { type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFUlEQVR4nGNgaPhPGhrVMKph+GoAAJ5XfxAVxgy+AAAAAElFTkSuQmCC" },
  ] };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
});
`);
let serial = 0;
const api = createServer(async (req, res) => {
  try {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const route = req.url?.split("/")[1];
    assert(["alpha", "beta"].includes(route));
    assert.equal(req.headers.authorization, `Bearer ${route}-fixture-key`);
    assert.equal(body.model, "fixture-model");
    const sawComputerResult = JSON.stringify(body.input).includes("SYNTHETIC_DESKTOP_CAPTURE");
    const namespace = body.tools?.find(tool => tool.type === "namespace" && tool.name === "mcp__computer");
    const tool = namespace?.tools?.find(tool => tool.type === "function" && tool.name === "screenshot")
      ?? body.tools?.find(tool => tool.type === "function" && /computer.*screenshot/.test(tool.name));
    assert(tool, "Codex must expose the computer MCP tool to the selected model provider");
    evidence.routes.push({ route, model: body.model, tool: tool.name, sawComputerResult });
    const id = String(++serial);
    const item = sawComputerResult
      ? { id: `msg_${id}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: `${route}: computer fixture verified`, annotations: [] }] }
      : { id: `fc_${id}`, type: "function_call", call_id: `call_${id}`, name: tool.name, ...(namespace ? { namespace: namespace.name } : {}), arguments: "{}", status: "completed" };
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of [
      { type: "response.created", response: { id: `resp_${id}`, status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id: `resp_${id}`, status: "completed", output: [item] } },
    ]) res.write(`data: ${JSON.stringify(event)}\n\n`);
    res.end();
  } catch (error) {
    evidence.routes.push({ error: String(error) });
    res.writeHead(400).end(String(error));
  }
});

try {
  await new Promise((resolve, reject) => {
    api.once("error", reject);
    api.listen(0, "127.0.0.1", resolve);
  });
  const port = api.address().port;
  for (const { name, model } of routes) {
    const home = join(root, name);
    mkdirSync(join(home, ".codex"), { recursive: true });
    const instance = await CodexDriver.create({
      instanceId: name, displayName: name, enabled: true,
      environment: { HOME: home, USERPROFILE: home, CODEX_HOME: join(home, ".codex"), FIXTURE_KEY: gatewayUrl ? "synthetic-gateway-key" : `${name}-fixture-key` },
      config: CodexDriver.decodeConfig({
        cli: process.env.PROBE_CODEX ?? "codex",
        provider: { name, url: gatewayUrl ?? `http://127.0.0.1:${port}/${name}/v1`, models: [model], apiKeyEnv: "FIXTURE_KEY" },
      }),
    });
    instances.push(instance);
    let cursor;
    for (let index = 0; index < 2; index++) {
      const recorder = recordEvents(instance.adapter);
      try {
        await instance.adapter.sendTurn({
          threadId: `${name}-thread`, text: "Read the synthetic computer fixture.", cwd: home,
          model, resumeCursor: cursor, approvalMode: "full",
          integrations: { localComputer: { command: process.execPath, args: [computer], env: {} } },
        });
        const done = await recorder.until(event => event.type === "turn.completed", 45_000);
        assert.equal(done.ok, true, JSON.stringify(recorder.events.filter(event => event.type === "runtime.error")));
        cursor = recorder.events.find(event => event.type === "session.started")?.sessionId;
        assert(cursor);
        evidence.turns.push({ provider: name, resumed: index > 0, ok: done.ok });
      } finally {
        recorder.stop();
      }
    }
  }
  if (!gatewayUrl) for (const { name } of routes) {
    assert(evidence.routes.some(route => route.route === name && route.sawComputerResult));
  }
  console.log(`PASS: ${routes.length} custom providers, native start/resume, and synthetic computer MCP round trips.`);
} finally {
  await Promise.all(instances.map(instance => instance.dispose()));
  api.closeAllConnections();
  await new Promise(resolve => api.close(resolve));
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2), { mode: 0o600 });
  rmSync(root, { recursive: true, force: true });
  console.log(`Evidence: ${evidencePath}`);
}
