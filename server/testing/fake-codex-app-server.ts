#!/usr/bin/env node
// Fake of the codex CLI's `app-server` JSON-RPC surface, for driver
// tests. Speaks newline-delimited JSON-RPC on stdio: answers the
// initialize/thread/turn handshake, then plays a scripted turn. Like the
// real app-server, it never exits on its own — the driver kills it.
//
//   FAKE_CODEX_MODE   happy (default) | approval | resume | stream | windows-command |
//                     mcp-elicitation | mcp-app-approval | mcp-form | permissions-approval | config-profile |
//                     config-profile-unsupported | config-read-error | image |
//                     logged-in-stdout | logged-out | unauthorized
//   FAKE_CODEX_DUMP   path to write {pid, argv, env, calls, decision} as JSON
//
// Keep this file dependency-free — it runs as a bare `node` subprocess.
import { readFileSync, writeFileSync } from "node:fs";

const mode = process.env.FAKE_CODEX_MODE ?? "happy";

if (process.argv[2] === "--version") {
  process.stdout.write(`${process.env.FAKE_CODEX_VERSION ?? "codex-cli 0.147.0"}\n`);
  process.exit(0);
}
if (process.argv[2] === "login" && process.argv[3] === "status") {
  if (mode === "logged-out") {
    process.stderr.write("Not logged in\n");
    process.exit(1);
  }
  // Codex 0.147.0 reports a successful login on stderr; retain a mode for
  // older versions that wrote the same status on stdout.
  const statusStream = mode === "logged-in-stdout" ? process.stdout : process.stderr;
  statusStream.write("Logged in using ChatGPT\n");
  process.exit(0);
}
const calls: Array<{ method: string; params: unknown }> = [];
let decision: unknown = null;
let experimentalApi = false;

const out = (obj: unknown) => process.stdout.write(JSON.stringify(obj) + "\n");
const notify = (method: string, params: unknown) => out({ jsonrpc: "2.0", method, params });

const dump = () => {
  if (process.env.FAKE_CODEX_DUMP) {
    writeFileSync(
      process.env.FAKE_CODEX_DUMP,
      JSON.stringify({ pid: process.pid, argv: process.argv.slice(2), env: process.env, calls, decision }, null, 2),
    );
  }
};

