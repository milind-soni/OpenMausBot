// Generic ACP (Agent Client Protocol) driver core — one JSON-RPC-2.0-over-
// stdio session runtime that every ACP CLI harness (Grok Build, Gemini CLI,
// …) rides. Modeled on t3code's AcpSessionRuntime + per-agent AcpSupport
// split: the protocol mechanics live here, the per-harness quirks (spawn
// argv, auth method, model catalog, sign-in check) live in a small support
// object. Adding a harness = write server/drivers/acp/<name>.ts.
//
// ACP has no `turn/completed` notification: the `session/prompt` RPC *result*
// is the completion signal (it carries stopReason + usage). Permission
// requests arrive as server→client `session/request_permission` and surface
// as canonical request.opened events, answered fail-closed (nothing approved
// unless the agent explicitly offered an `allow`-kind option — option ORDER
// is never a security contract). session/load REPLAYS history as ordinary
// session/update notifications, so updates are double-gated: nothing emits
// before the prompt is sent, and `_meta.isReplay` updates are dropped.
import { homedir } from "node:os";
import { lstat, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

import { PROVIDER_CREDENTIAL_ENV, WORKSPACE_CREDENTIAL_ENV } from "../../config.ts";
import { decodeInjectId } from "../local-inject.ts";
import { describeSpawnFailure, execCli, killCliTree, spawnCli } from "../../procs.ts";

/**
 * A `host::model` pick talks to a loopback server with its own key.
 * Subscription ACP login (grok.com cached_token) must not fail that turn.
 */
export function skipSubscriptionAuthForLocalInject(model: string | undefined): boolean {
  return Boolean(decodeInjectId(model));
}

import type {
  DriverCreateInput,
  EffortLevel,
  EngineInstall,
  ProviderDriver,
  ProviderInstance,
  ProviderSnapshot,
  ModelCatalog,
  RuntimeEvent,
  RuntimeEventListener,
  SendTurnInput,
  ProviderErrorCode,
  TurnImageInput,
} from "../../contracts.ts";
import { newEventId, newId } from "../../contracts.ts";
import { computerProxyEnv } from "../../container-computer.ts";
import { augmentedPath } from "../../env-path.ts";
import { supportsApprovalMode } from "../../../shared/approval-mode.ts";

// Resolved from the server root, never relative to this file: bundling inlines
// this module two directories up, so the `".."` pair here would climb past the
// packaged server dir entirely. See server/proxy-paths.ts.
const COMPUTER_PROXY_PATH = SPAWNED_PROXIES.computer;
import { appendNative } from "../native.ts";
import { SPAWNED_PROXIES } from "../../proxy-paths.ts";

export interface AcpConfig {
  cli: string;
  fullAuto: boolean;
  /** Optional home for this instance's sessions. */
  workspace?: string;
}

/** Per-harness specifics — everything that differs between Grok, Gemini, … */
export interface AcpSupport {
  driverKind: string;
  displayName: string;
  /** Omit for subscription CLIs (the default). Custom-only CLIs sit below
   *  the picker-rail divider and have no first-party cloud catalog. */
  access?: "subscription" | "custom";
  models: { default: string; options: Array<{ id: string; label: string }> };
  /** Effort levels this harness's CLI accepts, ascending. Omit when it has
   * no reasoning-effort control. Static for the same reason `models` is:
   * describe() runs before any session exists, so there is no _meta to read
   * — eventually both should come from initialize's _meta.modelState. */
  effortLevels?: readonly EffortLevel[];
  /** Default CLI binary name if the instance config doesn't override it. */
  defaultCli: string;
  /** Optional live model catalog. A failed lookup keeps the last usable catalog.
   *  `config` is the instance decode so a support can ask the same binary it
   *  will spawn (custom `cli` paths), not whatever happens to be named on PATH. */
  resolveModels?(
    environment: Record<string, string | undefined>,
    config: AcpConfig,
    instanceId: string,
  ): ModelCatalog | Promise<ModelCatalog>;
  /** Some managed agents are intentionally not probed during app startup.
   * Their explicit Refresh action remains the only network/process boundary. */
  resolveModelsOnCreate?: boolean;
  /** Native-protocol log label, e.g. "grok.acp". */
  nativeSource: string;
  /** Whether models behind this ACP harness can consume a referenced image.
   * Most coding agents can open local files; opt out for text-only agents. */
  images?: boolean;
  /** Message shown when the CLI is present but not signed in. */
  loginNote: string;
  /** How a user installs this harness's CLI; surfaced by the setup UI. */
  install?: EngineInstall;
  /** CLI argv AFTER the binary name to enter ACP stdio mode. */
  spawnArgs(config: AcpConfig, turn: SendTurnInput): string[];
  /** Provider credential variables this ACP child is allowed to inherit. */
  credentialEnv?: readonly string[];
  /** Select the model through a session config option instead of argv, for
   *  harnesses whose ACP subcommand takes no -m (opencode). The agent must
   *  CONFIRM the requested model before we prompt: silently running a model
   *  other than the one the picker shows is the failure this guards. */
  selectModel?: { configId: string };
  /** Mutate the child env in place: strip a key, inject a policy. Receives the
   *  instance config so a support can vary with fullAuto. */
  transformEnv?(env: Record<string, string | undefined>, config: AcpConfig, instanceId: string): void;
  /** Resolve a managed or account-scoped executable just before use. */
  resolveCommand?(
    env: Record<string, string | undefined>,
    config: AcpConfig,
    instanceId: string,
  ): Promise<{ command: string; args?: string[]; env?: Record<string, string | undefined> }>;
  /** Snapshot override for agents whose binary has no conventional --version. */
  snapshot?(
    env: Record<string, string | undefined>,
    config: AcpConfig,
    instanceId: string,
  ): Promise<ProviderSnapshot>;
  /** Google Antigravity resumes through session/resume, not session/load. */
  resumeMethod?: "load" | "resume";
  /** Route workspace file access through ACP so edits retain approval cards. */
  clientFileSystem?: boolean;
  /** Do not retain stderr from providers that may place OAuth material there. */
  redactStderr?: boolean;
  /** Bound provider-native tool payloads before writing diagnostic logs. */
  sanitizeToolPayload?: boolean;
  /** Mutate the child env after the turn model is known. Catalog refresh and
   *  snapshot share `transformEnv` and must not see a per-turn overlay. */
  applyTurnEnv?(
    env: Record<string, string | undefined>,
    ctx: { model?: string; requestedModel?: string },
  ): void;
  /** Pick the ACP authenticate methodId from initialize's advertised
   * authMethods; return null to skip the authenticate step. */
  pickAuthMethod(authMethods: Array<{ id?: string }>): string | null;
  /** "fail": abort the turn if auth is missing/errors (subscription CLIs).
   *  "continue": proceed anyway (CLIs that work off an ambient login). */
  authFailure: "fail" | "continue";
  /** snapshot(): can this harness actually run a turn? (env already carries the
   *  merged config). May be async for harnesses that have to ask the CLI. */
  isAuthenticated(
    env: Record<string, string | undefined>,
    config: AcpConfig,
    instanceId: string,
  ): boolean | Promise<boolean>;
  /** Refuse a first-party cloud turn before spawning when snapshot auth is
   * false. Local injected models deliberately bypass this subscription gate. */
  requireAuthenticationBeforeSpawn?: boolean;
  /** Classify provider-native failures without coupling the core to messages. */
  classifyError?(error: unknown): ProviderErrorCode | undefined;
  /** Compose the session/prompt text. Default prepends the persona. */
  buildPromptText?(turn: SendTurnInput): string;
  /** Rewrite a picker id (`omlx::model`) into the CLI-native id before spawn
   * and session/select. Local inject writers live here so the child sees a
   * model it already knows. */
  resolveTurnModel?(
    model: string | undefined,
    env: Record<string, string | undefined>,
  ): string | undefined;
  /** Apply per-session settings between session/new (or session/load) and the
   * first session/prompt. Some CLIs ignore argv and take the model/mode over
   * the wire instead (droid), so this is the only place the pick can land; a
   * throw here fails the turn rather than silently running another model. */
  configureSession?(ctx: {
    request: (method: string, params: unknown, timeoutMs?: number) => Promise<any>;
    sessionId: string;
    config: AcpConfig;
    turn: SendTurnInput;
    /** `session/new` (or `session/load`) advertised model list, verbatim. Some
     * CLIs namespace their ACP model ids differently from their argv `--model`
     * slugs (Cursor answers `default[]` where the CLI calls it `auto`), so a
     * driver that only knows the argv slug cannot form a valid set_model
     * without this. Empty when the agent advertised none. */
    sessionModels: Array<{ modelId?: string; name?: string }>;
  }): Promise<void>;
}

const envOr = (key: string, fallback: number): number => Number(process.env[key] ?? fallback);
const INIT_TIMEOUT = envOr("OPENMAUS_ACP_INIT_TIMEOUT_MS", 300_000);
const SESSION_CONFIG_TIMEOUT = envOr("OPENMAUS_ACP_SESSION_CONFIG_TIMEOUT_MS", 300_000); // configureSession's per-request default
const NEW_SESSION_TIMEOUT = envOr("OPENMAUS_ACP_NEW_SESSION_TIMEOUT_MS", 300_000);
const LOAD_SESSION_TIMEOUT = envOr("OPENMAUS_ACP_LOAD_SESSION_TIMEOUT_MS", 120_000); // history replay on a long thread is slow
const CLIENT_FILE_MAX_BYTES = 8 * 1024 * 1024;
const TOOL_LOG_TEXT_LIMIT = 64_000;

async function readAcpImageBlocks(images: readonly TurnImageInput[]) {
  return Promise.all(images.map(async (image) => ({
    type: "image" as const,
    data: (await readFile(image.path)).toString("base64"),
    mimeType: image.mime,
  })));
}

function sanitizeToolLogValue(value: unknown, budget: { nodes: number; text: number }, depth = 0): unknown {
  if (depth > 12 || budget.nodes-- <= 0) return undefined;
  if (typeof value === "string") {
    if (/^data:image\//iu.test(value) || budget.text <= 0) return undefined;
    const limit = Math.min(TOOL_LOG_TEXT_LIMIT, budget.text);
    const text = value.length <= limit ? value : `[Earlier output truncated]\n\n${value.slice(-limit)}`;
    budget.text -= text.length;
    return text;
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => {
      const sanitized = sanitizeToolLogValue(entry, budget, depth + 1);
      return sanitized === undefined ? [] : [sanitized];
    });
  }
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.entries(record).flatMap(([key, entry]) => {
    if ((record.type === "image" && (key === "data" || key === "blob")) ||
      (key === "blob" && typeof record.mimeType === "string" && record.mimeType.startsWith("image/"))) return [];
    const sanitized = sanitizeToolLogValue(entry, budget, depth + 1);
    return sanitized === undefined ? [] : [[key, sanitized]];
  }));
}

