#!/usr/bin/env node
// Fake of an ACP CLI's stdio surface (JSON-RPC 2.0: initialize, authenticate, session/new,
// session/prompt and scripted session/update streams) for driver tests. Env knobs:
//   FAKE_ACP_LOAD_NULL  session/load returns null, so the driver falls through to session/new
//   FAKE_ACP_REJECT_LIVE_LOAD_FILE  while it exists, load/resume of a session live in this process errors
//   FAKE_ACP_CACHED_LIVE_LOAD  a live session/load is acknowledged but keeps the old MCP credentials, like Qwen
//   FAKE_ACP_TEXT_REPLY  answer every session/prompt with only this text
//   FAKE_ACP_MODE  happy (default) | image | empty-reply | reasoning-only | exit-early | fail-after-text | crash-in-prompt | hang
//     | hang-initialize | unkeyed-tool | finished-tools (tool_call frames that arrive already completed or failed, one updated again)
//     | no-auth | auth-required | permission | question
//     | ask-question (a mid-prompt vendor question: FAKE_ACP_ASK_METHOD, default cursor/ask_question, params
//       FAKE_ACP_ASK_PARAMS; the client's reply is written to FAKE_ACP_ASK_ANSWER. FAKE_ACP_ASK_TIMING=with-result
//       settles the turn with the card open; after-result asks between turns)
//     | interleave (message, tool, message, tool, message) | no-session-config (set_mode/set_model answer -32601)
//     | ask-peer | delegate-peer | chief-delegate | create-peer (coordinate_bots through the injected agents
//       MCP; FAKE_ACP_REDELEGATE_FILE, FAKE_ACP_TASKID_FILE; a hand-off result wake gets a fixed line)
//     | echo-gated (echo the whole prompt; hold until FAKE_ACP_GATE_FILE exists) | safe-agent-reads
//     | stall-after-text | stall-after-tool (then silent forever) | slow-tool (silent for FAKE_ACP_TOOL_MS, or until
//       FAKE_ACP_TOOL_GATE exists when set; FAKE_ACP_TOOL_OUTPUT is the text its running call shows meanwhile)
//     | quiet-then-answer (silent for FAKE_ACP_QUIET_MS; with QWEN_HOME, append FAKE_ACP_QWEN_LOG lines to
//       Qwen's debug log every FAKE_ACP_LOG_EVERY_MS; with XDG_DATA_HOME, append FAKE_ACP_OPENCODE_LOG lines once to
//       OpenCode's shared log, {session} replaced by the session id) | mcp-tools (list each mcpServers entry's tools with
//       grok 1.0.25's initialize, or FAKE_ACP_MCP_HANDSHAKE; FAKE_ACP_MCP_SCHEMA_BYTES=1 adds each schema's length)
//     | lend-question (list_shared_computers around a question)
//     | list-peers (list_bots through the agents MCP; keeps the first agents server it is offered, like Hermes)
//   FAKE_ACP_MCP_TRANSPORTS  remote MCP transports advertised in initialize, e.g. "http,sse"
//   FAKE_ACP_PERMISSION_OPTIONS  JSON options override in permission mode
//   FAKE_ACP_DUMP  path for {argv, env}; with FAKE_ACP_MODES or FAKE_ACP_MODELS also <dump>.prompts.jsonl
//   FAKE_ACP_LAUNCH_COUNT_FILE  process counter incremented at startup
//   FAKE_ACP_RPC_DUMP  this process's method list, rewritten after every request
//   FAKE_ACP_RPC_APPEND_FILE  one {"pid","method","cwd"} line appended per request
//   FAKE_ACP_RPC_FAILURE_FILE  JSON-RPC error for session/prompt; once read the process stays poisoned
//   FAKE_ACP_RPC_FAILURE_METHOD  initialize, session/new or session/prompt (default)
//   FAKE_ACP_RPC_FAILURE_GATE  hold the error until this file exists
//   FAKE_ACP_RPC_FAILURE_AFTER_OUTPUT  emit text and a tool result before failing
//   FAKE_ACP_RPC_FAILURE_AFTER_USAGE  emit the scripted usage updates and FAKE_ACP_UPDATES_FILE's before failing
//   FAKE_ACP_LOAD_ERROR  JSON-RPC error returned by session/load
//   FAKE_ACP_MODELS  model ids: opencode-shaped configOptions and set_config_option (-32602 for others);
//     a new session starts on AGY_ACP_DEFAULT_MODEL when set, taken unchecked as agy_acp_server 1.1.1 does
//   FAKE_ACP_MODELS_FILE  the same list, read once at startup, as `opencode acp` never re-reads a login
//   FAKE_ACP_MODELS_LIST=v2  OpenCode 2: `models` answers empty with exit 0, `models --verbose` exits 1
//   FAKE_ACP_VERBOSE_FAIL_ONCE  marker path: the first `models --verbose` fails, like a new OpenCode home's first run
//   FAKE_ACP_MODEL_STICKS  set_config_option succeeds but keeps the old model
//   FAKE_ACP_EXIT_ON_MODEL  the process exits when set_config_option selects this model
//   FAKE_ACP_VARIANTS  JSON map model -> {id?, currentValue?, options} of ACP select values
//   FAKE_ACP_CONFIG_UPDATES  JSON [{after, sessionId?, configOptions, replay?}] emitted after the named response
//   FAKE_ACP_USAGE_ROOT  usage at the prompt result's root, as opencode 1.18.18 sends it
//   FAKE_ACP_USAGE_UPDATES_FILE  JSON numbers re-read per prompt, each sent as usage_update {used, size: 200000}
//   FAKE_ACP_UPDATES_FILE  JSON array of session/update params ({update, _meta?}) re-read per prompt, sent as-is
//   FAKE_ACP_MODE_ACK_FILE  while it exists a mode switch answers "empty" (no configOptions) or "error"
//   FAKE_ACP_HANG_ON  a prompt whose text holds this hangs as in mode hang; others answer
//   FAKE_ACP_CURSOR_FAST=1  a `fast` select ("true") once initialize declares _meta.parameterizedModelPicker, as Cursor CLI 2026.10.19; =stuck acknowledges set_config_option but keeps "true"
//   FAKE_ACP_SESSION_CLOSE=1  initialize advertises sessionCapabilities.close (OpenCode 1.19); session/close answers {}
//     after FAKE_ACP_SESSION_CLOSE_MS; =error advertises it and answers every session/close with an error
//   FAKE_ACP_IGNORE_CANCEL=1  session/cancel is ignored: a hanging prompt keeps running
//   FAKE_ACP_TOOL_LIMIT  session/prompt lists the session's MCP tools and refuses, as OpenCode Zen does, past this many;
//     under it the reply is "tools: <server>=<count>,…"
//   FAKE_ACP_CANCEL_STOP_REASON  the stopReason a cancelled hanging prompt answers (default cancelled; OpenCode answers end_turn)
//   FAKE_ACP_HANG_ONCE_FILE  with FAKE_ACP_HANG_ON, only the first matching prompt hangs; it writes this file
//   FAKE_ACP_HOLD_FILE  while this file exists, a session/prompt waits before it is answered
import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

const mode = process.env.FAKE_ACP_MODE ?? "happy";

// Follow the spawning server down; on Windows ppid does not change after parent exit.
{
  const spawner = process.ppid;
  const orphanWatch = setInterval(() => {
    if (process.ppid !== spawner) process.exit(0);
    try { process.kill(spawner, 0); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") process.exit(0);
    }
  }, 500);
  orphanWatch.unref();
}
const ONE_PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const modelsText = process.env.FAKE_ACP_MODELS_FILE && existsSync(process.env.FAKE_ACP_MODELS_FILE)
  ? readFileSync(process.env.FAKE_ACP_MODELS_FILE, "utf8")
  : process.env.FAKE_ACP_MODELS ?? "";
