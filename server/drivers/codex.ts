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
// and preserves that history or reports a failed resume.
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { stripWorkspaceCredentialEnv } from "../config.ts";
import { describeSpawnFailure, execCli, killCliTree, spawnCli } from "../procs.ts";
import { isHarnessOwnedMcpEnvName } from "../mcp-registry.ts";

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
import { augmentedPath, splitCliString } from "../env-path.ts";
import { classifyError, computeBackoff, interruptibleDelay, RETRY_MAX_ATTEMPTS } from "./retry.ts";
import { appendNative } from "./native.ts";
import { commandSummary, toolDetailPreview } from "../tool-summary.ts";
import { codexDeveloperInstructions, syncCodexInstructions } from "./codex-instructions.ts";
import type { ApprovalMode } from "../../shared/approval-mode.ts";
import { CodexDeviceAuthController } from "./codex-device-auth.ts";
import { codexAccountEmail } from "./codex-identity.ts";
import { classifyResumeFailure, mayReplay, recoveryPromptFor } from "../resume-recovery.ts";

export { decodeCodexSelection, readCodexModelCatalog, STATIC_CODEX_MODELS } from "./codex-catalog.ts";

const DRIVER_KIND = "codex";
const ASTRA_MODEL_ID = "gpt-6-astra";
const ASTRA_MIN_CODEX_VERSION = [0, 153, 1] as const;

class CodexRpcError extends Error {
  code: unknown;

  constructor(error: { code?: unknown; message?: string }) {
    super(error.message ?? JSON.stringify(error));
    this.code = error.code;
  }
}

function missingNativeCodexThread(error: unknown, cursor: string): boolean {
  // Codex's local thread/resume rejection, verified with an empty native home.
  // A generic 404, auth error, timeout or prose mentioning a missing thread is
  // not evidence that the native history was lost. Unknown versions fail closed.
  return error instanceof CodexRpcError && error.code === -32600 &&
    error.message === `no rollout found for thread id ${cursor}`;
}

/** Whether an installed Codex predates the release that exposes GPT-6 Astra
 * through app-server. Unknown version formats stay quiet: a bad guess should
 * never nag someone whose custom build may already support the model. */
export function codexPredatesAstra(version: string): boolean {
  const value = version.trim();
  const match = /\bcodex-cli\s+v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9a-z.-]+)?(?![\d.])\b/i.exec(value)
    ?? /^v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9a-z.-]+)?$/i.exec(value);
  if (!match) return false;
  const installed = match.slice(1, 4).map(Number);
  for (let i = 0; i < ASTRA_MIN_CODEX_VERSION.length; i += 1) {
    if (installed[i] !== ASTRA_MIN_CODEX_VERSION[i]) {
      return installed[i] < ASTRA_MIN_CODEX_VERSION[i];
    }
  }
  return false;
}

/** Ask the configured executable to update itself. This matters when the user
 * selected a non-PATH Codex: installing a second global copy would leave
 * OpenMausBot pointing at the old binary. */
