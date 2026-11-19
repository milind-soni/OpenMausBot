#!/usr/bin/env node
// Fake of the codex CLI's `app-server` JSON-RPC surface, for driver
// tests. Speaks newline-delimited JSON-RPC on stdio: answers the
// initialize/thread/turn handshake, then plays a scripted turn. Like the
// real app-server, it never exits on its own — the driver kills it.
//
//   FAKE_CODEX_MODE   happy (default) | approval | mcp-approval | resume | stream
//   FAKE_CODEX_DUMP   path to write {argv, env, calls, decision} as JSON
//   FAKE_CODEX_MCP_SERVER  serverName for mcp-approval (default gbs_agents)
//
// Keep this file dependency-free — it runs as a bare `node` subprocess.
import { readFileSync, writeFileSync } from "node:fs";

if (process.argv.includes("--version")) { process.stdout.write("fake-cli 1.0\n"); process.exit(0); }

const mode = process.env.FAKE_CODEX_MODE ?? "happy";
const calls: Array<{ method: string; params: unknown }> = [];
let decision: unknown = null;

const out = (obj: unknown) => process.stdout.write(JSON.stringify(obj) + "\n");
const notify = (method: string, params: unknown) => out({ jsonrpc: "2.0", method, params });

const dump = () => {
  if (process.env.FAKE_CODEX_DUMP) {
    writeFileSync(
      process.env.FAKE_CODEX_DUMP,
      JSON.stringify({ argv: process.argv.slice(2), env: process.env, calls, decision }, null, 2),
    );
  }
};

const finishTurn = () => {
  if (mode === "usage-limit" || mode === "steer-usage") {
    notify("account/rateLimits/updated", { rateLimits: { limitId: "codex", primary: { usedPercent: 100, resetsAt: 4102444800, windowDurationMins: 300 } } });
    notify("error", { error: { message: "Usage is used up", codexErrorInfo: "usageLimitExceeded" }, willRetry: false });
    dump();
    notify("turn/completed", { turn: { status: "failed", error: { message: "Usage is used up", codexErrorInfo: "usageLimitExceeded" } } });
    return;
  }
  notify("item/completed", { item: { id: "i1", type: "commandExecution", status: "completed" } });
  if (mode === "stream") {
    // token deltas, then the whole message — the driver must not double-emit
    notify("item/agentMessage/delta", { itemId: "m1", delta: "done from " });
    notify("item/agentMessage/delta", { itemId: "m1", delta: "fake codex" });
  }
  notify("item/completed", { item: { id: "m1", type: "agentMessage", text: "done from fake codex" } });
  notify("thread/tokenUsage/updated", { tokenUsage: { total: { inputTokens: 7, outputTokens: 3 } } });
  dump();
  notify("turn/completed", { turn: { status: "completed" } });
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

    // response to our own server->client request (approval decision)
    if (msg.id === 100 && (msg.result !== undefined || msg.error !== undefined)) {
      decision = msg.result ?? { error: msg.error };
      finishTurn();
      continue;
    }

    if (msg.method) calls.push({ method: msg.method, params: msg.params ?? null });

    switch (msg.method) {
      case "initialize":
        out({ jsonrpc: "2.0", id: msg.id, result: { ok: true } });
        break;
      case "account/rateLimits/read": {
        dump();
        if (mode === "usage-unavailable") out({ id: msg.id, error: { code: -1, message: "Unsupported authentication" } });
        else {
          const capture = JSON.parse(readFileSync(new URL("./fixtures/usage/codex-read-observed.json", import.meta.url), "utf8"));
          const now = Math.floor(Date.now() / 1000);
          for (const bucket of [capture.result.rateLimits, ...Object.values(capture.result.rateLimitsByLimitId)] as Array<typeof capture.result.rateLimits>) {
            for (const window of [bucket.primary, bucket.secondary]) {
              if (window) window.resetsAt = now + window.windowDurationMins * 60;
            }
          }
          if (mode === "usage-limit" && process.env.FAKE_CODEX_LIMIT_USAGE_READ === "1") {
            capture.result.ordinaryUsageAllowed = false;
          }
          out({ id: msg.id, result: capture.result });
        }
        break;
      }
      case "model/list": {
        const second = msg.params?.cursor === "next-page";
        const models = JSON.parse(second
          ? (process.env.FAKE_CODEX_MODELS_PAGE_2 ?? "[]")
          : (process.env.FAKE_CODEX_MODELS ?? '[{"model":"gpt-new","displayName":"GPT New","isDefault":true}]'));
        out({ jsonrpc: "2.0", id: msg.id, result: {
          data: models,
          nextCursor: !second && process.env.FAKE_CODEX_MODELS_PAGE_2 ? "next-page" : null,
        } });
        break;
      }
      case "thread/resume":
        if (mode === "resume") {
          out({ jsonrpc: "2.0", id: msg.id, result: { thread: { id: msg.params?.threadId } } });
        } else {
          out({ jsonrpc: "2.0", id: msg.id, error: { code: -1, message: "no such thread" } });
        }
        break;
      case "thread/start":
        out({ jsonrpc: "2.0", id: msg.id, result: { thread: { id: "codex-thread-1" }, model: "fake-codex-model" } });
        break;
      case "turn/steer":
        dump();
        if (mode === "steer-reject" || mode === "steer-reject-hang") {
          out({ id: msg.id, error: { code: -1, message: "Turn already ended" } });
          if (mode !== "steer-reject-hang") finishTurn();
        } else {
          out({ id: msg.id, result: { turnId: "native-turn-1" } });
          if (mode === "steer-usage") { setTimeout(finishTurn, 100); break; }
          if (msg.params.input[0].text === "hold-for-more") break;
          notify("item/agentMessage/delta", { itemId: "m1", delta: msg.params.input[0].text });
          notify("item/completed", { item: { id: "m1", type: "agentMessage", text: "Before correction. " + msg.params.input[0].text } });
          notify("turn/completed", { turn: { status: "completed" } });
        }
        break;
      case "turn/start":
        out({ jsonrpc: "2.0", id: msg.id, result: { turn: { id: "native-turn-1" } } });
        if (mode === "steer-reject" && msg.params.input[0].text.includes("redirect-now")) { finishTurn(); break; }
        if (mode === "steer" || mode === "steer-reject" || mode === "steer-reject-hang" || mode === "steer-usage") {
          notify("item/agentMessage/delta", { itemId: "m1", delta: "Before correction. " });
          break;
        }
        notify("item/started", { item: { id: "i1", type: "commandExecution", command: "ls -la" } });
        if (mode === "approval") {
          out({ jsonrpc: "2.0", id: 100, method: "execCommandApproval", params: { command: "rm -rf scratch" } });
          // turn continues from the approval response handler above
        } else if (mode === "mcp-approval") {
          out({
            jsonrpc: "2.0",
            id: 100,
            method: "mcpServer/elicitation/request",
            params: {
              serverName: process.env.FAKE_CODEX_MCP_SERVER ?? "gbs_agents",
              mode: "form",
              _meta: { codex_approval_kind: "mcp_tool_call" },
              message: 'Allow the MCP server to run tool "list_tasks"?',
              requestedSchema: { type: "object", properties: {} },
            },
          });
        } else {
          finishTurn();
        }
        break;
      default:
        if (msg.id !== undefined) out({ jsonrpc: "2.0", id: msg.id, result: {} });
    }
  }
});

// match the real app-server: stay alive until killed
setInterval(() => {}, 1_000);
