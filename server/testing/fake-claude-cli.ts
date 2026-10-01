#!/usr/bin/env node
// Fake of the claude CLI's stream-json surface, for driver tests.
// Reads the prompt from stdin (one stream-json line), then plays a
// scripted session. Failure modes are toggled by env var, mirroring how
// the real thing misbehaves:
//
//   FAKE_CLAUDE_MODE   happy (default) | exit-early | hang | malformed |
//                      dead-session (fails only when --resume is passed)
//                      | resume-dies-after-init (a --resume launch emits
//                        init, then exits without result or output)
//                      | stream (partial-message text deltas before the
//                        whole-message frame, plus subagent noise to drop)
//                      | not-logged-in (the frames a signed-out CLI really
//                        sends, captured from 2.1.263)
//                      | api-error (the CLI reports a non-auth API error as
//                        assistant text, then an error result; no model output)
//   FAKE_CLAUDE_API_ERROR text for the api-error frame (default: overloaded).
//   FAKE_CLAUDE_RELEASE with hang: the turn ends normally once this file exists.
//   FAKE_CLAUDE_DUMP   path to write {argv, env, cwd, prompt, systemPrompt,
//                      mcpConfig} as JSON,
//                      so the test can assert on argv shape and env hygiene.
//                      mcpConfig is read back from the --mcp-config file the
//                      way the real CLI reads it — the driver writes it to a
//                      private temp file and deletes it when the turn settles,
//                      so a test cannot open it after the fact.
//   FAKE_CLAUDE_TEXT_FILE path whose contents are the one-shot text mode's
//                      reply, read fresh each run so a suite sharing one
//                      server can vary it per test. A missing file, or a body
//                      of exactly __FAIL__, makes the call fail outright —
//                      the shape a caller's fallback path has to survive.
//   FAKE_CLAUDE_TEXT_ROUTES path of a JSON object {"marker": "reply"}, read
//                      fresh each run: a one-shot prompt containing a marker
//                      gets that reply (first match wins), before
//                      FAKE_CLAUDE_TEXT_FILE is consulted.
//   FAKE_CLAUDE_TEXT_DUMP like FAKE_CLAUDE_DUMP, but for one-shot text runs,
//                      so they never overwrite a turn's dump mid-test.
//   FAKE_CLAUDE_TEXT_HANG when set, the one-shot text mode never replies —
//                      the caller's abort signal is the only way it ends,
//                      which is exactly what its tests need to prove.
//   FAKE_CLAUDE_TEXT_RESULT raw --output-format json one-shot response;
//                      unset, wraps the text reply with synthetic usage.
//   FAKE_CLAUDE_REPLIES JSON array of strings (or string arrays for multiple
//                      assistant items) used in order across turns. This makes
//                      bounded multi-turn orchestration deterministic.
//   FAKE_CLAUDE_REPLY_STATE Optional counter file shared by fresh CLI
//                      processes so scripted replies keep their order.
//   FAKE_CLAUDE_TOOL_CALLS JSON array of {name, input?, ok?}: the tool calls
//                      each turn makes, in order and before its reply text —
//                      one tool_use (fresh id, that name and input) followed
//                      by its tool_result (is_error unless ok, default true).
//                      Unset, a turn makes the single default Bash call.
//   FAKE_CLAUDE_HOOKS  1: honour the `hooks` block of the --settings file the
//                      way the real CLI does — after each tool_result run
//                      every PostToolUse command with the event JSON on
//                      stdin (synchronously, inheriting this env), and once
//                      at the end run the Stop commands.
//   FAKE_CLAUDE_COMPACT 1: on this process's second and later turns, play a
//                      compaction the way the CLI does — run the PreCompact
//                      hooks (trigger auto), then the SessionStart hooks with
//                      source "compact", and treat whatever SessionStart's
//                      stdout said as context by echoing it into the reply.
//   FAKE_CLAUDE_TURN_STATE path of a counter file shared by fresh CLI
//                      processes, so FAKE_CLAUDE_COMPACT's "second turn"
//                      survives a respawn between turns.
//   FAKE_CLAUDE_CONTEXT_TOKENS report this latest-prompt size in a scripted
//                      room-plan reply, for automatic compaction fixtures.
//   FAKE_CLAUDE_AUTH   in (default) | out | unsupported | malformed |
//                      inherited-api-key — what `auth status` reports
//   FAKE_CLAUDE_AUTO_UNAVAILABLE_MODELS comma-separated --model values for
//                      which `--permission-mode auto` starts in "default",
//                      the way the real CLI (2.1.266) does for Haiku 4.5 and
//                      Sonnet 4.5: init reports the mode it actually runs in.
//   FAKE_CLAUDE_LATE_STEER_GATE path: a message that arrives mid-turn landed
//                      after the turn's last model call began. The real CLI
//                      (2.1.282) cannot fold it then: it finishes the turn
//                      with `result` and runs the message as its NEXT turn on
//                      the same stdin — init, tool call, reply. In `slow`
//                      mode that reply waits for this file, so a test can
//                      probe the harness while the continuation is running.
//   FAKE_CLAUDE_LATE_STEER_INIT_GATE path: with the gate above, the late
//                      turn's `init` waits for this file too, so a test can
//                      act while the first result is held and nothing has
//                      announced the continuation yet.
//   FAKE_CLAUDE_LATE_STEER_SILENT 1: the late turn prints `init` and then
//                      nothing at all — a continuation that never speaks.
//   FAKE_CLAUDE_SLOW_TAIL_TOOL 1: `slow` makes one more tool call right
//                      before its reply — a fold seam the harness sees after
//                      a steer that was already too late to be folded.
//   FAKE_CLAUDE_QUEUED_TURN_COUNT unset | zero | count — whether a result
//                      carries queued_turn_count. Unset: absent, an older
//                      CLI. zero: always 0, what 2.1.282 reports for words
//                      waiting on stdin (they are not in its command queue,
//                      yet it runs them next). count: the late steers still
//                      queued, the field's documented meaning.
//   Every result's total_cost_usd is the process's running total (0.01 per
//   result), the way the real CLI reports it: read the latest, never sum.
//   Its modelUsage is the same running count per model (tokens and costUSD).
//   FAKE_CLAUDE_COST_STATE dir: the real CLI (2.1.282) restores a session's
//                      running cost on --resume, so a resumed process's first
//                      total already counts the earlier turns. The fake saves
//                      its running cost per session id here, and a --resume
//                      launch starts from it.
//   FAKE_CLAUDE_ROUTER_PING 1: before each turn's reply, send one POST to
//                      $ANTHROPIC_BASE_URL/v1/messages carrying the headers
//                      the real CLI derives from its env (ANTHROPIC_AUTH_TOKEN
//                      as a Bearer token, ANTHROPIC_API_KEY as x-api-key), so a
//                      test's stub router sees what a real turn would send.
//                      Nothing is sent when ANTHROPIC_BASE_URL is unset.
//   FAKE_CLAUDE_RESUMED_API_ERROR 1: a --resume launch plays its first turn
//                      the `api-error` way — an error result with no cost
//                      figure — and its later turns normally.
//   FAKE_CLAUDE_EXIT_DELAY_MS ms this process keeps running after SIGTERM
//                      before it exits: a CLI that is slow to stop, as one
//                      can be on Windows, where taskkill is asynchronous.
//
// Keep this file dependency-free — it runs as a bare `node` subprocess.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runRoomHandoffAgent } from "./room-handoff-agent.ts";

