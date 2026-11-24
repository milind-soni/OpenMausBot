#!/usr/bin/env node
// Fake of the codex CLI's `app-server` JSON-RPC surface (NDJSON on stdio) for driver tests; like
// the real one it never exits on its own. Env knobs:
//   FAKE_CODEX_MODE  happy (default) | approval | resume | stream | windows-command | mcp-elicitation |
//     mcp-app-approval | mcp-form | permissions-approval | question | multi-question | mixed-question |
//     empty-question | malformed-question | config-profile | config-profile-unsupported | config-read-error |
//     image | logged-in-stdout | logged-out | unauthorized | late-request | retry-then-complete | signin-refused |
//     auth-recovery | mcp-401 | mcp-image | legacy-error | key-401 | recovered-403 | recovered-401 | recovering-403 | usage-limit
//     | plan-unsupported-input (a resumed thread's turns fail as a ChatGPT plan refuses saved audio; a new thread works)
//     | async-question (an agentMessage with delivery async and questions, as codex 0.160 sends request_user_input_async)
//   FAKE_CODEX_MISSING_BEARER  the first N launches fail their turn as codex-cli 0.160.1 holding no login does (count in FAKE_CODEX_STATE)
//   FAKE_CODEX_LAUNCH_CRASHES  the first N launches die pre-ack at turn/start, transient stderr, exit 1 (count in FAKE_CODEX_STATE)
//   FAKE_CODEX_LAUNCH_KILLS  the same by SIGKILL (POSIX-shaped; win32 reports exit 1, signal null)
//   FAKE_CODEX_LAUNCH_SILENT  the same with exit 1 and no stderr
//   FAKE_CODEX_ACK_CRASH  gate file: hold the post-ack crash until the driver parsed the ack
//   FAKE_CODEX_EXIT_MID_TURN  gate file: hold the ack/delta stdout until the stale websocket-426 stderr was read
//   FAKE_CODEX_EXIT_MID_TURN_KILL  gate file: hold the SIGKILL until the reasoning delta was parsed
//   FAKE_CODEX_ASK_HOLD  question modes: record the ask reply and hold the turn open
//   FAKE_CODEX_ASYNC_QUESTIONS  async-question mode: JSON replacing the message's `questions`
//   FAKE_CODEX_ASYNC_QUESTION_GATE  async-question mode: the turn keeps running until this file exists (default 300 ms)
//   FAKE_CODEX_DUMP  path for {pid, argv, env, calls, decision}
//   FAKE_CODEX_ACTION_LOG  early-tool-timeout/error: append an action before turn/start times out or fails
//   FAKE_CODEX_ECHO_INPUT  "1": echo turn/start's input back as a userMessage item, as codex-cli 0.164.0 does
//   FAKE_CODEX_COMMAND  the happy turn's one call, this command (default: "ls -la" and a web search);
//     FAKE_CODEX_COMMAND_OUTPUT  JSON chunks it prints as item/commandExecution/outputDelta notifications, one every
//     FAKE_CODEX_COMMAND_OUTPUT_MS (default all at once); FAKE_CODEX_COMMAND_GATE  the turn finishes once this file exists
//   FAKE_STREAM_SCRIPT, FAKE_STREAM_CADENCE  a scripted reply chosen by a marker in the prompt (as stream-script.ts)
//   FAKE_CODEX_PATCH_BYTES  each turn first writes web/index.html by apply_patch, streamed as two
//     item/fileChange/patchUpdated notifications (codex-cli 0.160.1's schema) of half and all this many bytes
//   FAKE_CODEX_COMPACTION  "1": each turn first compacts its context, as codex-cli 0.160.1 reports it (a contextCompaction item)
//   FAKE_CODEX_IGNORE_FEATURES  "1": config/read reports no `-c features.*` override
//   FAKE_CODEX_SHELL_ENVIRONMENT_POLICY  JSON config/read reports, every field present and null unless set (codex-cli 0.160)
//   FAKE_CODEX_APPROVAL_REQUEST  JSON {method, params} override in approval mode
//   FAKE_CODEX_ACCOUNT_EMAIL  synthetic ChatGPT identity (default ada@example.test)
//   FAKE_CODEX_ACCOUNT_MODE  chatgpt (default) | api-key | none | unsupported | error | hang
//   FAKE_CODEX_RESUME_ERROR  JSON-RPC error rejecting thread/resume
//   FAKE_CODEX_ARCHIVED  "1": thread/resume says the session is archived until thread/unarchive; "unarchive-fails": unarchive is refused too
//   FAKE_CODEX_INSTRUCTIONS_FILE  while this file exists, config/read reports its text as developer_instructions: the
//     person's configuration changed while the process ran (codex-cli 0.160.1 reads the files on every config/read)
//   FAKE_CODEX_DIE_ON_TURN  this process is killed as its Nth turn/start arrives, before any reply
//   FAKE_CODEX_STARTUP_DELAY_MS  hold the initialize reply this long, like a loaded host
//   FAKE_CODEX_STARTUP_LOG  append {pid, at, event: "initialize" | "turn/start"} per launch
//   FAKE_CODEX_START_ERROR  JSON-RPC error rejecting thread/start
//   FAKE_CODEX_MCP_FAILED  MCP server whose startup fails (`mcpServer/startupStatus/updated`) as thread/start begins
//   FAKE_CODEX_RESTORED_USAGE  report 100/50/10 tokens used before turn/start, as a resumed thread can
//   FAKE_CODEX_STEER_ERROR  JSON-RPC error rejecting turn/steer
//   FAKE_CODEX_STEER_ERROR_FILE  reject turn/steer only while this file exists
//   FAKE_CODEX_STEER_HANG  accept turn/steer and never answer
//   FAKE_CODEX_INTERRUPT_SILENT  ignore turn/interrupt
//   FAKE_CODEX_INTERRUPT_GRACE_MS  driver-side grace before escalating an interrupt
//   FAKE_CODEX_ROOM_PLAN  plan path: each turn runs room-handoff-agent.ts against the agents MCP server
//   FAKE_CODEX_COMPLETE_BEFORE_ACK  with FAKE_CODEX_ROOM_PLAN: stream the whole turn before acknowledging turn/start
//   FAKE_CODEX_TEXT_ROUTES  `codex exec`: JSON {"marker": "reply"}; the first marker in the prompt picks the reply
//   FAKE_CODEX_TEXT_REPLY  `codex exec` reply when no route matches (default "fake background answer")
//   FAKE_CODEX_TEXT_LOG  `codex exec`: append {argv, cwd, prompt, env} per call
//   FAKE_CODEX_TEXT_MODE  `codex exec`: ok (default) | fail | exit | hang | tool | noisy
//   FAKE_CODEX_TEXT_REFUSE  `codex exec`: comma-separated models answered with the 400 a ChatGPT account gets for gpt-5.4-mini
//   FAKE_CODEX_TEXT_BLOCK  `codex exec`: comma-separated models answered with the 403 OpenAI sends a region it does not serve
//   FAKE_CODEX_LUNA  "1": model/list also offers gpt-6-luna
//   FAKE_CODEX_TIERS  "1": model/list rows list a Fast service tier, as codex-cli 0.167.2 does; gpt-page-two
//     already runs on it by default. Set FAKE_CODEX_ULTRAFAST="1" alongside it to also include Ultrafast.
//   FAKE_CODEX_EFFORTS  "1": model/list rows declare supportedReasoningEfforts (gpt-fake-default includes "ultra", gpt-page-two stops at "max")
//   FAKE_CODEX_UPDATED_FILE  while this file exists, the CLI was updated in place: --version answers codex-cli 0.162.1
//     and model/list also offers gpt-6.1-sol
//   FAKE_CODEX_MCP_START  "1": on thread/start, start each `-c mcp_servers.*` mount as codex-cli 0.160.1 does
//     (its initialize, or FAKE_CODEX_MCP_HANDSHAKE) and dump mcpStartup[name]
//   FAKE_CODEX_MCP_READY_MS  each `-c mcp_servers.*` mount is reported starting after the thread/start or
//     thread/resume reply and ready at once, as codex-cli 0.166.0 does; with this, ready only this many ms
//     later, and the dump records mcpReadyAtTurnStart
//   FAKE_CODEX_CALL_LOG  append {pid, method, params} per request, across every process launched
//   FAKE_CODEX_THREAD_IDS  "distinct": thread/start names its thread codex-thread-<pid>-<n>, not always codex-thread-1
//   FAKE_CODEX_CONTEXT_TOKENS  the context reading (last.inputTokens) turns report, 7 by default: one number, or one per finished turn
//     separated by commas (the last repeats);
//     FAKE_CODEX_CONTEXT_TOKENS_AFTER_COMPACT  the reading once a thread/compact/start has completed
//   FAKE_CODEX_COMPACT  thread/compact/start: unset (compacts, as codex-cli 0.171.0 does: the request returns {}, then the thread
//     runs a turn with a contextCompaction item and reports no usage) | error | unsupported (method not found) | hang (the turn
//     never completes; turn/interrupt for its turn ends it); FAKE_CODEX_COMPACT_MS how long the turn takes (default 20);
//     FAKE_CODEX_COMPACT_HELPER "1": a helper thread's turn/completed and token usage arrive during it;
//     FAKE_CODEX_COMPACT_USAGE  JSON {inputTokens, outputTokens, cachedInputTokens} added to the thread's total by it
//   FAKE_CODEX_CONFIG_HANG_AFTER_TURNS  config/read is never answered once this many turns have finished
//   FAKE_CODEX_COMPACT_HOLD_FILE  a compaction that starts while this file exists completes once it is removed
//   FAKE_CODEX_COMPACT_NO_USAGE  "1": the compaction sends no thread/tokenUsage/updated at all
//   FAKE_CODEX_CONFIG_HOLD_FILE  a config/read that arrives while this file exists is answered once it is removed
//   FAKE_CODEX_CONFIG_HANG_FILE, FAKE_CODEX_CONFIG_ERROR_FILE  config/read is never answered / answered with an error while the file exists
//   FAKE_CODEX_ROLLOUT  rollout path thread/start and thread/resume report as `thread.path`; each happy turn appends a
//     namespace-less function_call for retry_thread and codex's "unsupported call: retry_thread" output to it
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";


