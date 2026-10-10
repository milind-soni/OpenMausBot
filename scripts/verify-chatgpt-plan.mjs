// Native protocol check, with synthetic Responses only. Never reads a login.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const root = mkdtempSync(join(tmpdir(), "omb-chatgpt-plan-"));
process.env.OMB_DATA_DIR = join(root, "omb");
const { chatgptPlanCodexArgs } = await import("../server/drivers/codex.ts");
const home = join(root, "home");
const cwd = join(root, "workspace");
mkdirSync(home); mkdirSync(cwd);
const captures = [];
const token = "synthetic-chatgpt-plan-token";
const server = createServer(async (req, res) => {
  if (req.url !== "/v1/responses") { res.writeHead(404).end(); return; }
  let text = "";
  for await (const chunk of req) text += chunk;
  const body = JSON.parse(text);
  captures.push({ body, authorization: req.headers.authorization });
  const item = { id: `msg_${captures.length}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Synthetic plan reply.", annotations: [] }] };
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
const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
let child;
let sequence = 0;
let pending = new Map();
let completions;
let stderr = "";
async function start() {
  pending = new Map();
  child = spawn(process.env.PROBE_CODEX ?? "codex", ["app-server", ...chatgptPlanCodexArgs(),
    // Fixture override only; the production endpoint is fixed HTTPS.
    "-c", `model_providers.openai_chatgpt_plan.base_url=${JSON.stringify(endpoint)}`,
  ], { env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home, OPENMAUSBOT_CHATGPT_TOKEN: token }, stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-8000); });
  createInterface({ input: child.stdout }).on("line", line => {
    let message; try { message = JSON.parse(line); } catch { return; }
    const waiter = pending.get(message.id);
    if (waiter) {
      pending.delete(message.id);
      if (message.error) waiter.reject(Error(JSON.stringify(message.error)));
      else waiter.resolve(message.result);
    }
    else if (message.method === "turn/completed") completions?.(message.params);
  });
  await rpc("initialize", { clientInfo: { name: "openmausbot", title: "OpenMausBot", version: "fixture" } });
  child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
}
function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await once(child, "exit");
}
async function turn(threadId) {
  const completed = new Promise(resolve => { completions = resolve; });
  await rpc("turn/start", { threadId, input: [{ type: "text", text: "Reply with the fixture greeting." }] });
  assert.equal((await completed).turn.status, "completed");
}
const timeout = setTimeout(() => { child?.kill("SIGKILL"); console.error("Native plan fixture timed out", root, stderr); process.exitCode = 1; server.close(); }, 45_000);
try {
  await start();
  const selection = { model: "gpt-6.1-sol", modelProvider: "openai_chatgpt_plan", cwd, approvalPolicy: "never", sandbox: "read-only" };
  const created = await rpc("thread/start", selection);
  await turn(created.thread.id);
  await stop();
  await start();
  const resumed = await rpc("thread/resume", { ...selection, threadId: created.thread.id });
  assert.equal(resumed.thread.id, created.thread.id);
  await turn(resumed.thread.id);
  assert.equal(captures.length, 2);
  for (const { body, authorization } of captures) {
    assert.equal(authorization, `Bearer ${token}`);
    assert.equal(body.model, "gpt-6.1-sol");
    assert.equal(body.stream, true);
    assert.equal(body.store, false);
    assert.ok(Array.isArray(body.input));
    for (const key of ["previous_response_id", "background", "conversation", "max_output_tokens", "temperature", "metadata"]) assert.equal(body[key], undefined, key);
    assert.ok(!(body.tools ?? []).some(tool => tool.type === "tool_search"));
  }
  console.log(JSON.stringify({ ok: true, root, turns: captures.length, model: "gpt-6.1-sol", resumed: true, store: false, stream: true }));
} finally {
  clearTimeout(timeout);
  await stop();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
