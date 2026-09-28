#!/usr/bin/env node
// Fake of the pi coding agent's `--mode rpc --no-session` stdio surface, for
// driver contract tests of server/drivers/pi.ts. Speaks pi's JSON-RPC-over-
// stdio protocol: answers get_available_models / new_session / switch_session
// / set_model / steer, and streams a scripted turn in response to `prompt`. Failure
// modes mirror how the real CLI misbehaves:
//
//   FAKE_PI_MODE   happy (default) | tooluse | permission | interleave | question-select | question-input
//                  | turn-error | no-models | exit-early | compaction | compaction-recovery
//                  | compaction-recovery-upstream | prompt-reject
//   FAKE_PI_MODELS comma-separated provider/model pairs (default "ollama-cloud/glm-5.2,openai/gpt-4o")
//   FAKE_PI_DUMP   path to append {argv, env} JSON, so a test can assert argv shape
//                  and env hygiene (no leaked secrets into the pi child).
//   FAKE_PI_STEER_REFUSE script an explicit success:false steer refusal
//   FAKE_PI_STEER_OUT_OF_ORDER hold the first steer's refusal until a second
//                  frame arrives, then answer refusal-for-first / success-for-second

import { appendFileSync, readFileSync } from "node:fs";

const mode = process.env.FAKE_PI_MODE ?? "happy";
const modelPairs = (process.env.FAKE_PI_MODELS ?? "ollama-cloud/glm-5.2,openai/gpt-4o")
  .split(",")
  .filter(Boolean)
  .map((pair) => {
    const [provider, id] = pair.split("/");
    return { provider: provider ?? "x", id: id ?? "m", name: id ?? "m" };
  });

const argv = process.argv.slice(2);

// The driver probes `<cli> --version` for snapshot(); answer and exit clean.
if (argv.includes("--version") || argv.includes("-v")) {
  process.stdout.write("pi 0.84.2 (fake)\n");
  process.exit(0);
}

if (process.env.FAKE_PI_DUMP) {
  try {
    // When the driver mounts integrations it hands the MCP config through
    // OMB_MCP_CONFIG; read it here so a test can assert the mount contract
    // (servers, proxy wrap, credential hygiene) without racing the temp file
    // cleanup the driver runs at turn settle.
    let mcpConfig: unknown = null;
    if (process.env.OMB_MCP_CONFIG) {
      try {
        mcpConfig = JSON.parse(readFileSync(process.env.OMB_MCP_CONFIG, "utf8"));
      } catch {
        /* unreadable config dumps as null */
      }
    }
    appendFileSync(
      process.env.FAKE_PI_DUMP,
      JSON.stringify({
        argv,
        envConfigured: ["PATH", "HOME", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "XAI_API_KEY", "BOX_TOKEN"].filter(
          (k) => process.env[k] !== undefined,
        ),
        mcpConfig,
      }) + "\n",
    );
  } catch {
    /* never let dumping break a run */
  }
}

// Explicit model refresh is a short-lived command, separate from RPC mode.
if (argv[0] === "update" && argv.includes("--models")) {
  process.exit(mode === "update-error" ? 1 : 0);
}

// exit-early: die before saying anything — a failed spawn surfaces as a
// runtime.error + failed turn, never a hang.
if (mode === "exit-early") {
  process.exit(1);
}

const send = (obj: any) => process.stdout.write(JSON.stringify(obj) + "\n");
let sessionCounter = 0;
let currentSessionFile: string | null = null;
// FAKE_PI_STEER_OUT_OF_ORDER parks the first steer frame until a second one
// arrives, so a test can force both waiters to exist before any response.
const heldSteerFrames: any[] = [];

