// Native Codex + production adapter, disposable homes, loopback model only: a mounted MCP server
// that takes seconds to start must already be callable from the turn's first exec call.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const startupDelayMs = Number(process.env.PROBE_MCP_DELAY_MS) || 3000;
const root = mkdtempSync(join(tmpdir(), "omb-native-mcp-startup-"));
process.env.OMB_DATA_DIR = join(root, "omb");
mkdirSync(join(root, "omb", "native"), { recursive: true });
console.log(`Evidence: ${root}`);
const { CodexDriver } = await import("../server/drivers/codex.ts");
const { recordEvents } = await import("../server/testing/events.ts");
const { flushNativeLogs } = await import("../server/drivers/native.ts");

const slowServer = join(root, "slow-mcp.mjs");
writeFileSync(slowServer, `import { createInterface } from "node:readline";
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    setTimeout(() => send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: message.params.protocolVersion,
      capabilities: { tools: {} }, serverInfo: { name: "slow-probe", version: "1" } } }), ${startupDelayMs});
  } else if (message.method === "tools/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "slow_probe_lookup", description: "Fixture tool of a slow MCP server.",
      inputSchema: { type: "object", properties: {} } }] } });
  } else if (message.id !== undefined) {
    send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "fixture" }] } });
  }
});
`);

const captures = [];
const execOutputs = [];
// Like gpt-6.1-terra in Codex's code mode: list the tools exec can call, then answer.
const LIST_TOOLS = "text(JSON.stringify(ALL_TOOLS.map((tool) => tool.name)));";
const server = createServer(async (req, res) => {
  if (req.method !== "POST") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ models: [] }));
    return;
  }
  let raw = "";
  for await (const chunk of req) raw += chunk;
  captures.push(raw);
  const last = JSON.parse(raw).input?.at(-1);
  const n = captures.length;
  let item;
  if (last?.type === "custom_tool_call_output") {
    execOutputs.push(JSON.stringify(last.output));
    item = { id: `msg_${n}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Fixture reply.", annotations: [] }] };
  } else {
    item = { id: `ctc_${n}`, type: "custom_tool_call", status: "completed", call_id: `call_${n}`, name: "exec", input: LIST_TOOLS };
  }
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of [
    { type: "response.created", response: { id: `resp_${n}`, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: item.type === "message" ? { ...item, content: [] } : item },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: `resp_${n}`, status: "completed", output: [item] } },
  ]) res.write(`data: ${JSON.stringify(event)}\n\n`);
  res.end();
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const results = [];
let instance;
try {
  const home = join(root, "home");
  const cwd = join(root, "cwd");
  for (const path of [home, cwd]) mkdirSync(path);
  writeFileSync(join(home, "config.toml"), `model="gpt-6.1-terra"
model_provider="fixture"
approval_policy="on-request"
sandbox_mode="workspace-write"
[model_providers.fixture]
name="Fixture"
base_url="http://127.0.0.1:${server.address().port}/v1"
wire_api="responses"
requires_openai_auth=false
`);
  instance = await CodexDriver.create({ instanceId: "mcp-startup-fixture", displayName: "MCP startup fixture", enabled: true,
    config: { cli: process.env.PROBE_CODEX ?? "codex", fullAuto: false },
    environment: { HOME: home, USERPROFILE: home, CODEX_HOME: home } });
  const recorder = recordEvents(instance.adapter);
  const integrations = { custom: { slowprobe: { command: process.execPath, args: [slowServer], env: {} } } };
  let cursor;
  for (const kind of ["start", "resume"]) {
    const threadId = "mcp-startup";
    const before = execOutputs.length;
    const { turnId } = await instance.adapter.sendTurn({ threadId, text: "Reply briefly.", cwd, model: "fixture::gpt-6.1-terra",
      effort: "low", approvalMode: "ask", integrations, ...(cursor ? { resumeCursor: cursor } : {}) });
    const done = await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId, 60000);
    assert.equal(done.ok, true, JSON.stringify(recorder.events.filter((event) => event.turnId === turnId)));
    cursor = recorder.events.find((event) => event.turnId === turnId && event.type === "session.started").sessionId;
    flushNativeLogs();
    const log = readFileSync(join(root, "omb", "native", `${threadId}.ndjson`), "utf8").trim().split("\n").map(JSON.parse);
    const threadRow = log.findLast((row) => row.dir === "out" && ["thread/start", "thread/resume"].includes(row.msg.method));
    const launch = log.slice(log.indexOf(threadRow));
    const startRow = launch.find((row) => row.dir === "out" && row.msg.method === "turn/start");
    const readyRow = launch.find((row) => row.dir === "in" && row.msg.method === "mcpServer/startupStatus/updated" && row.msg.params?.name === "slowprobe" && row.msg.params.status !== "starting");
    const result = { kind, method: threadRow.msg.method, serverStatus: readyRow?.msg.params.status,
      turnStartAfterServerReady: Boolean(readyRow && startRow && Date.parse(readyRow.at) <= Date.parse(startRow.at)),
      toolVisibleToFirstExec: (execOutputs[before] ?? "").includes("slow_probe_lookup") };
    results.push(result);
    console.log(JSON.stringify(result));
  }
  writeFileSync(join(root, "results.json"), JSON.stringify({ startupDelayMs, results, requests: captures.length, execOutputs }, null, 2));
  writeFileSync(join(root, "requests.json"), JSON.stringify(captures.map((raw) => JSON.parse(raw)), null, 2));
  for (const result of results) {
    assert.equal(result.serverStatus, "ready");
    assert.equal(result.turnStartAfterServerReady, true, `the ${result.kind} turn started before the MCP server was ready`);
    assert.equal(result.toolVisibleToFirstExec, true, `the ${result.kind} turn's first exec did not see slow_probe_lookup`);
  }
  console.log(`Evidence: ${root}`);
} finally {
  await instance?.dispose();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
