#!/usr/bin/env node
// Fake of the claude CLI's stream-json surface for driver tests. Env knobs:
//   FAKE_CLAUDE_MODE  happy (default) | exit-early | hang | malformed | dead-session (fails on --resume)
//     | stale-session (--resume answers 2.1.295's no-session error result, no init, stays up)
//     | error-result | resume-dies-after-init | stream (partial deltas plus subagent noise)
//     | not-logged-in (2.1.296's frames) | api-error | usage-limit (2.1.295's usage_limit_reached frames)
//   FAKE_CLAUDE_API_ERROR  text for the api-error frame (default: overloaded)
//   FAKE_CLAUDE_API_ERROR_KIND  the api-error frame's `error` (default: unknown); FAKE_CLAUDE_API_ERROR_STATUS its result's
//     api_error_status; FAKE_CLAUDE_NO_TERMINAL_REASON=1: the result has no terminal_reason, only stop_reason "stop_sequence"
//   FAKE_CLAUDE_RATE_LIMIT  JSON rate_limit_info reported in a `rate_limit_event` after init
//   FAKE_CLAUDE_LIMITED_FILE  path: while it exists, every turn plays usage-limit with the file's JSON rate_limit_info
//   FAKE_CLAUDE_MCP_FAILED  comma list of MCP servers init reports as failed (`mcp_servers`)
//   FAKE_CLAUDE_RELEASE  with hang: the turn ends normally once this file exists
//   FAKE_CLAUDE_DUMP  path for the latest turn's {argv, env, cwd, prompt, systemPrompt, mcpConfig}
//   FAKE_CLAUDE_EXIT_AFTER_TURN  1: exit once the turn is answered, so later turns relaunch with --resume
//   FAKE_CLAUDE_AUTH_AFTER_TURN  1: from the second turn, answer as not-logged-in; FAKE_CLAUDE_AUTH_AFTER_WORK  1: not-logged-in
//     calls a tool first
//   FAKE_CLAUDE_GONE_AFTER_TURN  path: after the turn stop reading stdin, write <path>.closed, exit once <path> exists
//   FAKE_CLAUDE_TEXT_FILE  path of the one-shot text reply; missing or exactly __FAIL__ fails the call
//   FAKE_CLAUDE_TEXT_ROUTES  path of {"marker": "reply"}: the first marker a one-shot prompt contains picks the reply
//   FAKE_CLAUDE_CACHE_READ_TOKENS  cache_read_input_tokens per model call (default 2)
//   FAKE_CLAUDE_PING_DUMP  path for a keep-warm ping's {argv, env, prompt, mcpConfig, settings, systemPrompt}
//   FAKE_CLAUDE_PING_USAGE  JSON usage for a keep-warm ping's result (default: warm read 150000, write 40)
//   FAKE_CLAUDE_PING_RESULT  raw json result for a keep-warm ping
//   FAKE_CLAUDE_TEXT_DUMP  FAKE_CLAUDE_DUMP for one-shot text runs
//   FAKE_CLAUDE_TEXT_LOG  JSON-lines file every one-shot prompt is appended to
//   FAKE_CLAUDE_TEXT_HANG  set: the one-shot text mode never replies
//   FAKE_CLAUDE_TEXT_RESULT  raw --output-format json one-shot response
//   FAKE_CLAUDE_REPLIES  JSON array of replies (string, or string[] for several items) used in order
//   FAKE_CLAUDE_REPLY_STATE  counter file keeping FAKE_CLAUDE_REPLIES in order across processes
//   FAKE_CLAUDE_TOOL_CALLS  JSON [{name, input?, ok?}] each turn calls before its reply (unset: one Bash call)
//   FAKE_CLAUDE_TOOL_CALLS_FILE  path of the same JSON, read again each turn (a warm process's turns differ); missing: none
//   FAKE_CLAUDE_STREAM_CADENCE  "chars:ms" (happy mode): stream each scripted reply as
//     text_delta chunks of `chars` chars every `ms` ms before its assistant message
//   FAKE_CLAUDE_USES_CLOUD_COMPUTER  1: first take one screenshot through the `computer` MCP server
//   FAKE_CLAUDE_CONNECT_APPS  toolkits (gmail,slack): first call COMPOSIO_MANAGE_CONNECTIONS via `composio`
//   FAKE_CLAUDE_HOOKS  1: run the --settings hooks like the CLI (PostToolUse per tool_result, PostToolUseFailure for
//     an ok:false call with its additionalContext echoed into the reply, Stop at the end)
//   FAKE_CLAUDE_COMPACT  1: from the second turn, play a compaction (PreCompact, compact_boundary, then SessionStart "compact")
//   FAKE_CLAUDE_TURN_STATE  counter file keeping FAKE_CLAUDE_COMPACT's turn count across respawns
//   FAKE_CLAUDE_CONTEXT_TOKENS  latest-prompt size reported in a scripted room-plan reply
//   FAKE_CLAUDE_AUTH  in (default) | out | unsupported | malformed | inherited-api-key: what `auth status` says
//     | api-key: signed in on the CLI's own API key (authMethod "api_key")
//     | file: signed in while <CLAUDE_CONFIG_DIR or ~/.claude>/fake-auth.json exists; `auth login` prints a
//     claude.ai link and writes it from the pasted code (`alice-…` signs in alice@example.com, `bad-…` is refused),
//     `auth logout` removes it
//   FAKE_CLAUDE_AUTO_UNAVAILABLE_MODELS  --model values where `--permission-mode auto` runs "default" (2.1.266)
//   FAKE_CLAUDE_LATE_STEER_GATE  path: a late steer runs as the next native turn (2.1.282), replying once it exists
//   FAKE_CLAUDE_LATE_STEER_INIT_GATE  path: that late turn's `init` also waits for it
//   FAKE_CLAUDE_LATE_STEER_SILENT  1: the late turn prints `init` and nothing else
//   FAKE_CLAUDE_SLOW_FINISH_GATE  path: `slow` replies once it exists; a body of "fail" ends as is_error
//   FAKE_CLAUDE_SLOW_TAIL_TOOL  1: `slow` makes one more tool call right before its reply
//   FAKE_CLAUDE_QUEUED_TURN_COUNT  unset | zero (what 2.1.282 reports for stdin words) | count
//   FAKE_CLAUDE_COST_STATE  dir of each session's running cost, restored on --resume as 2.1.282 does
//   FAKE_CLAUDE_ROUTER_PING  1: POST $ANTHROPIC_BASE_URL/v1/messages with the CLI's auth headers before each reply
//   FAKE_CLAUDE_RESUMED_API_ERROR  1: a --resume launch's first turn plays `api-error`
//   FAKE_CLAUDE_EXIT_DELAY_MS  ms to keep running after SIGTERM, like a slow taskkill on Windows
//   FAKE_CLAUDE_PROBE_LOG  path: each snapshot probe appends `<version|help|auth> <pid>`
//   FAKE_CLAUDE_HOLD_VERSION / _HELP / _AUTH  path: that snapshot probe answers only once it exists
//   FAKE_CLAUDE_MODE=slow-write: says it will build the page, then streams a Write of index.html as partial
//     input_json_delta frames (2.1.306 with --include-partial-messages) before its tool_use, runs it and replies.
//     FAKE_CLAUDE_WRITE_BYTES (default 16384) is the file's size, sent 512 bytes every FAKE_CLAUDE_WRITE_STEP_MS
//     (default 100); FAKE_CLAUDE_WRITE_HOLD  path: the call's input stays open once written until it exists
//   FAKE_CLAUDE_HOME_FILES  1: keep the CLI's own files in <CLAUDE_CONFIG_DIR or ~/.claude> as 2.1.294 does: a turn is
//     signed out without .credentials.json's claudeAiOauth.accessToken, refreshes an expired one (a temp file renamed over
//     it, written in place where the rename is refused), appends each prompt to projects/<cwd slug>/<session>.jsonl,
//     and --resume answers "No conversation found" without that file; the dump's signedInAs is the token used
//   FAKE_CLAUDE_RUN_BASH  1: a scripted Bash call without `output` runs its command (sh -c, in the CLI's folder and
//     environment); FAKE_CLAUDE_SHELL_LOG  path: each such call appends {command, output}
// total_cost_usd and modelUsage are running totals (0.01 per result), as the real CLI reports them.
import { splitLaunchNote } from "./launch-note.ts";
import { spawnSync } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { runRoomHandoffAgent } from "./room-handoff-agent.ts";

