// Claude driver — upstream ClaudeDriver skeleton over agentcal's
// drivers/claude.js runtime (stream-json both directions, prompt over
// stdin, completion from a real `result` event — verified against
// claude 2.1.211 by agentcal). Per-turn CLI process; the conversation
// continues across turns via --resume <sessionId> (the resumeCursor).
//
// Integrations become MCP servers on the CLI:
//   - Composio Sessions (connected apps → tools) over streamable HTTP
//   - the bot's cloud computer (box.ascii.dev) via server/computer-proxy.ts
//     — screenshot/exec/open_url, the CUA-on-the-box bridge
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, dirname } from "node:path";

import { DATA_DIR, stripWorkspaceCredentialEnv } from "../config.ts";
import { augmentedPath } from "../env-path.ts";
import { brokerSocketPath, describeSpawnFailure, execCli, killCliTree, spawnCli } from "../procs.ts";

import type {
  DriverCreateInput,
  ModelCatalog,
  ProviderDriver,
  ProviderInstance,
  ProviderSnapshot,
  RuntimeEvent,
  RuntimeEventListener,
  SendTurnInput,
} from "../contracts.ts";
import { computerProxyEnv } from "../container-computer.ts";
import { newEventId, newId } from "../contracts.ts";
import { classifyError, computeBackoff, interruptibleDelay, RETRY_MAX_ATTEMPTS } from "./retry.ts";
import {
  applyClaudeInject,
  decodeInjectId,
  mergeLocalInject,
  probeLocalInjects,
  resolveInjectId,
} from "./local-inject.ts";
import { appendNative } from "./native.ts";
import { SPAWNED_PROXIES } from "../proxy-paths.ts";

/** Whether `claude` has been signed in.
 *
 * Credential storage is deliberately not inspected here. Claude Code uses the
 * macOS Keychain for OAuth, a JSON file on some platforms, and may gain other
 * backends over time. Presence checks also accept stale credentials. The CLI's
 * own machine-readable auth command is the source of truth for every backend.
 */
export function claudeSignedIn(
  cli: string,
  env: NodeJS.ProcessEnv,
  run: typeof execCli = execCli,
): Promise<boolean> {
  return new Promise((resolve) => {
    run(cli, ["auth", "status", "--json"], { timeout: 8000, env }, (_error, stdout) => {
      try {
        const status: unknown = JSON.parse(stdout);
        resolve(
          typeof status === "object" && status !== null && "loggedIn" in status && status.loggedIn === true,
        );
      } catch {
        resolve(false);
      }
    });
  });
}

/** The CLI environment shared by auth probes and real turns.
 *
 * Subscription users can be billed pay-as-you-go if an inherited API key
 * leaks through, and a nested CLI must not inherit this session's identity.
 * Keeping the probe and turn environments identical prevents setup from
 * claiming an API-key login that the turn itself would deliberately remove.
 */
function claudeEnvironment(
  model?: string | null,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source, PATH: augmentedPath(), NPM_CONFIG_LOGLEVEL: "error" };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  // The harness process may hold workspace credentials (xai/box/voice keys,
  // env-injected at boot); none of them are this CLI's to see.
  stripWorkspaceCredentialEnv(env);
  const applied = applyClaudeInject(env, model);
  if (!applied.injected) delete env.ANTHROPIC_API_KEY;
  return env;
}

const DRIVER_KIND = "claudeAgent";

export interface ClaudeConfig {
  cli: string;
  permissionMode: "acceptEdits" | "auto" | "bypassPermissions";
  /** Available Claude built-ins. An empty list passes `--tools ""`. */
  tools?: string[];
  /** Claude tool patterns to deny after the available set is selected. */
  disallowedTools?: string[];
}

// model catalog ported from upstream packages/contracts/src/model.ts
export const STATIC_CLAUDE_MODELS: ModelCatalog = {
  default: "claude-sonnet-5",
  options: [
    { id: "claude-fable-5-1", label: "Claude Fable 5.1" },
    { id: "claude-fable-5", label: "Claude Fable 5" },
    { id: "claude-opus-5", label: "Claude Opus 5" },
    { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
    { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
  ],
};

const CLAUDE_MODEL_ID = /^[a-z0-9][a-z0-9._:/-]*$/i;

/** Rewrite a leftover API slug (`orcarouter/Qwen…`) to `host::model` when a
 *  local host is serving it, so the turn injects instead of asking for /login.
 *  Official cloud ids and already-encoded inject ids skip the probe. */
async function resolveClaudeTurnModel(
  model: string | null | undefined,
  env: Record<string, string | undefined>,
): Promise<string | null | undefined> {
  if (!model || decodeInjectId(model) || STATIC_CLAUDE_MODELS.options.some((option) => option.id === model)) {
    return model;
  }
  return resolveInjectId(model, await probeLocalInjects(env)) ?? model;
}

function claudeConfigDir(env: Record<string, string | undefined>): string {
  if (env.CLAUDE_CONFIG_DIR) return env.CLAUDE_CONFIG_DIR;
  return join(env.HOME || env.USERPROFILE || homedir(), ".claude");
}

function extrasFromUnknown(value: unknown): Array<{ id: string; label: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === "string") {
      return CLAUDE_MODEL_ID.test(item) ? [{ id: item, label: item }] : [];
    }
    if (!item || typeof item !== "object") return [];
    const row = item as { id?: unknown; model?: unknown; slug?: unknown; name?: unknown; displayName?: unknown; label?: unknown };
    const id = [row.id, row.model, row.slug].find((candidate): candidate is string => typeof candidate === "string");
    if (!id || !CLAUDE_MODEL_ID.test(id)) return [];
    const label = [row.name, row.displayName, row.label].find((candidate): candidate is string => typeof candidate === "string");
    return [{ id, label: label || id }];
  });
}

/** Extra ids from ~/.claude/settings.json. Official cloud rows stay untagged.
 *  `model` is Claude Code's last-used slug, not a catalog — listing it as
 *  Custom put a non-inject id in the picker and the turn then had no
 *  ANTHROPIC_API_KEY ("Not logged in · Please run /login"). Live injects
 *  come from mergeLocalInject. */
