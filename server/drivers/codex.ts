import { codexToolSurfaceArgs } from "./codex-tool-surface.ts";
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
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import { codexConfigMcpServerNames, mountedMcpServerName } from "./codex-mcp-names.ts";

import { DATA_DIR, stripWorkspaceCredentialEnv } from "../config.ts";
import { laterStartup, openStartupModelCatalog, writeStartupModelCache } from "../startup-model-catalog.ts";
import { hostedWorkspaceConfigured } from "../enterprise.ts";
import { cloudHomeConfigured } from "../cloud-home.ts";
import { serverVersion } from "../environment.ts";
import { ChatGptPlanAuthController } from "./chatgpt-plan-auth.ts";
import { describeSpawnFailure, execCli, killCliTree, spawnCli } from "../procs.ts";
import { isHarnessOwnedMcpEnvName } from "../mcp-registry.ts";

import type {
  DriverCreateInput,
  McpServerSpec,
  ProviderDriver,
  ProviderInstance,
  ProviderSnapshot,
  RuntimeEvent,
  RuntimeEventListener,
  SendTurnInput,
  StdioMcpSpec,
  SteerOutcome,
} from "../contracts.ts";
import { newEventId, newId } from "../contracts.ts";
import { decodeCodexSelection, OFFICIAL_CODEX_PROVIDER, readCodexModelCatalog, STATIC_CODEX_MODELS } from "./codex-catalog.ts";
import { codexLocalProviderArgs } from "./local-inject.ts";
import { augmentedPath, splitCliString } from "../env-path.ts";
import { classifyError, computeBackoff, interruptibleDelay, RETRY_MAX_ATTEMPTS } from "./retry.ts";
import { appendNative } from "./native.ts";
import { permissionCommand, permissionLaunchCwd } from "./permission-command.ts";
import { commandSummary, toolDetailPreview } from "../tool-summary.ts";
import { codexDeveloperInstructions, syncCodexInstructions } from "./codex-instructions.ts";
import { volatileContextNote, withContextNote } from "./prompt-split.ts";
import type { ApprovalMode } from "../../shared/approval-mode.ts";
import { CodexDeviceAuthController } from "./codex-device-auth.ts";
import { codexAccountEmail, codexHome } from "./codex-identity.ts";
import { keyRejected, noteKeyAccepted, noteKeyRejected } from "../key-rejections.ts";
import { classifyResumeFailure, mayReplay, rebuiltSessionNotice, recoveryPromptFor } from "../resume-recovery.ts";
import { extractMcpImages } from "../mcp-tool-images.ts";
import { parseProtocolAskQuestions, questionAnswersById, questionChoices } from "../../shared/ask-question.ts";
import { codexVersionBehind, readLatestCodexRelease } from "./codex-release.ts";
import { canUseMcpServer } from "../../shared/tool-scope.ts";
import { assertToolScopeSupported } from "../../shared/tool-scope-support.ts";
import { gateServer, mcpStdioServer } from "../mcp-gate-config.ts";
import { CALL_TOOL, DESCRIBE_TOOL, SEARCH_TOOL, directoryCallTarget } from "../mcp-directory.ts";

export { decodeCodexSelection, readCodexModelCatalog, STATIC_CODEX_MODELS } from "./codex-catalog.ts";

const DRIVER_KIND = "codex";

export function codexUserError(value: string, chatgptPlan: boolean): string {
  if (chatgptPlan && value.includes("subscription_sharing_usage_limit_exceeded")) {
    return "subscription_sharing_usage_limit_exceeded: Your ChatGPT plan usage limit was reached. Manage usage in ChatGPT Settings, or explicitly choose another provider.";
  }
  if (value.includes("provider_not_configured")) {
    return chatgptPlan
      ? "provider_not_configured: ChatGPT has not enabled this model for the selected account. Refresh models or reconnect ChatGPT plan in Settings. API billing will not be used."
      : "provider_not_configured: This Codex account cannot use the selected route. For the new ChatGPT plan models, choose ChatGPT plan in Settings → Engines and Continue with ChatGPT, then select a model from that account.";
  }
  return value.slice(0, 400);
}

// Codex's own words when OpenAI refuses its stored ChatGPT login (codex-cli
// 0.160 login/src/auth: workspace routing, token refresh, auth storage).
const CODEX_SIGN_IN_REFUSED = /workspace routing discovery unauthorized|access token could not be refreshed|authentication session could not be refreshed|ChatGPT login is required|auth data is not available|please (?:log out and )?sign in again/i;

/** A turn error (TurnError: message, codexErrorInfo) that says Codex's own
 * sign-in was refused: `unauthorized`, a 401 from the model backend, or one
 * of Codex's sign-in messages. A 401 from an MCP server or a tool reaches the
 * model as a tool result, never as a turn error, so it cannot land here. */
export function codexSignInRefused(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { message, codexErrorInfo: info } = error as { message?: unknown; codexErrorInfo?: unknown };
  if (info === "unauthorized") return true;
  if (info && typeof info === "object" &&
    Object.values(info).some((variant) => (variant as { httpStatusCode?: unknown } | null)?.httpStatusCode === 401)) return true;
  return typeof message === "string" && CODEX_SIGN_IN_REFUSED.test(message);
}

export const CODEX_SIGN_IN_EXPIRED = "Codex's ChatGPT sign-in has expired. Sign in again in Settings → Model providers → Codex.";

/** The plain sentence first, so a peer bot's one-line report keeps it;
 * Codex's own words follow as the detail. */
export function codexSignInExpired(raw: string): string {
  return `${CODEX_SIGN_IN_EXPIRED} Codex said: ${raw.slice(0, 300)}`;
}

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

async function codexReleaseUpdate(version: string, cli: string): Promise<ProviderSnapshot["update"] | undefined> {
  const latest = await readLatestCodexRelease();
  if (!latest || !codexVersionBehind(version, latest)) return undefined;
  return {
    title: `Update Codex to ${latest}`,
    message: `A newer stable Codex CLI is available (installed: ${version}). Update it, then refresh models. Model availability also depends on your signed-in account.`,
    command: codexUpdateCommand(cli),
  };
}

export interface CodexConfig {
  cli: string;
  fullAuto: boolean;
  authMode?: "chatgpt-plan";
  /** Ephemeral Company routing, supplied by the trusted desktop parent. */
  managed?: { url: string; models: string[] };
}

function decodeConfig(raw: unknown): CodexConfig {
  const o = (raw ?? {}) as Record<string, unknown>;
  if (o.authMode !== undefined && o.authMode !== "chatgpt-plan") throw new Error("Unknown Codex sign-in mode.");
  if (o.authMode && o.managed) throw new Error("ChatGPT plan and Company billing cannot be combined.");
  return {
    cli: typeof o.cli === "string" ? o.cli : "codex",
    fullAuto: o.fullAuto === true,
    ...(o.authMode === "chatgpt-plan" ? { authMode: "chatgpt-plan" as const } : {}),
    ...(o.managed && typeof o.managed === "object" ? { managed: decodeManagedCodex(o.managed) } : {}),
  };
}

/** The documented token-sharing Responses bridge carries no hosted
 * tool_search (#2035 verified Codex 0.159.0 sends none), so a plan turn's
 * MCP tools are all loaded up front. Its URL servers go through the remote
 * proxy's tool directory instead (mcp-directory.ts). */
