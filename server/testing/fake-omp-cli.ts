#!/usr/bin/env node
// Scripted omp RPC fake; its frames follow the omp 18.5.1 wire schema.
// Prompt admission and completion are separate (prompt_result/session_settled).
// FAKE_OMP_MODE additionally supports confirm/input/select, late-frames,
// delayed-exit, stall-exit and malformed-result.
// FAKE_OMP_DUMP appends launches, commands and lifecycle checkpoints as JSONL.
// FAKE_OMP_MODELS_FILE allows deterministic catalog changes between probes.
// FAKE_OMP_EXIT_GATE releases a delayed EOF flush when that file is created.
// FAKE_OMP_SWITCH_CANCEL / FAKE_OMP_SWITCH_MISMATCH exercise refused resumes.
// FAKE_OMP_FRAME_LIMIT lowers the physical stdout cap for transport contracts.
// corrupt-catalog/corrupt-turn use FAKE_OMP_CHUNK_FAULT to damage a sequence.
// Async work is deliberately held until a steer arrives, so tests control the
// lifecycle boundary through real RPC rather than racing a scripted timeout.
// Keep this fake self-contained: only node: builtins, never package imports.
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Model = { provider: string; id: string; name?: string; contextWindow?: number };
type Command = { type: string; id: string } & Record<string, unknown>;
type McpConfig = {
  scopeReadyPath?: string;
  toolScope?: unknown;
  localProvider?: { name: string; model: string };
};

const mode = process.env.FAKE_OMP_MODE ?? "happy";
const argv = process.argv.slice(2);
const rawModels: Model[] = argv.includes("--version") || (argv[0] === "models" && argv[1] === "refresh")
  ? []
  : process.env.FAKE_OMP_MODELS_FILE
  ? JSON.parse(readFileSync(process.env.FAKE_OMP_MODELS_FILE, "utf8")) as Model[]
  : process.env.FAKE_OMP_MODELS
  ? JSON.parse(process.env.FAKE_OMP_MODELS) as Model[]
  : [
    { provider: "anthropic", id: "claude-sonnet", name: "Claude Sonnet", contextWindow: 200_000 },
    { provider: "openai", id: "gpt-4o", name: "GPT-4o", contextWindow: 128_000 },
  ];
const models = rawModels.map((entry) => ({
  ...entry, name: entry.name || entry.id, contextWindow: entry.contextWindow ?? 128_000,
  api: "anthropic-messages", baseUrl: "https://example.test", reasoning: true,
  input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, maxTokens: 8192,
}));
const dump = (entry: unknown) => {
  if (process.env.FAKE_OMP_DUMP) appendFileSync(process.env.FAKE_OMP_DUMP, JSON.stringify(entry) + "\n");
};
const rawConfig: unknown = process.env.OMB_MCP_CONFIG
  ? JSON.parse(readFileSync(process.env.OMB_MCP_CONFIG, "utf8"))
  : null;
const mcpConfig = rawConfig as McpConfig | null;
const localProvider = mcpConfig?.localProvider;
dump({
  argv,
  pid: process.pid,
  envConfigured: ["PATH", "HOME", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "XAI_API_KEY", "GEMINI_API_KEY", "GROQ_API_KEY", "BOX_TOKEN"]
    .filter((key) => process.env[key] !== undefined),
  mcpConfig: rawConfig,
});
if (argv.includes("--version")) {
  process.stdout.write((process.env.FAKE_OMP_VERSION ?? "omp/18.4.12") + "\n");
  process.exit(0);
}
if (argv[0] === "models" && argv[1] === "refresh") process.exit(0);
if (mode === "exit-early") {
  process.stderr.write("fake omp: runtime crashed\n");
  process.exit(1);
}
if (typeof mcpConfig?.scopeReadyPath === "string" && process.env.FAKE_OMP_SCOPE_READY === "1") {
  writeFileSync(mcpConfig.scopeReadyPath, JSON.stringify({ ok: true, toolScope: mcpConfig.toolScope }));
}

