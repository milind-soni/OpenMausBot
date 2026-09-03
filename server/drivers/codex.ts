// Codex driver — upstream CodexDriver skeleton over agentcal's
// drivers/codex.js runtime: the official `codex` CLI headless over its
// app-server JSON-RPC protocol (newline-delimited JSON on stdio).
// Completion is a real `turn/completed` notification; approval requests
// arrive as in-process server→client JSON-RPC requests and surface as
// canonical request.opened events (answered via respondToRequest — no MCP
// proxy or unix socket needed, unlike claude). Verified against
// codex-cli 0.144.4 by agentcal.
//
// resumeCursor is the codex thread id; a later turn tries thread/resume
// and falls back to a fresh thread/start.
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { stripWorkspaceCredentialEnv } from "../config.ts";
import { computerProxyEnv } from "../container-computer.ts";
import { describeSpawnFailure, execCli, killCliTree, spawnCli } from "../procs.ts";
import { SPAWNED_PROXIES } from "../proxy-paths.ts";

import type {
  DriverCreateInput,
  ProviderDriver,
  ProviderInstance,
  ProviderSnapshot,
  RuntimeEvent,
  RuntimeEventListener,
  SendTurnInput,
} from "../contracts.ts";
import { newEventId, newId } from "../contracts.ts";
import { decodeCodexSelection, readCodexModelCatalog, STATIC_CODEX_MODELS } from "./codex-catalog.ts";
import { codexLocalProviderArgs } from "./local-inject.ts";
import { augmentedPath } from "../env-path.ts";
import { classifyError, computeBackoff, RETRY_MAX_ATTEMPTS } from "./retry.ts";
import { appendNative } from "./native.ts";

export { decodeCodexSelection, readCodexModelCatalog, STATIC_CODEX_MODELS } from "./codex-catalog.ts";

const DRIVER_KIND = "codex";

export interface CodexConfig {
  cli: string;
  fullAuto: boolean;
}

/** Decode persisted Codex settings while keeping full-auto opt-in strict. */
function decodeConfig(raw: unknown): CodexConfig {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    cli: typeof o.cli === "string" ? o.cli : "codex",
    fullAuto: o.fullAuto === true,
  };
}

const QUESTION_TIMEOUT_NOTE = "No answer was given — use your best judgment.";
const DENY_TIMEOUT_NOTE =
  "OpenMausBot: nobody answered this permission request in time. Skip this action and finish what you can without it.";

type StdioMcpServer = { command: string; args: string[]; env: Record<string, string> };

function mountMcpServer(
  appServerArgs: string[],
  env: Record<string, string | undefined>,
  name: string,
  server: StdioMcpServer,
  preApproved = true,
): void {
  Object.assign(env, server.env);
  const prefix = `mcp_servers.${name}`;
  appServerArgs.push(
    "-c", `${prefix}.command=${JSON.stringify(server.command)}`,
    "-c", `${prefix}.args=${JSON.stringify(server.args)}`,
    // Values stay in the child environment; argv contains names only so
    // credentials never appear in process listings or diagnostics.
    "-c", `${prefix}.env_vars=${JSON.stringify(Object.keys(server.env))}`,
  );
  // Harness-owned servers are pre-quieted; a user-configured server keeps
  // codex's on-request policy so its tool calls become approval cards.
  if (preApproved) {
    appServerArgs.push("-c", `${prefix}.default_tools_approval_mode="auto"`);
  }
}

/** The review child is intentionally independent from normal turn routing. */
export const CODEX_REVIEW_TIMEOUT_MS = 60_000;
const CODEX_REVIEW_MAX_OUTPUT_BYTES = 1_000_000;
const CODEX_REVIEW_INSTRUCTIONS =
  "Review only the supplied permission request. Do not call tools, inspect files, or access the network. Return only the requested JSON verdict.";
const CODEX_REVIEW_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["allow", "reason"],
  properties: {
    allow: { type: "boolean" },
    reason: { type: "string", minLength: 1, maxLength: 200 },
  },
} as const;
const CODEX_REVIEW_ENV_KEYS = [
  "PATH",
  "CODEX_HOME",
  "HOME",
  "USERPROFILE",
  "SystemRoot",
  "ComSpec",
  "PATHEXT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "NPM_CONFIG_LOGLEVEL",
] as const;