export function codexUpdateCommand(cli: string, platform: NodeJS.Platform = process.platform): string {
  if (cli === "codex") return "codex update";
  const trimmed = cli.trim();
  // Match resolveCliSpawn's one tokenizer pass, including its exception for
  // real unquoted paths containing spaces. A wrapper's fixed arguments must
  // precede `update`, just as they precede `app-server` and `--version`.
  const tokens = trimmed.includes(" ") && existsSync(trimmed)
    ? [trimmed]
    : splitCliString(trimmed);
  const quote = platform === "win32"
    ? (token: string) => `'${token.replaceAll("'", "''")}'`
    : (token: string) => `'${token.replaceAll("'", `'\\''`)}'`;
  const command = (tokens.length > 0 ? tokens : [trimmed]).map(quote).join(" ");
  return platform === "win32" ? `& ${command} update` : `${command} update`;
}

function codexAstraUpdate(
  version: string,
  models: typeof STATIC_CODEX_MODELS,
  cli: string,
): ProviderSnapshot["update"] | undefined {
  if (models.options.some((model) => model.id === ASTRA_MODEL_ID) || !codexPredatesAstra(version)) {
    return undefined;
  }
  return {
    title: "Update Codex for GPT-6 Astra",
    message:
      "This Codex version predates Astra support. Update it, then refresh models. Astra must also be available to your signed-in ChatGPT account.",
    command: codexUpdateCommand(cli),
  };
}

export interface CodexConfig {
  cli: string;
  fullAuto: boolean;
  /** Ephemeral Company routing, supplied by the trusted desktop parent. */
  managed?: { url: string; models: string[] };
}

function decodeConfig(raw: unknown): CodexConfig {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    cli: typeof o.cli === "string" ? o.cli : "codex",
    fullAuto: o.fullAuto === true,
    ...(o.managed && typeof o.managed === "object" ? { managed: decodeManagedCodex(o.managed) } : {}),
  };
}

function decodeManagedCodex(raw: object): NonNullable<CodexConfig["managed"]> {
  const value = raw as { url?: unknown; models?: unknown };
  if (typeof value.url !== "string" || !Array.isArray(value.models) || !value.models.length || value.models.some(model => typeof model !== "string" || !/^[\w][\w./+-]*$/.test(model))) {
    throw new Error("Invalid Company Codex configuration.");
  }
  const url = new URL(value.url);
  // Plain HTTP leaks the Company API key; allow it only on loopback hosts,
  // where a local proxy terminates TLS on the trusted machine instead.
  const loopback = url.hostname === "localhost" || url.hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))) throw new Error("Invalid Company Codex endpoint.");
  return { url: url.href.replace(/\/$/, ""), models: value.models as string[] };
}

export function managedCodexArgs(config: NonNullable<CodexConfig["managed"]>): string[] {
  // Credential stays in the instance environment, never argv or config.toml.
  // https://learn.chatgpt.com/docs/config-file/config-reference
  return [
    "-c", 'model_provider="openmaus_company"',
    "-c", 'model_providers.openmaus_company.name="Company"',
    "-c", `model_providers.openmaus_company.base_url=${JSON.stringify(config.url)}`,
    "-c", 'model_providers.openmaus_company.env_key="OPENMAUSBOT_COMPANY_API_KEY"',
    "-c", 'model_providers.openmaus_company.wire_api="responses"',
    "-c", "model_providers.openmaus_company.requires_openai_auth=false",
    "-c", 'cli_auth_credentials_store="ephemeral"',
    "-c", "shell_environment_policy.ignore_default_excludes=false",
  ];
}

const QUESTION_TIMEOUT_NOTE = "No answer was given — use your best judgment.";
const DENY_TIMEOUT_NOTE =
  "OpenMausBot: nobody answered this permission request in time. Skip this action and finish what you can without it.";

type StdioMcpServer = { command: string; args: string[]; env: Record<string, string> };

interface CodexApprovalParams {
  thread: Record<string, unknown>;
  turn: Record<string, unknown>;
  /** Safe legacy settings used only when an older app-server rejects the
   * negotiated named-profile field. */
  fallback?: Omit<CodexApprovalParams, "fallback">;
}

/** RequestPermissionProfile uses null for permission families that were not
 * requested; GrantedPermissionProfile requires those keys to be absent. */
function grantedPermissions(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).filter(([, value]) => value !== null && value !== undefined),
  );
}

function additionalPermissionSummary(permissions: unknown, reason: unknown): string {
  const requested = grantedPermissions(permissions);
  const exact = JSON.stringify(requested);
  const prefix = typeof reason === "string" && reason.trim() ? `${reason.trim()} — ` : "";
  return `${prefix}Requested permissions: ${exact}`;
}

type McpApprovalForm = {
  tool: string;
  summary: string;
  allowResult: { action: "accept"; content: Record<string, string> };
};

const plainRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const containsControlCharacter = (value: string): boolean => {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
};

function boundedLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const label = value.trim();
  return label && label.length <= 160 && !containsControlCharacter(label) ? label : null;
}

function ordinaryApprovalValue(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (/session|always|permanent|forever|persistent/.test(normalized)) return false;
  return normalized === "once" || /^(?:accept|approve|allow)(?:ed|[-_]?once)?$/.test(normalized);
}

/** Recognize only schema-backed app-access approvals. Arbitrary MCP forms
 * (credentials, free text, URLs, or required fields without a one-time enum)
 * remain user input and are declined; Full access never fabricates them. */
function mcpAppApprovalForm(params: unknown): McpApprovalForm | null {
  const request = plainRecord(params);
  if (!request || request.mode !== "form") return null;
  const metadata = plainRecord(request._meta);
  const target = plainRecord(metadata?.target);
  const toolParams = plainRecord(metadata?.tool_params);
  const message = boundedLabel(request.message) ?? "App access requested";
  const appName = [
    metadata?.app_name,
    metadata?.appName,
    metadata?.app,
    target?.app,
    target?.name,
    toolParams?.app_name,
    toolParams?.app,
    metadata?.connector_name,
    metadata?.connectorName,
  ].map(boundedLabel).find(Boolean) ?? message.match(/^Allow ChatGPT to use (.+?)\?$/i)?.[1]?.trim();
  // The application identity is the second half of the discriminator. A
  // required approval-looking enum by itself must not turn an arbitrary form
  // into a permission prompt.
  if (!appName) return null;

  const schema = plainRecord(request.requestedSchema);
  const properties = plainRecord(schema?.properties);
  const required = schema?.required;
  if (
    !properties ||
    !Array.isArray(required) ||
    required.length === 0 ||
    required.length > 8 ||
    !required.every((key) => typeof key === "string" && key.length > 0 && key.length <= 100)
  ) return null;

  const content: Record<string, string> = {};
  for (const key of required as string[]) {
    const field = plainRecord(properties[key]);
    if (!field) return null;
    const enumValues = Array.isArray(field.enum)
      ? field.enum.filter((value): value is string => typeof value === "string")
      : [];
    const oneOfValues = Array.isArray(field.oneOf)
      ? field.oneOf
          .map((option) => boundedLabel(plainRecord(option)?.const))
          .filter((value): value is string => Boolean(value))
      : [];
    const chosen = [...oneOfValues, ...enumValues].find(ordinaryApprovalValue);
    if (!chosen) return null;
    content[key] = chosen;
  }

  const tool = boundedLabel(appName) ?? boundedLabel(request.serverName) ?? "app_access";
  return { tool, summary: message, allowResult: { action: "accept", content } };
}

/** Codex persists these values on its native thread. Keep them explicit on
 * start, resume, and every turn so switching modes cannot leave a more
 * permissive sandbox/reviewer stuck to the next request. */
/** Ask and Edits both run Codex's workspace-write sandbox with the person as
 * reviewer: Codex has no narrower "edits only" mode, so the selector never
 * offers Edits for it (supportsApprovalMode) and a stray value asks. */
function namedApprovalParams(mode: Exclude<ApprovalMode, "custom">): CodexApprovalParams {
  if (mode === "full") {
    return {
      thread: {
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandbox: "danger-full-access",
      },
      turn: {
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandboxPolicy: { type: "dangerFullAccess" },
      },
    };
  }
  return {
    thread: {
      approvalPolicy: "on-request",
      approvalsReviewer: mode === "auto" ? "auto_review" : "user",
      sandbox: "workspace-write",
    },
    turn: {
      approvalPolicy: "on-request",
      approvalsReviewer: mode === "auto" ? "auto_review" : "user",
      sandboxPolicy: { type: "workspaceWrite" },
    },
  };
}

function effectiveApprovalPolicy(value: unknown): unknown {
  if (value === "untrusted" || value === "on-request" || value === "never") return value;
  const granular = plainRecord(plainRecord(value)?.granular);
  if (
    granular &&
    typeof granular.mcp_elicitations === "boolean" &&
    typeof granular.rules === "boolean" &&
    typeof granular.sandbox_approval === "boolean" &&
    (granular.request_permissions === undefined || typeof granular.request_permissions === "boolean") &&
    (granular.skill_approval === undefined || typeof granular.skill_approval === "boolean")
  ) {
    return {
      granular: {
        mcp_elicitations: granular.mcp_elicitations,
        rules: granular.rules,
        sandbox_approval: granular.sandbox_approval,
        ...(typeof granular.request_permissions === "boolean"
          ? { request_permissions: granular.request_permissions }
          : {}),
        ...(typeof granular.skill_approval === "boolean"
          ? { skill_approval: granular.skill_approval }
          : {}),
      },
    };
  }
  return "on-request";
}

function effectiveApprovalsReviewer(value: unknown): string {
  return value === "auto_review" || value === "guardian_subagent" ? value : "user";
}

function legacyCustomApprovalParams(config: Record<string, unknown>): CodexApprovalParams {
  const approvalPolicy = effectiveApprovalPolicy(config.approval_policy);
  const approvalsReviewer = effectiveApprovalsReviewer(config.approvals_reviewer);
  const sandbox = config.sandbox_mode === "workspace-write" ||
    config.sandbox_mode === "danger-full-access" ||
    config.sandbox_mode === "read-only"
    ? config.sandbox_mode
    : "read-only";
  let sandboxPolicy: Record<string, unknown>;
  if (sandbox === "danger-full-access") sandboxPolicy = { type: "dangerFullAccess" };
  else if (sandbox === "read-only") sandboxPolicy = { type: "readOnly" };
  else {
    const workspace = config.sandbox_workspace_write && typeof config.sandbox_workspace_write === "object"
      ? config.sandbox_workspace_write as Record<string, unknown>
      : {};
    sandboxPolicy = {
      type: "workspaceWrite",
      ...(Array.isArray(workspace.writable_roots) ? { writableRoots: workspace.writable_roots } : {}),
      ...(typeof workspace.network_access === "boolean" ? { networkAccess: workspace.network_access } : {}),
      ...(typeof workspace.exclude_slash_tmp === "boolean" ? { excludeSlashTmp: workspace.exclude_slash_tmp } : {}),
      ...(typeof workspace.exclude_tmpdir_env_var === "boolean"
        ? { excludeTmpdirEnvVar: workspace.exclude_tmpdir_env_var }
        : {}),
    };
  }
  return {
    thread: { approvalPolicy, approvalsReviewer, sandbox },
    turn: { approvalPolicy, approvalsReviewer, sandboxPolicy },
  };
}

/** config/read is the app-server's parsed, effective config boundary. Keep the
 * remaining wire validation deliberately small so quoted user profile ids are
 * not accidentally reinterpreted or logged as arbitrary config. */
function configuredPermissionProfile(config: Record<string, unknown>): string | null {
  if (typeof config.default_permissions !== "string") return null;
  const profile = config.default_permissions.trim();
  if (!profile || profile.length > 240 || containsControlCharacter(profile)) return null;
  return profile;
}

function customApprovalParams(raw: unknown): CodexApprovalParams {
  const config = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const fallback = legacyCustomApprovalParams(config);
  const permissions = configuredPermissionProfile(config);
  const approvalPolicy = effectiveApprovalPolicy(config.approval_policy);
  const approvalsReviewer = effectiveApprovalsReviewer(config.approvals_reviewer);
  // Codex 0.151 profiles define the sandbox, but approval policy remains an
  // independent setting. Reassert both approval fields so a resumed Full
  // thread cannot keep `never`; omit only the mutually-exclusive sandboxes.
  return permissions
    ? {
        thread: { permissions, approvalPolicy, approvalsReviewer },
        turn: { permissions, approvalPolicy, approvalsReviewer },
        fallback,
      }
    : fallback;
}

function permissionProfileUnsupported(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:experimental api|invalid params|unknown field|unknown.*permissions|permissions.*(?:unsupported|sandbox)|cannot.*permissions)/i.test(message);
}

/** Keep native instructions and private host paths out of diagnostics while
 * preserving enough of the input shape to debug delivery. The unmodified request is
 * still written to the provider immediately after this log copy is made. */
function codexNativeLogMessage(message: unknown): unknown {
  if (!message || typeof message !== "object" || Array.isArray(message)) return message;
  const record = message as Record<string, unknown>;
  const params = record.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) return message;
  if (record.method === "thread/start" || record.method === "thread/resume") {
    return { ...record, params: { ...params, developerInstructions: "[developer instructions omitted]" } };
  }
  if (record.method === "thread/inject_items") {
    return { ...record, params: { ...params, items: "[developer instruction update omitted]" } };
  }
  if (record.method !== "turn/start") return message;
  const input = (params as Record<string, unknown>).input;
  if (!Array.isArray(input)) return message;
  return {
    ...record,
    params: {
      ...params,
      input: input.map((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return item;
        const entry = item as Record<string, unknown>;
        return entry.type === "localImage"
          ? { ...entry, path: "[private attachment path omitted]" }
          : item;
      }),
    },
  };
}

/** Sanitize provider responses before the native diagnostic tee. Sensitive
 * request ids outlive the request promise, so a response arriving after its
 * timeout is still omitted rather than becoming a secret-bearing orphan. */
export function codexNativeIncomingLogMessage(
  message: any,
  sensitiveResponseIds: ReadonlySet<number>,
): unknown {
  if (message?.id !== undefined && sensitiveResponseIds.has(message.id)) {
    return {
      jsonrpc: message.jsonrpc,
      id: message.id,
      ...(message.error !== undefined
        ? { error: "[config/read error omitted]" }
        : { result: "[effective config omitted]" }),
    };
  }
  if (message?.method === "item/completed" && message.params?.item?.type === "imageGeneration") {
    return {
      ...message,
      params: {
        ...message.params,
        item: {
          ...message.params.item,
          result: `[generated image omitted · ${String(message.params.item.result ?? "").length} base64 chars]`,
          savedPath: undefined,
        },
      },
    };
  }
  return message;
}

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
    let models = config.managed ? { default: config.managed.models[0], options: config.managed.models.map(id => ({ id, label: id })) } : STATIC_CODEX_MODELS;
    const refreshModels = async () => {
      if (config.managed) return;
      try {
        const resolved = await readCodexModelCatalog(catalogEnv, fetch, config.cli);
        if (resolved.options.length) models = resolved;
      } catch {
        // Keep the last usable catalog when a local provider is down.
      }
    };
    await refreshModels();
    const authentication = new CodexDeviceAuthController({
      cli: config.cli,
      environment: childEnv,
      onAuthenticated: refreshModels,
    });
    const listeners = new Set<RuntimeEventListener>();
    interface Turn {
      stop: () => Promise<boolean>;
      turnId: string;
      asks: Map<string, (behavior: "allow" | "deny" | "answer", message?: string, source?: "user" | "timeout" | "system") => void>;
    }
    const active = new Map<string, Turn>();

    const emit = (event: RuntimeEvent) => {
      for (const l of Array.from(listeners)) l(event);
    };
    const base = (threadId: string, turnId: string) => ({
      eventId: newEventId(),
      provider: DRIVER_KIND,
      threadId,
      turnId,
      createdAt: new Date().toISOString(),
    });

    const sendTurn = async (turn: SendTurnInput) => {
      if (config.managed) {
        // One blanket refusal hides which prerequisite broke; name it so the
        // person can fix the actual gap instead of reconnecting blind.
        if (!turn.model) {
          throw new Error("Company model access is unavailable: no model is selected. Reconnect your organization; personal billing will not be used.");
        }
        if (!config.managed.models.includes(turn.model)) {
          throw new Error("Company model access is unavailable: " + turn.model + " is not approved for your organization. Reconnect your organization; personal billing will not be used.");
        }
        if (!input.environment.OPENMAUSBOT_COMPANY_API_KEY) {
          throw new Error("Company model access is unavailable: OPENMAUSBOT_COMPANY_API_KEY is missing. Reconnect your organization; personal billing will not be used.");
        }
        if (!input.environment.CODEX_HOME) {
          throw new Error("Company model access is unavailable: CODEX_HOME is missing. Reconnect your organization; personal billing will not be used.");
        }
      }
      // One driver instance serves many threads. Interrupt state belongs to
      // this turn so activity elsewhere cannot cancel or revive its retry.
      let stopRequested = false;
      let promptSubmitted = false;
      let recoveredMissingSession = false;
      // Wakes a retry backoff the moment Stop arrives, so the turn settles
      // now rather than after the full wait.
      const stopSignal = new AbortController();
      const { threadId } = turn;
      // Direct adapter callers predating the per-bot selector retain the
      // instance's legacy fullAuto setting. Harness turns always send an
      // explicit mode, which takes precedence.
      const approvalMode: ApprovalMode = turn.approvalMode ?? (config.fullAuto ? "full" : "ask");
      for (const [name, server] of Object.entries(turn.integrations?.custom ?? {})) {
        const reserved = Object.keys(server.env).find(isHarnessOwnedMcpEnvName);
        if (reserved) {
          throw new Error(`Custom MCP server “${name}” cannot set reserved environment variable “${reserved}”`);
        }
      }
      let autoAcceptPermissions = approvalMode === "full";
      if (active.has(threadId)) throw new Error("a turn is already running on this thread");
      const turnId = newId();
      // a retry relaunches the whole app-server; the backoff is scaled down in
      // tests so a fake's transient failures don't stall real seconds
      const retryScale = Number(process.env.FAKE_CODEX_RETRY_SCALE ?? "1");

      const launchAttempt = async (attempt: number): Promise<void> => {
        const env = childEnv();
        const appServerArgs = ["app-server", ...(config.managed ? managedCodexArgs(config.managed) : codexLocalProviderArgs(env, turn.model))];
        if (turn.integrations?.composio) {
          mountMcpServer(appServerArgs, env, "openmausbot_connectors", turn.integrations.composio);
        }
        if (turn.integrations?.agents) {
          mountMcpServer(appServerArgs, env, "agents", turn.integrations.agents);
        }
        if (turn.integrations?.localComputer) {
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
      let codexThreadId: string | null = null;
      let codexTurnId: string | null = null;
      let startingNativeTurn = false;
      const earlyNotifications: any[] = [];
      const state = {
        settled: false,
        lastError: "",
        lastText: "",
        sawStreamDelta: false,
        // codex reports token usage as a running total for this app-server
        // process. The harness wants this turn's figure: the total minus
        // whatever the process already carried before turn/start (a resumed
        // thread may restore earlier usage), banked on settle.
        usage: undefined as { input: number; output: number; cachedInput?: number } | undefined,
        usageBaseline: undefined as { input: number; output: number; cachedInput: number } | undefined,
      };

      const asks = new Map<string, (behavior: "allow" | "deny" | "answer", message?: string, source?: "user" | "timeout" | "system") => void>();
      let nextId = 1;
      const sensitiveResponseIds = new Set<number>();
      const rpcPending = new Map<number, {
        resolve: (v: any) => void;
        reject: (e: Error) => void;
      }>();

      const send = (obj: unknown) => {
        try {
          child.stdin.write(JSON.stringify(obj) + "\n");
        } catch {}
        appendNative(threadId, {
          dir: "out",
          source: "codex.app-server",
          msg: codexNativeLogMessage(obj),
        });
      };
      const request = (method: string, params: unknown, timeoutMs = 60_000) =>
        new Promise<any>((resolve, reject) => {
          const id = nextId++;
          if (method === "config/read") sensitiveResponseIds.add(id);
          // a wedged app-server can accept stdin and never reply; without this
          // the handshake await hangs forever and the bot stays busy for good
          const timer = setTimeout(() => {
            if (rpcPending.delete(id)) reject(new Error(`codex ${method} timed out after ${timeoutMs}ms`));
          }, timeoutMs);
          if (typeof timer.unref === "function") timer.unref();
          rpcPending.set(id, {
            resolve: (v) => {
              clearTimeout(timer);
              if (method === "thread/start" || method === "thread/resume") {
                // Notifications can follow the thread response in the same
                // stdout chunk, before the handshake await resumes.
                const returnedId = v?.thread?.id;
                const requestedId = method === "thread/resume"
                  && params && typeof params === "object" && "threadId" in params
                  ? params.threadId : null;
                if (typeof returnedId === "string" && returnedId) codexThreadId = returnedId;
                else if (typeof requestedId === "string" && requestedId) codexThreadId = requestedId;
              }
              if (method === "turn/start") {
                if (typeof v?.turn?.id !== "string" || !v.turn.id) {
                  reject(new Error("Codex did not return a native turn id"));
                  return;
                }
                // Bind synchronously: a single stdout chunk can contain the
                // response, streamed events, completion and a late request.
                codexTurnId = v.turn.id;
                startingNativeTurn = false;
                for (const notification of earlyNotifications.splice(0)) {
                  if (state.settled) break;
                  handleNotification(notification);
                }
              }
              resolve(v);
            },
            reject: (e) => {
              clearTimeout(timer);
              reject(e);
            },
          });
          send({ jsonrpc: "2.0", id, method, params });
        });

      let stopping: Promise<boolean> | undefined;
      const terminate = () => stopping ??= killCliTree(child).then((stopped) => {
        if (!stopped) stopping = undefined;
        return stopped;
      });
      let completeStoppedTurn: (() => void) | undefined;
      const stop = async () => {
        stopRequested = true;
        stopSignal.abort();
        const stopped = await terminate();
        if (stopped) completeStoppedTurn?.();
        return stopped;
      };

      const settle = async (ok: boolean, stopReason: string | null) => {
        if (state.settled) return;
        state.settled = true;
        for (const finish of Array.from(asks.values())) finish("deny", "OpenMausBot: the turn ended", "system");
        for (const p of rpcPending.values()) p.reject(new Error("turn settled"));
        rpcPending.clear();
        const complete = () => {
          if (active.get(threadId)?.stop !== stop) return;
          active.delete(threadId);
          emit({ ...base(threadId, turnId), type: "turn.completed", ok, stopReason, cost: null, ...(state.usage ? { usage: state.usage } : {}) });
        };
        completeStoppedTurn = complete;
        if (!(await stop())) {
          emit({ ...base(threadId, turnId), type: "runtime.error", message: "codex did not shut down after termination was requested" });
        }
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
        const isMcpElicitation = method === "mcpServer/elicitation/request";
        const isLegacyMcpPermission =
          method === "mcpServer/elicitation/request" &&
          params?._meta?.codex_approval_kind === "mcp_tool_call";
        const mcpAppApproval = isMcpElicitation ? mcpAppApprovalForm(params) : null;
        const isMcpPermission = isLegacyMcpPermission || mcpAppApproval !== null;
        const isQuestion = method === "item/tool/requestUserInput";
        const isAdditionalPermission = method === "item/permissions/requestApproval";
        const isPermission = legacy || isMcpPermission || isAdditionalPermission ||
          method === "item/commandExecution/requestApproval" ||
          method === "item/fileChange/requestApproval";
        // A normal MCP elicitation is a form or URL asking for real user input,
        // not a permission. We cannot safely synthesize its structured answer.
        // Unknown future server requests also fail closed instead of being
        // mistaken for commands and accepted by Full Access.
        if (!isQuestion && !isPermission) {
          if (isMcpElicitation) {
            send({ jsonrpc: "2.0", id: msg.id, result: { action: "decline" } });
          } else {
            send({
              jsonrpc: "2.0",
              id: msg.id,
              error: { code: -32601, message: `Unsupported server request: ${method}` },
            });
          }
          return;
        }
        // One ask card carries one question honestly: its choices would come
        // from the first question alone and its one reply (including the
        // timeout note) would be copied into every question id (#1237).
        // Refuse the bundled call with a teaching error instead of
        // fabricating per-question answers.
        if (isQuestion && (!Array.isArray(params.questions) || params.questions.length !== 1)) {
          const bundled = Array.isArray(params.questions) && params.questions.length > 1;
          send({
            jsonrpc: "2.0",
            id: msg.id,
            error: {
              code: -32602,
              message: bundled
                ? `ask supports one question per call; this request bundled ${params.questions.length}. Split it into separate asks, one question each.`
                : Array.isArray(params.questions)
                ? "ask supports one question per call; this request sent none."
                : "ask supports one question per call; params.questions must be an array with exactly one question.",
            },
          });
          return;
        }
        const mcpTool = isLegacyMcpPermission
          ? String(params.message ?? "").match(/tool "([^"]+)"/)?.[1]
          : undefined;
        const tool =
          mcpAppApproval
            ? mcpAppApproval.tool
            : isLegacyMcpPermission
            ? (mcpTool ?? "mcp")
            : isAdditionalPermission
              ? "permissions"
            : method === "item/fileChange/requestApproval" || method === "applyPatchApproval"
            ? "edit"
            : isQuestion
              ? "ask_user"
              : "shell";
        const permissionResult = (allow: boolean) =>
          isMcpPermission
            ? allow
              ? (mcpAppApproval?.allowResult ?? { action: "accept", content: {} })
              : { action: "decline" }
            : isAdditionalPermission
              ? { permissions: allow ? grantedPermissions(params.permissions) : {}, scope: "turn" }
              : { decision: allow ? (legacy ? "approved" : "accept") : legacy ? "denied" : "decline" };
        if (autoAcceptPermissions && isPermission) {
          return send({
            jsonrpc: "2.0",
            id: msg.id,
            result: permissionResult(true),
          });
        }
        const requestId = newId();
        const summary =
          isAdditionalPermission
            ? additionalPermissionSummary(params.permissions, params.reason)
            : isMcpPermission
            ? (mcpAppApproval?.summary ?? (typeof params.message === "string" ? params.message : "MCP access requested"))
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
              result: permissionResult(behavior === "allow"),
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
          requiresExplicitApproval: isAdditionalPermission || undefined,
        });
      };

      const handleNotification = (msg: any) => {
        const p = msg.params ?? {};
        // An app-server also emits notifications for native helper threads.
        // Only this request's parent may write its transcript/usage or settle
        // its run. Requests still use the approval broker above, including
        // helper requests; ignoring child *notifications* must not grant tools.
        const connectionError = msg.method === "error" &&
          !("threadId" in p) && !("turnId" in p);
        if (!connectionError) {
          if (!codexThreadId || p.threadId !== codexThreadId) return;
          if (!codexTurnId && msg.method === "thread/tokenUsage/updated" && p.tokenUsage?.total) {
            // A total reported before this turn exists is what the process
            // carried in — a resumed thread restoring earlier usage. It is the
            // baseline this turn's figure is measured from, never a reading to
            // buffer and replay as if this turn produced it. (Codex names the
            // turn before any model call, so a genuine first reading cannot
            // land here.)
            const t = p.tokenUsage.total;
            state.usageBaseline = { input: t.inputTokens ?? 0, output: t.outputTokens ?? 0, cachedInput: t.cachedInputTokens ?? 0 };
            return;
          }
          if (!codexTurnId) {
            // Some servers stream before acknowledging turn/start. Retain a
            // bounded prefix, then filter against the authoritative response.
            if (startingNativeTurn) {
              if (earlyNotifications.length >= 1024) {
                void settle(false, "too_many_events_before_turn_start");
              } else {
                earlyNotifications.push(msg);
              }
            }
            return;
          }
          const eventTurnId = msg.method === "turn/started" || msg.method === "turn/completed"
            ? p.turn?.id : p.turnId;
          if (eventTurnId !== codexTurnId) return;
        }
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
            if (title) {
              emit({
                ...base(threadId, turnId),
                type: "item.started",
                itemType: "tool",
                itemId: item.id,
                title,
                summary: item.type === "commandExecution" ? commandSummary({ command: item.command }) : undefined,
                input: toolDetailPreview(item.type === "commandExecution" ? { command: item.command, cwd: item.cwd } : item.type === "mcpToolCall" ? item.arguments : item.type === "fileChange" ? item.changes : item.query),
              });
            }
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
                output: toolDetailPreview(item.type === "commandExecution" ? { output: item.aggregatedOutput, exitCode: item.exitCode } : item.type === "mcpToolCall" ? item.error ?? item.result : item.type === "fileChange" ? item.changes : item.action),
              });
            } else if (item.type === "reasoning") {
              emit({ ...base(threadId, turnId), type: "item.updated", itemType: "reasoning", tokens: null });
            }
            break;
          }
          case "thread/tokenUsage/updated": {
            // `total` is everything this app-server process has used; `last`
            // is the most recent model call. This turn's figure is the total
            // minus what the process carried before turn/start went out (a
            // resumed thread can restore earlier usage), so it never grows by
            // the whole thread per message and never counts only the final
            // call of a multi-step turn. codex's inputTokens already includes
            // cachedInputTokens; the cached share rides alongside so the UI
            // can say how much was context re-read rather than new text.
            const t = p.tokenUsage?.total;
            const last = p.tokenUsage?.last;
            const shape = (u: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number }) => ({
              input: u.inputTokens ?? 0, output: u.outputTokens ?? 0, cachedInput: u.cachedInputTokens ?? 0,
            });
            // (A total that arrived before this turn was named became the
            // baseline upstream and never reaches this switch.)
            if (t) {
              const b = state.usageBaseline ?? { input: 0, output: 0, cachedInput: 0 };
              const now = shape(t);
              state.usage = {
                input: Math.max(0, now.input - b.input),
                output: Math.max(0, now.output - b.output),
                ...(typeof t.cachedInputTokens === "number" ? { cachedInput: Math.max(0, now.cachedInput - b.cachedInput) } : {}),
              };
            } else if (last) {
              state.usage = { input: last.inputTokens ?? 0, output: last.outputTokens ?? 0, ...(typeof last.cachedInputTokens === "number" ? { cachedInput: last.cachedInputTokens } : {}) };
            }
            if (t) {
              const window = p.tokenUsage?.modelContextWindow;
              emit({
                ...base(threadId, turnId),
                type: "thread.token-usage.updated",
                input: t.inputTokens ?? 0,
                output: t.outputTokens ?? 0,
                ...(typeof t.cachedInputTokens === "number" ? { cachedInput: t.cachedInputTokens } : {}),
                // the last call's prompt is what fills the window
                ...(last && typeof last.inputTokens === "number" ? { contextTokens: last.inputTokens } : {}),
                ...(typeof window === "number" && window > 0 ? { contextWindow: window } : {}),
              });
            }
            break;
          }
          case "turn/completed": {
            const t = p.turn ?? {};
            const message = typeof t.error?.message === "string" ? t.error.message.slice(0, 400) : "";
            if (t.status !== "completed" && message && message !== state.lastError) {
              state.lastError = message;
              emit({ ...base(threadId, turnId), type: "runtime.error", message,
                ...(classifyError({ text: message }).reason === "auth" ? { setup: true } : {}),
              });
            }
            void settle(t.status === "completed", t.status === "completed" ? null :
              (classifyError({ text: message || state.lastError }).reason === "provider_safety" ? "provider_safety" : (message || t.status || "failed")));
            break;
          }
          case "error":
            // shape drift: 0.144 sends {message}, 0.139 nests it under
            // {error:{message}} — surface either (agentcal armor)
            {
              const message = p.message ?? p.error?.message;
              if (message) {
                state.lastError = String(message).slice(0, 400);
                emit({ ...base(threadId, turnId), type: "runtime.error", message: state.lastError });
              }
            }
            break;
        }
      };

      let buf = "";
      // decode as UTF-8 across chunk boundaries — a raw `buf += chunk` splits
      // multibyte characters that straddle two reads and corrupts the text
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        if (abandoned || state.settled) return;
        buf += chunk;
        let nl;
        while (!state.settled && (nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          let msg: any;
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }
          stderrSinceOutput = "";
          const loggedMessage = codexNativeIncomingLogMessage(msg, sensitiveResponseIds);
          appendNative(threadId, { dir: "in", source: "codex.app-server", msg: loggedMessage });
          if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
            const pend = rpcPending.get(msg.id);
            if (pend) {
              rpcPending.delete(msg.id);
              if (msg.error) pend.reject(new CodexRpcError(msg.error));
              else pend.resolve(msg.result);
            }
          } else if (msg.id !== undefined && msg.method) {
            handleServerRequest(msg);
          } else if (msg.method) {
            handleNotification(msg);
          }
        }
      });

      let stderr = "";
      // Stderr that arrived after the last parsed protocol message. The
      // full buffer accumulates for the whole process lifetime, so its
      // tail can name a long-past event (a websocket 426 logged at turn
      // start, echoed half an hour later when something else kills the
      // process). Only this slice can explain an exit; older bytes are
      // context, not cause.
      let stderrSinceOutput = "";
      child.stderr.on("data", (c) => {
        stderr += c;
        stderrSinceOutput += c;
        if (stderr.length > 8192) stderr = stderr.slice(-8192);
        if (stderrSinceOutput.length > 2048) stderrSinceOutput = stderrSinceOutput.slice(-2048);
      });
      child.on("error", (e) => {
        if (abandoned) return;
        emit({ ...base(threadId, turnId), type: "runtime.error", ...describeSpawnFailure(e, config.cli) });
        void settle(false, "spawn_error");
      });
      child.on("close", (code, signal) => {
        if (abandoned) return;
        if (state.settled) {
          // Root exit alone cannot release a turn after an uncertain stop.
          // Recheck its group; an explicit later Stop can also retry this.
          void stop();
          return;
        }
        // The child died before the turn completed. Attribute the exit
        // honestly: name the signal when it was killed, and only quote
        // stderr that arrived after the last protocol message. A stale
        // tail here once misattributed a whole day of killed turns to a
        // websocket 426 logged at turn start.
        const recentStderr = stderrSinceOutput.trim();
        const hadStreamedOutput = codexTurnId !== null || state.sawStreamDelta;
        // A signal exit is terminal no matter what the stderr says:
        // something killed the process (OOM, kill -9), and classifyError
        // cannot see the signal — with code null, transient-looking recent
        // stderr could still mark a killed attempt retryable.
        // Classification also reads only stderr received after the last
        // protocol output; the lifetime buffer's tail can name a
        // long-past event (the websocket-426 misattribution).
        const verdict =
          signal !== null
            ? { transient: false, reason: "interrupted" }
            : classifyError({ exitCode: code, stderr: recentStderr });
        // Safe re-dispatch: relaunch only when the app-server never
        // acknowledged turn/start — no native turn began, nothing was
        // streamed, so replaying the input cannot duplicate work. After
        // any acknowledgement (or any buffered pre-ack event) the turn
        // settles instead: a replay could re-run tools the user saw.
        if (
          !stopRequested && codexTurnId === null && earlyNotifications.length === 0 &&
          verdict.transient && attempt < RETRY_MAX_ATTEMPTS - 1
        ) {
          const delayMs = computeBackoff(attempt);
          attempt++;
          emit({
            ...base(threadId, turnId),
            type: "turn.retrying",
            attempt,
            delayMs,
            reason: verdict.reason,
          });
          // Retire this attempt before anything async runs, so a late
          // rpc timer rejection in the handshake catch cannot relaunch
          // a second time on top of this one.
          abandoned = true;
          void (async () => {
            const alreadyDead = child.exitCode !== null || child.signalCode !== null;
            if (!alreadyDead && !(await terminate())) {
              void settle(false, "shutdown_timeout");
              return;
            }
            await interruptibleDelay(Math.max(1, Math.round(delayMs * retryScale)), stopSignal.signal).promise;
            if (!stopRequested) {
              void launchAttempt(attempt).catch(() => {});
            } else {
              await settle(false, "interrupted");
            }
          })().catch(() => {});
          return;
        }
        emit({
          ...base(threadId, turnId),
          type: "runtime.error",
          message: `codex exited ${code}${signal ? ` (signal ${signal})` : ""} before turn/completed${
            recentStderr ? `: ${recentStderr.slice(-300)}` : hadStreamedOutput && stderr.trim() ? "; no stderr after the last app-server output" : ""
          }`,
        });
        void settle(false, "exit_before_result");
      });

      active.set(threadId, { stop, turnId, asks });
      // Relaunching the app-server is still the same logical turn. Keep the
      // active process current on every attempt, but announce the turn once.
      if (attempt === 0) emit({ ...base(threadId, turnId), type: "turn.started" });

      // handshake + kickoff; a transient failure (5xx/overloaded/reset) gets
      // one relaunch of the whole app-server after backoff — but only when
      // nothing streamed yet, and never for auth/shape errors or interrupts
      try {
        await request("initialize", {
          clientInfo: { name: "openmausbot", version: "1" },
          // Named permission profiles are an experimental app-server field in
          // Codex 0.151. Negotiate them explicitly; older servers ignore this
          // capability and remain on the legacy Custom fallback below.
          capabilities: { experimentalApi: true },
        });
        send({ jsonrpc: "2.0", method: "initialized", params: {} });
        // developerInstructions replaces, rather than appends to, native
        // config. Read it for every approval mode so existing rules survive.
        // request() already redacts config/read responses from native logs.
        let effectiveConfig: unknown;
        try {
          const configured = await request("config/read", {
            cwd: turn.cwd ?? homedir(),
            includeLayers: false,
          });
          effectiveConfig = configured?.config;
        } catch {
          // Do not expose a possibly secret-bearing native config error or
          // overwrite unknown instructions with an empty fallback.
          throw new Error("Could not read Codex configuration; cannot safely update bot instructions. Retry after checking Codex.");
        }
        const developerInstructions = codexDeveloperInstructions(effectiveConfig, turn.system ?? "");
        let approvalParams: CodexApprovalParams;
        if (approvalMode === "custom") {
          // config/read returns the effective global + project config for this
          // cwd. Reasserting those values is essential: simply omitting them
          // on a resumed thread would keep the previous named mode sticky.
          approvalParams = customApprovalParams(effectiveConfig);
        } else {
          approvalParams = namedApprovalParams(approvalMode);
        }
        // Codex's `never` means "do not ask to escalate", not "grant every
        // requested permission". Only the user's explicit OpenMausBot Full
        // mode may synthesize approvals; Custom must preserve the sandbox
        // boundary from config.toml (for example never + read-only).
        autoAcceptPermissions = approvalMode === "full";
        // Each turn launches a new app-server. Reassert current bot instructions
        // on start AND resume so Codex owns their lifetime through compaction.
        // Removed bot rules are cleared without dropping native configured rules.
        const cursor = typeof turn.resumeCursor === "string" ? turn.resumeCursor : null;
        let startedModel: string | null = null;
        let resumedNativeThread = false;
        let promptText = turn.text;
        if (cursor) {
          const resumeThread = () => request("thread/resume", {
            threadId: cursor,
            developerInstructions,
            ...approvalParams.thread,
          });
          try {
            let resumed;
            try {
              resumed = await resumeThread();
            } catch (error) {
              if (!approvalParams.fallback || !permissionProfileUnsupported(error)) throw error;
              // Older servers may require the legacy permission selector, but
              // still resume the same native thread before any user submission.
              approvalParams = approvalParams.fallback;
              resumed = await resumeThread();
            }
            codexThreadId = resumed?.thread?.id ?? cursor;
            resumedNativeThread = true;
          } catch (error) {
            const failure = classifyResumeFailure({
              attempted: true,
              rejected: error instanceof CodexRpcError,
              promptSubmitted,
              producedOutput: state.sawStreamDelta,
            });
            if (!config.managed || recoveredMissingSession || stopRequested || state.settled ||
                !turn.recoveryText?.trim() || !missingNativeCodexThread(error, cursor) || !mayReplay(failure)) throw error;
            // The prompt has never been submitted. Rebuild only missing Company
            // histories, once, through the same approved model/provider below.
            recoveredMissingSession = true;
            promptText = recoveryPromptFor({ recoveryText: turn.recoveryText, currentText: turn.text, failure }).text;
          }
        }
        if (!codexThreadId) {
          const selection = config.managed ? { model: turn.model, modelProvider: "openmaus_company" } : decodeCodexSelection(turn.model);
          const startThread = () => request("thread/start", {
              developerInstructions,
              cwd: turn.cwd ?? homedir(),
              model: selection.model,
              ...(selection.modelProvider ? { modelProvider: selection.modelProvider } : {}),
              ...approvalParams.thread,
              ephemeral: false,
            });
          let started;
          try {
            started = await startThread();
          } catch (error) {
            if (!approvalParams.fallback || !permissionProfileUnsupported(error)) throw error;
            approvalParams = approvalParams.fallback;
            started = await startThread();
          }
          codexThreadId = started?.thread?.id ?? null;
          startedModel = started?.model ?? null;
        }
        if (!codexThreadId) throw new Error("Codex did not return a native thread id");
        await syncCodexInstructions(threadId, codexThreadId, developerInstructions, resumedNativeThread, request);
        emit({ ...base(threadId, turnId), type: "session.started", sessionId: codexThreadId, model: startedModel ?? turn.model ?? null });
        const turnInput = [
          ...(promptText ? [{ type: "text" as const, text: promptText }] : []),
          ...(turn.images ?? []).map((image) => ({ type: "localImage" as const, path: image.path })),
        ];
        const startTurn = () => {
          promptSubmitted = true;
          startingNativeTurn = true;
          return request("turn/start", {
            threadId: codexThreadId,
            input: turnInput,
            ...approvalParams.turn,
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
        };
        try {
          await startTurn();
        } catch (error) {
          if (!approvalParams.fallback || !permissionProfileUnsupported(error)) throw error;
          approvalParams = approvalParams.fallback;
          await startTurn();
        }
      } catch (e) {
        const failure = e instanceof Error ? e : { text: String(e) };
        const message = e instanceof Error ? e.message : String(e);
        const needsAuth = /(?:\b401\b|unauthorized|missing bearer|authentication required)/i.test(message);
        const verdict = classifyError(failure);
        // Three guards hold here: main's abandoned attempt never retries,
        // neither does a Company session already recovered once from canonical
        // history, and a Stop already asked for must not be undone by a relaunch.
        if (!state.settled && !abandoned && !recoveredMissingSession && !stopRequested && !needsAuth && verdict.transient && attempt < RETRY_MAX_ATTEMPTS - 1 && state.sawStreamDelta === false) {
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
          if (!await terminate()) {
            void settle(false, "shutdown_timeout");
            return;
          }
          await interruptibleDelay(Math.max(1, Math.round(delayMs * retryScale)), stopSignal.signal).promise;
          if (!stopRequested) {
            void launchAttempt(attempt).catch(() => {});
          } else {
            await settle(false, "interrupted");
          }
          return;
        }
        // abandoned marks an attempt retired by a retry; its late rpc
        // timeouts must neither report a spurious error nor relaunch again
        if (!state.settled && !abandoned) {
          emit({
            ...base(threadId, turnId),
            type: "runtime.error",
            message,
            ...(needsAuth ? { setup: true } : {}),
          });
          await settle(false, needsAuth ? "auth_required" : verdict.reason === "provider_safety" ? "provider_safety" : "rpc_error");
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
    if (config.managed) return { state: "available", version, authenticated: Boolean(input.environment.OPENMAUSBOT_COMPANY_API_KEY && input.environment.CODEX_HOME), billing: "metered" };
    const authenticated = await new Promise<boolean>((resolve) => {
      execCli(config.cli, ["login", "status"], { timeout: 8000, env }, (err, stdout, stderr) =>
        resolve(!err && /^logged in\b/im.test(`${stdout}\n${stderr ?? ""}`)),
      );
    });
    // Display identity only, so Settings can say whose ChatGPT account the
    // bots run on; the status command above stays the authority on sign-in.
    const email = authenticated ? await codexAccountEmail(config.cli, env) : null;
    // childEnv drops OPENAI_API_KEY on purpose — turns run on the ChatGPT login
    return {
      state: "available",
      version,
      authenticated,
      ...(email ? { account: { email } } : {}),
      update: codexAstraUpdate(version, models, config.cli),
      billing: "subscription",
    };
  };

  // Phase 3 part 3: the one-shot the harness's verifier (and any other
  // harness-initiated call) needs. `codex exec` reads the prompt from stdin
  // (Windows' argv limit), runs read-only and ephemeral, and writes its last
  // message to a file; that file is the answer. No session, no tools.
  const codexOneShot = (prompt: string, opts?: { cwd?: string }): Promise<string> =>
    new Promise((resolve, reject) => {
      const outFile = join(tmpdir(), `omb-codex-oneshot-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`);
      const args = ["exec", "--skip-git-repo-check", "--ephemeral", "-s", "read-only", "-m", models.default, "-o", outFile, "-"];
      let stdout = "";
      let stderr = "";
      let done = false;
      const child = spawnCli(config.cli, args, { cwd: opts?.cwd ?? homedir(), env: childEnv(), stdio: ["pipe", "pipe", "pipe"] });
      const finish = (error: Error | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        let text = "";
        try { text = readFileSync(outFile, "utf8"); } catch { text = ""; }
        try { unlinkSync(outFile); } catch { /* never written */ }
        if (error) { reject(error); return; }
        resolve((text.trim() || stdout.trim().split("\n").filter(Boolean).at(-1) || "").trim());
      };
      const timer = setTimeout(() => { killCliTree(child); finish(new Error("codex exec did not answer within 180 s")); }, 180_000);
      child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
      child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
      child.on("error", (error) => finish(error));
      child.on("close", (code) => finish(code === 0 ? null : new Error(`codex exec exited ${code}: ${stderr.trim().slice(-300)}`)));
      child.stdin?.end(prompt);
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
    startAuthentication: () => authentication.start(),
    getAuthentication: (flowId) => authentication.get(flowId),
    cancelAuthentication: () => authentication.cancel(),
    signOut: () => authentication.signOut(),
    generateText: codexOneShot,
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
        nativeImageInput: true,
        effortLevels: ["low", "medium", "high", "xhigh", "max"],
      },
      sendTurn,
      interruptTurn: async (threadId) => {
        await active.get(threadId)?.stop();
      },
      respondToRequest: async (threadId, requestId, decision) => {
        const turn = active.get(threadId);
        const finish = turn?.asks.get(requestId);
        if (!finish) return "unavailable"; // settled, timed out, or turn gone
        finish(decision.behavior, decision.message, "user");
        return decision.behavior === "allow" ? "allowed-once" : decision.behavior === "answer" ? "answered" : "rejected";
      },
      hasSession: (threadId) => active.has(threadId),
      stopAll: async () => {
        await Promise.all([...active.values()].map(({ stop }) => stop()));
      },
      onEvent: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    dispose: async () => {
      await authentication.dispose();
      await Promise.all([...active.values()].map(({ stop }) => stop()));
      listeners.clear();
    },
  };
},
};
