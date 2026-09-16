// Real OpenCode, disposable home, deterministic loopback model. No user data,
// real credentials or external model requests are used.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

assert.ok(process.argv[2], "Pass the absolute OpenCode CLI path");
const cli = resolve(process.argv[2]);
const home = mkdtempSync(join(tmpdir(), "omb-opencode-permissions-"));
const workspace = join(home, "workspace");
const external = join(home, "outside", "receipt.txt");
mkdirSync(workspace);
mkdirSync(join(home, "outside"));
writeFileSync(external, "OMB_EXTERNAL_READ_RECEIPT");
process.env = {
  PATH: process.env.PATH, HOME: home, USERPROFILE: home,
  XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"),
  XDG_CACHE_HOME: join(home, "cache"), XDG_STATE_HOME: join(home, "state"),
  OMB_DATA_DIR: join(home, "omb"), OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
  OPENCODE_DISABLE_MODELS_FETCH: "true", OPENMAUSBOT_PROBE_LOCAL_INJECT: "0",
  ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
};
let calls = 0;
let readSucceeded = false;
const server = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) { res.writeHead(404).end(); return; }
  const payload = JSON.parse(body);
  const toolResult = payload.messages.at(-1)?.role === "tool";
  readSucceeded ||= toolResult && JSON.stringify(payload.messages.at(-1)).includes("OMB_EXTERNAL_READ_RECEIPT");
  const tool = { index: 0, id: `read-${++calls}`, type: "function", function: { name: "read", arguments: JSON.stringify({ filePath: external }) } };
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const chunk = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({id:`fixture-${calls}`,object:"chat.completion.chunk",created:0,model:"fixture",choices:[{index:0,delta,finish_reason}]})}\n\n`;
  res.end(chunk(toolResult ? {role:"assistant",content:"Fixture complete."} : {role:"assistant",tool_calls:[tool]}, null)
    + chunk({}, toolResult ? "stop" : "tool_calls") + "data: [DONE]\n\n");
});
await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
const port = (server.address() as {port:number}).port;
writeFileSync(join(workspace, "opencode.json"), JSON.stringify({
  provider: { fixture: { npm: "@ai-sdk/openai-compatible", name: "Offline fixture", options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "fixture-only" }, models: { fixture: { name: "Fixture", limit: {context:32000,output:1000} } } } },
  model: "fixture/fixture", permission: { external_directory: "ask" },
}));
const { ensureDirs } = await import("../server/config.ts");
const { createOpenCodeDriver } = await import("../server/drivers/acp/opencode-go.ts");
const { recordEvents } = await import("../server/testing/events.ts");
ensureDirs();
const instance = await createOpenCodeDriver(async () => ({ default:"fixture/fixture", options:[{id:"fixture/fixture",label:"Fixture"}] })).create({
  instanceId:"permission-fixture", displayName:"Fixture", enabled:true,
  environment:{OPENCODE_API_KEY:"fixture-only"}, config:{cli,fullAuto:false},
});
const recorder = recordEvents(instance.adapter);
try {
  let resumeCursor: string | undefined;
  for (const approvalMode of ["full", "ask", "full"] as const) {
    readSucceeded = false;
    const {turnId} = await instance.adapter.sendTurn({threadId:"fixture",text:"Read the receipt outside the workspace.",cwd:workspace,model:"fixture/fixture",approvalMode,resumeCursor});
    if (approvalMode === "ask") {
      const opened = await recorder.until(e => e.turnId === turnId && e.type === "request.opened", 30000);
      await instance.adapter.respondToRequest("fixture", opened.requestId!, {behavior:"deny"});
    }
    const completed = await recorder.until(e => e.turnId === turnId && e.type === "turn.completed", 30000);
    assert.equal(completed.type, "turn.completed", JSON.stringify(completed));
    assert.ok(completed.type === "turn.completed" && completed.ok, JSON.stringify(completed));
    assert.equal(readSucceeded, approvalMode === "full", "Actual external read must follow the current mode");
    if (approvalMode === "full") assert.equal(recorder.events.some(e => e.turnId === turnId && e.type === "request.opened"), false);
    const started = recorder.events.find(e => e.turnId === turnId && e.type === "session.started");
    resumeCursor = started?.type === "session.started" ? started.sessionId ?? undefined : undefined;
    assert.ok(resumeCursor, "The next turn must exercise session resumption");
    console.log(JSON.stringify({approvalMode,readSucceeded,resumed:true}));
  }
} finally {
  recorder.stop();
  await instance.dispose();
  server.closeAllConnections();
  await new Promise<void>(done => server.close(() => done()));
  rmSync(home, { recursive:true, force:true });
}
