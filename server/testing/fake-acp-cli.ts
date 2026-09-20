#!/usr/bin/env node
// Fake of an ACP (Agent Client Protocol) CLI's stdio surface, for driver
// tests of acp/core.ts + its harness shims (grok, gemini). Speaks JSON-RPC
// 2.0 over stdin/stdout: answers initialize / authenticate / session/new /
// session/prompt, and streams session/update notifications for a scripted
// turn. Failure modes mirror how real ACP agents misbehave:
//
//   FAKE_ACP_LOAD_NULL  return null for session/load so the resume cursor is
//                       ignored and the driver falls through to session/new
//   FAKE_ACP_REJECT_LIVE_LOAD_FILE  while this file exists, session/load and
//                       session/resume answer an error when the requested
//                       session is already live in THIS process — the
//                       real-agent shape that forces the driver's one-shot
//                       re-spawn fallback. A fresh process holds no live
//                       session, so its load succeeds.
//   FAKE_ACP_MODE   happy (default) | image | empty-reply | exit-early | fail-after-text | hang | hang-initialize | stall-after-text | no-auth | auth-required | permission | question
//                   | interleave (message → tool → message → tool → message)
//                   | no-session-config (reject session/set_mode + set_model
//                     with -32601, i.e. an agent predating those methods)
//                   | ask-peer (spawn the injected "agents" MCP server from
//                     session/new's mcpServers, call list_bots + ask_bot on a
//                     peer, and reply with what the peer said — the comms e2e)
//                   | delegate-peer (same as ask-peer but uses delegate_bot —
//                     returns immediately, the peer runs after our turn)
//                   | chief-delegate (delegates only for an ASSIGN_TO_PEER
//                     prompt; ordinary follow-ups stay responsive)
//                   | create-peer (a Chief creates a specialist, then delegates
//                     work to it through the returned id)
//                   | echo-gated (reply by echoing the full prompt, and when
//                     FAKE_ACP_GATE_FILE is set hold the turn open until that
//                     file exists — a deterministic busy window for the
//                     steer-queue e2e, with the echo pinning exactly what a
//                     drained turn was sent)
//                   | safe-agent-reads (simulate a native Auto reviewer around
//                     the real injected agents MCP; not a real classifier test)
//                   | stall-after-text (stream one message chunk, then go
//                     fully silent forever — a wedged agent mid-answer; the
//                     driver's prompt idle guard must fail the turn on its own)
//   FAKE_ACP_MCP_TRANSPORTS  comma list of remote MCP transports the agent
//                       advertises in initialize (mcpCapabilities), e.g. "http,sse"
//   FAKE_ACP_DUMP   path to write {argv, env} as JSON, so a test can assert
//                   argv shape (agent/stdio flags) and env hygiene
//   FAKE_ACP_LAUNCH_COUNT_FILE  read-increment-write a process counter at
//                       startup, so a test can tell a reused pooled session
//                       (one launch) from a fresh child per turn (many)
//   FAKE_ACP_RPC_DUMP   rewrite, after every request, this process's full
//                       method list as a JSON array — per process, so a
//                       pooled child keeps one dump and a replacement child
//                       starts its own
//   FAKE_ACP_RPC_APPEND_FILE  append one {"pid","method"} JSON line per
//                       request, so a test can count RPCs across a pooled
//                       child and its replacement together
//   FAKE_ACP_MODELS      comma-separated model ids. Enables the opencode-shaped
//                        surface: session/new and session/load return
//                        configOptions, and session/set_config_option switches
//                        the model (rejecting an unadvertised one with -32602).
//   FAKE_ACP_MODEL_STICKS  session/set_config_option succeeds but leaves the
//                        model where it was, so the confirmation guard in
//                        core.ts has something to catch
//   FAKE_ACP_VARIANTS JSON map of model -> {id?, currentValue?, options} using
//                        ACP select values/groups; never contacts a provider.
//   FAKE_ACP_CONFIG_UPDATES JSON array of {after, sessionId?, configOptions,
//                        replay?}, emitted after the named RPC response.
//   FAKE_ACP_USAGE_ROOT  put the prompt result's usage at the root instead of
//                        under _meta (what opencode 1.18.18 actually does)
//
// Keep this file dependency-free — it runs as a bare `node` subprocess.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const mode = process.env.FAKE_ACP_MODE ?? "happy";
const ONE_PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
// opencode-shaped surface: the session carries its own model catalog and the
// model is chosen with session/set_config_option, because `opencode acp` takes
// no -m. Off unless FAKE_ACP_MODELS is set, so every existing mode is byte-
// identical to before.
const models = (process.env.FAKE_ACP_MODELS ?? "").split(",").filter(Boolean);
let currentModel: string | null = models[0] ?? null;
const variantConfigs: Record<string, { id?: string; currentValue?: string; options: any[] }> =
  JSON.parse(process.env.FAKE_ACP_VARIANTS ?? "{}");