// A faithful happy turn: a couple of text deltas then a terminal turn_end.
const streamTurn = () => {
  send({ type: "agent_start" });
  send({ type: "turn_start" });
  send({ type: "message_update", usage: { input: 0, output: 0 }, assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
  for (const delta of ["Hello", " from", " pi"]) {
    send({ type: "message_update", usage: { input: 0, output: 0 }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta } });
  }
  send({ type: "turn_end", message: { stopReason: "end_turn", usage: { input: 12, output: 3 } }, usage: { input: 12, output: 3 } });
  send({ type: "agent_end" });
};

const streamErrorTurn = () => {
  send({ type: "agent_start" });
  send({ type: "turn_start" });
  send({
    type: "turn_end",
    message: {
      stopReason: "error",
      errorMessage: "Invalid schema for function 'computer_browser_prepare'",
      usage: { input: 0, output: 0 },
    },
    usage: { input: 0, output: 0 },
  });
  send({ type: "agent_end" });
};

// compaction: a happy turn whose context crosses the auto-compaction
// threshold mid-run - compaction_start/end fire after the prompt ack and
// before turn_end, the exact moment a receipt-based prompt split must
// notice its delivery being summarized away.
const streamCompactionTurn = () => {
  send({ type: "agent_start" });
  send({ type: "turn_start" });
  send({ type: "compaction_start", reason: "threshold" });
  send({ type: "compaction_end", reason: "threshold", result: undefined, aborted: false, willRetry: false });
  send({ type: "message_update", usage: { input: 0, output: 0 }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "compacted" } });
  send({ type: "turn_end", message: { stopReason: "end_turn", usage: { input: 12, output: 3 } }, usage: { input: 12, output: 3 } });
  send({ type: "agent_end" });
};

// compaction-recovery: post-run overflow recovery — the run "ends"
// (turn_end + a non-terminal agent_end), then compaction summarises the
// session and the run resumes for one more turn before the terminal
// agent_end. The second half is delayed so it lands after the first
// agent_end, exactly the sequence a driver must not treat as finished at
// turn_end: killing the child there would silence the late compaction
// events that invalidate the prompt-split receipt.
const streamCompactionRecoveryTurn = () => {
  send({ type: "agent_start" });
  send({ type: "turn_start" });
  send({ type: "message_update", usage: { input: 0, output: 0 }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "recovered" } });
  send({ type: "turn_end", message: { stopReason: "end_turn", usage: { input: 12, output: 3 } }, usage: { input: 12, output: 3 } });
  send({ type: "agent_end", isTerminal: false });
  setTimeout(() => {
    send({ type: "compaction_start", reason: "overflow" });
    send({ type: "compaction_end", reason: "overflow", result: undefined, aborted: false, willRetry: false });
    send({ type: "agent_start" });
    send({ type: "turn_start" });
    send({ type: "message_update", usage: { input: 0, output: 0 }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "ok" } });
    send({ type: "turn_end", message: { stopReason: "end_turn", usage: { input: 4, output: 1 } }, usage: { input: 4, output: 1 } });
    send({ type: "agent_end", isTerminal: true });
  }, 30);
};

// compaction-recovery-upstream: the same post-run overflow recovery in
// upstream pi's dialect — agent_end frames carry willRetry instead of
// isTerminal, and the run closes with agent_settled after the final
// agent_end.
const streamCompactionRecoveryUpstreamTurn = () => {
  send({ type: "agent_start" });
  send({ type: "turn_start" });
  send({ type: "message_update", usage: { input: 0, output: 0 }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "recovered" } });
  send({ type: "turn_end", message: { stopReason: "end_turn", usage: { input: 12, output: 3 } }, usage: { input: 12, output: 3 } });
  send({ type: "agent_end", willRetry: true });
  setTimeout(() => {
    send({ type: "compaction_start", reason: "overflow" });
    send({ type: "compaction_end", reason: "overflow", result: undefined, aborted: false, willRetry: true });
    send({ type: "agent_start" });
    send({ type: "turn_start" });
    send({ type: "message_update", usage: { input: 0, output: 0 }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "ok" } });
    send({ type: "turn_end", message: { stopReason: "end_turn", usage: { input: 4, output: 1 } }, usage: { input: 4, output: 1 } });
    send({ type: "agent_end", willRetry: false });
    send({ type: "agent_settled" });
  }, 30);
};

// tooluse: one tool turn (stopReason toolUse, pi auto-continues) then a text
// turn — exactly the sequence that broke the settle-on-toolUse bug.
const streamToolTurn = () => {
  send({ type: "agent_start" });
  send({ type: "turn_start" });
  send({ type: "tool_execution_start", toolCallId: "call_1", toolName: "bash", args: { command: "echo hi", password: "pi-input-secret" } });
  send({ type: "tool_execution_end", toolCallId: "call_1", toolName: "bash", isError: false, result: { content: [{ type: "text", text: "hi" }], api_key: "pi-output-secret" } });
  send({ type: "turn_end", message: { stopReason: "toolUse", usage: { input: 5, output: 1 } }, usage: { input: 5, output: 1 } });
  // pi auto-continues within the same prompt to synthesize the reply
  send({ type: "turn_start" });
  send({ type: "message_update", usage: { input: 0, output: 0 }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "done" } });
  send({ type: "turn_end", message: { stopReason: "end_turn", usage: { input: 12, output: 2 } }, usage: { input: 12, output: 2 } });
  send({ type: "agent_end" });
};