const mode = process.env.FAKE_CODEX_MODE ?? "happy";
const tiers = process.env.FAKE_CODEX_TIERS === "1";
const efforts = process.env.FAKE_CODEX_EFFORTS === "1";
const ultrafastTier = process.env.FAKE_CODEX_ULTRAFAST === "1";
const FAST_TIERS = [
  { id: "priority", name: "Fast", description: "Fastest inference with increased plan usage" },
  ...(ultrafastTier
    ? [
        null,
        { id: "flex", name: "Flex", description: "Non-fast tier should not be emitted." },
        { id: "bad tier", name: "Fast", description: "Invalid tier id should be ignored." },
        { id: "blank", name: "   ", description: "Whitespace-only tier name should be ignored." },
        { id: "ultrafast", name: "Ultrafast", description: "The fastest available responses for latency-sensitive work." },
        { id: "ultrafast", name: "Ultrafast", description: "Duplicate entry to verify deduplication." },
      ]
    : []),
];

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

// stdout and stderr are separate pipes the writer cannot order, so these gates wait on the test
// (it creates the file once the driver consumed the earlier stream) instead of a sleep.
const waitForGate = (path: string | undefined, timeoutMs = 15_000): Promise<void> =>
  new Promise((resolve) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if ((path !== undefined && existsSync(path)) || Date.now() - startedAt > timeoutMs) {
        clearInterval(timer);
        resolve();
      }
    }, 2);
  });

const updated = Boolean(process.env.FAKE_CODEX_UPDATED_FILE && existsSync(process.env.FAKE_CODEX_UPDATED_FILE));

if (process.argv[2] === "--version") {
  process.stdout.write(`${updated ? "codex-cli 0.162.1" : process.env.FAKE_CODEX_VERSION ?? "codex-cli 0.147.0"}\n`);
  process.exit(0);
}
if (process.argv[2] === "login" && process.argv[3] === "status") {
  if (mode === "logged-out") {
    process.stderr.write("Not logged in\n");
    process.exit(1);
  }
  if (mode === "api-key-configured") {
    process.stderr.write("API key configured - sk-fake-****\nAuthentication is checked when you send a request.\n");
    process.exit(0);
  }
  // Codex 0.147.0 reports a successful login on stderr; older versions wrote it on stdout.
  const statusStream = mode === "logged-in-stdout" ? process.stdout : process.stderr;
  statusStream.write("Logged in using ChatGPT\n");
  process.exit(0);
}
if (process.argv[2] === "exec") {
  // `codex exec --json … -`: prompt on stdin, answer as exec's JSONL events (codex-cli 0.160.1).
  const prompt = await new Promise<string>((resolve) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => resolve(input));
  });
  const textMode = process.env.FAKE_CODEX_TEXT_MODE ?? "ok";
  if (process.env.FAKE_CODEX_TEXT_LOG) {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(?:HOME|CODEX_HOME|OPENAI_API_KEY|OPENMAUSBOT_.*)$/.test(key)));
    appendFileSync(process.env.FAKE_CODEX_TEXT_LOG, `${JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), prompt, env })}\n`);
  }
  const event = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
  if (textMode === "hang") {
    // An unsettled top-level await is fatal in Node; a repeating timer keeps the loop alive.
    await new Promise(() => setInterval(() => {}, 1 << 30));
  }
  if (textMode === "exit") {
    process.stderr.write("Error: stream disconnected before completion\n");
    process.exit(1);
  }
  event({ type: "thread.started", thread_id: "fake-exec-thread" });
  event({ type: "turn.started" });
  const model = process.argv[process.argv.indexOf("--model") + 1] ?? "";
  if (process.env.FAKE_CODEX_TEXT_REFUSE?.split(",").includes(model)) {
    const message = `unexpected status 400 Bad Request: {"type":"invalid_request_error","message":"The '${model}' model is not supported when using Codex with a ChatGPT account."}`;
    event({ type: "error", message });
    event({ type: "turn.failed", error: { message } });
    process.exit(1);
  }
  if (process.env.FAKE_CODEX_TEXT_BLOCK?.split(",").includes(model)) {
    const message = 'unexpected status 403 Forbidden: {"error":{"code":"unsupported_country_region_territory","message":"Country, region, or territory not supported","param":null,"type":"request_forbidden"}}';
    event({ type: "error", message });
    event({ type: "turn.failed", error: { message } });
    process.exit(1);
  }
  if (textMode === "fail") {
    event({ type: "error", message: "unexpected status 401 Unauthorized" });
    event({ type: "turn.failed", error: { message: "unexpected status 401 Unauthorized" } });
    process.exit(1);
  }
  if (textMode === "tool") {
    event({ type: "item.started", item: { id: "item_0", type: "command_execution", command: "ls", aggregated_output: "", status: "in_progress" } });
  }
  if (textMode === "noisy") {
    process.stdout.write("Reading prompt from stdin...\n");
    event({ type: "item.completed", item: { id: "item_0", type: "error", message: "a non-fatal notice" } });
    event({ type: "item.completed", item: { id: "item_1", type: "reasoning", text: "thinking" } });
  }
  let reply = process.env.FAKE_CODEX_TEXT_REPLY ?? "fake background answer";
  if (process.env.FAKE_CODEX_TEXT_ROUTES && existsSync(process.env.FAKE_CODEX_TEXT_ROUTES)) {
    try {
      const routes = JSON.parse(readFileSync(process.env.FAKE_CODEX_TEXT_ROUTES, "utf8")) as Record<string, string>;
      const hit = Object.entries(routes).find(([marker]) => prompt.includes(marker));
      if (hit) reply = hit[1];
    } catch {}
  }
  event({ type: "item.completed", item: { id: "item_2", type: "agent_message", text: reply } });
  event({ type: "turn.completed", usage: { input_tokens: 120, cached_input_tokens: 20, output_tokens: 7 } });
  process.exit(0);
}
const calls: Array<{ method: string; params: unknown }> = [];
/** A `-c` value as codex-cli reads it: JSON-compatible TOML, or an inline table of strings (`env`, `http_headers`). */
const tomlValue = (raw: string): unknown => raw.startsWith("{")
  ? Object.fromEntries([...raw.matchAll(/("(?:[^"\\]|\\.)*")\s*=\s*("(?:[^"\\]|\\.)*")/g)].map((pair) => [JSON.parse(pair[1]!), JSON.parse(pair[2]!)]))
  : JSON.parse(raw);