let currentVariant = variantConfigs[currentModel ?? ""]?.currentValue;
const variantValues = (entries: any[]): string[] => entries.flatMap((entry) => (
  typeof entry?.value === "string" ? [entry.value] : Array.isArray(entry?.options) ? variantValues(entry.options) : []
));
const modes = (process.env.FAKE_ACP_MODES ?? "").split(",").filter(Boolean);
let currentMode: string | null = modes[0] ?? null;
// task id captured from the last delegate_bot reply, for a later
// check_delegation call. Each turn is a fresh process, so the id is passed
// through a file (same state-passing pattern as FAKE_ACP_GATE_FILE).
const taskIdFile = process.env.FAKE_ACP_TASKID_FILE ?? "";
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
  ];
  return options.length ? options : null;
};
// cursor-shaped surface: the session advertises `models.availableModels` with
// parameterised ids (`default[]`) that differ from the argv `--model` slugs
// (`auto`). Off unless FAKE_ACP_SESSION_MODELS is set, so every existing mode
// stays byte-identical. Format: "id|Name,id|Name" — the name is optional.
const acpModels = (process.env.FAKE_ACP_SESSION_MODELS ?? "")
  .split(",")
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
    "SystemRoot",
    "FAKE_ACP_MODE",
    "FAKE_ACP_RPC_DUMP",
    "FAKE_ACP_IMAGE_CAPABILITY",
    "FAKE_ACP_DUMP_PROMPT",
    "TEST_POLICY",
    "OPENCODE_API_KEY",
    "OPENCODE_PERMISSION",
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
    "ANTHROPIC_API_KEY",
    "XAI_API_KEY",
    "BOX_TOKEN",
    "OMB_TTS_KEY",
    "OMB_FISH_AUDIO_API_KEY",
    "FACTORY_API_KEY",
    "UNSLOTH_STUDIO_AUTH_TOKEN",
    "CURSOR_API_KEY",
    "CURSOR_AUTH_TOKEN",
    "KIMI_MODEL_NAME",
    "KIMI_MODEL_API_KEY",
    "KIMI_MODEL_BASE_URL",
    "KIMI_MODEL_PROVIDER_TYPE",
    "KIMI_MODEL_DISPLAY_NAME",
    "TEST_TURN_MODEL",
    "MY_AGENT_TOKEN",
    "GEMINI_HOME",
    "AGY_ACP_FORCE_FILE_STORAGE",
    "ANTIGRAVITY_HARNESS_PATH",
  ].flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]]] as const)),
);
// pid rides along so a test can tell a respawned process (new pid, fresh
// dump) from a pooled one whose dump was never rewritten
const dumpState: Record<string, unknown> = { argv, env: dumpEnv, pid: process.pid };
if (process.env.FAKE_ACP_DUMP) {
  writeFileSync(process.env.FAKE_ACP_DUMP, JSON.stringify(dumpState, null, 2));
}
if (process.env.FAKE_ACP_LAUNCH_COUNT_FILE) {
  // count launched processes: read-increment-write, so a test can assert
  // how many children the driver spawned (a pooled session launches once)
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
// Cursor's driver probes `agent status` / `agent models` on the same binary
// it later spawns for ACP. Answer those without entering the JSON-RPC loop
// so catalog/auth tests do not hang on stdin.
if (argv[0] === "status" || argv[0] === "whoami") {
  const authenticated = process.env.FAKE_ACP_AUTH !== "0";
  console.log(JSON.stringify({ isAuthenticated: authenticated }));
  process.exit(0);
}
if (argv[0] === "models" || argv.includes("--list-models")) {
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

const out = (obj: unknown) => process.stdout.write(JSON.stringify(obj) + "\n");
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
// Send response and subsequent updates in one chunk to exercise wire ordering:
// a promise continuation must not overwrite a newer notification with the ACK.
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
      appendFileSync(process.env.FAKE_ACP_RPC_APPEND_FILE, JSON.stringify({ pid: process.pid, method }) + "\n");
    } catch {}
  }
};

// session/set_mode + session/set_model calls seen this run
const configCalls: Array<{ method: string; params: unknown }> = [];

