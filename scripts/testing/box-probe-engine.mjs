#!/usr/bin/env node
// A stand-in Claude Code CLI that RUNS the shell commands in its prompt, for proving the bot box on a real machine
// (_plans/team-mode-2026-10-21/T0-BUILD.md): the server starts it like the real CLI (stream-json both ways), and every
// prompt line that starts with `$ ` is run with /bin/sh inside whatever box the server put this process in. The reply is
// a JSON report of each command's exit code and output, so a test can read what the box let through. A line
// `@ <server> <tool> <json>` calls that tool of one of the turn's MCP servers instead, as a model's tool call would (a Team
// Cloud's per-member browser, _plans/team-mode-2026-10-21). Never shipped in an image; copied onto a test machine by hand.
// No model is called.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";

const argv = process.argv.slice(2);
const out = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);
const argAfter = (flag) => { const index = argv.indexOf(flag); return index >= 0 ? argv[index + 1] : undefined; };

if (argv[0] === "--version") { process.stdout.write("2.1.305 (Claude Code)\n"); process.exit(0); }
if (argv[0] === "--help") { process.stdout.write("Usage: claude [options]\n\nOptions:\n  --model <model>  Model\n  --autocompact <tokens>  Compaction window\n  -h, --help  Display help\n"); process.exit(0); }
if (argv[0] === "auth" && argv[1] === "status") { process.stdout.write(`${JSON.stringify({ loggedIn: true, authMethod: "api_key", apiProvider: "firstParty" })}\n`); process.exit(0); }
if (argv[0] === "update") { process.stdout.write("Claude Code is up to date.\n"); process.exit(0); }

const sessionId = argAfter("--resume") ?? argAfter("--session-id") ?? "probe-session";
const model = argAfter("--model") ?? "claude-probe";
const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0 };

function run(command) {
  const started = Date.now();
  const result = spawnSync("/bin/sh", ["-c", command], { encoding: "utf8", timeout: 30_000, env: process.env, maxBuffer: 4 * 1024 * 1024 });
  return {
    command, status: result.status, signal: result.signal ?? null, ms: Date.now() - started,
    stdout: (result.stdout ?? "").slice(0, 2000), stderr: (result.stderr ?? "").slice(0, 600),
  };
}

// One JSON-RPC request to a stdio MCP server, answered by the first line that carries its id.
const MCP_CALL = `
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

function callTool(line) {
  const started = Date.now();
  const [, server = "", tool = "", ...rest] = line.split(" ");
  let input = {};
  try { input = rest.length ? JSON.parse(rest.join(" ")) : {}; } catch (error) { return { command: line, status: 2, signal: null, ms: 0, stdout: "", stderr: `bad input: ${error.message}` }; }
  let config = null;
  try { config = JSON.parse(readFileSync(argAfter("--mcp-config") ?? "", "utf8")).mcpServers?.[server] ?? null; } catch {}
  if (!config?.command) return { command: line, status: 3, signal: null, ms: 0, stdout: "", stderr: `no ${server} MCP server in this turn` };
  const request = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: input } };
  const ran = spawnSync(process.execPath, ["-e", MCP_CALL, JSON.stringify({ command: config.command, args: config.args ?? [], env: config.env ?? {}, request })], { encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
  let reply = {};
  try { reply = JSON.parse(ran.stdout.trim().split("\n")[0] ?? ""); } catch { reply = { error: { message: ran.stderr || "no answer" } }; }
  const text = reply.error ? reply.error.message : (reply.result?.content ?? []).map((part) => part?.text ?? (part?.type === "image" ? "[image]" : JSON.stringify(part))).join("\n");
  return { command: line, status: reply.error || reply.result?.isError ? 1 : 0, signal: null, ms: Date.now() - started, stdout: String(text).slice(0, 4000), stderr: "" };
}

function report(prompt) {
  const lines = prompt.split("\n").map((line) => line.trim());
  const steps = lines.filter((line) => line.startsWith("$ ") || line.startsWith("@ "));
  const facts = { pid: process.pid, hostname: hostname(), cwd: process.cwd(), user: process.env.USER ?? null, envNames: Object.keys(process.env).sort(), proxy: process.env.HTTPS_PROXY ?? null };
  return { probe: "box-probe-engine", facts, results: steps.map((line) => (line.startsWith("@ ") ? callTool(line) : run(line.slice(2)))) };
}

// One-shot modes (titles, digests): answer at once.
if (["text", "json"].includes(argAfter("--output-format") ?? "") && !argv.includes("--input-format")) {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    if (argAfter("--output-format") === "json") out({ type: "result", is_error: false, result: "ok", session_id: sessionId, usage, total_cost_usd: 0 });
    else process.stdout.write("ok\n");
    process.exit(0);
  });
} else {
  let buffer = "";
  const turn = (prompt) => {
    out({ type: "system", subtype: "init", session_id: sessionId, model, permissionMode: argAfter("--permission-mode") ?? "default", tools: ["Bash"] });
    const text = typeof prompt?.message?.content === "string" ? prompt.message.content
      : Array.isArray(prompt?.message?.content) ? prompt.message.content.map((block) => block?.text ?? "").join("\n") : "";
    const answer = report(text);
    for (const [index, result] of answer.results.entries()) {
      const id = `probe-${index}`;
      const [, server, tool] = result.command.startsWith("@ ") ? result.command.split(" ") : [];
      out({ type: "assistant", message: { content: [{ type: "tool_use", id, name: tool ? `mcp__${server}__${tool}` : "Bash", input: tool ? {} : { command: result.command } }], usage } });
      out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: result.status !== 0, content: [{ type: "text", text: `exit ${result.status}\n${result.stdout}${result.stderr}` }] }] } });
    }
    out({ type: "assistant", message: { content: [{ type: "text", text: `BOX-PROBE-REPORT ${JSON.stringify(answer)}` }], usage } });
    out({ type: "result", is_error: false, stop_reason: "end_turn", session_id: sessionId, usage, total_cost_usd: 0 });
  };
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      try { turn(JSON.parse(line)); } catch (error) { process.stderr.write(`probe engine: ${error.message}\n`); }
    }
  });
  process.stdin.on("end", () => process.exit(0));
}
