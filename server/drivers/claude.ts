import { classifyClaudeAccountUsage, classifyClaudeUsage } from "../usage-classifiers.ts";
import { readClaudeAccountUsage } from "./account-usage.ts";
import type { UsageLimitFailure } from "../usage-types.ts";
// Claude driver — upstream ClaudeDriver skeleton over agentcal's
// drivers/claude.js runtime (stream-json both directions, prompt over
// stdin, completion from a real `result` event — verified against
// claude 2.1.211 by agentcal). Per-turn CLI process; the conversation
// continues across turns via --resume <sessionId> (the resumeCursor).
//
// Integrations become MCP servers on the CLI.
import { existsSync, unlinkSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { DATA_DIR } from "../config.ts";
import { augmentedPath } from "../env-path.ts";
import { brokerSocketPath, execCli, killCliTree, spawnCli } from "../procs.ts";

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
import { appendNative } from "./native.ts";
import { discoverClaudeModels } from "../model-discovery.ts";

const DRIVER_KIND = "claudeAgent";

export interface ClaudeConfig {
  cli: string;
  permissionMode: "acceptEdits" | "auto" | "bypassPermissions";
}

// model catalog ported from upstream packages/contracts/src/model.ts
const MODELS = {
  default: "claude-sonnet-5",
  options: [
    { id: "claude-fable-5", label: "Claude Fable 5" },
    { id: "claude-opus-5", label: "Claude Opus 5" },
    { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
    { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
  ],
};

// proxy entry files live next to this one as .ts in dev (node type
// stripping) and .js in the compiled dist-server the packaged app ships
const proxyPath = (basename: string) => {
  const ts = join(dirname(fileURLToPath(import.meta.url)), "..", `${basename}.ts`);
  return existsSync(ts) ? ts : ts.replace(/\.ts$/, ".js");
};
const PERM_PROXY_PATH = proxyPath("permission-proxy");
// in the packaged app process.execPath is the Electron binary — this env
// makes it behave as plain node for the spawned MCP proxies (harmless in dev)
const NODE_ENV_FLAG = { ELECTRON_RUN_AS_NODE: "1" };

// ── permission broker (ported from agentcal drivers/claude.js) ─────────
// A headless run that hits a permission acceptEdits doesn't cover should
// neither stall silently NOR get blanket-denied — it should ask the user.
// The broker is a net server on a per-turn socket; the proxy (spawned by
// the claude CLI) forwards asks over it and waits. Unanswered permission
// asks deny after timeoutMs with a keep-moving note; unanswered questions
// answer with "use your best judgment" — guidance, never a block.
interface Ask {
  id: string;
  kind: "permission" | "question";
  tool: string;
  input: Record<string, unknown>;
  at: number;
}

/*
const DENY_TIMEOUT_NOTE =
  "Gerer Build Studio: nobody answered this permission request in time. Skip this action and finish what you can without it.";
const QUESTION_TIMEOUT_NOTE = "Gerer Build Studio: nobody answered in time. Use your best judgment and continue.";
*/

/** One human-readable line for an ask — what the card subtitle shows. */
function askSummary(ask: Ask): string {
  const input = ask.input ?? {};
  if (typeof input.question === "string") return input.question.slice(0, 300);
  if (typeof input.command === "string") return input.command.slice(0, 200);
  if (typeof input.url === "string") return input.url.slice(0, 200);
  const text = JSON.stringify(input);
  return text === "{}" ? (ask.tool ?? "tool") : text.slice(0, 200);
}

function permissionSocketPath(threadId: string) {
  const tag = threadId.replace(/[^\w-]/g, "").slice(0, 8);
  return brokerSocketPath(DATA_DIR, tag);
}

function createPermissionBroker(opts: {
  socketPath: string;
  onAsk: (ask: Ask) => void;
  onResolve: (resolved: Ask & { behavior: string; source: string }) => void;
  timeoutMs?: number;
}) {
  // const timeoutMs = opts.timeoutMs ?? 15 * 60_000;
  const pending = new Map<string, { ask: Ask; finish: (behavior: string, message: string | undefined, source: string) => void }>();
  try {
    unlinkSync(opts.socketPath);
  } catch {}
  const server = createNetServer((conn) => {
    conn.on("error", () => {});
    let buf = "";
    conn.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.t !== "ask") continue;
        const askId = String(msg.id ?? newId());
        const kind = msg.kind === "question" ? ("question" as const) : ("permission" as const);
        const ask: Ask = { id: askId, kind, tool: msg.tool ?? "tool", input: msg.input ?? {}, at: Date.now() };
        const finish = (behavior: string, message: string | undefined, source: string) => {
          if (!pending.delete(askId)) return;
          // clearTimeout(timer);
          try {
            conn.write(JSON.stringify({ t: "answer", id: askId, behavior, message }) + "\n");
          } catch {}
          opts.onResolve({ ...ask, behavior, source });
        };
        // timeout disabled by user request
        /*
        const timer = setTimeout(
          () =>
            kind === "question"
              ? finish("answer", QUESTION_TIMEOUT_NOTE, "timeout")
              : finish("deny", DENY_TIMEOUT_NOTE, "timeout"),
          timeoutMs,
        );
        timer.unref?.();
        */
        pending.set(askId, { ask, finish });
        opts.onAsk(ask);
      }
    });
  });
  server.on("error", () => {});
  server.listen(opts.socketPath);
  return {
    answer(askId: string, behavior: string, message?: string): boolean {
      const p = pending.get(askId);
      if (!p) return false;
      const valid = p.ask.kind === "question" ? ["answer"] : ["allow", "deny"];
      if (!valid.includes(behavior)) return false;
      p.finish(behavior, message, "user");
      return true;
    },
    close() {
      for (const p of [...pending.values()]) {
        if (p.ask.kind === "question") p.finish("answer", "Gerer Build Studio: the turn is ending — wrap up.", "shutdown");
        else p.finish("deny", "Gerer Build Studio: the turn ended", "shutdown");
      }
      try {
        server.close();
      } catch {}
      try {
        unlinkSync(opts.socketPath);
      } catch {}
    },
  };
}