const frameLimit = Number(process.env.FAKE_OMP_FRAME_LIMIT ?? 1024 * 1024);
const reassemblyLimit = Number(process.env.FAKE_OMP_REASSEMBLY_LIMIT ?? 64 * 1024 * 1024);
if (!Number.isSafeInteger(frameLimit) || frameLimit < 512 || !Number.isSafeInteger(reassemblyLimit) || reassemblyLimit < 1) {
  throw new Error("Invalid fake omp frame limits");
}
const payloadLimit = Math.floor(frameLimit / 4);
let protocolVersion = 1;
let chunkCounter = 0;
let outputClosed = false;
const writeFrame = (frame: Record<string, unknown>) => process.stdout.write(JSON.stringify(frame) + "\n");
const send = (frame: Record<string, unknown>) => {
  if (outputClosed) return;
  const json = JSON.stringify(frame);
  const byteLength = Buffer.byteLength(json);
  if (byteLength + 1 <= frameLimit) { writeFrame(frame); return; }
  if (protocolVersion === 1 || byteLength > reassemblyLimit || mode === "overflow") {
    writeFrame(frame.type === "response"
      ? { id: frame.id, type: "response", command: frame.command, success: false, error: "RPC response exceeded the transport limit" }
      : { type: "rpc_frame_error", originalType: frame.type, error: "RPC frame exceeded the transport limit" });
    return;
  }
  const bytes = Buffer.from(json);
  const count = Math.ceil(byteLength / payloadLimit);
  const chunkId = `rpc-${++chunkCounter}`;
  const corrupt = (mode === "corrupt-catalog" && frame.command === "get_available_models")
    || (mode === "corrupt-turn" && frame.type === "message_update");
  const fault = corrupt ? process.env.FAKE_OMP_CHUNK_FAULT ?? "index" : undefined;
  if (fault === "utf8") bytes[0] = 0xff;
  if (fault === "json") bytes[0] = 0x21;
  if (fault === "object") { bytes.fill(32); bytes.write("[]"); }
  for (let index = 0; index < count; index++) {
    const chunk = {
      type: "rpc_chunk", chunkId, index, count, byteLength,
      data: bytes.subarray(index * payloadLimit, (index + 1) * payloadLimit).toString("base64"),
    };
    if (fault === "excess") chunk.byteLength--;
    if (index === 0) {
      if (fault === "start") chunk.index = 1;
      if (fault === "count-min") chunk.count = 1;
      if (fault === "count-max") chunk.count = Math.ceil(reassemblyLimit / payloadLimit) + 1;
      if (fault === "id-empty") chunk.chunkId = "";
      if (fault === "oversized") chunk.byteLength = reassemblyLimit + 1;
      if (fault === "base64") chunk.data = "not base64!";
      if (fault === "noncanonical") chunk.data = "AB==";
      if (fault === "payload") chunk.data = Buffer.alloc(payloadLimit + 1).toString("base64");
    }
    if (index === 1) {
      if (fault === "index") chunk.index++;
      if (fault === "id") chunk.chunkId += "-other";
      if (fault === "count") chunk.count++;
      if (fault === "length") chunk.byteLength++;
      if (fault === "interrupted") { writeFrame({ type: "session_settled" }); return; }
    }
    if (index === count - 1 && fault === "short") chunk.data = bytes.subarray(index * payloadLimit, byteLength - 1).toString("base64");
    writeFrame(chunk);
    if (index === 0 && fault === "truncated") {
      outputClosed = true;
      process.stdout.end();
      return;
    }
  }
};
const reply = (cmd: Command, data?: unknown) => send({ type: "response", id: cmd.id, command: cmd.type, success: true, ...(data === undefined ? {} : { data }) });
const refuse = (cmd: Command, error: string) => send({ type: "response", id: cmd.id, command: cmd.type, success: false, error });
const assistant = (usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }) => ({
  role: "assistant", content: [], api: "anthropic-messages", provider: "anthropic", model: "claude-sonnet",
  usage, stopReason: "stop", timestamp: Date.now(),
});
const delta = (text: string, type = "text_delta") => send({
  type: "message_update", message: assistant(),
  assistantMessageEvent: { type, contentIndex: 0, delta: text, partial: assistant() },
});
let sessionFile: string | null = null;
const sessionId = randomUUID();
let model = models[0];
let promptId: string | null = null;
let asyncPending = false;
let dialogId: string | null = null;
const result = (status = "completed", sessionSettled = true, error?: { message: string; retryable: boolean }) => {
  send({ type: "prompt_result", id: promptId, agentInvoked: true, status, sessionSettled, ...(error ? { error } : {}) });
  if (sessionSettled || status !== "completed") promptId = null;
};
const usage = (input: number, output: number, cacheRead: number, cacheWrite: number, cost: number) => send({
  type: "message_end",
  message: assistant({ input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } }),
});
const happy = () => {
  delta("Checking the request", "thinking_delta");
  delta("Hello");
  usage(12, 3, 5, 2, 0.125);
  // User message usage must not pollute the assistant's aggregate.
  send({ type: "message_end", message: { role: "user", content: "User message", timestamp: Date.now(), usage: { input: 999, output: 999, cacheRead: 0, cacheWrite: 0, cost: { total: 99 } } } });
  delta(" from");
  delta(" omp");
  usage(7, 4, 2, 1, 0.25);
  result();
};
const openEditor = (id: string, title: string) => {
  dialogId = id;
  send({ type: "extension_ui_request", id, method: "editor", title });
};
const startPrompt = (cmd: Command) => {
  promptId = cmd.id;
  if (mode === "prompt-reject") {
    refuse(cmd, "fake omp: prompt rejected");
    return;
  }
  const local = mode === "slash" || (mode === "manual-compaction" && cmd.message === "/compact");
  reply(cmd, { agentInvoked: !local });
  if (local) { promptId = null; return; }
  switch (mode) {
    case "large-turn":
    case "corrupt-turn":
      delta("🙂é".repeat(Number(process.env.FAKE_OMP_TEXT_REPEATS ?? 4096)));
      result();
      return;
    case "error":
      result("error", true, { message: "Provider quota exhausted", retryable: false });
      return;
    case "async":
    case "async-error":
    case "async-aborted":
      delta("Initial reply");
      usage(4, 1, 2, 0, 0.125);
      result(mode === "async-error" ? "error" : mode === "async-aborted" ? "aborted" : "completed", false,
        mode === "async-error" ? { message: "Provider quota exhausted", retryable: false } : undefined);
      asyncPending = true;
      // This observable checkpoint follows prompt_result in the same stream.
      delta("; background work pending");
      return;
    case "malformed-result":
      send({ type: "prompt_result", id: promptId, agentInvoked: true, status: "not-a-status", sessionSettled: true });
      delta("Invalid result ignored");
      return;
    case "delayed-exit":
      delta(process.env.FAKE_OMP_RESUMED_HISTORY ? `Resumed: ${process.env.FAKE_OMP_RESUMED_HISTORY}` : "First turn");
      result();
      return;
    case "stall-exit":
      happy();
      return;
    case "late-frames":
      openEditor("before-stop", "Stop this turn");
      return;
    case "confirm":
      dialogId = "confirm-1";
      send({ type: "extension_ui_request", id: dialogId, method: "confirm", title: "Host computer", message: "Allow this action?" });
      return;
    case "input":
      dialogId = "input-1";
      send({ type: "extension_ui_request", id: dialogId, method: "input", title: "Enter a value" });
      return;
    case "select":
      dialogId = "select-1";
      send({ type: "extension_ui_request", id: dialogId, method: "select", title: "Choose a value", options: ["One", "Two"] });
      return;
    case "approval":
      dialogId = "approval-1";
      send({ type: "tool_execution_start", toolCallId: "bash-1", toolName: "bash", args: { command: "echo hi" } });
      send({ type: "extension_ui_request", id: dialogId, method: "select", title: "Allow tool: bash\necho hi", options: ["Approve", "Deny"] });
      return;
    case "ask":
    case "ask-too-many":
    case "ask-duplicate":
      dialogId = "ask-1";
      send({ type: "extension_ui_request", id: dialogId, method: "ask", questions: mode === "ask-too-many"
        ? Array.from({ length: 7 }, (_, index) => ({ id: String(index), question: `Question ${index}?`, options: [{ label: "Yes" }] }))
        : [
          { id: "color", question: "Which color?", header: "Color", options: [{ label: "Blue" }, { label: "Green" }], recommended: 0 },
          { id: mode === "ask-duplicate" ? "color" : "city", question: "Which city?", options: [{ label: "Paris" }, { label: "Tokyo" }] },
        ] });
      return;
    case "editor":
      openEditor("editor-1", "Describe the change");
      return;
    case "cancel":
      openEditor("cancelled-1", "This dialog will close");
      send({ type: "extension_ui_request", id: "cancel-1", method: "cancel", targetId: "cancelled-1" });
      openEditor("continue-1", "Continue after cancellation");
      return;
    case "tooluse":
      delta("Before shell");
      send({ type: "tool_execution_start", toolCallId: "bash-1", toolName: "bash", args: { command: "echo hi" } });
      send({ type: "tool_execution_end", toolCallId: "bash-1", toolName: "bash", result: { content: [{ type: "text", text: "hi" }] }, isError: false });
      delta("After shell");
      result();
      return;
    case "xdev":
      send({ type: "tool_execution_start", toolCallId: "device-1", toolName: "write", args: { path: "xd://browser", content: { action: "navigate", url: "https://example.test" } } });
      send({ type: "tool_execution_end", toolCallId: "device-1", toolName: "write", result: { title: "Example" }, isError: false });
      delta("Device finished");
      result();
      return;
    case "compaction":
      send({ type: "auto_compaction_start", reason: "threshold", action: "context-full" });
      send({ type: "auto_compaction_end", action: "context-full", aborted: false, willRetry: false });
      happy();
      return;
    default:
      happy();
  }
};