export function readClaudeModelCatalog(env: Record<string, string | undefined> = process.env) {
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(readFileSync(join(claudeConfigDir(env), "settings.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return STATIC_CLAUDE_MODELS;
  }

  const extras = [
    ...extrasFromUnknown(settings.availableModels),
    ...extrasFromUnknown(settings.customModels),
    ...extrasFromUnknown(settings.extraModels),
  ];
  const nestedEnv = settings.env && typeof settings.env === "object" ? (settings.env as Record<string, unknown>) : {};
  const envModel = nestedEnv.ANTHROPIC_MODEL ?? env.ANTHROPIC_MODEL;
  if (typeof envModel === "string") extras.push(...extrasFromUnknown([envModel]));

  const options = STATIC_CLAUDE_MODELS.options.map((option) => ({ ...option }));
  const seen = new Set(options.map((option) => option.id));
  for (const extra of extras) {
    if (seen.has(extra.id)) continue;
    seen.add(extra.id);
    options.push({ id: extra.id, label: extra.label, custom: true });
  }
  return { default: STATIC_CLAUDE_MODELS.default, options };
}

// Resolved from the server root, never relative to this file: bundling inlines
// this module into an entry one directory up, so a `".."` here would climb too
// far. See server/proxy-paths.ts.
const PROXY_PATH = SPAWNED_PROXIES.computer;
const PERM_PROXY_PATH = SPAWNED_PROXIES.permission;
const DWEB_PROXY_PATH = SPAWNED_PROXIES.dweb;
// in the packaged app process.execPath is the Electron binary — this env
// makes it behave as plain node for the spawned MCP proxies (harmless in dev)
const NODE_ENV_FLAG = { ELECTRON_RUN_AS_NODE: "1" };

function removePrivateTempDir(filePath: string | null | undefined): boolean {
  if (!filePath) return true;
  try {
    rmSync(dirname(filePath), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    return true;
  } catch {
    return false;
  }
}

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
type AskBehavior = "allow" | "deny" | "answer";
type AskResolutionSource = "user" | "timeout" | "system";

const DENY_TIMEOUT_NOTE =
  "OpenMausBot: nobody answered this permission request in time. Skip this action and finish what you can without it.";
const QUESTION_TIMEOUT_NOTE = "OpenMausBot: nobody answered in time. Use your best judgment and continue.";
const DUPLICATE_ASK_ID_NOTE = "OpenMausBot: duplicate ask id — skipping this request.";

/** The system-source reply for an ask that outlives the turn — used both to
 * drain in-flight `pending` asks on close() and to answer one that arrives
 * on an already-closed broker (see the `closed` branch below). */
function systemEndedReply(kind: Ask["kind"]): { behavior: AskBehavior; message: string } {
  return kind === "question"
    ? { behavior: "answer", message: "OpenMausBot: the turn is ending — wrap up." }
    : { behavior: "deny", message: "OpenMausBot: the turn ended" };
}

/** One human-readable line for an ask — what the card subtitle shows. */
function askSummary(ask: Ask): string {
  const input = ask.input ?? {};
  if (typeof input.question === "string") return input.question.slice(0, 300);
  if (typeof input.command === "string") return input.command.slice(0, 200);
  if (typeof input.url === "string") return input.url.slice(0, 200);
  const text = JSON.stringify(input);
  return text === "{}" ? (ask.tool ?? "tool") : text.slice(0, 200);
}

export function permissionSocketPath(threadId: string) {
  // A readable prefix alone is not unique: ids that agree on their first
  // characters ("t-perm-dup-1", "t-perm-dup-2") would share a socket. POSIX
  // hides that — a new broker's listen replaces the socket FILE, so the name
  // always points at the fresh server — but Windows named pipes live in a
  // global namespace that is never unlinked, and a reused name races the
  // previous broker's async teardown. Half the tag is a digest of the FULL
  // id so distinct threads get distinct sockets; the tag stays at 8 chars
  // total because the POSIX path already brushes the 104-byte sun_path
  // limit under deep tmp home dirs.
  const prefix = threadId.replace(/[^\w-]/g, "").slice(0, 4);
  const digest = createHash("sha256").update(threadId).digest("hex").slice(0, 4);
  return brokerSocketPath(DATA_DIR, `${prefix}${digest}`);
}

/** Paths the broker may bind, tried in order. Windows named pipes are never
 * unlinkable, and a hung CLI child from an earlier server process can hold a
 * name for minutes, so fresh suffixes let the new broker bind immediately.
 * POSIX gets a short temp fallback because macOS rejects Unix socket paths
 * longer than its small `sun_path` limit; a deep test HOME or long username
 * can otherwise make every approval silently unavailable. The proxy learns
 * the actual bound path from its argv, so either fallback is transparent. */
export function brokerSocketCandidates(threadId: string): string[] {
  const base = permissionSocketPath(threadId);
  if (process.platform !== "win32") {
    const scope = createHash("sha256")
      .update(`${DATA_DIR}\0${process.pid}\0${threadId}`)
      .digest("hex")
      .slice(0, 16);
    return [base, join(tmpdir(), `omb-perm-${scope}.sock`)];
  }
  return [
    base,
    `${base}-${randomBytes(3).toString("hex")}`,
    `${base}-${randomBytes(3).toString("hex")}`,
  ];
}

export async function createPermissionBroker(opts: {
  /** Candidate bind paths, tried in order; the first that listens wins. */
  socketPaths: string[];
  onAsk: (ask: Ask) => void;
  onResolve: (resolved: Ask & { behavior: AskBehavior; source: AskResolutionSource }) => void;
  isActive?: () => boolean;
  timeoutMs?: number;
}) {
  const timeoutMs = opts.timeoutMs ?? 15 * 60_000;
  const pending = new Map<
    string,
    { ask: Ask; finish: (behavior: AskBehavior, message: string | undefined, source: AskResolutionSource) => void }
  >();
  // server.close() only stops accepting NEW connections — it does not touch
  // a connection that's already open. A still-alive child's MCP proxy can
  // keep sending asks on such a connection after the turn has ended, and
  // this handler stays fully wired to it. Without this flag those asks would
  // become new `pending` entries and `request.opened` cards for a turn the
  // driver already forgot (`active.delete(threadId)` already ran), which can
  // never be answered — the "zombie card" in issue #211.
  let closed = false;
  let boundPath = opts.socketPaths[0] ?? "";
  const connectionHandler = (conn: import("node:net").Socket) => {
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
        if (closed) {
          // Closure is terminal and takes precedence over every active-turn
          // rule, including duplicate-id rejection. Never register a pending
          // entry or notify onAsk, but always answer an existing connection:
          // permission-proxy.ts only resolves on an explicit answer (or a
          // connection error/close), so a silent drop would hang the tool.
          try {
            conn.write(JSON.stringify({ t: "answer", id: askId, ...systemEndedReply(kind) }) + "\n");
          } catch {}
          continue;
        }
        // A retained Claude process keeps its proxy connection between
        // turns. Late/background asks must still fail closed without opening
        // a card for a turn that has already settled.
        if (opts.isActive && !opts.isActive()) {
          try {
            conn.write(JSON.stringify({ t: "answer", id: askId, ...systemEndedReply(kind) }) + "\n");
          } catch {}
          continue;
        }
        // `pending` is server-scoped, not per-connection: two asks with the
        // same id — a buggy/adversarial client, never a legitimate retry
        // (permission-proxy mints a fresh randomUUID per ask) — would
        // otherwise let the second `pending.set` silently overwrite the
        // first, orphaning it as an unanswerable card once the first
        // resolves and deletes the shared key. Reject before either ask
        // becomes visible to onAsk.
        if (pending.has(askId)) {
          // askId is client-controlled; JSON.stringify escapes newlines and
          // control characters so it can't corrupt the log line or terminal.
          console.error(`permission broker on ${boundPath}: duplicate ask id ${JSON.stringify(askId)} — denying`);
          try {
            conn.write(JSON.stringify({ t: "answer", id: askId, behavior: "deny", message: DUPLICATE_ASK_ID_NOTE }) + "\n");
          } catch {}
          continue;
        }
        const ask: Ask = { id: askId, kind, tool: msg.tool ?? "tool", input: msg.input ?? {}, at: Date.now() };
        const finish = (behavior: AskBehavior, message: string | undefined, source: AskResolutionSource) => {
          if (!pending.delete(askId)) return;
          clearTimeout(timer);
          try {
            conn.write(JSON.stringify({ t: "answer", id: askId, behavior, message }) + "\n");
          } catch {}
          opts.onResolve({ ...ask, behavior, source });
        };
        const timer = setTimeout(
          () =>
            kind === "question"
              ? finish("answer", QUESTION_TIMEOUT_NOTE, "timeout")
              : finish("deny", DENY_TIMEOUT_NOTE, "timeout"),
          timeoutMs,
        );
        timer.unref?.();
        pending.set(askId, { ask, finish });
        opts.onAsk(ask);
      }
    });
  };
  // Bind the first candidate that will take a listener. A broker that
  // never came up used to be silent — every approval then timed out into a
  // deny nobody could explain. Keep the turn fail-closed on total failure,
  // but leave an actionable diagnostic either way.
  let server: ReturnType<typeof createNetServer> | null = null;
  for (const [index, candidate] of opts.socketPaths.entries()) {
    const attempt = createNetServer(connectionHandler);
    try {
      unlinkSync(candidate);
    } catch {}
    let outcome = await new Promise<"listening" | (Error & { code?: string })>((resolve) => {
      attempt.once("listening", () => resolve("listening"));
      // SAFETY: net 'error' events carry syscall errors; the optional
      // `code` is only read defensively below.
      attempt.once("error", (error) => resolve(error as Error & { code?: string }));
      attempt.listen(candidate);
    });
    // A fallback under the shared OS temp root must not be connectable by
    // another local account. DATA_DIR is private already, but applying the
    // same mode to every POSIX socket keeps the rule simple and fail-closed.
    if (outcome === "listening" && process.platform !== "win32") {
      try {
        chmodSync(candidate, 0o600);
      } catch (error) {
        try {
          attempt.close();
        } catch {}
        try {
          unlinkSync(candidate);
        } catch {}
        outcome = error as Error & { code?: string };
      }
    }
    if (outcome === "listening") {
      if (index > 0) {
        console.error(`permission broker: ${opts.socketPaths[0]} is still held — bound fallback ${candidate}`);
      }
      boundPath = candidate;
      server = attempt;
      attempt.on("error", (error) => {
        console.error(`permission broker error on ${candidate}: ${error.message}`);
      });
      break;
    }
    try {
      attempt.close();
    } catch {}
    if (index === opts.socketPaths.length - 1) {
      console.error(`permission broker unavailable on ${candidate}: ${outcome.message}`);
      break;
    }
  }
  // Never hand the proxy an occupied candidate when every bind failed. That
  // could connect it to a stale (or unrelated) listener instead of this
  // broker, defeating the fail-closed boundary.
  if (!server) throw new Error("claude: permission broker could not bind a local socket");
  const drain = () => {
    for (const p of [...pending.values()]) {
      const { behavior, message } = systemEndedReply(p.ask.kind);
      p.finish(behavior, message, "system");
    }
  };
  return {
    answer(askId: string, behavior: AskBehavior, message?: string): boolean {
      const p = pending.get(askId);
      if (!p) return false;
      if (p.ask.kind === "question" ? behavior !== "answer" : behavior === "answer") return false;
      p.finish(behavior, message, "user");
      return true;
    },
    pause() {
      drain();
    },
    close() {
      closed = true;
      drain();
      try {
        server?.close();
      } catch {}
      try {
        unlinkSync(boundPath);
      } catch {}
    },
    /** Where the broker actually listens — argv for the proxy child must
     * use this, not the deterministic base, when a fallback was bound. */
    socketPath: boundPath,
  };
}