const mode = process.env.FAKE_CLAUDE_MODE ?? "happy";
const streamCadence = (() => {
  const raw = process.env.FAKE_CLAUDE_STREAM_CADENCE;
  if (!raw) return null;
  const [chars, ms] = raw.split(":");
  const parsed = { chars: Number(chars), ms: Number(ms) };
  return Number.isSafeInteger(parsed.chars) && parsed.chars > 0 && Number.isSafeInteger(parsed.ms) && parsed.ms >= 0 ? parsed : null;
})();

// Concurrent turns share a capture path: publish whole JSON in one rename.
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
        // Windows indexers can briefly hold either file open.
        const code = (error as NodeJS.ErrnoException).code ?? "";
        if (!["EPERM", "EACCES", "EBUSY"].includes(code) || attempt >= delays.length) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delays[attempt]);
      }
    }
  } finally {
    try { unlinkSync(tmp); } catch {}
  }
};

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
{
  const exitDelay = Number(process.env.FAKE_CLAUDE_EXIT_DELAY_MS);
  if (Number.isFinite(exitDelay) && exitDelay > 0) {
    process.on("SIGTERM", () => { setTimeout(() => process.exit(0), exitDelay); });
  }
}
const scriptedReplies = (() => {
  try {
    const parsed = JSON.parse(process.env.FAKE_CLAUDE_REPLIES ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is string | string[] =>
      typeof value === "string" || (Array.isArray(value) && value.every((part) => typeof part === "string"))
    );
  } catch {
    return [];
  }
})();
type ScriptedToolCall = { name: string; id?: string; input: Record<string, unknown>; ok: boolean; output?: unknown; server?: string };
const parseToolCalls = (raw: string | undefined): ScriptedToolCall[] | null => {
  if (raw === undefined) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed
      .filter((call): call is { name: string; id?: unknown; input?: unknown; ok?: unknown; output?: unknown; server?: unknown } => typeof call?.name === "string")
      .map((call) => ({
        name: call.name,
        ...(typeof call.id === "string" ? { id: call.id } : {}),
        input: call.input && typeof call.input === "object" && !Array.isArray(call.input) ? call.input as Record<string, unknown> : {},
        ok: call.ok !== false,
        output: call.output,
        ...(typeof call.server === "string" ? { server: call.server } : {}),
      }));
  } catch {
    return null;
  }
};
const scriptedToolCallsAtStart = parseToolCalls(process.env.FAKE_CLAUDE_TOOL_CALLS);
const turnToolCalls = (): ScriptedToolCall[] | null => {
  const file = process.env.FAKE_CLAUDE_TOOL_CALLS_FILE;
  if (!file) return scriptedToolCallsAtStart;
  try { return parseToolCalls(readFileSync(file, "utf8")) ?? []; } catch { return []; }
};
let toolUseCount = 0;
let scriptedReplyIndex = 0;
const nextScriptedReply = (): string[] => {
  // A test that wants one long reply puts it in this file for as long as it wants it, read again each turn.
  const replyFile = process.env.FAKE_CLAUDE_REPLY_FILE;
  if (replyFile && existsSync(replyFile)) return [readFileSync(replyFile, "utf8")];
  const stateFile = process.env.FAKE_CLAUDE_REPLY_STATE;
  let index = scriptedReplyIndex;
  if (stateFile) {
    try {
      index = Number(readFileSync(stateFile, "utf8")) || 0;
    } catch {}
    writeFileSync(stateFile, String(index + 1));
  } else {
    scriptedReplyIndex += 1;
  }
  const reply = scriptedReplies[index] ?? "hello from fake claude";
  return Array.isArray(reply) ? reply : [reply];
};

// FAKE_CLAUDE_MARKER_REPLIES: path of {"marker": "reply"}: a prompt whose
// text contains a marker answers with that marker's reply, whatever process
// or replay delivers it. The voice-latency harness routes replies this way
// because the driver replays a user message over several CLI launches.
const markerReplies = (() => {
  const path = process.env.FAKE_CLAUDE_MARKER_REPLIES;
  if (!path) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const entries = Object.entries(parsed as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string");
    return entries.length ? entries : null;
  } catch {
    return null;
  }
})();
const replyForPrompt = (prompt: JsonValue): string[] | null => {
  if (!markerReplies) return null;
  const text = steeredText(prompt);
  const hit = markerReplies.find(([marker]) => marker !== "" && text.includes(marker));
  return hit ? [hit[1]] : null;
};

const argv = process.argv.slice(2);
const settingsHooks: Record<string, Array<{ hooks?: Array<{ type?: string; command?: string; timeout?: number }> }>> = (() => {
  if (process.env.FAKE_CLAUDE_HOOKS !== "1") return {};
  const i = argv.indexOf("--settings");
  if (i === -1) return {};
  try {
    const parsed = JSON.parse(readFileSync(argv[i + 1]!, "utf8"));
    return parsed && typeof parsed.hooks === "object" ? parsed.hooks : {};
  } catch {
    return {};
  }
})();
function runHooks(event: string, payload: Record<string, unknown>): string {
  let stdout = "";
  for (const entry of settingsHooks[event] ?? []) {
    for (const hook of entry.hooks ?? []) {
      if (hook.type !== "command" || !hook.command) continue;
      const result = spawnSync(hook.command, {
        shell: true,
        input: JSON.stringify({ hook_event_name: event, session_id: "fake-session", cwd: process.cwd(), ...payload }),
        env: process.env,
        timeout: ((hook.timeout ?? 5) + 1) * 1000,
        stdio: ["pipe", "pipe", "pipe"],
        encoding: "utf8",
      });
      stdout += result.stdout ?? "";
    }
  }
  return stdout;
}
let turnsPlayed = 0;
let resumedErrorPlayed = false;
const argAfter = (flag: string): string | null => {
  const i = argv.indexOf(flag);
  return i === -1 ? null : (argv[i + 1] ?? null);
};

const out = (obj: unknown) => process.stdout.write(JSON.stringify(obj) + "\n");

const probe = argv[0] === "--version" ? "version" : argv[0] === "--help" ? "help" : argv[0] === "auth" && argv[1] === "status" ? "auth" : null;
if (probe) {
  if (process.env.FAKE_CLAUDE_PROBE_LOG) appendFileSync(process.env.FAKE_CLAUDE_PROBE_LOG, `${probe} ${process.pid}\n`);
  const hold = process.env[`FAKE_CLAUDE_HOLD_${probe.toUpperCase()}`];
  while (hold && !existsSync(hold)) await new Promise((resolve) => setTimeout(resolve, 20));
}