// pending server→client permission request id → resolver
let pendingPermissionId: number | null = null;
let onPermissionAnswered: ((allowed: boolean) => void) | null = null;

// hang mode: the prompt we are holding open and its keep-alive timer —
// session/cancel resolves it cancelled (the ACP spec's cancel contract)
// and drops the keep-alive
let hangingPromptId: unknown = null;
let hangKeepAlive: ReturnType<typeof setInterval> | null = null;

// ask-peer mode: the "agents" MCP server entry from session/new's mcpServers
type McpEntry = { command: string; args?: string[]; env?: Array<{ name: string; value: string }> };
let agentsMcp: McpEntry | null = null;
// the session this process established, for FAKE_ACP_REJECT_LIVE_LOAD_FILE
let liveSession: string | null = null;

/** Minimal one-shot MCP stdio client: initialize, call each tool in
 * sequence, return the text of the last result. Dependency-free. */
function driveMcp(entry: McpEntry, calls: Array<{ name: string; args: (prev: string) => object }>, strict = false): Promise<string> {
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
      write({ jsonrpc: "2.0", id: step + 2, method: "tools/call", params: { name: call.name, arguments: call.args(last) } });
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
        // Protocol failures (for example a removed tool) are never a successful
        // empty reply. Tool-result denials remain inspectable by the legacy
        // approval fixtures unless that caller explicitly requires success.
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

/** Scripted text → tool → text → tool → text turn for order-contract tests. */
function playInterleaveTurn() {
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "before one" } } } });
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call", toolCallId: "tc-1", title: "run" } } });
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call_update", toolCallId: "tc-1", status: "completed" } } });
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "before two" } } } });
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call", toolCallId: "tc-2", title: "run" } } });
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call_update", toolCallId: "tc-2", status: "completed" } } });
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "after" } } } });
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
    handle(msg);
  }
});