function decodeToolList(value: unknown, field: "tools" | "disallowedTools"): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`claude: ${field} must be an array of non-empty strings`);
  const decoded: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string" || !entry.trim()) {
      throw new Error(`claude: ${field} must be an array of non-empty strings`);
    }
    const normalized = entry.trim();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    decoded.push(normalized);
  }
  return decoded;
}

function decodeConfig(raw: unknown): ClaudeConfig {
  const o = (raw ?? {}) as Record<string, unknown>;
  const mode = o.permissionMode;
  if (mode !== undefined && mode !== "acceptEdits" && mode !== "auto" && mode !== "bypassPermissions") {
    throw new Error(`claude: invalid permissionMode ${JSON.stringify(mode)}`);
  }
  const tools = decodeToolList(o.tools, "tools");
  const disallowedTools = decodeToolList(o.disallowedTools, "disallowedTools");
  return {
    cli: typeof o.cli === "string" ? o.cli : "claude",
    permissionMode: (mode as ClaudeConfig["permissionMode"]) ?? "acceptEdits",
    ...(tools !== undefined ? { tools } : {}),
    ...(disallowedTools !== undefined ? { disallowedTools } : {}),
  };
}

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

type ClaudeImage = NonNullable<SendTurnInput["images"]>[number];
type ClaudeUserContent =
  | { type: "image"; source: { type: "base64"; media_type: ClaudeImage["mime"]; data: string } }
  | { type: "text"; text: string };
type ClaudeUserMessage = {
  type: "user";
  message: { role: "user"; content: string | ClaudeUserContent[] };
};

/** Claude's stream-json input accepts the same image source blocks as the
 * Anthropic Messages API. Keep the old string form for text-only turns so a
 * CLI update cannot disturb the overwhelmingly common path. */
function claudeUserMessage(
  text: string,
  images: readonly ClaudeImage[] | undefined,
): ClaudeUserMessage {
  if (!images?.length) return { type: "user", message: { role: "user", content: text } };
  const content: ClaudeUserContent[] = images.map((image) => ({
    type: "image",
    source: {
      type: "base64",
      media_type: image.mime,
      data: readFileSync(image.path).toString("base64"),
    },
  }));
  if (text) content.push({ type: "text", text });
  return { type: "user", message: { role: "user", content } };
}

