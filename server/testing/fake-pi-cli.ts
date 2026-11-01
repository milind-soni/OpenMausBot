#!/usr/bin/env node
// Fake of the pi coding agent's `--mode rpc --no-session` stdio surface for pi.ts tests. Env knobs:
//   FAKE_PI_MODE  happy (default) | tooluse | permission | interleave | question-select | question-input
//     | turn-error | no-models | exit-early | compaction | compaction-recovery
//     | compaction-recovery-upstream | prompt-reject | omp-chunk
//     | session-slow (answers new_session after FAKE_PI_SESSION_DELAY_MS, default 800, and dumps {sessionReplied})
//   FAKE_PI_MODELS  provider/model pairs (default "ollama-cloud/glm-5.2,openai/gpt-4o")
//   FAKE_PI_DUMP  path to append {argv, env} JSON to
//   FAKE_PI_STEER_REFUSE  answer a steer with an explicit success:false
//   FAKE_PI_STEER_OUT_OF_ORDER  hold the first steer until a second arrives, then refuse the first and accept the second

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

if (argv.includes("--version") || argv.includes("-v")) {
  process.stdout.write("pi 0.84.2 (fake)\n");
  process.exit(0);
}

if (process.env.FAKE_PI_DUMP) {
  try {
    // Read OMB_MCP_CONFIG now: the driver deletes the temp file when the turn settles.
    let mcpConfig: unknown = null;
    if (process.env.OMB_MCP_CONFIG) {
      try {
        mcpConfig = JSON.parse(readFileSync(process.env.OMB_MCP_CONFIG, "utf8"));
      } catch {}
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
  } catch {}
}

if (argv[0] === "update" && argv.includes("--models")) {
  process.exit(mode === "update-error" ? 1 : 0);
}

if (mode === "exit-early") {
  process.exit(1);
}

const send = (obj: any) => process.stdout.write(JSON.stringify(obj) + "\n");
// omp's RPC v2: the runtime announces v1 with a 1 MiB frame cap and stubs bigger responses unless the
// client negotiated protocol 2; v2 sends them as `rpc_chunk` frames to reassemble.
const ompChunkMode = mode === "omp-chunk";
let negotiatedV2 = false;
let chunkSeq = 0;
const sendChunked = (frame: any) => {
  const bytes = Buffer.from(JSON.stringify(frame), "utf8");
  const size = Math.ceil(bytes.length / 3);
  const count = Math.max(2, Math.ceil(bytes.length / size));
  const chunkId = `rpc-${++chunkSeq}`;
  for (let index = 0; index < count; index++) {
    send({
      type: "rpc_chunk",
      chunkId,
      index,
      count,
      byteLength: bytes.length,
      data: bytes.subarray(index * size, (index + 1) * size).toString("base64"),
    });
  }
};
if (ompChunkMode) {
  send({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 });
}
let sessionCounter = 0;
let currentSessionFile: string | null = null;
const heldSteerFrames: any[] = [];

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

// Un-negotiated, the v1 transport replaces each chunked frame with the `rpc_frame_error` stub.
const streamChunkedTurn = () => {
  for (const frame of [
    { type: "agent_start" },
    { type: "turn_start" },
    { type: "message_update", usage: { input: 0, output: 0 }, assistantMessageEvent: { type: "text_start", contentIndex: 0 } },
    { type: "message_update", usage: { input: 0, output: 0 }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hello" } },
    { type: "message_update", usage: { input: 0, output: 0 }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: " from" } },
    { type: "message_update", usage: { input: 0, output: 0 }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: " pi" } },
    { type: "turn_end", message: { stopReason: "end_turn", usage: { input: 12, output: 3 } }, usage: { input: 12, output: 3 } },
    { type: "agent_end" },
  ]) {
    if (negotiatedV2) sendChunked(frame);
    else send({ type: "rpc_frame_error", originalType: frame.type, error: "RPC frame exceeded the transport limit" });
  }
  setTimeout(() => process.exit(0), 50);
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

const streamCompactionTurn = () => {
  send({ type: "agent_start" });
  send({ type: "turn_start" });
  send({ type: "compaction_start", reason: "threshold" });
  send({ type: "compaction_end", reason: "threshold", result: undefined, aborted: false, willRetry: false });
  send({ type: "message_update", usage: { input: 0, output: 0 }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "compacted" } });
  send({ type: "turn_end", message: { stopReason: "end_turn", usage: { input: 12, output: 3 } }, usage: { input: 12, output: 3 } });
  send({ type: "agent_end" });
};

// Post-run overflow recovery: turn_end and a non-terminal agent_end, compaction, one more turn, then the terminal agent_end.
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

// The same in upstream pi's dialect: willRetry instead of isTerminal, closing with agent_settled.
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

