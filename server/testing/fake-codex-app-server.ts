#!/usr/bin/env node
// Fake of the codex CLI's `app-server` JSON-RPC surface, for driver
// tests. Speaks newline-delimited JSON-RPC on stdio: answers the
// initialize/thread/turn handshake, then plays a scripted turn. Like the
// real app-server, it never exits on its own — the driver kills it.
//
//   FAKE_CODEX_MODE   happy (default) | approval | resume | stream | windows-command |
//                     mcp-elicitation | mcp-app-approval | mcp-form | permissions-approval | config-profile |
//                     config-profile-unsupported | config-read-error | image |
//                     logged-in-stdout | logged-out | unauthorized | late-request
//   FAKE_CODEX_LAUNCH_CRASHES  die at turn/start (before ack) with transient stderr,
//                               exit 1, for the first N launches (launch count kept in
//                               FAKE_CODEX_STATE)
//   FAKE_CODEX_LAUNCH_KILLS    like LAUNCH_CRASHES but die by SIGKILL (signal exit;
//                               POSIX-shaped — win32 reports exit 1, signal null), for
//                               the first N launches (launch count in FAKE_CODEX_STATE)
//   FAKE_CODEX_LAUNCH_SILENT   die at turn/start (before ack) with exit 1 and no stderr
//                               at all, for the first N launches (launch count in
//                               FAKE_CODEX_STATE)
//   FAKE_CODEX_ACK_CRASH       gate file path: hold the post-ack crash until the
//                              test confirms the driver parsed the ack
//   FAKE_CODEX_EXIT_MID_TURN   gate file path: hold the ack/delta stdout until the
//                              test confirms the stale websocket-426 stderr was read
//   FAKE_CODEX_EXIT_MID_TURN_KILL  gate file path: hold the SIGKILL until the test
//                              confirms the reasoning delta was parsed
//   FAKE_CODEX_DUMP   path to write {pid, argv, env, calls, decision} as JSON
//   FAKE_CODEX_ACCOUNT_EMAIL  synthetic ChatGPT identity (default ada@example.test)
//   FAKE_CODEX_ACCOUNT_MODE   chatgpt (default) | api-key | none | unsupported | error | hang
//   FAKE_CODEX_RESUME_ERROR   JSON-RPC error object to reject thread/resume
//   FAKE_CODEX_START_ERROR    JSON-RPC error object to reject thread/start
//   FAKE_CODEX_RESTORED_USAGE report 100/50/10 tokens already used before turn/start, as a resumed thread can
//
// Keep this file dependency-free — it runs as a bare `node` subprocess.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const mode = process.env.FAKE_CODEX_MODE ?? "happy";

// stdout and stderr are separate pipes: the writer cannot order them for
// the reader, and a fixed sleep only pretends to. These knobs synchronize
// on the test instead — it watches the driver consume the earlier stream
// and creates the gate file at that moment; the fake holds the scripted
// write until the gate appears (a later event-loop turn at the earliest,
// so the ordering is real, not a timing guess). Resolves after a long
// timeout so a broken gate still surfaces as a failing test, not a hang.
const waitForGate = (path: string | undefined, timeoutMs = 15_000): Promise<void> =>
  new Promise((resolve) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if ((path !== undefined && existsSync(path)) || Date.now() - startedAt > timeoutMs) {
        clearInterval(timer);
        resolve();
      }
    }, 2);
  });

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
let nativeThreadId = "codex-thread-1";
const nativeTurnId = "turn-1";
const notify = (method: string, params: any) => out({
  jsonrpc: "2.0", method,
  params: {
    threadId: nativeThreadId,
    ...(method.startsWith("turn/") ? {} : { turnId: nativeTurnId }),
    ...params,
    ...(params.turn ? { turn: { id: nativeTurnId, ...params.turn } } : {}),
  },
});

// The response and restored usage notification may arrive in one stdout
// chunk. Force that ordering for the baseline fixture instead of relying on
// the OS to coalesce two writes under load.
const threadReply = (response: unknown) => {
  if (!process.env.FAKE_CODEX_RESTORED_USAGE) return out(response);
  const restored = {
    jsonrpc: "2.0", method: "thread/tokenUsage/updated",
    params: { threadId: nativeThreadId, turnId: nativeTurnId,
      tokenUsage: { total: { inputTokens: 100, cachedInputTokens: 50, outputTokens: 10 } } },
  };
  process.stdout.write(`${JSON.stringify(response)}\n${JSON.stringify(restored)}\n`);
};

const dump = () => {
  if (process.env.FAKE_CODEX_DUMP) {
    writeFileSync(
      process.env.FAKE_CODEX_DUMP,
      JSON.stringify({ pid: process.pid, argv: process.argv.slice(2), env: process.env, calls, decision }, null, 2),
    );
  }
};

