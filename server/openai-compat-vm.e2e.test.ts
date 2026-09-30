// Parity check for #1856: an openai-compat bot on a Local VM must receive the
// same computer/browser tools a claudeAgent bot receives on the same surface.
// The container boundary is the group-local-vm fixture (a state file plus a
// fake `podman` binary that speaks MCP over stdio); the provider is an
// in-process OpenAI-compatible stub that records the tool list per request.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeFileAtomic } from "./atomic.ts";
import { freePortBlock } from "./testing/ports.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
let child: ChildProcess;
let fixtureHome = "";
let base = "";
let stateFile = "";
let dumpFile = "";
let nativeDir = "";
let stderr = "";
let upstream: Server;

type ChatMessage = { role: string; content?: unknown; tool_call_id?: string; tool_calls?: Array<{ id: string }> };
type ChatRequest = { messages: ChatMessage[]; tools?: Array<{ function: { name: string } }> };
const requests: ChatRequest[] = [];
let pendingSelect: { surface: string } | null = null;

const frame = (delta: unknown, finish_reason: string | null) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`;

const FAKE_PODMAN = `#!/usr/bin/env node
'use strict';
const readline = require('node:readline');
const TOOLS = [
  { name: 'screenshot', description: 'Capture the VM screen', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'click', description: 'Click at a point', inputSchema: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'], additionalProperties: false } },
  { name: 'type_text', description: 'Type text', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } },
  { name: 'open_url', description: 'Open a URL in the VM browser', inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'], additionalProperties: false } },
];
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (request.id === undefined) return;
  let result;
  if (request.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake-vm', version: '1' } };
  else if (request.method === 'tools/list') result = { tools: TOOLS };
  else if (request.method === 'tools/call') result = { content: [{ type: 'text', text: 'fake vm ran ' + String(request.params?.name) }] };
  else result = { content: [{ type: 'text', text: 'unsupported call' }], isError: true };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
});
rl.on('close', () => process.exit(0));
`;

const vmState = (state: Record<string, unknown> = {}) => writeFileAtomic(stateFile, JSON.stringify(state));
const api = async (method: string, path: string, body?: unknown, expectedStatus?: number) => {
  const r = await fetch(base + path, { method, headers: { "content-type": "application/json", origin: base },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await r.json() as any;
  if (expectedStatus !== undefined) expect(r.status, `${method} ${path}: ${JSON.stringify(result)}`).toBe(expectedStatus);
  else expect(r.ok, `${method} ${path}: ${JSON.stringify(result)}`).toBe(true);
  return result;
};
async function until<T>(read: () => T | Promise<T>, accept: (value: T) => boolean): Promise<T> {
  const end = Date.now() + 20_000;
  for (;;) {
    const value = await read();
    if (accept(value)) return value;
    if (Date.now() >= end) throw new Error(`Fixture wait expired: ${JSON.stringify(value)}\n${stderr}`);
    await new Promise(r => setTimeout(r, 50));
  }
}
const toolNames = (request: ChatRequest | undefined) => (request?.tools ?? []).map(tool => tool.function.name);
// The native tee (<data>/native/<thread>.ndjson) is what a person pastes into
// a bug report; the openai-compat "out" line must carry the request's tool
// names so a dropped-tool report can be localized to the proxy hop.
const nativeToolNames = (threadId: string): string[] => {
  const file = join(nativeDir, `${threadId}.ndjson`);
  if (!existsSync(file)) return [];
  const names = new Set<string>();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line) as { dir?: string; msg?: { tools?: string[] } };
    if (entry.dir === "out") for (const name of entry.msg?.tools ?? []) names.add(name);
  }
  return [...names];
};
const idle = (botId: string) => until(() => api("GET", "/api/bots?messages=0"), s => !s.bots.find((b: any) => b.id === botId)?.busy);

beforeAll(async () => {
  fixtureHome = mkdtempSync(join(tmpdir(), "omb-openai-vm-"));
  stateFile = join(fixtureHome, "vm.json");
  dumpFile = join(fixtureHome, "dump.json");
  vmState({ containers: [] });
  const fakebin = join(fixtureHome, "fakebin");
  mkdirSync(fakebin);
  writeFileSync(join(fakebin, "podman"), FAKE_PODMAN, { mode: 0o700 });
  chmodSync(join(fakebin, "podman"), 0o700);

  upstream = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/v1/models") return res.end(JSON.stringify({ data: [{ id: "fixture-model" }] }));
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const request = JSON.parse(raw || "{}") as ChatRequest;
    requests.push(request);
    const toolResult = request.messages?.some(message => message.role === "tool");
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (toolResult) {
      res.end(frame({ content: "Selection acknowledged; waiting for the new surface." }, "stop") + "data: [DONE]\n\n");
    } else if (pendingSelect) {
      const call = { index: 0, id: "select-call", type: "function", function: { name: "agents_select_computer", arguments: JSON.stringify({ surface: pendingSelect.surface }) } };
      pendingSelect = null;
      res.end(frame({ tool_calls: [call] }, "tool_calls") + "data: [DONE]\n\n");
    } else {
      res.end(frame({ content: "Done." }, "stop") + "data: [DONE]\n\n");
    }
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = (upstream.address() as { port: number }).port;

  const data = join(fixtureHome, "data");
  nativeDir = join(data, "native");
  const ui = join(fixtureHome, "static");
  mkdirSync(data);
  mkdirSync(join(ui, "assets"), { recursive: true });
  writeFileSync(join(ui, "index.html"), "<title>openai-compat VM tools</title>");
  writeFileSync(join(ui, "assets", "test.css"), "body{}");
  writeFileSync(join(data, "config.json"), JSON.stringify({
    // Per-bot isolation, matching the #1856 report: each bot gets its own
    // derived container target, so a fresh bot's VM is unseen until the
    // computer panel or a turn touches it — the strict pin cannot hide
    // behind a warm shared-VM cache entry.
    localVm: { mode: "per-bot" },
    instances: { claude: {
      driver: "claudeAgent",
      config: { cli: join(ROOT, "server/testing/fake-claude-cli.ts") },
      environment: { FAKE_CLAUDE_DUMP: dumpFile },
    } },
  }));

  const port = await freePortBlock([0, 1]);
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [
    "--experimental-strip-types",
    "--import", pathToFileURL(join(ROOT, "server/testing/group-local-vm-hooks.mjs")).href,
    join(ROOT, "server/index.ts"),
  ], {
    cwd: ROOT,
    env: {
      PATH: [fakebin, dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter),
      HOME: fixtureHome, USERPROFILE: fixtureHome, OMB_DATA_DIR: data,
      APPDATA: join(fixtureHome, "appdata"), LOCALAPPDATA: join(fixtureHome, "localappdata"),
      TEMP: fixtureHome, TMP: fixtureHome, TMPDIR: fixtureHome,
      OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1), OMB_STATIC_DIR: ui,
      OMB_TEST_VM_STATE: stateFile, OMB_EXTRA_PATH: fakebin,
      OMB_USER_DATA: join(fixtureHome, "user-data"),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout!.on("data", () => {});
  child.stderr!.on("data", c => { stderr += c; });
  await until(async () => {
    if (child.exitCode !== null) throw new Error(stderr);
    try { return (await fetch(base + "/api/health")).ok; } catch { return false; }
  }, Boolean);
  await api("PATCH", "/api/config", { openaiCompat: { key: "fixture-key", url: `http://127.0.0.1:${upstreamPort}/v1`, model: "fixture-model" } });
});

