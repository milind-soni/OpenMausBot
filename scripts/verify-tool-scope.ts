// Real official Grok CLI with a synthetic provider, disposable HOME and MCP.
// A contract probe, not a local-model benchmark or a sandbox claim.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ToolScope } from "../shared/tool-scope.ts";

const cli = resolve(process.argv[2] ?? "grok");
const home = mkdtempSync(join(tmpdir(), "omb-grok-selection-"));
process.env.HOME = home; process.env.USERPROFILE = home; process.env.OMB_DATA_DIR = join(home, "data");
const { GrokAgentDriver } = await import("../server/drivers/acp/grok.ts");
const { localHost } = await import("../server/drivers/local-inject.ts");
const { ensureDirs } = await import("../server/config.ts"); ensureDirs();
const artifact = join(home, "draft.txt"), blocked = join(home, "blocked.txt"), receipt = join(home, "mail-calls.txt");
type Payload = { stream?: boolean; tools?: Array<{ function: { name: string } }>; messages: Array<{ role: string; content?: unknown }> };
const payloads: Payload[] = [];
let scenario = "legacy", round = 0;
const provider = createServer(async (req, res) => {
  if (!req.url?.endsWith("/chat/completions")) { res.writeHead(404).end(); return; }
  let body = ""; for await (const chunk of req) body += chunk;
  const payload = JSON.parse(body) as Payload;
  const names = payload.tools?.map((tool) => tool.function.name) ?? [];
  const auxiliary = names.length === 1 && names[0] === "session_title";
  if (!auxiliary) payloads.push(payload);
  const calls = scenario === "native" ? [
    { name: "write", arguments: JSON.stringify({ file_path: artifact, content: "verified drafting" }) },
    { name: "run_terminal_command", arguments: JSON.stringify({ command: `touch '${blocked}'` }) },
  ] : scenario === "mail" ? (round === 0 ? [{ name: "search_tool", arguments: JSON.stringify({ query: "mail read_notes" }) }] : [
    { name: "use_tool", arguments: JSON.stringify({ tool_name: "mail__read_notes", tool_input: {} }) },
    { name: "use_tool", arguments: JSON.stringify({ tool_name: "mail__write_notes", tool_input: {} }) },
  ]) : [];
  const toolCalls = !auxiliary && round++ < (scenario === "mail" ? 2 : 1) && calls.length > 0;
  const message = toolCalls ? { role: "assistant", tool_calls: calls.map((fn, index) => ({ index, id: `fixture-${index}`, type: "function", function: fn })) } : { role: "assistant", content: "Fixture finished." };
  const response = { id: "fixture", created: 0, model: "fixture", usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
  if (!payload.stream) { res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ...response, object: "chat.completion", choices: [{ index: 0, message, finish_reason: toolCalls ? "tool_calls" : "stop" }] })); return; }
  const frame = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({ ...response, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
  res.writeHead(200, { "content-type": "text/event-stream" }).end(frame(message, null) + frame({}, toolCalls ? "tool_calls" : "stop") + "data: [DONE]\n\n");
});
await new Promise<void>((done) => provider.listen(0, "127.0.0.1", done));
localHost("omlx")!.baseUrl = `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`;
mkdirSync(join(home, ".grok")); writeFileSync(join(home, ".grok/config.toml"), "[cli]\nauto_update=false\n");
const mail = join(home, "mail.mjs");
writeFileSync(mail, `import {createInterface} from "node:readline";import {appendFileSync} from "node:fs";
createInterface({input:process.stdin}).on("line",line=>{const m=JSON.parse(line);if(m.id===undefined)return;let result={};
if(m.method==="initialize")result={protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:"mail-fixture",version:"1"}};
if(m.method==="tools/list")result={tools:["read_notes","write_notes"].map(name=>({name,description:name,inputSchema:{type:"object",properties:{},additionalProperties:false}}))};
if(m.method==="tools/call"){appendFileSync(process.env.RECEIPT,m.params.name+"\\n");result={content:[{type:"text",text:"mail fixture receipt"}]};}
process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:m.id,result})+"\\n");});`);
const instance = await GrokAgentDriver.create({ instanceId: "fixture", displayName: "Grok contract fixture", enabled: true, config: { cli: `${cli} --no-auto-update`, fullAuto: false }, environment: { HOME: home, USERPROFILE: home, GROK_HOME: join(home, ".grok") } });
const events: any[] = []; let approvals = 0;
instance.adapter.onEvent((event) => { events.push(event); if (event.type === "request.opened") { approvals++; void instance.adapter.respondToRequest(event.threadId, event.requestId, { behavior: "allow" }); } });
const evidence: unknown[] = [];
async function turn(kind: string, toolScope?: ToolScope, resumeCursor?: string) {
  scenario = kind; round = 0; const before = payloads.length, eventStart = events.length;
  const { turnId } = await instance.adapter.sendTurn({ threadId: "scope-contract", cwd: home, text: "Complete only the selected disposable fixture tools.", model: "omlx::fixture", approvalMode: "ask", toolScope, resumeCursor,
    integrations: kind === "mail" ? { custom: { mail: { command: process.execPath, args: [mail], env: { RECEIPT: receipt } } } } : {},
  });
  const deadline = Date.now() + 30_000;
  while (!events.slice(eventStart).some((event) => event.type === "turn.completed" && event.turnId === turnId) && Date.now() < deadline) await delay(50);
  const completed = events.slice(eventStart).find((event) => event.type === "turn.completed" && event.turnId === turnId);
  const errors = events.slice(eventStart).filter((event) => event.type === "runtime.error" && event.turnId === turnId);
  assert.equal(errors.length, 0, JSON.stringify(errors));
  assert(completed?.ok === true, `Grok ${kind} turn must complete successfully: ${JSON.stringify(completed)}`);
  assert(payloads.length > before, "A successful turn must reach the owned provider");
  const requests = payloads.slice(before), names = requests[0]!.tools?.map((tool) => tool.function.name) ?? [];
  evidence.push({ scenario: kind, ok: completed.ok, names, schemaBytes: Buffer.byteLength(JSON.stringify(requests[0]!.tools ?? [])), requests: requests.length });
  return { names, requests, cursor: events.slice(eventStart).find((event) => event.type === "session.started")?.sessionId as string | undefined };
}
try {
  await turn("legacy");
  const denied = await turn("deny", { deny: ["native:run_terminal_command"] });
  assert(!denied.names.includes("run_terminal_command"));
  assert.equal(denied.names.length, 24, "Deny one tool must retain the other available tools");
  const native = await turn("native", { allow: ["native:read_file", "native:search_replace", "native:write"] });
  assert.deepEqual([...native.names].sort(), ["read_file", "search_replace", "write"]);
  assert.equal(readFileSync(artifact, "utf8"), "verified drafting"); assert.equal(existsSync(blocked), false);
  const resumed = await turn("empty", { allow: [] }, native.cursor);
  assert(resumed.requests.every((payload) => (payload.tools ?? []).length === 0), "A restored session must not send its old catalog");
  assert.deepEqual((await turn("unknown", { allow: ["native:unknown_tool"] })).names, []);
  const configPath = join(home, ".grok/config.toml"), config = readFileSync(configPath, "utf8");
  const profile = join(home, "read-only.md");
  writeFileSync(profile, '---\nname: reader\ndescription: Existing restriction\ninjectDefaultTools: false\ntools: [read_file]\ndisallowedTools: [write]\n---\nKeep this profile restricted.\n');
  writeFileSync(configPath, `${config}\n[agent]\ndefinition=${JSON.stringify(profile)}\n`);
  assert.deepEqual((await turn("inherited", { allow: ["native:read_file", "native:write"] })).names, ["read_file"]);
  writeFileSync(configPath, `${config}\n[agent] # owner restriction\ndefinition=${JSON.stringify(profile)} # explicit profile\n`);
  assert.deepEqual((await turn("inherited-comment", { allow: ["native:read_file", "native:write"] })).names, ["read_file"]);
  for (const agentConfig of [`["agent"]\ndefinition=${JSON.stringify(profile)}`, `agent.definition=${JSON.stringify(profile)}`]) {
    writeFileSync(configPath, `${agentConfig}\n${config}`);
    const before = payloads.length;
    await assert.rejects(turn("unsupported-profile-syntax", { allow: ["native:read_file", "native:write"] }), /cannot be safely intersected/);
    assert.equal(payloads.length, before, "Unsupported inherited config syntax must prevent prompting");
  }
  writeFileSync(configPath, config);
  const selected = await turn("mail", { allow: ["native:search_tool", "native:use_tool", "mcp:mail:read_notes"] });
  assert.deepEqual([...selected.names].sort(), ["search_tool", "use_tool"]);
  assert.equal(readFileSync(receipt, "utf8"), "read_notes\n");
  const emptyMail = await turn("empty", { allow: [] }, selected.cursor);
  assert(emptyMail.requests.every((payload) => (payload.tools ?? []).length === 0));
  // A model's strict harness may otherwise replace the inline ACP profile.
  const strictConfig = config.replace(/(\[model\.omlx-fixture\][^[]*)/, '$1agent_type="codex"\n');
  assert.notEqual(strictConfig, config, "Fixture model configuration must be found");
  writeFileSync(configPath, `${strictConfig}\n[models]\ndefault="omlx-fixture"\n`);
  const strict = await turn("strict-model", { allow: [] });
  assert(strict.requests.every((payload) => (payload.tools ?? []).length === 0), "A model switch must not replace the owner selection with its strict harness");
  const strictDraft = await turn("strict-drafting", { allow: ["native:read_file", "native:search_replace", "native:write"] }, strict.cursor);
  assert(strictDraft.requests.every((payload) => JSON.stringify(payload.tools?.map(tool => tool.function.name).sort()) === JSON.stringify(["read_file", "search_replace", "write"])), "A resumed strict-model session must retain only its selected drafting tools");
  writeFileSync(configPath, `${config}\n[mcp_servers.ambient]\ncommand=${JSON.stringify(process.execPath)}\nargs=${JSON.stringify([mail])}\n`);
  const before = payloads.length, eventStart = events.length;
  await instance.adapter.sendTurn({ threadId: "ambient-refusal", cwd: home, text: "Must not run.", model: "omlx::fixture", toolScope: { allow: ["native:read_file"] } });
  const deadline = Date.now() + 20_000;
  while (!events.slice(eventStart).some((event) => event.type === "turn.completed") && Date.now() < deadline) await delay(50);
  assert(events.slice(eventStart).some((event) => event.type === "runtime.error" && /outside the bot's selection/.test(event.message)));
  assert.equal(payloads.length, before, "An ambient MCP connection must prevent the main provider request");
  console.log(JSON.stringify({ ok: true, evidence, approvals, withheldNativeExecuted: false, withheldMcpExecuted: false, auxiliarySessionTitleExcluded: true }));
} finally {
  await instance.dispose(); provider.closeAllConnections(); await new Promise<void>((done) => provider.close(() => done()));
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
