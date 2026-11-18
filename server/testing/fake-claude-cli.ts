#!/usr/bin/env node
// Fake of the claude CLI's stream-json surface, for driver tests.
// Reads the prompt from stdin (one stream-json line), then plays a
// scripted session. Failure modes are toggled by env var, mirroring how
// the real thing misbehaves:
//
//   FAKE_CLAUDE_MODE   happy (default) | exit-early | hang | malformed
//                      | stream (partial-message text deltas before the
//                        whole-message frame, plus subagent noise to drop)
//   FAKE_CLAUDE_DUMP   path to write {argv, env, prompt} as JSON, so the
//                      test can assert on argv shape and env hygiene
//
// Keep this file dependency-free — it runs as a bare `node` subprocess.
import { writeFileSync } from "node:fs";

if (process.argv.includes("--version")) { process.stdout.write("fake-cli 1.0\n"); process.exit(0); }

const mode = process.env.FAKE_CLAUDE_MODE ?? "happy";

const argv = process.argv.slice(2);
const argAfter = (flag: string): string | null => {
  const i = argv.indexOf(flag);
  return i === -1 ? null : (argv[i + 1] ?? null);
};

const out = (obj: unknown) => process.stdout.write(JSON.stringify(obj) + "\n");

let stdin = "";
let started = false;
let inputBuffer = "";
process.stdin.on("data", (c) => {
  stdin += c;
  inputBuffer += c;
  let boundary;
  while ((boundary = inputBuffer.indexOf("\n")) !== -1) {
    const line = inputBuffer.slice(0, boundary);
    inputBuffer = inputBuffer.slice(boundary + 1);
    try {
      const message = JSON.parse(line);
      if (message.type === "user") {
        if (!started) { started = true; run(message); }
        else if (mode === "steer") {
          out({ type: "assistant", message: { content: [{ type: "text", text: "Before correction. " + message.message.content }] } });
          out({ type: "result", is_error: false });
        }
      }
      if (message.type === "control_request" && message.request?.subtype === "initialize") {
        const models = JSON.parse(process.env.FAKE_CLAUDE_MODELS ?? '[{"value":"default","displayName":"Default"},{"value":"sonnet","displayName":"Claude Sonnet"}]');
        out({ type: "control_response", response: { request_id: message.request_id, subtype: "success", response: { models } } });
      }
    } catch { /* ordinary streaming prompt */ }
  }
});
function run(firstPrompt: unknown) {
  let prompt: unknown = firstPrompt;
  try {
    prompt = JSON.parse(stdin.split("\n").find((l) => l.trim()) ?? "null");
  } catch {
    /* leave null — the test will see it */
  }

  if (process.env.FAKE_CLAUDE_DUMP) {
    writeFileSync(process.env.FAKE_CLAUDE_DUMP, JSON.stringify({ argv, env: process.env, prompt }, null, 2));
  }

  const sessionId = argAfter("--resume") ?? argAfter("--session-id") ?? "fake-session";
  const model = argAfter("--model") ?? "claude-fake";

  if (mode === "exit-early") {
    process.stderr.write("fake-claude: simulated crash before result\n");
    process.exit(3);
  }

  out({ type: "system", subtype: "init", session_id: sessionId, model });

  if (mode === "usage-limit") {
    out({ type: "rate_limit_event", rate_limit_info: { status: "rejected", errorCode: "credits_required" } });
    out({ type: "result", is_error: true, subtype: "error_during_execution", errors: ["Usage ran out"] });
    return;
  }

  if (mode === "steer") {
    out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Before correction. " } } });
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

  out({
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "hello from fake claude" },
        { type: "tool_use", id: "tu-1", name: "Bash" },
      ],
      usage: { input_tokens: 10, cache_read_input_tokens: 2, output_tokens: 5 },
    },
  });
  out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu-1", is_error: false }] } });
  out({ type: "result", is_error: false, stop_reason: "end_turn", total_cost_usd: 0.01 });
  process.exit(0);
}