const finishTurn = () => {
  notify("item/completed", { item: { id: "i1", type: "commandExecution", status: "completed" } });
  notify("item/completed", { item: { id: "w1", type: "webSearch", status: "completed" } });
  if (mode === "stream") {
    // token deltas, then the whole message — the driver must not double-emit
    notify("item/agentMessage/delta", { itemId: "m1", delta: "done from " });
    notify("item/agentMessage/delta", { itemId: "m1", delta: "fake codex" });
  }
  if (mode === "image") {
    notify("item/completed", {
      item: {
        id: "img1",
        type: "imageGeneration",
        status: "completed",
        result: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        revisedPrompt: "a tiny green mouse",
        savedPath: "/tmp/provider-owned-path-must-not-be-read.png",
      },
    });
  }
  notify("item/completed", { item: { id: "m1", type: "agentMessage", text: "done from fake codex" } });
  notify("thread/tokenUsage/updated", { tokenUsage: { total: { inputTokens: 7, cachedInputTokens: 4, outputTokens: 3 } } });
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
    if ((msg.id === 100 || msg.id === 101) && (msg.result !== undefined || msg.error !== undefined)) {
      decision = msg.result ?? { error: msg.error };
      finishTurn();
      continue;
    }

    if (msg.method) calls.push({ method: msg.method, params: msg.params ?? null });

    switch (msg.method) {
      case "initialize":
        experimentalApi = msg.params?.capabilities?.experimentalApi === true;
        out({ jsonrpc: "2.0", id: msg.id, result: { ok: true } });
        break;
      case "model/list":
        if (msg.params?.cursor === "page-2") {
          out({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              data: [
                { id: "gpt-hidden", displayName: "Hidden", hidden: true, isDefault: false },
                { id: "gpt-page-two", displayName: "GPT Page Two", hidden: false, isDefault: false },
              ],
              nextCursor: null,
            },
          });
        } else {
          const hasAstra = process.env.FAKE_CODEX_ASTRA === "1";
          out({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              data: [
                ...(hasAstra
                  ? [{ id: "gpt-6-astra", displayName: "GPT-6 Astra", hidden: false, isDefault: true }]
                  : []),
                { id: "gpt-fake-default", displayName: "GPT Fake Default", hidden: false, isDefault: !hasAstra },
              ],
              nextCursor: "page-2",
            },
          });
        }
        break;
      case "config/read":
        if (mode === "config-read-error") {
          dump();
          out({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "config unavailable" } });
          break;
        }
        out({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            config: {
              ...(mode === "config-profile" || mode === "config-profile-unsupported"
              ? {
                  default_permissions: "private-operator-profile",
                  permissions: {
                    "private-operator-profile": { extends: ":danger-full-access" },
                  },
                  // These conflicting legacy values prove the profile wins.
                  approval_policy: null,
                  approvals_reviewer: null,
                  sandbox_mode: "read-only",
                }
              : {
                  approval_policy: "never",
                  approvals_reviewer: "auto_review",
                  sandbox_mode: "read-only",
                  mcp_servers: {
                    harmless_name: { env: { DISPLAY_LABEL: "innocuous-config-secret-7a9c" } },
                  },
                }),
              developer_instructions: process.env.FAKE_CODEX_INSTRUCTIONS ?? null,
            },
            origins: {},
          },
        });
        break;
      case "thread/resume":
        if (msg.params?.permissions && (!experimentalApi || mode === "config-profile-unsupported")) {
          out({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "experimental API required for permissions" } });
        } else if (mode === "resume" || mode === "instructions-unsupported" || mode === "config-profile" || mode === "config-profile-unsupported") {
          out({ jsonrpc: "2.0", id: msg.id, result: { thread: { id: msg.params?.threadId } } });
        } else {
          out({ jsonrpc: "2.0", id: msg.id, error: { code: -1, message: "no such thread" } });
        }
        break;
      case "thread/inject_items":
        if (mode === "instructions-unsupported") {
          dump();
          out({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
          break;
        }
        out({ jsonrpc: "2.0", id: msg.id, result: {} });
        break;
      case "thread/start":
        if (msg.params?.permissions && (!experimentalApi || mode === "config-profile-unsupported")) {
          out({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "experimental API required for permissions" } });
        } else {
          out({ jsonrpc: "2.0", id: msg.id, result: { thread: { id: "codex-thread-1" }, model: "fake-codex-model" } });
        }
        break;
      case "turn/start": {
        if (msg.params?.permissions && (!experimentalApi || mode === "config-profile-unsupported")) {
          out({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "experimental API required for permissions" } });
          break;
        }
        if (mode === "unauthorized") {
          out({
            jsonrpc: "2.0",
            id: msg.id,
            error: {
              code: -32603,
              message: "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header",
            },
          });
          break;
        }
        // transient-failure script for retry tests. FAKE_CODEX_TRANSIENTS is
        // how many launches fail transiently; the launch count lives in a
        // state FILE because child processes cannot mutate the parent's env.
        // FAKE_CODEX_PARTIAL_FAILS makes the FIRST failing turn stream a text
        // delta first, so the partial-output guard has something to see.
        if (process.env.FAKE_CODEX_TRANSIENTS && process.env.FAKE_CODEX_STATE) {
          let launched = 0;
          try {
            launched = Number(readFileSync(process.env.FAKE_CODEX_STATE, "utf8")) || 0;
          } catch {}
          const quota = Number(process.env.FAKE_CODEX_TRANSIENTS) || 0;
          writeFileSync(process.env.FAKE_CODEX_STATE, String(launched + 1));
          if (launched < quota) {
            if (process.env.FAKE_CODEX_PARTIAL_FAILS) {
              out({ jsonrpc: "2.0", id: msg.id, result: { ok: true } });
              notify("item/agentMessage/delta", { itemId: "m1", delta: "half an answer" });
              notify("turn/completed", { turn: { status: "failed", error: { message: "provider overloaded, try again" } } });
              break;
            }
            out({
              jsonrpc: "2.0",
              id: msg.id,
              error: { code: -32603, message: "provider returned 503: upstream capacity exceeded" },
            });
            break;
          }
        }
        out({ jsonrpc: "2.0", id: msg.id, result: { ok: true } });
        const command = mode === "windows-command"
          ? [
              "\"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\"",
              "-Command",
              `"Get-Content -Raw -LiteralPath 'C:\\Users\\Ada\\workspaces\\${"very-long-folder\\".repeat(8)}NOTES.md'"`,
            ].join(" ")
          : "ls -la";
        notify("item/started", { item: { id: "i1", type: "commandExecution", command } });
        notify("item/started", { item: { id: "w1", type: "webSearch", query: "OpenMausBot" } });
        if (mode === "mcp-elicitation") {
          out({
            jsonrpc: "2.0",
            id: 101,
            method: "mcpServer/elicitation/request",
            params: {
              serverName: "agents",
              mode: "form",
              _meta: { codex_approval_kind: "mcp_tool_call", tool_params: {} },
              message: 'Allow the agents MCP server to run tool "list_bots"?',
              requestedSchema: { type: "object", properties: {} },
            },
          });
        } else if (mode === "mcp-app-approval") {
          out({
            jsonrpc: "2.0",
            id: 101,
            method: "mcpServer/elicitation/request",
            params: {
              serverName: "computer-use",
              mode: "form",
              message: "Allow ChatGPT to use Safari?",
              _meta: { app_name: "Safari", persist: ["session", "always"] },
              requestedSchema: {
                type: "object",
                properties: {
                  approval: {
                    type: "string",
                    oneOf: [
                      { const: "once", title: "Allow once" },
                      { const: "session", title: "Allow for this session" },
                      { const: "always", title: "Always allow Safari" },
                    ],
                  },
                },
                required: ["approval"],
              },
            },
          });
        } else if (mode === "mcp-form") {
          out({
            jsonrpc: "2.0",
            id: 101,
            method: "mcpServer/elicitation/request",
            params: {
              serverName: "example",
              mode: "form",
              message: "Enter an API key",
              requestedSchema: {
                type: "object",
                properties: { apiKey: { type: "string" } },
                required: ["apiKey"],
              },
            },
          });
        } else if (mode === "permissions-approval") {
          out({
            jsonrpc: "2.0",
            id: 101,
            method: "item/permissions/requestApproval",
            params: {
              threadId: "codex-thread-1",
              turnId: "turn-1",
              itemId: "permission-1",
              cwd: "/tmp",
              startedAtMs: Date.now(),
              reason: "Needs network access",
              permissions: {
                network: { enabled: true },
                fileSystem: null,
              },
            },
          });
        } else if (mode === "approval" || mode === "windows-command") {
          const approvalCommand = mode === "windows-command" ? command : "rm -rf scratch";
          out({ jsonrpc: "2.0", id: 100, method: "execCommandApproval", params: { command: approvalCommand } });
          // turn continues from the approval response handler above
        } else {
          finishTurn();
        }
        break;
      }
      default:
        if (msg.id !== undefined) out({ jsonrpc: "2.0", id: msg.id, result: {} });
    }
  }
});

// match the real app-server: stay alive until killed
setInterval(() => {}, 1_000);