send({
  type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: frameLimit,
  maxReassembledFrameBytes: Number(process.env.FAKE_OMP_ADVERTISED_REASSEMBLY_LIMIT ?? reassemblyLimit),
});
send({ type: "extension_ui_request", id: "w1", method: "setWidget", widgetKey: "x" });
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline: number;
  while ((newline = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    handle(JSON.parse(line) as Command);
  }
});
process.stdin.on("end", () => {
  dump({ lifecycle: "stdin-ended" });
  if (mode === "stall-exit") {
    setInterval(() => {}, 60_000);
    return;
  }
  const finish = () => {
    if (sessionFile && mode === "delayed-exit") writeFileSync(sessionFile, "flushed first turn");
    process.stdout.end(() => process.exit(0));
  };
  const gate = process.env.FAKE_OMP_EXIT_GATE;
  if (mode !== "delayed-exit" || !gate || existsSync(gate)) { finish(); return; }
  const watcher = watch(process.env.FAKE_OMP_SESSION_DIR ?? tmpdir(), () => {
    if (!existsSync(gate)) return;
    watcher.close();
    finish();
  });
  if (existsSync(gate)) { watcher.close(); finish(); }
});

function handle(cmd: Command) {
  dump({ command: cmd });
  switch (cmd.type) {
    case "negotiate_protocol":
      if (cmd.protocolVersion !== 2) refuse(cmd, `Unsupported RPC protocol version: ${String(cmd.protocolVersion)}`);
      else {
        reply(cmd, { protocolVersion: 2 });
        protocolVersion = 2;
      }
      return;
    case "set_ask_dialog":
      if (mode === "ask-refuse") refuse(cmd, "Structured ask dialog unavailable");
      else reply(cmd, { enabled: true });
      return;
    case "new_session": {
      const directory = process.env.FAKE_OMP_SESSION_DIR ?? tmpdir();
      mkdirSync(directory, { recursive: true });
      sessionFile = join(directory, `fake-omp-${randomUUID()}.jsonl`);
      writeFileSync(sessionFile, "");
      reply(cmd, { cancelled: false });
      return;
    }
    case "switch_session":
      if (process.env.FAKE_OMP_SWITCH_REFUSE === "1") refuse(cmd, "Session unavailable");
      else if (process.env.FAKE_OMP_SWITCH_CANCEL === "1") reply(cmd, { cancelled: true });
      else if (process.env.FAKE_OMP_SWITCH_MISMATCH === "1") reply(cmd, { cancelled: false });
      else {
        if (typeof cmd.sessionPath !== "string") throw new Error("Missing session path");
        sessionFile = cmd.sessionPath;
        if (mode === "delayed-exit") {
          process.env.FAKE_OMP_RESUMED_HISTORY = readFileSync(sessionFile, "utf8");
          if (!process.env.FAKE_OMP_RESUMED_HISTORY) { refuse(cmd, "Session was not flushed"); return; }
        }
        reply(cmd, { cancelled: false });
      }
      return;
    case "get_state": {
      const state = { ...(sessionFile ? { sessionFile } : {}), sessionId, ...(model ? { model } : {}) };
      dump({ state });
      reply(cmd, state);
      return;
    }
    case "get_available_models":
      reply(cmd, { models });
      return;
    case "set_model":
      if (typeof cmd.provider === "string" && typeof cmd.modelId === "string"
        && (models.some((entry) => entry.provider === cmd.provider && entry.id === cmd.modelId)
          || (localProvider?.name === cmd.provider && localProvider?.model === cmd.modelId))) {
        model = models.find((entry) => entry.provider === cmd.provider && entry.id === cmd.modelId) ?? {
          provider: cmd.provider, id: cmd.modelId, name: cmd.modelId,
          api: "openai-completions", baseUrl: "http://127.0.0.1:11434/v1", reasoning: false,
          input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128_000, maxTokens: 8192,
        };
        reply(cmd, model);
      } else refuse(cmd, "Model not found");
      return;
    case "set_thinking_level":
      reply(cmd);
      return;
    case "prompt":
      startPrompt(cmd);
      return;
    case "steer":
      if (process.env.FAKE_OMP_STEER_REFUSE === "1") refuse(cmd, "Steering refused");
      else {
        reply(cmd);
        if (asyncPending) {
          asyncPending = false;
          delta("; background finished");
          usage(8, 2, 3, 0, 0.25);
          send({ type: "session_settled" });
          promptId = null;
        }
      }
      return;
    case "abort":
      reply(cmd);
      if (promptId) result("aborted");
      if (mode === "late-frames") {
        delta("Late content");
        send({ type: "tool_execution_start", toolCallId: "late-tool", toolName: "bash", args: { command: "echo late" } });
        send({ type: "tool_execution_end", toolCallId: "late-tool", toolName: "bash", isError: false });
        openEditor("late-card", "Unanswerable question");
        dump({ lifecycle: "late-frames-sent" });
      }
      return;
    case "extension_ui_response":
      if (cmd.id !== dialogId) return;
      dialogId = null;
      if (mode === "approval") {
        send({ type: "tool_execution_end", toolCallId: "bash-1", toolName: "bash", result: { content: [{ type: "text", text: cmd.value === "Approve" ? "hi" : "Denied" }] }, isError: cmd.value !== "Approve" });
      }
      delta("Answer received");
      result();
      return;
    default:
      refuse(cmd, "Unknown command");
  }
}