function sanitizeAcpToolMessage(message: any): unknown {
  const isToolUpdate = message?.method === "session/update"
    && ["tool_call", "tool_call_update"].includes(message?.params?.update?.sessionUpdate);
  const isPermission = message?.method === "session/request_permission";
  if (!isToolUpdate && !isPermission) return message;
  return sanitizeToolLogValue(message, { nodes: 512, text: TOOL_LOG_TEXT_LIMIT });
}

function decodeAcpConfig(defaultCli: string) {
  return (raw: unknown): AcpConfig => {
    const o = (raw ?? {}) as Record<string, unknown>;
    return {
      cli: typeof o.cli === "string" ? o.cli : defaultCli,
      fullAuto: o.fullAuto === true,
      workspace: typeof o.workspace === "string" ? o.workspace : undefined,
    };
  };
}

/**
 * ACP JSON-RPC-over-stdio driver. Harness differences (argv, auth, catalog)
 * live in `support`; this is the shared handshake and turn runtime.
 */
export function createAcpDriver(support: AcpSupport): ProviderDriver<AcpConfig> {
  const DRIVER_KIND = support.driverKind;
  const SOURCE = support.nativeSource;
  const decodeConfig = decodeAcpConfig(support.defaultCli);
  const DENY_TIMEOUT_NOTE =
    "OpenMausBot: nobody answered this permission request in time. Skip this action and finish what you can without it.";

  return {
    driverKind: DRIVER_KIND,
    metadata: {
      displayName: support.displayName,
      supportsMultipleInstances: true,
      access: support.access ?? "subscription",
    },
    install: support.install,
    models: support.models,
    decodeConfig,
    defaultConfig: () => decodeConfig({}),

    async create(input: DriverCreateInput<AcpConfig>): Promise<ProviderInstance> {
      const { instanceId, config } = input;
      const childEnv = (activeConfig = config) => {
        const env: Record<string, string | undefined> = {
          ...process.env,
          ...input.environment,
          PATH: augmentedPath(),
        };
        const allowedCredentials = new Set(support.credentialEnv ?? []);
        // two lists, one rule: foreign PROVIDER keys must not flip a CLI's
        // billing off its own login, and WORKSPACE credentials (box token,
        // voice key, …) are the harness's secrets — riding along in
        // `...process.env` is not a grant. A driver keeps only what its
        // credentialEnv allowlist names.
        for (const key of [...PROVIDER_CREDENTIAL_ENV, ...WORKSPACE_CREDENTIAL_ENV]) {
          if (!allowedCredentials.has(key)) delete env[key];
        }
        support.transformEnv?.(env, activeConfig, instanceId);
        return env;
      };
      let models = support.models;
      const refreshModels = async () => {
        if (!support.resolveModels) return;
        try {
          const resolved = await support.resolveModels(childEnv(), config, instanceId);
          if (resolved.options.length) models = resolved;
        } catch {
          // Keep the last usable catalog when an optional discovery source is down.
        }
      };
      if (support.resolveModelsOnCreate !== false) await refreshModels();
      const listeners = new Set<RuntimeEventListener>();
      interface Turn {
        stop: () => void;
        interrupt: () => void;
        turnId: string;
        asks: Map<string, (behavior: string, source?: "user" | "timeout" | "system", message?: string) => void>;
      }
      const active = new Map<string, Turn>();

      const emit = (event: RuntimeEvent) => {
        for (const listener of listeners) listener(event);
      };

      // ACP content blocks may carry a complete raster image inline. Keep the
      // bytes on the wire, but never duplicate megabytes of base64 into the
      // provider-native diagnostic log in either direction.
      const nativeLogMessage = (msg: any): unknown => {
        let redacted = msg;
        const prompt = msg?.method === "session/prompt" ? msg?.params?.prompt : null;
        if (Array.isArray(prompt)) {
          redacted = {
            ...msg,
            params: {
              ...msg.params,
              prompt: prompt.map((content: any) =>
                content?.type === "image" && typeof content.data === "string"
                  ? { ...content, data: `[image data: ${content.data.length} base64 chars]` }
                  : content
              ),
            },
          };
        }
        const content = redacted?.params?.update?.content;
        if (
          redacted?.method !== "session/update" ||
          redacted?.params?.update?.sessionUpdate !== "agent_message_chunk" ||
          content?.type !== "image" ||
          typeof content.data !== "string"
        ) return support.sanitizeToolPayload ? sanitizeAcpToolMessage(redacted) : redacted;
        redacted = {
          ...redacted,
          params: {
            ...redacted.params,
            update: {
              ...redacted.params.update,
              content: { ...content, data: `[image data: ${content.data.length} base64 chars]` },
            },
          },
        };
        return support.sanitizeToolPayload ? sanitizeAcpToolMessage(redacted) : redacted;
      };
      const base = (threadId: string, turnId: string) => ({
        eventId: newEventId(),
        provider: DRIVER_KIND,
        threadId,
        turnId,
        createdAt: new Date().toISOString(),
      });

      // ACP session mcpServers: stdio is the baseline every ACP agent
      // supports (mcpCapabilities.http/.sse only add EXTRA transports), so
      // an injected stdio proxy — e.g. the peer-agent comms tool — attaches
      // fine here. env is the ACP {name,value}[] shape.
      const acpMcpServers = (turn: SendTurnInput) => {
        const servers: Array<{ name: string; command: string; args: string[]; env: Array<{ name: string; value: string }> }> = [];
        const acpEnv = (env: Record<string, string>) =>
          Object.entries(env).map(([name, value]) => ({ name, value: String(value) }));
        const agents = turn.integrations?.agents;
        if (agents) {
          servers.push({ name: "agents", command: agents.command, args: agents.args, env: acpEnv(agents.env) });
        }
        const composio = turn.integrations?.composio;
        if (composio) {
          servers.push({
            name: "composio",
            command: composio.command,
            args: composio.args,
            env: acpEnv(composio.env),
          });
        }
        const browser = turn.integrations?.browser;
        if (browser) {
          servers.push({ name: "browser", command: browser.command, args: browser.args, env: acpEnv(browser.env) });
        }
        // The bot's computer, mounted exactly like the Claude driver does.
        // Cloud boxes use the REST adapter; host and sandbox Cua connections
        // expose Cua Driver's official MCP server directly.
        const computer = turn.integrations?.computer;
        if (computer) {
          servers.push({
            name: "computer",
            command: process.execPath,
            args: [COMPUTER_PROXY_PATH],
            env: acpEnv({ ELECTRON_RUN_AS_NODE: "1", ...computerProxyEnv(computer) }),
          });
        } else if (turn.integrations?.localComputer) {
          const local = turn.integrations.localComputer;
          servers.push({
            name: "computer",
            command: local.command,
            args: local.args,
            env: acpEnv(local.env ?? {}),
          });
        }
        // user-configured servers, after the built-ins: a residual name
        // collision keeps the built-in (reserved names are filtered at the
        // config boundary; this is defense in depth).
        for (const [name, server] of Object.entries(turn.integrations?.custom ?? {})) {
          if (servers.some((existing) => existing.name === name)) continue;
          servers.push({ name, command: server.command, args: server.args, env: acpEnv(server.env) });
        }
        return servers;
      };

      const sendTurn = async (turn: SendTurnInput) => {
        const { threadId } = turn;
        if (active.has(threadId)) throw new Error("a turn is already running on this thread");
        // Provider-instance `fullAuto` predates per-bot approval levels. Every
        // harness turn now carries the bot's mode, so Ask/Auto must explicitly
        // put the native agent back into its interactive mode. Otherwise a
        // legacy Grok bypassPermissions / Cursor --force / Droid auto-high /
        // Antigravity yolo setting would silently outrank the selector. Calls
        // that omit approvalMode retain the old adapter-level behavior for
        // embedders and tests outside the harness.
        const turnConfig = turn.approvalMode === undefined
          ? config
          : { ...config, fullAuto: turn.approvalMode === "full" && supportsApprovalMode(DRIVER_KIND, "full") };
        const controlsHost = turn.integrations?.localComputer?.scope === "local-computer";
        if (controlsHost && turnConfig.fullAuto && turn.approvalMode !== "full") {
          throw new Error("local computer control requires interactive provider approvals");
        }
        const turnId = newId();
        const cwd = turn.cwd ?? turnConfig.workspace ?? homedir();
        const env = childEnv(turnConfig);
        if (
          support.requireAuthenticationBeforeSpawn
          && !skipSubscriptionAuthForLocalInject(turn.model)
          && !(await support.isAuthenticated(env, turnConfig, instanceId))
        ) {
          emit({ ...base(threadId, turnId), type: "turn.started" });
          emit({ ...base(threadId, turnId), type: "runtime.error", message: support.loginNote, setup: true });
          emit({ ...base(threadId, turnId), type: "turn.completed", ok: false, stopReason: "auth_required", cost: null });
          return { turnId };
        }
        const resolvedModel = support.resolveTurnModel?.(turn.model, env);
        support.applyTurnEnv?.(env, { model: resolvedModel, requestedModel: turn.model });
        const cliTurn =
          resolvedModel !== undefined && resolvedModel !== turn.model
            ? { ...turn, model: resolvedModel }
            : turn;
        const mcpServers = acpMcpServers(turn);
        let launch: { command: string; args?: string[]; env?: Record<string, string | undefined> };
        try {
          launch = support.resolveCommand
            ? await support.resolveCommand(env, turnConfig, instanceId)
            : { command: turnConfig.cli };
        } catch (error) {
          emit({ ...base(threadId, turnId), type: "turn.started" });
          emit({
            ...base(threadId, turnId),
            type: "runtime.error",
            message: error instanceof Error ? error.message : String(error),
            setup: true,
          });
          emit({ ...base(threadId, turnId), type: "turn.completed", ok: false, stopReason: "setup_required", cost: null });
          return { turnId };
        }

        const child = spawnCli(launch.command, [...(launch.args ?? []), ...support.spawnArgs(turnConfig, cliTurn)], {
          cwd,
          env: launch.env ?? env,
          stdio: ["pipe", "pipe", "pipe"],
        });

        const state = { settled: false, promptSent: false, text: "" };
        const asks = new Map<string, (behavior: string, source?: "user" | "timeout" | "system", message?: string) => void>();
        let nextId = 1;
        let sessionId: string | null = null;
        let interruptTimer: ReturnType<typeof setTimeout> | null = null;
        const rpcPending = new Map<
          number,
          { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> | null }
        >();

        const send = (obj: unknown) => {
          try {
            child.stdin.write(JSON.stringify(obj) + "\n");
          } catch {}
          appendNative(threadId, { dir: "out", source: SOURCE, msg: nativeLogMessage(obj) });
        };
        const request = (method: string, params: unknown, timeoutMs?: number) =>
          new Promise<any>((resolve, reject) => {
            const id = nextId++;
            let timer: ReturnType<typeof setTimeout> | null = null;
            if (timeoutMs) {
              timer = setTimeout(() => {
                rpcPending.delete(id);
                reject(new Error(`${method} timed out`));
              }, timeoutMs);
              timer.unref?.();
            }
            rpcPending.set(id, { resolve, reject, timer });
            send({ jsonrpc: "2.0", id, method, params });
          });

        const stop = () => killCliTree(child);

        const resolveClientPath = async (requestPath: unknown): Promise<string> => {
          if (typeof requestPath !== "string" || !isAbsolute(requestPath)) {
            throw new Error("ACP file paths must be absolute.");
          }
          const workspace = await realpath(cwd).catch(() => resolve(cwd));
          const requested = resolve(requestPath);
          const lexical = relative(resolve(cwd), requested);
          if (lexical === ".." || lexical.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(lexical)) {
            throw new Error("ACP file path is outside the session workspace.");
          }
          const suffix = [basename(requested)];
          let ancestor = dirname(requested);
          while (!(await lstat(ancestor).catch(() => null))) {
            const parent = dirname(ancestor);
            if (parent === ancestor) throw new Error("ACP file path has no accessible parent.");
            suffix.unshift(basename(ancestor));
            ancestor = parent;
          }
          const candidate = resolve(await realpath(ancestor), ...suffix);
          const rel = relative(workspace, candidate);
          if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
            throw new Error("ACP file path is outside the session workspace.");
          }
          const existing = await lstat(candidate).catch(() => null);
          if (existing?.isSymbolicLink()) throw new Error("ACP file path cannot be a symbolic link.");
          return candidate;
        };

        const handleClientFileRequest = async (msg: any): Promise<void> => {
          const fail = (error: unknown) => send({
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32602, message: error instanceof Error ? error.message : String(error) },
          });
          try {
            if (!support.clientFileSystem) throw new Error("Client file access is disabled.");
            const params = msg.params ?? {};
            const path = await resolveClientPath(params.path);
            if (msg.method === "fs/read_text_file") {
              const info = await stat(path);
              if (!info.isFile() || info.size > CLIENT_FILE_MAX_BYTES) {
                throw new Error(`ACP can only read text files under ${CLIENT_FILE_MAX_BYTES} bytes.`);
              }
              const content = await readFile(path, "utf8");
              if (params.line == null && params.limit == null) {
                send({ jsonrpc: "2.0", id: msg.id, result: { content } });
                return;
              }
              const line = Number.isInteger(params.line) && params.line > 0 ? params.line : 1;
              const limit = Number.isInteger(params.limit) && params.limit >= 0 ? params.limit : undefined;
              const lines = content.split("\n");
              const start = line - 1;
              send({
                jsonrpc: "2.0",
                id: msg.id,
                result: { content: lines.slice(start, limit === undefined ? undefined : start + limit).join("\n") },
              });
              return;
            }
            if (typeof params.content !== "string" || Buffer.byteLength(params.content) > CLIENT_FILE_MAX_BYTES) {
              throw new Error(`ACP can only write text files under ${CLIENT_FILE_MAX_BYTES} bytes.`);
            }
            await mkdir(dirname(path), { recursive: true });
            await writeFile(path, params.content, "utf8");
            send({ jsonrpc: "2.0", id: msg.id, result: {} });
          } catch (error) {
            fail(error);
          }
        };

        /** Emit buffered assistant text as its own item, then clear it. */
        const flushAssistantText = () => {
          const text = state.text;
          state.text = "";
          if (!text.trim()) return;
          emit({ ...base(threadId, turnId), type: "item.completed", itemType: "assistant_text", text });
        };

        const settle = (ok: boolean, stopReason: string | null) => {
          if (state.settled) return;
          state.settled = true;
          if (interruptTimer) clearTimeout(interruptTimer);
          for (const finish of asks.values()) finish("cancel", "system");
          for (const p of rpcPending.values()) {
            if (p.timer) clearTimeout(p.timer);
            p.reject(new Error("turn settled"));
          }
          rpcPending.clear();
          active.delete(threadId);
          flushAssistantText();
          emit({ ...base(threadId, turnId), type: "turn.completed", ok, stopReason, cost: null });
          stop(); // the agent process does not exit on its own
        };

        // server→client permission request → canonical request.opened
        const handleServerRequest = (msg: any) => {
          if (msg.method === "fs/read_text_file" || msg.method === "fs/write_text_file") {
            void handleClientFileRequest(msg);
            return;
          }
          if (msg.method !== "session/request_permission") {
            // never leave an unknown server request hanging — the agent blocks
            return send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
          }
          const params = msg.params ?? {};
          flushAssistantText();
          const options: Array<{ optionId?: string; kind?: string; name?: string }> = Array.isArray(params.options) ? params.options : [];
          const optionFor = (want: "allow" | "reject") =>
            options.find((o) => o.kind === `${want}_once` && typeof o.optionId === "string")?.optionId
              ?? options.find((o) => String(o.kind ?? "").startsWith(want) && typeof o.optionId === "string")?.optionId
              ?? null;
          const cancelled = { outcome: { outcome: "cancelled" } };
          const missing = (want: string) =>
            emit({
              ...base(threadId, turnId),
              type: "runtime.error",
              message: `${DRIVER_KIND} offered no "${want}" permission option — cancelling the request instead of guessing`,
            });

          const toolCall = params.toolCall ?? {};
          const isQuestion = String(toolCall.toolCallId ?? "").startsWith("interaction_");
          if (turnConfig.fullAuto && turn.approvalMode === undefined && !isQuestion) {
            const allow = optionFor("allow");
            if (!allow) missing("allow");
            return send({
              jsonrpc: "2.0",
              id: msg.id,
              result: allow ? { outcome: { outcome: "selected", optionId: allow } } : cancelled,
            });
          }
          const kind = String(toolCall.kind ?? "");
          const tool = kind === "execute" ? "shell" : kind === "edit" ? "edit" : kind || "tool";
          const summary = String(toolCall.rawInput?.command ?? toolCall.title ?? tool).slice(0, 200);
          const requestId = newId();
          const finish = (
            behavior: string,
            source: "user" | "timeout" | "system" = "user",
            message?: string,
          ) => {
            if (!asks.delete(requestId)) return;
            clearTimeout(timer);
            const want = behavior === "allow" ? "allow" : "reject";
            const named = isQuestion && behavior === "answer"
              ? options.filter((option) => option.optionId === message || option.name?.trim() === message)
              : [];
            const optionId = behavior === "cancel"
              ? null
              : isQuestion
                ? named.length === 1 && typeof named[0].optionId === "string" ? named[0].optionId : null
                : optionFor(want);
            if (behavior !== "cancel" && !optionId) missing(isQuestion ? "matching answer" : want);
            send({
              jsonrpc: "2.0",
              id: msg.id,
              result: optionId ? { outcome: { outcome: "selected", optionId } } : cancelled,
            });
            emit({
              ...base(threadId, turnId),
              type: "request.resolved",
              requestId,
              behavior: optionId && isQuestion ? "answer" : optionId && behavior === "allow" ? "allow" : "deny",
              source: optionId ? source : "system",
              approvalScope: controlsHost ? "local-computer" : undefined,
            });
          };
          const timer = setTimeout(() => {
            emit({ ...base(threadId, turnId), type: "runtime.error", message: DENY_TIMEOUT_NOTE });
            finish("deny", "timeout");
          }, 15 * 60_000);
          timer.unref?.();
          asks.set(requestId, finish);
          emit({
            ...base(threadId, turnId),
            type: "request.opened",
            requestId,
            requestType: isQuestion ? "question" : "permission",
            tool,
            summary,
            choices: isQuestion
              ? options.flatMap((option) => typeof option.name === "string" && option.name.trim() ? [option.name.trim()] : [])
              : undefined,
            approvalScope: controlsHost ? "local-computer" : undefined,
          });
        };

        const handleNotification = (msg: any) => {
          // Vendor side-channels (e.g. grok's `_x.ai/*`) are teed to the
          // native log but never normalized: the prompt result is the settle.
          if (msg.method !== "session/update") return;
          const p = msg.params ?? {};
          if (!state.promptSent || p._meta?.isReplay === true) return;
          const u = p.update ?? {};
          switch (u.sessionUpdate) {
            case "agent_message_chunk": {
              const content = u.content;
              const delta = content?.text;
              if (content?.type === "image" && typeof content.data === "string" && content.data) {
                flushAssistantText();
                emit({
                  ...base(threadId, turnId),
                  type: "item.completed",
                  itemType: "assistant_image",
                  data: content.data,
                  alt: "Generated image",
                });
              } else if (typeof delta === "string" && delta) {
                state.text += delta;
                emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "assistant_text", delta });
              }
              break;
            }
            case "agent_thought_chunk": {
              const delta = u.content?.text;
              if (typeof delta === "string" && delta) {
                emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "reasoning_text", delta });
              }
              break;
            }
            case "tool_call": {
              flushAssistantText();
              emit({
                ...base(threadId, turnId),
                type: "item.started",
                itemType: "tool",
                itemId: u.toolCallId,
                title: String(u.rawInput?.command ?? u.title ?? "tool").slice(0, 80),
              });
              break;
            }
            case "tool_call_update": {
              if (u.status === "completed" || u.status === "failed") {
                emit({
                  ...base(threadId, turnId),
                  type: "item.completed",
                  itemType: "tool",
                  itemId: u.toolCallId,
                  ok: u.status !== "failed",
                });
              }
              break;
            }
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
            appendNative(threadId, { dir: "in", source: SOURCE, msg: nativeLogMessage(msg) });
            if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
              const pend = rpcPending.get(msg.id);
              if (pend) {
                rpcPending.delete(msg.id);
                if (pend.timer) clearTimeout(pend.timer);
                if (msg.error) {
                  const error = new Error(msg.error.message ?? JSON.stringify(msg.error));
                  Object.assign(error, { code: msg.error.code, data: msg.error.data });
                  pend.reject(error);
                } else {
                  pend.resolve(msg.result);
                }
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
          if (!support.redactStderr) stderr += c;
          if (stderr.length > 8192) stderr = stderr.slice(-8192);
        });
        child.on("error", (e) => {
          emit({ ...base(threadId, turnId), type: "runtime.error", ...describeSpawnFailure(e, launch.command) });
          settle(false, "spawn_error");
        });
        child.on("close", (code) => {
          if (!state.settled) {
            emit({
              ...base(threadId, turnId),
              type: "runtime.error",
              message: `${DRIVER_KIND} exited ${code} before the prompt result${stderr ? `: ${stderr.trim().slice(-300)}` : ""}`,
            });
            settle(false, "exit_before_result");
          }
        });

        const interrupt = () => {
          if (sessionId) send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
          else stop();
          if (interruptTimer) clearTimeout(interruptTimer);
          interruptTimer = setTimeout(() => settle(true, "cancelled"), 5_000);
          interruptTimer.unref?.();
        };
        active.set(threadId, { stop, interrupt, turnId, asks });
        emit({ ...base(threadId, turnId), type: "turn.started" });

        (async () => {
          try {
            const init = await request(
              "initialize",
              {
                protocolVersion: 1,
                clientInfo: { name: "openmausbot", version: "0.0.0" },
                clientCapabilities: {
                  fs: {
                    readTextFile: support.clientFileSystem === true,
                    writeTextFile: support.clientFileSystem === true,
                  },
                  terminal: false,
                },
              },
              INIT_TIMEOUT,
            );
            const methods: Array<{ id?: string }> = Array.isArray(init?.authMethods) ? init.authMethods : [];
            const methodId = support.pickAuthMethod(methods);
            if (!skipSubscriptionAuthForLocalInject(turn.model)) {
              if (methodId) {
                try {
                  await request("authenticate", { methodId }, INIT_TIMEOUT);
                } catch {
                  if (support.authFailure === "fail") throw new Error(support.loginNote);
                  // else: proceed on an ambient login
                }
              } else if (support.authFailure === "fail") {
                throw new Error(support.loginNote);
              }
            }

            const images = turn.images ?? [];
            const runtimeAcceptsImages = init?.agentCapabilities?.promptCapabilities?.image === true;
            if (images.length && support.images === true && !runtimeAcceptsImages) {
              throw new Error(
                `${support.displayName} is configured for image attachments, but this installed runtime does not advertise ACP image input. Update the ${support.displayName} CLI or send the message without an image.`,
              );
            }

            const cursor = typeof turn.resumeCursor === "string" ? turn.resumeCursor : null;
            let sessionResult: any = null;
            if (cursor) {
              try {
                sessionResult = await request(
                  support.resumeMethod === "resume" ? "session/resume" : "session/load",
                  { sessionId: cursor, cwd, mcpServers },
                  LOAD_SESSION_TIMEOUT,
                );
                if (sessionResult) sessionId = cursor;
              } catch {
                /* session gone, load unsupported, or too slow — start fresh */
              }
            }
            if (!sessionId) {
              sessionResult = await request("session/new", { cwd, mcpServers }, NEW_SESSION_TIMEOUT);
              sessionId = typeof sessionResult?.sessionId === "string" ? sessionResult.sessionId : null;
              if (!sessionId) throw new Error("session/new returned no sessionId");
            }
            let selectedModel: string | null = null;
            let sessionStarted = false;
            const emitSessionStarted = () => {
              if (sessionStarted) return;
              sessionStarted = true;
              emit({
                ...base(threadId, turnId),
                type: "session.started",
                sessionId,
                model: selectedModel ?? init?._meta?.modelState?.currentModelId ?? cliTurn.model ?? null,
              });
            };

            try {
              if (support.selectModel) {
                const { configId } = support.selectModel;
                const currentOf = (r: any) =>
                  (Array.isArray(r?.configOptions) ? r.configOptions : []).find((o: any) => o?.id === configId)
                    ?.currentValue ?? null;
                selectedModel = currentOf(sessionResult);
                if (cliTurn.model && cliTurn.model !== selectedModel) {
                  selectedModel = currentOf(
                    await request(
                      "session/set_config_option",
                      { sessionId, configId, value: cliTurn.model },
                      INIT_TIMEOUT,
                    ),
                  );
                  // an agent that answers OK but keeps its old model is worse than
                  // one that errors: it burns a paid turn on the wrong thing
                  if (selectedModel !== cliTurn.model) {
                    throw new Error(
                      `${DRIVER_KIND} did not switch to ${cliTurn.model} (still ${selectedModel ?? "unknown"})`,
                    );
                  }
                }
              }

              if (support.configureSession) {
                await support.configureSession({
                  request: (method, params, timeoutMs) =>
                    request(method, params, timeoutMs ?? SESSION_CONFIG_TIMEOUT),
                  sessionId,
                  config: turnConfig,
                  turn: cliTurn,
                  sessionModels: Array.isArray(sessionResult?.models?.availableModels)
                    ? sessionResult.models.availableModels
                    : [],
                });
                // initialize's currentModelId is the CLI default (grok-4.6),
                // not the model this turn asked for. After a successful pin,
                // report the slug we set so the UI does not claim otherwise.
                if (!selectedModel && cliTurn.model) selectedModel = cliTurn.model;
              }
            } catch (error) {
              // session.started is the only place the resume cursor is recorded,
              // so a rejected setting must not orphan a session we just created.
              emitSessionStarted();
              throw error;
            }
            emitSessionStarted();
            state.promptSent = true;
            const text = support.buildPromptText
              ? support.buildPromptText(turn)
              : turn.system
                ? `${turn.system}\n\n${turn.text}`
                : turn.text;
            const imageBlocks = support.images === true && runtimeAcceptsImages
              ? await readAcpImageBlocks(images)
              : [];
            const result = await request("session/prompt", {
              sessionId,
              prompt: [{ type: "text", text }, ...imageBlocks],
            });
            // opencode 1.18.18 reports usage at the result root; grok and
            // gemini put it under _meta. Read both rather than lose the count.
            const usage = result?.usage ?? result?._meta ?? {};
            if (typeof usage.inputTokens === "number" || typeof usage.outputTokens === "number") {
              emit({
                ...base(threadId, turnId),
                type: "thread.token-usage.updated",
                input: usage.inputTokens ?? 0,
                output: usage.outputTokens ?? 0,
              });
            }
            const reason = result?.stopReason;
            if (reason === "end_turn") settle(true, null);
            else if (reason === "cancelled") settle(true, "cancelled");
            else {
              const errorMessage = typeof result?.error === "string" && result.error
                ? result.error
                : typeof result?.message === "string" && result.message
                  ? result.message
                  : `Model turn failed: ${reason ?? "unknown error"}`;
              emit({
                ...base(threadId, turnId),
                type: "runtime.error",
                message: errorMessage,
              });
              settle(false, reason ?? "failed");
            }
          } catch (e) {
            if (!state.settled) {
              const message = e instanceof Error ? e.message : String(e);
              const code = support.classifyError?.(e);
              // Authentication setup is a user action, not a retry. The
              // classifier is preferred; loginNote remains a compatibility
              // fallback for existing ACP supports.
              const needsAuth = code === "invalid_credentials" || code === "inactive_subscription"
                || message === support.loginNote;
              emit({
                ...base(threadId, turnId),
                type: "runtime.error",
                message,
                ...(needsAuth ? { setup: true } : {}),
              });
              settle(false, needsAuth ? "auth_required" : "rpc_error");
            }
          }
        })();

        return { turnId };
      };

      const snapshot = async (): Promise<ProviderSnapshot> => {
        const env = childEnv();
        if (support.snapshot) return support.snapshot(env, config, instanceId);
        const version = await new Promise<string | null>((resolve) => {
          execCli(config.cli, ["--version"], { timeout: 8000, env }, (err, stdout) =>
            resolve(err ? null : stdout.trim()),
          );
        });
        if (!version) return { state: "unavailable", reason: `\`${config.cli}\` CLI not found` };
        return { state: "available", version, authenticated: await support.isAuthenticated(env, config, instanceId) };
      };

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        displayName: input.displayName,
        enabled: input.enabled,
        get models() {
          return models;
        },
        refreshModels: support.resolveModels ? refreshModels : undefined,
        snapshot,
        adapter: {
          provider: DRIVER_KIND,
          capabilities: {
            sessionModelSwitch: "unsupported",
            agentsMcp: true,
        customMcp: true,
            computerMcp: true,
            composioMcp: true,
            browserMcp: true,
            images: support.images !== false,
            nativeImageInput: support.images === true,
            effortLevels: support.effortLevels,
            // OpenMausBot supplies a per-bot approvalMode on every harness
            // turn, which safely overrides a legacy instance fullAuto value.
            // Direct adapter calls that omit it still fail closed in sendTurn.
            localComputerMcp: true,
          },
          sendTurn,
          interruptTurn: async (threadId) => active.get(threadId)?.interrupt(),
          respondToRequest: async (threadId, requestId, decision) => {
            const turn = active.get(threadId);
            const finish = turn?.asks.get(requestId);
            if (!finish) return "unavailable"; // settled, timed out, or turn gone
            finish(decision.behavior, "user", decision.message);
            return decision.behavior === "allow"
              ? "allowed-once"
              : decision.behavior === "answer"
                ? "answered"
                : "rejected";
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
        dispose: async () => {
          for (const { stop } of active.values()) stop();
          listeners.clear();
        },
      };
    },
  };
}