if (argv[0] === "--version") {
  // FAKE_CLAUDE_VERSION stands in for an older CLI.
  process.stdout.write(`${process.env.FAKE_CLAUDE_VERSION ?? "2.1.232"} (Claude Code)\n`);
  process.exit(0);
}

if (argv[0] === "--help") {
  // FAKE_CLAUDE_AUTOCOMPACT=0, or a version below 2.1.122, leaves --autocompact out of --help.
  const [maj = 0, min = 0, pat = 0] = (process.env.FAKE_CLAUDE_VERSION ?? "2.1.232").split(".").map(Number);
  const has = process.env.FAKE_CLAUDE_AUTOCOMPACT !== "0" && (maj > 2 || (maj === 2 && (min > 1 || (min === 1 && pat >= 122))));
  process.stdout.write(
    `Usage: claude [options]\n\nOptions:\n  --model <model>  Model\n${has ? "  --autocompact <tokens>  Compaction window\n" : ""}  -h, --help  Display help\n`,
  );
  process.exit(0);
}

if (argv[0] === "update") {
  if (process.env.FAKE_CLAUDE_UPDATE === "fail") {
    process.stderr.write("fake-claude: simulated update failure\n");
    process.exit(1);
  }
  process.stdout.write("Claude Code is up to date.\n");
  process.exit(0);
}

const fakeAuthFile = () => join(process.env.CLAUDE_CONFIG_DIR || join(process.env.HOME || homedir(), ".claude"), "fake-auth.json");

if (argv[0] === "auth" && argv[1] === "login" && process.env.FAKE_CLAUDE_AUTH === "file") {
  process.stdout.write(`Opening browser to sign in…\nBrowser didn't open? Use the url below to sign in (c to copy)\n\nhttps://claude.ai/oauth/authorize?code=true&client_id=fake&state=${process.pid}\n\nPaste code here if prompted > `);
  const code = await new Promise<string>((resolve) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      input += chunk;
      if (input.includes("\n")) resolve(input.split("\n")[0]!.trim());
    });
    process.stdin.on("end", () => resolve(input.trim()));
  });
  if (!code || code.startsWith("bad")) {
    process.stdout.write("\nOAuth error: Invalid code\n", () => process.exit(1));
  } else {
    mkdirSync(join(fakeAuthFile(), ".."), { recursive: true });
    writeFileSync(fakeAuthFile(), JSON.stringify({ email: `${code.split("-")[0]}@example.com` }));
    process.stdout.write("\nLogin successful.\n", () => process.exit(0));
  }
  await new Promise(() => {});
}

if (argv[0] === "auth" && argv[1] === "logout" && process.env.FAKE_CLAUDE_AUTH === "file") {
  rmSync(fakeAuthFile(), { force: true });
  process.stdout.write("Successfully logged out from your Anthropic account.\n", () => process.exit(0));
  await new Promise(() => {});
}

if (argv[0] === "auth" && argv[1] === "status") {
  const auth = process.env.FAKE_CLAUDE_AUTH ?? "in";
  if (auth === "file") {
    let email: string | undefined;
    try { email = (JSON.parse(readFileSync(fakeAuthFile(), "utf8")) as { email?: string }).email; } catch {}
    process.stdout.write(
      JSON.stringify(email ? { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", email } : { loggedIn: false, authMethod: "none", apiProvider: "firstParty" }) + "\n",
      () => process.exit(email ? 0 : 1),
    );
    await new Promise(() => {});
  }
  if (auth === "unsupported") {
    process.stderr.write("error: unknown command 'auth'\n");
    process.exit(1);
  }
  if (auth === "malformed") {
    process.stdout.write("not json\n");
    process.exit(0);
  }
  const loggedIn = auth === "in" || auth === "api-key" || (auth === "inherited-api-key" && Boolean(process.env.ANTHROPIC_API_KEY));
  process.stdout.write(
    JSON.stringify({ loggedIn, authMethod: !loggedIn ? "none" : auth === "api-key" ? "api_key" : "claude.ai", apiProvider: "firstParty" }) + "\n",
    () => process.exit(auth === "out" ? 1 : 0),
  );
}

if (["text", "json"].includes(argAfter("--output-format") ?? "")) {
  const prompt = await new Promise<string>((resolve) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => resolve(input));
  });
  if (argv.includes("--fork-session")) {
    const read = (flag: string) => {
      const path = argAfter(flag);
      if (!path) return null;
      try { return readFileSync(path, "utf8"); } catch { return null; }
    };
    if (process.env.FAKE_CLAUDE_PING_DUMP) {
      writeDumpAtomic(process.env.FAKE_CLAUDE_PING_DUMP, JSON.stringify({
        pid: process.pid, argv, env: process.env, prompt, cwd: process.cwd(),
        mcpConfig: JSON.parse(read("--mcp-config") ?? "null"),
        settings: JSON.parse(read("--settings") ?? "null"),
        systemPrompt: read("--append-system-prompt-file"),
      }, null, 2));
    }
    const pingModel = argAfter("--model") ?? "claude-fake";
    const usage = JSON.parse(process.env.FAKE_CLAUDE_PING_USAGE ?? '{"input_tokens":4,"cache_read_input_tokens":150000,"cache_creation_input_tokens":40,"output_tokens":3}');
    process.stdout.write(process.env.FAKE_CLAUDE_PING_RESULT ?? JSON.stringify({
      type: "result", is_error: false, result: "warm", session_id: "fake-fork", usage, total_cost_usd: 0.05,
      modelUsage: { [pingModel]: { costUSD: 0.05 } },
    }));
    process.exit(0);
  }
  // Background one-shots never overwrite the shared turn dump; FAKE_CLAUDE_TEXT_DUMP records them.
  const upkeepCall = /You are the (?:CAPTURE|TIDY|ORGANIZE) step of a memory system|You are the SKILL REVIEW step/.test(prompt);
  const oneShotDump = process.env.FAKE_CLAUDE_TEXT_DUMP ?? (upkeepCall ? undefined : process.env.FAKE_CLAUDE_DUMP);
  if (oneShotDump) {
    writeDumpAtomic(
      oneShotDump,
      JSON.stringify({ pid: process.pid, argv, env: process.env, prompt, cwd: process.cwd(), mcpConfig: null }, null, 2),
    );
  }
  if (process.env.FAKE_CLAUDE_TEXT_LOG) appendFileSync(process.env.FAKE_CLAUDE_TEXT_LOG, `${JSON.stringify({ prompt })}\n`);
  if (process.env.FAKE_CLAUDE_TEXT_HANG) {
    // An unsettled top-level await is fatal in Node; a repeating timer keeps the loop alive.
    await new Promise(() => setInterval(() => {}, 1 << 30));
  }
  const replyText = (text: string, code = 0) => {
    const model = argAfter("--model") ?? "claude-haiku-4-5";
    process.stdout.write(argAfter("--output-format") === "json"
      ? process.env.FAKE_CLAUDE_TEXT_RESULT ?? JSON.stringify({
          type: "result", is_error: code !== 0, result: text,
          usage: { input_tokens: 10, cache_read_input_tokens: 2, cache_creation_input_tokens: 3, output_tokens: 5 },
          total_cost_usd: 0.01,
          modelUsage: { [model]: { inputTokens: 10, cacheReadInputTokens: 2, cacheCreationInputTokens: 3, outputTokens: 5, costUSD: 0.01 } },
        })
      : code === 0 ? text : "");
    process.exit(code);
  };
  if (process.env.FAKE_CLAUDE_TEXT_ROUTES && existsSync(process.env.FAKE_CLAUDE_TEXT_ROUTES)) {
    try {
      const routes = JSON.parse(readFileSync(process.env.FAKE_CLAUDE_TEXT_ROUTES, "utf8")) as Record<string, string>;
      const hit = Object.entries(routes).find(([marker]) => prompt.includes(marker));
      if (hit) {
        replyText(hit[1]);
      }
    } catch {}
  }
  if (process.env.FAKE_CLAUDE_TEXT_FILE) {
    const file = process.env.FAKE_CLAUDE_TEXT_FILE;
    const reply = existsSync(file) ? readFileSync(file, "utf8") : "__FAIL__";
    if (reply.trim() === "__FAIL__") {
      process.stderr.write("fake one-shot text failed\n");
      replyText("fake one-shot text failed", 1);
    }
    replyText(reply);
  }
  replyText("fake generated text\n");
}

