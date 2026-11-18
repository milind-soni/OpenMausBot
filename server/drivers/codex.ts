import type { ChildProcess } from "node:child_process";
import { classifyCodexUsage } from "../usage-classifiers.ts";
import type { UsageLimitFailure } from "../usage-types.ts";
import { readCodexUsage } from "./codex-usage.ts";
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
import { homedir } from "node:os";

import { execCli, killCliTree, spawnCli } from "../procs.ts";

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
import { augmentedPath } from "../env-path.ts";
import { appendNative } from "./native.ts";
import { discoverCodexModels } from "../model-discovery.ts";

const DRIVER_KIND = "codex";

// catalog ported from upstream packages/contracts/src/model.ts
const MODELS = {
  default: "gpt-5.6-sol",
  options: [
    { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
    { id: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
    { id: "gpt-5.4", label: "GPT-5.4" },
  ],
};

export interface CodexConfig {
  cli: string;
  fullAuto: boolean;
}

function decodeConfig(raw: unknown): CodexConfig {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    cli: typeof o.cli === "string" ? o.cli : "codex",
    fullAuto: o.fullAuto === true,
  };
}

// Codex's app-server has no per-thread "mcpServers" RPC param (unlike ACP's
// session/new) — MCP servers only come from ~/.codex/config.toml. `-c
// key=value` (TOML-parsed) overrides that config for just this spawned
// process without ever touching the file on disk, so a per-turn server
// (the agents-proxy, with its per-boot bearer token) can still be injected
// safely. Verified against codex-cli 0.147.0 via mcpServerStatus/list.
const tomlString = (value: string): string => JSON.stringify(value);
const tomlArray = (values: string[]): string => `[${values.map(tomlString).join(",")}]`;
const tomlInlineTable = (entries: Record<string, string>): string =>
  `{${Object.entries(entries).map(([k, v]) => `${k}=${tomlString(v)}`).join(",")}}`;

/** Namespaced (not just "agents") so a `-c` override can never collide with
 * an MCP server the user has genuinely configured under that name. */
const AGENTS_MCP_KEY = "gbs_agents";

function agentsConfigOverrides(agents: { command: string; args: string[]; env: Record<string, string> }): string[] {
  const flags = ["-c", `mcp_servers.${AGENTS_MCP_KEY}.command=${tomlString(agents.command)}`];
  if (agents.args.length) flags.push("-c", `mcp_servers.${AGENTS_MCP_KEY}.args=${tomlArray(agents.args)}`);
  if (Object.keys(agents.env).length) flags.push("-c", `mcp_servers.${AGENTS_MCP_KEY}.env=${tomlInlineTable(agents.env)}`);
  return flags;
}

const QUESTION_TIMEOUT_NOTE = "No answer was given — use your best judgment.";
const DENY_TIMEOUT_NOTE =
  "Gerer Build Studio: nobody answered this permission request in time. Skip this action and finish what you can without it.";

export const CodexDriver: ProviderDriver<CodexConfig> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Codex", supportsMultipleInstances: true },
  models: MODELS,
  decodeConfig,
  defaultConfig: () => decodeConfig({}),
  getAutoApprove: (config) => config.fullAuto,
  setAutoApprove: (config, autoApprove) => ({ ...config, fullAuto: autoApprove }),

  async create(input: DriverCreateInput<CodexConfig>): Promise<ProviderInstance> {
    const { instanceId, config } = input;
    const listeners = new Set<RuntimeEventListener>();
    interface Turn {
      stop: () => void;
      turnId: string;
      steer: (text: string) => Promise<void>;
      asks: Map<string, (behavior: string, message?: string) => void>;
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

    const usageChildren = new Set<ChildProcess>();
    let disposed = false;
    const reportUsage = (payload: unknown, threadId = "", turnId = "") => {
      const classified = classifyCodexUsage(payload);
      if (classified.usage) emit({ ...base(threadId, turnId), type: "usage.updated", usage: classified.usage });
      return classified.failure;
    };
    const refreshUsage = async () => {
      if (disposed || active.size) return;
      try {
        const payload = await readCodexUsage(config.cli, child => {
          usageChildren.add(child);
          return () => usageChildren.delete(child);
        });
        if (!disposed) reportUsage(payload);
      } catch {
        if (!disposed) emit({ ...base("", ""), type: "usage.updated", usage: { source: "reported", status: "unknown" } });
      }
    };

    const sendTurn = async (turn: SendTurnInput) => {
      const { threadId } = turn;
      if (active.has(threadId)) throw new Error("a turn is already running on this thread");
      const turnId = newId();

      const env: Record<string, string | undefined> = { ...process.env, ...input.environment, PATH: augmentedPath(), NPM_CONFIG_LOGLEVEL: "error" };
      // the CLI owns its own ChatGPT login; a leaked API key silently flips
      // billing to pay-as-you-go (agentcal)
      delete env.OPENAI_API_KEY;

      const appServerArgs = ["app-server", ...(turn.integrations?.agents ? agentsConfigOverrides(turn.integrations.agents) : [])];
      const child = spawnCli(config.cli, appServerArgs, {
        cwd: turn.cwd ?? homedir(),
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });

      let failure: UsageLimitFailure | undefined;
      let failureReported = false;
      const state = { settled: false, lastText: "", sawStreamDelta: false };
      const asks = new Map<string, (behavior: string, message?: string) => void>();
      let nextId = 1;
      const rpcPending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

      const send = (obj: unknown) => {
        try {
          child.stdin.write(JSON.stringify(obj) + "\n");
        } catch {}
        appendNative(threadId, { dir: "out", source: "codex.app-server", msg: obj });
      };
      const request = (method: string, params: unknown) =>
        new Promise<any>((resolve, reject) => {
          const id = nextId++;
          rpcPending.set(id, { resolve, reject });
          send({ jsonrpc: "2.0", id, method, params });
        });

      const stop = () => killCliTree(child);

      const settle = (ok: boolean, stopReason: string | null) => {
        if (state.settled) return;
        state.settled = true;
        for (const finish of [...asks.values()]) finish("deny", "Gerer Build Studio: the turn ended");
        for (const p of rpcPending.values()) p.reject(new Error("turn settled"));
        rpcPending.clear();
        active.delete(threadId);
        emit({ ...base(threadId, turnId), type: "turn.completed", ok, stopReason, cost: null, failure });
        stop(); // the app-server never exits on its own
      };

      // MCP elicitations answer with {action, content}, not {decision} — codex
      // rejects the tool call when it can't deserialize the reply.
      const answerElicitation = (id: unknown, accept: boolean) =>
        send({ jsonrpc: "2.0", id, result: { action: accept ? "accept" : "decline", content: accept ? {} : null } });

      // server→client approval request → canonical request.opened
      const handleServerRequest = (msg: any) => {
        const method = msg.method as string;
        const params = msg.params ?? {};
        if (method === "mcpServer/elicitation/request") {
          const toolApproval = params._meta?.codex_approval_kind === "mcp_tool_call";
          // only tool-call approvals can be answered; a real form needs input we can't give
          if (!toolApproval) return answerElicitation(msg.id, false);
          // our own agents-proxy is pre-approved, as mcp__agents is for claude
          if (config.fullAuto || params.serverName === AGENTS_MCP_KEY) return answerElicitation(msg.id, true);
        }
        const elicitation = method === "mcpServer/elicitation/request";
        const legacy = method === "execCommandApproval" || method === "applyPatchApproval";
        const isQuestion = method === "item/tool/requestUserInput";
        const tool =
          method === "item/fileChange/requestApproval" || method === "applyPatchApproval"
            ? "edit"
            : isQuestion
              ? "ask_user"
              : elicitation
                ? "mcp"
                : "shell";
        if (config.fullAuto && !isQuestion) {
          return send({ jsonrpc: "2.0", id: msg.id, result: { decision: legacy ? "approved" : "accept" } });
        }
        const requestId = newId();
        const summary =
          typeof params.command === "string"
            ? params.command.slice(0, 200)
            : Array.isArray(params.questions)
              ? params.questions.map((q: any) => q.question ?? q.header).filter(Boolean).join(" · ")
              : elicitation && typeof params.message === "string"
                ? params.message
                : typeof params.reason === "string"
                ? params.reason
                : tool;
        const choices = isQuestion
          ? (params.questions?.[0]?.options ?? []).map((o: any) => o.label).slice(0, 5)
          : undefined;
        const finish = (behavior: string, message?: string) => {
          if (!asks.delete(requestId)) return;
          clearTimeout(timer);
          if (isQuestion) {
            const answers: Record<string, { answers: string[] }> = {};
            for (const q of Array.isArray(params.questions) ? params.questions : []) {
              answers[q.id] = { answers: [message || QUESTION_TIMEOUT_NOTE] };
            }
            send({ jsonrpc: "2.0", id: msg.id, result: { answers } });
          } else if (elicitation) {
            answerElicitation(msg.id, behavior === "allow");
          } else {
            send({
              jsonrpc: "2.0",
              id: msg.id,
              result: { decision: behavior === "allow" ? (legacy ? "approved" : "accept") : legacy ? "denied" : "decline" },
            });
          }
          emit({ ...base(threadId, turnId), type: "request.resolved", requestId, behavior, source: "user" });
        };
        const timer = setTimeout(
          () => (isQuestion ? finish("answer", QUESTION_TIMEOUT_NOTE) : finish("deny", DENY_TIMEOUT_NOTE)),
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
        });
      };

      const handleNotification = (msg: any) => {
        const p = msg.params ?? {};
        failure = reportUsage(msg, threadId, turnId) ?? failure;
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
                ? String(item.command ?? "shell").slice(0, 80)
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
            } else if (["commandExecution", "fileChange", "mcpToolCall"].includes(item.type)) {
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
            const t = p.tokenUsage?.total;
            if (t) {
              emit({
                ...base(threadId, turnId),
                type: "thread.token-usage.updated",
                input: t.inputTokens ?? 0,
                output: t.outputTokens ?? 0,
              });
            }
            break;
          }
          case "turn/completed": {
            const t = p.turn ?? {};
            if (t.status === "completed") failure = undefined;
            else if (failure && !failureReported) {
              emit({ ...base(threadId, turnId), type: "runtime.error", message: "This AI app’s usage ran out.", failure });
              failureReported = true;
            }
            settle(t.status === "completed", t.status === "completed" ? null : (t.error?.message ?? t.status ?? "failed"));
            break;
          }
          case "error":
            // shape drift: 0.144 sends {message}, 0.139 nests it under
            // {error:{message}} — surface either (agentcal armor)
            {
              const message = p.message ?? p.error?.message;
              if (message) {
                emit({ ...base(threadId, turnId), type: "runtime.error", message: String(message).slice(0, 400), failure });
                if (failure) failureReported = true;
              }
            }
            break;
        }
      };

      let buf = "";
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
          appendNative(threadId, { dir: "in", source: "codex.app-server", msg });
          if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
            const pend = rpcPending.get(msg.id);
            if (pend) {
              rpcPending.delete(msg.id);
              if (msg.error) {
                failure = reportUsage(msg, threadId, turnId) ?? failure;
                pend.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
              } else pend.resolve(msg.result);
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
        emit({ ...base(threadId, turnId), type: "runtime.error", message: `spawn failed: ${e.message}` });
        settle(false, "spawn_error");
      });
      child.on("close", (code) => {
        if (!state.settled) {
          emit({
            ...base(threadId, turnId),
            type: "runtime.error",
            message: `codex exited ${code} before turn/completed${stderr ? `: ${stderr.trim().slice(-300)}` : ""}`,
          });
          settle(false, "exit_before_result");
        }
      });

      let nativeThreadId: string | null = null;
      let nativeTurnId: string | null = null;
      let ready: Promise<void>;
      const steer = async (text: string) => {
        await ready;
        if (state.settled || !nativeThreadId || !nativeTurnId) throw new Error("The turn has ended or is not ready");
        await request("turn/steer", { threadId: nativeThreadId, expectedTurnId: nativeTurnId, input: [{ type: "text", text }] });
      };
      child.stdin.on("error", () => {});
      active.set(threadId, { stop, turnId, asks, steer });
      emit({ ...base(threadId, turnId), type: "turn.started" });

      // handshake + kickoff; any refusal surfaces as failure, not a hang
      ready = (async () => {
        try {
          await request("initialize", { clientInfo: { name: "gerer-build-studio", version: "1" } });
          send({ jsonrpc: "2.0", method: "initialized", params: {} });
          // A failed/unsupported read must never prevent a conversation.
          void request("account/rateLimits/read", {}).then(result => reportUsage({ result }, threadId, turnId)).catch(() => {});
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
            const started = await request("thread/start", {
              cwd: turn.cwd ?? homedir(),
              model: turn.model || null,
              sandbox: config.fullAuto ? "danger-full-access" : "workspace-write",
              approvalPolicy: config.fullAuto ? "never" : "on-request",
              ephemeral: false,
            });
            codexThreadId = started?.thread?.id ?? null;
            startedModel = started?.model ?? null;
          }
          emit({ ...base(threadId, turnId), type: "session.started", sessionId: codexThreadId, model: startedModel ?? turn.model ?? null });
          nativeThreadId = codexThreadId;
          const startedTurn = await request("turn/start", {
            threadId: codexThreadId,
            input: [{ type: "text", text: turn.system ? `${turn.system}\n\n${turn.text}` : turn.text }],
          });
          nativeTurnId = startedTurn?.turn?.id ?? null;
        } catch (e) {
          if (!state.settled) {
            emit({ ...base(threadId, turnId), type: "runtime.error", message: (e as Error).message });
            settle(false, "rpc_error");
          }
        }
      })();

      return { turnId };
    };

    const snapshot = async (): Promise<ProviderSnapshot> => {
      const version = await new Promise<string | null>((resolve) => {
        execCli(config.cli, ["--version"], { timeout: 8000, env: { ...process.env, PATH: augmentedPath() } }, (err, stdout) =>
          resolve(err ? null : stdout.trim()),
        );
      });
      if (!version) return { state: "unavailable", reason: `\`${config.cli}\` CLI not found` };
      return { state: "available", version };
    };

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      displayName: input.displayName,
      enabled: input.enabled,
      models: MODELS,
      discoverModels: () => discoverCodexModels(config.cli),
      snapshot,
      adapter: {
        provider: DRIVER_KIND,
        capabilities: { sessionModelSwitch: "unsupported", agentsMcp: true },
        sendTurn,
        refreshUsage,
        interruptTurn: async (threadId) => active.get(threadId)?.stop(),
        steerTurn: async (threadId, text) => {
          const turn = active.get(threadId);
          if (!turn) throw new Error("The turn has ended");
          await turn.steer(text);
        },
        respondToRequest: async (threadId, requestId, decision) => {
          const turn = active.get(threadId);
          const finish = turn?.asks.get(requestId);
          if (!finish) throw new Error("no such pending request");
          finish(decision.behavior, decision.message);
        },
        hasSession: (threadId) => active.has(threadId),
        stopAll: async () => {
          for (const child of usageChildren) killCliTree(child);
          for (const { stop } of active.values()) stop();
        },
        onEvent: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      dispose: async () => {
        disposed = true;
        for (const child of usageChildren) killCliTree(child);
        for (const { stop } of active.values()) stop();
        listeners.clear();
      },
    };
  },
};