/** Native traces are routinely attached to bug reports. Preserve the image
 * block's shape and size for debugging, but never persist its base64 bytes. */
function diagnosticClaudeUserMessage(message: ClaudeUserMessage): ClaudeUserMessage {
  if (!Array.isArray(message.message.content)) return message;
  return {
    ...message,
    message: {
      ...message.message,
      content: message.message.content.map((block) =>
        block.type === "image"
          ? {
              ...block,
              source: {
                ...block.source,
                data: `[image data: ${block.source.data.length} base64 chars]`,
              },
            }
          : block,
      ),
    },
  };
}

export const ClaudeDriver: ProviderDriver<ClaudeConfig> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Claude", supportsMultipleInstances: true },
  // npm on all three: the one recipe that is genuinely cross-platform. The
  // native installers differ per OS and would need verifying separately.
  install: {
    command: {
      darwin: "npm install -g @anthropic-ai/claude-code",
      linux: "npm install -g @anthropic-ai/claude-code",
      win32: "npm install -g @anthropic-ai/claude-code",
    },
    needsNode: true,
    docsUrl: "https://claude.com/claude-code",
    signInCommand: "claude",
  },
  models: STATIC_CLAUDE_MODELS,
  decodeConfig,
  defaultConfig: () => decodeConfig({}),

  async create(input: DriverCreateInput<ClaudeConfig>): Promise<ProviderInstance> {
    const { instanceId, config } = input;
    const catalogEnv: Record<string, string | undefined> = { ...process.env, ...input.environment };
    let models = STATIC_CLAUDE_MODELS;
    const refreshModels = async () => {
      try {
        const resolved = await mergeLocalInject(readClaudeModelCatalog(catalogEnv), catalogEnv);
        if (resolved.options.length) models = resolved;
      } catch {
        // Keep the last usable catalog when settings.json is unreadable.
      }
    };
    await refreshModels();
    const listeners = new Set<RuntimeEventListener>();
    // one active turn per thread; a second send while busy is a caller bug
    const active = new Map<string, { stop: () => void; turnId: string; broker?: Awaited<ReturnType<typeof createPermissionBroker>> }>();

    // One live CLI process per thread, kept across turns. Under
    // --input-format stream-json the CLI settles a turn with `result` while
    // stdin stays open, takes the next user message on the same stdin as a
    // new turn, and folds a message that arrives MID-turn into the running
    // one before its next model call (verified against 2.1.221 — that fold
    // is what "steer" is). So a session is spawned once, reused while its
    // spawn contract (args, MCP config, cwd, model) is unchanged, closed
    // after SESSION_IDLE_MS of quiet, and resumed by --resume when needed.
    interface Session {
      child: ReturnType<typeof spawnCli>;
      broker?: Awaited<ReturnType<typeof createPermissionBroker>>;
      mcpConfigPath: string | null;
      systemPromptPath: string | null;
      /** the spawn contract — a different one means a fresh process */
      argsKey: string;
      /** the CLI's session id from `init`, what --resume takes later */
      sessionId: string | null;
      /** the running turn, or null between turns */
      turn: { turnId: string; settled: boolean; sawStreamDelta: boolean } | null;
      idleTimer: ReturnType<typeof setTimeout> | null;
      closing: boolean;
      stderr: string;
    }
    const sessions = new Map<string, Session>();
    const configuredIdleMinimum = Number(process.env.OMB_CLAUDE_SESSION_IDLE_MIN_MS);
    const sessionIdleMinimum = Number.isFinite(configuredIdleMinimum) && configuredIdleMinimum > 0
      ? configuredIdleMinimum
      : 10_000;
    const SESSION_IDLE_MS = Math.max(sessionIdleMinimum, Number(process.env.OMB_CLAUDE_SESSION_IDLE_MS) || 10 * 60_000);

    const closeSession = (threadId: string, why: string) => {
      const s = sessions.get(threadId);
      if (!s || s.closing) return;
      s.closing = true;
      if (s.idleTimer) clearTimeout(s.idleTimer);
      // Broker ownership belongs to this session. Detach and close it now,
      // before a replacement can bind the same per-thread socket; the old
      // child's later close event must never unlink a new broker.
      const broker = s.broker;
      s.broker = undefined;
      broker?.close();
      appendNative(threadId, { dir: "out", source: "claude.session", msg: { close: why } });
      // stdin EOF is the CLI's exit signal; give it a moment, then insist
      try {
        s.child.stdin.end();
      } catch {}
      const kill = setTimeout(() => {
        if (s.child.exitCode === null) killCliTree(s.child);
      }, 5_000);
      kill.unref?.();
    };
    const armIdle = (threadId: string) => {
      const s = sessions.get(threadId);
      if (!s) return;
      if (s.idleTimer) clearTimeout(s.idleTimer);
      s.idleTimer = setTimeout(() => closeSession(threadId, "idle"), SESSION_IDLE_MS);
      s.idleTimer.unref?.();
    };
    const writeUser = (s: Session, threadId: string, promptMsg: ClaudeUserMessage): Promise<boolean> => {
      if (!s.child.stdin.writable || s.child.stdin.destroyed) return Promise.resolve(false);
      return new Promise((resolve) => {
        try {
          s.child.stdin.write(JSON.stringify(promptMsg) + "\n", (error) => {
            if (error) return resolve(false);
            appendNative(threadId, {
              dir: "out",
              source: "claude.sdk.message",
              msg: diagnosticClaudeUserMessage(promptMsg),
            });
            resolve(true);
          });
        } catch {
          resolve(false);
        }
      });
    };

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
    // retry bookkeeping lives PER THREAD, not per sendTurn call: a relaunch
    // is a fresh sendTurn, and the attempt cap must survive across launches
    const retryState = new Map<string, { attempt: number; cancelled: boolean }>();

    const sendTurn = async (turn: SendTurnInput) => {
      const { threadId } = turn;
      if (active.has(threadId)) throw new Error("a turn is already running on this thread");
      // A bot-level mode is authoritative for this turn. In particular, an
      // old provider instance may still be configured with
      // `bypassPermissions`; Ask/Auto must restore Claude's interactive
      // broker instead of inheriting that silent bypass. Calls without a
      // per-turn mode keep the legacy adapter behavior.
      const permissionMode = turn.approvalMode === undefined
        ? config.permissionMode
        : turn.approvalMode === "full" ? "bypassPermissions"
          : turn.approvalMode === "auto" ? "auto" : "default";
      const controlsHost = turn.integrations?.localComputer?.scope === "local-computer";
      if (controlsHost && permissionMode === "bypassPermissions" && turn.approvalMode !== "full") {
        throw new Error("local computer control requires the interactive approval broker");
      }
      // Materialize before creating a broker or process. A missing/corrupt
      // attachment must fail this call without leaving a live session behind.
      const promptMsg = claudeUserMessage(turn.text, turn.images);
      const turnId = newId();
      const retryAbort = new AbortController();
      const retry = retryState.get(threadId) ?? { attempt: 0, cancelled: false };
      retry.cancelled = false;
      retryState.set(threadId, retry);
      // a retry relaunches the whole CLI; the backoff is scaled down in tests
      // so a fake's transient failures don't stall real seconds
      const retryScale = Number(process.env.FAKE_CLAUDE_RETRY_SCALE ?? "1");
      const sessionId = typeof turn.resumeCursor === "string" ? turn.resumeCursor : null;
      const newSessionId = sessionId ? null : newId();

      const args = [
        "-p",
        "--output-format", "stream-json",
        "--input-format", "stream-json",
        "--verbose", // required by stream-json output
        // token-level streaming: content_block_delta events between the
        // whole-message frames, so the bubble grows as the model writes
        "--include-partial-messages",
        "--permission-mode", permissionMode,
      ];
      if (config.tools !== undefined) args.push("--tools", config.tools.join(","));
      if (config.disallowedTools?.length) {
        args.push("--disallowedTools", config.disallowedTools.join(","));
      }
      const turnEnvironment: NodeJS.ProcessEnv = { ...process.env, ...input.environment };
      const turnModel = await resolveClaudeTurnModel(turn.model, turnEnvironment);
      const injected = applyClaudeInject({ ...turnEnvironment }, turnModel);
      if (injected.model) args.push("--model", injected.model);
      if (turn.effort) args.push("--effort", turn.effort);

      // A room prompt can contain section context, skills, memory, playbooks,
      // and browser/agent instructions. Passing that text directly on argv
      // exceeds Windows' CreateProcess command-line limit and surfaces as
      // `spawn ENAMETOOLONG`. Claude accepts the same prompt from a file, so
      // keep both the text and its potentially sensitive contents off argv.
      let systemPromptPath: string | null = null;

      // integrations → MCP servers; pre-allow their tools (a headless
      // acceptEdits run silently denies anything unlisted)
      const mcpServers: Record<string, unknown> = {};
      const allowed: string[] = [];
      if (turn.integrations?.composio) {
        mcpServers.composio = { ...turn.integrations.composio };
        allowed.push("mcp__composio");
      }
      if (turn.integrations?.computer) {
        mcpServers.computer = {
          command: process.execPath,
          args: [PROXY_PATH],
          env: { ...NODE_ENV_FLAG, ...computerProxyEnv(turn.integrations.computer) },
        };
        allowed.push("mcp__computer");
      } else if (turn.integrations?.localComputer) {
        const local = turn.integrations.localComputer;
        mcpServers.computer = {
          command: local.command,
          args: local.args,
          env: local.env,
        };
        // The isolated Local VM preserves the established pre-allow behavior.
        // Host tools always route through OpenMausBot's permission broker.
        if (!controlsHost) allowed.push("mcp__computer");
      }
      // peer-agent comms (list_bots/ask_bot) — the harness builds the whole
      // spawn contract (command/args/env incl. the boot token) in
      // agentsIntegration(); pre-allowing matters doubly here, or the CLI's
      // own ListAgents look-alike shadows it and "@Bot" asks go nowhere
      if (turn.integrations?.agents) {
        // Coordination is foundational, not an optional deferred lookup.
        // Claude waits for always-loaded tools before building the prompt.
        mcpServers.agents = { ...turn.integrations.agents, alwaysLoad: true };
        allowed.push("mcp__agents");
      }
      if (turn.integrations?.phone) {
        mcpServers.phone = { ...turn.integrations.phone };
        allowed.push("mcp__phone");
      }
      if (turn.integrations?.browser) {
        mcpServers.browser = { ...turn.integrations.browser };
        allowed.push("mcp__browser");
      }
      // dweb network daemon (status / repo / opencode model access) via
      // server/drivers/dweb-proxy.ts — points at the configured dweb instance
      if (turn.integrations?.dweb) {
        mcpServers.dweb = {
          command: process.execPath,
          args: [DWEB_PROXY_PATH],
          env: {
            ...NODE_ENV_FLAG,
            DWEB_URL: turn.integrations.dweb.url,
          },
        };
        allowed.push("mcp__dweb");
      }
      // user-configured servers mount like any integration but are NOT
      // pre-allowed: acceptEdits silently denies unlisted tools, which
      // routes every custom tool call through the ogb permission broker
      // into an Allow/Deny card. Reserved names were filtered upstream;
      // skip any residual collision instead of clobbering a built-in.
      for (const [name, server] of Object.entries(turn.integrations?.custom ?? {})) {
        if (name in mcpServers) continue;
        mcpServers[name] = { ...server };
      }
      // Keep ask_user available even in Full access. Native bypass skips
      // permission prompts, not questions requiring a person's answer.
      let broker: Awaited<ReturnType<typeof createPermissionBroker>> | undefined;
      const socketPath = permissionSocketPath(threadId);
      if (permissionMode !== "bypassPermissions") {
        args.push("--permission-prompt-tool", "mcp__ogb__approve");
      }
      mcpServers.ogb = { command: process.execPath, args: [PERM_PROXY_PATH, socketPath], env: { ...NODE_ENV_FLAG }, alwaysLoad: true };
      allowed.push("mcp__ogb");
      // The MCP config carries credentials — a Composio consumer key in a
      // header, the box token in the computer proxy's env, the comms token in
      // the agents proxy's env. On argv every one of those is world-readable
      // through `ps` for the life of the turn, to any local process. The CLI
      // accepts a FILE for this flag, so the secrets go in a 0600 file that
      // is removed when the turn settles.
      let mcpConfigPath: string | null = null;
      if (Object.keys(mcpServers).length) {
        mcpConfigPath = join(mkdtempSync(join(tmpdir(), "omb-mcp-")), "mcp.json");
        args.push("--mcp-config", mcpConfigPath);
        args.push("--allowedTools", allowed.join(","));
      }

      const env = claudeEnvironment(turnModel, turnEnvironment);
      // Our approvals and browser credentials expire at the user-turn
      // boundary. Native background workers cannot outlive that boundary;
      // parallel bot work must use the harness's durable delegate_bot path.
      env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = "1";
      const cwd = turn.cwd ?? homedir();
      // Everything that shapes the process, minus session/turn-specific temp
      // paths. Their contents are represented directly in the key instead.
      const privateFileFlags = new Set(["--mcp-config"]);
      const keyArgs = args.filter((a, i) => !privateFileFlags.has(a) && !privateFileFlags.has(args[i - 1] ?? ""));
      const argsKey = JSON.stringify({
        args: keyArgs,
        system: turn.system ?? null,
        mcpServers,
        cwd,
        model: injected.model ?? null,
        base: env.ANTHROPIC_BASE_URL ?? null,
      });

      // Reuse the live process when it is idle, unchanged, and is the session
      // the harness wants resumed. Anything else: close it and spawn fresh
      // (with --resume, so the conversation continues in the new process).
      const live = sessions.get(threadId);
      if (live && !live.turn && !live.closing && live.child.exitCode === null && live.argsKey === argsKey && (!sessionId || sessionId === live.sessionId)) {
        if (live.idleTimer) clearTimeout(live.idleTimer);
        live.turn = { turnId, settled: false, sawStreamDelta: false };
        active.set(threadId, { stop: () => {
          closeSession(threadId, "interrupted");
          killCliTree(live.child);
        }, turnId, broker: live.broker });
        emit({ ...base(threadId, turnId), type: "turn.started" });
        const written = await writeUser(live, threadId, promptMsg);
        if (!written) {
          active.delete(threadId);
          live.turn = null;
          closeSession(threadId, "stdin write failed");
          retryState.delete(threadId);
          if (mcpConfigPath) {
            try {
              rmSync(dirname(mcpConfigPath), { recursive: true, force: true });
            } catch {}
          }
          throw new Error("claude session stdin is not writable");
        }
        // the MCP config was for the first spawn; nothing to clean here
        if (mcpConfigPath) {
          try {
            rmSync(dirname(mcpConfigPath), { recursive: true, force: true });
          } catch {}
        }
        return { turnId };
      }
      if (live) closeSession(threadId, "spawn contract changed");

      // Until sessions.set() below, this turn owns every launch resource.
      // Any bind, private-config or synchronous spawn failure must release
      // them here rather than leave a live listener or credential temp file.
      const cleanupUnownedLaunch = () => {
        broker?.close();
        broker = undefined;
        if (mcpConfigPath) {
          try {
            rmSync(dirname(mcpConfigPath), { recursive: true, force: true });
          } catch {}
          mcpConfigPath = null;
        }
        if (systemPromptPath) {
          removePrivateTempDir(systemPromptPath);
          systemPromptPath = null;
        }
        retryState.delete(threadId);
      };

      try {
        // Create the prompt file only for a new process. A compatible live
        // session has already consumed the same system prompt at launch.
        if (turn.system) {
          systemPromptPath = join(mkdtempSync(join(tmpdir(), "omb-system-")), "prompt.txt");
          writeFileSync(systemPromptPath, turn.system, { mode: 0o600 });
          args.push("--append-system-prompt-file", systemPromptPath);
        }
        // Only create a broker for a new process. A compatible retained
        // process keeps its existing proxy connection and broker across turns.
        if (socketPath) {
          // remembers which tool each pending ask came from, so the resolved
          // event can scope approvals to real desktop-control tools only
          const askTools = new Map<string, string | undefined>();
          broker = await createPermissionBroker({
            socketPaths: brokerSocketCandidates(threadId),
            isActive: () => Boolean(sessions.get(threadId)?.turn),
            onAsk: (ask) => {
              const eventTurnId = sessions.get(threadId)?.turn?.turnId ?? turnId;
              askTools.set(ask.id, typeof ask.tool === "string" ? ask.tool : undefined);
              emit({
                ...base(threadId, eventTurnId),
                type: "request.opened",
                requestId: ask.id,
                requestType: ask.kind,
                tool: ask.tool,
                summary: askSummary(ask),
                approvalScope:
                  typeof ask.tool === "string" && controlsHost && ask.tool.startsWith("mcp__computer")
                    ? "local-computer"
                    : undefined,
                choices: Array.isArray(ask.input?.choices) ? (ask.input.choices as string[]).slice(0, 5) : undefined,
              });
            },
            onResolve: (resolved) => {
              const eventTurnId = sessions.get(threadId)?.turn?.turnId ?? turnId;
              emit({
                ...base(threadId, eventTurnId),
                type: "request.resolved",
                requestId: resolved.id,
                behavior: resolved.behavior,
                source: resolved.source,
                approvalScope:
                  controlsHost && typeof askTools.get(resolved.id) === "string" && askTools.get(resolved.id)!.startsWith("mcp__computer") ? "local-computer" : undefined,
              });
              askTools.delete(resolved.id);
            },
          });
          // A fallback bind means the deterministic pipe is still held by an
          // earlier process's child. The proxy learns its path from argv, so
          // point it at the pipe we actually bound. argsKey deliberately keeps
          // the base path: the nonce is not part of the spawn contract, and a
          // retained session keeps its own broker object anyway.
          if (broker.socketPath !== socketPath && mcpConfigPath) {
            mcpServers.ogb = { command: process.execPath, args: [PERM_PROXY_PATH, broker.socketPath], env: { ...NODE_ENV_FLAG }, alwaysLoad: true };
          }
        }

        // Write once, only after the broker has selected its real endpoint.
        if (mcpConfigPath) {
          writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers }), { mode: 0o600 });
        }
        if (sessionId) args.push("--resume", sessionId);
        else args.push("--session-id", newSessionId!);
      } catch (error) {
        cleanupUnownedLaunch();
        throw error;
      }

      let child: ReturnType<typeof spawnCli>;
      try {
        child = spawnCli(config.cli, args, {
          cwd,
          env,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (error) {
        cleanupUnownedLaunch();
        throw error;
      }
      const session: Session = {
        child,
        broker,
        mcpConfigPath,
        systemPromptPath,
        argsKey,
        sessionId: sessionId ?? newSessionId,
        turn: { turnId, settled: false, sawStreamDelta: false },
        idleTimer: null,
        closing: false,
        stderr: "",
      };
      sessions.set(threadId, session);

      // settles the TURN, not the process: the CLI stays for the next
      // message until it has been quiet for SESSION_IDLE_MS
      const settle = (
        ok: boolean,
        stopReason: string | null,
        cost: number | null = null,
        usage?: { input: number; output: number; cachedInput?: number },
      ) => {
        const t = session.turn;
        if (!t || t.settled) return;
        t.settled = true;
        // Resolve any ask still open for this turn, but keep the broker
        // listening for the next turn on the retained process. Between turns
        // isActive() rejects late background asks without creating cards.
        session.broker?.pause();
        // the config file holds live credentials — the CLI read it at start;
        // it must not sit on disk for the life of the session
        if (session.mcpConfigPath) {
          try {
            rmSync(dirname(session.mcpConfigPath), { recursive: true, force: true });
          } catch {}
          session.mcpConfigPath = null;
        }
        if (session.systemPromptPath) {
          if (removePrivateTempDir(session.systemPromptPath)) session.systemPromptPath = null;
        }
        active.delete(threadId);
        session.turn = null;
        // A settled turn owns no retry budget. Retained CLI sessions may run
        // many later turns on this thread, and each must start fresh.
        retryState.delete(threadId);
        emit({ ...base(threadId, t.turnId), type: "turn.completed", ok, stopReason, cost, ...(usage ? { usage } : {}) });
        if (session.child.exitCode === null && !session.closing) armIdle(threadId);
      };
      const currentTurnId = () => session.turn?.turnId ?? turnId;

      const handleLine = (line: string) => {
        let o: any;
        try {
          o = JSON.parse(line);
        } catch {
          return;
        }
        appendNative(threadId, { dir: "in", source: "claude.sdk.message", msg: o });
        switch (o.type) {
          case "system":
            if (o.subtype === "init") {
              if (typeof o.session_id === "string") session.sessionId = o.session_id;
              emit({ ...base(threadId, currentTurnId()), type: "session.started", sessionId: o.session_id, model: o.model });
            } else if (o.subtype === "thinking_tokens") {
              emit({ ...base(threadId, currentTurnId()), type: "item.updated", itemType: "reasoning", tokens: o.estimated_tokens });
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
              if (session.turn) session.turn.sawStreamDelta = true;
              emit({ ...base(threadId, currentTurnId()), type: "content.delta", streamKind: "assistant_text", delta: d.text });
            } else if (d.type === "thinking_delta" && typeof d.thinking === "string" && d.thinking) {
              emit({ ...base(threadId, currentTurnId()), type: "content.delta", streamKind: "reasoning_text", delta: d.thinking });
            }
            break;
          }
          case "assistant": {
            const msg = o.message ?? {};
            const text = firstText(msg.content);
            if (text.trim()) {
              // fallback delta for CLIs/paths that never streamed the block
              if (!session.turn?.sawStreamDelta) {
                emit({ ...base(threadId, currentTurnId()), type: "content.delta", streamKind: "assistant_text", delta: text });
              }
              if (session.turn) session.turn.sawStreamDelta = false;
              emit({ ...base(threadId, currentTurnId()), type: "item.completed", itemType: "assistant_text", text });
            }
            for (const b of Array.isArray(msg.content) ? msg.content : []) {
              if (b.type === "tool_use") {
                emit({ ...base(threadId, currentTurnId()), type: "item.started", itemType: "tool", itemId: b.id, title: b.name });
              }
            }
            if (msg.usage) {
              emit({
                ...base(threadId, currentTurnId()),
                type: "thread.token-usage.updated",
                input: (msg.usage.input_tokens || 0) + (msg.usage.cache_read_input_tokens || 0),
                output: msg.usage.output_tokens || 0,
                ...(typeof msg.usage.cache_read_input_tokens === "number"
                  ? { cachedInput: msg.usage.cache_read_input_tokens }
                  : {}),
              });
            }
            break;
          }
          case "user":
            for (const b of Array.isArray(o.message?.content) ? o.message.content : []) {
              if (b.type === "tool_result") {
                emit({ ...base(threadId, currentTurnId()), type: "item.completed", itemType: "tool", itemId: b.tool_use_id, ok: !b.is_error });
              }
            }
            break;
          case "result":
            // A synthetic background completion is not the result of the
            // submitted user turn. Settling it would revoke browser access
            // and deny approvals while that user turn is still running.
            if (o.origin?.kind === "task-notification") break;
            // result.usage is this invocation's total — one process per turn,
            // so it is the turn's figure. cache reads count as input: they
            // are billed (at the cache rate) and they fill the window — but
            // they are reported separately too, so the UI can show how much
            // of the figure was context re-read rather than new text.
            settle(
              o.is_error !== true,
              o.stop_reason ?? o.terminal_reason ?? null,
              o.total_cost_usd ?? null,
              o.usage
                ? {
                    input: (o.usage.input_tokens || 0) + (o.usage.cache_read_input_tokens || 0) + (o.usage.cache_creation_input_tokens || 0),
                    output: o.usage.output_tokens || 0,
                    ...(typeof o.usage.cache_read_input_tokens === "number"
                      ? { cachedInput: o.usage.cache_read_input_tokens }
                      : {}),
                  }
                : undefined,
            );
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
          if (line.trim()) handleLine(line);
        }
      });

      child.stderr.on("data", (c) => {
        session.stderr += c;
        if (session.stderr.length > 8192) session.stderr = session.stderr.slice(-8192);
      });

      child.on("error", (e) => {
        emit({ ...base(threadId, currentTurnId()), type: "runtime.error", ...describeSpawnFailure(e, config.cli) });
        settle(false, "spawn_error");
      });

      child.on("close", (code) => {
        // a turn still running when the process died is a failed turn; a
        // process that exited between turns (idle close, contract change)
        // is just a session ending
        if (session.turn && !session.turn.settled) {
          const message = `claude exited ${code} before result${session.stderr ? `: ${session.stderr.trim().slice(-300)}` : ""}`;
          const verdict = classifyError({ exitCode: code, stderr: message });
          if (
            !retry.cancelled &&
            code !== 0 &&
            verdict.transient &&
            !session.turn.sawStreamDelta &&
            retry.attempt < RETRY_MAX_ATTEMPTS - 1
          ) {
            // the CLI is gone but the TURN continues: keep the thread busy,
            // emit no terminal event, and relaunch after the backoff. The
            // `active` entry STAYS — it is what makes an interrupt during
            // the backoff reach this turn's stop() and cancel the retry.
            const failedBroker = session.broker;
            session.broker = undefined;
            failedBroker?.pause();
            failedBroker?.close();
            if (session.mcpConfigPath) {
              try {
                rmSync(dirname(session.mcpConfigPath), { recursive: true, force: true });
              } catch {}
              session.mcpConfigPath = null;
            }
            if (session.systemPromptPath) {
              removePrivateTempDir(session.systemPromptPath);
              session.systemPromptPath = null;
            }
            sessions.delete(threadId);
            session.turn = null;
            retry.attempt++;
            const delayMs = computeBackoff(retry.attempt - 1);
            emit({
              ...base(threadId, turnId),
              type: "turn.retrying",
              attempt: retry.attempt,
              delayMs,
              reason: verdict.reason,
            });
            void (async () => {
              const wait = interruptibleDelay(delayMs * retryScale, retryAbort.signal);
              await wait.promise;
              // an interrupt during the backoff landed here via stop(); the
              // turn settles as interrupted and no zombie relaunch happens
              if (retry.cancelled) {
                active.delete(threadId);
                retryState.delete(threadId);
                emit({
                  ...base(threadId, turnId),
                  type: "turn.completed",
                  ok: false,
                  stopReason: "interrupted",
                  cost: null,
                });
                return;
              }
              // hand the thread back before recursing — the relaunch's own
              // guard would otherwise reject it as "already running"
              active.delete(threadId);
              try {
                const cursor = session.sessionId ?? sessionId ?? undefined;
                await sendTurn({ ...turn, resumeCursor: cursor });
              } catch (e) {
                retryState.delete(threadId);
                emit({
                  ...base(threadId, turnId),
                  type: "runtime.error",
                  message: e instanceof Error ? e.message : String(e),
                });
                emit({
                  ...base(threadId, turnId),
                  type: "turn.completed",
                  ok: false,
                  stopReason: "exit_before_result",
                  cost: null,
                });
              }
            })();
            return;
          }
          retryState.delete(threadId);
          emit({
            ...base(threadId, currentTurnId()),
            type: "runtime.error",
            message,
          });
          settle(false, "exit_before_result");
        }
        if (session.idleTimer) clearTimeout(session.idleTimer);
        session.broker?.close();
        if (session.mcpConfigPath) {
          try {
            rmSync(dirname(session.mcpConfigPath), { recursive: true, force: true });
          } catch {}
        }
        removePrivateTempDir(session.systemPromptPath);
        if (sessions.get(threadId) === session) sessions.delete(threadId);
      });

      const stop = () => {
        // taskkill is asynchronous on Windows. Retire steering and approvals
        // now, before a still-connected child can submit more work.
        closeSession(threadId, "interrupted");
        retry.cancelled = true;
        retryAbort.abort();
        killCliTree(child);
      };
      active.set(threadId, { stop, turnId, broker });
      emit({ ...base(threadId, turnId), type: "turn.started" });

      // prompt over stdin as a stream-json message — never argv (ARG_MAX).
      // stdin stays OPEN: that is what keeps the session alive for a
      // mid-turn steer or the next turn; closeSession() ends it.
      if (!(await writeUser(session, threadId, promptMsg))) {
        settle(false, "stdin_write_failed");
        closeSession(threadId, "stdin write failed");
      }

      return { turnId };
    };

    /** A user message into the running turn: the CLI delivers it before its
     * next model call. False when nothing is running here to steer. */
    const steer = async (threadId: string, text: string): Promise<boolean> => {
      const s = sessions.get(threadId);
      if (!s || !s.turn || s.turn.settled || s.closing || s.child.exitCode !== null) return false;
      return writeUser(s, threadId, claudeUserMessage(text, undefined));
    };

    const snapshot = async (): Promise<ProviderSnapshot> => {
      const env = claudeEnvironment(undefined, { ...process.env, ...input.environment });
      const version = await new Promise<string | null>((resolve) => {
        execCli(config.cli, ["--version"], { timeout: 8000, env }, (err, stdout) =>
          resolve(err ? null : stdout.trim()),
        );
      });
      if (!version) return { state: "unavailable", reason: `\`${config.cli}\` CLI not found` };
      const authenticated = await claudeSignedIn(config.cli, env);
      // claudeEnvironment strips ANTHROPIC_API_KEY, so turns run on the
      // CLI's own login (Pro/Max): the cost it reports is what the call
      // WOULD bill, not a charge
      return { state: "available", version, authenticated, billing: "subscription" };
    };

    /** One-shot Claude call with the prompt on stdin, never argv. Approval
     * summaries can contain paths, commands, or secrets, so the generic
     * `claude -p "prompt"` shape is not safe for review. No tools or MCP
     * servers are mounted in this isolated process. */
    const generateReview = (prompt: string, signal?: AbortSignal): Promise<string> =>
      new Promise((resolve, reject) => {
        const child = spawnCli(
          config.cli,
          ["-p", "--model", "claude-haiku-4-5", "--output-format", "text"],
          {
            stdio: ["pipe", "pipe", "pipe"],
            env: claudeEnvironment("claude-haiku-4-5", { ...process.env, ...input.environment }),
          },
        );
        let stdout = "";
        let stderr = "";
        let settled = false;
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          if (error) reject(error);
          else resolve(stdout.trim());
        };
        const onAbort = () => {
          killCliTree(child);
          finish(new Error("Claude review aborted"));
        };
        const timer = setTimeout(() => {
          killCliTree(child);
          finish(new Error("Claude review timed out"));
        }, 60_000);
        timer.unref?.();
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          stdout += chunk;
          if (stdout.length > 1_000_000) {
            killCliTree(child);
            finish(new Error("Claude review output exceeded 1 MB"));
          }
        });
        child.stderr.on("data", (chunk: string) => {
          stderr = (stderr + chunk).slice(-8_192);
        });
        child.on("error", (error) => finish(error));
        child.on("close", (code) => {
          if (code === 0) finish();
          else finish(new Error(stderr.trim() || `Claude review exited ${code}`));
        });
        if (signal?.aborted) onAbort();
        else {
          signal?.addEventListener("abort", onAbort, { once: true });
          child.stdin.end(prompt);
        }
      });

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
          sessionModelSwitch: "in-session",
          agentsMcp: true,
        customMcp: true,
          computerMcp: true,
          composioMcp: true,
          phoneMcp: true,
          browserMcp: true,
          images: true,
          nativeImageInput: true,
          effortLevels: ["low", "medium", "high", "xhigh", "max"],
          queueing: true,
          // Harness turns reassert a per-bot mode and restore the broker even
          // when an old instance was configured with bypassPermissions.
          localComputerMcp: true,
        },
        sendTurn,
        steer,
        interruptTurn: async (threadId) => active.get(threadId)?.stop(),
        respondToRequest: async (threadId, requestId, decision) => {
          // fail-closed by construction: no broker, or an ask that already
          // timed out / settled, is `unavailable` — the caller denies
          const broker = sessions.get(threadId)?.broker ?? active.get(threadId)?.broker;
          if (!broker) return "unavailable";
          const behavior = decision.behavior === "answer" ? "answer" : decision.behavior;
          if (!broker.answer(requestId, behavior, decision.message)) return "unavailable";
          return behavior === "allow" ? "allowed-once" : behavior === "answer" ? "answered" : "rejected";
        },
        hasSession: (threadId) => active.has(threadId),
        stopAll: async () => {
          for (const { stop } of active.values()) stop();
          for (const threadId of [...sessions.keys()]) closeSession(threadId, "stopAll");
        },
        onEvent: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      generateText: (prompt) => generateReview(prompt),
      reviewPermission: generateReview,
      dispose: async () => {
        for (const { stop } of active.values()) stop();
        for (const threadId of [...sessions.keys()]) closeSession(threadId, "dispose");
        listeners.clear();
      },
    };
  },
};