// Like the real CLI under --input-format stream-json: each stdin message starts a turn, and one
// sent mid-turn is folded into it.
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
const sessionId = argAfter("--resume") ?? argAfter("--session-id") ?? "fake-session";
const model = argAfter("--model") ?? "claude-fake";
const requestedPermissionMode = argAfter("--permission-mode") ?? "default";
const autoUnavailableFor = (process.env.FAKE_CLAUDE_AUTO_UNAVAILABLE_MODELS ?? "").split(",").filter(Boolean);
const permissionMode =
  requestedPermissionMode === "auto" && autoUnavailableFor.includes(model) ? "default" : requestedPermissionMode;
// FAKE_CLAUDE_KEEP_BASH=1 plays a CLI that keeps Bash whatever --tools said.
const mcpStatus = () => process.env.FAKE_CLAUDE_MCP_FAILED
  ? { mcp_servers: process.env.FAKE_CLAUDE_MCP_FAILED.split(",").map((name) => ({ name, status: "failed" })) }
  : {};
const toolsFlag = argAfter("--tools");
const tools = [...new Set([...(toolsFlag ? toolsFlag.split(",") : ["Bash", "Read", "Edit", "Write", "Glob", "Grep", "WebFetch", "WebSearch"]),
  ...(process.env.FAKE_CLAUDE_KEEP_BASH === "1" ? ["Bash"] : [])])];
let launchFiles: Record<string, unknown> | null = null;
let turnRunning = false;
let steered: string[] = [];
let steeredMessages: JsonValue[] = [];
const replayUserMessages = argv.includes("--replay-user-messages");
let replayCount = 0;
const replay = (sent: JsonValue) => {
  if (!replayUserMessages) return;
  const message = (sent ?? {}) as { uuid?: unknown; message?: unknown };
  const uuid = typeof message.uuid === "string" ? message.uuid : `fake-replay-${process.pid}-${++replayCount}`;
  out({ type: "user", message: message.message ?? null, uuid, session_id: sessionId, parent_tool_use_id: null, isReplay: true });
};
const replaySteered = () => {
  for (const message of steeredMessages.splice(0)) replay(message);
};
const lateSteers: JsonValue[] = [];
let lateContinuation = false;
let lateTurnWaiting = false;
type FakeModelUsage = { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number; costUSD: number };
const costStateFile = process.env.FAKE_CLAUDE_COST_STATE ? join(process.env.FAKE_CLAUDE_COST_STATE, `${sessionId}.json`) : null;
const runningCost: { total: number; modelUsage: Record<string, FakeModelUsage> } = (() => {
  if (costStateFile && argv.includes("--resume")) {
    try {
      return JSON.parse(readFileSync(costStateFile, "utf8"));
    } catch {}
  }
  return { total: 0, modelUsage: {} };
})();
let stdinEnded = false;
let steerGateArmed = false;

// FAKE_CLAUDE_STEER_GATE: stop reading stdin after the first prompt until this file exists, so a
// large second write leaves adapter.steer() pending while the first turn settles.
const armSteerGate = () => {
  const gate = process.env.FAKE_CLAUDE_STEER_GATE;
  if (!gate || steerGateArmed) return;
  steerGateArmed = true;
  process.stdin.pause();
  const poll = setInterval(() => {
    if (!existsSync(gate)) return;
    clearInterval(poll);
    process.stdin.resume();
  }, 10);
};

const promptText = (raw: JsonValue): string => {
  const prompt = splitLaunchNote(raw).prompt;
  const m = prompt && typeof prompt === "object" && !Array.isArray(prompt) ? (prompt as { message?: { content?: unknown } }).message : undefined;
  return typeof m?.content === "string" ? m.content : "";
};
const steeredText = (prompt: JsonValue): string => {
  const m = prompt && typeof prompt === "object" && !Array.isArray(prompt) ? (prompt as { message?: { content?: unknown } }).message : undefined;
  if (!Array.isArray(m?.content)) return promptText(prompt);
  return m.content
    .map((block: { type?: unknown; text?: unknown }) => block?.type === "image" ? "[image]" : typeof block?.text === "string" ? block.text.trim() : "")
    .filter(Boolean)
    .join(" ");
};

const startLateTurn = (): boolean => {
  if (lateTurnWaiting) return true;
  const late = lateSteers[0];
  if (late === undefined) return false;
  const initGate = process.env.FAKE_CLAUDE_LATE_STEER_INIT_GATE;
  if (initGate && !existsSync(initGate)) {
    lateTurnWaiting = true;
    const poll = setInterval(() => {
      if (!existsSync(initGate)) return;
      clearInterval(poll);
      lateTurnWaiting = false;
      finishIfDone();
    }, 10);
    return true;
  }
  lateSteers.shift();
  playTurn(late, true);
  return true;
};

const finishIfDone = () => {
  if (turnRunning) return;
  if (startLateTurn()) return;
  if (stdinEnded) process.exit(0);
  if (process.env.FAKE_CLAUDE_EXIT_AFTER_TURN === "1") process.stdout.write("", () => process.exit(0));
  const gone = process.env.FAKE_CLAUDE_GONE_AFTER_TURN;
  if (gone) process.stdout.write("", () => {
    // Node keeps fd 0 open through stdin.destroy().
    process.stdin.pause();
    closeSync(0);
    writeFileSync(`${gone}.closed`, "closed");
    setInterval(() => { if (existsSync(gone)) process.exit(0); }, 10);
  });
};

const finishTurn = () => {
  runHooks("Stop", { stop_hook_active: false });
  out({ type: "result", is_error: false, stop_reason: "end_turn", total_cost_usd: 0.01, usage: { input_tokens: 10, cache_read_input_tokens: 2, output_tokens: 5 } });
  turnRunning = false;
  finishIfDone();
};

const readLaunchFiles = (): Record<string, unknown> => {
  const configPath = argAfter("--mcp-config");
  let mcpConfig: unknown = null;
  if (configPath) {
    try {
      mcpConfig = JSON.parse(readFileSync(configPath, "utf8"));
    } catch {}
  }
  const systemPromptPath = argAfter("--append-system-prompt-file");
  const settingsPath = argAfter("--settings");
  const settings = settingsPath ? JSON.parse(readFileSync(settingsPath, "utf8")) : null;
  const settingsMode = settingsPath ? statSync(settingsPath).mode & 0o777 : null;
  let systemPrompt: string | null = null;
  if (systemPromptPath) {
    try {
      systemPrompt = readFileSync(systemPromptPath, "utf8");
    } catch {}
  }
  return { systemPrompt, mcpConfig, settings, settingsMode };
};

