import { codexToolSurfaceArgs } from "./codex-tool-surface.ts";
import { codexShellDisabled, GUEST_CONFINED_CODEX_ARGS } from "./codex-guest.ts";
import { TEAM_TOOLS_FAILED, teamToolsFailed } from "./team-tools.ts";
// The `codex` CLI headless over its app-server JSON-RPC (NDJSON on stdio): completion is
// `turn/completed`, approvals arrive as server→client requests, resumeCursor is the codex thread id.
import { existsSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import { codexConfigMcp, codexConfigRunsServer, mountedMcpServerName } from "./codex-mcp-names.ts";

import { DATA_DIR, stripWorkspaceCredentialEnv } from "../config.ts";
import { laterStartup, openStartupModelCatalog, readStartupModelCache, writeStartupModelCache } from "../startup-model-catalog.ts";
import { hostedWorkspaceConfigured } from "../enterprise.ts";
import { cloudHomeConfigured } from "../cloud-home.ts";
import { serverVersion } from "../environment.ts";
import { ChatGptPlanAuthController } from "./chatgpt-plan-auth.ts";
import { captureCliTree, describeSpawnFailure, execCli, killCliTree, spawnCli, waitForExit } from "../procs.ts";
import { codexLaunch, codexLaunchesStarting, codexLaunchSlot, codexRpcTimeoutMs, keepStopping, RELAUNCH_EXIT_WAIT_MS, spawnHoldingSlot, tryCodexLaunchSlot } from "./codex-process.ts";
import { isReservedMcpEnvEntry, mcpServerNameError } from "../mcp-registry.ts";

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
  TextGenerationOptions,
} from "../contracts.ts";
import { newEventId, newId, TurnNotStartedError } from "../contracts.ts";
import { decodeCodexSelection, OFFICIAL_CODEX_PROVIDER, readCodexModelCatalog, STATIC_CODEX_MODELS } from "./codex-catalog.ts";
import { codexLocalProviderArgs } from "./local-inject.ts";
import { codexBackgroundRoute, runCodexBackgroundRoute, runCodexOneShot } from "./codex-background-text.ts";
import { augmentedPath, splitCliString } from "../env-path.ts";
import { classifyError, computeBackoff, interruptibleDelay, RETRY_MAX_ATTEMPTS } from "./retry.ts";
import { appendNative } from "./native.ts";
import { answersAlone, permissionLaunchCwd, shellRequest } from "./permission-command.ts";
import { commandSummary, toolDetailPreview } from "../tool-summary.ts";
import { codexDeveloperInstructions, syncCodexInstructions } from "./codex-instructions.ts";
import { volatileContextNote, withContextNote } from "./prompt-split.ts";
import type { ApprovalMode } from "../../shared/approval-mode.ts";
import { CodexDeviceAuthController } from "./codex-device-auth.ts";
import { codexAccountEmail, codexHome } from "./codex-identity.ts";
import { CODEX_MISSING_CREDENTIALS, CODEX_SIGN_IN_EXPIRED, codexLimitFacts, codexNotSignedIn, codexSignInExpired, codexSignInRefused, codexUserError, type CodexRoute } from "./codex-errors.ts";
import { codexLoginCheck, codexLoginStatus, storedCodexLogin } from "./codex-login.ts";
import { keyRejected, noteKeyAccepted, noteKeyRejected } from "../key-rejections.ts";
import { classifyResumeFailure, mayReplay, rebuiltSessionNotice, recoveryPromptFor } from "../resume-recovery.ts";
import { extractMcpImages } from "../mcp-tool-images.ts"; import { codexImageInputs, withoutInlineImages } from "./codex-images.ts";
import { parseProtocolAskQuestions, questionChoices } from "../../shared/ask-question.ts";
import { codexQuestionReply, openAsyncQuestion, type CodexAsk } from "./codex-questions.ts";
import { codexVersionBehind, readLatestCodexRelease } from "./codex-release.ts";
import { effectiveApprovalPolicy, effectiveApprovalsReviewer } from "./codex-approval-config.ts";
import { canUseMcpServer } from "../../shared/tool-scope.ts";
import { assertToolScopeSupported } from "../../shared/tool-scope-support.ts";
import { appMountFor, gateServer, mcpStdioServer } from "../mcp-gate-config.ts"; import { OWN_APPS_SERVER } from "../../shared/own-apps.ts";
import { CALL_TOOL, DESCRIBE_TOOL, SEARCH_TOOL, directoryCallTarget } from "../mcp-directory.ts"; import { codexPatchProgress } from "./tool-progress.ts";

export { decodeCodexSelection, readCodexModelCatalog, STATIC_CODEX_MODELS } from "./codex-catalog.ts";

const DRIVER_KIND = "codex";
const OFFICE_FEATURES_OFF = ["multi_agent", "memories", "goals", "tool_suggest", "hooks", "apps", "plugins", "remote_plugin",
  "image_generation", "sleep_tool", "daemon_auto_start"] as const;

function stripOfficeEnvironment(env: Record<string, string | undefined>): void {
  for (const name of Object.keys(env)) {
    if (/proxy|^AGENT_VAULT|^(?:BASH_ENV|ENV|NODE_OPTIONS|LD_PRELOAD|DYLD_INSERT_LIBRARIES|OPENAI_BASE_URL|OPENAI_API_BASE)$/i.test(name)) delete env[name];
  }
}

class CodexRpcError extends Error {
  code: unknown;

  constructor(error: { code?: unknown; message?: string }) {
    super(error.message ?? JSON.stringify(error));
    this.code = error.code;
  }
}

function missingNativeCodexThread(error: unknown, cursor: string): boolean {
  // Codex's local thread/resume rejection, verified with an empty native home; unknown versions fail closed.
  return error instanceof CodexRpcError && error.code === -32600 &&
    error.message === `no rollout found for thread id ${cursor}`;
}

/** Codex refuses to resume an archived session: "session <id> is archived. Run `codex unarchive <id>` to unarchive it first." */
const archivedNativeCodexThread = (error: unknown, cursor: string): boolean =>
  error instanceof CodexRpcError && error.message.includes(cursor) && /\bis archived\b/.test(error.message);

/** Ask the configured executable to update itself, so a non-PATH Codex is the one updated. */
export function codexUpdateCommand(cli: string, platform: NodeJS.Platform = process.platform): string {
  if (cli === "codex") return "codex update";
  const trimmed = cli.trim();
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

/** The token-sharing Responses bridge carries no hosted tool_search (Codex 0.159.0 sends none), so
 * a plan turn's MCP tools load up front. */
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
    // OPENMAUSBOT_CHATGPT_TOKEN is excluded via extendShellExclusions: a `-c exclude` here would replace the lower layers' list.
  ];
}

