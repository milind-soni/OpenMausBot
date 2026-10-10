#!/usr/bin/env node
// Fake of the Antigravity `agy` CLI's print-mode stdio surface, for driver
// tests of drivers/antigravity.ts. On `--version` it prints a version; in
// stream-json input mode it reads one user event from stdin, then emits a
// canned NDJSON turn: init → tool
// step (ACTIVE then DONE) → agent_response step with usage → result with
// status SUCCESS. Deterministic, no network.
//
//   FAKE_AGY_MODE=ask-peer
//     reads OpenMausBot's temporary `openmausbot-agents` entry from agy's
//     global MCP config, calls list_bots then ask_bot, and returns the peer's
//     real reply. This pins the Antigravity/Gemini comms path end to end.
//
// Keep this file dependency-free — it runs as a bare `node` subprocess.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const mode = process.env.FAKE_AGY_MODE ?? "happy";

type McpEntry = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

function agentsMcpEntry(): McpEntry | null {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  try {
    const config = JSON.parse(
      readFileSync(join(home, ".gemini", "config", "mcp_config.json"), "utf8"),
    );
    const entry = config.mcpServers?.["openmausbot-agents"];
    if (!entry?.command) return null;
    return {
      command: String(entry.command),
      args: Array.isArray(entry.args) ? entry.args.map(String) : [],
      env: Object.fromEntries(
        Object.entries(entry.env ?? {}).map(([name, value]) => [name, String(value)]),
      ),
    };
  } catch {
    return null;
  }
}

/** Minimal MCP stdio client matching the real config shape used by agy. */
function driveMcp(
  entry: McpEntry,
  calls: Array<{ name: string; args: (previous: string) => object }>,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...entry.env };
    const child = spawn(entry.command, entry.args ?? [], {
      env,
      stdio: ["pipe", "pipe", "inherit"],
    });
    let settled = false;
    let step = -1; // -1 = initialize in flight
    let last = "";

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (error) reject(error);
      else resolve(last);
    };
    const timer = setTimeout(() => finish(new Error("mcp timeout")), 60_000);
    const write = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const next = () => {
      step += 1;
      if (step >= calls.length) return finish();
      const call = calls[step];
      write({
        jsonrpc: "2.0",
        id: step + 2,
        method: "tools/call",
        params: { name: call.name, arguments: call.args(last) },
      });
    };

    child.on("error", (error) => finish(error));
    child.on("exit", (code) => {
      if (!settled) finish(new Error(`mcp exited before completing (code ${code ?? "unknown"})`));
    });
    child.stdin.on("error", (error) => finish(error));
    let buffer = "";
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        let message: any;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id === undefined) continue;
        if (message.error) {
          finish(new Error(String(message.error.message ?? "MCP call failed")));
          return;
        }
        if (step === -1) {
          write({ jsonrpc: "2.0", method: "notifications/initialized" });
          next();
          continue;
        }
        last = String(message.result?.content?.[0]?.text ?? "");
        next();
      }
    });
    write({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "openmausbot-fake-antigravity", version: "1.0.0" },
      },
    });
  });
}

const argv = process.argv.slice(2);
if (process.env.FAKE_AGY_IGNORE_SIGTERM === "1") {
  process.on("SIGTERM", () => {});
}
if (process.env.FAKE_AGY_DUMP) {
  writeFileSync(process.env.FAKE_AGY_DUMP, JSON.stringify({ argv, env: process.env }, null, 2));
}
if (argv.includes("--version")) {
  console.log(process.env.FAKE_AGY_VERSION ?? "1.1.22");
  process.exit(0);
}
if (process.env.FAKE_AGY_READY_FILE) {
  writeFileSync(process.env.FAKE_AGY_READY_FILE, "ready");
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

const streamInput = argv[argv.indexOf("--input-format") + 1] === "stream-json";
let prompt: string | undefined;
if (streamInput) {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) input += chunk;
  const line = input.split("\n").find((candidate) => candidate.trim());
  try {
    const message = line ? JSON.parse(line) : null;
    const content = message?.event === "user" ? message.message?.content : undefined;
    prompt = typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.filter((block) => block?.type === "text").map((block) => block.text).join("")
        : undefined;
  } catch {}
} else {
  // Retained for tests of old callers; production prompt paths use stdin.
  const printIdx = Math.max(argv.indexOf("--print"), argv.indexOf("-p"));
  prompt = printIdx !== -1 ? argv[printIdx + 1] : undefined;
}
if (!prompt) process.exit(0);
if (process.env.FAKE_AGY_DUMP) {
  writeFileSync(process.env.FAKE_AGY_DUMP, JSON.stringify({ argv, env: process.env, prompt }, null, 2));
}

const toolName = mode === "ask-peer" ? "ask_bot" : "write_to_file";
out({ event: "init", conversation_id: CONV, init: { cwd: process.cwd(), tools: ["run_command", "write_to_file", ...(mode === "ask-peer" ? ["list_bots", "ask_bot"] : [])], permission_mode: "accept-edits" } });
out({ event: "step_update", conversation_id: CONV, step_update: { conversation_id: CONV, step_index: 0, state: "ACTIVE", step_type: "tool", tool_name: toolName, tool_info: { name: toolName, parameters: {} } } });

let response = "done from fake agy";
if (mode === "ask-peer") {
  const agents = agentsMcpEntry();
  if (!agents) {
    response = "peer error: agents MCP not mounted";
  } else {
    try {
      const reply = await driveMcp(agents, [
        { name: "list_bots", args: () => ({}) },
        {
          name: "ask_bot",
          args: (list) => ({
            bot_id: /id: ([\w-]+)/.exec(list)?.[1] ?? "",
            message: "ping from fake Gemini",
          }),
        },
      ]);
      response = `peer says: ${reply}`;
    } catch (error) {
      response = `peer error: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
}

out({ event: "step_update", conversation_id: CONV, step_update: { conversation_id: CONV, step_index: 0, state: "DONE", step_type: "tool", tool_name: toolName, tool_info: { name: toolName, parameters: {} } } });
out({ event: "step_update", conversation_id: CONV, step_update: { conversation_id: CONV, step_index: 1, state: "DONE", step_type: "agent_response", usage: { input_tokens: 100, output_tokens: 20, thinking_tokens: 0, cache_read_tokens: 5, total_tokens: 125 } } });
out({ event: "result", conversation_id: CONV, result: { conversation_id: CONV, status: "SUCCESS", response, duration_seconds: 1, num_turns: 1, usage: { input_tokens: 100, output_tokens: 20, thinking_tokens: 0, cache_read_tokens: 5, total_tokens: 125 } } });
const postResultDelayMs = Number(process.env.FAKE_AGY_POST_RESULT_DELAY_MS ?? 0);
if (Number.isFinite(postResultDelayMs) && postResultDelayMs > 0) {
  await new Promise((resolve) => setTimeout(resolve, postResultDelayMs));
}
process.exit(0);
