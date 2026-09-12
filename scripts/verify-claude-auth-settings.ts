// Real Claude CLI through the OMB driver, synthetic account and loopback API.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const cli = resolve(process.argv[2] ?? "");
const apiKey = process.argv.includes("--api-key");
assert.ok(process.argv[2], "Pass the absolute Claude CLI path");
const home = mkdtempSync(join(tmpdir(), "omb-claude-auth-fixture-"));
const account = join(home, ".claude");
const workspace = join(home, "workspace");
mkdirSync(account);
mkdirSync(workspace);
process.env = {
  HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"),
  PATH: process.env.PATH, OMB_DATA_DIR: join(home, "omb"),
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1",
  ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
};
const requests: { authenticated: boolean; model: string }[] = [];
const server = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  if (req.url?.includes("count_tokens")) {
    res.writeHead(200, { "Content-Type": "application/json" }).end('{"input_tokens":10}');
    return;
  }
  if (req.method !== "POST" || !req.url?.startsWith("/v1/messages")) { res.writeHead(404).end(); return; }
  const payload = JSON.parse(body);
  requests.push({ authenticated: req.headers["x-api-key"] === "fixture-only-key" || req.headers.authorization === "Bearer fixture-only-key", model: payload.model });
  const response = { id: "msg_fixture", type: "message", role: "assistant", model: payload.model, content: [{ type: "text", text: "Offline authentication works." }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } };
  if (!payload.stream) { res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(response)); return; }
  const events = [
    { type: "message_start", message: { ...response, content: [], stop_reason: null } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Offline authentication works." } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } },
    { type: "message_stop" },
  ];
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
});
await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
const port = (server.address() as { port: number }).port;
writeFileSync(join(account, "settings.json"), JSON.stringify({
  ...(!apiKey ? { apiKeyHelper: "echo fixture-only-key" } : {}),
  env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ...(apiKey ? { ANTHROPIC_API_KEY: "fixture-only-key" } : {}) },
  hooks: { SessionStart: [{ hooks: [{ type: "command", command: `${JSON.stringify(process.execPath)} -e "require('fs').writeFileSync('hook-ran', 'unexpected')"` }] }] },
}), { mode: 0o600 });
const { ensureDirs } = await import("../server/config.ts");
ensureDirs();
const { ClaudeDriver } = await import("../server/drivers/claude.ts");
const { recordEvents } = await import("../server/testing/events.ts");
const provider = await ClaudeDriver.create({ instanceId: "fixture", displayName: "Offline Claude", enabled: true, environment: {}, config: { cli, configDir: account, permissionMode: "acceptEdits", tools: [] } });
const recorder = recordEvents(provider.adapter);
try {
  for (let i = 0; i < 2; i++) {
    const { turnId } = await provider.adapter.sendTurn({ threadId: "fixture-thread", text: "Reply briefly. No tools.", cwd: workspace, model: "claude-sonnet-4-6", approvalMode: "ask" });
    const done = await recorder.until(event => event.type === "turn.completed" && event.turnId === turnId, 40_000);
    assert.equal((done as { ok: boolean }).ok, true, JSON.stringify(recorder.events.filter(event => event.type === "runtime.error")));
  }
  assert.ok(requests.length >= 2);
  assert.ok(requests.every(request => request.authenticated));
  assert.equal(existsSync(join(workspace, "hook-ran")), false, "Personal hooks must stay isolated");
  console.log(JSON.stringify({ ok: true, turns: 2, authentication: apiKey ? "settings env key" : "apiKeyHelper", authenticated: true, settingsIsolated: true, endpoint: "loopback only" }));
} finally {
  recorder.stop();
  await provider.dispose();
  server.closeAllConnections();
  await new Promise<void>(done => server.close(() => done()));
  rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