function handle(msg: any) {
  // client's response to our permission request
  if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined) && msg.id === pendingPermissionId) {
    pendingPermissionId = null;
    const chosen = msg.result?.outcome?.optionId;
    // which option the client picked, for tests asserting allow_always
    if (process.env.FAKE_ACP_PERMISSION_ANSWER) writeFileSync(process.env.FAKE_ACP_PERMISSION_ANSWER, String(chosen ?? "cancelled"));
    onPermissionAnswered?.(typeof chosen === "string" && chosen.startsWith("allow"));
    return;
  }
  if (!msg.method) return;
  recordMethod(msg.method);

  switch (msg.method) {
    case "initialize": {
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
      // which remote MCP transports this agent advertises, e.g. "http,sse"
      const mcpTransports = (process.env.FAKE_ACP_MCP_TRANSPORTS ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
      result(msg.id, {
        protocolVersion: 1,
        authMethods,
        agentInfo: agentName
          ? { name: agentName, version: process.env.FAKE_ACP_AGENT_VERSION ?? "test" }
          : undefined,
        agentCapabilities: agentName || acceptsImages || mcpTransports.length
          ? {
              ...(agentName ? { loadSession: true, sessionCapabilities: { resume: true }, auth: { logout: true } } : {}),
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
      result(msg.id, {});
      break;
    case "session/new": {
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
        dumpState.mcpServers = servers;
        writeFileSync(process.env.FAKE_ACP_DUMP, JSON.stringify(dumpState, null, 2));
      }
      agentsMcp = servers.find((s: any) => s?.name === "agents") ?? null;
      if (process.env.FAKE_ACP_DUMP) {
        writeFileSync(`${process.env.FAKE_ACP_DUMP}.mcp.json`, JSON.stringify(servers, null, 2));
      }
      const opts = configOptions();
      const mdls = sessionModels();
      liveSession = "fake-acp-session";
      resultAndConfigUpdates(msg.id, {
        sessionId: "fake-acp-session",
        ...(opts ? { configOptions: opts } : {}),
        ...(mdls ? { models: mdls } : {}),
      }, "session/new", "fake-acp-session");
      break;
    }
    case "session/load": {
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
      if (mode === "safe-agent-reads") {
        agentsMcp = (msg.params?.mcpServers ?? []).find((server: any) => server.name === "agents") ?? null;
      }
      if (process.env.FAKE_ACP_DUMP) {
        writeFileSync(`${process.env.FAKE_ACP_DUMP}.mcp.json`, JSON.stringify(msg.params?.mcpServers ?? []));
      }
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
    // per-session settings (droid sets model/autonomy here, not via argv).
    // Recorded next to FAKE_ACP_DUMP so a test can assert what was applied.
    // NOTE: last writer wins — each turn spawns a fresh child, so a two-turn
    // test would only ever see the final turn's calls.
    case "session/set_mode":
    case "session/set_model": {
      if (mode === "no-session-config") {
        // an older agent that predates these methods
        return out({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
      }
      if (mode === "set-model-invalid-params" && msg.method === "session/set_model") {
        // an agent whose ACP model namespace does not contain the id it was
        // sent — Cursor's answer when handed an argv slug like `auto`.
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
      if (configId === "mode" && modes.includes(value)) {
        currentMode = value;
        configCalls.push({ method: msg.method, params: msg.params });
        if (process.env.FAKE_ACP_DUMP) {
          writeFileSync(`${process.env.FAKE_ACP_DUMP}.config.json`, JSON.stringify(configCalls, null, 2));
        }
        result(msg.id, process.env.FAKE_ACP_EMPTY_MODE_ACK ? {} : { configOptions: configOptions() });
        break;
      }
      if (configId !== "model" || !models.includes(value)) {
        out({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32602, message: `Invalid params: model not found: ${value}`, data: { modelId: value } },
        });
        break;
      }
      // FAKE_ACP_MODEL_STICKS: answer OK and keep the old model anyway. Nothing
      // in the protocol forbids it, and it is the shape core.ts's confirmation
      // guard exists for — an error is loud, this is silent.
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
      emitConfigUpdates("session/prompt", msg.params.sessionId);
      if (process.env.FAKE_ACP_DUMP && process.env.FAKE_ACP_VARIANTS) {
        writeFileSync(`${process.env.FAKE_ACP_DUMP}.selection.json`, JSON.stringify({
          sessionId: msg.params.sessionId, model: currentModel, variant: currentVariant,
        }));
      }
      if (process.env.FAKE_ACP_DUMP && process.env.FAKE_ACP_DUMP_PROMPT === "1") {
        writeFileSync(`${process.env.FAKE_ACP_DUMP}.prompt.json`, JSON.stringify(msg.params?.prompt ?? null, null, 2));
      }
      if (mode === "hang") {
        // never resolve the prompt on our own — lets tests exercise interrupt
        hangingPromptId = msg.id;
        hangKeepAlive = setInterval(() => {}, 1_000);
        return;
      }
      if (mode === "stall-after-text") {
        // Stream a chunk, then go fully silent forever: no updates, no result,
        // no exit. This is the shape of a wedged OpenCode agent that stopped
        // mid-answer — the driver's prompt idle guard must fail the turn on
        // its own, because nothing else will ever arrive.
        out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "half an answer, then silence" } } } });
        hangingPromptId = msg.id;
        hangKeepAlive = setInterval(() => {}, 1_000);
        return;
      }
      if (mode === "fail-after-text") {
        // Stream real text, THEN fail the turn — the shape of a crash
        // mid-answer. This is the one case where the routine-failed/done
        // notification dedup is load-bearing: the reply is non-empty, so
        // nothing else suppresses the generic done.
        out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "half a report, then a crash" } } } });
        recordMethod("session/prompt.error");
        out({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "fake acp: turn failed after streaming" } });
        return;
      }
      const complete = () => {
        recordMethod("session/prompt.result");
        result(
          msg.id,
          // FAKE_ACP_USAGE_ROOT reproduces opencode 1.18.18's shape: usage at
          // the result root with an empty _meta, instead of usage under _meta.
          process.env.FAKE_ACP_USAGE_ROOT
            ? { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5 }, _meta: {} }
            : { stopReason: "end_turn", _meta: { inputTokens: 10, outputTokens: 5 } },
        );
      };
      const promptText = String(msg.params?.prompt?.[0]?.text ?? "");
      // A delegated reply woke this bot (control-plane continuation): the
      // harness revived it to fold the result in. Synthesize instead of
      // driving the mode's usual delegate/ask flow, which would loop or
      // re-ask for approval on a turn the user did not initiate.
      const wokeFromDelegation = promptText.includes("[A delegated task just completed]")
        || promptText.includes("[A delegated task failed]");
      if (wokeFromDelegation) {
        fakeLog("branch: wokeFromDelegation");
        const failed = promptText.includes("[A delegated task failed]");
        const sawResult = promptText.includes("replied to the delegated task");
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
        void driveMcp(agentsMcp, [
          {
            name: "check_delegation",
            args: () => ({ task_id: savedTaskId }),
          },
        ])
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
          {
            name: "delegate_bot",
            args: (list) => ({
              bot_id: /id: ([\w-]+)/.exec(list)?.[1] ?? "",
              message: "long delegated task",
              reason: "background assignment",
            }),
          },
        ])
          .then((reply) => {
            rememberDelegatedTaskId(/Task id: ([\w-]+)/.exec(reply)?.[1] ?? "");
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
      if (mode === "ask-peer" && agentsMcp) {
        // the comms e2e: reach a peer bot through the injected agents proxy
        // and reply with whatever it said (the peer's fake runs plain happy
        // — its depth-1 turn gets no agents server, so no recursion)
        void driveMcp(agentsMcp, [
          { name: "list_bots", args: () => ({}) },
          {
            name: "ask_bot",
            args: (list) => ({ bot_id: /id: ([\w-]+)/.exec(list)?.[1] ?? "", message: "ping from fake" }),
          },
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
        void driveMcp(agentsMcp, [
          {
            name: "create_bot",
            args: () => ({
              name: "Pixel",
              role: "Product designer",
              instructions: "Design and review the user experience.",
            }),
          },
          {
            name: "delegate_bot",
            args: (created) => ({
              bot_id: /id: ([\w-]+)/.exec(created)?.[1] ?? "",
              message: "Review the new onboarding flow.",
              reason: "design review",
            }),
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
        // echoing the WHOLE prompt (system + turn text) lets a test assert
        // both what a drained turn was sent and what it was NOT sent (e.g.
        // the webhook untrusted-data paragraph a steered turn must not get)
        const finish = () => {
          out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `echo: ${promptText}` } } } });
          complete();
        };
        const gate = process.env.FAKE_ACP_GATE_FILE;
        // FAKE_ACP_STARTED_FILE: written the moment the prompt arrives, so a
        // test can act "during the turn" (after the harness's pre-turn
        // checkpoint) without racing the busy flag, which flips at claim.
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
        // async peer-handoff e2e: queue the delegation and return
        // immediately; the harness fires the peer's depth-1 turn after our
        // turn settles. We don't need the peer's reply in our text — the
        // comms e2e verifies the channel mirroring on its own.
        void driveMcp(agentsMcp, [
          { name: "list_bots", args: () => ({}) },
          {
            name: "delegate_bot",
            args: (list) => ({
              bot_id: /id: ([\w-]+)/.exec(list)?.[1] ?? "",
              message: "delegated task",
              reason: "followup",
            }),
          },
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
      else if (mode !== "empty-reply") playTurn();
      if (mode === "safe-agent-reads" && agentsMcp) {
        const entry = agentsMcp;
        // Deliberately independent of the app's policy catalog. These are the
        // two exact calls in the reported regression, repeated in one turn.
        void (async () => {
          for (const name of ["list_bots", "session_search", "list_bots"]) {
            const nativeAuto = argv[argv.indexOf("--permission-mode") + 1] === "auto";
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
        // ask the client to approve a tool, then complete once answered
        pendingPermissionId = 9001;
        onPermissionAnswered = complete;
        out({
          jsonrpc: "2.0",
          id: pendingPermissionId,
          method: "session/request_permission",
          params: {
            toolCall: process.env.FAKE_ACP_PERMISSION_TOOL_CALL
              ? JSON.parse(process.env.FAKE_ACP_PERMISSION_TOOL_CALL)
              : { kind: "execute", rawInput: { command: "echo hi" }, title: "echo hi" },
            options: [
              { optionId: "allow-once", kind: "allow_once" },
              // Grok offers a session-wide allow on some requests and omits
              // it on others; the driver must cope with both.
              ...(process.env.FAKE_ACP_ALLOW_ALWAYS ? [{ optionId: "allow-always", kind: "allow_always" }] : []),
              { optionId: "reject", kind: "reject_once" },
            ],
          },
        });
        return;
      }
      if (mode === "question") {
        pendingPermissionId = 9002;
        onPermissionAnswered = complete;
        out({
          jsonrpc: "2.0",
          id: pendingPermissionId,
          method: "session/request_permission",
          params: {
            toolCall: { toolCallId: "interaction_color", kind: "other", title: "Which color?" },
            options: [
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
      complete();
      break;
    }
    case "session/cancel":
      // the interrupted prompt resolves as cancelled
      if (hangingPromptId !== null) {
        result(hangingPromptId, { stopReason: "cancelled", _meta: {} });
        if (hangKeepAlive) clearInterval(hangKeepAlive);
        hangingPromptId = null;
        hangKeepAlive = null;
      }
      break;
    default:
      if (msg.id !== undefined) out({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
  }
}