function decodeManagedCodex(raw: object): NonNullable<CodexConfig["managed"]> {
  const value = raw as { url?: unknown; models?: unknown };
  if (typeof value.url !== "string" || !Array.isArray(value.models) || !value.models.length || value.models.some(model => typeof model !== "string" || !/^[\w][\w./+-]*$/.test(model))) {
    throw new Error("Invalid Company Codex configuration.");
  }
  const url = new URL(value.url);
  // Plain HTTP leaks the Company API key; allow it only on loopback.
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

const PRIVATE_ENV_FAMILIES = ["OMB_GATE_CONFIG_", "OMB_REMOTE_MCP_CONFIG_"];
const PROXY_LITERAL_ENV = ["NODE_USE_ENV_PROXY", "NO_PROXY", "no_proxy"];
const SHELL_ESSENTIALS = new Set(["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TERM", "LANG", "TZ"]);

const DENY_TIMEOUT_NOTE =
  "OpenMausBot: nobody answered this permission request in time. Skip this action and finish what you can without it.";

const renamedMcpServers = new Set<string>();
function noteRenamedMcpServer(name: string, mountName: string): void {
  if (renamedMcpServers.has(name)) return;
  renamedMcpServers.add(name);
  console.error(`codex: MCP server ${JSON.stringify(name)} is also declared in Codex's own config.toml — mounted as ${JSON.stringify(mountName)} for this bot so the two do not merge`);
}

/** JSON string quoting is valid TOML basic-string quoting. */
function tomlInlineTable(entries: Record<string, string>): string {
  return `{ ${Object.entries(entries).map(([key, value]) => `${JSON.stringify(key)} = ${JSON.stringify(value)}`).join(", ")} }`;
}

interface CodexApprovalParams {
  thread: Record<string, unknown>;
  turn: Record<string, unknown>;
  /** Legacy settings for an older app-server that rejects the named-profile field. */
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

/** Only schema-backed app-access approvals; any other MCP form (credentials, free text, URLs) stays
 * user input and is declined, and Full access never fabricates one. */
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

  const label = boundedLabel(appName) ?? boundedLabel(request.serverName) ?? "app_access";
  return { tool: label.startsWith("mcp__") ? "app_access" : label, summary: message, allowResult: { action: "accept", content } };
}

/** Thread-config overrides adding `patterns` to the person's shell exclusions. Codex keeps two
 * representations, the `exclude`/`include_only` lists and the `filters` table, and a higher layer
 * that writes one drops the other below it (codex-cli 0.160, which reports unset fields as null). */
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

/** Codex persists these on its native thread, so they are explicit on start, resume and every turn.
 * Codex has no narrower "edits only" sandbox, so a stray Edits value asks. */
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

function withResolvedSandbox(params: CodexApprovalParams, session: unknown): CodexApprovalParams {
  const requested = plainRecord(params.turn.sandboxPolicy);
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
  // Codex 0.151 profiles define the sandbox but not the approval policy: reassert both approval
  // fields so a resumed Full thread cannot keep `never`.
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

/** Native instructions and image bytes stay out of diagnostics; the provider still gets the unmodified request. */
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
  return record.method === "turn/start" ? withoutInlineImages(message) : message;
}

/** A response arriving after its request timed out is still sanitized, never a secret-bearing orphan. */
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
  return withoutInlineImages(message);
}

/** Codex's default for one MCP server's tools (openai/codex#17843): "auto"
 * runs without asking only tools the server marks read-only, "approve" runs
 * every tool without asking, "prompt" asks for each call. */
type McpApprovalMode = "approve" | "auto" | "prompt";