afterAll(async () => {
  await waitForExit(child, { signal: "SIGTERM" });
  if (upstream) await new Promise<void>(resolve => upstream.close(() => resolve()));
  if (fixtureHome) await removeTempDir(fixtureHome);
});

// The openai-compat turns mount the real computer server, whose bridge
// (mcp-bridge.ts) spawns the runtime with a plain spawn: Windows launches only
// a .com/.exe that way, so the extensionless node-script `podman` above can
// never start there and the mount fails before any request (the product finds
// Podman Desktop's podman.exe). Same fixture limit as container-mcp.test.ts;
// the claudeAgent control below only builds the config and still runs there.
const itWithFakeRuntime = it.skipIf(process.platform === "win32");

describe("openai-compat Local VM tools", () => {
  itWithFakeRuntime("mounts the Local VM tools on a strict Works on: Local VM turn", async () => {
    vmState({ containers: [] });
    requests.length = 0;
    const { bot } = await api("POST", "/api/bots", { name: "openai strict vm" });
    await api("PATCH", `/api/bots/${bot.id}`, { computer: "vm" });
    await api("PATCH", `/api/bots/${bot.id}/model`, { instanceId: "openaiCompat", model: "fixture-model" });
    await api("POST", `/api/bots/${bot.id}/messages`, { text: "Take a screenshot of the desktop." });
    await until(() => requests.length, count => count >= 1);
    await idle(bot.id);
    expect(toolNames(requests[0])).toContain("computer_screenshot");
    expect(toolNames(requests[0])).toContain("agents_select_computer");
    // The same list must land in the native tee: #1856 could not be
    // diagnosed because the openai-compat driver's outgoing record held
    // only the model and a message count — never the mounted tools.
    await until(() => nativeToolNames(bot.threadId), names => names.length > 0);
    expect(nativeToolNames(bot.threadId)).toContain("computer_screenshot");
  }, 60_000);

  itWithFakeRuntime("mounts the Local VM tools on the select_computer continuation", async () => {
    vmState({ containers: [] });
    requests.length = 0;
    pendingSelect = null;
    const { bot } = await api("POST", "/api/bots", { name: "openai select vm" });
    await api("PATCH", `/api/bots/${bot.id}/model`, { instanceId: "openaiCompat", model: "fixture-model" });
    pendingSelect = { surface: "vm" };
    await api("POST", `/api/bots/${bot.id}/messages`, { text: "Open a browser on my Local VM." });
    // Turn 1: the model picks the Local VM through select_computer. Under the
    // default Ask approval that call waits on the person's card; allow it, the
    // turn ends after the tool result, and the continuation reconnects on the VM.
    const card = await until(async (): Promise<{ requestId: string } | null> => {
      const state = await api("GET", "/api/bots");
      const current = state.bots.find((item: any) => item.id === bot.id);
      return current?.messages?.find((message: any) => message.card?.requestId && !message.card.answered)?.card ?? null;
    }, Boolean);
    await api("POST", `/api/bots/${bot.id}/respond`, { threadId: bot.threadId, requestId: card!.requestId, behavior: "allow" });
    try {
      await until(() => requests.length, count => count >= 3);
    } catch (error) {
      const state = await api("GET", "/api/bots");
      const current = state.bots.find((item: any) => item.id === bot.id);
      console.error("CONTINUATION MISSING", JSON.stringify({
        requests: requests.map(r => ({ tools: toolNames(r), roles: r.messages?.map(m => m.role) })),
        messages: current?.messages?.map((m: any) => ({ role: m.role, kind: m.kind, text: m.text, tool: m.tool, error: m.error })),
      }, null, 2));
      throw error;
    }
    await idle(bot.id);
    const continuation = requests[2];
    expect(toolNames(continuation), JSON.stringify({ tools: toolNames(continuation), requests: requests.length })).toContain("computer_screenshot");
    expect(toolNames(continuation)).toContain("agents_select_computer");
  }, 60_000);

  it("mounts the Local VM for a claudeAgent control on the same surface", async () => {
    vmState({ containers: [] });
    const { bot } = await api("POST", "/api/bots", { name: "claude strict vm" });
    await api("PATCH", `/api/bots/${bot.id}`, { computer: "vm" });
    await api("POST", `/api/bots/${bot.id}/messages`, { text: "Take a screenshot of the desktop." });
    const dump = await until((): { mcpConfig?: { mcpServers?: Record<string, { env?: Record<string, string> }> } } | null => {
      if (!existsSync(dumpFile)) return null;
      try { return JSON.parse(readFileSync(dumpFile, "utf8")); } catch { return null; }
    }, Boolean);
    await idle(bot.id);
    expect(dump!.mcpConfig?.mcpServers?.computer).toBeTruthy();
    expect(String(dump!.mcpConfig!.mcpServers!.computer.env?.OMB_CONTROL_URL ?? "")).toContain("127.0.0.1");
  }, 60_000);
});
