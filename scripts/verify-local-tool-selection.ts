// Real local-model proof, separate from the synthetic CLI contract probes.
// Usage: node --experimental-strip-types scripts/verify-local-tool-selection.ts
//   pi|grok /absolute/path/to/cli http://127.0.0.1:1234/v1 MODEL_ID
// Start/load your local model separately. This script owns only disposable
// HOME/data/MCP files. The loopback proxy bounds generation to 768 tokens;
// it never changes tool schemas or invents model responses/tool calls.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ToolScope } from "../shared/tool-scope.ts";
import type { EngineInstance, RuntimeEvent } from "../server/contracts.ts";

const [engine, cliArgument, providerArgument, model] = process.argv.slice(2);
assert(engine === "pi" || engine === "grok", "Choose pi or grok");
assert(cliArgument && providerArgument && model, "Supply CLI, loopback /v1 URL and loaded model ID");
const cli = resolve(cliArgument);
const upstream = new URL(providerArgument);
assert(upstream.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(upstream.hostname)
  && !upstream.username && !upstream.password && !upstream.search && !upstream.hash, "Only an unauthenticated loopback model is supported");
const home = mkdtempSync(join(tmpdir(), "omb-local-selection-"));
// Do not inherit cloud accounts or the user's native-agent configuration.
for (const name of Object.keys(process.env)) {
  if (!["PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "LANG", "LC_ALL", "TZ", "TMPDIR"].includes(name)) delete process.env[name];
}
process.env.HOME = home; process.env.USERPROFILE = home; process.env.OMB_DATA_DIR = join(home, "data");
const { ensureDirs } = await import("../server/config.ts"); ensureDirs();
const artifact = join(home, "draft.txt"), blocked = join(home, "blocked.txt"), receipt = join(home, "mail-calls.txt");
type Payload = { tools?: Array<{ function: { name: string } }>; stream?: boolean; max_tokens?: number; messages: unknown[] };
type Capture = { scenario: string; names: string[]; schemaBytes: number; auxiliary: boolean; usage?: unknown; called: string[] };
const captures: Capture[] = [];
let scenario = "native";
let inFlight = 0;
const proxy = createServer(async (req, res) => {
  inFlight++;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180_000);
  res.on("close", () => { if (!res.writableEnded) controller.abort(); });
  try {
    const target = new URL(req.url ?? "/", `http://127.0.0.1`);
    assert(["/v1/chat/completions", "/v1/models"].includes(target.pathname), "Unexpected model endpoint");
    let text = ""; for await (const chunk of req) text += String(chunk);
    const payload = text ? JSON.parse(text) as Payload : undefined;
    let capture: Capture | undefined;
    if (payload) {
      const names = payload.tools?.map(tool => tool.function.name) ?? [];
      capture = { scenario, names, schemaBytes: Buffer.byteLength(JSON.stringify(payload.tools ?? [])),
        auxiliary: names.length === 1 && names[0] === "session_title", called: [] };
      captures.push(capture);
      assert(captures.filter(row => row.scenario === scenario).length <= 12, "Local turn exceeded its request budget");
      payload.max_tokens = Math.min(payload.max_tokens ?? 768, 768);
      console.log(JSON.stringify({ phase: "provider-request", engine, scenario, names, schemaBytes: capture.schemaBytes, auxiliary: capture.auxiliary }));
    }
    const response = await fetch(`${upstream.href.replace(/\/$/, "")}${target.pathname.slice(3)}`, {
      method: req.method, headers: { "content-type": "application/json" },
      ...(payload ? { body: JSON.stringify(payload) } : {}), signal: controller.signal,
    });
    res.writeHead(response.status, { "content-type": response.headers.get("content-type") ?? "application/json" });
    let output = ""; const decoder = new TextDecoder();
    for await (const chunk of response.body ?? []) { output += decoder.decode(chunk, { stream: true }); res.write(chunk); }
    output += decoder.decode();
    res.end();
    const frames = payload?.stream ? output.split("\n").filter(line => line.startsWith("data: ")).map(line => line.slice(6)).filter(line => line !== "[DONE]") : [output];
    for (const frame of frames) {
      try {
        const result = JSON.parse(frame);
        if (capture && result.usage) capture.usage = result.usage;
        const calls = result.choices?.flatMap((choice: any) => (choice.delta ?? choice.message)?.tool_calls ?? []) ?? [];
        if (capture) capture.called.push(...calls.map((call: any) => call.function?.name).filter(Boolean));
      } catch { /* Non-JSON stream termination is not model evidence. */ }
    }
    if (capture) console.log(JSON.stringify({ phase: "provider-response", engine, ...capture }));
  } catch (error) {
    if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error) } }));
  } finally { clearTimeout(timeout); inFlight--; }
});
await new Promise<void>(done => proxy.listen(0, "127.0.0.1", done));
const baseUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}/v1`;
const mail = join(home, "mail.mjs");
writeFileSync(mail, `import {createInterface} from "node:readline"; import {appendFileSync} from "node:fs";
createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;let result={};
if(m.method==='initialize')result={protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'mail-fixture',version:'1'}};
if(m.method==='tools/list')result={tools:['read_notes','send'].map(name=>({name,description:name==='read_notes'?'Read the disposable test notes':'Send a disposable test note',inputSchema:{type:'object',properties:{},additionalProperties:false}}))};
if(m.method==='tools/call'){appendFileSync(process.env.RECEIPT,m.params.name+'\\n');result={content:[{type:'text',text:'Disposable notes: orchard lantern 42'}]};}
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});`);
let instance: EngineInstance | undefined;
const events: RuntimeEvent[] = [];
let approvals = 0;
try {
  if (engine === "pi") {
    const directory = join(home, ".pi", "agent"); mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "models.json"), JSON.stringify({ providers: { fixture: { baseUrl, api: "openai-completions", apiKey: "local-fixture",
      models: [{ id: model, name: "Owned local model", reasoning: false, input: ["text"], contextWindow: 8192, maxTokens: 768,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
    writeFileSync(join(directory, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: model, defaultThinkingLevel: "off" }));
    const { PiDriver } = await import("../server/drivers/pi.ts");
    instance = await PiDriver.create({ instanceId: "local-test", displayName: "Local Pi fixture", enabled: true,
      config: { cli, fullAuto: false }, environment: { HOME: home, USERPROFILE: home } });
  } else {
    mkdirSync(join(home, ".grok")); writeFileSync(join(home, ".grok/config.toml"), "[cli]\nauto_update=false\n");
    const { localHost } = await import("../server/drivers/local-inject.ts"); localHost("lmstudio")!.baseUrl = baseUrl;
    const { GrokAgentDriver } = await import("../server/drivers/acp/grok.ts");
    instance = await GrokAgentDriver.create({ instanceId: "local-test", displayName: "Local Grok fixture", enabled: true,
      config: { cli: `${cli} --no-auto-update`, fullAuto: false }, environment: { HOME: home, USERPROFILE: home, GROK_HOME: join(home, ".grok") } });
  }
  instance.adapter.onEvent(event => {
    events.push(event);
    if (event.type === "request.opened") { approvals++; void instance!.adapter.respondToRequest(event.threadId, event.requestId, { behavior: "allow" }); }
  });
  async function turn(kind: string, toolScope: ToolScope, text: string) {
    scenario = kind; const start = events.length, before = captures.length;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const { turnId } = await Promise.race([
      instance!.adapter.sendTurn({ threadId: `local-${kind}`, cwd: home, text, toolScope, approvalMode: "ask",
        model: engine === "pi" ? `fixture/${model}` : `lmstudio::${model}`,
        integrations: { custom: { mail: { command: process.execPath, args: [mail], env: { RECEIPT: receipt } } } },
      }),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error(`Local ${engine} ${kind} timed out`)), 180_000); }),
    ]).finally(() => clearTimeout(timeout));
    const deadline = Date.now() + 180_000;
    while (!events.slice(start).some(event => event.type === "turn.completed" && event.turnId === turnId) && Date.now() < deadline) await delay(50);
    const turnEvents = events.slice(start).filter(event => event.turnId === turnId);
    const completed = turnEvents.find(event => event.type === "turn.completed");
    assert(completed?.ok === true, "Local model turn must complete successfully");
    const errors = turnEvents.filter(event => event.type === "runtime.error"); assert.equal(errors.length, 0, JSON.stringify(errors));
    while (inFlight > 0 && Date.now() < deadline) await delay(20);
    assert.equal(inFlight, 0, "Provider evidence must finish before changing scenarios");
    const main = captures.slice(before).filter(row => !row.auxiliary); assert(main.length > 0, "Turn must reach the actual local model");
    console.log(JSON.stringify({ phase: "turn-completed", ok: completed.ok, engine, scenario, requests: main, approvals }));
    return main;
  }
  const nativeNames = engine === "pi" ? ["read", "edit", "write"] : ["read_file", "search_replace", "write"];
  const native = await turn("native", { allow: nativeNames.map(name => `native:${name}`) },
    `Use the write tool once to create ${artifact} containing exactly "local model fixture". This is a disposable test file. Do not call any other tools. After writing, reply "done".`);
  for (const request of native) assert.deepEqual([...request.names].sort(), [...nativeNames].sort());
  assert.equal(readFileSync(artifact, "utf8").trim(), "local model fixture", "The real model must write the requested fixture");
  const allowed = engine === "pi" ? ["mcp:mail:read_notes"] : ["native:search_tool", "native:use_tool", "mcp:mail:read_notes"];
  const selected = await turn("mail", { allow: allowed }, engine === "pi"
    ? "Call mail_read_notes once with {} to read the disposable test notes, then repeat their contents. Do not send anything."
    : "Use search_tool to find mail read_notes, then use_tool to call mail__read_notes with {}. Repeat the disposable test notes. Do not send anything.");
  for (const request of selected) assert.deepEqual([...request.names].sort(), engine === "pi" ? ["mail_read_notes"] : ["search_tool", "use_tool"]);
  const mailReceipt = readFileSync(receipt, "utf8");
  const mailCalls = mailReceipt.trim().split("\n");
  assert(mailCalls.length > 0 && mailCalls.every(name => name === "read_notes"), "Only the selected MCP operation may execute");
  const empty = await turn("blocked", { allow: [] },
    `Try to use a terminal tool to create ${blocked}, or mail send. If neither tool is available, say it is unavailable. Do not pretend you ran it.`);
  assert(empty.every(row => row.names.length === 0));
  assert.equal(existsSync(blocked), false); assert.equal(readFileSync(receipt, "utf8"), mailReceipt);
  console.log(JSON.stringify({ ok: true, engine, model, generationTokenLimit: 768, evidence: captures,
    approvals, selectedMcpCalls: mailCalls.length, nativeDraftCreated: true, selectedMcpExecuted: true, withheldNativeExecuted: false, withheldMcpExecuted: false }));
} finally {
  await instance?.dispose(); proxy.closeAllConnections(); await new Promise<void>(done => proxy.close(() => done()));
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