// One id per line when the list holds a newline (DeepSeek's wire values are JSON pairs with commas); else comma-separated.
const models = modelsText.split(modelsText.includes("\n") ? "\n" : ",").map((id) => id.trim()).filter(Boolean);
const defaultModelEnv = process.env.AGY_ACP_DEFAULT_MODEL;
if (models.length && defaultModelEnv && !models.includes(defaultModelEnv)) models.push(defaultModelEnv);
let currentModel: string | null = models.length && defaultModelEnv ? defaultModelEnv : models[0] ?? null;
const variantConfigs: Record<string, { id?: string; currentValue?: string; options: any[] }> =
  JSON.parse(process.env.FAKE_ACP_VARIANTS ?? "{}");
let currentVariant = variantConfigs[currentModel ?? ""]?.currentValue;
const variantValues = (entries: any[]): string[] => entries.flatMap((entry) => (
  typeof entry?.value === "string" ? [entry.value] : Array.isArray(entry?.options) ? variantValues(entry.options) : []
));
const modes = (process.env.FAKE_ACP_MODES ?? "").split(",").filter(Boolean);
let currentMode: string | null = modes[0] ?? null;
let currentFast: string | null = null;
const taskIdFile = process.env.FAKE_ACP_TASKID_FILE ?? "";
const peerIdOf = (list: string): string => /id: ([\w-]+)/.exec(list)?.[1] ?? "";
function handoffCall(message: string, options: { consult?: boolean; reason?: string; doneWhen?: string } = {}): { name: string; args: (list: string) => object } {
  const reason = options.reason ? { reason: options.reason } : {};
  const doneWhen = options.doneWhen ? { done_when: options.doneWhen } : {};
  return { name: "coordinate_bots", args: (list) => ({ bot_ids: [peerIdOf(list)], message, ...(options.consult ? { consult: true } : {}), ...reason, ...doneWhen }) };
}
const handoffIdOf = (reply: string): string => /"requestId":"([\w-]+)"/.exec(reply)?.[1] ?? "";
const statusCall = (id: string): { name: string; args: () => object } => ({ name: "assignment_status", args: () => ({ id }) });
const logFile = process.env.FAKE_ACP_LOG_FILE ?? "";
const rejectLiveLoadFile = process.env.FAKE_ACP_REJECT_LIVE_LOAD_FILE ?? "";
function fakeLog(line: string): void {
  if (!logFile) return;
  try {
    appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`);
  } catch {}
}
let chiefDelegatedTaskId = "";
function rememberDelegatedTaskId(id: string): void {
  chiefDelegatedTaskId = id;
  if (taskIdFile) {
    try {
      writeFileSync(taskIdFile, id);
    } catch {}
  }
}
function savedDelegatedTaskId(): string {
  if (chiefDelegatedTaskId) return chiefDelegatedTaskId;
  if (taskIdFile && existsSync(taskIdFile)) {
    try {
      chiefDelegatedTaskId = readFileSync(taskIdFile, "utf8").trim();
    } catch {}
  }
  return chiefDelegatedTaskId;
}
const configOptions = () => {
  const variant = variantConfigs[currentModel ?? ""];
  const options = [
    ...(models.length ? [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: currentModel,
          options: models.map((value) => ({ value, name: value })),
        },
      ] : []),
    ...(variant ? [{
      id: variant.id ?? "effort",
      name: "Effort",
      category: "thought_level",
      type: "select",
      currentValue: currentVariant,
      options: variant.options,
    }] : []),
    ...(modes.length ? [{
      id: "mode",
      name: "Mode",
      category: "mode",
      type: "select",
      currentValue: currentMode,
      options: modes.map((value) => ({ value, name: value })),
    }] : []),
    ...(currentFast ? [{
      id: "fast",
      name: "Fast",
      type: "select",
      currentValue: currentFast,
      options: [{ value: "true", name: "On" }, { value: "false", name: "Off" }],
    }] : []),
  ];
  return options.length ? options : null;
};
// FAKE_ACP_SESSION_MODELS "id|Name,id|Name": cursor-shaped `models.availableModels` whose ids
// (`default[]`) differ from argv slugs (`auto`); commas inside `[...]` do not split an id.
const acpModels = (process.env.FAKE_ACP_SESSION_MODELS ?? "")
  .split(/,(?![^[]*\])/)
  .filter(Boolean)
  .map((entry) => {
    const [modelId, name] = entry.split("|");
    return name ? { modelId, name } : { modelId };
  });
const sessionModels = () =>
  acpModels.length ? { currentModelId: acpModels[0].modelId, availableModels: acpModels } : null;

const argv = process.argv.slice(2);
const dumpEnv = Object.fromEntries(
  [
    "PATH",
    "HOME",
    "USERPROFILE",
    "TEMP",
    "TMP",
    "SystemRoot",
    "FAKE_ACP_MODE",
    "FAKE_ACP_RPC_DUMP",
    "FAKE_ACP_IMAGE_CAPABILITY",
    "FAKE_ACP_DUMP_PROMPT",
    "TEST_POLICY",
    "OPENCODE_API_KEY",
    "OPENCODE_PERMISSION",
    "OPENCODE_DISABLE_AUTOUPDATE",
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
    "ANTHROPIC_API_KEY",
    "XAI_API_KEY",
    "GROK_AGENT",
    "BOX_TOKEN",
    "OMB_TTS_KEY",
    "OMB_FISH_AUDIO_API_KEY",
    "OMB_CLOUD_READY_TOKEN",
    "OMB_CLOUD_BOOTSTRAP",
    "OMB_LICENSE_KEY",
    "OMB_INSTALLATION_CREDENTIAL",
    "FACTORY_API_KEY",
    "UNSLOTH_STUDIO_AUTH_TOKEN",
    "CURSOR_API_KEY",
    "CLINE_API_KEY",
    "CLINE_PROVIDER",
    "CLINE_MODEL",
    "CLINE_MCP_SETTINGS_PATH",
    "CURSOR_AUTH_TOKEN",
    "KIMI_MODEL_NAME",
    "KIMI_MODEL_API_KEY",
    "KIMI_MODEL_BASE_URL",
    "KIMI_MODEL_PROVIDER_TYPE",
    "KIMI_MODEL_DISPLAY_NAME",
    "TEST_TURN_MODEL",
    "MY_AGENT_TOKEN",
    "VENICE_API_KEY",
    "GEMINI_HOME",
    "AGY_ACP_FORCE_FILE_STORAGE",
    "ANTIGRAVITY_HARNESS_PATH",
    "AGY_ACP_DEFAULT_MODEL",
    "OPENCODE_DISABLE_PROJECT_CONFIG",
    "GEMINI_API_KEY",
    "MISTRAL_API_KEY",
    "OMB_ANTHROPIC_API_KEY",
    "COPILOT_ALLOW_ALL",
    "COPILOT_GITHUB_TOKEN",
    "GH_TOKEN",
    "GITHUB_TOKEN",
  ].flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]]] as const)),
);
const dumpState: Record<string, unknown> = { argv, env: dumpEnv, pid: process.pid };
const writeDumpAtomic = (path: string, contents: string): void => {
  const tmp = `${path}.${process.pid}.tmp`;
  const delays = [5, 10, 20, 40, 80];
  try {
    writeFileSync(tmp, contents);
    for (let attempt = 0; ; attempt += 1) {
      try {
        renameSync(tmp, path);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? "";
        if (!["EPERM", "EACCES", "EBUSY"].includes(code) || attempt >= delays.length) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delays[attempt]);
      }
    }
  } finally {
    try { unlinkSync(tmp); } catch {}
  }
};
if (process.env.FAKE_ACP_DUMP) {
  writeDumpAtomic(process.env.FAKE_ACP_DUMP, JSON.stringify(dumpState, null, 2));
}
if (process.env.FAKE_ACP_LAUNCH_COUNT_FILE) {
  let launches = 0;
  try {
    launches = Number.parseInt(readFileSync(process.env.FAKE_ACP_LAUNCH_COUNT_FILE, "utf8").trim(), 10) || 0;
  } catch {}
  try {
    writeFileSync(process.env.FAKE_ACP_LAUNCH_COUNT_FILE, String(launches + 1));
  } catch {}
}
if (argv.includes("--version")) {
  console.log("fake-acp 1.0.0");
  process.exit(0);
}
// Cursor's driver probes `agent status` / `agent models` on the binary it spawns for ACP.
if (argv[0] === "status" || argv[0] === "whoami") {
  const authenticated = process.env.FAKE_ACP_AUTH !== "0";
  console.log(JSON.stringify({ isAuthenticated: authenticated }));
  process.exit(0);
}
if (argv[0] === "models" || argv.includes("--list-models")) {
  const failOnce = process.env.FAKE_ACP_VERBOSE_FAIL_ONCE;
  if (failOnce && argv.includes("--verbose") && !existsSync(failOnce)) {
    writeFileSync(failOnce, "failed once\n");
    console.error("Failed to run the query 'CREATE TABLE `workspace` (…)'");
    process.exit(1);
  }
  if (process.env.FAKE_ACP_MODELS_LIST === "v2") {
    if (argv.includes("--verbose")) {
      console.error("Unrecognized flag: --verbose");
      process.exit(1);
    }
    process.exit(0);
  }
  if (models.length) {
    const verbose = argv.includes("--verbose");
    console.log(
      models.flatMap((slug) => verbose
        ? [
            slug,
            JSON.stringify({
              id: slug.slice(slug.indexOf("/") + 1),
              providerID: slug.slice(0, slug.indexOf("/")),
              name: slug,
              status: "active",
              limit: { context: 200_000 },
            }, null, 2),
          ]
        : [slug]).join("\n"),
    );
    process.exit(0);
  }
  console.log(
    [
      "Available models",
      "",
      "auto - Auto (default)",
      "composer-2.5 - Composer 2.5 (current)",
      "gpt-5.3-codex - Codex 5.3",
      "cursor-live - Cursor Live",
    ].join("\n"),
  );
  process.exit(0);
}

// ACP names the session in every update and request: the one whose request this answers, or the live one.
const answering = new AsyncLocalStorage<string>();
const out = (obj: any) => {
  if ((obj?.method === "session/update" || obj?.method === "session/request_permission") && obj.params && obj.params.sessionId === undefined) {
    obj = { ...obj, params: { sessionId: answering.getStore() ?? liveSession ?? "fake-acp-session", ...obj.params } };
  }
  process.stdout.write(JSON.stringify(obj) + "\n");
};
const result = (id: unknown, res: unknown) => out({ jsonrpc: "2.0", id, result: res });
const configUpdates = JSON.parse(process.env.FAKE_ACP_CONFIG_UPDATES ?? "[]") as Array<{
  after: string; sessionId?: string; configOptions: unknown[]; replay?: boolean;
}>;
const emitConfigUpdates = (after: string, sessionId: string) => {
  for (const update of configUpdates.filter((entry) => entry.after === after)) {
    out({
      jsonrpc: "2.0", method: "session/update", params: {
        sessionId: update.sessionId ?? sessionId,
        ...(update.replay ? { _meta: { isReplay: true } } : {}),
        update: { sessionUpdate: "config_option_update", configOptions: update.configOptions },
      },
    });
  }
};
// Response and updates go in one chunk to exercise wire ordering.
const resultAndConfigUpdates = (id: unknown, res: unknown, after: string, sessionId: string) => {
  const updates = configUpdates.filter((entry) => entry.after === after).map((update) => ({
    jsonrpc: "2.0", method: "session/update", params: {
      sessionId: update.sessionId ?? sessionId,
      ...(update.replay ? { _meta: { isReplay: true } } : {}),
      update: { sessionUpdate: "config_option_update", configOptions: update.configOptions },
    },
  }));
  process.stdout.write([{ jsonrpc: "2.0", id, result: res }, ...updates].map((message) => JSON.stringify(message)).join("\n") + "\n");
};
const rpcMethods: string[] = [];
const recordMethod = (method: string) => {
  rpcMethods.push(method);
  if (process.env.FAKE_ACP_RPC_DUMP) writeFileSync(process.env.FAKE_ACP_RPC_DUMP, JSON.stringify(rpcMethods));
  if (process.env.FAKE_ACP_RPC_APPEND_FILE) {
    try {
      appendFileSync(process.env.FAKE_ACP_RPC_APPEND_FILE, JSON.stringify({ pid: process.pid, method, cwd: process.cwd() }) + "\n");
    } catch {}
  }
};

const configCalls: Array<{ method: string; params: unknown }> = [];

let pendingPermissionId: number | null = null;
let onPermissionAnswered: ((allowed: boolean) => void) | null = null;
let lastPermissionCancelled = false;
let pendingAskQuestionId: number | null = null;
let onAskQuestionAnswered: (() => void) | null = null;

let hangingPromptId: unknown = null;
let hangKeepAlive: ReturnType<typeof setInterval> | null = null;

type McpEntry = { command: string; args?: string[]; env?: Array<{ name: string; value: string }> };
let agentsMcp: McpEntry | null = null;
type AnyMcpEntry = { name: string; command?: string; args?: string[]; env?: Array<{ name: string; value: string }>; url?: string; headers?: Array<{ name: string; value: string }> };
let sessionMcp: AnyMcpEntry[] = [];
/** grok 1.0.25's initialize (`grok mcp doctor`) */
const GROK_MCP_HANDSHAKE = { protocolVersion: "2025-11-25", capabilities: { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } }, clientInfo: { name: "grok-shell", version: "1.0.25" } };

async function listMcpTools(entry: AnyMcpEntry, handshake: unknown): Promise<string[]> {
  const names = (result: any) => (result?.tools ?? []).map((tool: { name: string; inputSchema?: unknown }) =>
    process.env.FAKE_ACP_MCP_SCHEMA_BYTES === "1" ? `${tool.name}=${JSON.stringify(tool.inputSchema ?? {}).length}` : tool.name);
  if (typeof entry.url === "string") {
    const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    for (const { name, value } of entry.headers ?? []) headers[name] = value;
    const post = async (frame: object) => {
      const response = await fetch(entry.url!, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", ...frame }), signal: AbortSignal.timeout(20_000) });
      const session = response.headers.get("mcp-session-id");
      if (session) headers["mcp-session-id"] = session;
      const text = await response.text();
      const body = text.split("\n").find((line) => line.startsWith("data:"))?.slice(5) ?? text;
      const parsed = body.trim() ? JSON.parse(body) : {};
      if (!response.ok || parsed.error) throw new Error(`HTTP ${response.status} ${parsed.error?.message ?? ""}`.trim());
      return parsed.result;
    };
    await post({ id: 1, method: "initialize", params: handshake });
    await post({ method: "notifications/initialized" });
    return names(await post({ id: 2, method: "tools/list", params: {} }));
  }
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    for (const { name, value } of entry.env ?? []) env[name] = value;
    const child = spawn(entry.command!, entry.args ?? [], { env, stdio: ["pipe", "pipe", "ignore"] });
    const finish = (error: Error | null, tools?: string[]) => { clearTimeout(timer); child.kill(); if (error) reject(error); else resolve(tools!); };
    const timer = setTimeout(() => finish(new Error("mcp timeout")), 20_000);
    child.on("error", (error) => finish(error));
    const write = (frame: object) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...frame })}\n`);
    let pending = "";
    child.stdout.on("data", (chunk) => {
      pending += chunk;
      for (let nl = pending.indexOf("\n"); nl !== -1; nl = pending.indexOf("\n")) {
        const line = pending.slice(0, nl);
        pending = pending.slice(nl + 1);
        let frame: any;
        try { frame = JSON.parse(line); } catch { continue; }
        if (frame.error) return finish(new Error(String(frame.error.message)));
        if (frame.id === 1) { write({ method: "notifications/initialized" }); write({ id: 2, method: "tools/list", params: {} }); }
        if (frame.id === 2) return finish(null, names(frame.result));
      }
    });
    write({ id: 1, method: "initialize", params: handshake });
  });
}
let liveSession: string | null = null;
let sessionsOpened = 0;
let rpcFailure: unknown = null;
function emitSessionReports(): void {
  const updatesFile = process.env.FAKE_ACP_UPDATES_FILE;
  if (updatesFile && existsSync(updatesFile)) {
    try {
      for (const params of JSON.parse(readFileSync(updatesFile, "utf8")) as unknown[]) {
        if (params && typeof params === "object") out({ jsonrpc: "2.0", method: "session/update", params });
      }
    } catch {}
  }
  const usageFile = process.env.FAKE_ACP_USAGE_UPDATES_FILE;
  if (usageFile && existsSync(usageFile)) {
    try {
      for (const used of JSON.parse(readFileSync(usageFile, "utf8")) as unknown[]) {
        if (typeof used === "number") {
          out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "usage_update", used, size: 200000 } } });
        }
      }
    } catch {}
  }
}
function failRpc(msg: { method: string; id: unknown }): boolean {
  if (msg.method !== (process.env.FAKE_ACP_RPC_FAILURE_METHOD ?? "session/prompt")) return false;
  const failureFile = process.env.FAKE_ACP_RPC_FAILURE_FILE;
  if (failureFile && existsSync(failureFile)) rpcFailure = JSON.parse(readFileSync(failureFile, "utf8"));
  if (!rpcFailure) return false;
  if (msg.method === "session/prompt" && process.env.FAKE_ACP_RPC_FAILURE_AFTER_USAGE === "1") emitSessionReports();
  if (msg.method === "session/prompt" && process.env.FAKE_ACP_RPC_FAILURE_AFTER_OUTPUT === "1") playTurn();
  const fail = () => {
    recordMethod(`${msg.method}.error`);
    out({ jsonrpc: "2.0", id: msg.id, error: rpcFailure });
  };
  const gate = process.env.FAKE_ACP_RPC_FAILURE_GATE;
  if (gate && !existsSync(gate)) {
    const timer = setInterval(() => {
      if (!existsSync(gate)) return;
      clearInterval(timer);
      fail();
    }, 20);
  } else fail();
  return true;
}