/** Keep only non-secret runtime context needed by the isolated reviewer. */
function codexReviewEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const reviewEnv: Record<string, string | undefined> = {};
  for (const key of CODEX_REVIEW_ENV_KEYS) {
    if (env[key] !== undefined) reviewEnv[key] = env[key];
  }
  return reviewEnv;
}

/**
 * Run one permission review through a fresh app-server process. The prompt is
 * only present in the JSON-RPC turn/start message on child stdin. The child
 * gets a disposable cwd, read-only/never-approval session settings, and an
 * empty MCP table; it never receives a normal turn's integrations or cursor.
 *
 * The raw assistant text is returned so auto-review's existing strict parser
 * remains the security boundary for malformed or extra output.
 */
export function runCodexPermissionReview(
  cli: string,
  env: Record<string, string | undefined>,
  prompt: string,
  signal?: AbortSignal,
  timeoutMs = CODEX_REVIEW_TIMEOUT_MS,
): Promise<string> {
  if (signal?.aborted) return Promise.reject(new Error("Codex review aborted"));

  const reviewCwd = mkdtempSync(join(tmpdir(), "omb-codex-review-"));
  const args = [
    "app-server",
    // Do not inherit MCP servers from the user's Codex config. Normal turns
    // add their own named entries explicitly; this review has none.
    "-c", "mcp_servers={}",
    // Do not let the app-server inject project instructions from the temp cwd.
    "-c", "project_doc_max_bytes=0",
  ];
  const reviewEnv = codexReviewEnv(env);
  let child: ReturnType<typeof spawnCli> | undefined;
  let settled = false;
  let outputBytes = 0;
  let stderr = "";
  let buffer = "";
  let answer: string | undefined;
  let nextId = 1;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;

  return new Promise((resolve, reject) => {
    const removeTempCwd = () => {
      try {
        rmSync(reviewCwd, { recursive: true, force: true });
      } catch {
        // The cwd is disposable; a later process cleanup must not turn a
        // completed review into an apparently failed approval.
      }
    };
    const finish = (error?: Error, value?: string) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
      for (const request of pending.values()) request.reject(error ?? new Error("Codex review settled"));
      pending.clear();
      if (child && child.exitCode === null && child.signalCode === null) killCliTree(child);
      if (child) child.once("close", removeTempCwd);
      else removeTempCwd();
      if (error) reject(error);
      else resolve(value ?? "");
    };
    const send = (message: unknown) => {
      if (!child?.stdin?.writable) throw new Error("Codex review stdin is unavailable");
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    const request = (method: string, params: unknown): Promise<any> =>
      new Promise((resolveRequest, rejectRequest) => {
        const id = nextId++;
        pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
        try {
          send({ jsonrpc: "2.0", id, method, params });
        } catch (error) {
          pending.delete(id);
          rejectRequest(error instanceof Error ? error : new Error(String(error)));
        }
      });

    try {
      child = spawnCli(cli, args, {
        cwd: reviewCwd,
        env: reviewEnv,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      const chunkBytes = Buffer.byteLength(chunk, "utf8");
      if (outputBytes + chunkBytes > CODEX_REVIEW_MAX_OUTPUT_BYTES) {
        finish(new Error("Codex review output exceeded 1 MB"));
        return;
      }
      outputBytes += chunkBytes;
      buffer += chunk;
      let newline: number;
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
        if (!message || typeof message !== "object" || Array.isArray(message)) {
          continue;
        }
        if (message.id !== undefined && typeof message.method === "string") {
          try {
            send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not allowed during permission review" } });
          } catch {
            // child stdin closed
          }
          continue;
        }
        if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
          const waiting = pending.get(message.id);
          if (!waiting) continue;
          pending.delete(message.id);
          if (message.error) waiting.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
          else waiting.resolve(message.result);
          continue;
        }
        if (message.method === "item/completed" && message.params?.item?.type === "agentMessage") {
          const text = message.params.item.text;
          if (typeof text === "string") {
            if (answer !== undefined) {
              finish(new Error("Codex review returned multiple assistant messages"));
              return;
            }
            answer = text;
          }
          continue;
        }
        if (message.method === "turn/completed") {
          const status = message.params?.turn?.status;
          if (status !== "completed") {
            finish(new Error(`Codex review turn failed: ${String(status ?? "unknown")}`));
          } else if (answer === undefined) {
            finish(new Error("Codex review returned no assistant message"));
          } else {
            finish(undefined, answer.trim());
          }
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-8_192);
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code, signalCode) => {
      removeTempCwd();
      if (!settled) finish(new Error(stderr.trim() || `Codex review exited ${code ?? signalCode ?? "before result"}`));
    });

    onAbort = () => finish(new Error("Codex review aborted"));
    timer = setTimeout(() => finish(new Error(`Codex review timed out after ${timeoutMs}ms`)), timeoutMs);
    timer.unref?.();
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });

    void (async () => {
      try {
        await request("initialize", { clientInfo: { name: "openmausbot-review", version: "1" } });
        send({ jsonrpc: "2.0", method: "initialized", params: {} });
        const started = await request("thread/start", {
          cwd: reviewCwd,
          sandbox: "read-only",
          approvalPolicy: "never",
          ephemeral: true,
          dynamicTools: [],
          developerInstructions: CODEX_REVIEW_INSTRUCTIONS,
        });
        const threadId = started?.thread?.id;
        if (typeof threadId !== "string" || !threadId) throw new Error("Codex review returned no ephemeral thread id");
        await request("turn/start", {
          threadId,
          input: [{ type: "text", text: prompt }],
          outputSchema: CODEX_REVIEW_OUTPUT_SCHEMA,
        });
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    })();
  });
}