const mode = process.env.FAKE_CLAUDE_MODE ?? "happy";

// Follow the spawning server down, including on Windows where ppid does
// not change after parent exit. Inline: fakes must stay self-contained.
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
type ScriptedToolCall = { name: string; id?: string; input: Record<string, unknown>; ok: boolean; output?: unknown };
// null = unset (or unparseable): keep the single default Bash call.
const scriptedToolCalls: ScriptedToolCall[] | null = (() => {
  const raw = process.env.FAKE_CLAUDE_TOOL_CALLS;
  if (raw === undefined) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed
      .filter((call): call is { name: string; id?: unknown; input?: unknown; ok?: unknown; output?: unknown } => typeof call?.name === "string")
      .map((call) => ({
        name: call.name,
        ...(typeof call.id === "string" ? { id: call.id } : {}),
        input: call.input && typeof call.input === "object" && !Array.isArray(call.input) ? call.input as Record<string, unknown> : {},
        ok: call.ok !== false,
        output: call.output,
      }));
  } catch {
    return null;
  }
})();
let toolUseCount = 0;
let scriptedReplyIndex = 0;
const nextScriptedReply = (): string[] => {
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
/** Run every command hook registered for `event`, like the real CLI: JSON on
 * stdin, wait for exit (bounded), ignore its output except to a dump. */
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

// Snapshot probes: both answer on argv alone and exit without reading stdin.
if (argv[0] === "--version") {
  // FAKE_CLAUDE_VERSION lets a test stand in for an older CLI: the driver
  // withholds flags that version predates (CLAUDE_FLAG_FLOORS).
  process.stdout.write(`${process.env.FAKE_CLAUDE_VERSION ?? "2.1.232"} (Claude Code)\n`);
  process.exit(0);
}

if (argv[0] === "--help") {
  // Lists --autocompact in the option column like the real CLI, unless the
  // fake stands in for a build without it: FAKE_CLAUDE_AUTOCOMPACT=0, or a
  // version below the 2.1.122 floor.
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

if (argv[0] === "auth" && argv[1] === "status") {
  const auth = process.env.FAKE_CLAUDE_AUTH ?? "in";
  if (auth === "unsupported") {
    process.stderr.write("error: unknown command 'auth'\n");
    process.exit(1);
  }
  if (auth === "malformed") {
    process.stdout.write("not json\n");
    process.exit(0);
  }
  const loggedIn = auth === "in" || (auth === "inherited-api-key" && Boolean(process.env.ANTHROPIC_API_KEY));
  process.stdout.write(
    JSON.stringify({ loggedIn, authMethod: loggedIn ? "claude.ai" : "none", apiProvider: "firstParty" }) + "\n",
    () => process.exit(auth === "out" ? 1 : 0),
  );
}

// One-shot helper mode used by generateText/reviewPermission. The prompt is
// deliberately read from stdin so sensitive review text never appears in
// argv or process listings.
if (["text", "json"].includes(argAfter("--output-format") ?? "")) {
  const prompt = await new Promise<string>((resolve) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => resolve(input));
  });
  // Memory upkeep's background one-shots (on for every bot) never overwrite
  // the shared turn dump a test reads; FAKE_CLAUDE_TEXT_DUMP still records them.
  const upkeepCall = /You are the (?:CAPTURE|TIDY|ORGANIZE) step of a memory system/.test(prompt);
  const oneShotDump = process.env.FAKE_CLAUDE_TEXT_DUMP ?? (upkeepCall ? undefined : process.env.FAKE_CLAUDE_DUMP);
  if (oneShotDump) {
    writeFileSync(
      oneShotDump,
      JSON.stringify({ pid: process.pid, argv, env: process.env, prompt, mcpConfig: null }, null, 2),
    );
  }
  if (process.env.FAKE_CLAUDE_TEXT_HANG) {
    // a repeating timer keeps the loop alive without settling the
    // top-level await, which Node would otherwise treat as fatal
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
  // FAKE_CLAUDE_TEXT_ROUTES: a JSON file {"marker": "reply"}, re-read each
  // run; the first marker the prompt contains picks the reply, so one run
  // can answer a capture, a tidy-up and a title differently.
  if (process.env.FAKE_CLAUDE_TEXT_ROUTES && existsSync(process.env.FAKE_CLAUDE_TEXT_ROUTES)) {
    try {
      const routes = JSON.parse(readFileSync(process.env.FAKE_CLAUDE_TEXT_ROUTES, "utf8")) as Record<string, string>;
      const hit = Object.entries(routes).find(([marker]) => prompt.includes(marker));
      if (hit) {
        replyText(hit[1]);
      }
    } catch {
      // a malformed routes file falls through to the plain reply below
    }
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

// Line-driven, like the real CLI under --input-format stream-json: each user
// message starts a turn; a message that arrives WHILE a turn is playing is
// folded into it (the real CLI delivers it before the next model call — the
// harness calls that a steer); the process stays alive with stdin open and
// exits only when stdin ends. `slow` leaves a gap between the tool result
// and the reply so a test can steer into it.
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
const sessionId = argAfter("--resume") ?? argAfter("--session-id") ?? "fake-session";
const model = argAfter("--model") ?? "claude-fake";
// The mode init reports: what was asked for, unless auto is unavailable for
// this model, in which case the real CLI silently runs Manual ("default").
const requestedPermissionMode = argAfter("--permission-mode") ?? "default";
const autoUnavailableFor = (process.env.FAKE_CLAUDE_AUTO_UNAVAILABLE_MODELS ?? "").split(",").filter(Boolean);
const permissionMode =
  requestedPermissionMode === "auto" && autoUnavailableFor.includes(model) ? "default" : requestedPermissionMode;
// The built-in tools init reports, as the real CLI does: --tools when given,
// else its default set. FAKE_CLAUDE_KEEP_BASH=1 plays a CLI that keeps Bash
// whatever it was told.
const toolsFlag = argAfter("--tools");
const tools = [...new Set([...(toolsFlag ? toolsFlag.split(",") : ["Bash", "Read", "Edit", "Write", "Glob", "Grep", "WebFetch", "WebSearch"]),
  ...(process.env.FAKE_CLAUDE_KEEP_BASH === "1" ? ["Bash"] : [])])];
let dumped = false;
let turnRunning = false;
let steered: string[] = [];
/** The folded steers as they were sent, echoed when the reply takes them in. */
let steeredMessages: JsonValue[] = [];
// --replay-user-messages (2.1.282): each stdin user message is echoed, with
// the uuid it was sent with, as a turn takes it in — the prompt as its turn
// starts, a folded steer before the reply that answers it, a late steer as
// its own turn starts.
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
// Messages that landed after the running turn's last model call
// (FAKE_CLAUDE_LATE_STEER_GATE): each becomes the next turn once it ends.
const lateSteers: JsonValue[] = [];
let lateContinuation = false;
let lateTurnWaiting = false;
// the running cost behind total_cost_usd and modelUsage; a --resume launch
// starts from the session's saved one (FAKE_CLAUDE_COST_STATE)
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

// Ownership-race fixture: after accepting the first prompt, stop consuming
// stdin until the test creates this file. A large second write then leaves
// adapter.steer() genuinely pending while the first turn settles and another
// HTTP request deletes or switches the bot.
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

const promptText = (prompt: JsonValue): string => {
  const m = prompt && typeof prompt === "object" && !Array.isArray(prompt) ? (prompt as { message?: { content?: unknown } }).message : undefined;
  return typeof m?.content === "string" ? m.content : "";
};

/** A message the finished turn could not fold runs as the next turn — once
 * FAKE_CLAUDE_LATE_STEER_INIT_GATE, if set, lets its `init` out. True while
 * one is queued or waiting. */
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
};

const playTurn = (prompt: JsonValue, late = false) => {
  turnRunning = true;
  lateContinuation = late;
  steered = [];
  steeredMessages = [];
  // Every prompt this process receives, one JSON object per line. FAKE_CLAUDE_DUMP
  // records only the first, which cannot show what a REUSED session was sent on
  // its second and later turns.
  if (process.env.FAKE_CLAUDE_PROMPTS) appendFileSync(process.env.FAKE_CLAUDE_PROMPTS, `${JSON.stringify(prompt)}\n`);
  if (!dumped && process.env.FAKE_CLAUDE_DUMP) {
    dumped = true;
    const configPath = argAfter("--mcp-config");
    let mcpConfig: unknown = null;
    if (configPath) {
      try {
        mcpConfig = JSON.parse(readFileSync(configPath, "utf8"));
      } catch {
        /* leave null — the test will see it */
      }
    }
    const systemPromptPath = argAfter("--append-system-prompt-file");
    const settingsPath = argAfter("--settings");
    const settings = settingsPath ? JSON.parse(readFileSync(settingsPath, "utf8")) : null;
    const settingsMode = settingsPath ? statSync(settingsPath).mode & 0o777 : null;
    let systemPrompt: string | null = null;
    if (systemPromptPath) {
      try {
        systemPrompt = readFileSync(systemPromptPath, "utf8");
      } catch {
        /* leave null — the test will see it */
      }
    }
    writeFileSync(
      process.env.FAKE_CLAUDE_DUMP,
      JSON.stringify({ pid: process.pid, argv, env: process.env, cwd: process.cwd(), prompt, systemPrompt, mcpConfig, settings, settingsMode }, null, 2),
    );
  }

  if (process.env.FAKE_CLAUDE_ROUTER_PING === "1" && process.env.ANTHROPIC_BASE_URL) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (process.env.ANTHROPIC_AUTH_TOKEN) headers.authorization = `Bearer ${process.env.ANTHROPIC_AUTH_TOKEN}`;
    if (process.env.ANTHROPIC_API_KEY) headers["x-api-key"] = process.env.ANTHROPIC_API_KEY;
    // Synchronous on purpose: the turn's frames follow the request, as they do
    // for the real CLI, and this fake's turn loop is synchronous.
    spawnSync(process.execPath, [
      "-e",
      "fetch(process.argv[1], { method: 'POST', headers: JSON.parse(process.argv[2]), body: '{}' }).then((r) => r.text(), () => {})",
      `${process.env.ANTHROPIC_BASE_URL.replace(/\/+$/u, "")}/v1/messages`,
      JSON.stringify(headers),
    ], { stdio: "ignore", timeout: 5_000 });
  }

  // A resumed session the CLI no longer has: it exits before any `init`
  // frame, so the prompt on stdin is never read. A FRESH launch (--session-id)
  // works normally, which is what makes recovery observable.
  if (mode === "dead-session" && argv.includes("--resume")) {
    process.stderr.write(`fake-claude: No conversation found with session ID: ${argAfter("--resume")}\n`);
    process.exit(1);
  }

  if (mode === "exit-early") {
    process.stderr.write("fake-claude: simulated crash before result\n");
    process.exit(3);
  }
  // transient-failure script for retry tests. FAKE_CLAUDE_TRANSIENTS is how
  // many launches fail transiently (503-shaped stderr, exit 5); the count of
  // launches so far lives in a state FILE because child processes cannot
  // mutate the parent's environment. When the quota is exhausted (or
  // FAKE_CLAUDE_STATE is unset) the turn completes normally.
  // FAKE_CLAUDE_PARTIAL_FAILS makes the FIRST launch emit a text delta
  // before failing — the partial-output guard must forbid retrying it.
  if (process.env.FAKE_CLAUDE_TRANSIENTS && process.env.FAKE_CLAUDE_STATE) {
    let launched = 0;
    try {
      launched = Number(readFileSync(process.env.FAKE_CLAUDE_STATE, "utf8")) || 0;
    } catch {}
    const quota = Number(process.env.FAKE_CLAUDE_TRANSIENTS) || 0;
    writeFileSync(process.env.FAKE_CLAUDE_STATE, String(launched + 1));
    out({ type: "system", subtype: "init", session_id: sessionId, model, permissionMode, tools });
    if (launched < quota) {
      if (process.env.FAKE_CLAUDE_PARTIAL_FAILS) {
        out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "half an answer" } } });
      }
      process.stderr.write("claude: API error (503): service temporarily unavailable\n");
      process.exit(5);
    }
  }

  // the real CLI re-announces init on every turn of a live process
  out({ type: "system", subtype: "init", session_id: sessionId, model, permissionMode, tools });

  // a continuation that announces itself and then never speaks again
  if (lateContinuation && process.env.FAKE_CLAUDE_LATE_STEER_SILENT) {
    setInterval(() => {}, 1_000);
    return;
  }
  replay(prompt);

  // The CLI accepted the resumed session — it read the prompt — and then
  // died with nothing to show. The prompt may already have run tools, so
  // the driver must NOT send it again.
  if (mode === "resume-dies-after-init" && argv.includes("--resume")) {
    process.stderr.write("fake-claude: simulated crash after accepting the resumed session\n");
    process.exit(3);
  }

  const resumedError = process.env.FAKE_CLAUDE_RESUMED_API_ERROR === "1" && argv.includes("--resume") && !resumedErrorPlayed;
  if (resumedError) resumedErrorPlayed = true;
  if (mode === "api-error" || resumedError) {
    const text = process.env.FAKE_CLAUDE_API_ERROR ?? "API Error: 529 Overloaded. This is a server-side issue, usually temporary.";
    out({ type: "assistant", message: { model: "<synthetic>", content: [{ type: "text", text }] }, error: "unknown", is_api_error_message: true });
    out({ type: "result", is_error: true, stop_reason: "stop_sequence", terminal_reason: "api_error", result: text });
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
    // stay alive until killed — lets tests exercise interrupt + the
    // permission broker while a turn is officially in flight. With
    // FAKE_CLAUDE_RELEASE, the turn ends normally once that file exists.
    const release = process.env.FAKE_CLAUDE_RELEASE;
    const held = setInterval(() => {
      if (!release || !existsSync(release)) return;
      clearInterval(held);
      out({ type: "assistant", message: { content: [{ type: "text", text: "released" }] } });
      out({ type: "result", is_error: false, stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } });
      turnRunning = false;
      finishIfDone();
    }, 100);
    return;
  }

  if (mode === "malformed") {
    process.stdout.write("this is not json\n{broken\n");
  }

  // A signed-out CLI answers every prompt with this, verbatim: the login
  // instruction arrives as assistant text, and only the frame's own error
  // fields say it is a failure at all.
  if (mode === "not-logged-in") {
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
    // subagent narration — the driver must drop this, not render it
    out({
      type: "stream_event",
      parent_tool_use_id: "task-1",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "SUBAGENT NOISE" } },
    });
  }

  let replyParts = nextScriptedReply();
  const defaultToolId = `tu-${process.pid}-${++toolUseCount}`;
  // FAKE_CLAUDE_TURN_STATE: a counter file so "second turn" survives a
  // respawn between turns (the harness may relaunch the CLI legitimately)
  if (process.env.FAKE_CLAUDE_TURN_STATE) {
    let n = 0;
    try { n = Number(readFileSync(process.env.FAKE_CLAUDE_TURN_STATE, "utf8")) || 0; } catch {}
    turnsPlayed = n;
    writeFileSync(process.env.FAKE_CLAUDE_TURN_STATE, String(n + 1));
  }
  turnsPlayed += 1;
  if (process.env.FAKE_CLAUDE_COMPACT === "1" && turnsPlayed >= 2) {
    runHooks("PreCompact", { trigger: "auto" });
    const context = runHooks("SessionStart", { source: "compact" });
    if (context.trim()) replyParts = [`${context.trim()}\n\n${replyParts[0] ?? ""}`, ...replyParts.slice(1)];
  }
  const usage = { input_tokens: 10, cache_read_input_tokens: 2, output_tokens: 5 };
  if (scriptedToolCalls) {
    // scripted calls come first, each settled before the reply text
    for (const call of scriptedToolCalls) {
      const id = call.id ?? `tu-${process.pid}-${++toolUseCount}`;
      out({ type: "assistant", message: { content: [{ type: "tool_use", id, name: call.name, input: call.input }], usage } });
      out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: !call.ok, content: call.output }] } });
      runHooks("PostToolUse", { tool_name: call.name, tool_input: call.input, tool_response: call.output, tool_use_id: id });
    }
    for (const text of replyParts) out({ type: "assistant", message: { content: [{ type: "text", text }], usage } });
  } else {
    replyParts.forEach((text, index) => {
      const content: Array<
        { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
      > = [{ type: "text", text }];
      if (index === replyParts.length - 1) content.push({ type: "tool_use", id: defaultToolId, name: "Bash", input: { command: "echo hi" } });
      out({ type: "assistant", message: { content, usage } });
    });
    out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: defaultToolId, is_error: false, content: [{ type: "text", text: "hi" }] }] } });
    runHooks("PostToolUse", { tool_name: "Bash", tool_input: { command: "echo hi" }, tool_response: "hi", tool_use_id: defaultToolId });
  }

  // total_cost_usd is the process's running total (2.1.282: "read the latest
  // result rather than summing across results"); usage is this turn's own.
  const finish = () => {
    // anything steered in was taken in before this turn's result
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
  if (mode === "background-result") {
    // Claude can emit a synthetic result when a background task finishes.
    // It does not complete the user turn currently waiting on permission.
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
    // a gap a test can steer into; the closing reply carries anything that
    // was folded in, the way the real CLI includes a mid-turn message in
    // the same turn's next model call
    const finishSlowTurn = () => {
      if (process.env.FAKE_CLAUDE_SLOW_TAIL_TOOL) {
        // one more tool call before the reply: a fold seam the harness sees
        // AFTER a steer that this turn's stdin drain had already passed by
        const id = `tu-${process.pid}-${++toolUseCount}`;
        out({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Bash", input: { command: "echo tail" } }] } });
        out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: false, content: [{ type: "text", text: "tail" }] }] } });
      }
      const tail = steered.length ? ` + steered: ${steered.join(" | ")}` : "";
      replaySteered();
      out({ type: "assistant", message: { content: [{ type: "text", text: `reply to: ${promptText(prompt)}${tail}` }] } });
      finish();
    };
    // a late steer's turn holds on its own gate, so a test can look at the
    // harness while the CLI is still working on the words it steered
    const finishGate = lateContinuation ? process.env.FAKE_CLAUDE_LATE_STEER_GATE : process.env.FAKE_CLAUDE_SLOW_FINISH_GATE;
    if (finishGate) {
      const poll = setInterval(() => {
        if (!existsSync(finishGate)) return;
        clearInterval(poll);
        // The steer is already in our stdin pipe when the gate appears — the
        // server flushes it before answering the request that lets the test
        // drop the gate. But this is a timer, and timers run BEFORE the poll
        // phase that reads the pipe, so finishing here can close the turn
        // with the steer unread; it would then open a second turn. Hand off
        // to the check phase, which runs after the read.
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
      // folded into the running turn, unless it landed after that turn's
      // last model call — then the real CLI queues it for the next turn,
      // behind any queued message whose turn has not been announced yet
      if (process.env.FAKE_CLAUDE_LATE_STEER_GATE) lateSteers.push(prompt);
      else {
        steered.push(promptText(prompt));
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
