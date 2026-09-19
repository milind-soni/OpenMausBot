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
//   FAKE_CLAUDE_DUMP   path to write {argv, env, prompt, systemPrompt,
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
//   FAKE_CLAUDE_TEXT_DUMP like FAKE_CLAUDE_DUMP, but for one-shot text runs,
//                      so they never overwrite a turn's dump mid-test.
//   FAKE_CLAUDE_TEXT_HANG when set, the one-shot text mode never replies —
//                      the caller's abort signal is the only way it ends,
//                      which is exactly what its tests need to prove.
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
//   FAKE_CLAUDE_AUTH   in (default) | out | unsupported | malformed |
//                      inherited-api-key — what `auth status` reports
//   FAKE_CLAUDE_AUTO_UNAVAILABLE_MODELS comma-separated --model values for
//                      which `--permission-mode auto` starts in "default",
//                      the way the real CLI (2.1.266) does for Haiku 4.5 and
//                      Sonnet 4.5: init reports the mode it actually runs in.
//
// Keep this file dependency-free — it runs as a bare `node` subprocess.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { runRoomHandoffAgent } from "./room-handoff-agent.ts";

const mode = process.env.FAKE_CLAUDE_MODE ?? "happy";
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
if (argAfter("--output-format") === "text") {
  const prompt = await new Promise<string>((resolve) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => resolve(input));
  });
  const oneShotDump = process.env.FAKE_CLAUDE_TEXT_DUMP ?? process.env.FAKE_CLAUDE_DUMP;
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
  if (process.env.FAKE_CLAUDE_TEXT_FILE) {
    const file = process.env.FAKE_CLAUDE_TEXT_FILE;
    const reply = existsSync(file) ? readFileSync(file, "utf8") : "__FAIL__";
    if (reply.trim() === "__FAIL__") {
      process.stderr.write("fake one-shot text failed\n");
      process.exit(1);
    }
    process.stdout.write(reply);
    process.exit(0);
  }
  process.stdout.write("fake generated text\n");
  process.exit(0);
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
let dumped = false;
let turnRunning = false;
let steered: string[] = [];
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

const finishIfDone = () => {
  if (stdinEnded && !turnRunning) process.exit(0);
};

const playTurn = (prompt: JsonValue) => {
  turnRunning = true;
  steered = [];
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
      JSON.stringify({ pid: process.pid, argv, env: process.env, prompt, systemPrompt, mcpConfig, settings, settingsMode }, null, 2),
    );
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
    out({ type: "system", subtype: "init", session_id: sessionId, model, permissionMode });
    if (launched < quota) {
      if (process.env.FAKE_CLAUDE_PARTIAL_FAILS) {
        out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "half an answer" } } });
      }
      process.stderr.write("claude: API error (503): service temporarily unavailable\n");
      process.exit(5);
    }
  }

  // the real CLI re-announces init on every turn of a live process
  out({ type: "system", subtype: "init", session_id: sessionId, model, permissionMode });

  // The CLI accepted the resumed session — it read the prompt — and then
  // died with nothing to show. The prompt may already have run tools, so
  // the driver must NOT send it again.
  if (mode === "resume-dies-after-init" && argv.includes("--resume")) {
    process.stderr.write("fake-claude: simulated crash after accepting the resumed session\n");
    process.exit(3);
  }

  if (mode === "api-error") {
    const text = "API Error: 529 Overloaded. This is a server-side issue, usually temporary.";
    out({ type: "assistant", message: { model: "<synthetic>", content: [{ type: "text", text }] }, error: "unknown", is_api_error_message: true });
    out({ type: "result", is_error: true, stop_reason: "stop_sequence", terminal_reason: "api_error", result: text });
    turnRunning = false;
    finishIfDone();
    return;
  }

  if (process.env.FAKE_CLAUDE_ROOM_PLAN) {
    const progress = (text: string) => out({ type: "assistant", message: { content: [{ type: "text", text }] } });
    void runRoomHandoffAgent(argv, process.env.FAKE_CLAUDE_ROOM_PLAN, prompt, undefined, progress).then(text => {
      out({ type: "assistant", message: { content: [{ type: "text", text }] } });
      out({ type: "result", is_error: false, stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } });
    }).catch(error => {
      out({ type: "result", is_error: true, result: String(error), stop_reason: "error" });
    }).finally(() => { turnRunning = false; finishIfDone(); });
    return;
  }

  if (mode === "hang") {
    // stay alive until killed — lets tests exercise interrupt + the
    // permission broker while a turn is officially in flight
    setInterval(() => {}, 1_000);
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

  const finish = () => {
    runHooks("Stop", { stop_hook_active: false });
    out({ type: "result", is_error: false, stop_reason: "end_turn", total_cost_usd: 0.01, usage: { input_tokens: 10, cache_read_input_tokens: 2, output_tokens: 5 } });
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
      const tail = steered.length ? ` + steered: ${steered.join(" | ")}` : "";
      out({ type: "assistant", message: { content: [{ type: "text", text: `reply to: ${promptText(prompt)}${tail}` }] } });
      finish();
    };
    const finishGate = process.env.FAKE_CLAUDE_SLOW_FINISH_GATE;
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
    if (turnRunning) {
      steered.push(promptText(prompt));
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