export const CodexDriver: ProviderDriver<CodexConfig> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Codex", supportsMultipleInstances: true },
  install: {
    command: {
      darwin: "npm install -g @openai/codex",
      linux: "npm install -g @openai/codex",
      win32: "npm install -g @openai/codex",
    },
    needsNode: true,
    docsUrl: "https://github.com/openai/codex",
    signInCommand: "codex login",
  },
  models: STATIC_CODEX_MODELS,
  decodeConfig,
  defaultConfig: () => decodeConfig({}),

  /** Create a Codex provider instance and its runtime adapter. */
  async create(input: DriverCreateInput<CodexConfig>): Promise<ProviderInstance> {
    const { instanceId, config } = input;
    const childEnv = (): Record<string, string | undefined> => {
      const env: Record<string, string | undefined> = {
        ...process.env,
        ...input.environment,
        PATH: augmentedPath(),
        NPM_CONFIG_LOGLEVEL: "error",
      };
      // The CLI owns its own ChatGPT login; a leaked API key silently flips
      // billing to pay-as-you-go (agentcal).
      delete env.OPENAI_API_KEY;
      // The harness process may hold workspace credentials (xai/box/voice
      // keys, env-injected at boot); none of them are this CLI's to see.
      stripWorkspaceCredentialEnv(env);
      return env;
    };
    const catalogEnv = childEnv();
    let models = STATIC_CODEX_MODELS;
    const refreshModels = async () => {
      try {
        const resolved = await readCodexModelCatalog(catalogEnv, fetch, config.cli);
        if (resolved.options.length) models = resolved;
      } catch {
        // Keep the last usable catalog when a local provider is down.
      }
    };
    await refreshModels();
    const listeners = new Set<RuntimeEventListener>();
    interface Turn {
      stop: () => void;
      turnId: string;
      asks: Map<string, (behavior: "allow" | "deny" | "answer", message?: string, source?: "user" | "timeout" | "system") => void>;
    }
    const active = new Map<string, Turn>();

    const emit = (event: RuntimeEvent) => {
      for (const l of [...listeners]) l(event);
    };
    const base = (threadId: string, turnId: string) => ({
      eventId: newEventId(),
      provider: DRIVER_KIND,
      threadId,
      turnId,
      createdAt: new Date().toISOString(),
    });

    const sendTurn = async (turn: SendTurnInput) => {
      // One driver instance serves many threads. Interrupt state belongs to
      // this turn so activity elsewhere cannot cancel or revive its retry.
      let stopRequested = false;
      const { threadId } = turn;
      if (active.has(threadId)) throw new Error("a turn is already running on this thread");
      const turnId = newId();
      // a retry relaunches the whole app-server; the backoff is scaled down in
      // tests so a fake's transient failures don't stall real seconds
      const retryScale = Number(process.env.FAKE_CODEX_RETRY_SCALE ?? "1");

      const launchAttempt = async (attempt: number): Promise<void> => {
        const env = childEnv();
        const appServerArgs = ["app-server", ...codexLocalProviderArgs(env, turn.model)];
        if (turn.integrations?.composio) {
          mountMcpServer(appServerArgs, env, "openmausbot_connectors", turn.integrations.composio);
        }
        if (turn.integrations?.agents) {
          mountMcpServer(appServerArgs, env, "agents", turn.integrations.agents);
        }
        if (turn.integrations?.computer) {
          const proxyEnv = computerProxyEnv(turn.integrations.computer);
          mountMcpServer(appServerArgs, env, "computer", {
            command: process.execPath,
            args: [SPAWNED_PROXIES.computer],
            env: {
              ELECTRON_RUN_AS_NODE: "1",
              OGB_BOX_ID: proxyEnv.OGB_BOX_ID ?? "",
              OGB_BOX_TOKEN: proxyEnv.OGB_BOX_TOKEN ?? "",
              // who-is-driving endpoint, so a person taking the wheel in the
              // panel pauses this bot's hands mid-turn
              OMB_CONTROL_URL: proxyEnv.OMB_CONTROL_URL ?? "",
              OMB_CONTROL_TOKEN: proxyEnv.OMB_CONTROL_TOKEN ?? "",
            },
          });
        } else if (turn.integrations?.localComputer) {
          // The host daemon and isolated Local VM both arrive as a direct Cua
          // Driver stdio MCP server. Codex sees the same computer tool surface.
          mountMcpServer(appServerArgs, env, "computer", turn.integrations.localComputer);
        }
        if (turn.integrations?.browser) {
          mountMcpServer(appServerArgs, env, "browser", turn.integrations.browser);
        }
        for (const [name, server] of Object.entries(turn.integrations?.custom ?? {})) {
          mountMcpServer(appServerArgs, env, name, server, false);
        }
        if (turn.integrations?.phone) {
          const bridge = turn.integrations.phone;
          Object.assign(env, bridge.env);
          const prefix = "mcp_servers.openmausbot_phone";
          appServerArgs.push(
            "-c", `${prefix}.command=${JSON.stringify(bridge.command)}`,
            "-c", `${prefix}.args=${JSON.stringify(bridge.args)}`,
            "-c", `${prefix}.env_vars=${JSON.stringify(Object.keys(bridge.env))}`,
            "-c", `${prefix}.default_tools_approval_mode="auto"`,
          );
        }

        const child = spawnCli(config.cli, appServerArgs, {
          cwd: turn.cwd ?? homedir(),
          env,
          stdio: ["pipe", "pipe", "pipe"],
        });

      let abandoned = false;
      const state = {
        settled: false,
        lastText: "",
        sawStreamDelta: false,
        // codex reports token usage as a running THREAD total; the harness
        // wants this turn's figure, so the last report is banked on settle
        usage: undefined as { input: number; output: number; cachedInput?: number } | undefined,
      };

      const asks = new Map<string, (behavior: "allow" | "deny" | "answer", message?: string, source?: "user" | "timeout" | "system") => void>();
      let nextId = 1;
      const rpcPending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

      const send = (obj: unknown) => {
        try {
          child.stdin.write(JSON.stringify(obj) + "\n");
        } catch {}
        appendNative(threadId, { dir: "out", source: "codex.app-server", msg: obj });
      };
      const request = (method: string, params: unknown, timeoutMs = 60_000) =>
        new Promise<any>((resolve, reject) => {
          const id = nextId++;
          // a wedged app-server can accept stdin and never reply; without this
          // the handshake await hangs forever and the bot stays busy for good
          const timer = setTimeout(() => {
            if (rpcPending.delete(id)) reject(new Error(`codex ${method} timed out after ${timeoutMs}ms`));
          }, timeoutMs);
          if (typeof timer.unref === "function") timer.unref();
          rpcPending.set(id, {
            resolve: (v) => {
              clearTimeout(timer);
              resolve(v);
            },
            reject: (e) => {
              clearTimeout(timer);
              reject(e);
            },
          });
          send({ jsonrpc: "2.0", id, method, params });
        });

      const stop = () => {
        stopRequested = true;
        killCliTree(child);
      };

      const settle = (ok: boolean, stopReason: string | null) => {
        if (state.settled) return;
        state.settled = true;
        for (const finish of [...asks.values()]) finish("deny", "OpenMausBot: the turn ended", "system");
        for (const p of rpcPending.values()) p.reject(new Error("turn settled"));
        rpcPending.clear();
        active.delete(threadId);
        emit({ ...base(threadId, turnId), type: "turn.completed", ok, stopReason, cost: null, ...(state.usage ? { usage: state.usage } : {}) });
        stop(); // the app-server never exits on its own
      };

      // server→client approval request → canonical request.opened
      // Host-scope tagging mirrors claude.ts: when this turn mounts the real
      // Mac (not a VM), every card carries approvalScope so the harness's
      // local-computer-block backstop applies to remembered always-allows.
      const controlsHost = turn.integrations?.localComputer?.scope === "local-computer";
      const handleServerRequest = (msg: any) => {
        const method = msg.method as string;
        const params = msg.params ?? {};
        const legacy = method === "execCommandApproval" || method === "applyPatchApproval";
        const isMcpElicitation =
          method === "mcpServer/elicitation/request" &&
          params?._meta?.codex_approval_kind === "mcp_tool_call";
        const isQuestion = method === "item/tool/requestUserInput";
        const mcpTool = isMcpElicitation
          ? String(params.message ?? "").match(/tool \"([^\"]+)\"/)?.[1]
          : undefined;
        const tool =
          isMcpElicitation
            ? (mcpTool ?? "mcp")
            : method === "item/fileChange/requestApproval" || method === "applyPatchApproval"
            ? "edit"
            : isQuestion
              ? "ask_user"
              : "shell";
        if (config.fullAuto && !isQuestion) {
          return send({
            jsonrpc: "2.0",
            id: msg.id,
            result: isMcpElicitation
              ? { action: "accept", content: {} }
              : { decision: legacy ? "approved" : "accept" },
          });
        }
        const requestId = newId();
        const summary =
          isMcpElicitation && typeof params.message === "string"
            ? params.message
            : typeof params.command === "string"
            ? params.command
            : Array.isArray(params.questions)
              ? params.questions.map((q: any) => q.question ?? q.header).filter(Boolean).join(" · ")
              : typeof params.reason === "string"
                ? params.reason
                : tool;
        const choices = isQuestion
          ? (params.questions?.[0]?.options ?? []).map((o: any) => o.label).slice(0, 5)
          : undefined;
        const finish = (behavior: "allow" | "deny" | "answer", message?: string, source: "user" | "timeout" | "system" = "user") => {
          if (!asks.delete(requestId)) return;
          clearTimeout(timer);
          if (isQuestion) {
            const answers: Record<string, { answers: string[] }> = {};
            for (const q of Array.isArray(params.questions) ? params.questions : []) {
              answers[q.id] = { answers: [message || QUESTION_TIMEOUT_NOTE] };
            }
            send({ jsonrpc: "2.0", id: msg.id, result: { answers } });
          } else {
            send({
              jsonrpc: "2.0",
              id: msg.id,
              result: isMcpElicitation
                ? behavior === "allow"
                  ? { action: "accept", content: {} }
                  : { action: "decline" }
                : { decision: behavior === "allow" ? (legacy ? "approved" : "accept") : legacy ? "denied" : "decline" },
            });
          }
          emit({ ...base(threadId, turnId), type: "request.resolved", requestId, behavior, source });
        };
        const timer = setTimeout(
          () => (isQuestion ? finish("answer", QUESTION_TIMEOUT_NOTE, "timeout") : finish("deny", DENY_TIMEOUT_NOTE, "timeout")),
          15 * 60_000,
        );
        timer.unref?.();
        asks.set(requestId, finish);
        emit({
          ...base(threadId, turnId),
          type: "request.opened",
          requestId,
          requestType: isQuestion ? "question" : "permission",
          tool,
          summary,
          choices,
          approvalScope: controlsHost ? "local-computer" : undefined,
        });
      };

      const handleNotification = (msg: any) => {
        const p = msg.params ?? {};
        switch (msg.method) {
          // token-level chat text; the item/completed frame follows with the
          // whole message, so its delta is only a fallback when none streamed
          case "item/agentMessage/delta": {
            const delta = typeof p.delta === "string" ? p.delta : "";
            if (delta) {
              state.sawStreamDelta = true;
              emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "assistant_text", delta });
            }
            break;
          }
          case "item/reasoning/textDelta":
          case "item/reasoning/summaryTextDelta": {
            const delta = typeof p.delta === "string" ? p.delta : "";
            if (delta) emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "reasoning_text", delta });
            break;
          }
          case "item/started": {
            const item = p.item ?? {};
            const title =
              item.type === "commandExecution"
                ? String(item.command ?? "shell")
                : item.type === "fileChange"
                  ? "edit"
                  : item.type === "mcpToolCall"
                    ? (item.tool ?? item.name ?? "mcp")
                    : item.type === "webSearch"
                      ? "web_search"
                      : null;
            if (title) emit({ ...base(threadId, turnId), type: "item.started", itemType: "tool", itemId: item.id, title });
            break;
          }
          case "item/completed": {
            const item = p.item ?? {};
            if (item.type === "agentMessage") {
              if (item.text?.trim()) {
                state.lastText = item.text;
                if (!state.sawStreamDelta) {
                  emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "assistant_text", delta: item.text });
                }
                state.sawStreamDelta = false;
                emit({ ...base(threadId, turnId), type: "item.completed", itemType: "assistant_text", text: item.text });
              }
            } else if (item.type === "imageGeneration" && item.status !== "failed") {
              // Current Codex app-server (the same schema consumed by T3
              // Code) returns the generated raster as base64 `result` and
              // may also expose a local `savedPath`. Use bytes, never the
              // provider-owned path: the harness will validate and copy
              // them into its private attachment store.
              if (typeof item.result === "string" && item.result.trim()) {
                emit({
                  ...base(threadId, turnId),
                  type: "item.completed",
                  itemType: "assistant_image",
                  itemId: item.id,
                  data: item.result,
                  alt: typeof item.revisedPrompt === "string" ? item.revisedPrompt : undefined,
                });
              }
            } else if (["commandExecution", "fileChange", "mcpToolCall", "webSearch"].includes(item.type)) {
              emit({
                ...base(threadId, turnId),
                type: "item.completed",
                itemType: "tool",
                itemId: item.id,
                ok: item.status !== "failed" && item.status !== "declined",
              });
            } else if (item.type === "reasoning") {
              emit({ ...base(threadId, turnId), type: "item.updated", itemType: "reasoning", tokens: null });
            }
            break;
          }
          case "thread/tokenUsage/updated": {
            // `last` is the most recent turn when the server sends it;
            // `total` is the thread so far — a fresh app-server per turn
            // makes that this turn's figure too
            const turnUsage = p.tokenUsage?.last ?? p.tokenUsage?.total;
            // codex's inputTokens already includes cachedInputTokens; the
            // cached share is carried alongside so the UI can say how much
            // of a turn was context re-read rather than new text
            if (turnUsage) {
              state.usage = {
                input: turnUsage.inputTokens ?? 0,
                output: turnUsage.outputTokens ?? 0,
                ...(typeof turnUsage.cachedInputTokens === "number"
                  ? { cachedInput: turnUsage.cachedInputTokens }
                  : {}),
              };
            }
            const t = p.tokenUsage?.total;
            if (t) {
              emit({
                ...base(threadId, turnId),
                type: "thread.token-usage.updated",
                input: t.inputTokens ?? 0,
                output: t.outputTokens ?? 0,
                ...(typeof t.cachedInputTokens === "number"
                  ? { cachedInput: t.cachedInputTokens }
                  : {}),
              });
            }
            break;
          }
          case "turn/completed": {
            const t = p.turn ?? {};
            settle(t.status === "completed", t.status === "completed" ? null : (t.error?.message ?? t.status ?? "failed"));
            break;
          }
          case "error":
            // shape drift: 0.144 sends {message}, 0.139 nests it under
            // {error:{message}} — surface either (agentcal armor)
            {
              const message = p.message ?? p.error?.message;
              if (message) emit({ ...base(threadId, turnId), type: "runtime.error", message: String(message).slice(0, 400) });
            }
            break;
        }
      };

      let buf = "";
      // decode as UTF-8 across chunk boundaries — a raw `buf += chunk` splits
      // multibyte characters that straddle two reads and corrupts the text
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
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
          const loggedMessage = msg.method === "item/completed" && msg.params?.item?.type === "imageGeneration"
            ? {
                ...msg,
                params: {
                  ...msg.params,
                  item: {
                    ...msg.params.item,
                    result: `[generated image omitted · ${String(msg.params.item.result ?? "").length} base64 chars]`,
                    savedPath: undefined,
                  },
                },
              }
            : msg;
          appendNative(threadId, { dir: "in", source: "codex.app-server", msg: loggedMessage });
          if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
            const pend = rpcPending.get(msg.id);
            if (pend) {
              rpcPending.delete(msg.id);
              msg.error ? pend.reject(new Error(msg.error.message ?? JSON.stringify(msg.error))) : pend.resolve(msg.result);
            }
          } else if (msg.id !== undefined && msg.method) {
            handleServerRequest(msg);
          } else if (msg.method) {
            handleNotification(msg);
          }
        }
      });

      let stderr = "";
      child.stderr.on("data", (c) => {
        stderr += c;
        if (stderr.length > 8192) stderr = stderr.slice(-8192);
      });
      child.on("error", (e) => {
        if (abandoned) return;
        emit({ ...base(threadId, turnId), type: "runtime.error", ...describeSpawnFailure(e, config.cli) });
        settle(false, "spawn_error");
      });
      child.on("close", (code) => {
        if (abandoned) return;
        if (!state.settled) {
          emit({
            ...base(threadId, turnId),
            type: "runtime.error",
            message: `codex exited ${code} before turn/completed${stderr ? `: ${stderr.trim().slice(-300)}` : ""}`,
          });
          settle(false, "exit_before_result");
        }
      });

      active.set(threadId, { stop, turnId, asks });
      // Relaunching the app-server is still the same logical turn. Keep the
      // active process current on every attempt, but announce the turn once.
      if (attempt === 0) emit({ ...base(threadId, turnId), type: "turn.started" });

      // handshake + kickoff; a transient failure (5xx/overloaded/reset) gets
      // one relaunch of the whole app-server after backoff — but only when
      // nothing streamed yet, and never for auth/shape errors or interrupts
      try {
        await request("initialize", { clientInfo: { name: "openmausbot", version: "1" } });
        send({ jsonrpc: "2.0", method: "initialized", params: {} });
        const cursor = typeof turn.resumeCursor === "string" ? turn.resumeCursor : null;
        let codexThreadId: string | null = null;
        let startedModel: string | null = null;
        if (cursor) {
          try {
            const resumed = await request("thread/resume", { threadId: cursor });
            codexThreadId = resumed?.thread?.id ?? cursor;
          } catch {
            /* resume unsupported or thread gone — start fresh below */
          }
        }
        if (!codexThreadId) {
          const selection = decodeCodexSelection(turn.model);
          const started = await request("thread/start", {
            cwd: turn.cwd ?? homedir(),
            model: selection.model,
            ...(selection.modelProvider ? { modelProvider: selection.modelProvider } : {}),
            sandbox: config.fullAuto ? "danger-full-access" : "workspace-write",
            approvalPolicy: config.fullAuto ? "never" : "on-request",
            ephemeral: false,
          });
          codexThreadId = started?.thread?.id ?? null;
          startedModel = started?.model ?? null;
        }
        emit({ ...base(threadId, turnId), type: "session.started", sessionId: codexThreadId, model: startedModel ?? turn.model ?? null });
        await request("turn/start", {
          threadId: codexThreadId,
          input: [{ type: "text", text: turn.system ? `${turn.system}\n\n${turn.text}` : turn.text }],
          // Spread, not `effort: turn.effort ?? null`. Probed against
          // codex-cli 0.146.0: null is indistinguishable from an absent key
          // — both leave the thread's current effort alone, emitting no
          // thread/settings/updated, and thread/resume reads the old value
          // back. The app-server offers no way to clear a level either:
          // "" is rejected outright and thread/start takes no effort at
          // all. So a thread keeps the last level it was sent until it is
          // sent another, and choosing Default lands on the bot's next new
          // thread rather than the current one.
          ...(turn.effort ? { effort: turn.effort } : {}),
        });
      } catch (e) {
        const failure = e instanceof Error ? e : { text: String(e) };
        const message = e instanceof Error ? e.message : String(e);
        const needsAuth = /(?:\b401\b|unauthorized|missing bearer|authentication required)/i.test(message);
        const verdict = classifyError(failure);
        if (!state.settled && !needsAuth && verdict.transient && attempt < RETRY_MAX_ATTEMPTS - 1 && state.sawStreamDelta === false) {
          const delayMs = computeBackoff(attempt);
          attempt++;
          emit({
            ...base(threadId, turnId),
            type: "turn.retrying",
            attempt,
            delayMs,
            reason: verdict.reason,
          });
          // This app-server never exits by itself. Retire the failed attempt
          // and silence its late handlers before the replacement launches.
          abandoned = true;
          killCliTree(child);
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, Math.max(1, Math.round(delayMs * retryScale)));
            timer.unref?.();
          });
          if (!stopRequested) {
            void launchAttempt(attempt).catch(() => {});
          } else {
            settle(false, "interrupted");
          }
          return;
        }
        if (!state.settled) {
          emit({
            ...base(threadId, turnId),
            type: "runtime.error",
            message,
            ...(needsAuth ? { setup: true } : {}),
          });
          settle(false, needsAuth ? "auth_required" : "rpc_error");
        }
      }
    };

    void launchAttempt(0).catch(() => {});
    return { turnId };
  };

  const snapshot = async (): Promise<ProviderSnapshot> => {
    const env = childEnv();
    const version = await new Promise<string | null>((resolve) => {
      execCli(config.cli, ["--version"], { timeout: 8000, env }, (err, stdout) =>
        resolve(err ? null : stdout.trim()),
      );
    });
    if (!version) return { state: "unavailable", reason: `\`${config.cli}\` CLI not found` };
    const authenticated = await new Promise<boolean>((resolve) => {
      execCli(config.cli, ["login", "status"], { timeout: 8000, env }, (err, stdout, stderr) =>
        resolve(!err && /^logged in\b/im.test(`${stdout}\n${stderr ?? ""}`)),
      );
    });
    // childEnv drops OPENAI_API_KEY on purpose — turns run on the ChatGPT login
    return { state: "available", version, authenticated, billing: "subscription" };
  };

  return {
    instanceId,
    driverKind: DRIVER_KIND,
    displayName: input.displayName,
    enabled: input.enabled,
    get models() {
      return models;
    },
    refreshModels,
    snapshot,
    adapter: {
      provider: DRIVER_KIND,
      capabilities: {
        sessionModelSwitch: "unsupported",
        computerMcp: true,
        localComputerMcp: true,
        composioMcp: true,
        agentsMcp: true,
      customMcp: true,
        phoneMcp: true,
        browserMcp: true,
        images: true,
        effortLevels: ["low", "medium", "high", "xhigh", "max"],
      },
      sendTurn,
      interruptTurn: async (threadId) => active.get(threadId)?.stop(),
      respondToRequest: async (threadId, requestId, decision) => {
        const turn = active.get(threadId);
        const finish = turn?.asks.get(requestId);
        if (!finish) return "unavailable"; // settled, timed out, or turn gone
        finish(decision.behavior, decision.message, "user");
        return decision.behavior === "allow" ? "allowed-once" : decision.behavior === "answer" ? "answered" : "rejected";
      },
      hasSession: (threadId) => active.has(threadId),
      stopAll: async () => {
        for (const { stop } of active.values()) stop();
      },
      onEvent: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    reviewPermission: (prompt, signal) => runCodexPermissionReview(config.cli, childEnv(), prompt, signal),
    dispose: async () => {
      for (const { stop } of active.values()) stop();
      listeners.clear();
    },
  };
},
};