// permission: open a select ask, hold the turn until extension_ui_response
// arrives, then stream the reply.
const streamPermissionTurn = () => {
  send({ type: "agent_start" });
  send({ type: "turn_start" });
  send({ type: "extension_ui_request", id: "ask-1", method: "select", title: "Run bash: echo hi?", options: ["Allow once", "Deny"] });
  // wait for the answer before finishing
};

// question-select: a select ask that is genuinely a question — named
// options the driver must surface as choices + a structured question.
const streamQuestionSelectTurn = () => {
  send({ type: "agent_start" });
  send({ type: "turn_start" });
  send({ type: "extension_ui_request", id: "ask-select", method: "select", title: "Which color?",
    options: process.env.FAKE_PI_QUESTION_OPTIONS ? JSON.parse(process.env.FAKE_PI_QUESTION_OPTIONS) : ["Blue", "Green"] });
  // wait for the answer before finishing
};

// question-input: a free-text ask — no options, the typed answer returns
// verbatim.
const streamQuestionInputTurn = () => {
  send({ type: "agent_start" });
  send({ type: "turn_start" });
  send({ type: "extension_ui_request", id: "ask-input", method: "input", title: "Which city?" });
  // wait for the answer before finishing
};

/** Scripted text → tool → text → tool → text turn for order-contract tests. */
const streamInterleaveTurn = () => {
  send({ type: "agent_start" });
  send({ type: "turn_start" });
  send({ type: "message_update", usage: { input: 0, output: 0 }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "before one" } });
  send({ type: "tool_execution_start", toolCallId: "call_1", toolName: "bash", args: { command: "echo one" } });
  send({ type: "tool_execution_end", toolCallId: "call_1", toolName: "bash", isError: false });
  send({ type: "message_update", usage: { input: 0, output: 0 }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "before two" } });
  send({ type: "tool_execution_start", toolCallId: "call_2", toolName: "bash", args: { command: "echo two" } });
  send({ type: "tool_execution_end", toolCallId: "call_2", toolName: "bash", isError: false });
  send({ type: "message_update", usage: { input: 0, output: 0 }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "after" } });
  send({ type: "turn_end", message: { stopReason: "end_turn", usage: { input: 12, output: 3 } }, usage: { input: 12, output: 3 } });
  send({ type: "agent_end" });
};

const finishPermissionTurn = () => {
  send({ type: "tool_execution_start", toolCallId: "call_1", toolName: "bash", args: { command: "echo hi" } });
  send({ type: "tool_execution_end", toolCallId: "call_1", toolName: "bash", isError: false });
  send({ type: "message_update", usage: { input: 0, output: 0 }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "ok" } });
  send({ type: "turn_end", message: { stopReason: "end_turn", usage: { input: 8, output: 1 } }, usage: { input: 8, output: 1 } });
  send({ type: "agent_end" });
};

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let cmd;
    try {
      cmd = JSON.parse(line);
    } catch {
      continue;
    }
    handle(cmd);
  }
});
process.stdin.on("end", () => process.exit(0));