function driveMcp(entry: McpEntry, calls: Array<{ name: string | (() => string); args: (prev: string) => object }>, strict = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    for (const { name, value } of entry.env ?? []) env[name] = value;
    const child = spawn(entry.command, entry.args ?? [], { env, stdio: ["pipe", "pipe", "inherit"] });
    child.on("error", reject);
    const timer = setTimeout(() => (child.kill(), reject(new Error("mcp timeout"))), 60_000);
    let step = -1; // -1 = initialize in flight
    let last = "";
    const write = (obj: unknown) => child.stdin.write(JSON.stringify(obj) + "\n");
    const next = () => {
      step += 1;
      if (step >= calls.length) {
        clearTimeout(timer);
        child.kill();
        return resolve(last);
      }
      const call = calls[step];
      const args = call.args(last);
      write({ jsonrpc: "2.0", id: step + 2, method: "tools/call", params: { name: typeof call.name === "function" ? call.name() : call.name, arguments: args } });
    };
    let buf = "";
    child.stdout.on("data", (c) => {
      buf += c;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === undefined) continue;
        if (msg.error || (strict && msg.result?.isError)) {
          clearTimeout(timer);
          child.kill();
          reject(new Error(`Fixture MCP request failed: ${JSON.stringify(msg.error ?? msg.result)}`));
          return;
        }
        if (step === -1) {
          write({ jsonrpc: "2.0", method: "notifications/initialized" });
          next();
          continue;
        }
        last = String(msg.result?.content?.[0]?.text ?? "");
        next();
      }
    });
    write({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
  });
}