const streamToolTurn = () => {
  send({ type: "agent_start" });
  send({ type: "turn_start" });
  send({ type: "tool_execution_start", toolCallId: "call_1", toolName: "bash", args: { command: "echo hi", password: "pi-input-secret" } });
  send({ type: "tool_execution_end", toolCallId: "call_1", toolName: "bash", isError: false, result: { content: [{ type: "text", text: "hi" }], api_key: "pi-output-secret" } });
  send({ type: "turn_end", message: { stopReason: "toolUse", usage: { input: 5, output: 1 } }, usage: { input: 5, output: 1 } });
  send({ type: "turn_start" });
  send({ type: "message_update", usage: { input: 0, output: 0 }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "done" } });
  send({ type: "turn_end", message: { stopReason: "end_turn", usage: { input: 12, output: 2 } }, usage: { input: 12, output: 2 } });
  send({ type: "agent_end" });
};

const streamPermissionTurn = () => {
  send({ type: "agent_start" });
  send({ type: "turn_start" });
  send({ type: "extension_ui_request", id: "ask-1", method: "select", title: "Run bash: echo hi?", options: ["Allow once", "Deny"] });
};

const streamQuestionSelectTurn = () => {
  send({ type: "agent_start" });
  send({ type: "turn_start" });
  send({ type: "extension_ui_request", id: "ask-select", method: "select", title: "Which color?",
    options: process.env.FAKE_PI_QUESTION_OPTIONS ? JSON.parse(process.env.FAKE_PI_QUESTION_OPTIONS) : ["Blue", "Green"] });
};

const streamQuestionInputTurn = () => {
  send({ type: "agent_start" });
  send({ type: "turn_start" });
  send({ type: "extension_ui_request", id: "ask-input", method: "input", title: "Which city?" });
};

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
    case "negotiate_protocol":
      // Vanilla pi 1.0.2 refuses the unknown command and keeps working.
      if (!ompChunkMode) {
        send({ id: cmd.id, type: "response", command: "negotiate_protocol", success: false, error: "Unknown command: negotiate_protocol" });
        return;
      }
      if (cmd.protocolVersion === 2) {
        negotiatedV2 = true;
        send({ type: "response", command: "negotiate_protocol", success: true, data: { protocolVersion: 2 } });
      } else {
        send({ type: "response", command: "negotiate_protocol", success: false, error: "fake pi: only protocol version 2 is supported" });
      }
      return;
    case "get_available_models": {
      const response = {
        type: "response",
        command: "get_available_models",
        success: true,
        data: { models: mode === "no-models" ? [] : modelPairs },
      };
      if (ompChunkMode && !negotiatedV2) {
        send({ type: "response", command: "get_available_models", success: false, error: "RPC response exceeded the transport limit" });
        return;
      }
      if (ompChunkMode) sendChunked(response);
      else send(response);
      return;
    }
    case "get_state":
      send({ type: "response", command: "get_state", success: true, data: {
        model: null, thinkingLevel: "off", isStreaming: false, isCompacting: false,
        steeringMode: "one-at-a-time", followUpMode: "one-at-a-time", sessionFile: currentSessionFile,
        sessionId: `s-${sessionCounter}`, autoCompactionEnabled: true, messageCount: 0, pendingMessageCount: 0,
      } });
      return;
    case "new_session":
      if (mode === "session-error") {
        send({ type: "response", command: "new_session", success: false, error: "fake pi: session unavailable" });
        return;
      }
      sessionCounter += 1;
      currentSessionFile = `/fake/pi-session-${sessionCounter}.json`;
      const sessionReply = { type: "response", command: "new_session", success: true, data: { sessionId: `s-${sessionCounter}`, sessionFile: currentSessionFile } };
      if (mode !== "session-slow") {
        send(sessionReply);
        return;
      }
      setTimeout(() => {
        if (process.env.FAKE_PI_DUMP) appendFileSync(process.env.FAKE_PI_DUMP, JSON.stringify({ sessionReplied: true }) + "\n");
        send(sessionReply);
      }, Number(process.env.FAKE_PI_SESSION_DELAY_MS ?? 800));
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
        } catch {}
      }
      send({ type: "response", command: "set_model", success: true, data: { id: cmd.modelId, provider: cmd.provider } });
      return;
    }
    case "set_thinking_level":
      if (process.env.FAKE_PI_DUMP) {
        try {
          appendFileSync(process.env.FAKE_PI_DUMP, JSON.stringify({ thinkingLevel: cmd.level }) + "\n");
        } catch {}
      }
      send({ type: "response", command: "set_thinking_level", success: true });
      return;
    case "prompt":
      if (mode === "prompt-reject") {
        // pi rejects a prompt submitted while a compaction runs.
        send({ type: "response", command: "prompt", success: false, error: "fake pi: compaction in progress" });
        return;
      }
      if (process.env.FAKE_PI_DUMP) {
        try {
          appendFileSync(
            process.env.FAKE_PI_DUMP,
            JSON.stringify({ prompt: { message: cmd.message, ...(Array.isArray(cmd.images) ? { images: cmd.images } : {}) } }) + "\n",
          );
        } catch {}
      }
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
      else if (mode === "omp-chunk") streamChunkedTurn();
      else streamTurn();
      return;
    case "steer": {
      if (process.env.FAKE_PI_DUMP) {
        try {
          appendFileSync(process.env.FAKE_PI_DUMP, JSON.stringify({ steer: { id: cmd.id, message: cmd.message } }) + "\n");
        } catch {}
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
        } catch {}
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
