// Native Codex + production adapter, disposable homes, loopback model only.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "omb-native-sandbox-"));
process.env.OMB_DATA_DIR = join(root, "omb");
mkdirSync(join(root, "omb", "native"), { recursive: true });
console.log(`Evidence: ${root}`);
const { CodexDriver } = await import("../server/drivers/codex.ts");
const { recordEvents } = await import("../server/testing/events.ts");
const captures = [];
const server = createServer(async (req, res) => {
  if (req.method !== "POST") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ models: [] }));
    return;
  }
  let raw = "";
  for await (const chunk of req) raw += chunk;
  captures.push(JSON.parse(raw));
  const item = { id: `msg_${captures.length}`, type: "message", role: "assistant", status: "completed",
    content: [{ type: "output_text", text: "Fixture reply.", annotations: [] }] };
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of [
    { type: "response.created", response: { id: `resp_${captures.length}`, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: `resp_${captures.length}`, status: "completed", output: [item] } },
  ]) res.write(`data: ${JSON.stringify(event)}\n\n`);
  res.end();
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const results = [];
let instance;
try {
  for (const network of [true, false]) {
    const home = join(root, `home-${network}`);
    const cwd = join(root, `cwd-${network}`);
    const extra = join(root, `extra-${network}`);
    for (const path of [home, cwd, extra]) mkdirSync(path);
    writeFileSync(join(home, "config.toml"), `model="gpt-5.6-luna"
model_provider="fixture"
approval_policy="on-request"
sandbox_mode="workspace-write"
[windows]
sandbox="unelevated"
[sandbox_workspace_write]
network_access=${network}
writable_roots=[${JSON.stringify(extra.replaceAll("\\", "/"))}]
exclude_tmpdir_env_var=true
exclude_slash_tmp=true
[model_providers.fixture]
name="Fixture"
base_url="http://127.0.0.1:${server.address().port}/v1"
wire_api="responses"
requires_openai_auth=false
`);
    instance = await CodexDriver.create({ instanceId: "sandbox-fixture", displayName: "Sandbox fixture", enabled: true,
      config: { cli: process.env.PROBE_CODEX ?? "codex", fullAuto: false },
      environment: { HOME: home, USERPROFILE: home, CODEX_HOME: home } });
    const recorder = recordEvents(instance.adapter);
    let cursor;
    for (const mode of ["ask", "auto", "full", "ask", "custom"]) {
      const threadId = `sandbox-${network}-${mode}-${results.length}`;
      const { turnId } = await instance.adapter.sendTurn({ threadId, text: "Reply briefly.", system: "Synthetic permission check.",
        cwd, model: "fixture::gpt-5.6-luna", effort: "low", approvalMode: mode, ...(cursor ? { resumeCursor: cursor } : {}) });
      const done = await recorder.until(event => event.type === "turn.completed" && event.turnId === turnId, 30000);
      assert.equal(done.ok, true, JSON.stringify(recorder.events.filter(event => event.turnId === turnId)));
      cursor = recorder.events.find(event => event.turnId === turnId && event.type === "session.started").sessionId;
      const log = readFileSync(join(root, "omb", "native", `${threadId}.ndjson`), "utf8").trim().split("\n").map(JSON.parse);
      const start = log.find(row => row.dir === "out" && ["thread/start", "thread/resume"].includes(row.msg.method));
      const resolved = log.find(row => row.dir === "in" && row.msg.id === start.msg.id).msg.result.sandbox;
      const sent = log.find(row => row.dir === "out" && row.msg.method === "turn/start").msg.params.sandboxPolicy;
      assert.deepEqual(sent, resolved);
      assert.equal(sent.type, mode === "full" ? "dangerFullAccess" : "workspaceWrite");
      if (mode !== "full") {
        assert.equal(sent.networkAccess, network);
        assert.equal(sent.excludeTmpdirEnvVar, true);
        assert.equal(sent.excludeSlashTmp, true);
        assert(sent.writableRoots.some(path => path.replaceAll("\\", "/").toLowerCase() === extra.replaceAll("\\", "/").toLowerCase()));
      }
      results.push({ mode, network, method: start.msg.method, passed: true });
      console.log(JSON.stringify(results.at(-1)));
    }
    await instance.dispose();
    instance = undefined;
  }
  assert.equal(captures.length, 10);
  writeFileSync(join(root, "results.json"), JSON.stringify({ results, requests: captures.length }, null, 2));
  console.log(`Evidence: ${root}`);
} finally {
  await instance?.dispose();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