function playTurn() {
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "hello from fake acp" } } } });
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call", toolCallId: "tc-1", title: "run", rawInput: { path: "/fixture/readme.md", password: "acp-input-secret" } } } });
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call_update", toolCallId: "tc-1", status: "completed", rawOutput: { text: "fixture file content", api_key: "acp-output-secret" } } } });
}

function playInterleaveTurn() {
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "before one" } } } });
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call", toolCallId: "tc-1", title: "run" } } });
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call_update", toolCallId: "tc-1", status: "completed" } } });
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "before two" } } } });
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call", toolCallId: "tc-2", title: "run" } } });
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call_update", toolCallId: "tc-2", status: "completed" } } });
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "after" } } } });
}

function playReasoningTurn() {
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_thought_chunk", content: { text: "considering the request at length" } } } });
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_thought_chunk", content: { text: " without ever producing an answer" } } } });
}

let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    const sessionId = msg.params?.sessionId;
    if (typeof sessionId === "string") answering.run(sessionId, () => handle(msg));
    else handle(msg);
  }
});

function heldByHoldFile(msg: any): boolean {
  const hold = process.env.FAKE_ACP_HOLD_FILE;
  if (!hold || !existsSync(hold)) return false;
  const poll = setInterval(() => {
    if (existsSync(hold)) return;
    clearInterval(poll);
    handle(msg);
  }, 50);
  return true;
}

