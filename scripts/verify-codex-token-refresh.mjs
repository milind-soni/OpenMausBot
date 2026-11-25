// Real Codex, synthetic credentials and a loopback Responses service; never touches a user's Codex home.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startChatGptTokenBridge } from "../server/drivers/chatgpt-plan-token-bridge.ts";

const cli = process.env.PROBE_CODEX || "codex";
const helper = process.env.PROBE_HELPER || fileURLToPath(new URL("../server/drivers/chatgpt-plan-token-command.ts", import.meta.url));
const runtime = process.env.PROBE_RUNTIME || process.execPath;
const event = (type, data) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
async function scenario(dynamic) {
  const dir = mkdtempSync(join(tmpdir(), "omb-codex-refresh-"));
  const marker = join(dir, "tool-count");
  let expired = false, requests = [];
  const bridge = dynamic ? await startChatGptTokenBridge(async () => expired ? "fake-B" : "fake-A") : null;
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (!req.url?.includes("/responses")) { res.writeHead(404); res.end(); return; }
      const token = (req.headers.authorization || "").replace("Bearer ", "");
      requests.push(token);
      if (requests.length > 1 && token === "fake-A") {
        expired = true;
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: "token_expired", message: "synthetic token expired" } }));
        return;
      }
      const item = requests.length === 1 ? {
        id: "fc_fixture", type: "function_call", status: "completed", name: "exec_command", call_id: "call_fixture",
        arguments: JSON.stringify({ cmd: `if [ -n "$OMB_CODEX_AUTH_SECRET" ]; then printf leak >> '${marker}'; else printf x >> '${marker}'; fi` }),
      } : { id: "msg_fixture", type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: "fixture ok", annotations: [] }] };
      const id = `resp_fixture${requests.length}`;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(event("response.created", { type: "response.created", response: { id, status: "in_progress", output: [] } }) +
        event("response.output_item.added", { type: "response.output_item.added", output_index: 0, item }) +
        event("response.output_item.done", { type: "response.output_item.done", output_index: 0, item }) +
        event("response.completed", { type: "response.completed", response: { id, status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }));
    });
  });
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const args = ["exec", "--skip-git-repo-check", "--ephemeral", "--sandbox", "workspace-write", "-m", "gpt-5",
      "-c", 'model_provider="fixture"', "-c", 'model_providers.fixture.name="Fixture"',
      "-c", `model_providers.fixture.base_url="http://127.0.0.1:${server.address().port}/v1"`,
      "-c", 'model_providers.fixture.wire_api="responses"', "-c", "model_providers.fixture.requires_openai_auth=false",
      "-c", "model_providers.fixture.supports_websockets=false", "-c", "model_providers.fixture.stream_max_retries=0",
      "-c", "model_providers.fixture.request_max_retries=0", "-c", "features.shell_snapshot=false",
      "-c", 'shell_environment_policy.exclude=["OMB_CODEX_AUTH_SECRET","OMB_CODEX_AUTH_SOCKET","ELECTRON_RUN_AS_NODE"]',
      ...(dynamic ? ["-c", `model_providers.fixture.auth.command=${JSON.stringify(runtime)}`,
        "-c", `model_providers.fixture.auth.args=[${JSON.stringify(helper)}]`, "-c", "model_providers.fixture.auth.refresh_interval_ms=30000",
        "-c", "model_providers.fixture.auth.timeout_ms=60000"] : ["-c", 'model_providers.fixture.env_key="FIXTURE_TOKEN"']), "Run fixture tool"];
    const env = { PATH: process.env.PATH, HOME: dir, CODEX_HOME: dir, NO_PROXY: "127.0.0.1,localhost", FIXTURE_TOKEN: "fake-A", ELECTRON_RUN_AS_NODE: "1", ...bridge?.env };
    const child = spawn(cli, args, { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; child.stdout.on("data", x => { output += x; }); child.stderr.on("data", x => { output += x; });
    const timer = setTimeout(() => child.kill("SIGTERM"), 45000);
    const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
    clearTimeout(timer);
    assert.equal(existsSync(marker) ? readFileSync(marker, "utf8") : "", "x", `tool must run once without the bridge secret: ${output.slice(-1200)}`);
    assert.deepEqual(requests, dynamic ? ["fake-A", "fake-A", "fake-B"] : ["fake-A", "fake-A"]);
    assert.equal(code, dynamic ? 0 : 1, output.slice(-1200));
    console.log(`${dynamic ? "dynamic" : "static"}: ${dynamic ? "recovered" : "failed as expected"}; tool ran once`);
  } finally { bridge?.close(); server.close(); rmSync(dir, { recursive: true, force: true }); }
}
await scenario(false);
await scenario(true);