const mcpOverrides: Record<string, Record<string, unknown>> = {};
for (let index = 0; process.env.FAKE_CODEX_MCP_OVERRIDES === "1" && index < process.argv.length; index++) {
  if (process.argv[index - 1] === "-c" && process.argv[index]!.startsWith("mcp_servers=")) {
    // The real CLI replaces its accumulated override table before later dotted-path fields apply.
    for (const name of Object.keys(mcpOverrides)) delete mcpOverrides[name];
    for (const [, key] of process.argv[index]!.matchAll(/("(?:[^"\\]|\\.)*") = \{ enabled = false \}/g)) mcpOverrides[JSON.parse(key!) as string] = { enabled: false };
    continue;
  }
  const match = process.argv[index - 1] === "-c" ? /^mcp_servers\.([^.]+)\.([^.]+)=(.*)$/.exec(process.argv[index]!) : null;
  if (match) (mcpOverrides[match[1]!] ??= {})[match[2]!] = tomlValue(match[3]!);
}
// codex-cli 0.160 config/read reports every shell_environment_policy field, null when unset. A `-c
// shell_environment_policy.exclude=[…]` override replaces the list and drops the lower `filters` (0.160.1).
const shellExcludeOverride = process.argv.reduce<unknown>((found, arg, index) => {
  const match = process.argv[index - 1] === "-c" ? /^shell_environment_policy\.exclude=(.*)$/.exec(arg) : null;
  return match ? JSON.parse(match[1]!) : found;
}, undefined);
const shellEnvironmentPolicy = (): unknown => {
  const unset = { inherit: null, ignore_default_excludes: null, exclude: null, set: null,
    include_only: null, filters: null, experimental_use_profile: null };
  const supplied: unknown = process.env.FAKE_CODEX_SHELL_ENVIRONMENT_POLICY ? JSON.parse(process.env.FAKE_CODEX_SHELL_ENVIRONMENT_POLICY) : {};
  if (!supplied || typeof supplied !== "object" || Array.isArray(supplied)) return supplied;
  return { ...unset, ...supplied, ...(shellExcludeOverride !== undefined ? { exclude: shellExcludeOverride, filters: null } : {}) };
};
let developerInstructions = "";
let resumedThread: string | null = null;
let unarchived = false;
const logStartup = (event: string) => {
  if (process.env.FAKE_CODEX_STARTUP_LOG) appendFileSync(process.env.FAKE_CODEX_STARTUP_LOG, `${JSON.stringify({ pid: process.pid, at: Date.now(), event })}\n`);
};
let decision: unknown = null;
let experimentalApi = false;

const out = (obj: unknown) => process.stdout.write(JSON.stringify(obj) + "\n");
let nativeThreadId = "codex-thread-1";
let nativeTurnId = "turn-1";
let turnsStarted = 0;
let turnsFinished = 0;
let threadsStarted = 0;
let compactions = 0;
/** What compactions added to the thread's token total: it is cumulative, so every later turn's total carries it. */
const compactedUsage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
let compactingTurn: string | null = null;
const startedThreadId = () => {
  threadsStarted += 1;
  if (process.env.FAKE_CODEX_THREAD_IDS === "distinct") nativeThreadId = `codex-thread-${process.pid}-${threadsStarted}`;
  return nativeThreadId;
};
const notify = (method: string, params: any) => out({
  jsonrpc: "2.0", method,
  params: {
    threadId: nativeThreadId,
    ...(method.startsWith("turn/") ? {} : { turnId: nativeTurnId }),
    ...params,
    ...(params.turn ? { turn: { id: nativeTurnId, ...params.turn } } : {}),
  },
});

// The response and restored usage notification may share one stdout chunk; force that ordering.
const resolvedSandbox = (params: Record<string, unknown>) => {
  if (process.env.FAKE_CODEX_RESOLVED_SANDBOX) return JSON.parse(process.env.FAKE_CODEX_RESOLVED_SANDBOX);
  if (params.sandbox === "danger-full-access") return { type: "dangerFullAccess" };
  if (params.sandbox === "workspace-write") return {
    type: "workspaceWrite", networkAccess: false, writableRoots: [],
    excludeTmpdirEnvVar: false, excludeSlashTmp: false,
  };
  return { type: "readOnly" };
};

type McpStartup = { status: "ready"; tools: string[] } | { status: "failed"; error: string };
let mcpStartup: Record<string, McpStartup> | undefined;
/** codex-cli 0.160.1's initialize for every server it connects. */
const CODEX_MCP_HANDSHAKE = { protocolVersion: "2025-06-18", capabilities: { elicitation: { form: {}, url: {} } }, clientInfo: { name: "codex-mcp-client", title: "Codex", version: "0.160.1" } };
const mcpMounts = (): Record<string, Record<string, unknown>> => {
  const mounts: Record<string, Record<string, unknown>> = {};
  process.argv.forEach((arg, index) => {
    const match = process.argv[index - 1] === "-c" ? /^mcp_servers\.([^.]+)\.([^.=]+)=(.*)$/.exec(arg) : null;
    if (!match) return;
    (mounts[match[1]!] ??= {})[match[2]!] = tomlValue(match[3]!);
  });
  return mounts;
};
const mcpError = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 500);
const startStdioMcp = (mount: Record<string, unknown>, handshake: unknown): Promise<McpStartup> => new Promise((resolve) => {
  const env: Record<string, string> = {};
  for (const name of ["PATH", "HOME"]) if (process.env[name]) env[name] = process.env[name]!;
  for (const name of (mount.env_vars ?? []) as string[]) if (process.env[name] !== undefined) env[name] = process.env[name]!;
  Object.assign(env, mount.env ?? {});
  const child = spawn(mount.command as string, (mount.args ?? []) as string[], { env, stdio: ["pipe", "pipe", "ignore"] });
  const done = (result: McpStartup) => { clearTimeout(timer); child.kill(); resolve(result); };
  const timer = setTimeout(() => done({ status: "failed", error: "startup timed out" }), 20_000);
  child.on("error", (error) => done({ status: "failed", error: mcpError(error) }));
  const write = (frame: object) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...frame })}\n`);
  let pending = "";
  child.stdout.on("data", (chunk) => {
    pending += chunk;
    for (let nl = pending.indexOf("\n"); nl !== -1; nl = pending.indexOf("\n")) {
      const line = pending.slice(0, nl);
      pending = pending.slice(nl + 1);
      let frame: any;
      try { frame = JSON.parse(line); } catch { continue; }
      if (frame.error) return done({ status: "failed", error: mcpError(frame.error.message) });
      if (frame.id === 1) { write({ method: "notifications/initialized" }); write({ id: 2, method: "tools/list", params: {} }); }
      if (frame.id === 2) return done({ status: "ready", tools: (frame.result?.tools ?? []).map((tool: { name: string }) => tool.name) });
    }
  });
  write({ id: 1, method: "initialize", params: handshake });
});
const startUrlMcp = async (mount: Record<string, unknown>, handshake: unknown): Promise<McpStartup> => {
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (typeof mount.bearer_token_env_var === "string") headers.authorization = `Bearer ${process.env[mount.bearer_token_env_var] ?? ""}`;
  for (const [header, variable] of Object.entries((mount.env_http_headers ?? {}) as Record<string, string>)) headers[header] = process.env[variable] ?? "";
  Object.assign(headers, mount.http_headers ?? {});
  const post = async (frame: object) => {
    const response = await fetch(mount.url as string, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", ...frame }), signal: AbortSignal.timeout(20_000) });
    const session = response.headers.get("mcp-session-id");
    if (session) headers["mcp-session-id"] = session;
    const text = await response.text();
    const body = text.split("\n").find((line) => line.startsWith("data:"))?.slice(5) ?? text;
    const parsed = body.trim() ? JSON.parse(body) : {};
    if (!response.ok || parsed.error) throw new Error(`HTTP ${response.status}: ${parsed.error?.message ?? ""}`);
    return parsed.result;
  };
  try {
    await post({ id: 1, method: "initialize", params: handshake });
    await post({ method: "notifications/initialized" });
    const listed = await post({ id: 2, method: "tools/list", params: {} });
    return { status: "ready", tools: (listed?.tools ?? []).map((tool: { name: string }) => tool.name) };
  } catch (error) { return { status: "failed", error: mcpError(error) }; }
};
const startMcpServers = async (): Promise<Record<string, McpStartup>> => {
  const handshake = process.env.FAKE_CODEX_MCP_HANDSHAKE ? JSON.parse(process.env.FAKE_CODEX_MCP_HANDSHAKE) : CODEX_MCP_HANDSHAKE;
  const entries = await Promise.all(Object.entries(mcpMounts()).filter(([, mount]) => mount.enabled !== false).map(async ([name, mount]) =>
    [name, typeof mount.url === "string" ? await startUrlMcp(mount, handshake) : await startStdioMcp(mount, handshake)] as const));
  return Object.fromEntries(entries);
};

let mcpPending: string[] = [];
let mcpReadyAtTurnStart: boolean | undefined;
// codex-cli 0.166.0 answers the thread request first and reports each server's startup after it.
const announceMcpStartup = () => {
  const report = (name: string, status: string, error: string | null = null) =>
    out({ jsonrpc: "2.0", method: "mcpServer/startupStatus/updated", params: { threadId: null, name, status, error, failureReason: null } });
  mcpPending = Object.entries(mcpMounts())
    // Every server it starts, by command or by URL (OpenMausBot's own, with OMB_OWN_MCP_HTTP=1).
    .filter(([name, fields]) => ("command" in fields || "url" in fields) && fields.enabled !== false && name !== process.env.FAKE_CODEX_MCP_FAILED)
    .map(([name]) => name);
  for (const name of mcpPending) report(name, "starting");
  const settle = (name: string) => {
    mcpPending = mcpPending.filter((pending) => pending !== name);
    const started = mcpStartup?.[name];
    if (started?.status === "failed") report(name, "failed", started.error);
    else report(name, "ready");
  };
  const delayMs = Number(process.env.FAKE_CODEX_MCP_READY_MS) || 0;
  for (const [index, name] of [...mcpPending].entries()) {
    const delay = delayMs * (process.env.FAKE_CODEX_MCP_STAGGER === "1" ? index + 1 : 1);
    if (delay > 0) setTimeout(() => settle(name), delay);
    else settle(name);
  }
};
const threadReply = (response: unknown) => {
  replyToThread(response);
  announceMcpStartup();
};
const replyToThread = (response: unknown) => {
  if (!process.env.FAKE_CODEX_RESTORED_USAGE) return out(response);
  const restored = {
    jsonrpc: "2.0", method: "thread/tokenUsage/updated",
    params: { threadId: nativeThreadId, turnId: nativeTurnId,
      tokenUsage: { total: { inputTokens: 100, cachedInputTokens: 50, outputTokens: 10 } } },
  };
  process.stdout.write(`${JSON.stringify(response)}\n${JSON.stringify(restored)}\n`);
};

// Write the dump whole or not at all (temp file, then rename): Windows CI read a half-rewritten
// dump. Windows may refuse the rename briefly while an indexer holds the file.
const RENAME_RETRY_DELAYS_MS = [5, 10, 20, 40, 80];
const RETRYABLE_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const writeDumpAtomic = (path: string, contents: string): void => {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, contents);
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(tmp, path);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (!RETRYABLE_RENAME_CODES.has(code) || attempt >= RENAME_RETRY_DELAYS_MS.length) {
        try { unlinkSync(tmp); } catch {}
        throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RENAME_RETRY_DELAYS_MS[attempt]);
    }
  }
};
const dump = () => {
  // FAKE_CODEX_DUMP_TURNS_ONLY=1: account probes never overwrite a turn's dump.
  if (process.env.FAKE_CODEX_DUMP_TURNS_ONLY === "1" && !calls.some(call => call.method === "turn/start")) return;
  if (process.env.FAKE_CODEX_DUMP) {
    writeDumpAtomic(
      process.env.FAKE_CODEX_DUMP,
      JSON.stringify({ pid: process.pid, argv: process.argv.slice(2), env: process.env, calls, decision, ...(mcpStartup ? { mcpStartup } : {}),
        ...(mcpReadyAtTurnStart !== undefined ? { mcpReadyAtTurnStart } : {}) }, null, 2),
    );
  }
};

/** The context reading each turn reports: FAKE_CODEX_CONTEXT_TOKENS names one per finished turn (the last repeats), and
 * FAKE_CODEX_CONTEXT_TOKENS_AFTER_COMPACT replaces them once a thread was compacted. */
const contextReading = (): number => {
  const afterCompact = Number(process.env.FAKE_CODEX_CONTEXT_TOKENS_AFTER_COMPACT);
  if (compactions > 0 && afterCompact > 0) return afterCompact;
  const schedule = (process.env.FAKE_CODEX_CONTEXT_TOKENS ?? "").split(",").map(Number).filter((n) => n > 0);
  return schedule[Math.min(turnsFinished, schedule.length) - 1] ?? 7;
};

const finishTurn = () => {
  if (process.env.FAKE_CODEX_COMPACTION === "1") {
    notify("item/started", { item: { id: "c1", type: "contextCompaction" } });
    notify("item/completed", { item: { id: "c1", type: "contextCompaction" } });
  }
  const patchBytes = Number(process.env.FAKE_CODEX_PATCH_BYTES);
  if (patchBytes > 0) {
    const change = (bytes: number) => [{ path: `${process.cwd()}/web/index.html`, kind: { type: "add" }, diff: "+".repeat(bytes) }];
    notify("item/started", { item: { id: "p1", type: "fileChange", status: "inProgress", changes: [] } });
    notify("item/fileChange/patchUpdated", { itemId: "p1", changes: change(Math.floor(patchBytes / 2)) });
    notify("item/fileChange/patchUpdated", { itemId: "p1", changes: change(patchBytes) });
    notify("item/completed", { item: { id: "p1", type: "fileChange", status: "completed", changes: change(patchBytes) } });
  }
  notify("item/completed", { item: { id: "i1", type: "commandExecution", status: "completed", aggregatedOutput: "README.md\nAPI_KEY=codex-output-secret", exitCode: 0 } });
  notify("item/completed", { item: { id: "w1", type: "webSearch", status: "completed" } });
  if (mode === "stream") {
    notify("item/agentMessage/delta", { itemId: "m1", delta: "done from " });
    notify("item/agentMessage/delta", { itemId: "m1", delta: "fake codex" });
  }
  if (mode === "image") {
    notify("item/completed", {
      item: {
        id: "img1",
        type: "imageGeneration",
        status: "completed",
        result: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        revisedPrompt: "a tiny green mouse",
        savedPath: "/tmp/provider-owned-path-must-not-be-read.png",
      },
    });
  }
  notify("item/completed", { item: { id: "m1", type: "agentMessage", text: "done from fake codex" } });
  const carried = process.env.FAKE_CODEX_RESTORED_USAGE ? { inputTokens: 100, cachedInputTokens: 50, outputTokens: 10 } : { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
  notify("thread/tokenUsage/updated", { tokenUsage: {
    total: { inputTokens: carried.inputTokens + 7 * ++turnsFinished + compactedUsage.inputTokens, cachedInputTokens: carried.cachedInputTokens + 4 * turnsFinished + compactedUsage.cachedInputTokens, outputTokens: carried.outputTokens + 3 * turnsFinished + compactedUsage.outputTokens },
    last: { inputTokens: contextReading(), cachedInputTokens: 4, outputTokens: 3 },
    modelContextWindow: 272000,
  } });
  if (process.env.FAKE_CODEX_ROLLOUT) {
    const line = (payload: unknown) => `${JSON.stringify({ timestamp: new Date().toISOString(), type: "response_item", payload })}\n`;
    appendFileSync(process.env.FAKE_CODEX_ROLLOUT,
      line({ type: "function_call", name: "retry_thread", arguments: "{}", call_id: "call_unsupported" }) +
      line({ type: "function_call_output", call_id: "call_unsupported", output: "unsupported call: retry_thread" }));
  }
  dump();
  if (mode === "late-request") process.stdout.cork();
  notify("turn/completed", { turn: { status: "completed" } });
  if (mode === "late-request") {
    out({ jsonrpc: "2.0", id: 100, method: "execCommandApproval", params: { command: "echo too late" } });
    process.stdout.uncork();
  }
};

// The scripted replies every fake plays (FAKE_STREAM_SCRIPT, FAKE_STREAM_CADENCE); inlined, since tests copy this fake
// out of the repo.
let streamTurn = 0;
const streamScriptFor = (prompt: string): { steps: Array<Record<string, string>>; chars: number; ms: number } | null => {
  if (!process.env.FAKE_STREAM_SCRIPT) return null;
  let scripts: Record<string, Array<Record<string, string>>>;
  try { scripts = JSON.parse(readFileSync(process.env.FAKE_STREAM_SCRIPT, "utf8")); } catch { return null; }
  // A prompt can carry earlier requests as context: the newest marker in it is the request.
  const marker = Object.keys(scripts).filter((key) => prompt.includes(key)).sort((a, b) => prompt.lastIndexOf(b) - prompt.lastIndexOf(a) || b.length - a.length)[0];
  if (!marker) return null;
  const [chars = 4, ms = 40] = (process.env.FAKE_STREAM_CADENCE ?? "4:40").split(":").map(Number);
  return { steps: scripts[marker]!, chars: Math.max(1, chars), ms: Math.max(0, ms) };
};
const playStreamScript = (script: NonNullable<ReturnType<typeof streamScriptFor>>) => {
  const turn = ++streamTurn;
  const live = () => turn === streamTurn;
  const queue = script.steps.slice();
  let index = 0;
  const next = () => {
    if (!live()) return;
    const step = queue.shift();
    if (!step) return void notify("turn/completed", { turn: { status: "completed" } });
    index += 1;
    if (step.fail !== undefined) return void notify("turn/completed", { turn: { status: "failed", error: { message: step.fail } } });
    if (step.tool !== undefined) {
      notify("item/started", { item: { id: `c${index}`, type: "commandExecution", command: step.tool } });
      notify("item/completed", { item: { id: `c${index}`, type: "commandExecution", status: "completed", aggregatedOutput: "ok", exitCode: 0 } });
      return void setTimeout(next, script.ms);
    }
    const text = step.say ?? step.think ?? "";
    const id = `m${index}`;
    if (step.say !== undefined) notify("item/started", { item: { id, type: "agentMessage", text: "" } });
    let at = 0;
    const send = () => {
      if (!live()) return;
      if (at < text.length) {
        const delta = text.slice(at, at += script.chars);
        notify(step.say !== undefined ? "item/agentMessage/delta" : "item/reasoning/textDelta", { itemId: id, delta });
        return void setTimeout(send, script.ms);
      }
      if (step.say !== undefined) notify("item/completed", { item: { id, type: "agentMessage", text } });
      setTimeout(next, script.ms);
    };
    send();
  };
  next();
};

const playRoomPlanTurn = (msg: any, planPath: string) => {
  const ack = () => out({ jsonrpc: "2.0", id: msg.id, result: { turn: { id: nativeTurnId } } });
  const early = process.env.FAKE_CODEX_COMPLETE_BEFORE_ACK === "1";
  const setting = (key: string) => {
    const entry = process.argv.find((arg) => arg.startsWith(`mcp_servers.agents.${key}=`));
    return entry ? JSON.parse(entry.slice(entry.indexOf("=") + 1)) : undefined;
  };
  const integration = {
    command: setting("command"),
    args: setting("args") ?? [],
    env: Object.fromEntries((setting("env_vars") ?? []).map((key: string) => [key, process.env[key] ?? ""])),
  };
  const text = (msg.params?.input ?? []).filter((item: any) => item?.type === "text").map((item: any) => item.text).join("\n");
  if (!early) ack();
  // Loaded only in this mode: other tests run a copy of this file on its own.
  void import("./room-handoff-agent.ts").then(({ runRoomHandoffAgent }) => runRoomHandoffAgent(process.argv.slice(2), planPath, { message: { content: text } },
    // A later turn of one process carries on the thread it has loaded, with no thread/resume.
    { integration, system: developerInstructions, evidence: { resumedThread: resumedThread ?? (turnsStarted > 1 ? nativeThreadId : null) } }))
    .then((reply) => {
      notify("item/completed", { item: { id: "m1", type: "agentMessage", text: reply } });
      notify("turn/completed", { turn: { status: "completed" } });
    })
    .catch((error) => notify("turn/completed", { turn: { status: "failed", error: { message: String(error) } } }))
    .finally(() => { if (early) ack(); });
};

let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk;
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

    if ((msg.id === 100 || msg.id === 101) && (msg.result !== undefined || msg.error !== undefined)) {
      decision = msg.result ?? { error: msg.error };
      if ((mode === "question" || mode === "multi-question" || mode === "empty-question") && process.env.FAKE_CODEX_ASK_HOLD === "1") {
        // Completing the turn would start the driver's child-reap timers, which freeze on a fake clock.
        dump();
      } else {
        finishTurn();
      }
      continue;
    }

    if (msg.method && !msg.released) calls.push({ method: msg.method, params: msg.params ?? null });
    if (msg.method && !msg.released && process.env.FAKE_CODEX_CALL_LOG) {
      const entry = `${JSON.stringify({ pid: process.pid, method: msg.method, params: msg.params ?? null })}\n`;
      const log = () => appendFileSync(process.env.FAKE_CODEX_CALL_LOG!, entry);
      if (msg.method === "config/read") setImmediate(log); else log();
    }

    switch (msg.method) {
      case "initialize": {
        experimentalApi = msg.params?.capabilities?.experimentalApi === true;
        logStartup("initialize");
        const reply = () => out({ jsonrpc: "2.0", id: msg.id, result: { ok: true, userAgent: process.env.FAKE_CODEX_USER_AGENT ?? "codex_cli_rs/0.166.0" } });
        if (process.env.FAKE_CODEX_STARTUP_DELAY_MS) setTimeout(reply, Number(process.env.FAKE_CODEX_STARTUP_DELAY_MS));
        else reply();
        break;
      }
      case "thread/unarchive":
        dump();
        if (process.env.FAKE_CODEX_ARCHIVED === "unarchive-fails") {
          out({ jsonrpc: "2.0", id: msg.id, error: { code: -32600, message: `cannot unarchive session ${msg.params?.threadId}` } });
          break;
        }
        unarchived = true;
        out({ jsonrpc: "2.0", id: msg.id, result: { thread: { id: msg.params?.threadId } } });
        break;
      case "account/read": {
        dump();
        const accountMode = process.env.FAKE_CODEX_ACCOUNT_MODE;
        if (accountMode === "hang") break;
        if (accountMode === "unsupported" || accountMode === "error") {
          out({ jsonrpc: "2.0", id: msg.id, error: {
            code: accountMode === "unsupported" ? -32601 : -32000,
            message: "Offline fixture account read unavailable",
          } });
          break;
        }
        const account = accountMode === "none" || mode === "logged-out" ? null
          : accountMode === "api-key" ? { type: "apiKey" }
          : { type: "chatgpt", email: process.env.FAKE_CODEX_ACCOUNT_EMAIL ?? "ada@example.test", planType: "pro" };
        out({ jsonrpc: "2.0", id: msg.id, result: { account, requiresOpenaiAuth: true } });
        break;
      }
      case "model/list":
        if (msg.params?.cursor === "page-2") {
          out({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              data: [
                { id: "gpt-hidden", displayName: "Hidden", hidden: true, isDefault: false },
                { id: "gpt-page-two", displayName: "GPT Page Two", hidden: false, isDefault: false,
                  ...(tiers ? { serviceTiers: FAST_TIERS, defaultServiceTier: "priority" } : {}),
                  ...(efforts
                    ? { supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }, { reasoningEffort: "high" }, { reasoningEffort: "xhigh" }, { reasoningEffort: "max" }] }
                    : {}) },
              ],
              nextCursor: null,
            },
          });
        } else {
          const hasAstra = process.env.FAKE_CODEX_ASTRA === "1";
          out({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              data: [
                ...(hasAstra
                  ? [{ id: "gpt-6-astra", displayName: "GPT-6 Astra", hidden: false, isDefault: true }]
                  : []),
                { id: "gpt-fake-default", displayName: "GPT Fake Default", hidden: false, isDefault: !hasAstra,
                  ...(tiers ? { serviceTiers: FAST_TIERS, defaultServiceTier: null } : {}),
                  ...(efforts ? { supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"] } : {}) },
                ...(process.env.FAKE_CODEX_LUNA === "1"
                  ? [{ id: "gpt-6-luna", displayName: "GPT-6 Luna", hidden: false, isDefault: false }]
                  : []),
                ...(updated ? [{ id: "gpt-6.1-sol", displayName: "GPT-6.1 Sol", hidden: false, isDefault: false }] : []),
              ],
              nextCursor: "page-2",
            },
          });
        }
        break;
      case "config/read":
        logStartup("config/read");
        if (process.env.FAKE_CODEX_CONFIG_HOLD_FILE && existsSync(process.env.FAKE_CODEX_CONFIG_HOLD_FILE) && !msg.released) {
          const held = process.env.FAKE_CODEX_CONFIG_HOLD_FILE;
          const timer = setInterval(() => {
            if (existsSync(held)) return;
            clearInterval(timer);
            process.stdin.emit("data", `${JSON.stringify({ ...msg, released: true })}\n`);
          }, 5);
          break;
        }
        if ((process.env.FAKE_CODEX_CONFIG_HANG_FILE && existsSync(process.env.FAKE_CODEX_CONFIG_HANG_FILE))
          || (process.env.FAKE_CODEX_CONFIG_HANG_AFTER_TURNS && turnsFinished >= Number(process.env.FAKE_CODEX_CONFIG_HANG_AFTER_TURNS))) break;
        if (process.env.FAKE_CODEX_CONFIG_ERROR_FILE && existsSync(process.env.FAKE_CODEX_CONFIG_ERROR_FILE)) {
          out({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "config unavailable" } });
          break;
        }
        if (mode === "config-read-error") {
          dump();
          out({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "config unavailable" } });
          break;
        }
        out({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            config: {
              ...(mode === "config-profile" || mode === "config-profile-unsupported"
              ? {
                  default_permissions: "private-operator-profile",
                  permissions: {
                    "private-operator-profile": { extends: ":danger-full-access" },
                  },
                  // These conflicting legacy values prove the profile wins.
                  approval_policy: null,
                  approvals_reviewer: null,
                  sandbox_mode: "read-only",
                }
              : {
                  approval_policy: "never",
                  approvals_reviewer: "auto_review",
                  sandbox_mode: "read-only",
                  mcp_servers: process.env.FAKE_CODEX_MCP_OVERRIDES === "1" ? mcpOverrides : process.env.FAKE_CODEX_MCP_CONFIG ? JSON.parse(process.env.FAKE_CODEX_MCP_CONFIG) : {
                    harmless_name: { env: { DISPLAY_LABEL: "innocuous-config-secret-7a9c" } },
                  },
                }),
              developer_instructions: process.env.FAKE_CODEX_INSTRUCTIONS_FILE && existsSync(process.env.FAKE_CODEX_INSTRUCTIONS_FILE)
                ? readFileSync(process.env.FAKE_CODEX_INSTRUCTIONS_FILE, "utf8") : process.env.FAKE_CODEX_INSTRUCTIONS ?? null,
              shell_environment_policy: shellEnvironmentPolicy(),
              features: Object.fromEntries(process.argv.flatMap((arg, index) => {
                const match = process.argv[index - 1] === "-c" ? /^features\.(\w+)=(true|false)$/.exec(arg) : null;
                return match && process.env.FAKE_CODEX_IGNORE_FEATURES !== "1" ? [[match[1], match[2] === "true"]] : [];
              })),
            },
            origins: {},
          },
        });
        break;
      case "thread/resume":
        dump();
        developerInstructions = msg.params?.developerInstructions ?? "";
        resumedThread = msg.params?.threadId ?? null;
        if (process.env.FAKE_CODEX_RESUME_ERROR) {
          out({ jsonrpc: "2.0", id: msg.id, error: JSON.parse(process.env.FAKE_CODEX_RESUME_ERROR) });
        } else if (process.env.FAKE_CODEX_ARCHIVED && !unarchived) {
          const id = msg.params?.threadId;
          out({ jsonrpc: "2.0", id: msg.id, error: { code: -32600, message: `session ${id} is archived. Run \`codex unarchive ${id}\` to unarchive it first.` } });
        } else if (process.env.FAKE_CODEX_ARCHIVED) {
          threadReply({ jsonrpc: "2.0", id: msg.id, result: { thread: { id: msg.params?.threadId }, sandbox: resolvedSandbox(msg.params ?? {}) } });
        } else if (msg.params?.permissions && (!experimentalApi || mode === "config-profile-unsupported")) {
          out({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "experimental API required for permissions" } });
        } else if (mode === "resume" || mode === "plan-unsupported-input" || mode === "review-events" || mode === "helper-events" || mode === "instructions-unsupported" || mode === "config-profile" || mode === "config-profile-unsupported" || mode === "async-question" ||
            (mode === "resume-then-missing" && !existsSync(process.env.FAKE_CODEX_STATE ?? ""))) {
          threadReply({ jsonrpc: "2.0", id: msg.id, result: { thread: { id: msg.params?.threadId, ...(process.env.FAKE_CODEX_ROLLOUT ? { path: process.env.FAKE_CODEX_ROLLOUT } : {}) }, sandbox: resolvedSandbox(msg.params ?? {}) } });
        } else {
          out({ jsonrpc: "2.0", id: msg.id, error: { code: -32600, message: `no rollout found for thread id ${msg.params?.threadId}` } });
        }
        break;
      case "thread/inject_items":
        if (mode === "instructions-unsupported") {
          dump();
          out({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
          break;
        }
        out({ jsonrpc: "2.0", id: msg.id, result: {} });
        break;
      case "turn/steer": {
        dump();
        const refused = (message: string) =>
          out({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message } });
        if (process.env.FAKE_CODEX_STEER_ERROR) {
          out({ jsonrpc: "2.0", id: msg.id, error: JSON.parse(process.env.FAKE_CODEX_STEER_ERROR) });
          break;
        }
        if (process.env.FAKE_CODEX_STEER_ERROR_FILE && existsSync(process.env.FAKE_CODEX_STEER_ERROR_FILE)) {
          refused("active turn is not steerable");
          break;
        }
        if (process.env.FAKE_CODEX_STEER_HANG) break;
        if (msg.params?.expectedTurnId !== nativeTurnId) {
          refused("active turn is not steerable");
          break;
        }
        out({ jsonrpc: "2.0", id: msg.id, result: { turnId: nativeTurnId } });
        break;
      }
      case "turn/interrupt":
        dump();
        streamTurn += 1;
        if (process.env.FAKE_CODEX_INTERRUPT_SILENT) break;
        out({ jsonrpc: "2.0", id: msg.id, result: {} });
        if (compactingTurn && msg.params?.turnId === compactingTurn) {
          notify("turn/completed", { turn: { id: compactingTurn, status: "interrupted" } });
          compactingTurn = null;
          break;
        }
        notify("turn/completed", { turn: { status: "interrupted" } });
        break;
      case "thread/compact/start": {
        dump();
        nativeThreadId = msg.params?.threadId ?? nativeThreadId;
        const compact = process.env.FAKE_CODEX_COMPACT;
        if (compact === "unsupported" || compact === "error") {
          out({ jsonrpc: "2.0", id: msg.id, error: compact === "unsupported" ? { code: -32601, message: "method not found" } : { code: -32000, message: "compaction failed" } });
          break;
        }
        out({ jsonrpc: "2.0", id: msg.id, result: {} });
        const turnId = `compact-turn-${++compactions}`;
        notify("turn/started", { turn: { id: turnId, status: "inProgress" } });
        notify("item/started", { turnId, item: { id: "compaction-1", type: "contextCompaction" } });
        if (process.env.FAKE_CODEX_COMPACT_HELPER === "1") {
          notify("thread/tokenUsage/updated", { threadId: "helper-thread", turnId: "helper-turn", tokenUsage: { total: { inputTokens: 999, outputTokens: 999 } } });
          notify("turn/completed", { threadId: "helper-thread", turn: { id: "helper-turn", status: "completed" } });
          notify("item/started", { turnId, item: { id: "after-helper", type: "marker" } });
        }
        if (compact === "hang") {
          compactingTurn = turnId;
          break;
        }
        const finishCompaction = () => {
          const added = process.env.FAKE_CODEX_COMPACT_USAGE ? JSON.parse(process.env.FAKE_CODEX_COMPACT_USAGE) : {};
          for (const key of Object.keys(compactedUsage) as Array<keyof typeof compactedUsage>) compactedUsage[key] += added[key] ?? 0;
          const carried = process.env.FAKE_CODEX_RESTORED_USAGE ? { inputTokens: 100, cachedInputTokens: 50, outputTokens: 10 } : { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
          notify("item/completed", { turnId, item: { id: "compaction-1", type: "contextCompaction" } });
          if (process.env.FAKE_CODEX_COMPACT_NO_USAGE !== "1") notify("thread/tokenUsage/updated", { turnId, tokenUsage: {
            total: { inputTokens: carried.inputTokens + 7 * turnsFinished + compactedUsage.inputTokens, cachedInputTokens: carried.cachedInputTokens + 4 * turnsFinished + compactedUsage.cachedInputTokens, outputTokens: carried.outputTokens + 3 * turnsFinished + compactedUsage.outputTokens },
            last: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
            modelContextWindow: 272000,
          } });
          notify("turn/completed", { turn: { id: turnId, status: "completed" } });
        };
        const held = process.env.FAKE_CODEX_COMPACT_HOLD_FILE;
        if (held && existsSync(held)) {
          const timer = setInterval(() => {
            if (existsSync(held)) return;
            clearInterval(timer);
            finishCompaction();
          }, 5);
        } else setTimeout(finishCompaction, Number(process.env.FAKE_CODEX_COMPACT_MS) || 20);
        break;
      }
      case "thread/start":
        dump();
        developerInstructions = msg.params?.developerInstructions ?? "";
        if (process.env.FAKE_CODEX_MCP_FAILED) {
          const name = process.env.FAKE_CODEX_MCP_FAILED;
          out({ jsonrpc: "2.0", method: "mcpServer/startupStatus/updated", params: { threadId: null, name, status: "failed", error: `MCP client for \`${name}\` timed out after 30 seconds.`, failureReason: null } });
        }
        if (process.env.FAKE_CODEX_START_ERROR) {
          out({ jsonrpc: "2.0", id: msg.id, error: JSON.parse(process.env.FAKE_CODEX_START_ERROR) });
        } else if (msg.params?.permissions && (!experimentalApi || mode === "config-profile-unsupported")) {
          out({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "experimental API required for permissions" } });
        } else if (process.env.FAKE_CODEX_MCP_START === "1") {
          // Codex starts MCP servers with the thread; one that fails leaves the thread without its tools.
          const reply = { jsonrpc: "2.0", id: msg.id, result: { thread: { id: startedThreadId() }, model: "fake-codex-model", sandbox: resolvedSandbox(msg.params ?? {}) } };
          void startMcpServers().then((startup) => { mcpStartup = startup; dump(); threadReply(reply); });
        } else {
          threadReply({ jsonrpc: "2.0", id: msg.id, result: { thread: { id: startedThreadId(), ...(process.env.FAKE_CODEX_ROLLOUT ? { path: process.env.FAKE_CODEX_ROLLOUT } : {}) }, model: "fake-codex-model", sandbox: resolvedSandbox(msg.params ?? {}) } });
        }
        break;
      case "turn/start": {
        if (process.env.FAKE_CODEX_MCP_READY_MS) mcpReadyAtTurnStart = mcpPending.length === 0;
        nativeTurnId = `turn-${++turnsStarted}`;
        dump();
        if (Number(process.env.FAKE_CODEX_DIE_ON_TURN) === turnsStarted) process.kill(process.pid, "SIGKILL");
        logStartup("turn/start");
        nativeThreadId = msg.params?.threadId ?? nativeThreadId;
        if (mode === "early-tool-timeout" || mode === "early-tool-error") {
          if (process.env.FAKE_CODEX_ACTION_LOG) appendFileSync(process.env.FAKE_CODEX_ACTION_LOG, `${JSON.stringify({ action: "record", pid: process.pid })}\n`);
          notify("item/completed", { item: { id: "early-tool", type: "commandExecution", command: "record", status: "completed", aggregatedOutput: "recorded" } });
          if (mode === "early-tool-error") out({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "connection reset by peer" } });
          break;
        }
        // Counts turn launches only, not the catalog spawn during create().
        if (process.env.FAKE_CODEX_LAUNCH_CRASHES && process.env.FAKE_CODEX_STATE) {
          let launched = 0;
          try {
            launched = Number(readFileSync(process.env.FAKE_CODEX_STATE, "utf8")) || 0;
          } catch {}
          const crashes = Number(process.env.FAKE_CODEX_LAUNCH_CRASHES) || 0;
          writeFileSync(process.env.FAKE_CODEX_STATE, String(launched + 1));
          if (launched < crashes) {
            console.error("Error: connection reset by peer");
            process.exit(1);
          }
        }
        if (process.env.FAKE_CODEX_LAUNCH_KILLS && process.env.FAKE_CODEX_STATE) {
          let launched = 0;
          try {
            launched = Number(readFileSync(process.env.FAKE_CODEX_STATE, "utf8")) || 0;
          } catch {}
          const kills = Number(process.env.FAKE_CODEX_LAUNCH_KILLS) || 0;
          writeFileSync(process.env.FAKE_CODEX_STATE, String(launched + 1));
          if (launched < kills) {
            // The kill waits a tick so stderr reaches the pipe; turn/start stays unacknowledged.
            console.error("Error: connection reset by peer");
            setTimeout(() => process.kill(process.pid, "SIGKILL"), 15);
            break;
          }
        }
        if (process.env.FAKE_CODEX_LAUNCH_SILENT && process.env.FAKE_CODEX_STATE) {
          let launched = 0;
          try {
            launched = Number(readFileSync(process.env.FAKE_CODEX_STATE, "utf8")) || 0;
          } catch {}
          const silent = Number(process.env.FAKE_CODEX_LAUNCH_SILENT) || 0;
          writeFileSync(process.env.FAKE_CODEX_STATE, String(launched + 1));
          if (launched < silent) {
            process.exit(1);
          }
        }
        if (mode === "safety-rpc") {
          out({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "HTTP 503: This task was blocked by our safety systems." } });
          break;
        }
        if (mode === "safety-completion" || mode === "safety-notification") {
          out({ jsonrpc: "2.0", id: msg.id, result: { turn: { id: nativeTurnId } } });
          const message = "This task was blocked by our safety systems.";
          if (mode === "safety-notification") notify("error", { message });
          notify("turn/completed", { turn: { status: "failed", error: { message } } });
          break;
        }
        if (msg.params?.permissions && (!experimentalApi || mode === "config-profile-unsupported")) {
          out({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "experimental API required for permissions" } });
          break;
        }
        // Codex 0.160's ErrorNotification is {error: TurnError, willRetry}; its reconnects come first with willRetry: true.
        if (mode === "retry-then-complete" || mode === "signin-refused") {
          out({ jsonrpc: "2.0", id: msg.id, result: { turn: { id: nativeTurnId } } });
          for (let attempt = 1; attempt <= 5; attempt++) {
            notify("error", { willRetry: true, error: { message: `Reconnecting... ${attempt}/5`, codexErrorInfo: null, additionalDetails: "workspace routing discovery unauthorized (401)" } });
          }
          if (mode === "retry-then-complete") { finishTurn(); break; }
          const error = { message: "workspace routing discovery unauthorized (401)", codexErrorInfo: "unauthorized", additionalDetails: null };
          notify("error", { willRetry: false, error });
          notify("turn/completed", { turn: { status: "failed", error } });
          break;
        }
        if (mode === "auth-recovery") {
          out({ jsonrpc: "2.0", id: msg.id, result: { turn: { id: nativeTurnId } } });
          notify("modelProvider/authRecoveryStarted", { provider: "openai", message: "Refreshing sign-in" });
          notify("turn/completed", { turn: { status: "failed", error: { message: "unexpected status 401 Unauthorized", codexErrorInfo: null } } });
          break;
        }
        if (mode === "key-401") {
          out({ jsonrpc: "2.0", id: msg.id, result: { turn: { id: nativeTurnId } } });
          const error = { message: "unexpected status 401 Unauthorized: Incorrect API key provided", codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } }, additionalDetails: null };
          notify("error", { willRetry: false, error });
          notify("turn/completed", { turn: { status: "failed", error } });
          break;
        }
        const recovery = /^(recovered|recovering)-(401|403)$/.exec(mode);
        if (recovery) {
          out({ jsonrpc: "2.0", id: msg.id, result: { turn: { id: nativeTurnId } } });
          notify("modelProvider/authRecoveryStarted", { provider: "openai", message: "Refreshing sign-in" });
          if (recovery[1] === "recovered") notify("modelProvider/authRecoveryCompleted", { provider: "openai", message: "Signed in" });
          const message = recovery[2] === "403" ? "unexpected status 403 Forbidden: unauthorized client" : "unexpected status 401 Unauthorized";
          notify("turn/completed", { turn: { status: "failed", error: { message, codexErrorInfo: recovery[2] === "403" ? { responseStreamConnectionFailed: { httpStatusCode: 403 } } : null } } });
          break;
        }
        if (mode === "mcp-401") {
          out({ jsonrpc: "2.0", id: msg.id, result: { turn: { id: nativeTurnId } } });
          notify("item/completed", { item: { id: "t1", type: "mcpToolCall", tool: "fetch", status: "failed", error: { message: "HTTP 401 Unauthorized: Please sign in again" } } });
          finishTurn();
          break;
        }
        if (mode === "mcp-image") {
          out({ jsonrpc: "2.0", id: msg.id, result: { turn: { id: nativeTurnId } } });
          notify("item/completed", { item: { id: "t1", type: "mcpToolCall", tool: "screenshot", status: "completed", result: { content: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }] } } });
          finishTurn();
          break;
        }
        if (mode === "legacy-error") {
          out({ jsonrpc: "2.0", id: msg.id, result: { turn: { id: nativeTurnId } } });
          notify("error", { message: "stream disconnected before completion" });
          notify("turn/completed", { turn: { status: "failed", error: { message: "stream disconnected before completion" } } });
          break;
        }
        if (process.env.FAKE_CODEX_MISSING_BEARER && process.env.FAKE_CODEX_STATE) {
          let launched = 0;
          try {
            launched = Number(readFileSync(process.env.FAKE_CODEX_STATE, "utf8")) || 0;
          } catch {}
          writeFileSync(process.env.FAKE_CODEX_STATE, String(launched + 1));
          if (launched < (Number(process.env.FAKE_CODEX_MISSING_BEARER) || 0)) {
            out({ jsonrpc: "2.0", id: msg.id, result: { turn: { id: nativeTurnId } } });
            const prompt = { type: "userMessage", id: "u1", content: msg.params?.input ?? [] };
            notify("item/started", { item: prompt });
            notify("item/completed", { item: prompt });
            const said = "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses";
            notify("error", { willRetry: true, error: { message: "Reconnecting... 1/5", codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 401 } }, additionalDetails: said } });
            const error = { message: said, codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } }, additionalDetails: null };
            notify("error", { willRetry: false, error });
            notify("turn/completed", { turn: { status: "failed", error } });
            break;
          }
        }
        if (mode === "plan-model-refused") {
          out({ jsonrpc: "2.0", id: msg.id, result: { turn: { id: nativeTurnId } } });
          // The reporter's words (2026-11-03): ChatGPT lists gpt-6.1-sol, then refuses it for a ChatGPT account.
          const error = { message: "unexpected status 400 Bad Request: invalid_request_error model_not_found: The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.", codexErrorInfo: null, additionalDetails: null };
          notify("error", { willRetry: false, error });
          notify("turn/completed", { turn: { status: "failed", error } });
          break;
        }
        if (mode === "plan-unsupported-input" && resumedThread) {
          out({ jsonrpc: "2.0", id: msg.id, result: { turn: { id: nativeTurnId } } });
          // The reporter's words (2026-11-17): the resumed session holds an mp3 a ChatGPT plan will not take.
          const error = { message: "unexpected status 400 Bad Request: {\"error\":{\"message\":\"User subscription sharing supports text, image, and file input. Remove unsupported content or use an API key instead.\",\"type\":\"invalid_request_error\",\"param\":\"input\",\"code\":\"subscription_sharing_unsupported_capability\"}}", codexErrorInfo: null, additionalDetails: null };
          notify("error", { willRetry: false, error });
          notify("turn/completed", { turn: { status: "failed", error } });
          break;
        }
        if (mode === "usage-limit") {
          out({ jsonrpc: "2.0", id: msg.id, result: { turn: { id: nativeTurnId } } });
          const error = { message: "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 5:23 PM.", codexErrorInfo: "usageLimitExceeded", additionalDetails: null };
          notify("error", { willRetry: false, error });
          notify("turn/completed", { turn: { status: "failed", error } });
          break;
        }
        if (mode === "unauthorized") {
          out({
            jsonrpc: "2.0",
            id: msg.id,
            error: {
              code: -32603,
              message: "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header",
            },
          });
          break;
        }
        // FAKE_CODEX_TRANSIENTS launches fail transiently (count in FAKE_CODEX_STATE); FAKE_CODEX_PARTIAL_FAILS streams a delta first.
        if (process.env.FAKE_CODEX_TRANSIENTS && process.env.FAKE_CODEX_STATE) {
          let launched = 0;
          try {
            launched = Number(readFileSync(process.env.FAKE_CODEX_STATE, "utf8")) || 0;
          } catch {}
          const quota = Number(process.env.FAKE_CODEX_TRANSIENTS) || 0;
          writeFileSync(process.env.FAKE_CODEX_STATE, String(launched + 1));
          if (launched < quota) {
            if (process.env.FAKE_CODEX_PARTIAL_FAILS) {
              out({ jsonrpc: "2.0", id: msg.id, result: { turn: { id: nativeTurnId } } });
              notify("item/agentMessage/delta", { itemId: "m1", delta: "half an answer" });
              notify("turn/completed", { turn: { status: "failed", error: { message: "provider overloaded, try again" } } });
              break;
            }
            out({
              jsonrpc: "2.0",
              id: msg.id,
              error: { code: -32603, message: "provider returned 503: upstream capacity exceeded" },
            });
            break;
          }
        }
        if (process.env.FAKE_CODEX_ACK_CRASH) {
          out({ jsonrpc: "2.0", id: msg.id, result: { turn: { id: nativeTurnId } } });
          // Crash only once the ack was parsed: on Windows pipe delivery order varies.
          void waitForGate(process.env.FAKE_CODEX_ACK_CRASH).then(() => {
            console.error("Error: connection reset by peer");
            process.exit(1);
          });
          break;
        }
        if (process.env.FAKE_CODEX_EXIT_MID_TURN) {
          console.error("2026-09-14T20:24:19Z ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: HTTP error: 426 Upgrade Required, url: ws://127.0.0.1:10100/v1/responses");
          // Hold stdout until the stale stderr was read, or it lands after the last parse (Windows pipe order).
          void waitForGate(process.env.FAKE_CODEX_EXIT_MID_TURN).then(() => {
            out({ jsonrpc: "2.0", id: msg.id, result: { turn: { id: nativeTurnId } } });
            notify("item/reasoning/textDelta", { itemId: "m1", delta: "still thinking" });
            void waitForGate(process.env.FAKE_CODEX_EXIT_MID_TURN_KILL).then(() =>
              process.kill(process.pid, "SIGKILL"),
            );
          });
          break;
        }
        if (process.env.FAKE_CODEX_ROOM_PLAN) {
          playRoomPlanTurn(msg, process.env.FAKE_CODEX_ROOM_PLAN);
          break;
        }
        if (mode === "early-turn-events") finishTurn();
        out({ jsonrpc: "2.0", id: msg.id, result: { turn: { id: nativeTurnId } } });
        const script = streamScriptFor((msg.params?.input ?? []).filter((item: any) => item?.type === "text").map((item: any) => item.text).join("\n"));
        if (script) {
          playStreamScript(script);
          break;
        }
        if (mode === "early-turn-events") break;
        if (process.env.FAKE_CODEX_ECHO_INPUT === "1") {
          const prompt = { type: "userMessage", id: "u1", content: msg.params?.input ?? [] };
          notify("item/started", { item: prompt });
          notify("item/completed", { item: prompt });
        }
        if (mode === "helper-events") {
          for (const scope of [
            { threadId: "helper-thread", turnId: "helper-turn" },
            { threadId: nativeThreadId, turnId: "previous-turn" },
            { threadId: null, turnId: null },
          ]) {
            notify("item/agentMessage/delta", { ...scope, delta: "FOREIGN answer" });
            notify("item/reasoning/textDelta", { ...scope, delta: "FOREIGN reasoning" });
            notify("item/started", { ...scope, item: { id: "foreign-tool", type: "commandExecution", command: "FOREIGN command" } });
            notify("item/completed", { ...scope, item: { type: "agentMessage", text: "FOREIGN final" } });
            notify("thread/tokenUsage/updated", { ...scope, tokenUsage: { total: { inputTokens: 999, outputTokens: 999 } } });
            notify("error", { ...scope, message: "FOREIGN error" });
            notify("turn/completed", { ...scope, turn: { id: scope.turnId, status: "completed" } });
            notify("turn/completed", { ...scope, turn: { id: scope.turnId, status: "failed" } });
          }
          out({ jsonrpc: "2.0", id: 100, method: "execCommandApproval", params: { command: "echo parent continues" } });
          break;
        }
        const command = mode === "windows-command"
          ? [
              "\"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\"",
              "-Command",
              `"Get-Content -Raw -LiteralPath 'C:\\Users\\Ada\\workspaces\\${"very-long-folder\\".repeat(8)}NOTES.md'"`,
            ].join(" ")
          : process.env.FAKE_CODEX_COMMAND || "ls -la";
        notify("item/started", { item: { id: "i1", type: "commandExecution", command } });
        const printed = JSON.parse(process.env.FAKE_CODEX_COMMAND_OUTPUT ?? "[]") as string[];
        const every = Number(process.env.FAKE_CODEX_COMMAND_OUTPUT_MS) || 0;
        printed.forEach((delta, index) => {
          const print = () => notify("item/commandExecution/outputDelta", { itemId: "i1", delta });
          if (every > 0) setTimeout(print, every * (index + 1));
          else print();
        });
        if (!process.env.FAKE_CODEX_COMMAND) notify("item/started", { item: { id: "w1", type: "webSearch", query: "OpenMausBot" } });
        const reviewOnce = process.env.FAKE_CODEX_REVIEW_ONCE_FILE;
        if (process.env.FAKE_CODEX_REVIEW_EVENTS && (!reviewOnce || !existsSync(reviewOnce))) {
          if (reviewOnce) writeFileSync(reviewOnce, "1");
          for (const event of JSON.parse(process.env.FAKE_CODEX_REVIEW_EVENTS)) {
            out({ jsonrpc: "2.0", method: event.method, params: event.params });
          }
        }
        if (mode === "mcp-elicitation") {
          out({
            jsonrpc: "2.0",
            id: 101,
            method: "mcpServer/elicitation/request",
            params: {
              serverName: "agents",
              mode: "form",
              _meta: { codex_approval_kind: "mcp_tool_call", tool_params: {} },
              message: 'Allow the agents MCP server to run tool "list_bots"?',
              requestedSchema: { type: "object", properties: {} },
            },
          });
        } else if (mode === "mcp-app-approval") {
          out({
            jsonrpc: "2.0",
            id: 101,
            method: "mcpServer/elicitation/request",
            params: {
              serverName: "computer-use",
              mode: "form",
              message: "Allow ChatGPT to use Safari?",
              _meta: { app_name: "Safari", persist: ["session", "always"] },
              requestedSchema: {
                type: "object",
                properties: {
                  approval: {
                    type: "string",
                    oneOf: [
                      { const: "once", title: "Allow once" },
                      { const: "session", title: "Allow for this session" },
                      { const: "always", title: "Always allow Safari" },
                    ],
                  },
                },
                required: ["approval"],
              },
            },
          });
        } else if (mode === "mcp-form") {
          out({
            jsonrpc: "2.0",
            id: 101,
            method: "mcpServer/elicitation/request",
            params: {
              serverName: "example",
              mode: "form",
              message: "Enter an API key",
              requestedSchema: {
                type: "object",
                properties: { apiKey: { type: "string" } },
                required: ["apiKey"],
              },
            },
          });
        } else if (mode === "permissions-approval") {
          out({
            jsonrpc: "2.0",
            id: 101,
            method: "item/permissions/requestApproval",
            params: {
              threadId: "codex-thread-1",
              turnId: "turn-1",
              itemId: "permission-1",
              cwd: "/tmp",
              startedAtMs: Date.now(),
              reason: "Needs network access",
              permissions: {
                network: { enabled: true },
                fileSystem: null,
              },
            },
          });
        } else if (
          mode === "question" ||
          mode === "multi-question" ||
          mode === "mixed-question" ||
          mode === "empty-question" ||
          mode === "malformed-question"
        ) {
          out({
            jsonrpc: "2.0",
            id: 101,
            method: "item/tool/requestUserInput",
            params: {
              questions: mode === "malformed-question"
                ? "please"
                : mode === "question"
                ? [{
                    id: "q-ship",
                    question: "Ship today?",
                    options: ["Yes", "No", "Maybe", "Later", "Soon", "Never"].map((label) => ({ label })),
                  }]
                : mode === "mixed-question"
                ? [
                    { id: "q-broken", question: "   ", options: [{ label: "Broken choice" }] },
                    { id: "q-review", question: "Who reviews?", options: [{ label: "Ada" }, { label: "Lin" }] },
                  ]
                : mode === "empty-question"
                ? []
                : [
                    { id: "q-ship", question: "Ship today?", options: [{ label: "Yes" }, { label: "No" }] },
                    { id: "q-review", question: "Who reviews?", options: [{ label: "Ada" }, { label: "Lin" }] },
                  ],
            },
          });
        } else if (mode === "async-question") {
          const item = {
            type: "agentMessage",
            id: "call_async_question",
            text: "Which source should I use?\n- Directly in OpenMausBot\n- The official server in Executor",
            phase: "final_answer",
            memoryCitation: null,
            delivery: "async",
            questions: process.env.FAKE_CODEX_ASYNC_QUESTIONS
              ? JSON.parse(process.env.FAKE_CODEX_ASYNC_QUESTIONS)
              : [{ title: "Which source should I use?", options: ["Directly in OpenMausBot", "The official server in Executor"] }],
          };
          notify("item/started", { item, startedAtMs: Date.now() });
          notify("item/completed", { item, completedAtMs: Date.now() });
          const gate = process.env.FAKE_CODEX_ASYNC_QUESTION_GATE;
          void waitForGate(gate, gate ? 15_000 : 300).then(() => {
            dump();
            finishTurn();
          });
        } else if (mode === "approval" || mode === "windows-command") {
          const approvalCommand = mode === "windows-command" ? command : "rm -rf scratch";
          const approval = process.env.FAKE_CODEX_APPROVAL_REQUEST
            ? JSON.parse(process.env.FAKE_CODEX_APPROVAL_REQUEST)
            : { method: "execCommandApproval", params: { command: approvalCommand } };
          out({ jsonrpc: "2.0", id: 100, ...approval });
        } else if (process.env.FAKE_CODEX_COMMAND_GATE) {
          void waitForGate(process.env.FAKE_CODEX_COMMAND_GATE, 10 * 60_000).then(() => finishTurn());
        } else {
          finishTurn();
          if (process.env.FAKE_CODEX_REVIEW_AFTER_COMPLETION) {
            const event = JSON.parse(process.env.FAKE_CODEX_REVIEW_AFTER_COMPLETION);
            out({ jsonrpc: "2.0", method: event.method, params: event.params });
          }
        }
        break;
      }
      default:
        if (msg.id !== undefined) out({ jsonrpc: "2.0", id: msg.id, result: {} });
    }
  }
});

// codex-cli 0.160.1 stays up between turns and exits once its stdin closes.
process.stdin.on("end", () => setTimeout(() => process.exit(0), 200));
setInterval(() => {}, 1_000);