function handle(msg: any) {
  if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined) && msg.id === pendingAskQuestionId) {
    pendingAskQuestionId = null;
    if (process.env.FAKE_ACP_ASK_ANSWER) {
      // Written aside and renamed in, so a test that sees the file never reads it half-written.
      const partial = `${process.env.FAKE_ACP_ASK_ANSWER}.partial`;
      writeFileSync(partial, JSON.stringify(msg.error !== undefined ? { error: msg.error } : { result: msg.result }));
      renameSync(partial, process.env.FAKE_ACP_ASK_ANSWER);
    }
    onAskQuestionAnswered?.();
    return;
  }
  if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined) && msg.id === pendingPermissionId) {
    pendingPermissionId = null;
    const chosen = msg.result?.outcome?.optionId;
    lastPermissionCancelled = msg.result?.outcome?.outcome === "cancelled";
    // FAKE_ACP_PERMISSION_ANSWER: the option the client picked.
    if (process.env.FAKE_ACP_PERMISSION_ANSWER) writeFileSync(process.env.FAKE_ACP_PERMISSION_ANSWER, String(chosen ?? "cancelled"));
    onPermissionAnswered?.(typeof chosen === "string" && chosen.startsWith("allow"));
    return;
  }
  if (!msg.method) return;
  if (msg.method === "session/prompt" && heldByHoldFile(msg)) return;
  recordMethod(msg.method);

  switch (msg.method) {
    case "initialize": {
      if (failRpc(msg)) break;
      if (mode === "hang-initialize") {
        setInterval(() => {}, 1_000);
        return;
      }
      if (mode === "exit-early") {
        process.stderr.write("fake-acp: simulated crash before result\n");
        process.exit(3);
      }
      const authMethods = mode === "no-auth" ? [] : [{ id: process.env.FAKE_ACP_AUTH_METHOD ?? "cached_token" }];
      const agentName = process.env.FAKE_ACP_AGENT_NAME;
      const acceptsImages = process.env.FAKE_ACP_IMAGE_CAPABILITY === "1";
      const mcpTransports = (process.env.FAKE_ACP_MCP_TRANSPORTS ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
      const closesSessions = ["1", "error"].includes(process.env.FAKE_ACP_SESSION_CLOSE ?? "");
      if (["1", "stuck"].includes(process.env.FAKE_ACP_CURSOR_FAST ?? "") && msg.params?.clientCapabilities?._meta?.parameterizedModelPicker === true) {
        currentFast = "true";
      }
      result(msg.id, {
        protocolVersion: 1,
        authMethods,
        agentInfo: agentName
          ? { name: agentName, version: process.env.FAKE_ACP_AGENT_VERSION ?? "test" }
          : undefined,
        agentCapabilities: agentName || acceptsImages || mcpTransports.length || closesSessions
          ? {
              ...(agentName ? { loadSession: true, sessionCapabilities: { resume: true }, auth: { logout: true } } : {}),
              ...(closesSessions ? { sessionCapabilities: { close: {} } } : {}),
              ...(acceptsImages ? { promptCapabilities: { image: true } } : {}),
              ...(mcpTransports.length ? { mcpCapabilities: { http: mcpTransports.includes("http"), sse: mcpTransports.includes("sse") } } : {}),
            }
          : undefined,
        _meta: {
          modelState: { currentModelId: "fake-acp-model" },
          ...(process.env.FAKE_ACP_GROK_VERSION ? { grokShell: true, agentVersion: process.env.FAKE_ACP_GROK_VERSION } : {}),
        },
      });
      break;
    }
    case "authenticate":
      if (mode === "authenticate-failed") {
        out({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "Login expired" } });
        break;
      }
      result(msg.id, {});
      break;
    case "_x.ai/mcp/list":
      result(msg.id, { result: { servers: [], sessionMcpResolved: true } });
      break;
    case "session/new": {
      if (failRpc(msg)) break;
      if (mode === "auth-required") {
        out({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32000, message: "Authentication required", data: { providerId: "opencode-go" } },
        });
        break;
      }
      const servers: McpEntry[] = Array.isArray(msg.params?.mcpServers) ? msg.params.mcpServers : [];
      if (process.env.FAKE_ACP_DUMP) {
        writeFileSync(`${process.env.FAKE_ACP_DUMP}.session.json`, JSON.stringify(msg.params));
        dumpState.mcpServers = servers;
        writeDumpAtomic(process.env.FAKE_ACP_DUMP, JSON.stringify(dumpState, null, 2));
      }
      const offered = servers.find((s: any) => s?.name === "agents") ?? null;
      agentsMcp = mode === "list-peers" ? agentsMcp ?? offered : offered;
      sessionMcp = servers as AnyMcpEntry[];
      if (process.env.FAKE_ACP_DUMP) {
        writeFileSync(`${process.env.FAKE_ACP_DUMP}.mcp.json`, JSON.stringify(servers, null, 2));
      }
      const opts = configOptions();
      const mdls = sessionModels();
      sessionsOpened += 1;
      liveSession = sessionsOpened === 1 ? "fake-acp-session" : `fake-acp-session-${sessionsOpened}`;
      resultAndConfigUpdates(msg.id, {
        sessionId: liveSession,
        ...(opts ? { configOptions: opts } : {}),
        ...(mdls ? { models: mdls } : {}),
      }, "session/new", liveSession);
      break;
    }
    case "session/close":
      if (process.env.FAKE_ACP_SESSION_CLOSE === "error") out({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "close failed" } });
      else if (process.env.FAKE_ACP_SESSION_CLOSE_MS) setTimeout(() => result(msg.id, {}), Number(process.env.FAKE_ACP_SESSION_CLOSE_MS));
      else result(msg.id, {});
      break;
    case "session/load": {
      if (process.env.FAKE_ACP_LOAD_ERROR) {
        out({ jsonrpc: "2.0", id: msg.id, error: JSON.parse(process.env.FAKE_ACP_LOAD_ERROR) });
        break;
      }
      if (process.env.FAKE_ACP_LOAD_NULL) {
        result(msg.id, null);
        break;
      }
      if (rejectLiveLoadFile && existsSync(rejectLiveLoadFile) && liveSession === msg.params?.sessionId) {
        out({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32000, message: "session already active in this agent" },
        });
        break;
      }
      const cachedLiveLoad = process.env.FAKE_ACP_CACHED_LIVE_LOAD === "1" && liveSession === msg.params?.sessionId;
      if ((mode === "safe-agent-reads" || mode === "chief-delegate" || mode === "create-peer") && !cachedLiveLoad) {
        agentsMcp = (msg.params?.mcpServers ?? []).find((server: any) => server.name === "agents") ?? null;
      }
      if (mode === "list-peers") {
        agentsMcp ??= (msg.params?.mcpServers ?? []).find((server: any) => server.name === "agents") ?? null;
      }
      if (process.env.FAKE_ACP_DUMP) {
        writeFileSync(`${process.env.FAKE_ACP_DUMP}.mcp.json`, JSON.stringify(msg.params?.mcpServers ?? []));
      }
      if (!cachedLiveLoad) sessionMcp = msg.params?.mcpServers ?? [];
      const opts = configOptions();
      const mdls = sessionModels();
      liveSession = typeof msg.params?.sessionId === "string" ? msg.params.sessionId : liveSession;
      resultAndConfigUpdates(msg.id, { ...(opts ? { configOptions: opts } : {}), ...(mdls ? { models: mdls } : {}) }, "session/load", msg.params.sessionId);
      break;
    }
    case "session/resume": {
      if (rejectLiveLoadFile && existsSync(rejectLiveLoadFile) && liveSession === msg.params?.sessionId) {
        out({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32000, message: "session already active in this agent" },
        });
        break;
      }
      if (process.env.FAKE_ACP_DUMP) {
        writeFileSync(`${process.env.FAKE_ACP_DUMP}.mcp.json`, JSON.stringify(msg.params?.mcpServers ?? []));
      }
      const opts = configOptions();
      const mdls = sessionModels();
      liveSession = typeof msg.params?.sessionId === "string" ? msg.params.sessionId : liveSession;
      result(msg.id, { ...(opts ? { configOptions: opts } : {}), ...(mdls ? { models: mdls } : {}) });
      break;
    }
    // droid sets model/autonomy here, not via argv. Recorded beside FAKE_ACP_DUMP; last writer wins.
    case "session/set_mode":
    case "session/set_model": {
      if (mode === "no-session-config") {
        return out({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
      }
      if (msg.method === "session/set_model" && (mode === "set-model-invalid-params" ||
          (mode === "set-model-invalid-after-first" && configCalls.some((call) => call.method === "session/set_model")))) {
        // Cursor's answer when handed an argv slug like `auto`.
        return out({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "Invalid params" } });
      }
      const settingId = msg.method === "session/set_mode" ? "modeId" : "modelId";
      if (typeof msg.params?.sessionId !== "string" || typeof msg.params?.[settingId] !== "string") {
        out({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32602, message: `Invalid params: sessionId and ${settingId} must be strings` },
        });
        break;
      }
      configCalls.push({ method: msg.method, params: msg.params });
      if (process.env.FAKE_ACP_DUMP) {
        writeFileSync(`${process.env.FAKE_ACP_DUMP}.config.json`, JSON.stringify(configCalls, null, 2));
      }
      result(msg.id, {});
      break;
    }
    case "session/set_config_option": {
      const { configId, value } = msg.params ?? {};
      const variant = variantConfigs[currentModel ?? ""];
      if (variant && configId === (variant.id ?? "effort") && variantValues(variant.options).includes(value)) {
        if (!process.env.FAKE_ACP_VARIANT_STICKS) currentVariant = value;
        configCalls.push({ method: msg.method, params: msg.params });
        if (process.env.FAKE_ACP_DUMP) {
          writeFileSync(`${process.env.FAKE_ACP_DUMP}.config.json`, JSON.stringify(configCalls, null, 2));
        }
        resultAndConfigUpdates(msg.id, process.env.FAKE_ACP_EMPTY_VARIANT_ACK ? {} : { configOptions: configOptions() }, "effort", msg.params.sessionId);
        break;
      }
      if (configId === "fast" && currentFast && (value === "true" || value === "false")) {
        if (process.env.FAKE_ACP_CURSOR_FAST !== "stuck") currentFast = value;
        configCalls.push({ method: msg.method, params: msg.params });
        if (process.env.FAKE_ACP_DUMP) {
          writeFileSync(`${process.env.FAKE_ACP_DUMP}.config.json`, JSON.stringify(configCalls, null, 2));
        }
        result(msg.id, { configOptions: configOptions() });
        break;
      }
      if (configId === "mode" && modes.includes(value)) {
        const ackFile = process.env.FAKE_ACP_MODE_ACK_FILE;
        const ack = ackFile && existsSync(ackFile) ? readFileSync(ackFile, "utf8").trim() : "";
        if (ack === "error") {
          out({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "Internal error: could not change mode" } });
          break;
        }
        if (ack === "empty") {
          result(msg.id, {});
          break;
        }
        currentMode = value;
        configCalls.push({ method: msg.method, params: msg.params });
        if (process.env.FAKE_ACP_DUMP) {
          writeFileSync(`${process.env.FAKE_ACP_DUMP}.config.json`, JSON.stringify(configCalls, null, 2));
        }
        result(msg.id, process.env.FAKE_ACP_EMPTY_MODE_ACK ? {} : { configOptions: configOptions() });
        break;
      }
      if (configId === "model" && value === process.env.FAKE_ACP_EXIT_ON_MODEL) process.exit(4);
      if (configId !== "model" || !models.includes(value)) {
        out({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32602, message: `Invalid params: model not found: ${value}`, data: { modelId: value } },
        });
        break;
      }
      if (!process.env.FAKE_ACP_MODEL_STICKS) {
        currentModel = value;
        currentVariant = variantConfigs[value]?.currentValue;
      }
      configCalls.push({ method: msg.method, params: msg.params });
      if (process.env.FAKE_ACP_DUMP) {
        writeFileSync(`${process.env.FAKE_ACP_DUMP}.config.json`, JSON.stringify(configCalls, null, 2));
      }
      resultAndConfigUpdates(msg.id, { configOptions: configOptions() }, "model", msg.params.sessionId);
      break;
    }
    case "session/prompt": {
      if (process.env.FAKE_ACP_DUMP && (modes.length || models.length)) {
        appendFileSync(`${process.env.FAKE_ACP_DUMP}.prompts.jsonl`, JSON.stringify({
          pid: process.pid, sessionId: msg.params?.sessionId, mode: currentMode, model: currentModel,
        }) + "\n");
      }
      emitConfigUpdates("session/prompt", msg.params.sessionId);
      if (process.env.FAKE_ACP_DUMP && process.env.FAKE_ACP_VARIANTS) {
        writeFileSync(`${process.env.FAKE_ACP_DUMP}.selection.json`, JSON.stringify({
          sessionId: msg.params.sessionId, model: currentModel, variant: currentVariant,
        }));
      }
      if (process.env.FAKE_ACP_DUMP && process.env.FAKE_ACP_DUMP_PROMPT === "1") {
        writeFileSync(`${process.env.FAKE_ACP_DUMP}.prompt.json`, JSON.stringify(msg.params?.prompt ?? null, null, 2));
      }
      if (failRpc(msg)) return;
      if (process.env.FAKE_ACP_TOOL_LIMIT) {
        const limit = Number(process.env.FAKE_ACP_TOOL_LIMIT);
        const handshake = process.env.FAKE_ACP_MCP_HANDSHAKE ? JSON.parse(process.env.FAKE_ACP_MCP_HANDSHAKE) : GROK_MCP_HANDSHAKE;
        void Promise.all(sessionMcp.map((entry) => listMcpTools(entry, handshake).then((tools) => `${entry.name}=${tools.length}`))).then((counts) => {
          const total = counts.reduce((sum, entry) => sum + Number(entry.split("=")[1]), 0);
          if (total > limit) {
            recordMethod("session/prompt.tool-limit");
            out({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: `Internal error: Invalid value for 'tools': maximum number of items is ${limit}.`,
              data: { service: "session", errorName: "APIError" } } });
            return;
          }
          out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `tools: ${counts.join(",")}` } } } });
          result(msg.id, { stopReason: "end_turn", _meta: { inputTokens: 10, outputTokens: 5 } });
        });
        return;
      }
      if (process.env.FAKE_ACP_TEXT_REPLY !== undefined) {
        out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: msg.params?.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: process.env.FAKE_ACP_TEXT_REPLY } } } });
        result(msg.id, { stopReason: "end_turn", _meta: { inputTokens: 12, outputTokens: 4 } });
        return;
      }
      const fullPrompt = (Array.isArray(msg.params?.prompt) ? msg.params.prompt : []).map((block: any) => block?.text ?? "").join("");
      const hangOn = process.env.FAKE_ACP_HANG_ON, hangOnce = process.env.FAKE_ACP_HANG_ONCE_FILE;
      const held = Boolean(hangOn) && fullPrompt.includes(hangOn!) && !(hangOnce && existsSync(hangOnce));
      if (held && hangOnce) writeFileSync(hangOnce, String(Date.now()));
      if (mode === "hang" || held) {
        hangingPromptId = msg.id;
        hangKeepAlive = setInterval(() => {}, 1_000);
        return;
      }
      if (mode === "stall-after-text") {
        out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "half an answer, then silence" } } } });
        hangingPromptId = msg.id;
        hangKeepAlive = setInterval(() => {}, 1_000);
        return;
      }
      if (mode === "crash-in-prompt") {
        out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "working" } } } });
        setTimeout(() => process.exit(3), 200);
        return;
      }
      if (mode === "fail-after-text") {
        out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "half a report, then a crash" } } } });
        recordMethod("session/prompt.error");
        out({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "fake acp: turn failed after streaming" } });
        return;
      }
      const complete = () => {
        emitSessionReports();
        recordMethod("session/prompt.result");
        result(
          msg.id,
          process.env.FAKE_ACP_USAGE_ROOT
            ? { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5 }, _meta: {} }
            : { stopReason: "end_turn", _meta: { inputTokens: 10, outputTokens: 5 } },
        );
      };
      if (mode === "quiet-then-answer") {
        const lines: string[] = process.env.FAKE_ACP_QWEN_LOG ? JSON.parse(process.env.FAKE_ACP_QWEN_LOG) : [];
        let logTimer: ReturnType<typeof setInterval> | null = null;
        if (lines.length && process.env.QWEN_HOME && liveSession) {
          const dir = `${process.env.QWEN_HOME}/debug`;
          mkdirSync(dir, { recursive: true });
          let i = 0;
          logTimer = setInterval(() => {
            appendFileSync(`${dir}/${liveSession}.txt`, `${new Date().toISOString()} ${lines[Math.min(i++, lines.length - 1)]}\n`);
          }, Number(process.env.FAKE_ACP_LOG_EVERY_MS ?? 100));
        }
        const openCodeLines: string[] = process.env.FAKE_ACP_OPENCODE_LOG ? JSON.parse(process.env.FAKE_ACP_OPENCODE_LOG) : [];
        if (openCodeLines.length && process.env.XDG_DATA_HOME && liveSession) {
          const dir = `${process.env.XDG_DATA_HOME}/opencode/log`;
          mkdirSync(dir, { recursive: true });
          const session = liveSession;
          setTimeout(() => {
            appendFileSync(`${dir}/opencode.log`, openCodeLines.map((line) => `${line.replaceAll("{session}", session)}\n`).join(""));
          }, Number(process.env.FAKE_ACP_LOG_EVERY_MS ?? 100));
        }
        setTimeout(() => {
          if (logTimer) clearInterval(logTimer);
          out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "done" } } } });
          complete();
        }, Number(process.env.FAKE_ACP_QUIET_MS ?? 600));
        return;
      }
      if (mode === "slow-tool" || mode === "stall-after-tool") {
        const tool = (update: Record<string, unknown>) =>
          out({ jsonrpc: "2.0", method: "session/update", params: { update: { toolCallId: "tc-slow", ...update } } });
        // ACP's default status is pending: this tool_call carries none.
        tool({ sessionUpdate: "tool_call", title: "sleep", kind: "execute", rawInput: { command: "sleep 45 && echo done" } });
        const printed = process.env.FAKE_ACP_TOOL_OUTPUT;
        tool({ sessionUpdate: "tool_call_update", status: "in_progress", ...(printed ? { content: [{ type: "content", content: { type: "text", text: printed } }] } : {}) });
        const finish = () => tool({ sessionUpdate: "tool_call_update", status: "completed", rawOutput: { output: "done" } });
        if (mode === "stall-after-tool") {
          finish();
          hangingPromptId = msg.id;
          hangKeepAlive = setInterval(() => {}, 1_000);
          return;
        }
        const answer = () => {
          finish();
          out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "done" } } } });
          complete();
        };
        const gate = process.env.FAKE_ACP_TOOL_GATE;
        if (gate) {
          const held = setInterval(() => {
            if (!existsSync(gate)) return;
            clearInterval(held);
            answer();
          }, 20);
          return;
        }
        setTimeout(answer, Number(process.env.FAKE_ACP_TOOL_MS ?? 600));
        return;
      }
      if (mode === "unkeyed-tool") {
        // Violates ACP by omitting toolCallId.
        out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call", title: "run", rawInput: { command: "echo done" } } } });
        out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call_update", status: "completed", rawOutput: { output: "done" } } } });
        out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "done" } } } });
        complete();
        return;
      }
      if (mode === "finished-tools") {
        const update = (u: Record<string, unknown>) => out({ jsonrpc: "2.0", method: "session/update", params: { update: u } });
        // An unkeyed call left running, so an unkeyed finished one must not take its place in the queue.
        update({ sessionUpdate: "tool_call", title: "build", rawInput: { command: "make" } });
        update({ sessionUpdate: "tool_call", toolCallId: "tc-done", status: "completed", title: "read", rawOutput: { output: "ok" } });
        update({ sessionUpdate: "tool_call", toolCallId: "tc-denied", status: "failed", title: "rm -rf build",
          content: [{ type: "content", content: { type: "text", text: "Permission denied" } }] });
        update({ sessionUpdate: "tool_call", status: "completed", title: "echo", rawOutput: { output: "unkeyed" } });
        update({ sessionUpdate: "tool_call", status: "failed", title: "screenshot",
          content: [{ type: "image", data: ONE_PIXEL_PNG, mimeType: "image/png" }] });
        update({ sessionUpdate: "tool_call_update", status: "completed", rawOutput: { output: "built" } });
        // ACP v1 lets an update name a tool call that already finished.
        update({ sessionUpdate: "tool_call_update", toolCallId: "tc-done", status: "completed",
          content: [{ type: "image", data: ONE_PIXEL_PNG, mimeType: "image/png" }] });
        update({ sessionUpdate: "agent_message_chunk", content: { text: "done" } });
        complete();
        return;
      }
      const promptText = String(msg.params?.prompt?.[0]?.text ?? "");
      // A hand-off result wake is synthesized: the mode's usual flow would loop on an unprompted turn.
      const runtimeReport = /\[OpenMausBot report from @[^\]\n]*: ([a-z_]+)/.exec(promptText);
      const wokeFromDelegation = promptText.includes("[A delegated task just completed]")
        || promptText.includes("[A delegated task failed]")
        || runtimeReport !== null;
      if (wokeFromDelegation) {
        fakeLog("branch: wokeFromDelegation");
        const failed = promptText.includes("[A delegated task failed]")
          || (runtimeReport !== null && runtimeReport[1] !== "done" && runtimeReport[1] !== "completed");
        const sawResult = promptText.includes("replied to the delegated task") || /\nWhat @\S+ said: "/.test(promptText);
        const redelegateFile = process.env.FAKE_ACP_REDELEGATE_FILE;
        if (mode === "delegate-peer" && agentsMcp && sawResult && redelegateFile && !existsSync(redelegateFile)) {
          writeFileSync(redelegateFile, "1");
          void driveMcp(agentsMcp, [
            { name: "list_bots", args: () => ({}) },
            handoffCall("second delegated task"),
          ])
            .then((reply) => {
              out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `delegated again: ${reply}` } } } });
              complete();
            })
            .catch((e) => {
              out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `delegate error: ${(e as Error).message}` } } } });
              complete();
            });
          return;
        }
        out({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                text: failed
                  ? "woke after delegation failure: will tell the user"
                  : sawResult
                    ? "woke after delegation: saw the result"
                    : "woke after delegation: no result",
              },
            },
          },
        });
        complete();
        return;
      }
      if (mode === "chief-delegate" && agentsMcp && promptText.includes("CHECK_STATUS")) {
        fakeLog(`branch: CHECK_STATUS savedTaskId=${JSON.stringify(savedDelegatedTaskId())}`);
        const savedTaskId = savedDelegatedTaskId();
        if (!savedTaskId) {
          out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "status check skipped: no delegated task id" } } } });
          complete();
          return;
        }
        void driveMcp(agentsMcp, [statusCall(savedTaskId)])
          .then((reply) => {
            out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `status: ${reply}` } } } });
            complete();
          })
          .catch((e) => {
            out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `status error: ${(e as Error).message}` } } } });
            complete();
          });
        return;
      }
      if (mode === "chief-delegate" && promptText.includes("CHIEF_RESULT_CONTEXT")) {
        const sawDelegatedResult =
          promptText.includes("@LongWorker replied to the delegated task")
          && promptText.includes("long delegated task");
        out({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                text: sawDelegatedResult
                  ? "chief saw delegated result: long delegated task"
                  : "chief did not see delegated result",
              },
            },
          },
        });
        complete();
        return;
      }
      if (
        mode === "chief-delegate"
        && agentsMcp
        && promptText.includes("ASSIGN_TO_PEER")
        && !promptText.includes("CHIEF_FOLLOW_UP")
      ) {
        void driveMcp(agentsMcp, [
          { name: "list_bots", args: () => ({}) },
          handoffCall("long delegated task", { reason: "background assignment" }),
        ])
          .then((reply) => {
            rememberDelegatedTaskId(handoffIdOf(reply));
            out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `assigned: ${reply}` } } } });
            complete();
          })
          .catch((e) => {
            const message = e instanceof Error ? e.message : String(e);
            out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `delegate error: ${message}` } } } });
            complete();
          });
        return;
      }
      if (mode === "list-peers" && agentsMcp) {
        void driveMcp(agentsMcp, [{ name: "list_bots", args: () => ({}) }])
          .then((list) => {
            out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `peers: ${list}` } } } });
            complete();
          })
          .catch((e) => {
            out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `peers error: ${(e as Error).message}` } } } });
            complete();
          });
        return;
      }
      if (mode === "mcp-tools") {
        const handshake = process.env.FAKE_ACP_MCP_HANDSHAKE ? JSON.parse(process.env.FAKE_ACP_MCP_HANDSHAKE) : GROK_MCP_HANDSHAKE;
        void Promise.all(sessionMcp.map((entry) => listMcpTools(entry, handshake).then(
          (tools) => `${entry.name}: ${tools.join(",")}`,
          (error: Error) => `${entry.name} failed: ${error.message}`,
        ))).then((lines) => {
          out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: lines.join("\n") } } } });
          complete();
        });
        return;
      }
      if (mode === "ask-peer" && agentsMcp) {
        void driveMcp(agentsMcp, [
          { name: "list_bots", args: () => ({}) },
          handoffCall("ping from fake", { consult: true }),
        ])
          .then((reply) => {
            out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `peer says: ${reply}` } } } });
            complete();
          })
          .catch((e) => {
            out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `peer error: ${(e as Error).message}` } } } });
            complete();
          });
        return;
      }
      if (mode === "create-peer" && agentsMcp) {
        let listed = "";
        void driveMcp(agentsMcp, [
          { name: "list_bots", args: () => ({}) },
          {
            name: "create_bot",
            args: (bots) => {
              listed = bots;
              return {
                name: "Pixel",
                role: "Product designer",
                instructions: "Design and review the user experience.",
              };
            },
          },
          {
            name: "coordinate_bots",
            args: (created) => {
              const id = /id: ([\w-]+)/.exec(created)?.[1] ?? /^- Pixel\b.*?\[id: ([\w-]+)/m.exec(listed)?.[1] ?? "";
              return handoffCall("Review the new onboarding flow.", { reason: "design review" }).args(`id: ${id}`);
            },
          },
        ])
          .then((reply) => {
            out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `team created: ${reply}` } } } });
            complete();
          })
          .catch((e) => {
            const message = e instanceof Error ? e.message : String(e);
            out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `create error: ${message}` } } } });
            complete();
          });
        return;
      }
      if (mode === "echo-gated") {
        const finish = () => {
          out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `echo: ${promptText}` } } } });
          complete();
        };
        const gate = process.env.FAKE_ACP_GATE_FILE;
        // FAKE_ACP_STARTED_FILE: written when the prompt arrives, so a test can act during the turn.
        const started = process.env.FAKE_ACP_STARTED_FILE;
        if (started) writeFileSync(started, String(Date.now()));
        if (gate && !existsSync(gate)) {
          const poll = setInterval(() => {
            if (!existsSync(gate)) return;
            clearInterval(poll);
            finish();
          }, 50);
          return;
        }
        finish();
        return;
      }
      if (mode === "delegate-peer" && agentsMcp) {
        void driveMcp(agentsMcp, [
          { name: "list_bots", args: () => ({}) },
          handoffCall("delegated task", { reason: "followup", doneWhen: "the export opens in Numbers" }),
        ])
          .then((reply) => {
            out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `delegated: ${reply}` } } } });
            complete();
          })
          .catch((e) => {
            out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `delegate error: ${(e as Error).message}` } } } });
            complete();
          });
        return;
      }
      if (mode === "image") {
        out({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "image", data: ONE_PIXEL_PNG, mimeType: "image/png" },
            },
          },
        });
      } else if (mode === "interleave") playInterleaveTurn();
      else if (mode === "reasoning-only") playReasoningTurn();
      else if (mode !== "empty-reply") playTurn();
      if (mode === "safe-agent-reads" && agentsMcp) {
        const entry = agentsMcp;
        void (async () => {
          for (const name of ["list_bots", "session_search", "list_bots"]) {
            const nativeAuto = ["--permission-mode", "--approval-mode"].some((flag) => argv.includes(flag) && argv[argv.indexOf(flag) + 1] === "auto");
            if (!nativeAuto) {
              const allowed = await new Promise<boolean>((resolve) => {
                pendingPermissionId = 9100;
                onPermissionAnswered = resolve;
                out({ jsonrpc: "2.0", id: pendingPermissionId, method: "session/request_permission", params: {
                  toolCall: { toolCallId: `fixture-${name}`, kind: "other", title: `agents__${name}`, rawInput: {} },
                  options: [{ optionId: "allow-once", kind: "allow_once" }, { optionId: "reject", kind: "reject_once" }],
                } });
              });
              if (!allowed) { complete(); return; }
            }
            const text = await driveMcp(entry, [{ name, args: () => name === "session_search" ? { query: "approval fixture" } : {} }], true);
            out({ jsonrpc: "2.0", method: "session/update", params: { update: {
              sessionUpdate: "agent_message_chunk", content: { text: `${name}: ${text}\n` },
            } } });
          }
          complete();
        })().catch((error) => out({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: String(error) } }));
        return;
      }
      if (mode === "permission") {
        pendingPermissionId = 9001;
        onPermissionAnswered = () => {
          out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "handled the permission decision" } } } });
          complete();
        };
        out({
          jsonrpc: "2.0",
          id: pendingPermissionId,
          method: "session/request_permission",
          params: {
            toolCall: process.env.FAKE_ACP_PERMISSION_TOOL_CALL
              ? JSON.parse(process.env.FAKE_ACP_PERMISSION_TOOL_CALL)
              : { kind: "execute", rawInput: { command: "echo hi" }, title: "echo hi" },
            options: process.env.FAKE_ACP_PERMISSION_OPTIONS ? JSON.parse(process.env.FAKE_ACP_PERMISSION_OPTIONS) : [
              { optionId: "allow-once", kind: "allow_once" },
              // Grok offers a session-wide allow on some requests and omits it on others.
              ...(process.env.FAKE_ACP_ALLOW_ALWAYS ? [{ optionId: "allow-always", kind: "allow_always" }] : []),
              { optionId: "reject", kind: "reject_once" },
            ],
          },
        });
        return;
      }
      if (mode === "lend-question" && agentsMcp) {
        const entry = agentsMcp;
        const list = () => driveMcp(entry, [{ name: "list_shared_computers", args: () => ({}) }]).catch((e) => `error ${(e as Error).message}`);
        void (async () => {
          const before = await list();
          pendingPermissionId = 9003;
          onPermissionAnswered = () => {
            void list().then((after) => {
              out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `before: ${before} | after: ${after}` } } } });
              complete();
            });
          };
          out({ jsonrpc: "2.0", id: pendingPermissionId, method: "session/request_permission", params: {
            toolCall: { toolCallId: "interaction_folder", kind: "other", title: "Which folder should I read?" },
            options: [{ optionId: "docs-id", kind: "allow_once", name: "Docs" }, { optionId: "other-id", kind: "allow_once", name: "Other" }],
          } });
        })();
        return;
      }
      if (mode === "question") {
        pendingPermissionId = 9002;
        onPermissionAnswered = () => {
          // FAKE_ACP_HOLD_ON_CANCELLED: a cancelled question holds the prompt until session/cancel, as Antigravity does.
          if (process.env.FAKE_ACP_HOLD_ON_CANCELLED && lastPermissionCancelled) {
            hangingPromptId = msg.id;
            return;
          }
          out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "answered the question" } } } });
          complete();
        };
        out({
          jsonrpc: "2.0",
          id: pendingPermissionId,
          method: "session/request_permission",
          params: {
            toolCall: { toolCallId: "interaction_color", kind: "other", title: "Which color?" },
            options: process.env.FAKE_ACP_QUESTION_OPTIONS ? JSON.parse(process.env.FAKE_ACP_QUESTION_OPTIONS) : [
              { optionId: "blue-id", kind: "allow_once", name: "Blue" },
              {
                optionId: "green-id",
                kind: "allow_once",
                name: process.env.FAKE_ACP_PAD_QUESTION_OPTION ? " Green " : "Green",
              },
            ],
          },
        });
        return;
      }
      if (mode === "ask-question") {
        const ask = () => {
          pendingAskQuestionId = 9300;
          out({
            jsonrpc: "2.0",
            id: pendingAskQuestionId,
            method: process.env.FAKE_ACP_ASK_METHOD ?? "cursor/ask_question",
            params: process.env.FAKE_ACP_ASK_PARAMS ? JSON.parse(process.env.FAKE_ACP_ASK_PARAMS) : {
              toolCallId: "ask-1",
              title: "Pick a color",
              questions: [{ id: "color", prompt: "Which color?", options: [{ id: "blue-id", label: "Blue" }, { id: "green-id", label: "Green" }], allowMultiple: false }],
            },
          });
        };
        const timing = process.env.FAKE_ACP_ASK_TIMING;
        if (timing === "with-result" || timing === "after-result") {
          onAskQuestionAnswered = null;
          if (timing === "with-result") ask();
          complete();
          // late enough that the driver has settled the turn first
          if (timing === "after-result") setTimeout(ask, 300);
          return;
        }
        onAskQuestionAnswered = () => {
          out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "answered the question" } } } });
          complete();
        };
        ask();
        return;
      }
      complete();
      break;
    }
    case "session/cancel":
      if (hangingPromptId !== null && process.env.FAKE_ACP_IGNORE_CANCEL !== "1") {
        result(hangingPromptId, { stopReason: process.env.FAKE_ACP_CANCEL_STOP_REASON ?? "cancelled", _meta: {} });
        if (hangKeepAlive) clearInterval(hangKeepAlive);
        hangingPromptId = null;
        hangKeepAlive = null;
      }
      break;
    default:
      if (msg.id !== undefined) out({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
  }
}