function mountMcpServer(
  appServerArgs: string[],
  env: Record<string, string | undefined>,
  name: string,
  server: StdioMcpSpec,
  approval: McpApprovalMode = "auto",
  /** Written into the mount's own `env` table: its process gets them, Codex's command shell does not. */
  literalEnv: Record<string, string> = {},
  written: Set<string> = new Set(),
): void {
  const prefix = `mcp_servers.${name}`;
  Object.assign(env, server.env);
  for (const name of Object.keys(server.env)) written.add(name);
  appServerArgs.push(
    "-c", `${prefix}.command=${JSON.stringify(server.command)}`,
    "-c", `${prefix}.args=${JSON.stringify(server.args)}`,
    // argv carries names only, so credentials never appear in process listings.
    "-c", `${prefix}.env_vars=${JSON.stringify(Object.keys(server.env))}`,
  );
  if (Object.keys(literalEnv).length) appServerArgs.push("-c", `${prefix}.env=${tomlInlineTable(literalEnv)}`);
  if (approval !== "prompt") appServerArgs.push("-c", `${prefix}.default_tools_approval_mode="${approval}"`);
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
    const officeExecution = input.officeExecution === true;
    const plan = config.authMode === "chatgpt-plan";
    const planUnavailable = plan && (hostedWorkspaceConfigured() || cloudHomeConfigured())
      ? "ChatGPT plan sign-in for hosted Pro requires OpenAI's hosted-app approval. Use a Company model or API key until that integration is approved; the local desktop flow cannot be used here."
      : undefined;
    const planDirectory = join(DATA_DIR, "providers", "chatgpt-plan", createHash("sha256").update(instanceId).digest("hex"));
    const childEnv = (): Record<string, string | undefined> => {
      const env: Record<string, string | undefined> = {
        ...process.env,
        ...input.environment,
        PATH: augmentedPath(),
        NPM_CONFIG_LOGLEVEL: "error",
      };
      // A leaked API key silently flips Codex's own ChatGPT login to pay-as-you-go.
      delete env.OPENAI_API_KEY;
      stripWorkspaceCredentialEnv(env);
      delete env.OPENMAUSBOT_CHATGPT_TOKEN;
      if (officeExecution) stripOfficeEnvironment(env);
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
      if (config.managed || officeExecution) return;
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
          if (!kept) throw error;
        }
      } else {
        try {
          const resolved = await readCodexModelCatalog(catalogEnv, fetch, config.cli);
          if (resolved.options.length) models = resolved;
        } catch {}
      }
      try { writeStartupModelCache(instanceId, models); } catch {}
    };
    // Codex's model list ships with the CLI: updating 0.155.1 to 0.162.1 in place adds gpt-6.1-sol.
    let modelsCliVersion: string | null = null;
    let startupModelRefresh: Promise<void> | null = null;
    if (officeExecution) {
      const cached = readStartupModelCache(instanceId);
      const options = cached?.options.filter(model => decodeCodexSelection(model.id).modelProvider === OFFICIAL_CODEX_PROVIDER);
      models = options?.length ? { default: options.some(model => model.id === cached!.default) ? cached!.default : options[0].id, options } : STATIC_CODEX_MODELS;
    } else if (config.managed) {
      await refreshModels();
    } else {
      startupModelRefresh = (await openStartupModelCatalog({
        instanceId,
        use: (catalog) => { models = catalog; },
        current: () => models,
        refresh: async () => {
          if (planAuth) {
            try { await refreshModels(laterStartup()); } catch {}
          } else await refreshModels();
        },
      }))?.pending ?? null;
    }
    // OpenAI can refuse Codex's own ChatGPT login while `codex login status` still reports it. Only a
    // stored ChatGPT login is marked: an API-key login cannot be fixed by a ChatGPT sign-in.
    const ownLogin = !plan && !config.managed;
    const loginCheck = codexLoginCheck(config.cli);
    const loginMark = (): [string, string] | null => {
      const env = childEnv();
      const home = ownLogin ? codexHome(env) : null;
      const stored = home ? storedCodexLogin(env) : null;
      if (!home || stored === null) return null;
      try {
        const auth = JSON.parse(stored) as { auth_mode?: unknown; tokens?: unknown };
        const chatgpt = typeof auth.auth_mode === "string" ? /chatgpt/i.test(auth.auth_mode) : Boolean(auth.tokens);
        if (!chatgpt) return null;
      } catch { return null; }
      return [`codex-login:${home}`, stored];
    };
    const smallModelsUsable = () => !plan && loginMark() === null;
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
      steer?: (text: string) => Promise<SteerOutcome>;
      turnId: string;
      asks: Map<string, CodexAsk>;
      office?: boolean;
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
      if (officeExecution && !turn.executionContext) throw new Error("Office execution requires a native controller lease.");
      const restrictedOffice = officeExecution || turn.executionContext !== undefined;
      const assertPreparing = () => {
        if (disposed) throw new Error("This provider was removed. Select a connected account and send again.");
        if (turn.executionContext?.signal.aborted
          || (turn.executionContext && Date.now() >= turn.executionContext.deadline)) {
          throw new TurnNotStartedError(newId(), "Codex execution was stopped before provider admission.");
        }
      };
      assertPreparing();
      if (startupModelRefresh) await startupModelRefresh;
      assertPreparing();
      turn = { ...turn, toolScope: assertToolScopeSupported(DRIVER_KIND, turn.toolScope) };
      const generation = planGeneration;
      const assertPlanCurrent = () => {
        assertPreparing();
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
      // Interrupt state belongs to this turn so activity on other threads cannot cancel or revive its retry.
      let stopRequested = false;
      let promptSubmitted = false;
      let recoveredMissingSession = false;
      let loginRaceRetried = false;
      const stopSignal = new AbortController();
      const { threadId } = turn;
      const approvalMode: ApprovalMode = turn.approvalMode ?? (config.fullAuto ? "full" : "ask");
      if (restrictedOffice && approvalMode === "auto") {
        throw new Error("Office execution does not support automatic model permission review.");
      }
      for (const [name, server] of Object.entries(turn.integrations?.custom ?? {})) {
        if ("url" in server) continue;
        const reserved = Object.entries(server.env).find(([key, value]) => isReservedMcpEnvEntry(key, value));
        if (reserved) {
          throw new Error(`Custom MCP server “${name}” cannot set reserved environment variable “${reserved[0]}”`);
        }
      }
      let autoAcceptPermissions = approvalMode === "full";
      const chatgptTurn = ownLogin &&
        decodeCodexSelection(turn.model || models.default).modelProvider === OFFICIAL_CODEX_PROVIDER;
      if (turn.executionContext && !chatgptTurn) {
        throw new Error("Office execution permits only native Codex OAuth model routes.");
      }
      const route: CodexRoute = plan ? "plan" : chatgptTurn ? "own" : "other";
      const signedOut = chatgptTurn && await loginCheck(childEnv()) === "missing";
      assertPlanCurrent();
      if (active.has(threadId)) throw new Error("a turn is already running on this thread");
      const turnId = newId();
      if (signedOut) {
        emit({ ...base(threadId, turnId), type: "turn.started" });
        emit({ ...base(threadId, turnId), type: "runtime.error", message: codexNotSignedIn(), setup: true });
        emit({ ...base(threadId, turnId), type: "turn.completed", ok: false, stopReason: "auth_required", cost: null });
        return { turnId };
      }
      const retryScale = Number(process.env.FAKE_CODEX_RETRY_SCALE ?? "1");
      let announced = false;
      const waitingTurn = (attempt: number): Turn => {
        const waiting: Turn = { stop: async () => { stopRequested = true; stopSignal.abort(); return true; }, turnId, asks: new Map(), office: restrictedOffice };
        active.set(threadId, waiting);
        if (attempt === 0 && !announced) emit({ ...base(threadId, turnId), type: "turn.started" });
        announced = true;
        return waiting;
      };
      const waitForLaunchSlot = async (attempt: number) => {
        const waiting = waitingTurn(attempt);
        emit({ ...base(threadId, turnId), type: "runtime.notice", message: `Waiting for a free Codex slot: ${codexLaunchesStarting()} Codex runs are starting on this computer. This one starts on its own.` });
        const slot = await codexLaunchSlot(stopSignal.signal);
        if (slot && !stopRequested) return slot;
        slot?.();
        if (active.get(threadId) === waiting) {
          active.delete(threadId);
          emit({ ...base(threadId, turnId), type: "turn.completed", ok: false, stopReason: "interrupted", cost: null });
        }
        return null;
      };
      const prelaunchFailed = (error: unknown) => {
        const current = active.get(threadId);
        if ((current && current.turnId !== turnId) || (!current && announced)) return;
        active.delete(threadId);
        if (!announced) emit({ ...base(threadId, turnId), type: "turn.started" });
        announced = true;
        const cancelled = stopRequested || turn.executionContext?.signal.aborted;
        if (!cancelled) emit({ ...base(threadId, turnId), type: "runtime.error", message: error instanceof Error ? error.message : String(error) });
        emit({ ...base(threadId, turnId), type: "turn.completed", ok: false, stopReason: cancelled ? "interrupted" : "execution_not_admitted", cost: null });
      };
      const launchAttempt = async (attempt: number): Promise<void> => {
        const env = childEnv();
        const launchedLogin = chatgptTurn ? storedCodexLogin(env) : null;
        if (planToken) env.OPENMAUSBOT_CHATGPT_TOKEN = planToken;
        const appServerArgs = ["app-server", ...(plan ? chatgptPlanCodexArgs() : config.managed ? managedCodexArgs(config.managed) : codexLocalProviderArgs(env, turn.model)), ...codexToolSurfaceArgs(),
          ...(restrictedOffice ? OFFICE_FEATURES_OFF.flatMap(feature => ["-c", `features.${feature}=false`]) : []),
          // Native shell snapshots can restore variables the shell policy removed.
          ...(turn.toolScope === undefined && !restrictedOffice ? [] : ["-c", "features.shell_snapshot=false"]),
          // A guest-driven turn: no shell, no file reads (-c wins over config files).
          ...(turn.guestConfined ? GUEST_CONFINED_CODEX_ARGS : [])];
        const baseEnv = new Map(Object.entries(env).filter(([, value]) => value !== undefined));
        const mountedNames = new Set<string>();
        const selectedMcp = new Map<string, StdioMcpSpec>();
        const selectedApprovals = new Map<string, McpApprovalMode>();
        const customMcpNames = new Map<string, string>();
        const directoryMounts = new Set<string>();
        const literalEnvs = new Map<string, Record<string, string>>();
        const scopedServer = (name: string, mountName: string, server: McpServerSpec): StdioMcpSpec | null => {
          if (!canUseMcpServer(turn.toolScope, name)) return null;
          if (restrictedOffice && !("url" in server)) {
            const env = { ...server.env };
            stripOfficeEnvironment(env);
            for (const name of ["HOME", "USERPROFILE", "CODEX_HOME", "OPENAI_API_KEY", "OPENMAUSBOT_CHATGPT_TOKEN"]) delete env[name];
            server = { ...server, env };
          }
          // Every URL server goes through OpenMausBot's remote proxy: Codex's own client adds fields
          // strict servers refuse (codex-cli 0.160.1 sends elicitation.form/url; rmcp 3.2 can add
          // schemaValidation), and Codex does not speak SSE. A plan turn has no tool_search, so its URL
          // servers use the proxy's tool directory.
          const directory = plan && "url" in server;
          const apps = appMountFor(name, turn);
          if (turn.toolScope === undefined && !("url" in server) && !apps) return server;
          const hash = createHash("sha256").update(mountName).digest("hex");
          // Codex starts MCP children with only a few env names.
          const proxy = turn.toolScope === undefined && "url" in server
            ? mcpStdioServer(server, { nodeEnv: { ELECTRON_RUN_AS_NODE: "1" }, ...(directory ? { directory: { name } } : {}), configEnvName: `OMB_REMOTE_MCP_CONFIG_${hash}`, sourceEnv: env, apps })
            : gateServer({ name, server, threadId, budget: 0, toolScope: turn.toolScope, nodeEnv: { ELECTRON_RUN_AS_NODE: "1" }, configEnvName: `OMB_GATE_CONFIG_${hash}`, directory, sourceEnv: env, apps });
          if (proxy && directory) directoryMounts.add(mountName);
          if (!proxy) return null;
          const shared = { ...proxy.env };
          if (turn.toolScope === undefined) {
            const literal = Object.fromEntries(Object.entries(shared).filter(([key]) => PROXY_LITERAL_ENV.includes(key)));
            for (const key of PROXY_LITERAL_ENV) delete shared[key];
            if (Object.keys(literal).length) literalEnvs.set(mountName, literal);
          }
          return { command: proxy.command, args: proxy.args ?? [], env: shared };
        };
        const mountSelected = (name: string, mountName: string, server: McpServerSpec, approval: McpApprovalMode = "auto") => {
          const selected = scopedServer(name, mountName, server);
          if (selected) {
            selectedMcp.set(mountName, selected);
            selectedApprovals.set(mountName, approval);
            mountMcpServer(appServerArgs, env, mountName, selected, approval, literalEnvs.get(mountName), mountedNames);
            if (turn.toolScope !== undefined && approval === "prompt") appServerArgs.push("-c", `mcp_servers.${mountName}.default_tools_approval_mode="prompt"`);
          }
        };
        if (turn.integrations?.composio) mountSelected("composio", "openmausbot_connectors", turn.integrations.composio);
        if (turn.integrations?.composioOwn) mountSelected(OWN_APPS_SERVER, `openmausbot_${OWN_APPS_SERVER}`, turn.integrations.composioOwn);
        if (turn.integrations?.agents) {
          // OpenMausBot's own coordination tools never ask: "auto" quiets only read-only tools.
          mountSelected("agents", "agents", turn.integrations.agents, "approve");
        }
        if (turn.integrations?.localComputer) {
          mountSelected("computer", "computer", turn.integrations.localComputer);
        }
        if (turn.integrations?.browser) {
          mountSelected("browser", "browser", turn.integrations.browser);
        }
        for (const name of ["data", "highlevel"] as const) if (turn.integrations?.[name]) mountSelected(name, name, turn.integrations[name]);
        // A `-c` override merges with a same-named server in config.toml, and stdio over url is
        // "invalid configuration" that kills the turn, so such a server mounts under its own name.
        const codexConfig = codexConfigMcp(env), declaredInCodexConfig = codexConfig.names;
        if (turn.toolScope !== undefined || restrictedOffice) {
          for (const name of declaredInCodexConfig) appServerArgs.push("-c", `mcp_servers.${name}.enabled=false`);
        }
        for (const [name, server] of Object.entries(turn.integrations?.custom ?? {}).filter(([name, server]) => turn.toolScope !== undefined || restrictedOffice || !codexConfigRunsServer(codexConfig, name, server))) {
          const mountName = mountedMcpServerName(name, declaredInCodexConfig);
          if (mountName !== name) noteRenamedMcpServer(name, mountName);
          mountSelected(name, mountName, server, "prompt");
          if (selectedMcp.has(mountName) && !mcpServerNameError(name) && !name.includes("__")) customMcpNames.set(mountName, name);
        }
        if (turn.integrations?.phone) {
          if (turn.toolScope !== undefined || restrictedOffice) {
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

        // Codex gives MCP children their variables from the environment it runs shell commands in, so
        // every variable a mount writes is excluded from that shell (snapshots are off).
        const mountedEnv = [...mountedNames].filter((name) => env[name] !== undefined && !SHELL_ESSENTIALS.has(name) && !name.startsWith("LC_")
          && (name === "ELECTRON_RUN_AS_NODE" || baseEnv.get(name) !== env[name]));
        const privateEnv = [...new Set([
          ...(turn.toolScope !== undefined ? ["OMB_GATE_CONFIG_*"] : []),
          ...PRIVATE_ENV_FAMILIES.filter((family) => mountedEnv.some((name) => name.startsWith(family))).map((family) => `${family}*`),
          ...mountedEnv.filter((name) => !PRIVATE_ENV_FAMILIES.some((family) => name.startsWith(family))).sort(),
        ])];
        // Records this turn writes never run without proof that shell snapshots are off.
        const provenPrivateEnv = turn.toolScope !== undefined || directoryMounts.size > 0;
        if (privateEnv.length && turn.toolScope === undefined) appServerArgs.push("-c", "features.shell_snapshot=false");

        const selectionConfig: { config?: Record<string, unknown> } = turn.toolScope === undefined && !restrictedOffice ? {} : { config: { mcp_servers: Object.fromEntries(
          [...selectedMcp].map(([name, server]) => [name, {
            command: server.command, args: server.args, env_vars: Object.keys(server.env), env: {}, default_tools_approval_mode: selectedApprovals.get(name) ?? "prompt",
          }]),
        ) } };

        const commandCwd = permissionLaunchCwd(turn.cwd ?? homedir());
        if (restrictedOffice) {
          stripOfficeEnvironment(env);
          delete env.OPENAI_API_KEY;
          delete env.OPENMAUSBOT_CHATGPT_TOKEN;
          for (const name of ["HOME", "USERPROFILE", "CODEX_HOME"]) {
            if (baseEnv.has(name)) env[name] = baseEnv.get(name);
            else delete env[name];
          }
        }
        const releaseSlot = tryCodexLaunchSlot() ?? await waitForLaunchSlot(attempt);
        if (!releaseSlot) return;
        const waiting = waitingTurn(attempt);
        try {
          assertPreparing();
          if (stopRequested) throw new TurnNotStartedError(turnId, "Codex was stopped while waiting for a launch slot.");
          await turn.engineAdmission?.("process");
          assertPreparing();
          if (stopRequested || active.get(threadId) !== waiting) throw new TurnNotStartedError(turnId, "Codex was stopped while waiting for memory.");
          turn.executionContext?.assert("process");
        } catch (error) {
          releaseSlot();
          throw error;
        }
        const child = spawnHoldingSlot(releaseSlot, () => {
          assertPreparing();
          if (stopRequested) throw new TurnNotStartedError(turnId, "Codex was stopped before process start.");
          return spawnCli(...codexLaunch(config.cli, appServerArgs), {
            cwd: turn.cwd ?? homedir(),
            env,
            stdio: ["pipe", "pipe", "pipe"],
          }, "bot");
        });

      let abandoned = false;
      let codexThreadId: string | null = null;
      let codexTurnId: string | null = null;
      let startingNativeTurn = false;
      const earlyNotifications: any[] = [];
      const state = {
        settled: false,
        lastError: "",
        lastErrorSetup: false,
        retryError: "",
        authRecovery: false,
        lastText: "",
        sawStreamDelta: false,
        streamed: false,
        // codex reports token usage as a running total for the app-server process.
        usage: undefined as { input: number; output: number; cachedInput?: number } | undefined,
        usageBaseline: undefined as { input: number; output: number; cachedInput: number } | undefined,
      };

      const asks = new Map<string, CodexAsk>();
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
      const request = (method: string, params: unknown, timeoutMs = codexRpcTimeoutMs(method)) =>
        new Promise<any>((resolve, reject) => {
          const id = nextId++;
          if (method === "config/read") sensitiveResponseIds.add(id);
          // A wedged app-server can accept stdin and never reply.
          const timer = setTimeout(() => {
            if (rpcPending.delete(id)) reject(new Error(`codex ${method} timed out after ${timeoutMs}ms`));
          }, timeoutMs);
          if (typeof timer.unref === "function") timer.unref();
          rpcPending.set(id, {
            resolve: (v) => {
              clearTimeout(timer);
              if (method === "thread/start" || method === "thread/resume") {
                // Notifications can follow the thread response in one stdout chunk.
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
                // Bind synchronously: one stdout chunk can hold the response, events, completion and a late request.
                codexTurnId = v.turn.id;
                startingNativeTurn = false;
                for (const notification of earlyNotifications.splice(0)) {
                  if (state.settled || abandoned) break;
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
      const terminate = () => stopping ??= killCliTree(child, turn.executionContext ? 0 : 5_000).then((stopped) => {
        if (!stopped) stopping = undefined;
        return stopped;
      });
      let completeStoppedTurn: (() => void) | undefined;
      // Interrupt over the protocol before any signal: killing first surfaced routine stops as
      // "codex exited null (signal SIGTERM) before turn/completed".
      let interruptRequested = false;
      const stop = async () => {
        captureCliTree(child);
        stopRequested = true;
        stopSignal.abort();
        if (!turn.executionContext && !state.settled && !interruptRequested && codexThreadId && codexTurnId &&
            child.exitCode === null && child.signalCode === null) {
          interruptRequested = true;
          const graceMs = Math.max(1, Number(process.env.FAKE_CODEX_INTERRUPT_GRACE_MS ?? 750) || 750);
          try {
            await request("turn/interrupt", { threadId: codexThreadId, turnId: codexTurnId }, graceMs);
          } catch {}
          const deadline = Date.now() + graceMs;
          while (!state.settled && Date.now() < deadline) {
            await new Promise((wake) => setTimeout(wake, 15));
          }
          // Sign-out must wait until the child holding its token has exited.
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
        if (await stop()) return;
        emit({ ...base(threadId, turnId), type: "runtime.error", message: "codex did not shut down after termination was requested" });
        await keepStopping(terminate, () => active.get(threadId)?.stop === stop);
        complete();
      };

      // Retires this process before anything async, so a late rpc timer rejection cannot relaunch again.
      const relaunch = async (reason: string, failure: string, failedStop: string) => {
        const delayMs = computeBackoff(attempt);
        attempt++;
        emit({ ...base(threadId, turnId), type: "turn.retrying", attempt, delayMs, reason });
        abandoned = true;
        releaseSlot();
        const exited = child.exitCode !== null || child.signalCode !== null;
        if (!exited && !(await terminate()) && !(await waitForExit(child, RELAUNCH_EXIT_WAIT_MS))) {
          emit({ ...base(threadId, turnId), type: "runtime.error", message: failure });
          return settle(false, failedStop);
        }
        await interruptibleDelay(Math.max(1, Math.round(delayMs * retryScale)), stopSignal.signal).promise;
        if (!stopRequested) void launchAttempt(attempt).catch(prelaunchFailed);
        else await settle(false, "interrupted");
      };

      const steerActiveTurn = async (text: string): Promise<SteerOutcome> => {
        if (state.settled || abandoned || stopRequested || !codexThreadId || !codexTurnId) return "refused";
        if (child.exitCode !== null || child.signalCode !== null) return "refused";
        try {
          assertPreparing();
          turn.executionContext?.assert("steer");
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

      const controlsHost = turn.integrations?.localComputer?.scope === "local-computer";
      const handleServerRequest = (msg: any) => {
        if (turn.executionContext) {
          if (stopRequested || state.settled || abandoned) { void stop(); return; }
          try { assertPreparing(); turn.executionContext.assert("steer"); }
          catch { void stop(); return; }
        }
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
        // An MCP elicitation asks for real input, not permission; unknown server requests fail closed
        // instead of being accepted by Full access.
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
        // Codex asks 'Allow the <server> MCP server to run tool "<tool>"?'. The tool runs from the
        // first quote to the closing `"?`, so `web_search" …` cannot pass for web_search.
        const mcpMessage = typeof params.message === "string" ? params.message : "";
        const mcpTool = isLegacyMcpPermission ? / to run tool "(.*)"\?$/.exec(mcpMessage)?.[1] : undefined;
        const searchedServer = isLegacyMcpPermission && typeof params.serverName === "string" && directoryMounts.has(params.serverName);
        const asksAbout = (tool: string) => mcpMessage === `Allow the ${params.serverName} MCP server to run tool "${tool}"?`;
        if (searchedServer && (asksAbout(SEARCH_TOOL) || asksAbout(DESCRIBE_TOOL))) {
          send({ jsonrpc: "2.0", id: msg.id, result: { action: "accept", content: {} } });
          return;
        }
        const runs = searchedServer && asksAbout(CALL_TOOL) ? directoryCallTarget(CALL_TOOL, params._meta?.tool_params) : undefined;
        const customMcpName = typeof params.serverName === "string" ? customMcpNames.get(params.serverName) : undefined;
        const customMcpTool = runs ?? mcpTool ?? "mcp";
        const qualifiedMcpTool = isLegacyMcpPermission && customMcpName && mcpTool && asksAbout(mcpTool)
          && customMcpTool && /^[A-Za-z0-9_.:-]+$/.test(customMcpTool)
          ? `mcp__${customMcpName}__${customMcpTool}` : undefined;
        const tool =
          mcpAppApproval
            ? mcpAppApproval.tool
            : isLegacyMcpPermission
            ? (qualifiedMcpTool ?? (customMcpTool.startsWith("mcp__") ? "mcp" : customMcpTool))
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
        const shell = method === "execCommandApproval" || method === "item/commandExecution/requestApproval" ? params.command : undefined;
        if (autoAcceptPermissions && isPermission && answersAlone(shell)) {
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
        const choices =
          isQuestion && protocolQuestions ? questionChoices(protocolQuestions.map(({ question }) => question)) : undefined;
        const finish = (behavior: "allow" | "deny" | "answer", message?: string, source: "user" | "timeout" | "system" = "user") => {
          if (!asks.delete(requestId)) return;
          clearTimeout(timer);
          if (isQuestion) {
            send({ jsonrpc: "2.0", id: msg.id, result: codexQuestionReply(behavior, message, source, protocolQuestions ?? []) });
          } else {
            send({
              jsonrpc: "2.0",
              id: msg.id,
              result: permissionResult(behavior === "allow"),
            });
          }
          emit({ ...base(threadId, turnId), type: "request.resolved", requestId, behavior, source });
        };
        const timer = isQuestion ? undefined : setTimeout(() => finish("deny", DENY_TIMEOUT_NOTE, "timeout"), 15 * 60_000);
        timer?.unref?.();
        asks.set(requestId, finish);
        emit({
          ...base(threadId, turnId),
          type: "request.opened",
          requestId,
          requestType: isQuestion ? "question" : "permission",
          tool,
          summary,
          ...shellRequest(shell, params.cwd ?? (
            !params.threadId || params.threadId === codexThreadId ? commandCwd : undefined
          )),
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
      let teamToolsNoticed = false;
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
      // Each bot's Codex reads auth.json when it starts, possibly while another one rewrites it.
      const retryLoginRace = (raw: string, refused: boolean): boolean => {
        const missing = CODEX_MISSING_CREDENTIALS.test(raw);
        if (!chatgptTurn || loginRaceRetried || state.streamed || attempt >= RETRY_MAX_ATTEMPTS - 1 || !(refused || missing)) return false;
        const mark = loginMark();
        if (!mark || (!missing && mark[1] === launchedLogin)) return false;
        loginRaceRetried = true;
        void relaunch("auth", raw, "auth_required").catch(() => {});
        return true;
      };
      const turnError = (error: { message?: unknown; codexErrorInfo?: unknown }) => {
        const raw = String(error.message);
        const refused = chatgptTurn && loginMark() !== null && (codexSignInRefused(error) ||
          (state.authRecovery && !/\b403\b|forbidden/i.test(raw) && /\b401\b|unauthorized/i.test(raw)));
        if (retryLoginRace(raw, refused)) return;
        if (refused) loginRefused();
        const message = refused ? codexSignInExpired(raw) : codexUserError(raw, route, error.codexErrorInfo);
        const setup = refused || classifyError({ text: raw }).reason === "auth";
        if (message === state.lastError && (state.lastErrorSetup || !setup)) return;
        state.lastError = message;
        state.lastErrorSetup ||= setup;
        emit({ ...base(threadId, turnId), type: "runtime.error", message, ...(setup ? { setup: true } : {}), ...codexLimitFacts(raw, route) });
      };
      const handleNotification = (msg: any) => {
        const p = msg.params ?? {};
        // MCP servers start with the thread, before it has an id; this process serves this turn alone.
        if (msg.method === "mcpServer/startupStatus/updated") {
          if (!teamToolsNoticed && teamToolsFailed(p)) {
            teamToolsNoticed = true;
            emit({ ...base(threadId, turnId), type: "runtime.notice", message: TEAM_TOOLS_FAILED });
          }
          return;
        }
          // The app-server also notifies for native helper threads; only this request's parent writes or settles.
        const connectionError = msg.method === "error" &&
          !("threadId" in p) && !("turnId" in p);
        if (!connectionError) {
          if (!codexThreadId || p.threadId !== codexThreadId) return;
          if (!codexTurnId && msg.method === "thread/tokenUsage/updated" && p.tokenUsage?.total) {
            // A total reported before this turn exists is what the process carried in: the baseline.
            const t = p.tokenUsage.total;
            state.usageBaseline = { input: t.inputTokens ?? 0, output: t.outputTokens ?? 0, cachedInput: t.cachedInputTokens ?? 0 };
            return;
          }
          if (!codexTurnId) {
            // Some servers stream before acknowledging turn/start.
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
          // guardianWarning is thread-scoped in Codex 0.147.
          if (eventTurnId !== codexTurnId && !(msg.method === "guardianWarning" && eventTurnId === undefined)) return;
        }
        if (msg.method.startsWith("item/") && p.item?.type !== "userMessage") state.streamed = true;
        switch (msg.method) {
          case "guardianWarning":
            if (typeof p.message === "string" && /automatic approval review.*timed out/i.test(p.message)) reviewWarning = true;
            break;
          case "item/autoApprovalReview/completed": {
            const status = p.review?.status;
            if (status !== "timedOut" && status !== "denied") break;
            if (typeof p.reviewId !== "string" || !p.reviewId) break;
            if (!seenReviews.has(p.reviewId)) {
              seenReviews.add(p.reviewId);
              if (status === "timedOut") timedOutReview = true;
              reviewNotice(status, p.action);
            }
            break;
          }
          // item/completed follows with the whole message, so a delta is only a fallback.
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
            if (typeof p.delta === "string" && p.delta) emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "reasoning_text", delta: p.delta });
            break;
          }
          case "item/fileChange/patchUpdated": { const draft = codexPatchProgress(p); if (draft) emit({ ...base(threadId, turnId), ...draft }); break; }
          case "item/started": {
            const item = p.item ?? {};
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
              openAsyncQuestion(item, asks, steerActiveTurn, (event) => emit({ ...base(threadId, turnId), ...event }));
            } else if (item.type === "imageGeneration" && item.status !== "failed") {
              // The app-server returns the generated raster as base64 `result` and may expose a local
              // `savedPath`; use the bytes, never the provider-owned path.
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
            // `total` covers this app-server process, `last` the latest model call; codex's inputTokens
            // already includes cachedInputTokens.
            const t = p.tokenUsage?.total;
            const last = p.tokenUsage?.last;
            const shape = (u: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number }) => ({
              input: u.inputTokens ?? 0, output: u.outputTokens ?? 0, cachedInput: u.cachedInputTokens ?? 0,
            });
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
                output: t.outputTokens ?? 0, ...(typeof t.reasoningOutputTokens === "number" ? { reasoning: t.reasoningOutputTokens } : {}),
                ...(typeof t.cachedInputTokens === "number" ? { cachedInput: t.cachedInputTokens } : {}),
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
              turnError({ message: state.retryError });
            }
            if (abandoned) break;
            void settle(t.status === "completed", t.status === "completed" ? null :
              (classifyError({ text: state.lastError }).reason === "provider_safety" ? "provider_safety" : (state.lastError || t.status || "failed")));
            break;
          }
          case "error": {
            // 0.144 sends {message}; 0.139 and 0.160 nest {error:{message, codexErrorInfo}}.
            const error = p.error && typeof p.error === "object" ? p.error : { message: p.message };
            if (!error.message) break;
            // 0.160 reports each of its own reconnects ("Reconnecting... 1/5") with willRetry: true.
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
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        if (abandoned || state.settled) return;
        buf += chunk;
        let nl;
        while (!state.settled && !abandoned && (nl = buf.indexOf("\n")) !== -1) {
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
      // Only stderr after the last protocol message can explain an exit; older bytes are context.
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
          void stop();
          return;
        }
        if (stopRequested) {
          void settle(false, "interrupted");
          return;
        }
        const recentStderr = stderrSinceOutput.trim();
        const hadStreamedOutput = codexTurnId !== null || state.sawStreamDelta;
        // A signal exit (OOM, kill -9) is terminal whatever the stderr says; classifyError cannot see it.
        const verdict =
          signal !== null
            ? { transient: false, reason: "interrupted" }
            : classifyError({ exitCode: code, stderr: recentStderr });
        const exitMessage = `codex exited ${code}${signal ? ` (signal ${signal})` : ""} before turn/completed${
          recentStderr ? `: ${recentStderr.slice(-300)}` : hadStreamedOutput && stderr.trim() ? "; no stderr after the last app-server output" : ""
        }`;
        // Relaunch only when turn/start was never acknowledged: a replay could re-run tools the user saw.
        if (!stopRequested && codexTurnId === null && earlyNotifications.length === 0 && verdict.transient && attempt < RETRY_MAX_ATTEMPTS - 1) {
          void relaunch(verdict.reason, exitMessage, "exit_before_result").catch(() => {});
          return;
        }
        emit({ ...base(threadId, turnId), type: "runtime.error", message: exitMessage });
        void settle(false, "exit_before_result");
      });

      active.set(threadId, { stop, turnId, asks, steer: steerActiveTurn, office: restrictedOffice });
      if (attempt === 0 && !announced) emit({ ...base(threadId, turnId), type: "turn.started" });

      try {
        await request("initialize", {
          clientInfo: { name: "openmausbot", title: "OpenMausBot", version: serverVersion() },
          // Named permission profiles are an experimental app-server field in Codex 0.151.
          capabilities: { experimentalApi: true },
        });
        send({ jsonrpc: "2.0", method: "initialized", params: {} });
        // developerInstructions replaces, rather than appends to, native config.
        let effectiveConfig: unknown;
        try {
          const configured = await request("config/read", {
            cwd: turn.cwd ?? homedir(),
            includeLayers: false,
          });
          effectiveConfig = configured?.config;
        } catch (error) {
          // Never expose a possibly secret-bearing config error; codex's "invalid configuration" carries none.
          const invalid = error instanceof CodexRpcError && /^invalid configuration\b/i.test(error.message);
          throw new Error(
            invalid
              ? "Codex rejected its configuration as invalid. Check ~/.codex/config.toml (or CODEX_HOME) for a broken entry, then retry."
              : "Could not read Codex configuration; cannot safely update bot instructions. Retry after checking Codex.",
          );
        }
        if (privateEnv.length || restrictedOffice) {
          const snapshot = (effectiveConfig as { features?: { shell_snapshot?: unknown } } | null)?.features?.shell_snapshot;
          if (provenPrivateEnv || restrictedOffice ? snapshot !== false : snapshot === true) {
            throw new Error("Codex could not disable inherited shell snapshots. No prompt was sent.");
          }
        }
        if (restrictedOffice) {
          const features = (effectiveConfig as { features?: Record<string, unknown> } | null)?.features;
          if (OFFICE_FEATURES_OFF.some(feature => features?.[feature] !== false)) {
            throw new Error("Codex could not disable unrequested native agent or background model features. No prompt was sent.");
          }
        }
        if (privateEnv.length || plan) {
          const rawPolicy = (effectiveConfig as { shell_environment_policy?: unknown } | null)?.shell_environment_policy;
          if (rawPolicy !== undefined && (!rawPolicy || typeof rawPolicy !== "object" || Array.isArray(rawPolicy))) {
            throw new Error("Codex could not confirm its shell environment policy. No prompt was sent.");
          }
          selectionConfig.config = { ...selectionConfig.config,
            ...extendShellExclusions((rawPolicy ?? {}) as Record<string, unknown>, [...(plan ? ["OPENMAUSBOT_CHATGPT_TOKEN"] : []), ...privateEnv]) };
        }
        if (turn.toolScope !== undefined || restrictedOffice) {
          const catalog = (effectiveConfig as { mcp_servers?: unknown } | null)?.mcp_servers;
          if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) throw new Error("Codex could not confirm its selected MCP configuration. No prompt was sent.");
          for (const [name, entry] of Object.entries(catalog)) {
            if (entry && typeof entry === "object" && (entry as { enabled?: unknown }).enabled === false) continue;
            const expected = selectedMcp.get(name);
            const actual = entry as { command?: unknown; args?: unknown; env_vars?: unknown; env?: unknown; default_tools_approval_mode?: unknown; tools?: unknown } | null;
            if (!expected || actual?.command !== expected.command
              || JSON.stringify(actual?.args ?? []) !== JSON.stringify(expected.args ?? [])
              || !Array.isArray(actual?.env_vars) || JSON.stringify([...actual.env_vars].sort()) !== JSON.stringify(Object.keys(expected.env).sort())
              || actual.default_tools_approval_mode !== (selectedApprovals.get(name) ?? "prompt")
              || (actual.env != null && (typeof actual.env !== "object" || Array.isArray(actual.env) || Object.keys(actual.env).length > 0))
              || (actual.tools != null && (typeof actual.tools !== "object" || Array.isArray(actual.tools) || Object.keys(actual.tools).length > 0))) {
              throw new Error("Codex has an MCP server outside the selected configuration. Disable native MCP entries for this account before using tool selection. No prompt was sent.");
            }
          }
        }
        // A Codex that did not take the overrides runs nothing for a guest.
        if (turn.guestConfined && !codexShellDisabled(effectiveConfig)) {
          throw new Error(`This Codex could not turn its shell off, so it can't run this turn. Update Codex, or switch this bot to Claude.${turn.confinedWhy ? ` ${turn.confinedWhy}` : ""}`);
        }
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
          // Omitting these on a resumed thread would keep the previous named mode.
          approvalParams = customApprovalParams(effectiveConfig);
        } else {
          approvalParams = namedApprovalParams(approvalMode);
        }
        if (restrictedOffice && (approvalParams.thread.approvalsReviewer !== "user"
          || approvalParams.turn.approvalsReviewer !== "user")) {
          throw new Error("Office execution does not support automatic model permission review.");
        }
        // Codex's `never` means "do not ask to escalate", not "grant every requested permission":
        // only Full may synthesize approvals.
        autoAcceptPermissions = approvalMode === "full";
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
          // An archived session is unarchived and resumed; if that fails it is rebuilt like a missing one.
          const resumeUnarchived = () => resumeThread().catch((error) => !archivedNativeCodexThread(error, cursor) ? Promise.reject(error)
            : request("thread/unarchive", { threadId: cursor }).then(resumeThread, () => Promise.reject(error)));
          try {
            let resumed;
            try {
              resumed = await resumeUnarchived();
            } catch (error) {
              if (!approvalParams.fallback || !permissionProfileUnsupported(error)) throw error;
              approvalParams = approvalParams.fallback;
              resumed = await resumeUnarchived();
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
                !turn.recoveryText?.trim() || !(missingNativeCodexThread(error, cursor) || archivedNativeCodexThread(error, cursor)) || !mayReplay(failure)) throw error;
            // Codex no longer has the thread: rebuild once, or every later turn fails the same way.
            recoveredMissingSession = true;
            const rebuild = recoveryPromptFor({ recoveryText: turn.recoveryText, currentText: turn.text, failure });
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
          ...await codexImageInputs(turn.images),
        ];
        const startTurn = () => {
          assertPreparing();
          if (stopRequested || state.settled || abandoned) throw new Error("Codex was stopped before prompt dispatch.");
          turn.executionContext?.assert("prompt");
          promptSubmitted = true;
          startingNativeTurn = true;
          return request("turn/start", {
            threadId: codexThreadId,
            input: turnInput,
            ...approvalParams.turn,
            // No environment: exec_command, apply_patch and view_image are refused (codex-cli 0.159.0).
            // Without the experimental API the field is rejected, not ignored.
            ...(turn.guestConfined ? { environments: [] } : {}),
            // Spread, not `effort ?? null`: codex-cli 0.146.0 treats null as absent (the thread keeps
            // its effort), rejects "", and thread/start takes no effort, so a thread keeps its last level.
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
        // Only after turn/start accepted the input may the receipt claim delivery.
        if (commitVolatile) commitVolatile();
        releaseSlot();
      } catch (e) {
        const failure = e instanceof Error ? e : { text: String(e) };
        const raw = e instanceof Error ? e.message : String(e);
        const refused = chatgptTurn && loginMark() !== null && codexSignInRefused({ message: raw });
        const message = refused ? codexSignInExpired(raw) : codexUserError(raw, route);
        const needsAuth = refused || /(?:\b401\b|unauthorized|missing bearer|authentication required)/i.test(raw);
        const verdict = classifyError(failure);
        if (!state.settled && !abandoned && !recoveredMissingSession && !stopRequested && !needsAuth && verdict.transient && attempt < RETRY_MAX_ATTEMPTS - 1 && state.sawStreamDelta === false) {
          return relaunch(verdict.reason, message, "rpc_error");
        }
        if (!state.settled && !abandoned) {
          if (refused) loginRefused();
          emit({
            ...base(threadId, turnId),
            type: "runtime.error",
            message,
            ...(needsAuth ? { setup: true } : codexLimitFacts(raw, route)),
          });
          await settle(false, needsAuth ? "auth_required" : verdict.reason === "provider_safety" ? "provider_safety" : "rpc_error");
        }
      }
    };

    void launchAttempt(0).catch(prelaunchFailed);
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
    const previousCliVersion = modelsCliVersion;
    modelsCliVersion = version;
    if (previousCliVersion !== null && previousCliVersion !== version) await refreshModels();
    const authenticated = await codexLoginStatus(config.cli, env) === "signed-in";
    if (authenticated && loginRejected()) {
      return { state: "available", version, authenticated: false, reason: CODEX_SIGN_IN_EXPIRED,
        update: await codexReleaseUpdate(version, config.cli), billing: "subscription" };
    }
    const email = authenticated ? await codexAccountEmail(config.cli, env) : null;
    return {
      state: "available",
      version,
      authenticated,
      ...(email ? { account: { email } } : {}),
      update: await codexReleaseUpdate(version, config.cli),
      billing: "subscription",
    };
  };

  /** The background one-shot: `codex exec` with no tools or session, in an empty folder. Never
   * generateText, or titles and compaction would each start a Codex process. */
  const generateMemoryText = async (prompt: string, options: TextGenerationOptions = {}): Promise<string> => {
    if (officeExecution) throw new Error("Office execution disables unrequested background model calls.");
    if (startupModelRefresh) await startupModelRefresh;
    if (disposed) throw new Error("This provider was removed.");
    if (planUnavailable) throw new Error(planUnavailable);
    const env = childEnv();
    let providerArgs: string[] = [];
    if (planAuth) {
      if (planSigningOut) throw new Error("This ChatGPT account is being disconnected.");
      if (!models.options.length) await refreshModels();
      env.OPENMAUSBOT_CHATGPT_TOKEN = await planAuth.accessToken();
      if (planSigningOut || disposed) throw new Error("This ChatGPT account is being disconnected.");
      mkdirSync(join(planDirectory, "codex"), { recursive: true, mode: 0o700 });
      providerArgs = chatgptPlanCodexArgs();
    } else if (config.managed) {
      if (!input.environment.OPENMAUSBOT_COMPANY_API_KEY || !input.environment.CODEX_HOME) {
        throw new Error("Company model access is unavailable. Reconnect your organization; personal billing will not be used.");
      }
      providerArgs = managedCodexArgs(config.managed);
    }
    const route = codexBackgroundRoute(models, smallModelsUsable(), options.fallback);
    if (!route) throw new Error("Codex lists no model for background calls. Refresh models in Settings → Model providers → Codex.");
    return runCodexBackgroundRoute(route, (id) => {
      const selection = planAuth || config.managed ? { model: id, modelProvider: null } : decodeCodexSelection(id);
      return runCodexOneShot({
        spawn: spawnCli, kill: killCliTree, cli: config.cli, env, prompt, options,
        model: selection.model ?? id,
        modelProvider: selection.modelProvider,
        providerArgs: planAuth || config.managed ? providerArgs : codexLocalProviderArgs(env, id),
        describeError: (message) => codexUserError(message, planAuth ? "plan" : selection.modelProvider === OFFICIAL_CODEX_PROVIDER ? "own" : "other"),
      });
    }, options);
  };

  return {
    instanceId,
    driverKind: DRIVER_KIND,
    displayName: input.displayName,
    enabled: input.enabled,
    get models() {
      return models;
    },
    quickModelsUsable: smallModelsUsable,
    refreshModels,
    ...(startupModelRefresh ? { startupModelRefresh } : {}),
    generateMemoryText,
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
        guestTurns: "confined",
        queueing: true,
        computerMcp: true,
        localComputerMcp: true,
        composioMcp: true,
        agentsMcp: true,
      customMcp: true,
        phoneMcp: true,
        browserMcp: true,
        dataMcp: true, highlevelMcp: true,
        images: true,
        nativeImageInput: true,
        effortLevels: ["low", "medium", "high", "xhigh", "max"],
        strictResume: true,
        engineAdmission: true,
      },
      sendTurn,
      interruptTurn: async (threadId, turnId) => {
        const current = active.get(threadId);
        if (current && (turnId === undefined || current.turnId === turnId)) {
          const stopped = await current.stop();
          if (current.office && !stopped) throw new Error("The native Codex process stop is unconfirmed; this office attempt remains blocked.");
        }
      },
      steer: async (threadId, text) => {
        const turn = active.get(threadId);
        return turn?.steer ? await turn.steer(text) : "refused";
      },
      respondToRequest: async (threadId, requestId, decision) => {
        const turn = active.get(threadId);
        const finish = turn?.asks.get(requestId);
        if (!finish) return "unavailable";
        return (await finish(decision.behavior, decision.message, "user"))
          ?? (decision.behavior === "allow" ? "allowed-once" : decision.behavior === "answer" ? "answered" : "rejected");
      },
      hasSession: (threadId) => active.has(threadId),
      stopAll: async () => {
        await Promise.all([...active.values()].map(async (turn) => {
          if (!await turn.stop() && turn.office) throw new Error("The native Codex process stop is unconfirmed; this office attempt remains blocked.");
        }));
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
      await Promise.all([...active.values()].map(async (turn) => {
        if (!await turn.stop() && turn.office) throw new Error("The native Codex process stop is unconfirmed; this office attempt remains blocked.");
      }));
      listeners.clear();
    },
  };
},
};
