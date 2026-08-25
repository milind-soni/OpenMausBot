#!/usr/bin/env node
// Fake of the Antigravity `agy` CLI's print-mode stdio surface, for driver
// tests of drivers/antigravity.ts. On `--version` it prints a version; on a
// print-mode invocation (`--print <prompt> … --output-format stream-json`) it
// reads the prompt from the `--print` ARGV value (the real CLI does NOT read a
// piped prompt in print mode), then emits a canned NDJSON turn: init → tool
// step (ACTIVE then DONE) → agent_response step with usage → result with
// status SUCCESS. Deterministic, no network.
//
// Keep this file dependency-free — it runs as a bare `node` subprocess.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
if (process.env.FAKE_AGY_IGNORE_SIGTERM === "1") {
  process.on("SIGTERM", () => {});
}
if (process.env.FAKE_AGY_READY_FILE) {
  writeFileSync(process.env.FAKE_AGY_READY_FILE, "ready");
}
if (process.env.FAKE_AGY_DUMP) {
  writeFileSync(process.env.FAKE_AGY_DUMP, JSON.stringify({ argv, env: process.env }, null, 2));
}
if (argv.includes("--version")) {
  console.log("1.1.12");
  process.exit(0);
}

const delayMs = Number(process.env.FAKE_AGY_DELAY_MS ?? 0);
if (Number.isFinite(delayMs) && delayMs > 0) {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}
if (process.env.FAKE_AGY_MCP_DUMP) {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  let config = "null";
  try {
    config = readFileSync(join(home, ".gemini", "config", "mcp_config.json"), "utf8");
  } catch {}
  writeFileSync(process.env.FAKE_AGY_MCP_DUMP, config);
}

const out = (obj: unknown) => process.stdout.write(JSON.stringify(obj) + "\n");
const CONV = "conv-fake-123";

// The prompt is the value that follows --print on argv (mirrors the driver,
// which no longer pipes stdin). A bare --print with no value yields no turn.
const printIdx = argv.indexOf("--print");
const prompt = printIdx !== -1 ? argv[printIdx + 1] : undefined;
if (!prompt) process.exit(0);

out({ event: "init", conversation_id: CONV, init: { cwd: process.cwd(), tools: ["run_command", "write_to_file"], permission_mode: "accept-edits" } });
out({ event: "step_update", conversation_id: CONV, step_update: { conversation_id: CONV, step_index: 0, state: "ACTIVE", step_type: "tool", tool_name: "write_to_file", tool_info: { name: "write_to_file", parameters: {} } } });
out({ event: "step_update", conversation_id: CONV, step_update: { conversation_id: CONV, step_index: 0, state: "DONE", step_type: "tool", tool_name: "write_to_file", tool_info: { name: "write_to_file", parameters: {} } } });
out({ event: "step_update", conversation_id: CONV, step_update: { conversation_id: CONV, step_index: 1, state: "DONE", step_type: "agent_response", usage: { input_tokens: 100, output_tokens: 20, thinking_tokens: 0, cache_read_tokens: 5, total_tokens: 125 } } });
out({ event: "result", conversation_id: CONV, result: { conversation_id: CONV, status: "SUCCESS", response: "done from fake agy", duration_seconds: 1, num_turns: 1, usage: { input_tokens: 100, output_tokens: 20, thinking_tokens: 0, cache_read_tokens: 5, total_tokens: 125 } } });
const postResultDelayMs = Number(process.env.FAKE_AGY_POST_RESULT_DELAY_MS ?? 0);
if (Number.isFinite(postResultDelayMs) && postResultDelayMs > 0) {
  await new Promise((resolve) => setTimeout(resolve, postResultDelayMs));
}
process.exit(0);