const finishTurn = () => {
  notify("item/completed", { item: { id: "i1", type: "commandExecution", status: "completed", aggregatedOutput: "README.md\nAPI_KEY=codex-output-secret", exitCode: 0 } });
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
  // `total` is the process so far, `last` the final model call. With
  // FAKE_CODEX_RESTORED_USAGE the process already carried 100/50/10 before
  // turn/start (a resumed thread restoring earlier usage), so the driver's
  // per-turn figure must still come out as 7/4/3.
  const carried = process.env.FAKE_CODEX_RESTORED_USAGE ? { inputTokens: 100, cachedInputTokens: 50, outputTokens: 10 } : { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
  notify("thread/tokenUsage/updated", { tokenUsage: {
    total: { inputTokens: carried.inputTokens + 7, cachedInputTokens: carried.cachedInputTokens + 4, outputTokens: carried.outputTokens + 3 },
    last: { inputTokens: 7, cachedInputTokens: 4, outputTokens: 3 },
    modelContextWindow: 272000,
  } });
  dump();
  if (mode === "late-request") process.stdout.cork();
  notify("turn/completed", { turn: { status: "completed" } });
  if (mode === "late-request") {
    out({ jsonrpc: "2.0", id: 100, method: "execCommandApproval", params: { command: "echo too late" } });
    process.stdout.uncork();
  }
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
      case "account/read": {
        dump();
        const accountMode = process.env.FAKE_CODEX_ACCOUNT_MODE;
        if (accountMode === "hang") break;
        if (accountMode === "unsupported" || accountMode === "error") {
          out({ jsonrpc: "2.0", id: msg.id, error: {
            code: accountMode === "unsupported" ? -32601 : -32000,
            message: "Offline fixture account read unavailable",
          } });
          break;
        }
        const account = accountMode === "none" || mode === "logged-out" ? null
          : accountMode === "api-key" ? { type: "apiKey" }
          : { type: "chatgpt", email: process.env.FAKE_CODEX_ACCOUNT_EMAIL ?? "ada@example.test", planType: "pro" };
        out({ jsonrpc: "2.0", id: msg.id, result: { account, requiresOpenaiAuth: true } });
        break;
      }
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
        dump();
        if (process.env.FAKE_CODEX_RESUME_ERROR) {
          out({ jsonrpc: "2.0", id: msg.id, error: JSON.parse(process.env.FAKE_CODEX_RESUME_ERROR) });
        } else if (msg.params?.permissions && (!experimentalApi || mode === "config-profile-unsupported")) {
          out({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "experimental API required for permissions" } });
        } else if (mode === "resume" || mode === "helper-events" || mode === "instructions-unsupported" || mode === "config-profile" || mode === "config-profile-unsupported" ||
            (mode === "resume-then-missing" && !existsSync(process.env.FAKE_CODEX_STATE ?? ""))) {
          threadReply({ jsonrpc: "2.0", id: msg.id, result: { thread: { id: msg.params?.threadId } } });
        } else {
          out({ jsonrpc: "2.0", id: msg.id, error: { code: -32600, message: `no rollout found for thread id ${msg.params?.threadId}` } });
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
        dump();
        if (process.env.FAKE_CODEX_START_ERROR) {
          out({ jsonrpc: "2.0", id: msg.id, error: JSON.parse(process.env.FAKE_CODEX_START_ERROR) });
        } else if (msg.params?.permissions && (!experimentalApi || mode === "config-profile-unsupported")) {
          out({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "experimental API required for permissions" } });
        } else {
          threadReply({ jsonrpc: "2.0", id: msg.id, result: { thread: { id: "codex-thread-1" }, model: "fake-codex-model" } });
        }
        break;
      case "turn/start": {
        dump();
        nativeThreadId = msg.params?.threadId ?? nativeThreadId;
        // crash script for close-path retry tests: die before
        // acknowledging turn/start. The launch count lives in a state
        // FILE for the same reason as the TRANSIENTS script below; it
        // must count only turn launches, not the catalog spawn during
        // create(), which is why this sits here and not on initialize.
        if (process.env.FAKE_CODEX_LAUNCH_CRASHES && process.env.FAKE_CODEX_STATE) {
          let launched = 0;
          try {
            launched = Number(readFileSync(process.env.FAKE_CODEX_STATE, "utf8")) || 0;
          } catch {}
          const crashes = Number(process.env.FAKE_CODEX_LAUNCH_CRASHES) || 0;
          writeFileSync(process.env.FAKE_CODEX_STATE, String(launched + 1));
          if (launched < crashes) {
            console.error("Error: connection reset by peer");
            process.exit(1);
          }
        }
        if (process.env.FAKE_CODEX_LAUNCH_KILLS && process.env.FAKE_CODEX_STATE) {
          let launched = 0;
          try {
            launched = Number(readFileSync(process.env.FAKE_CODEX_STATE, "utf8")) || 0;
          } catch {}
          const kills = Number(process.env.FAKE_CODEX_LAUNCH_KILLS) || 0;
          writeFileSync(process.env.FAKE_CODEX_STATE, String(launched + 1));
          if (launched < kills) {
            // signal death: transient-looking stderr, then SIGKILL. The
            // driver must treat the signal itself as terminal and never
            // classify its way into a retry off the stderr text. The kill
            // is delayed a tick so the stderr write reaches the pipe, and
            // turn/start is never acknowledged, keeping the death pre-ack
            // like a real OOM or kill -9.
            console.error("Error: connection reset by peer");
            setTimeout(() => process.kill(process.pid, "SIGKILL"), 15);
            break;
          }
        }
        if (process.env.FAKE_CODEX_LAUNCH_SILENT && process.env.FAKE_CODEX_STATE) {
          let launched = 0;
          try {
            launched = Number(readFileSync(process.env.FAKE_CODEX_STATE, "utf8")) || 0;
          } catch {}
          const silent = Number(process.env.FAKE_CODEX_LAUNCH_SILENT) || 0;
          writeFileSync(process.env.FAKE_CODEX_STATE, String(launched + 1));
          if (launched < silent) {
            // silent death: exit 1 before ack with no stderr at all. The
            // driver must settle from what actually happened, never by
            // digging into the lifetime stderr buffer for a retry excuse.
            process.exit(1);
          }
        }
        if (mode === "safety-rpc") {
          out({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "HTTP 503: This task was blocked by our safety systems." } });
          break;
        }
        if (mode === "safety-completion" || mode === "safety-notification") {
          out({ jsonrpc: "2.0", id: msg.id, result: { turn: { id: nativeTurnId } } });
          const message = "This task was blocked by our safety systems.";
          if (mode === "safety-notification") notify("error", { message });
          notify("turn/completed", { turn: { status: "failed", error: { message } } });
          break;
        }
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
              out({ jsonrpc: "2.0", id: msg.id, result: { turn: { id: nativeTurnId } } });
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
        if (process.env.FAKE_CODEX_ACK_CRASH) {
          out({ jsonrpc: "2.0", id: msg.id, result: { turn: { id: nativeTurnId } } });
          // Crash only once the test confirms the ack above was parsed
          // (the env var is the gate file path). stderr that races ahead
          // of the parsed ack gets reset as pre-output and the message
          // assertion flakes (seen on windows-latest, where pipe delivery
          // order varies).
          void waitForGate(process.env.FAKE_CODEX_ACK_CRASH).then(() => {
            console.error("Error: connection reset by peer");
            process.exit(1);
          });
          break;
        }
        if (process.env.FAKE_CODEX_EXIT_MID_TURN) {
          // replay of the 2026-09-14 incident: a websocket 426 on stderr
          // at turn start, output keeps flowing, and the process is then
          // killed by a signal long after the stale line
          console.error("2026-09-14T20:24:19Z ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: HTTP error: 426 Upgrade Required, url: ws://127.0.0.1:10100/v1/responses");
          // Hold the stdout writes back until the test confirms the stale
          // stderr above was read. If the driver parses stdout first, the
          // stderr chunk lands after the last parse and the stale 426 is
          // blamed at close — the same windows pipe-ordering flake class
          // as ACK_CRASH above. The kill waits for its own gate so the
          // delta is parsed before the close event fires.
          void waitForGate(process.env.FAKE_CODEX_EXIT_MID_TURN).then(() => {
            out({ jsonrpc: "2.0", id: msg.id, result: { turn: { id: nativeTurnId } } });
            notify("item/reasoning/textDelta", { itemId: "m1", delta: "still thinking" });
            void waitForGate(process.env.FAKE_CODEX_EXIT_MID_TURN_KILL).then(() =>
              process.kill(process.pid, "SIGKILL"),
            );
          });
          break;
        }
        if (mode === "early-turn-events") finishTurn();
        out({ jsonrpc: "2.0", id: msg.id, result: { turn: { id: nativeTurnId } } });
        if (mode === "early-turn-events") break;
        if (mode === "helper-events") {
          // Interleave child and stale-parent traffic with the active parent.
          // A child completion must not kill the process or answer for the parent.
          for (const scope of [
            { threadId: "helper-thread", turnId: "helper-turn" },
            { threadId: nativeThreadId, turnId: "previous-turn" },
            { threadId: null, turnId: null },
          ]) {
            notify("item/agentMessage/delta", { ...scope, delta: "FOREIGN answer" });
            notify("item/reasoning/textDelta", { ...scope, delta: "FOREIGN reasoning" });
            notify("item/started", { ...scope, item: { id: "foreign-tool", type: "commandExecution", command: "FOREIGN command" } });
            notify("item/completed", { ...scope, item: { type: "agentMessage", text: "FOREIGN final" } });
            notify("thread/tokenUsage/updated", { ...scope, tokenUsage: { total: { inputTokens: 999, outputTokens: 999 } } });
            notify("error", { ...scope, message: "FOREIGN error" });
            notify("turn/completed", { ...scope, turn: { id: scope.turnId, status: "completed" } });
            notify("turn/completed", { ...scope, turn: { id: scope.turnId, status: "failed" } });
          }
          // This request proves that the parent is still able to do work after
          // the child finished. Wait for the real adapter approval response.
          out({ jsonrpc: "2.0", id: 100, method: "execCommandApproval", params: { command: "echo parent continues" } });
          break;
        }
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