const useCloudComputer = () => {
  launchFiles ??= readLaunchFiles();
  const server = (launchFiles.mcpConfig as { mcpServers?: Record<string, { command?: string; args?: string[]; env?: Record<string, string> }> } | null)
    ?.mcpServers?.computer;
  if (!server?.command || server.args?.at(-1) !== "computer" || !/harness-mcp-proxy/.test(server.args[0] ?? "")) return;
  const id = `tu-${process.pid}-${++toolUseCount}`;
  out({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "mcp__computer__screenshot", input: {} }] } });
  const ran = spawnSync(server.command, server.args, {
    input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "screenshot", arguments: {} } })}\n`,
    env: { ...process.env, ...server.env }, encoding: "utf8", timeout: 150_000,
  });
  let reply: { result?: { isError?: boolean; content?: unknown }; error?: { message?: string } } = {};
  try { reply = JSON.parse(ran.stdout.trim().split("\n")[0] ?? ""); } catch { reply = { error: { message: ran.stderr || "no answer" } }; }
  out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id,
    is_error: Boolean(reply.error || reply.result?.isError), content: reply.result?.content ?? reply.error?.message ?? "" }] } });
};

// The connected-apps bridge exits when its stdin closes, before a reply that needs a harness
// round trip, so stdin stays open until the reply arrives.
const MCP_CALL_PROGRAM = `
const { spawn } = require("node:child_process");
const { command, args, env, request } = JSON.parse(process.argv[1]);
const child = spawn(command, args, { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "inherit"] });
let buffer = "";
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  for (const line of buffer.split("\\n").slice(0, -1)) {
    let reply;
    try { reply = JSON.parse(line); } catch { continue; }
    if (reply.id !== request.id) continue;
    process.stdout.write(JSON.stringify(reply) + "\\n");
    child.kill();
    process.exit(0);
  }
  buffer = buffer.slice(buffer.lastIndexOf("\\n") + 1);
});
child.on("exit", () => process.exit(1));
child.stdin.write(JSON.stringify(request) + "\\n");
`;

const mcpToolCall = (serverName: string, name: string, input: Record<string, unknown>): { ok: boolean; content: unknown } => {
  launchFiles ??= readLaunchFiles();
  const server = (launchFiles.mcpConfig as { mcpServers?: Record<string, { command?: string; args?: string[]; env?: Record<string, string> }> } | null)
    ?.mcpServers?.[serverName];
  if (!server?.command) return { ok: false, content: `no ${serverName} MCP server was launched for this turn` };
  const request = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: input } };
  const ran = spawnSync(process.execPath, ["-e", MCP_CALL_PROGRAM, JSON.stringify({ command: server.command, args: server.args ?? [], env: server.env ?? {}, request })], {
    encoding: "utf8", timeout: 120_000,
  });
  let reply: { result?: { isError?: boolean; content?: unknown }; error?: { message?: string } } = {};
  try { reply = JSON.parse(ran.stdout.trim().split("\n")[0] ?? ""); } catch { reply = { error: { message: ran.stderr || "no answer" } }; }
  return { ok: !reply.error && !reply.result?.isError, content: reply.result?.content ?? reply.error?.message ?? "" };
};

/** COMPOSIO_MANAGE_CONNECTIONS through the launched connected-apps server, if
 * this turn has one: the bridge turns it into a Connect card in the chat. */
const connectApps = (toolkits: string[]) => {
  launchFiles ??= readLaunchFiles();
  const server = (launchFiles.mcpConfig as { mcpServers?: Record<string, { command?: string; args?: string[]; env?: Record<string, string> }> } | null)
    ?.mcpServers?.composio;
  if (!server?.command) return;
  const id = `tu-${process.pid}-${++toolUseCount}`;
  const input = { toolkits };
  out({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "mcp__composio__COMPOSIO_MANAGE_CONNECTIONS", input }] } });
  const request = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "COMPOSIO_MANAGE_CONNECTIONS", arguments: input } };
  const ran = spawnSync(process.execPath, ["-e", MCP_CALL_PROGRAM, JSON.stringify({ command: server.command, args: server.args ?? [], env: server.env ?? {}, request })], {
    encoding: "utf8", timeout: 60_000,
  });
  let reply: { result?: { isError?: boolean; content?: unknown }; error?: { message?: string } } = {};
  try { reply = JSON.parse(ran.stdout.trim().split("\n")[0] ?? ""); } catch { reply = { error: { message: ran.stderr || "no answer" } }; }
  out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id,
    is_error: Boolean(reply.error || reply.result?.isError), content: reply.result?.content ?? reply.error?.message ?? "" }] } });
};

let volatileNote: string | null = null;
/** The volatile half of the instructions a user message carries (prompt-split.ts withVolatileNote), if any. */
const volatileNoteIn = (prompt: JsonValue): string | null => {
  const text = JSON.stringify(prompt);
  const parsed = /<system-reminder>\\nThis part of your instructions (?:changes from turn to turn|changed since this session started)[^:]*:\\n\\n([\s\S]*?)\\n<\/system-reminder>/.exec(text);
  return parsed ? (JSON.parse(`"${parsed[1]}"`) as string) : null;
};

const claudeFolder = () => process.env.CLAUDE_CONFIG_DIR || join(process.env.HOME || homedir(), ".claude");
const transcriptFile = () => join(claudeFolder(), "projects", process.cwd().replace(/[^a-zA-Z0-9]/g, "-"), `${sessionId}.jsonl`);
/** The access token this turn signs in with, refreshed first when expired; null when signed out. */
const homeSignIn = (): string | null => {
  const file = join(claudeFolder(), ".credentials.json");
  let oauth: { accessToken?: unknown; expiresAt?: unknown; [key: string]: unknown } | undefined;
  try { oauth = JSON.parse(readFileSync(file, "utf8")).claudeAiOauth; } catch { return null; }
  if (!oauth || typeof oauth.accessToken !== "string" || !oauth.accessToken) return null;
  if (typeof oauth.expiresAt !== "number" || oauth.expiresAt > Date.now()) return oauth.accessToken;
  const refreshed = { ...oauth, accessToken: `${oauth.accessToken}+`, expiresAt: Date.now() + 3_600_000 };
  const text = JSON.stringify({ claudeAiOauth: refreshed });
  const temporary = join(dirname(file), `.credentials.json.${process.pid}.tmp`);
  writeFileSync(temporary, text, { mode: 0o600 });
  try {
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    if (!["EXDEV", "EPERM", "EEXIST", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    writeFileSync(file, text);
  }
  return refreshed.accessToken;
};
const runBash = (command: string): { ok: boolean; content: string } => {
  const ran = spawnSync("/bin/sh", ["-c", command], { encoding: "utf8", timeout: 30_000 });
  const output = `${ran.stdout ?? ""}${ran.stderr ?? ""}`;
  if (process.env.FAKE_CLAUDE_SHELL_LOG) appendFileSync(process.env.FAKE_CLAUDE_SHELL_LOG, `${JSON.stringify({ command, output })}\n`);
  return { ok: ran.status === 0, content: output };
};

const playTurn = (prompt: JsonValue, late = false) => {
  turnRunning = true;
  lateContinuation = late;
  steered = [];
  steeredMessages = [];
  // FAKE_CLAUDE_PROMPTS: every prompt this process receives, one JSON line each.
  if (process.env.FAKE_CLAUDE_PROMPTS) appendFileSync(process.env.FAKE_CLAUDE_PROMPTS, `${JSON.stringify(prompt)}\n`);
  volatileNote = volatileNoteIn(prompt) ?? volatileNote;
  const homeFiles = process.env.FAKE_CLAUDE_HOME_FILES === "1";
  const signedInAs = homeFiles ? homeSignIn() : undefined;
  if (!late && process.env.FAKE_CLAUDE_DUMP) {
    launchFiles ??= readLaunchFiles();
    // systemPrompt: what the model is instructed with, the system prompt file plus the
    // volatile half a user message carries (claude.ts keeps the file stable for the cache)
    const systemPrompt = volatileNote && typeof launchFiles.systemPrompt === "string" ? `${launchFiles.systemPrompt}\n\n${volatileNote}` : launchFiles.systemPrompt;
    writeDumpAtomic(
      process.env.FAKE_CLAUDE_DUMP,
      JSON.stringify({ pid: process.pid, argv, env: process.env, cwd: process.cwd(), prompt, ...launchFiles, systemPrompt, systemPromptFile: launchFiles.systemPrompt, ...(homeFiles ? { signedInAs } : {}) }, null, 2),
    );
  }

  if (process.env.FAKE_CLAUDE_ROUTER_PING === "1" && process.env.ANTHROPIC_BASE_URL) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (process.env.ANTHROPIC_AUTH_TOKEN) headers.authorization = `Bearer ${process.env.ANTHROPIC_AUTH_TOKEN}`;
    if (process.env.ANTHROPIC_API_KEY) headers["x-api-key"] = process.env.ANTHROPIC_API_KEY;
    spawnSync(process.execPath, [
      "-e",
      "fetch(process.argv[1], { method: 'POST', headers: JSON.parse(process.argv[2]), body: '{}' }).then((r) => r.text(), () => {})",
      `${process.env.ANTHROPIC_BASE_URL.replace(/\/+$/u, "")}/v1/messages`,
      JSON.stringify(headers),
    ], { stdio: "ignore", timeout: 5_000 });
  }

  if (mode === "dead-session" && argv.includes("--resume")) {
    process.stderr.write(`fake-claude: No conversation found with session ID: ${argAfter("--resume")}\n`);
    process.exit(1);
  }
  if (homeFiles && !late) {
    if (argv.includes("--resume") && turnsPlayed === 0 && !existsSync(transcriptFile())) {
      out({
        type: "result", subtype: "error_during_execution", duration_ms: 0, is_error: true, num_turns: 0, stop_reason: null,
        session_id: sessionId, total_cost_usd: 0, errors: [`No conversation found with session ID: ${sessionId}`],
      });
      turnRunning = false;
      finishIfDone();
      return;
    }
    mkdirSync(dirname(transcriptFile()), { recursive: true });
    appendFileSync(transcriptFile(), `${JSON.stringify({ type: "user", sessionId, message: promptText(prompt) })}\n`);
  }
  if ((mode === "stale-session" && argv.includes("--resume")) || mode === "error-result") {
    out({
      type: "result", subtype: "error_during_execution", duration_ms: 0, is_error: true, num_turns: 0, stop_reason: null,
      session_id: sessionId, total_cost_usd: 0, errors: [`No conversation found with session ID: ${sessionId}`],
    });
    turnRunning = false;
    finishIfDone();
    return;
  }

  if (mode === "exit-early") {
    process.stderr.write("fake-claude: simulated crash before result\n");
    process.exit(3);
  }
  // FAKE_CLAUDE_TRANSIENTS launches fail transiently (exit 5), counted in the FAKE_CLAUDE_STATE file;
  // FAKE_CLAUDE_PARTIAL_FAILS makes the first one emit a text delta before failing.
  if (process.env.FAKE_CLAUDE_TRANSIENTS && process.env.FAKE_CLAUDE_STATE) {
    let launched = 0;
    try {
      launched = Number(readFileSync(process.env.FAKE_CLAUDE_STATE, "utf8")) || 0;
    } catch {}
    const quota = Number(process.env.FAKE_CLAUDE_TRANSIENTS) || 0;
    writeFileSync(process.env.FAKE_CLAUDE_STATE, String(launched + 1));
    out({ type: "system", subtype: "init", session_id: sessionId, model, permissionMode, tools, ...mcpStatus() });
    if (launched < quota) {
      if (process.env.FAKE_CLAUDE_PARTIAL_FAILS) {
        out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "half an answer" } } });
      }
      process.stderr.write("claude: API error (503): service temporarily unavailable\n");
      process.exit(5);
    }
  }

  // the real CLI re-announces init on every turn of a live process
  out({ type: "system", subtype: "init", session_id: sessionId, model, permissionMode, tools, ...mcpStatus() });
  const limitedFile = process.env.FAKE_CLAUDE_LIMITED_FILE;
  const limited = limitedFile && existsSync(limitedFile) ? readFileSync(limitedFile, "utf8") : null;
  const rateLimit = limited !== null ? JSON.parse(limited) : process.env.FAKE_CLAUDE_RATE_LIMIT ? JSON.parse(process.env.FAKE_CLAUDE_RATE_LIMIT) : null;
  if (rateLimit) out({ type: "rate_limit_event", rate_limit_info: rateLimit, session_id: sessionId });

  if (lateContinuation && process.env.FAKE_CLAUDE_LATE_STEER_SILENT) {
    setInterval(() => {}, 1_000);
    return;
  }
  replay(prompt);

  if (mode === "resume-dies-after-init" && argv.includes("--resume")) {
    process.stderr.write("fake-claude: simulated crash after accepting the resumed session\n");
    process.exit(3);
  }

  const resumedError = process.env.FAKE_CLAUDE_RESUMED_API_ERROR === "1" && argv.includes("--resume") && !resumedErrorPlayed;
  if (resumedError) resumedErrorPlayed = true;
  if (mode === "usage-limit" || limited !== null) {
    // captured from 2.1.295 for an account past its weekly limit
    const text = process.env.FAKE_CLAUDE_API_ERROR ?? "You've hit your weekly limit \u00b7 resets Oct 12 at 2:30pm (Asia/Calcutta)";
    out({
      type: "assistant", message: { model: "<synthetic>", stop_reason: "stop_sequence", content: [{ type: "text", text }] },
      error: "rate_limit", is_api_error_message: true, api_error: "usage_limit_reached",
      ...(rateLimit ? { api_error_params: { rate_limit_info: rateLimit } } : {}),
    });
    out({ type: "result", subtype: "success", is_error: true, stop_reason: "stop_sequence", terminal_reason: "api_error", api_error: "usage_limit_reached", result: text });
    turnRunning = false;
    finishIfDone();
    return;
  }
  if (mode === "api-error" || resumedError) {
    const text = process.env.FAKE_CLAUDE_API_ERROR ?? "API Error: 529 Overloaded. This is a server-side issue, usually temporary.";
    out({ type: "assistant", message: { model: "<synthetic>", stop_reason: "stop_sequence", content: [{ type: "text", text }] }, error: process.env.FAKE_CLAUDE_API_ERROR_KIND ?? "unknown", is_api_error_message: true });
    const status = Number(process.env.FAKE_CLAUDE_API_ERROR_STATUS) || undefined;
    out({ type: "result", subtype: "success", is_error: true, stop_reason: "stop_sequence", ...(process.env.FAKE_CLAUDE_NO_TERMINAL_REASON === "1" ? {} : { terminal_reason: "api_error" }), ...(status ? { api_error_status: status } : {}), result: text });
    turnRunning = false;
    finishIfDone();
    return;
  }

  if (process.env.FAKE_CLAUDE_ROOM_PLAN) {
    const progress = (text: string) => out({ type: "assistant", message: { content: [{ type: "text", text }] } });
    void runRoomHandoffAgent(argv, process.env.FAKE_CLAUDE_ROOM_PLAN, prompt, undefined, progress).then(text => {
      const contextTokens = Number(process.env.FAKE_CLAUDE_CONTEXT_TOKENS);
      const usage = Number.isSafeInteger(contextTokens) && contextTokens > 0 ? { input_tokens: contextTokens, output_tokens: 5 } : undefined;
      out({ type: "assistant", message: { content: [{ type: "text", text }], ...(usage ? { usage } : {}) } });
      out({ type: "result", is_error: false, stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } });
    }).catch(error => {
      out({ type: "result", is_error: true, result: String(error), stop_reason: "error" });
    }).finally(() => { turnRunning = false; finishIfDone(); });
    return;
  }

  if (mode === "hang") {
    const release = process.env.FAKE_CLAUDE_RELEASE;
    const finishGate = process.env.FAKE_CLAUDE_FINISH_GATE;
    const held = setInterval(() => {
      if (finishGate && existsSync(finishGate)) {
        clearInterval(held);
        out({ type: "assistant", message: { content: [{ type: "text", text: "fixture turn completed" }] } });
        finishTurn();
        return;
      }
      if (!release || !existsSync(release)) return;
      clearInterval(held);
      out({ type: "assistant", message: { content: [{ type: "text", text: "released" }] } });
      out({ type: "result", is_error: false, stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } });
      turnRunning = false;
      finishIfDone();
    }, finishGate ? 10 : 100);
    return;
  }

  if (mode === "malformed") {
    process.stdout.write("this is not json\n{broken\n");
  }

  // A signed-out CLI's frames, as Claude Code 2.1.296 sends them: only the frame's own error fields mark the failure.
  if (mode === "not-logged-in" || process.env.FAKE_CLAUDE_AUTH_AFTER_TURN === "1" && turnsPlayed > 0 || signedInAs === null) {
    if (process.env.FAKE_CLAUDE_AUTH_AFTER_WORK === "1") out({
      type: "assistant", message: { model: "claude-fixture", content: [{ type: "tool_use", id: "before-sign-out", name: "Bash", input: { command: "pwd" } }] },
    });
    out({ type: "system", subtype: "status", status: "requesting" });
    out({
      type: "assistant",
      message: { model: "<synthetic>", content: [{ type: "text", text: "Not logged in \u00b7 Please run /login" }] },
      error: "authentication_failed",
      is_api_error_message: true,
    });
    out({
      type: "result",
      is_error: true,
      stop_reason: "stop_sequence",
      terminal_reason: "api_error",
      result: "Not logged in \u00b7 Please run /login",
      total_cost_usd: runningCost.total,
    });
    turnRunning = false;
    finishIfDone();
    return;
  }

  if (mode === "stream") {
    const delta = (d: unknown) => out({ type: "stream_event", event: { type: "content_block_delta", delta: d } });
    delta({ type: "thinking_delta", thinking: "hmm" });
    delta({ type: "text_delta", text: "hello from " });
    delta({ type: "text_delta", text: "fake claude" });
    out({
      type: "stream_event",
      parent_tool_use_id: "task-1",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "SUBAGENT NOISE" } },
    });
  }

  if (process.env.FAKE_CLAUDE_USES_CLOUD_COMPUTER === "1") useCloudComputer();
  if (process.env.FAKE_CLAUDE_CONNECT_APPS) connectApps(process.env.FAKE_CLAUDE_CONNECT_APPS.split(",").filter(Boolean));

  let replyParts = replyForPrompt(prompt) ?? nextScriptedReply();
  const defaultToolId = `tu-${process.pid}-${++toolUseCount}`;
  if (process.env.FAKE_CLAUDE_TURN_STATE) {
    let n = 0;
    try { n = Number(readFileSync(process.env.FAKE_CLAUDE_TURN_STATE, "utf8")) || 0; } catch {}
    turnsPlayed = n;
    writeFileSync(process.env.FAKE_CLAUDE_TURN_STATE, String(n + 1));
  }
  turnsPlayed += 1;
  if (process.env.FAKE_CLAUDE_COMPACT === "1" && turnsPlayed >= 2) {
    runHooks("PreCompact", { trigger: "auto" });
    out({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 1000 } });
    const context = runHooks("SessionStart", { source: "compact" });
    if (context.trim()) replyParts = [`${context.trim()}\n\n${replyParts[0] ?? ""}`, ...replyParts.slice(1)];
  }
  const cacheRead = Number(process.env.FAKE_CLAUDE_CACHE_READ_TOKENS);
  const usage = { input_tokens: 10, cache_read_input_tokens: Number.isSafeInteger(cacheRead) && cacheRead > 0 ? cacheRead : 2, output_tokens: 5 };
  const finish = () => {
    replaySteered();
    runHooks("Stop", { stop_hook_active: false });
    runningCost.total = Number((runningCost.total + 0.01).toFixed(2));
    const counted = (runningCost.modelUsage[model] ??= { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0 });
    counted.inputTokens += 10;
    counted.cacheReadInputTokens += 2;
    counted.outputTokens += 5;
    counted.costUSD = Number((counted.costUSD + 0.01).toFixed(2));
    if (costStateFile) writeFileSync(costStateFile, JSON.stringify(runningCost));
    const queued = process.env.FAKE_CLAUDE_QUEUED_TURN_COUNT;
    out({
      type: "result",
      is_error: false,
      stop_reason: "end_turn",
      total_cost_usd: runningCost.total,
      usage: { input_tokens: 10, cache_read_input_tokens: 2, output_tokens: 5 },
      modelUsage: runningCost.modelUsage,
      ...(queued === "zero" ? { queued_turn_count: 0 } : queued === "count" ? { queued_turn_count: lateSteers.length } : {}),
    });
    turnRunning = false;
    finishIfDone();
  };

  if (mode === "slow-write") {
    const total = Number(process.env.FAKE_CLAUDE_WRITE_BYTES) || 16_384;
    const stepMs = Number(process.env.FAKE_CLAUDE_WRITE_STEP_MS) || 100;
    const id = `toolu-write-${process.pid}-${++toolUseCount}`;
    const filePath = join(process.cwd(), "index.html");
    const content = `<!doctype html>\n<title>Dashboard</title>\n${"<div class=\"card\">sales</div>\n".repeat(Math.ceil(total / 32))}`.slice(0, total);
    const event = (e: unknown) => out({ type: "stream_event", event: e, parent_tool_use_id: null, session_id: "fake-session" });
    out({ type: "assistant", message: { id: "msg-intro", content: [{ type: "text", text: "I'll build the dashboard now." }], usage } });
    event({ type: "message_start", message: { id: "msg-write", usage } });
    event({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name: "Write", input: {} } });
    const head = `{"file_path": ${JSON.stringify(filePath)}, "content": "`;
    const body = JSON.stringify(content).slice(1, -1);
    event({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: head } });
    let at = 0;
    const closeCall = () => {
      event({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "\"}" } });
      event({ type: "content_block_stop", index: 0 });
      out({ type: "assistant", message: { id: "msg-write", content: [{ type: "tool_use", id, name: "Write", input: { file_path: filePath, content } }], usage } });
      event({ type: "message_stop" });
      out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: false, content: `File created successfully at: ${filePath}` }] } });
      out({ type: "assistant", message: { content: [{ type: "text", text: "Done: index.html is ready." }], usage } });
      finish();
    };
    const step = () => {
      if (at < body.length) {
        event({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: body.slice(at, at + 512) } });
        at += 512;
        setTimeout(step, stepMs);
        return;
      }
      const hold = process.env.FAKE_CLAUDE_WRITE_HOLD;
      if (!hold) return closeCall();
      const poll = setInterval(() => {
        if (!existsSync(hold)) return;
        clearInterval(poll);
        closeCall();
      }, 50);
    };
    setTimeout(step, stepMs);
    return;
  }

  if (streamCadence && mode === "happy") {
    // Deterministic delta replay for the voice-latency harness: stream each
    // scripted reply part as fixed-size text_delta chunks at a fixed interval,
    // then the assistant message (the driver dedups the streamed text).
    const emitPart = (part: number) => {
      const text = replyParts[part] ?? "";
      let at = 0;
      const step = () => {
        const chunk = text.slice(at, at + streamCadence.chars);
        at += streamCadence.chars;
        if (chunk) out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: chunk } } });
        if (at < text.length) {
          setTimeout(step, streamCadence.ms);
        } else {
          out({ type: "assistant", message: { content: [{ type: "text", text }], usage } });
          if (part + 1 < replyParts.length) setTimeout(() => emitPart(part + 1), streamCadence.ms);
          else setTimeout(() => finish(), 0);
        }
      };
      step();
    };
    emitPart(0);
    return;
  }
  const scriptedToolCalls = turnToolCalls();
  if (scriptedToolCalls) {
    const failureContext: string[] = [];
    for (const call of scriptedToolCalls) {
      const id = call.id ?? `tu-${process.pid}-${++toolUseCount}`;
      out({ type: "assistant", message: { content: [{ type: "tool_use", id, name: call.name, input: call.input }], usage } });
      const reply = call.server ? mcpToolCall(call.server, call.name, call.input)
        : call.name === "Bash" && call.output === undefined && process.env.FAKE_CLAUDE_RUN_BASH === "1" ? runBash(String((call.input as { command?: unknown } | undefined)?.command ?? ""))
        : { ok: call.ok, content: call.output };
      out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: !reply.ok, content: reply.content }] } });
      if (!reply.ok) {
        // Claude Code 2.1.296 runs only PostToolUseFailure for a failed call, with the result text as `error`.
        const printed = runHooks("PostToolUseFailure", { tool_name: call.name, tool_input: call.input, error: reply.content, tool_use_id: id });
        try {
          const context = JSON.parse(printed)?.hookSpecificOutput?.additionalContext;
          if (typeof context === "string" && context) failureContext.push(context);
        } catch {}
      } else {
        runHooks("PostToolUse", { tool_name: call.name, tool_input: call.input, tool_response: reply.content, tool_use_id: id });
      }
    }
    if (failureContext.length) replyParts = [`${failureContext.join("\n")}\n\n${replyParts[0] ?? ""}`, ...replyParts.slice(1)];
    for (const text of replyParts) out({ type: "assistant", message: { content: [{ type: "text", text }], usage } });
  } else {
    replyParts.forEach((text, index) => {
      const content: Array<
        { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
      > = [{ type: "text", text }];
      if (index === replyParts.length - 1) content.push({ type: "tool_use", id: defaultToolId, name: "Bash", input: { command: "echo hi" } });
      out({ type: "assistant", message: { content, usage } });
    });
    if (mode === "tool-heartbeat") {
      // Claude Code 2.1.306 sends this every 30 s while a tool runs.
      out({ type: "tool_progress", tool_use_id: `${defaultToolId}-heartbeat-0`, tool_name: "Bash",
        parent_tool_use_id: defaultToolId, elapsed_time_seconds: 30, heartbeat: true });
    }
    out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: defaultToolId, is_error: false, content: [{ type: "text", text: "hi" }] }] } });
    runHooks("PostToolUse", { tool_name: "Bash", tool_input: { command: "echo hi" }, tool_response: "hi", tool_use_id: defaultToolId });
  }

  if (mode === "background-result") {
    // Claude emits a synthetic result when a background task finishes; it does not complete the turn.
    out({ type: "result", origin: { kind: "task-notification" }, is_error: false, total_cost_usd: 99 });
    out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "parent still working" } } });
    const poll = setInterval(() => {
      if (!process.env.FAKE_CLAUDE_FINISH_GATE || !existsSync(process.env.FAKE_CLAUDE_FINISH_GATE)) return;
      clearInterval(poll);
      finish();
    }, 10);
    return;
  }
  if (mode === "slow") {
    const finishSlowTurn = () => {
      if (process.env.FAKE_CLAUDE_SLOW_TAIL_TOOL) {
        const id = `tu-${process.pid}-${++toolUseCount}`;
        out({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Bash", input: { command: "echo tail" } }] } });
        out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: false, content: [{ type: "text", text: "tail" }] }] } });
      }
      const tail = steered.length ? ` + steered: ${steered.join(" | ")}` : "";
      replaySteered();
      out({ type: "assistant", message: { content: [{ type: "text", text: `reply to: ${promptText(prompt)}${tail}` }] } });
      const gate = process.env.FAKE_CLAUDE_SLOW_FINISH_GATE;
      if (!lateContinuation && gate && readFileSync(gate, "utf8").trim() === "fail") {
        out({ type: "result", is_error: true, stop_reason: "error", result: "fixture turn failed" });
        turnRunning = false;
        finishIfDone();
        return;
      }
      finish();
    };
    const finishGate = lateContinuation ? process.env.FAKE_CLAUDE_LATE_STEER_GATE : process.env.FAKE_CLAUDE_SLOW_FINISH_GATE;
    if (finishGate) {
      const poll = setInterval(() => {
        if (!existsSync(finishGate)) return;
        clearInterval(poll);
        // Timers run before the poll phase that reads the pipe, so finishing here could leave the
        // steer unread: hand off to the check phase.
        setImmediate(finishSlowTurn);
      }, 10);
    } else {
      setTimeout(finishSlowTurn, 800);
    }
  } else {
    finish();
  }
};

let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let prompt: JsonValue = null;
    try {
      prompt = JSON.parse(line);
    } catch {
      continue;
    }
    if (turnRunning || lateTurnWaiting) {
      if (process.env.FAKE_CLAUDE_LATE_STEER_GATE) lateSteers.push(prompt);
      else {
        steered.push(steeredText(prompt));
        steeredMessages.push(prompt);
      }
      if (process.env.FAKE_CLAUDE_STEER_RECEIVED) writeFileSync(process.env.FAKE_CLAUDE_STEER_RECEIVED, "received");
    } else {
      playTurn(prompt);
      armSteerGate();
    }
  }
});
process.stdin.on("end", () => {
  stdinEnded = true;
  finishIfDone();
});