export function chatgptPlanCodexArgs(): string[] {
  return [
    "-c", 'model_provider="openai_chatgpt_plan"',
    "-c", 'model_providers.openai_chatgpt_plan.name="ChatGPT plan"',
    "-c", 'model_providers.openai_chatgpt_plan.base_url="https://api.openai.com/v1"',
    "-c", 'model_providers.openai_chatgpt_plan.env_key="OPENMAUSBOT_CHATGPT_TOKEN"',
    "-c", 'model_providers.openai_chatgpt_plan.wire_api="responses"',
    "-c", "model_providers.openai_chatgpt_plan.requires_openai_auth=false",
    "-c", "model_providers.openai_chatgpt_plan.supports_websockets=false",
    "-c", 'cli_auth_credentials_store="ephemeral"',
    "-c", "features.tool_search=false",
    "-c", "shell_environment_policy.ignore_default_excludes=false",
    // OPENMAUSBOT_CHATGPT_TOKEN is excluded on the thread, in the policy's
    // own representation (extendShellExclusions): a `-c exclude` here would
    // replace the lower layers' list and drop their filters.
  ];
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

/** Names of variable families mounts write, excluded by one pattern each:
 * gate and remote-proxy private records (a URL server's address and header
 * values live in the latter). */
const PRIVATE_ENV_FAMILIES = ["OMB_GATE_CONFIG_", "OMB_REMOTE_MCP_CONFIG_"];
/** The remote proxy's settings that are not secret (mcp-gate-config.ts). */
const PROXY_LITERAL_ENV = ["NODE_USE_ENV_PROXY", "NO_PROXY", "no_proxy"];
/** Variables a shell cannot work without: never excluded, whoever set them. */
const SHELL_ESSENTIALS = new Set(["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TERM", "LANG", "TZ"]);

const DENY_TIMEOUT_NOTE =
  "OpenMausBot: nobody answered this permission request in time. Skip this action and finish what you can without it.";

const renamedMcpServers = new Set<string>();
/** Logged once per name: the rename is deliberate, not a lost server. */
function noteRenamedMcpServer(name: string, mountName: string): void {
  if (renamedMcpServers.has(name)) return;
  renamedMcpServers.add(name);
  console.error(`codex: MCP server ${JSON.stringify(name)} is also declared in Codex's own config.toml — mounted as ${JSON.stringify(mountName)} for this bot so the two do not merge`);
}

/** A TOML inline table for a `-c key=value` override; JSON string quoting
 * is valid TOML basic-string quoting. */
function tomlInlineTable(entries: Record<string, string>): string {
  return `{ ${Object.entries(entries).map(([key, value]) => `${JSON.stringify(key)} = ${JSON.stringify(value)}`).join(", ")} }`;
}

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

/** What a guest-driven turn's app-server starts with: the shell, unified
 * exec and image reads off (codex-cli 0.159.0 `features`), web search too. */
export const GUEST_CONFINED_CODEX_ARGS = [
  "-c", "features.shell_tool=false", "-c", "features.unified_exec=false", "-c", "features.view_image=false", "-c", 'web_search="disabled"',
] as const;

/** Whether the effective config (config/read) shows the shell turned off. */
export function codexShellDisabled(config: unknown): boolean {
  const features = plainRecord(plainRecord(config)?.features);
  return features?.shell_tool === false && features?.unified_exec === false && features?.view_image === false;
}

/** Thread-config overrides that add `patterns` to the person's shell
 * exclusions, given the effective shell_environment_policy (config/read).
 * Codex keeps two representations: the legacy `exclude`/`include_only`
 * lists and the keyed `filters` table (pattern → "exclude" | "include").
 * A higher layer that writes one drops the other from the layers below
 * (codex-cli 0.160), so the person's rules are extended in the
 * representation they use. codex-cli 0.160 also reports every unset field
 * as null: null means absent. Anything else unexpected refuses the turn. */
function extendShellExclusions(policy: Record<string, unknown>, patterns: readonly string[]): Record<string, unknown> {
  const unconfirmed = () => new Error("Codex could not confirm its shell environment exclusions. No prompt was sent.");
  const exclude = policy.exclude ?? undefined;
  const filters = policy.filters ?? undefined;
  if (exclude !== undefined && (!Array.isArray(exclude) || exclude.some(name => typeof name !== "string"))) throw unconfirmed();
  if (filters === undefined) {
    return { "shell_environment_policy.exclude": [...new Set([...(exclude ?? []) as string[], ...patterns])] };
  }
  const table = plainRecord(filters);
  if (!table || Object.values(table).some(action => action !== "exclude" && action !== "include")) throw unconfirmed();
  // One Codex layer cannot mix the two; writing filters would drop the lists.
  if (exclude !== undefined || (policy.include_only ?? undefined) !== undefined) throw unconfirmed();
  // Patterns match, merge across layers, and must be unique ignoring case.
  const ours = new Set(patterns.map(pattern => pattern.toLowerCase()));
  return { "shell_environment_policy.filters": Object.fromEntries([
    ...Object.entries(table).filter(([pattern]) => !ours.has(pattern.toLowerCase())),
    ...patterns.map(pattern => [pattern, "exclude"]),
  ]) };
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

/** Keep the turn on the complete sandbox resolved by native start/resume. */
function withResolvedSandbox(params: CodexApprovalParams, session: unknown): CodexApprovalParams {
  const requested = plainRecord(params.turn.sandboxPolicy);
  // Named permission profiles own their policy; do not mix both selectors.
  if (!requested) return params;
  const sandbox = plainRecord(plainRecord(session)?.sandbox);
  if (!sandbox || typeof sandbox.type !== "string") {
    throw new Error("Codex did not return its resolved sandbox policy. Update Codex, then retry; the turn was not started because its permissions could not be verified.");
  }
  if (sandbox.type !== requested.type) {
    throw new Error("Codex did not apply the requested sandbox mode; cannot safely start the turn.");
  }
  return { ...params, turn: { ...params.turn, sandboxPolicy: sandbox } };
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

/** Every mount is a command Codex starts: URL servers arrive here already
 * behind OpenMausBot's remote proxy (see scopedServer in sendTurn). */
function mountMcpServer(
  appServerArgs: string[],
  env: Record<string, string | undefined>,
  name: string,
  server: StdioMcpSpec,
  preApproved = true,
  /** Settings that are not secret, written into the mount's own `env`
   * table: its process gets them, the shell Codex runs commands in does not. */
  literalEnv: Record<string, string> = {},
  /** Collects every variable name this mount writes into `env`. */
  written: Set<string> = new Set(),
): void {
  const prefix = `mcp_servers.${name}`;
  Object.assign(env, server.env);
  for (const name of Object.keys(server.env)) written.add(name);
  appServerArgs.push(
    "-c", `${prefix}.command=${JSON.stringify(server.command)}`,
    "-c", `${prefix}.args=${JSON.stringify(server.args)}`,
    // Values stay in the child environment; argv contains names only so
    // credentials never appear in process listings or diagnostics.
    "-c", `${prefix}.env_vars=${JSON.stringify(Object.keys(server.env))}`,
  );
  if (Object.keys(literalEnv).length) appServerArgs.push("-c", `${prefix}.env=${tomlInlineTable(literalEnv)}`);
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
    const plan = config.authMode === "chatgpt-plan";
    const planUnavailable = plan && (hostedWorkspaceConfigured() || cloudHomeConfigured())
      ? "ChatGPT plan sign-in for hosted Pro requires OpenAI's hosted-app approval. Use a Company model or API key until that integration is approved; the local desktop flow cannot be used here."
      : undefined;
    // Provider homes are excluded from portable backups and Move to Cloud.
    const planDirectory = join(DATA_DIR, "providers", "chatgpt-plan", createHash("sha256").update(instanceId).digest("hex"));
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
      delete env.OPENMAUSBOT_CHATGPT_TOKEN;
      if (plan) env.CODEX_HOME = join(planDirectory, "codex");
      return env;
    };
    const catalogEnv = childEnv();
    const planAuth = plan ? new ChatGptPlanAuthController({ directory: planDirectory }) : null;
    let planGeneration = 0;
    let planSigningOut = false;
    let disposed = false;
    let planWarning: string | undefined;
    let models = plan ? { default: "", options: [] } : config.managed ? { default: config.managed.models[0], options: config.managed.models.map(id => ({ id, label: id })) } : STATIC_CODEX_MODELS;
    const refreshModels = async (preserveExisting = false) => {
      if (config.managed) return;
      if (planAuth) {
        const generation = planGeneration;
        const kept = preserveExisting && models.options.length > 0 ? models : null;
        if (!kept) models = { default: "", options: [] };
        try {
          if (!planUnavailable && !planSigningOut && !disposed) {
            const catalog = await planAuth.models();
            if (generation === planGeneration && !planSigningOut && !disposed && (!kept || catalog.options.length)) models = catalog;
          }
        } catch (error) {
          // A deferred refresh keeps the list already being served. An
          // explicit refresh still clears first and reports the error.
          if (!kept) throw error;
        }
      } else {
        try {
          const resolved = await readCodexModelCatalog(catalogEnv, fetch, config.cli);
          if (resolved.options.length) models = resolved;
        } catch {
          // Keep the last usable catalog when a local provider is down.
        }
      }
      try { writeStartupModelCache(instanceId, models); } catch { /* derived cache */ }
    };
    // A revoked grant or a temporary catalog outage must leave the account
    // reachable in Settings for reconnect; it must not become a shadow.
    // A later start serves the saved list and refreshes behind listen.
    let startupModelRefresh: Promise<void> | null = null;
    if (config.managed) {
      await refreshModels();
    } else {
      startupModelRefresh = (await openStartupModelCatalog({
        instanceId,
        use: (catalog) => { models = catalog; },
        current: () => models,
        refresh: async () => {
          if (planAuth) {
            try { await refreshModels(laterStartup()); } catch { /* Explicit refresh reports the error. */ }
          } else await refreshModels();
        },
      }))?.pending ?? null;
    }
    // Codex's own ChatGPT login (not ChatGPT plan, whose tokens OpenMausBot
    // holds, nor Company routing) can be refused by OpenAI while `codex login
    // status` still reports it. A refusal marks it the way a rejected API key
    // is marked (key-rejections.ts): its credential home, plus the stored
    // auth file, so a sign-in made anywhere else starts over. A later turn
    // that succeeds, a new sign-in and sign-out clear it. Only a stored
    // ChatGPT login is marked: an API-key login (`codex login --with-api-key`)
    // cannot be fixed by the ChatGPT sign-in Settings offers.
    const ownLogin = !plan && !config.managed;
    const loginMark = (): [string, string] | null => {
      const home = ownLogin ? codexHome(childEnv()) : null;
      if (!home) return null;
      let stored = "";
      try { stored = readFileSync(join(home, "auth.json"), "utf8"); } catch { return null; /* keyring, or none */ }
      try {
        const auth = JSON.parse(stored) as { auth_mode?: unknown; tokens?: unknown };
        const chatgpt = typeof auth.auth_mode === "string" ? /chatgpt/i.test(auth.auth_mode) : Boolean(auth.tokens);
        if (!chatgpt) return null;
      } catch { return null; }
      return [`codex-login:${home}`, stored];
    };
    const loginRefused = () => { const mark = loginMark(); if (mark) noteKeyRejected(...mark); };
    const loginAccepted = (mark = loginMark()) => { if (mark) noteKeyAccepted(...mark); };
    const loginRejected = () => { const mark = loginMark(); return mark !== null && keyRejected(...mark); };
    const authentication = new CodexDeviceAuthController({
      cli: config.cli,
      environment: childEnv,
      signInRejected: loginRejected,
      onAuthenticated: async () => { loginAccepted(); await refreshModels(); },
    });
    const listeners = new Set<RuntimeEventListener>();
    interface Turn {
      stop: () => Promise<boolean>;
      /** Fold new user input into the running native turn (turn/steer).
       * "refused" when this attempt has nothing steerable; the caller
       * queues. "indeterminate" when delivery happened but the answer did
       * not come back — the caller must not re-queue those words. */
      steer?: (text: string) => Promise<SteerOutcome>;
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
      if (startupModelRefresh) await startupModelRefresh;
      turn = { ...turn, toolScope: assertToolScopeSupported(DRIVER_KIND, turn.toolScope) };
      const generation = planGeneration;
      const assertPlanCurrent = () => {
        if (disposed) throw new Error("This provider was removed. Select a connected account and send again.");
        if (planAuth && (planSigningOut || generation !== planGeneration)) throw new Error("The ChatGPT account changed while this message was preparing. Select a connected account and send again.");
      };
      assertPlanCurrent();
      if (planUnavailable) throw new Error(planUnavailable);
      const planToken = planAuth ? await planAuth.accessToken() : undefined;
      assertPlanCurrent();
      if (planAuth) {
        if (!turn.model || !models.options.some(model => model.id === turn.model)) {
          await refreshModels();
          assertPlanCurrent();
          if (!turn.model || !models.options.some(model => model.id === turn.model)) throw new Error("This model is not available to the selected ChatGPT plan. Refresh models and choose a listed model; API billing will not be used.");
        }
        mkdirSync(join(planDirectory, "codex"), { recursive: true, mode: 0o700 });
      }
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
        if ("url" in server) continue;
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

      // Only a turn on the official provider says anything about Codex's
      // ChatGPT login: a custom provider's 401 is its own key's, and its
      // success proves nothing about ChatGPT. No model means the catalog's
      // default, which is provider-qualified when config.toml picks another.
      const chatgptTurn = ownLogin &&
        decodeCodexSelection(turn.model || models.default).modelProvider === OFFICIAL_CODEX_PROVIDER;
      const launchAttempt = async (attempt: number): Promise<void> => {
        const env = childEnv();
        if (planToken) env.OPENMAUSBOT_CHATGPT_TOKEN = planToken;
        const appServerArgs = ["app-server", ...(plan ? chatgptPlanCodexArgs() : config.managed ? managedCodexArgs(config.managed) : codexLocalProviderArgs(env, turn.model)), ...codexToolSurfaceArgs(),
          // Native snapshots can restore inherited variables after the shell
          // policy has filtered them. Scoped MCP gate settings must stay private.
          ...(turn.toolScope === undefined ? [] : ["-c", "features.shell_snapshot=false"]),
          // A guest-driven turn (SendTurnInput.guestConfined): no shell and
          // no file reads, whatever the person's own config says (-c wins
          // over config files). The turn also starts with no environment.
          ...(turn.guestConfined ? GUEST_CONFINED_CODEX_ARGS : [])];
        // What the environment holds before any MCP mount writes to it, and
        // every name the mounts write.
        const baseEnv = new Map(Object.entries(env).filter(([, value]) => value !== undefined));
        const mountedNames = new Set<string>();
        const selectedMcp = new Map<string, StdioMcpSpec>();
        const selectedApprovals = new Map<string, boolean>();
        /** Mounts whose big catalog is searched (plan turns' URL servers). */
        const directoryMounts = new Set<string>();
        /** Each mount's settings that are not secret (mountMcpServer's literalEnv). */
        const literalEnvs = new Map<string, Record<string, string>>();
        const scopedServer = (name: string, mountName: string, server: McpServerSpec): StdioMcpSpec | null => {
          if (!canUseMcpServer(turn.toolScope, name)) return null;
          // Every URL server is reached through OpenMausBot's remote proxy,
          // on every Codex login, never by Codex's own MCP client: the proxy
          // opens the connection with the same minimal handshake as Settings
          // → Test (mcp-http.ts). Codex's own client adds capability fields
          // (codex-cli 0.160.1 sends elicitation.form/url; rmcp 3.2's form
          // capability can carry schemaValidation) that a strict server
          // refuses: a Voluum server answered "Unrecognized field
          // 'schemaValidation'", Codex started the thread without its tools,
          // and every call came back "Tool not found" while Settings → Test
          // listed 100+ tools. The proxy also speaks SSE, which Codex does not.
          // A plan turn has no tool_search (chatgptPlanCodexArgs): its URL
          // servers are also searched through the proxy's tool directory.
          // Own-login and Company turns keep Codex's hosted tool_search, so
          // their catalog passes through whole.
          const directory = plan && "url" in server;
          if (turn.toolScope === undefined && !("url" in server)) return server;
          const hash = createHash("sha256").update(mountName).digest("hex");
          // A proxy's network settings come from the environment Codex runs
          // with: Codex itself starts MCP children with only a few names.
          const proxy = turn.toolScope === undefined
            ? mcpStdioServer(server, { nodeEnv: { ELECTRON_RUN_AS_NODE: "1" }, ...(directory ? { directory: { name } } : {}), configEnvName: `OMB_REMOTE_MCP_CONFIG_${hash}`, sourceEnv: env })
            : gateServer({ name, server, threadId, budget: 0, toolScope: turn.toolScope, nodeEnv: { ELECTRON_RUN_AS_NODE: "1" },
              configEnvName: `OMB_GATE_CONFIG_${hash}`, directory, sourceEnv: env });
          if (proxy && directory) directoryMounts.add(mountName);
          if (!proxy) return null;
          // The proxy's own network switches go in its env table, so the
          // shell keeps the person's NO_PROXY and never gets the switch. A
          // gate already carries them inside its private record.
          const shared = { ...proxy.env };
          if (turn.toolScope === undefined) {
            const literal = Object.fromEntries(Object.entries(shared).filter(([key]) => PROXY_LITERAL_ENV.includes(key)));
            for (const key of PROXY_LITERAL_ENV) delete shared[key];
            if (Object.keys(literal).length) literalEnvs.set(mountName, literal);
          }
          return { command: proxy.command, args: proxy.args ?? [], env: shared };
        };
        const mountSelected = (name: string, mountName: string, server: McpServerSpec, preApproved = true) => {
          const selected = scopedServer(name, mountName, server);
          if (selected) {
            selectedMcp.set(mountName, selected);
            selectedApprovals.set(mountName, preApproved);
            mountMcpServer(appServerArgs, env, mountName, selected, preApproved, literalEnvs.get(mountName), mountedNames);
            if (turn.toolScope !== undefined && !preApproved) appServerArgs.push("-c", `mcp_servers.${mountName}.default_tools_approval_mode="prompt"`);
          }
        };
        if (turn.integrations?.composio) {
          mountSelected("composio", "openmausbot_connectors", turn.integrations.composio);
        }
        if (turn.integrations?.agents) {
          mountSelected("agents", "agents", turn.integrations.agents);
        }
        if (turn.integrations?.localComputer) {
          // The host daemon and isolated Local VM both arrive as a direct Cua
          // Driver stdio MCP server. Codex sees the same computer tool surface.
          mountSelected("computer", "computer", turn.integrations.localComputer);
        }
        if (turn.integrations?.browser) {
          mountSelected("browser", "browser", turn.integrations.browser);
        }
        if (turn.integrations?.data) {
          mountSelected("data", "data", turn.integrations.data);
        }
        // A custom server named like one in the user's own config.toml would
        // be merged with it by the `-c` override — a stdio command over a
        // remote url is "invalid configuration" and kills the turn before the
        // model is asked. Such a server mounts under a name of its own.
        const declaredInCodexConfig = codexConfigMcpServerNames(env);
        if (turn.toolScope !== undefined) {
          for (const name of declaredInCodexConfig) appServerArgs.push("-c", `mcp_servers.${name}.enabled=false`);
        }
        for (const [name, server] of Object.entries(turn.integrations?.custom ?? {})) {
          const mountName = mountedMcpServerName(name, declaredInCodexConfig);
          if (mountName !== name) noteRenamedMcpServer(name, mountName);
          mountSelected(name, mountName, server, false);
        }
        if (turn.integrations?.phone) {
          if (turn.toolScope !== undefined) {
            mountSelected("phone", "openmausbot_phone", turn.integrations.phone);
          } else {
          const bridge = turn.integrations.phone;
          Object.assign(env, bridge.env);
          for (const name of Object.keys(bridge.env)) mountedNames.add(name);
          const prefix = "mcp_servers.openmausbot_phone";
          appServerArgs.push(
            "-c", `${prefix}.command=${JSON.stringify(bridge.command)}`,
            "-c", `${prefix}.args=${JSON.stringify(bridge.args)}`,
            "-c", `${prefix}.env_vars=${JSON.stringify(Object.keys(bridge.env))}`,
            "-c", `${prefix}.default_tools_approval_mode="auto"`,
          );
          }
        }

        // Codex hands its MCP children their variables from the one
        // environment it also runs shell commands in. Every variable a mount
        // writes there (a command server's token, a harness mount's
        // capability, a gate's or remote proxy's private record, which holds
        // a URL server's header values) is excluded from that shell below,
        // and shell snapshots, which can restore what the policy removed,
        // are off.
        // Not excluded: a value the environment already held that a mount
        // passes along unchanged (the person's proxy settings), and the few
        // variables no shell works without. ELECTRON_RUN_AS_NODE is never the
        // person's setting, so it is excluded wherever a mount sets it.
        const mountedEnv = [...mountedNames].filter((name) => env[name] !== undefined && !SHELL_ESSENTIALS.has(name) && !name.startsWith("LC_")
          && (name === "ELECTRON_RUN_AS_NODE" || baseEnv.get(name) !== env[name]));
        const privateEnv = [...new Set([
          ...(turn.toolScope !== undefined ? ["OMB_GATE_CONFIG_*"] : []),
          ...PRIVATE_ENV_FAMILIES.filter((family) => mountedEnv.some((name) => name.startsWith(family))).map((family) => `${family}*`),
          ...mountedEnv.filter((name) => !PRIVATE_ENV_FAMILIES.some((family) => name.startsWith(family))).sort(),
        ])];
        // Records this turn writes for a tool selection or a searched server
        // never run without proof that snapshots are off. The rest was there
        // before that guarantee, so a Codex that cannot say keeps working,
        // only with the exclusions.
        const provenPrivateEnv = turn.toolScope !== undefined || directoryMounts.size > 0;
        if (privateEnv.length && turn.toolScope === undefined) appServerArgs.push("-c", "features.shell_snapshot=false");

        const selectionConfig: { config?: Record<string, unknown> } = turn.toolScope === undefined ? {} : { config: { mcp_servers: Object.fromEntries(
          [...selectedMcp].map(([name, server]) => [name, {
            command: server.command, args: server.args, env_vars: Object.keys(server.env), env: {}, default_tools_approval_mode: selectedApprovals.get(name) ? "auto" : "prompt",
          }]),
        ) } };

        const commandCwd = permissionLaunchCwd(turn.cwd ?? homedir());
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
        // whether lastError went out marked setup (a sign-in to fix)
        lastErrorSetup: false,
        // an error Codex said it would retry itself (willRetry), kept only
        // to explain a turn that then fails without words of its own
        retryError: "",
        // Codex started recovering its model provider's sign-in this turn
        authRecovery: false,
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
      // Stop asks the app-server to end the turn itself before any process
      // signal. Killing first surfaced routine stops as "codex exited null
      // (signal SIGTERM) before turn/completed"; the protocol interrupt keeps
      // the session the authority, and the kill below is only escalation for
      // a server that will not answer. settle() runs with state.settled
      // already true, so ordinary completion still tears down immediately.
      let interruptRequested = false;
      const stop = async () => {
        stopRequested = true;
        stopSignal.abort();
        if (!state.settled && !interruptRequested && codexThreadId && codexTurnId &&
            child.exitCode === null && child.signalCode === null) {
          interruptRequested = true;
          const graceMs = Math.max(1, Number(process.env.FAKE_CODEX_INTERRUPT_GRACE_MS ?? 750) || 750);
          try {
            await request("turn/interrupt", { threadId: codexThreadId, turnId: codexTurnId }, graceMs);
          } catch {
            // Old CLI without the method, or a wedged server: escalate below.
          }
          const deadline = Date.now() + graceMs;
          while (!state.settled && Date.now() < deadline) {
            await new Promise((wake) => setTimeout(wake, 15));
          }
          // Protocol completion is not process termination. In particular,
          // sign-out must wait until the child holding its token has exited.
        }
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

      // Live steering folds new input into the running turn without ending
      // it. expectedTurnId is the protocol's precondition: a turn that moved
      // on (or a CLI without turn/steer) answers with an explicit RPC error,
      // which becomes "refused" here so the caller queues for the next turn —
      // the child is never killed to steer. A timeout after delivery, a dead
      // transport, or a turn that settles while the answer is in flight is
      // "indeterminate": the words may already be running, so the caller must
      // not re-queue them.
      const steerActiveTurn = async (text: string): Promise<SteerOutcome> => {
        if (state.settled || abandoned || stopRequested || !codexThreadId || !codexTurnId) return "refused";
        if (child.exitCode !== null || child.signalCode !== null) return "refused";
        try {
          const steerTimeoutMs = Math.max(1, Number(process.env.FAKE_CODEX_STEER_TIMEOUT_MS ?? 10_000) || 10_000);
          await request("turn/steer", {
            threadId: codexThreadId,
            input: [{ type: "text", text }],
            expectedTurnId: codexTurnId,
          }, steerTimeoutMs);
          return "steered";
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (state.settled || message.includes("timed out")) return "indeterminate";
          return "refused";
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
        // The whole set rides one card, answered per id: the protocol pairs
        // each question with its own id, and the card's single reply is
        // mapped back block by block (or as the flat single-question
        // fallback). The only refusal left is an ask with nothing answerable
        // — #1237 is closed: a bundle no longer copies one answer into
        // every id.
        const protocolQuestions = isQuestion ? parseProtocolAskQuestions(params.questions) : null;
        if (isQuestion && !protocolQuestions) {
          send({
            jsonrpc: "2.0",
            id: msg.id,
            error: {
              code: -32602,
              message: Array.isArray(params.questions)
                ? "ask needs at least one answerable question — a string id and question text each; this request sent none."
                : "ask needs params.questions to be an array of questions, each with a string id and question text.",
            },
          });
          return;
        }
        // Codex asks 'Allow the <server> MCP server to run tool "<tool>"?'.
        // The tool is everything from the first quote to the closing `"?`,
        // so a tool named `web_search" …` cannot pass for web_search.
        const mcpMessage = typeof params.message === "string" ? params.message : "";
        const mcpTool = isLegacyMcpPermission ? / to run tool "(.*)"\?$/.exec(mcpMessage)?.[1] : undefined;
        // A searched server (mcp-directory.ts): its catalog reads run no
        // tool and pass without a card, as the tools/list they replace did,
        // but only when Codex asks about exactly them; call_tool is shown as
        // the tool it runs.
        const searchedServer = isLegacyMcpPermission && typeof params.serverName === "string" && directoryMounts.has(params.serverName);
        const asksAbout = (tool: string) => mcpMessage === `Allow the ${params.serverName} MCP server to run tool "${tool}"?`;
        if (searchedServer && (asksAbout(SEARCH_TOOL) || asksAbout(DESCRIBE_TOOL))) {
          send({ jsonrpc: "2.0", id: msg.id, result: { action: "accept", content: {} } });
          return;
        }
        const runs = searchedServer && asksAbout(CALL_TOOL) ? directoryCallTarget(CALL_TOOL, params._meta?.tool_params) : undefined;
        const tool =
          mcpAppApproval
            ? mcpAppApproval.tool
            : isLegacyMcpPermission
            ? (runs ?? mcpTool ?? "mcp")
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
            ? (mcpAppApproval?.summary ?? (runs ? `Allow the ${params.serverName} MCP server to run tool ${JSON.stringify(runs)}?`
              : typeof params.message === "string" ? params.message : "MCP access requested"))
            : typeof params.command === "string"
            ? params.command
            : protocolQuestions
              ? protocolQuestions.map(({ question }) => question.question).join(" · ")
            : Array.isArray(params.questions)
              ? params.questions.map((q: any) => q.question ?? q.header).filter(Boolean).join(" · ")
              : typeof params.reason === "string"
                ? params.reason
                : tool;
        // Flat choices only when one non-multiselect question can actually
        // be answered by a bare reply; a bundle's first-question buttons
        // would be an unusable lie for flat clients.
        const choices =
          isQuestion && protocolQuestions ? questionChoices(protocolQuestions.map(({ question }) => question)) : undefined;
        const finish = (behavior: "allow" | "deny" | "answer", message?: string, source: "user" | "timeout" | "system" = "user") => {
          if (!asks.delete(requestId)) return;
          clearTimeout(timer);
          if (isQuestion) {
            // Only the person's reply is filed: Q:/A: blocks mapped to the
            // id that asked them, or the flat fallback for a single
            // question. Timeout and turn teardown send empty answers so
            // every id reads unanswered — system notes never occupy the
            // slot the model reads as the person's words (the rule
            // permission-proxy already follows).
            const mapped =
              behavior === "answer" && source === "user" && typeof message === "string"
                ? questionAnswersById(message, protocolQuestions ?? [])
                : {};
            // Null prototype so an opaque id like __proto__ becomes a real
            // answer key instead of hitting the inherited setter.
            const answers: Record<string, { answers: string[] }> = Object.create(null);
            for (const [id, answer] of Object.entries(mapped)) answers[id] = { answers: [answer] };
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
          // A timed-out question resolves as denied, not answered: the card
          // closes with no reply (answers stay empty either way), and the
          // resolve event must not claim an answer that never happened.
          () => finish("deny", isQuestion ? undefined : DENY_TIMEOUT_NOTE, "timeout"),
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
          command: method === "execCommandApproval" || method === "item/commandExecution/requestApproval"
            ? permissionCommand(params.command, params.cwd ?? (
              // Helpers may have a different workspace from their parent.
              !params.threadId || params.threadId === codexThreadId ? commandCwd : undefined
            )) : undefined,
          choices,
          ...(protocolQuestions ? { questions: protocolQuestions.map((pair) => pair.question) } : {}),
          approvalScope: controlsHost ? "local-computer" : undefined,
          requiresExplicitApproval: isAdditionalPermission || (
            (method === "execCommandApproval" || method === "item/commandExecution/requestApproval") &&
            (params.additionalPermissions != null || params.networkApprovalContext != null)
          ) || undefined,
        });
      };

      const seenReviews = new Set<string>();
      let reviewWarning = false;
      let timedOutReview = false;
      const retryMode = approvalMode[0].toUpperCase() + approvalMode.slice(1);
      const reviewNotice = (status: "warning" | "timedOut" | "denied", action?: any) => {
        if (status === "warning") {
          emit({ ...base(threadId, turnId), type: "runtime.error",
            message: `Codex automatic review reported a timeout. Check what ran before retrying. Retry stays ${retryMode}. Select Ask for human approval in approval settings.`,
          });
          return;
        }
        const command = action?.type === "command" ? commandSummary({ command: action.command }) : undefined;
        const target = command ? `: "${command.slice(0, 30)}"` : " for the requested action";
        const outcome = status === "timedOut" ? "timed out" : "denied";
        emit({ ...base(threadId, turnId), type: "runtime.error",
          message: `Codex automatic review ${outcome}${target}. Action did not run. Retry stays ${retryMode}. Select Ask for human approval in approval settings.`,
        });
      };
      // The turn's failure, said once. An error notification and the
      // turn/completed after it usually carry the same words; the second
      // only speaks again to deliver a sign-in flag the first lacked.
      // Codex's own refused sign-in reads as one plain sentence and marks
      // the login, so Settings asks for a new sign-in too.
      const turnError = (error: { message?: unknown; codexErrorInfo?: unknown }) => {
        const raw = String(error.message);
        const refused = chatgptTurn && loginMark() !== null && (codexSignInRefused(error) ||
          (state.authRecovery && !/\b403\b|forbidden/i.test(raw) && /\b401\b|unauthorized/i.test(raw)));
        if (refused) loginRefused();
        const message = refused ? codexSignInExpired(raw) : codexUserError(raw, plan);
        const setup = refused || classifyError({ text: message }).reason === "auth";
        if (message === state.lastError && (state.lastErrorSetup || !setup)) return;
        state.lastError = message;
        state.lastErrorSetup ||= setup;
        emit({ ...base(threadId, turnId), type: "runtime.error", message, ...(setup ? { setup: true } : {}) });
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
          // guardianWarning is thread-scoped in Codex 0.147; this child
          // process belongs to one app turn. Never admit a mismatched turnId.
          if (eventTurnId !== codexTurnId && !(msg.method === "guardianWarning" && eventTurnId === undefined)) return;
        }
        switch (msg.method) {
          case "guardianWarning":
            if (typeof p.message === "string" && /automatic approval review.*timed out/i.test(p.message)) reviewWarning = true;
            break;
          case "item/autoApprovalReview/completed": {
            const status = p.review?.status;
            if (status !== "timedOut" && status !== "denied") break;
            // Completed reviews carry a reviewId. Without it distinct
            // failures cannot be separated from duplicate notifications.
            if (typeof p.reviewId !== "string" || !p.reviewId) break;
            if (!seenReviews.has(p.reviewId)) {
              seenReviews.add(p.reviewId);
              if (status === "timedOut") timedOutReview = true;
              reviewNotice(status, p.action);
            }
            break;
          }
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
            // call_tool on a searched server reads as the tool it runs.
            const runs = item.type === "mcpToolCall" && item.tool === CALL_TOOL && typeof item.server === "string" && directoryMounts.has(item.server)
              ? directoryCallTarget(CALL_TOOL, item.arguments) : undefined;
            const title =
              item.type === "commandExecution"
                ? String(item.command ?? "shell")
                : item.type === "fileChange"
                  ? "edit"
                  : item.type === "mcpToolCall"
                    ? (runs ?? item.tool ?? item.name ?? "mcp")
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
                input: toolDetailPreview(item.type === "commandExecution" ? { command: item.command, cwd: item.cwd } : item.type === "mcpToolCall" ? (runs ? item.arguments?.arguments ?? {} : item.arguments) : item.type === "fileChange" ? item.changes : item.query),
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
              if (item.type === "mcpToolCall") {
                for (const img of extractMcpImages(item.result)) {
                  emit({ ...base(threadId, turnId), type: "item.completed", itemType: "assistant_image", data: img.data });
                }
              }
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
            if (reviewWarning && !timedOutReview) reviewNotice("warning");
            const t = p.turn ?? {};
            if (t.status === "completed") {
              if (chatgptTurn) loginAccepted();
            } else if (typeof t.error?.message === "string") {
              turnError(t.error);
            } else if (t.status === "failed" && !state.lastError && state.retryError) {
              // Codex gave up retrying without a final word: its last one
              turnError({ message: state.retryError });
            }
            void settle(t.status === "completed", t.status === "completed" ? null :
              (classifyError({ text: state.lastError }).reason === "provider_safety" ? "provider_safety" : (state.lastError || t.status || "failed")));
            break;
          }
          case "error": {
            // shape drift: 0.144 sends {message}, 0.139 and 0.160 nest it
            // under {error:{message, codexErrorInfo}} — surface either
            // (agentcal armor)
            const error = p.error && typeof p.error === "object" ? p.error : { message: p.message };
            if (!error.message) break;
            // 0.160 reports each of its own reconnects ("Reconnecting...
            // 1/5") with willRetry: true. Those are not the turn's failure;
            // the final error, or turn/completed, says how it ended.
            if (p.willRetry === true) {
              state.retryError = String(error.message);
              break;
            }
            turnError(error);
            break;
          }
          case "modelProvider/authRecoveryStarted":
            state.authRecovery = true;
            break;
          case "modelProvider/authRecoveryCompleted":
            state.authRecovery = false;
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
        emit({ ...base(threadId, turnId), type: "runtime.error", ...describeSpawnFailure(e, config.cli, turn.cwd ?? homedir()) });
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
        // An intentional stop killed (or outlived) the child before the
        // turn acknowledged its own end. That is the stop doing its job, not
        // a crash: settle quietly so Stop never reports the raw signal.
        if (stopRequested) {
          void settle(false, "interrupted");
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

      active.set(threadId, { stop, turnId, asks, steer: steerActiveTurn });
      // Relaunching the app-server is still the same logical turn. Keep the
      // active process current on every attempt, but announce the turn once.
      if (attempt === 0) emit({ ...base(threadId, turnId), type: "turn.started" });

      // handshake + kickoff; a transient failure (5xx/overloaded/reset) gets
      // one relaunch of the whole app-server after backoff — but only when
      // nothing streamed yet, and never for auth/shape errors or interrupts
      try {
        await request("initialize", {
          clientInfo: { name: "openmausbot", title: "OpenMausBot", version: serverVersion() },
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
        } catch (error) {
          // Do not expose a possibly secret-bearing native config error or
          // overwrite unknown instructions with an empty fallback. A config
          // codex itself rejected is the one case worth naming: the person
          // can act on it, and the message carries no credential.
          const invalid = error instanceof CodexRpcError && /^invalid configuration\b/i.test(error.message);
          throw new Error(
            invalid
              ? "Codex rejected its configuration as invalid. Check ~/.codex/config.toml (or CODEX_HOME) for a broken entry, then retry."
              : "Could not read Codex configuration; cannot safely update bot instructions. Retry after checking Codex.",
          );
        }
        if (privateEnv.length) {
          const snapshot = (effectiveConfig as { features?: { shell_snapshot?: unknown } } | null)?.features?.shell_snapshot;
          if (provenPrivateEnv ? snapshot !== false : snapshot === true) {
            throw new Error("Codex could not disable inherited shell snapshots. No prompt was sent.");
          }
        }
        if (privateEnv.length || plan) {
          // Extend the effective policy, never replace it, for both new and
          // resumed threads, so local, Company and ChatGPT turns keep the
          // person's own exclusions, and a plan turn adds its token's to
          // them on every turn, mounts or none.
          const rawPolicy = (effectiveConfig as { shell_environment_policy?: unknown } | null)?.shell_environment_policy;
          if (rawPolicy !== undefined && (!rawPolicy || typeof rawPolicy !== "object" || Array.isArray(rawPolicy))) {
            throw new Error("Codex could not confirm its shell environment policy. No prompt was sent.");
          }
          selectionConfig.config = { ...selectionConfig.config,
            ...extendShellExclusions((rawPolicy ?? {}) as Record<string, unknown>, [...(plan ? ["OPENMAUSBOT_CHATGPT_TOKEN"] : []), ...privateEnv]) };
        }
        if (turn.toolScope !== undefined) {
          const catalog = (effectiveConfig as { mcp_servers?: unknown } | null)?.mcp_servers;
          if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) throw new Error("Codex could not confirm its selected MCP configuration. No prompt was sent.");
          for (const [name, entry] of Object.entries(catalog)) {
            if (entry && typeof entry === "object" && (entry as { enabled?: unknown }).enabled === false) continue;
            const expected = selectedMcp.get(name);
            const actual = entry as { command?: unknown; args?: unknown; env_vars?: unknown; env?: unknown; default_tools_approval_mode?: unknown; tools?: unknown } | null;
            if (!expected || actual?.command !== expected.command
              || JSON.stringify(actual?.args ?? []) !== JSON.stringify(expected.args ?? [])
              || !Array.isArray(actual?.env_vars) || JSON.stringify([...actual.env_vars].sort()) !== JSON.stringify(Object.keys(expected.env).sort())
              || actual.default_tools_approval_mode !== (selectedApprovals.get(name) ? "auto" : "prompt")
              || (actual.env != null && (typeof actual.env !== "object" || Array.isArray(actual.env) || Object.keys(actual.env).length > 0))
              || (actual.tools != null && (typeof actual.tools !== "object" || Array.isArray(actual.tools) || Object.keys(actual.tools).length > 0))) {
              throw new Error("Codex has an MCP server outside the selected configuration. Disable native MCP entries for this account before using tool selection. No prompt was sent.");
            }
          }
        }
        // Proven before the turn starts: a Codex that did not take the
        // overrides runs nothing for a guest.
        if (turn.guestConfined && !codexShellDisabled(effectiveConfig)) {
          throw new Error(`This Codex could not turn its shell off, so it can't run this turn. Update Codex, or switch this bot to Claude.${turn.confinedWhy ? ` ${turn.confinedWhy}` : ""}`);
        }
        // Only the stable half of the prompt belongs in the developer slot:
        // it is the part that must survive compaction unchanged, and any
        // change to it invalidates the provider's cached prefix. The volatile
        // half (the sections in VOLATILE_SECTIONS, system-prompt.ts) is
        // delivered inside the turn that changed it, after the cached
        // prefix, the same contract SendTurnInput.systemStable documents.
        // Without the split the driver keeps the previous single-block
        // behaviour.
        const stableInstructions = typeof turn.systemStable === "string" && typeof turn.systemVolatile === "string"
          ? turn.systemStable
          : null;
        const promptSplit = stableInstructions !== null;
        const developerInstructions = codexDeveloperInstructions(
          effectiveConfig,
          stableInstructions ?? turn.system ?? "",
        );
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
        const selection = config.managed
          ? { model: turn.model, modelProvider: "openmaus_company" }
          : config.authMode === "chatgpt-plan"
            ? { model: turn.model, modelProvider: "openai_chatgpt_plan" }
            : decodeCodexSelection(turn.model);
        const cursor = typeof turn.resumeCursor === "string" ? turn.resumeCursor : null;
        let startedModel: string | null = null;
        let resumedNativeThread = false;
        let rebuiltFromReplay = false;
        let promptText = turn.text;
        if (cursor) {
          const resumeThread = () => request("thread/resume", {
            ...selectionConfig,
            threadId: cursor,
            developerInstructions,
            model: selection.model,
            ...(selection.modelProvider ? { modelProvider: selection.modelProvider } : {}),
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
            approvalParams = withResolvedSandbox(approvalParams, resumed);
            codexThreadId = resumed?.thread?.id ?? cursor;
            resumedNativeThread = true;
          } catch (error) {
            const failure = classifyResumeFailure({
              attempted: true,
              rejected: error instanceof CodexRpcError,
              promptSubmitted,
              producedOutput: state.sawStreamDelta,
            });
            if (recoveredMissingSession || stopRequested || state.settled ||
                !turn.recoveryText?.trim() || !missingNativeCodexThread(error, cursor) || !mayReplay(failure)) throw error;
            // The prompt has never been submitted and Codex no longer has the
            // thread: without a rebuild every later turn resumes the same
            // missing rollout and fails the same way. Rebuild it from the
            // chat, Company or personal, as Claude does for a refused resume;
            // once, through the same approved model/provider below. The
            // person is told (runtime.notice beside session.started).
            recoveredMissingSession = true;
            const rebuild = recoveryPromptFor({ recoveryText: turn.recoveryText, currentText: turn.text, failure });
            // Announced as rebuilt only when the replacement really carries the
            // replay; otherwise it holds no more than the turn text.
            rebuiltFromReplay = rebuild.replayed;
            promptText = rebuild.text;
          }
        }
        if (!codexThreadId) {
          const startThread = () => request("thread/start", {
              ...selectionConfig,
              developerInstructions,
              cwd: turn.cwd ?? homedir(),
              model: selection.model,
              ...(selection.modelProvider ? { modelProvider: selection.modelProvider } : {}),
              ...approvalParams.thread,
              ...(turn.guestConfined ? { environments: [] } : {}),
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
          approvalParams = withResolvedSandbox(approvalParams, started);
          codexThreadId = started?.thread?.id ?? null;
          startedModel = started?.model ?? null;
        }
        if (!codexThreadId) throw new Error("Codex did not return a native thread id");
        const { deliverVolatile, hadVolatile, commitVolatile } = await syncCodexInstructions(
          threadId,
          codexThreadId,
          developerInstructions,
          promptSplit ? turn.systemVolatile ?? "" : "",
          resumedNativeThread,
          request,
          Boolean(turn.mentionTurn),
        );
        // A changed volatile half rides the next user input as a labelled
        // context block. It never touches the developer slot, so an
        // ordinary memory write or roster change neither appends a second
        // copy of the prompt to history nor re-uploads the conversation.
        if (deliverVolatile) {
          promptText = withContextNote(
            volatileContextNote(promptSplit ? turn.systemVolatile ?? "" : "", hadVolatile),
            promptText,
          );
        }
        emit({ ...base(threadId, turnId), type: "session.started", sessionId: codexThreadId, model: startedModel ?? turn.model ?? null, ...(rebuiltFromReplay ? { rebuilt: true } : {}) });
        if (rebuiltFromReplay) emit({ ...base(threadId, turnId), type: "runtime.notice", message: rebuiltSessionNotice("Codex") });
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
            // No environment: no exec_command, apply_patch or view_image, and
            // any call to them is refused (probed against codex-cli 0.159.0).
            // Without the experimental API the field is rejected, not ignored.
            ...(turn.guestConfined ? { environments: [] } : {}),
            // Spread, not `effort: turn.effort ?? null`. Probed against
            // codex-cli 0.146.0: null is indistinguishable from an absent key
            // — both leave the thread's current effort alone, emitting no
            // thread/settings/updated, and thread/resume reads the old value
            // back. The app-server offers no way to clear a level either:
            // "" is rejected outright and thread/start takes no effort at
            // all. So a thread keeps the last level it was sent until it is
            // sent another; back on Default, the harness gives a thread that
            // holds a level a new thread instead of resuming it (server/index.ts).
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
        // turn/start accepted the input: only now may the receipt claim the
        // volatile half was delivered, so a rejected turn redelivers on retry.
        if (commitVolatile) commitVolatile();
      } catch (e) {
        const failure = e instanceof Error ? e : { text: String(e) };
        const raw = e instanceof Error ? e.message : String(e);
        const refused = chatgptTurn && loginMark() !== null && codexSignInRefused({ message: raw });
        const message = refused ? codexSignInExpired(raw) : codexUserError(raw, plan);
        const needsAuth = refused || /(?:\b401\b|unauthorized|missing bearer|authentication required)/i.test(message);
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
          if (refused) loginRefused();
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
    if (planUnavailable) return { state: "unavailable", authenticated: false, chatgptPlan: true, reason: planUnavailable, authenticationUnavailableReason: planUnavailable };
    const env = childEnv();
    const version = await new Promise<string | null>((resolve) => {
      execCli(config.cli, ["--version"], { timeout: 8000, env }, (err, stdout) =>
        resolve(err ? null : stdout.trim()),
      );
    });
    if (!version) return { state: "unavailable", reason: `\`${config.cli}\` CLI not found`, ...(plan ? { chatgptPlan: true } : {}) };
    if (planAuth) return { state: "available", version, chatgptPlan: true, billing: "subscription", ...await planAuth.snapshot(), update: await codexReleaseUpdate(version, config.cli),
      ...(planWarning ? { warning: { title: "Check ChatGPT connection", message: planWarning } } : {}) };
    if (config.managed) return { state: "available", version, authenticated: Boolean(input.environment.OPENMAUSBOT_COMPANY_API_KEY && input.environment.CODEX_HOME), billing: "metered" };
    const authenticated = await new Promise<boolean>((resolve) => {
      execCli(config.cli, ["login", "status"], { timeout: 8000, env }, (err, stdout, stderr) =>
        resolve(!err && /^logged in\b/im.test(`${stdout}\n${stderr ?? ""}`)),
      );
    });
    // Signed in as far as the CLI knows, but OpenAI refused it on a real turn.
    if (authenticated && loginRejected()) {
      return { state: "available", version, authenticated: false, reason: CODEX_SIGN_IN_EXPIRED,
        update: await codexReleaseUpdate(version, config.cli), billing: "subscription" };
    }
    // Display identity only, so Settings can say whose ChatGPT account the
    // bots run on; the status command above stays the authority on sign-in.
    const email = authenticated ? await codexAccountEmail(config.cli, env) : null;
    // childEnv drops OPENAI_API_KEY on purpose — turns run on the ChatGPT login
    return {
      state: "available",
      version,
      authenticated,
      ...(email ? { account: { email } } : {}),
      update: await codexReleaseUpdate(version, config.cli),
      billing: "subscription",
    };
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
    ...(startupModelRefresh ? { startupModelRefresh } : {}),
    ...(plan ? { authenticationMethod: "browser-pkce" as const } : {}),
    startAuthentication: async () => {
      if (planUnavailable) throw new Error(planUnavailable);
      if (planSigningOut || disposed) throw new Error("This account is being disconnected. Wait before signing in again.");
      return (planAuth ?? authentication).start();
    },
    getAuthentication: async (flowId) => {
      const result = await (planAuth ?? authentication).get(flowId);
      if (planAuth && result.phase === "succeeded") planWarning = undefined;
      if (planAuth && result.phase === "succeeded" && !models.options.length) await refreshModels();
      return result;
    },
    cancelAuthentication: () => (planAuth ?? authentication).cancel(),
    signOut: async () => {
      if (!planAuth) {
        const mark = loginMark();
        await authentication.signOut();
        loginAccepted(mark);
        return;
      }
      planSigningOut = true;
      planGeneration++;
      try {
        const stopped = await Promise.all([...active.values()].map(({ stop }) => stop()));
        if (stopped.some(value => !value)) throw new Error("A ChatGPT task could not stop safely. Stop the task before signing out.");
        models = { default: "", options: [] };
        await planAuth.signOut();
        planWarning = undefined;
      } catch (error) {
        if ((error as { code?: string }).code !== "chatgpt_revocation_unconfirmed") throw error;
        planWarning = (error as Error).message;
      } finally { planSigningOut = false; }
    },
    snapshot,
    adapter: {
      provider: DRIVER_KIND,
      capabilities: {
        sessionModelSwitch: "unsupported",
        // A guest's turn runs with no environment and the shell off (guestConfined).
        guestTurns: "confined",
        queueing: true,
        computerMcp: true,
        localComputerMcp: true,
        composioMcp: true,
        agentsMcp: true,
      customMcp: true,
        phoneMcp: true,
        browserMcp: true,
        dataMcp: true,
        images: true,
        nativeImageInput: true,
        effortLevels: ["low", "medium", "high", "xhigh", "max"],
        strictResume: true,
      },
      sendTurn,
      interruptTurn: async (threadId) => {
        await active.get(threadId)?.stop();
      },
      steer: async (threadId, text) => {
        const turn = active.get(threadId);
        return turn?.steer ? await turn.steer(text) : "refused";
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
      disposed = true;
      planGeneration++;
      await authentication.dispose();
      await planAuth?.dispose();
      await Promise.all([...active.values()].map(({ stop }) => stop()));
      listeners.clear();
    },
  };
},
};