function handle(cmd: any) {
  switch (cmd.type) {
    case "get_available_models":
      send({
        type: "response",
        command: "get_available_models",
        success: true,
        data: { models: mode === "no-models" ? [] : modelPairs },
      });
      return;
    case "new_session":
      if (mode === "session-error") {
        send({ type: "response", command: "new_session", success: false, error: "fake pi: session unavailable" });
        return;
      }
      sessionCounter += 1;
      currentSessionFile = `/fake/pi-session-${sessionCounter}.json`;
      send({ type: "response", command: "new_session", success: true, data: { sessionId: `s-${sessionCounter}`, sessionFile: currentSessionFile } });
      return;
    case "switch_session":
      if (mode === "session-error") {
        send({ type: "response", command: "switch_session", success: false, error: "fake pi: session unavailable" });
        return;
      }
      currentSessionFile = cmd.sessionPath ?? currentSessionFile;
      send({ type: "response", command: "switch_session", success: true, data: { sessionId: "s-resumed", sessionFile: currentSessionFile } });
      return;
    case "set_model": {
      if (process.env.FAKE_PI_DUMP) {
        try {
          appendFileSync(process.env.FAKE_PI_DUMP, JSON.stringify({ setModel: { provider: cmd.provider, modelId: cmd.modelId } }) + "\n");
        } catch {
          /* never let dumping break a run */
        }
      }
      send({ type: "response", command: "set_model", success: true, data: { id: cmd.modelId, provider: cmd.provider } });
      return;
    }
    case "set_thinking_level":
      // record the level so a test can assert what the driver pinned
      if (process.env.FAKE_PI_DUMP) {
        try {
          appendFileSync(process.env.FAKE_PI_DUMP, JSON.stringify({ thinkingLevel: cmd.level }) + "\n");
        } catch {
          /* never let dumping break a run */
        }
      }
      send({ type: "response", command: "set_thinking_level", success: true });
      return;
    case "prompt":
      if (mode === "prompt-reject") {
        // mirrors pi rejecting a prompt submitted while a compaction runs
        send({ type: "response", command: "prompt", success: false, error: "fake pi: compaction in progress" });
        return;
      }
      if (process.env.FAKE_PI_DUMP) {
        try {
          appendFileSync(
            process.env.FAKE_PI_DUMP,
            JSON.stringify({ prompt: { message: cmd.message, ...(Array.isArray(cmd.images) ? { images: cmd.images } : {}) } }) + "\n",
          );
        } catch {
          /* never let dumping break a run */
        }
      }
      // acknowledge acceptance; the completion comes via events
      send({ type: "response", command: "prompt", success: true });
      if (mode === "tooluse") streamToolTurn();
      else if (mode === "permission") streamPermissionTurn();
      else if (mode === "question-select") streamQuestionSelectTurn();
      else if (mode === "question-input") streamQuestionInputTurn();
      else if (mode === "interleave") streamInterleaveTurn();
      else if (mode === "turn-error") streamErrorTurn();
      else if (mode === "compaction") streamCompactionTurn();
      else if (mode === "compaction-recovery") streamCompactionRecoveryTurn();
      else if (mode === "compaction-recovery-upstream") streamCompactionRecoveryUpstreamTurn();
      else streamTurn();
      return;
    case "steer": {
      // Mid-turn input frame: ack like the real runtime (success only after
      // session.steer accepted it), echoing the frame's correlation id the
      // way the real RPC runtime does. FAKE_PI_STEER_REFUSE scripts an
      // explicit success:false refusal so the driver's tri-state mapping is
      // testable.
      if (process.env.FAKE_PI_DUMP) {
        try {
          appendFileSync(process.env.FAKE_PI_DUMP, JSON.stringify({ steer: { id: cmd.id, message: cmd.message } }) + "\n");
        } catch {
          /* never let dumping break a run */
        }
      }
      const steerAck = (frame: any, success: boolean) =>
        send({
          type: "response",
          command: "steer",
          ...(frame.id !== undefined ? { id: frame.id } : {}),
          ...(success ? { success: true } : { success: false, error: "fake pi: nothing to steer" }),
        });
      if (process.env.FAKE_PI_STEER_OUT_OF_ORDER) {
        if (heldSteerFrames.length === 0) {
          heldSteerFrames.push(cmd);
          return;
        }
        // Both frames are now in flight: answer the FIRST with an explicit
        // refusal and the SECOND with success, in that order, so a driver
        // that keys waiters by command name alone hands the refusal to the
        // wrong caller.
        steerAck(heldSteerFrames[0], false);
        steerAck(cmd, true);
        heldSteerFrames.length = 0;
        return;
      }
      steerAck(cmd, !process.env.FAKE_PI_STEER_REFUSE);
      return;
    }
    case "extension_ui_response":
      if (process.env.FAKE_PI_DUMP) {
        try {
          appendFileSync(process.env.FAKE_PI_DUMP, JSON.stringify({ uiResponse: cmd }) + "\n");
        } catch {
          /* never let dumping break a run */
        }
      }
      if (cmd.id === "ask-1") finishPermissionTurn();
      else if (cmd.id === "ask-select" || cmd.id === "ask-input") finishPermissionTurn();
      return;
    case "abort":
      send({ type: "turn_end", message: { stopReason: "cancelled", usage: { input: 0, output: 0 } }, usage: { input: 0, output: 0 } });
      return;
    default:
      return;
  }
}