function decodeConfig(raw: unknown): ClaudeConfig {
  const o = (raw ?? {}) as Record<string, unknown>;
  const mode = o.permissionMode;
  if (mode !== undefined && mode !== "acceptEdits" && mode !== "auto" && mode !== "bypassPermissions") {
    throw new Error(`claude: invalid permissionMode ${JSON.stringify(mode)}`);
  }
  return {
    cli: typeof o.cli === "string" ? o.cli : "claude",
    permissionMode: (mode as ClaudeConfig["permissionMode"]) ?? "acceptEdits",
  };
}

const runsAsRoot = () => process.getuid?.() === 0;
const effectivePermissionMode = (config: ClaudeConfig) =>
  config.permissionMode === "bypassPermissions" && runsAsRoot() ? "acceptEdits" : config.permissionMode;

function firstText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b?.type === "text" && b.text)
      .map((b) => b.text)
      .join("");
  }
  return "";
}

export const ClaudeDriver: ProviderDriver<ClaudeConfig> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Claude", supportsMultipleInstances: true },
  models: MODELS,
  decodeConfig,
  defaultConfig: () => decodeConfig({}),
  getAutoApprove: (config) => effectivePermissionMode(config) === "bypassPermissions",
  setAutoApprove: (config, autoApprove) => ({
    ...config,
    permissionMode: autoApprove ? "bypassPermissions" : "acceptEdits",
  }),

  async create(input: DriverCreateInput<ClaudeConfig>): Promise<ProviderInstance> {
    const { instanceId, config } = input;
    const listeners = new Set<RuntimeEventListener>();
    // one active turn per thread; a second send while busy is a caller bug
    const active = new Map<string, { stop: () => void; turnId: string; steer: (text: string) => Promise<void>; broker?: ReturnType<typeof createPermissionBroker> }>();

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
      const { threadId } = turn;
      if (active.has(threadId)) throw new Error("a turn is already running on this thread");
      const turnId = newId();
      const sessionId = typeof turn.resumeCursor === "string" ? turn.resumeCursor : null;
      const newSessionId = sessionId ? null : newId();
      const permissionMode = effectivePermissionMode(config);

      const args = [
        "-p",
        "--output-format", "stream-json",
        "--input-format", "stream-json",
        "--verbose", // required by stream-json output
        // token-level streaming: content_block_delta events between the
        // whole-message frames, so the bubble grows as the model writes
        "--include-partial-messages",
        "--permission-mode", permissionMode === "auto" ? "acceptEdits" : permissionMode,
      ];
      if (sessionId) args.push("--resume", sessionId);
      else args.push("--session-id", newSessionId!);
      if (turn.model) args.push("--model", turn.model);
      if (turn.system) args.push("--append-system-prompt", turn.system);

      // integrations → MCP servers; pre-allow their tools (a headless
      // acceptEdits run silently denies anything unlisted)
      const mcpServers: Record<string, unknown> = {};
      const allowed: string[] = [];
      if (turn.integrations?.localComputer) {
        // this Mac, via the Electron-owned cua-driver daemon (spawn config
        // read from cua-connection.json — same "computer" name either way,
        // the agent just sees a computer)
        mcpServers.computer = { ...turn.integrations.localComputer };
        allowed.push("mcp__computer");
      }
      // peer-agent comms (list_bots/ask_bot) — the harness builds the whole
      // spawn contract (command/args/env incl. the boot token) in
      // agentsIntegration(); pre-allowing matters doubly here, or the CLI's
      // own ListAgents look-alike shadows it and "@Bot" asks go nowhere
      if (turn.integrations?.agents) {
        mcpServers.agents = { ...turn.integrations.agents };
        allowed.push("mcp__agents");
      }
      // permission broker: anything acceptEdits would silently deny becomes
      // an Allow/Deny card in chat, and the agent gets ask_user. Skipped in
      // bypassPermissions (fullAuto) — nothing would ever ask.
      let broker: ReturnType<typeof createPermissionBroker> | undefined;
      if (permissionMode !== "bypassPermissions") {
        const socketPath = permissionSocketPath(threadId);
        broker = createPermissionBroker({
          socketPath,
          onAsk: (ask) =>
            emit({
              ...base(threadId, turnId),
              type: "request.opened",
              requestId: ask.id,
              requestType: ask.kind,
              tool: ask.tool,
              summary: askSummary(ask),
              choices: Array.isArray(ask.input?.choices) ? (ask.input.choices as string[]).slice(0, 5) : undefined,
            }),
          onResolve: (resolved) =>
            emit({
              ...base(threadId, turnId),
              type: "request.resolved",
              requestId: resolved.id,
              behavior: resolved.behavior,
              source: resolved.source,
            }),
        });
        args.push("--permission-prompt-tool", "mcp__gbs__approve");
        mcpServers.gbs = { command: process.execPath, args: [PERM_PROXY_PATH, socketPath], env: { ...NODE_ENV_FLAG } };
        allowed.push("mcp__gbs");
      }
      if (Object.keys(mcpServers).length) {
        args.push("--mcp-config", JSON.stringify({ mcpServers }));
        args.push("--allowedTools", allowed.join(","));
      }

      const env: Record<string, string | undefined> = { ...process.env, ...input.environment, PATH: augmentedPath(), NPM_CONFIG_LOGLEVEL: "error" };
      // subscription users get billed pay-as-you-go if this leaks through;
      // and a nested CLI must not inherit this session's identity (agentcal)
      delete env.ANTHROPIC_API_KEY;
      delete env.CLAUDECODE;
      delete env.CLAUDE_CODE_ENTRYPOINT;

      const child = spawnCli(config.cli, args, {
        cwd: turn.cwd ?? homedir(),
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });

      let failure: UsageLimitFailure | undefined;
      let settled = false;
      const settle = (ok: boolean, stopReason: string | null, cost: number | null = null) => {
        if (settled) return;
        settled = true;
        broker?.close();
        child.stdin.end();
        active.delete(threadId);
        emit({ ...base(threadId, turnId), type: "turn.completed", ok, stopReason, cost, failure });
      };

      // token streaming: true while --include-partial-messages is delivering
      // text deltas for the current assistant message, so the whole-message
      // frame that follows doesn't re-emit the same text as one big delta
      let sawStreamDelta = false;

      const handleLine = (line: string) => {
        let o: any;
        try {
          o = JSON.parse(line);
        } catch {
          return;
        }
        appendNative(threadId, { dir: "in", source: "claude.sdk.message", msg: o });
        const classified = classifyClaudeUsage(o);
        if (classified.usage) emit({ ...base(threadId, turnId), type: "usage.updated", usage: classified.usage });
        if (classified.failure && !failure) {
          failure = classified.failure;
          emit({ ...base(threadId, turnId), type: "runtime.error", message: "This AI app’s usage ran out.", failure });
        }
        switch (o.type) {
          case "system":
            if (o.subtype === "init") {
              emit({ ...base(threadId, turnId), type: "session.started", sessionId: o.session_id, model: o.model });
            } else if (o.subtype === "thinking_tokens") {
              emit({ ...base(threadId, turnId), type: "item.updated", itemType: "reasoning", tokens: o.estimated_tokens });
            }
            break;
          case "stream_event": {
            // subagent narration is dropped — N parallel Tasks would
            // interleave their prose into one bubble (upstream-verified bug)
            if (o.parent_tool_use_id) break;
            const ev = o.event ?? {};
            if (ev.type !== "content_block_delta") break;
            const d = ev.delta ?? {};
            if (d.type === "text_delta" && typeof d.text === "string" && d.text) {
              sawStreamDelta = true;
              emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "assistant_text", delta: d.text });
            } else if (d.type === "thinking_delta" && typeof d.thinking === "string" && d.thinking) {
              emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "reasoning_text", delta: d.thinking });
            }
            break;
          }
          case "assistant": {
            const msg = o.message ?? {};
            const text = firstText(msg.content);
            if (text.trim()) {
              // fallback delta for CLIs/paths that never streamed the block
              if (!sawStreamDelta) {
                emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "assistant_text", delta: text });
              }
              sawStreamDelta = false;
              emit({ ...base(threadId, turnId), type: "item.completed", itemType: "assistant_text", text });
            }
            for (const b of Array.isArray(msg.content) ? msg.content : []) {
              if (b.type === "tool_use") {
                emit({ ...base(threadId, turnId), type: "item.started", itemType: "tool", itemId: b.id, title: b.name });
              }
            }
            if (msg.usage) {
              emit({
                ...base(threadId, turnId),
                type: "thread.token-usage.updated",
                input: (msg.usage.input_tokens || 0) + (msg.usage.cache_read_input_tokens || 0),
                output: msg.usage.output_tokens || 0,
              });
            }
            break;
          }
          case "user":
            for (const b of Array.isArray(o.message?.content) ? o.message.content : []) {
              if (b.type === "tool_result") {
                emit({ ...base(threadId, turnId), type: "item.completed", itemType: "tool", itemId: b.tool_use_id, ok: !b.is_error });
              }
            }
            break;
          case "result":
            if (o.is_error !== true && failure) {
              failure = undefined;
              emit({ ...base(threadId, turnId), type: "usage.updated", usage: { source: "inferred", status: "unknown" } });
            }
            settle(o.is_error !== true, o.stop_reason ?? o.terminal_reason ?? null, o.total_cost_usd ?? null);
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
          if (line.trim()) handleLine(line);
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
        if (!settled) {
          emit({
            ...base(threadId, turnId),
            type: "runtime.error",
            message: `claude exited ${code} before result${stderr ? `: ${stderr.trim().slice(-300)}` : ""}`,
          });
          settle(false, "exit_before_result");
        }
      });

      const stop = () => killCliTree(child);
      const steer = async (text: string) => {
        if (settled || !child.stdin.writable) throw new Error("The turn has ended");
        const msg = { type: "user", message: { role: "user", content: text } };
        await new Promise<void>((resolve, reject) => child.stdin.write(JSON.stringify(msg) + "\n", err => err ? reject(err) : resolve()));
        appendNative(threadId, { dir: "out", source: "claude.sdk.message", msg });
      };
      child.stdin.on("error", () => {}); // write callbacks surface steering failures
      active.set(threadId, { stop, turnId, broker, steer });
      emit({ ...base(threadId, turnId), type: "turn.started" });

      // prompt over stdin as a stream-json message — never argv (ARG_MAX)
      const promptMsg = { type: "user", message: { role: "user", content: turn.text } };
      child.stdin.write(JSON.stringify(promptMsg) + "\n");
      appendNative(threadId, { dir: "out", source: "claude.sdk.message", msg: promptMsg });

      return { turnId };
    };

    const snapshot = async (): Promise<ProviderSnapshot> => {
      const version = await new Promise<string | null>((resolve) => {
        execCli(config.cli, ["--version"], { timeout: 8000, env: { ...process.env, PATH: augmentedPath() } }, (err, stdout) =>
          resolve(err ? null : stdout.trim()),
        );
      });
      if (!version) return { state: "unavailable", reason: `\`${config.cli}\` CLI not found` };
      const authenticated = existsSync(join(homedir(), ".claude", ".credentials.json"));
      return { state: "available", version, authenticated };
    };

    const refreshUsage = async () => {
      if (active.size) return;
      try {
        const classified = classifyClaudeAccountUsage(await readClaudeAccountUsage());
        if (classified.usage) emit({ ...base("", ""), type: "usage.updated", usage: classified.usage });
      } catch {}
    };

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      displayName: input.displayName,
      enabled: input.enabled,
      models: MODELS,
      discoverModels: () => discoverClaudeModels(config.cli),
      snapshot,
      adapter: {
        provider: DRIVER_KIND,
        capabilities: { sessionModelSwitch: "in-session", agentsMcp: true },
        sendTurn,
        refreshUsage,
        interruptTurn: async (threadId) => active.get(threadId)?.stop(),
        steerTurn: async (threadId, text) => {
          const turn = active.get(threadId);
          if (!turn) throw new Error("The turn has ended");
          await turn.steer(text);
        },
        respondToRequest: async (threadId, requestId, decision) => {
          const broker = active.get(threadId)?.broker;
          if (!broker) throw new Error("no active turn with a permission broker on this thread");
          const behavior = decision.behavior === "answer" ? "answer" : decision.behavior;
          if (!broker.answer(requestId, behavior, decision.message)) {
            throw new Error("no such pending request (it may have timed out)");
          }
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
      generateText: (prompt: string, signal?: AbortSignal) =>
        new Promise((resolve, reject) => {
          execCli(
            config.cli,
            ["-p", prompt, "--model", "claude-haiku-4-5", "--output-format", "text", "--tools", "", "--strict-mcp-config", "--no-session-persistence"],
            { timeout: 60_000, signal, env: { ...process.env, ...input.environment, PATH: augmentedPath() } },
            (err, stdout) => (err ? reject(err) : resolve(stdout.trim())),
          );
        }),
      dispose: async () => {
        for (const { stop } of active.values()) stop();
        listeners.clear();
      },
    };
  },
};
