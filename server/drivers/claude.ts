// Claude driver — upstream ClaudeDriver skeleton over agentcal's
// drivers/claude.js runtime (stream-json both directions, prompt over
// stdin, completion from a real `result` event — verified against
// claude 2.1.211 by agentcal). Per-turn CLI process; the conversation
// continues across turns via --resume <sessionId> (the resumeCursor).
//
// Integrations become MCP servers on the CLI:
//   - Composio Sessions (connected apps → tools) over streamable HTTP
//   - the bot's cloud computer (boat.dev) via server/computer-proxy.ts
//     — screenshot/exec/open_url, the CUA-on-the-boat bridge
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, dirname, isAbsolute, normalize } from "node:path";

import { DATA_DIR, stripWorkspaceCredentialEnv } from "../config.ts";
import { writeFileAtomic } from "../atomic.ts";
import { augmentedPath } from "../env-path.ts";
import { brokerSocketPath, describeSpawnFailure, execCli, killCliTree, spawnCli } from "../procs.ts";
import { classifyResumeFailure, mayReplay, recoveryPromptFor } from "../resume-recovery.ts";
import { ClaudeLoginController } from "./claude-login-auth.ts";

import type {
  DriverCreateInput,
  ModelCatalog,
  ProviderDriver,
  ProviderInstance,
  ProviderSnapshot,
  RuntimeEvent,
  RuntimeEventListener,
  SendTurnInput,
  SteerOutcome,
  TextGenerationOptions,
} from "../contracts.ts";
import { gateServer, resultBudget } from "../mcp-gate-config.ts";
import { newEventId, newId } from "../contracts.ts";
import { askInputSummary, commandSummary, toolDetailPreview } from "../tool-summary.ts";
import { classifyError, computeBackoff, interruptibleDelay, RETRY_MAX_ATTEMPTS } from "./retry.ts";
import { sessionIdlePolicy } from "./session-idle.ts";
import { parseVersionTriple, versionAtLeast } from "./acp/core.ts";
import {
  applyClaudeInject,
  decodeInjectId,
  mergeLocalInject,
  probeLocalInjects,
  resolveInjectId,
} from "./local-inject.ts";
import { appendNative } from "./native.ts";
import { permissionCommand, permissionLaunchCwd } from "./permission-command.ts";
import { SPAWNED_PROXIES } from "../proxy-paths.ts";
import { extractMcpImages } from "../mcp-tool-images.ts";
import {
  ASK_USER_QUESTION_TOOL,
  askQuestionSummary,
  parseAskQuestions,
  parseChoices,
  questionChoices,
  type AskQuestion,
} from "../../shared/ask-question.ts";

/** Whether `claude` has been signed in.
 *
 * Credential storage is deliberately not inspected here. Claude Code uses the
 * macOS Keychain for OAuth, a JSON file on some platforms, and may gain other
 * backends over time. Presence checks also accept stale credentials. The CLI's
 * own machine-readable auth command is the source of truth for every backend.
 */
function claudeAuthStatus(
  cli: string,
  env: NodeJS.ProcessEnv,
  run: typeof execCli = execCli,
): Promise<{ authenticated: boolean; account?: ProviderSnapshot["account"] }> {
  return new Promise((resolve) => {
    run(cli, ["auth", "status", "--json"], { timeout: 8000, maxBuffer: 65_536, env }, (_error, stdout) => {
      try {
        const status: unknown = JSON.parse(stdout);
        if (!status || typeof status !== "object" || !("loggedIn" in status) || status.loggedIn !== true) {
          return resolve({ authenticated: false });
        }
        // Only display identity fields, never the CLI's full auth response.
        const identity = status as { email?: unknown; orgName?: unknown; authMethod?: unknown };
        const boundedText = (value: unknown, max: number): string | undefined =>
          typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\p{Cc}\p{Cf}]/u.test(value)
            ? value.trim() : undefined;
        const candidateEmail = boundedText(identity.email, 254);
        const email = candidateEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidateEmail) ? candidateEmail : undefined;
        const organization = boundedText(identity.orgName, 160);
        // An API key is a workspace decision, not a person: say so instead
        // of showing an empty identity.
        const account = {
          ...(email ? { email } : {}),
          ...(organization ? { organization } : {}),
          ...(identity.authMethod === "api_key" ? { method: "api-key" as const } : {}),
        };
        resolve({ authenticated: true, ...(Object.keys(account).length ? { account } : {}) });
      } catch {
        resolve({ authenticated: false });
      }
    });
  });
}

export async function claudeSignedIn(
  cli: string,
  env: NodeJS.ProcessEnv,
  run: typeof execCli = execCli,
): Promise<boolean> {
  return (await claudeAuthStatus(cli, env, run)).authenticated;
}

/** Parent-session credentials/routing that a named account must not inherit.
 * Shared with terminal sign-in instructions so login and turns select alike. */
export const CLAUDE_ACCOUNT_ENV_KEYS = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
  "CLAUDE_CODE_OAUTH_SCOPES",
  "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
  "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
] as const;

/** Resolve the CLI's config location without changing HOME or Keychain. */
export function resolveClaudeConfigDir(configDir?: string, env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME || env.USERPROFILE || homedir();
  const configured = configDir?.trim() || env.CLAUDE_CONFIG_DIR?.trim() || join(home, ".claude");
  const expanded = configured === "~" ? home : configured.startsWith("~/") ? join(home, configured.slice(2)) : configured;
  if (!isAbsolute(expanded) || /[\p{Cc}\p{Cf}]/u.test(expanded)) {
    throw new Error("claude: configDir must be an absolute path or start with ~/");
  }
  return normalize(expanded);
}

/** Whether a stream frame is the CLI reporting that it has no login.
 *
 * The CLI flags its own api-error frames (`error`, `is_api_error_message`);
 * a model reply never carries them. Requiring that flag first is what keeps
 * an answer that merely discusses being logged out from being read as a
 * failure — the text classifier runs only once the CLI has already called
 * the frame an error, and covers CLI builds that flag the frame without
 * naming the reason.
 */
export function claudeAuthFailure(
  frame: { error?: unknown; is_api_error_message?: unknown },
  text: string,
): boolean {
  if (frame.is_api_error_message !== true && typeof frame.error !== "string") return false;
  return frame.error === "authentication_failed" || classifyError({ text }).reason === "auth";
}

/** A model newer than the installed Claude Code: the API refuses it and the
 * CLI relays that as an api-error frame ("Claude Code 2.1.268 does not
 * support this model; version 2.1.280 or newer is required. Run 'claude
 * update'…"). It names no model, so it covers every model it happens for.
 * Like a signed-out turn, it is fixed by changing the install, not by a
 * retry, so the UI offers to run the update. */
export function claudeVersionTooOld(
  frame: { error?: unknown; is_api_error_message?: unknown },
  text: string,
): boolean {
  if (frame.is_api_error_message !== true && typeof frame.error !== "string") return false;
  return /\bClaude Code v?\d+(?:\.\d+)+ does not support this model\b/i.test(text);
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
  configDir?: string,
  instanceEnvironment: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source, PATH: augmentedPath(), NPM_CONFIG_LOGLEVEL: "error" };
  if (configDir?.trim()) {
    env.CLAUDE_CONFIG_DIR = resolveClaudeConfigDir(configDir, env);
    for (const key of CLAUDE_ACCOUNT_ENV_KEYS) {
      // Explicit custom endpoint settings still work; subscription OAuth
      // always belongs to this account's CLI-managed login, never its parent.
      if (key.startsWith("CLAUDE_CODE_OAUTH_") || key.endsWith("_FILE_DESCRIPTOR") || !Object.hasOwn(instanceEnvironment, key)) {
        delete env[key];
      }
    }
  } else if (env.CLAUDE_CONFIG_DIR) {
    env.CLAUDE_CONFIG_DIR = resolveClaudeConfigDir(undefined, env);
  }
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  // The harness process may hold workspace credentials (xai/box/voice keys,
  // env-injected at boot); none of them are this CLI's to see.
  stripWorkspaceCredentialEnv(env);
  const applied = applyClaudeInject(env, model);
  // A key set on purpose for this workspace (Settings → API keys, carried
  // in the instance environment) stays. One riding along in the parent's
  // env never does: it would flip a subscription login to pay-as-you-go.
  if (!applied.injected && !instanceEnvironment.ANTHROPIC_API_KEY) delete env.ANTHROPIC_API_KEY;
  return env;
}

/** Escape hatch back to the pre-isolation launch, where a bot inherited this
 * machine's Claude Code setup: its MCP servers and connectors, skills,
 * agents, hooks and personal CLAUDE.md. Set it only to recover a bot that
 * genuinely depended on a user- or local-scope MCP server; the supported way
 * to give a bot a server is the app's own `mcpServers` config or the bot
 * project's `.mcp.json`. */
function inheritsUserConfig(env: NodeJS.ProcessEnv): boolean {
  return env.OMB_CLAUDE_INHERIT_USER_CONFIG === "1";
}

/** The Engines-page warning while the escape hatch is set. The flag is a
 * footgun: it is invisible once exported, and what it costs — every Claude
 * bot re-reading this machine's own servers, skills, hooks and CLAUDE.md on
 * every model call — shows up only on the bill. Naming it where the person
 * looks when something is off is the whole point. */
export function claudeInheritWarning(env: NodeJS.ProcessEnv): ProviderSnapshot["warning"] | undefined {
  if (!inheritsUserConfig(env)) return undefined;
  return {
    title: "Bots inherit this machine's Claude Code setup",
    message:
      "OMB_CLAUDE_INHERIT_USER_CONFIG=1 is set on the OpenMausBot process, so every Claude bot also loads this " +
      "computer's own MCP servers, connectors, skills, hooks and personal CLAUDE.md on every turn — often thousands " +
      "of extra tokens per model call, and tools nobody gave the bot. Unless a bot genuinely needs a server from " +
      "your user-scope Claude config, remove the variable and restart; add the server under Settings → MCP servers " +
      "or the bot project's .mcp.json instead.",
  };
}

/** Retain the selected CLI account's authentication without importing its
 * hooks, permissions, MCP servers or personal instructions. Explicit OMB
 * connections/local endpoints own their entire routing + credential pair. */
export function readClaudeAuthSettings(
  env: NodeJS.ProcessEnv,
  instanceEnvironment: NodeJS.ProcessEnv = {},
): { env?: Record<string, string>; apiKeyHelper?: string } {
  if (CLAUDE_ACCOUNT_ENV_KEYS.some((key) => instanceEnvironment[key])) return {};
  try {
    const settings = JSON.parse(readFileSync(join(resolveClaudeConfigDir(undefined, env), "settings.json"), "utf8"));
    const authEnv: Record<string, string> = {};
    for (const key of CLAUDE_ACCOUNT_ENV_KEYS) {
      if (!key.endsWith("_FILE_DESCRIPTOR") && typeof settings?.env?.[key] === "string") {
        authEnv[key] = settings.env[key];
      }
    }
    return {
      ...(Object.keys(authEnv).length ? { env: authEnv } : {}),
      ...(typeof settings?.apiKeyHelper === "string" && settings.apiKeyHelper.trim()
        ? { apiKeyHelper: settings.apiKeyHelper } : {}),
    };
  } catch {
    return {};
  }
}

/** MCP servers the bot's own project declares in `<cwd>/.mcp.json`.
 *
 * The CLI would find this file itself, but the harness launches it with
 * --strict-mcp-config, which makes the harness's config the only source.
 * The project file IS part of the bot's definition (its cwd is chosen per
 * bot), so it is forwarded verbatim — including `type: "http"`/`"sse"`
 * entries the harness never mounts itself, because the CLI, not this code,
 * is what has to understand them. A malformed file is ignored rather than
 * failing the turn: an unreadable project config must not brick a bot. */
function projectMcpServers(cwd: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(cwd, ".mcp.json"), "utf8"));
  } catch {
    return {};
  }
  const servers = (parsed as { mcpServers?: unknown } | null)?.mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return {};
  const out: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(servers as Record<string, unknown>)) {
    if (server && typeof server === "object" && !Array.isArray(server)) out[name] = server;
  }
  return out;
}

/** The CLI compacts its own session when it approaches a window. Left alone
 * that window is the model's, so a Sonnet 5 session runs to something near a
 * million tokens before anything happens — and every model call until then
 * re-reads the whole thing. The measured food-ordering thread sat at 330k
 * tokens per call and looked perfectly healthy to the CLI.
 *
 * So the harness picks the window instead. This delegates the actual
 * compaction to the CLI, which owns the session and already has a summarizer
 * for it; the harness only decides when it is worth paying for.
 *
 * OMB_CLAUDE_AUTOCOMPACT takes a token count, "auto" to hand the decision
 * back to the CLI, or "off" to pass nothing at all. The CLI rejects a window
 * outside 100k-1M as a hard argument error, so a configured value is clamped
 * rather than passed through: a mistyped setting must not fail every turn. */
export function autoCompactWindow(env: NodeJS.ProcessEnv): string | null {
  const raw = (env.OMB_CLAUDE_AUTOCOMPACT ?? "").trim().toLowerCase();
  if (raw === "off") return null;
  if (raw === "auto") return "auto";
  const parsed = raw ? Number(raw) : DEFAULT_AUTOCOMPACT_TOKENS;
  if (!Number.isFinite(parsed) || parsed <= 0) return String(DEFAULT_AUTOCOMPACT_TOKENS);
  return String(Math.min(1_000_000, Math.max(100_000, Math.floor(parsed))));
}

/** Generous for real work, and still a third of where a 1M-window session
 * would otherwise get to. With bot tool results gated (mcp-gate.ts) most
 * threads never reach it; this is the backstop for the ones that do. */
const DEFAULT_AUTOCOMPACT_TOKENS = 200_000;

/** The Claude CLI version that first accepted each flag the harness passes
 * for context control. An unknown flag is a hard argument error, so passing
 * one to an older CLI would fail every turn rather than degrade; each flag
 * is therefore only passed to a CLI known to accept it.
 *
 * Verified against the published binaries, not the changelog (which never
 * records `--autocompact`): `--strict-mcp-config` is present in 1.0.60 and
 * absent from 1.0.0; `--setting-sources` first appears in 1.0.122 (1.0.120
 * lacks it); `--autocompact` first appears in 2.1.122 (2.1.121 lacks it). */
export const CLAUDE_FLAG_FLOORS = {
  "--strict-mcp-config": [1, 0, 60],
  "--setting-sources": [1, 0, 122],
  "--autocompact": [2, 1, 122],
  // 2.1.267 is the first CLI that accepts it; below that the recorded prompt
  // simply is not refreshed, which is the pre-existing behaviour.
  "--system-prompt-snapshot": [2, 1, 267],
  // A guest's turn on a Cloud home (GUEST_CLAUDE_TOOLS): 2.1.248 takes
  // --restricted, 2.1.257 honours blockReadsOutsideWorkingDirectories.
  "--restricted": [2, 1, 257],
} as const satisfies Record<string, ClaudeCliVersion>;

/** The only built-in tools a guest's turn on a Cloud home gets
 * (SendTurnInput.guestConfined): no Bash, PowerShell or WebFetch, so nothing
 * runs a command, and with --restricted plus the settings below every read
 * outside its own folder is refused outright, never asked. Probed against
 * Claude Code 2.1.284 in `default` mode: without this, a built-in list of
 * "read-only" Bash commands runs unasked, and `xargs head` reads any file. */
/** A refusal of a confined turn, and why it is confined (SendTurnInput.confinedWhy). */
const withWhy = (refusal: string, why: string | undefined) => why ? `${refusal} ${why}` : refusal;

export const GUEST_CLAUDE_TOOLS = ["Read", "Grep", "Glob", "Edit", "Write", "WebSearch"] as const;
/** Tools a guest's session must never report in its init frame. */
const GUEST_FORBIDDEN_TOOLS = new Set(["Bash", "PowerShell", "WebFetch", "BashOutput", "KillShell", "KillBash", "NotebookEdit", "Task", "Agent"]);
/** The permission block a guest's session runs under, as a second layer. */
export const GUEST_CLAUDE_PERMISSIONS = {
  blockReadsOutsideWorkingDirectories: true,
  deny: ["Bash", "PowerShell", "WebFetch", "Read(//proc/**)"],
} as const;

export type ClaudeCliVersion = readonly [number, number, number];

/** The newest floor above: a CLI at or past it accepts everything the
 * harness sends. Below it the engine still works, minus the flags the CLI
 * predates, and the Engines page suggests an update. */
export const CLAUDE_CONTEXT_CONTROL_MIN_VERSION: ClaudeCliVersion = CLAUDE_FLAG_FLOORS["--system-prompt-snapshot"];

/** The first CLI this driver has seen echo a stdin user message, with the
 * uuid it was sent with, as a model call takes it in (`--replay-user-messages`,
 * checked on 2.1.282): a steer written during a tool call is echoed right
 * after that tool's result, one written during the turn's last model call
 * only after the turn's `result`, as its own turn starts. That tells a folded
 * steer from one that runs next. Below it, every steer holds its turn's
 * result for the grace. */
export const CLAUDE_REPLAY_FLOOR: ClaudeCliVersion = [2, 1, 282];

/** `claude --version` prints "2.1.232 (Claude Code)"; the first dotted triple
 * is the version. Null when nothing parses, e.g. a wrapper that prints its
 * own banner first — see claudeCliSupports for how that is treated. */
export function parseClaudeCliVersion(stdout: string | null | undefined): ClaudeCliVersion | null {
  return parseVersionTriple(stdout ?? "");
}

/** Whether a CLI reporting `version` accepts `flag`. A version that could
 * not be parsed counts as current: every CLI that predates a floor prints a
 * plain "x.y.z (Claude Code)", so an unreadable version is far more likely
 * a newer wrapper than an old build, and withholding the flags from a modern
 * CLI would silently re-open the context leak this file exists to close. */
export function claudeCliSupports(version: ClaudeCliVersion | null, flag: keyof typeof CLAUDE_FLAG_FLOORS): boolean {
  return version === null || versionAtLeast(version, CLAUDE_FLAG_FLOORS[flag]);
}

/** The Engines-page notice for a CLI older than the newest floor. The engine
 * keeps working without the flags its CLI predates. */
export function claudeCliUpdate(version: string | null, cli: string): ProviderSnapshot["update"] | undefined {
  const parsed = parseClaudeCliVersion(version);
  if (!parsed || versionAtLeast(parsed, CLAUDE_CONTEXT_CONTROL_MIN_VERSION)) return undefined;
  const floor = CLAUDE_CONTEXT_CONTROL_MIN_VERSION.join(".");
  const missing = (Object.keys(CLAUDE_FLAG_FLOORS) as (keyof typeof CLAUDE_FLAG_FLOORS)[])
    .filter((flag) => !claudeCliSupports(parsed, flag));
  const effects = [
    ...(missing.includes("--autocompact") ? ["no compaction window picked by OpenMausBot"] : []),
    ...(missing.includes("--setting-sources") ? ["bots still see this machine's own Claude Code setup"] : []),
    ...(missing.includes("--system-prompt-snapshot") ? ["coordinated resumed turns cannot refresh stale system prompts"] : []),
  ];
  return {
    title: "Update Claude Code for context controls",
    message:
      `Claude Code ${parsed.join(".")} predates ${floor}, so bots run without ${missing.join(", ")}: ` +
      `${effects.join("; ")}. Update it, then refresh Engines.`,
    command: cli === "claude" ? "claude update" : `${cli} update`,
  };
}

const DRIVER_KIND = "claudeAgent";

const NO_ANTHROPIC_KEY = "No Anthropic API key — open Settings → API keys.";

export interface ClaudeConfig {
  cli: string;
  /** Separate CLI-managed login/settings. Empty uses the normal CLI account. */
  configDir?: string;
  /** Company routing is supplied by the private desktop parent, never local discovery. */
  managed?: boolean;
  /** Operator-provided hosted catalog; absent for ordinary desktop accounts. */
  managedModels?: string[];
  permissionMode: "acceptEdits" | "auto" | "bypassPermissions";
  /** Available Claude built-ins. An empty list passes `--tools ""`. */
  tools?: string[];
  /** Claude tool patterns to deny after the available set is selected. */
  disallowedTools?: string[];
  /** Runs only on the workspace Anthropic key (the `claudeApi` instance):
   * unavailable without one, never on a personal login. */
  requireApiKey?: boolean;
}

// model catalog ported from upstream packages/contracts/src/model.ts
export const STATIC_CLAUDE_MODELS: ModelCatalog = {
  default: "claude-sonnet-5",
  options: [
    { id: "claude-fable-5-1", label: "Claude Fable 5.1" },
    { id: "claude-fable-5", label: "Claude Fable 5" },
    { id: "claude-opus-5-5", label: "Claude Opus 5.5", contextWindow: 1_000_000 },
    { id: "claude-opus-5", label: "Claude Opus 5" },
    { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", contextWindow: 1_000_000 },
    { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
    { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
  ],
};

const CLAUDE_MODEL_ID = /^[a-z0-9][a-z0-9._:/-]*$/i;
/** Official Anthropic model ids, e.g. claude-sonnet-5-5 (no host:: inject prefix). */
const OFFICIAL_CLAUDE_ID = /^claude-[a-z0-9.-]+$/;

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

/** Extra ids from ~/.claude/settings.json. Official extraModels stay untagged.
 *  `model` is Claude Code's last-used slug, not a catalog — listing it as
 *  Custom put a non-inject id in the picker and the turn then had no
 *  ANTHROPIC_API_KEY ("Not logged in · Please run /login"). Live injects
 *  come from mergeLocalInject. */
export function readClaudeModelCatalog(env: Record<string, string | undefined> = process.env) {
  // A missing or unreadable settings.json is not fatal: an instance whose
  // environment sets ANTHROPIC_MODEL (a Claude Code install pointed at an
  // Anthropic-compatible host) still lists that model as Custom.
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(readFileSync(join(resolveClaudeConfigDir(undefined, env), "settings.json"), "utf8")) as Record<string, unknown>;
  } catch {
    settings = {};
  }

  const extras = [
    ...extrasFromUnknown(settings.availableModels).map((extra) => ({ ...extra, custom: true })),
    ...extrasFromUnknown(settings.customModels).map((extra) => ({ ...extra, custom: true })),
    ...extrasFromUnknown(settings.extraModels).map((extra) => ({ ...extra, custom: !OFFICIAL_CLAUDE_ID.test(extra.id) })),
  ];
  const nestedEnv = settings.env && typeof settings.env === "object" ? (settings.env as Record<string, unknown>) : {};
  const envModel = nestedEnv.ANTHROPIC_MODEL ?? env.ANTHROPIC_MODEL;
  if (typeof envModel === "string") extras.push(...extrasFromUnknown([envModel]).map((extra) => ({ ...extra, custom: true })));

  const options = STATIC_CLAUDE_MODELS.options.map((option) => ({ ...option }));
  const seen = new Set(options.map((option) => option.id));
  for (const extra of extras) {
    if (seen.has(extra.id)) continue;
    seen.add(extra.id);
    // Only extraModels adds official cloud rows. An explicit endpoint model
    // override stays custom even when its id also appears in that list.
    options.push(extra.custom || extra.id === envModel
      ? { id: extra.id, label: extra.label, custom: true }
      : { id: extra.id, label: extra.label });
  }
  return { default: STATIC_CLAUDE_MODELS.default, options };
}

// Resolved from the server root, never relative to this file: bundling inlines
// this module into an entry one directory up, so a `".."` here would climb too
// far. See server/proxy-paths.ts.
const PERM_PROXY_PATH = SPAWNED_PROXIES.permission;
const DWEB_PROXY_PATH = SPAWNED_PROXIES.dweb;
const HOOK_HELPER_PATH = SPAWNED_PROXIES.hook;
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

/** The structured questions behind an ask, when it is one. Claude's own
 * AskUserQuestion carries them; everything else answers null and keeps the
 * plain summary/choices card. */
function askQuestions(ask: Ask): AskQuestion[] | null {
  return ask.tool === ASK_USER_QUESTION_TOOL ? parseAskQuestions(ask.input) : null;
}

/** One human-readable line for an ask — what the card subtitle shows. */
function askSummary(ask: Ask): string {
  const questions = askQuestions(ask);
  if (questions) return askQuestionSummary(questions);
  return askInputSummary(ask.input) ?? ask.tool ?? "tool";
}

/** One native `result` frame's verdict and figures. A logical turn can span
 * more than one: a user message steered in after the turn's last model call
 * runs as the CLI's next native turn (see STEERED_CONTINUATION_GRACE_MS). */
export interface NativeTurnResult {
  ok: boolean;
  stopReason: string | null;
  cost: number | null;
  usage?: { input: number; output: number; cachedInput?: number };
}

/** A logical turn made of several native turns: any failed half fails it,
 * the last stop reason stands, per-turn token usage adds up, and the cost is
 * the latest figure — the CLI reports total_cost_usd as the process's running
 * total ("cumulative across turns in streaming-input sessions … read the
 * latest result rather than summing", 2.1.282), so adding would double-bill.
 * A figure missing on one side leaves the other side's alone. */
export function sumNativeTurnResults(earlier: NativeTurnResult | null, latest: NativeTurnResult): NativeTurnResult {
  if (!earlier) return latest;
  const usage = earlier.usage && latest.usage
    ? {
        input: earlier.usage.input + latest.usage.input,
        output: earlier.usage.output + latest.usage.output,
        ...(earlier.usage.cachedInput !== undefined || latest.usage.cachedInput !== undefined
          ? { cachedInput: (earlier.usage.cachedInput ?? 0) + (latest.usage.cachedInput ?? 0) }
          : {}),
      }
    : latest.usage ?? earlier.usage;
  return {
    ok: earlier.ok && latest.ok,
    stopReason: latest.stopReason ?? earlier.stopReason,
    cost: latest.cost ?? earlier.cost,
    ...(usage ? { usage } : {}),
  };
}

/** How long after a native `result` the CLI gets to announce, with `init`,
 * the turn it starts for a user message steered in after this turn's last
 * model call. The message is already buffered on its stdin, so this takes
 * milliseconds (about 60 ms on 2.1.282). If nothing comes, the message was
 * folded into one of this turn's model calls after all, and the held result
 * is the turn's: every result with a steer outstanding waits this long. */
export const STEERED_CONTINUATION_GRACE_MS = 2_000;

/** How long a steered continuation may stay silent after its `init` before
 * the driver stops waiting and closes the turn on the held result. 2.1.282
 * follows `init` with a `status` frame within milliseconds and every CLI
 * streams once the model answers; a continuation that never speaks would
 * otherwise keep the turn — and its internal tool pass — open until the
 * stall watchdog. */
export const STEERED_CONTINUATION_SILENCE_MS = 30_000;

/** Tests scale each steer timer on its own, the way FAKE_CLAUDE_RETRY_SCALE
 * scales the retry backoff — a test that shortens the silence bound must not
 * also shorten the grace `init` has to arrive in. Production runs at 1. */
const fakeTimerScale = (name: string) => Number(process.env[name] ?? "1") || 1;
const steerGraceScale = () => fakeTimerScale("FAKE_CLAUDE_STEER_GRACE_SCALE");
const steerSilenceScale = () => fakeTimerScale("FAKE_CLAUDE_STEER_SILENCE_SCALE");

/** Where the hook helper reads this thread's current turn token. Stable per
 * thread (so the CLI's environment can name it once) and private. */
export function hookTokenFile(threadId: string, botId?: string): string {
  const digest = createHash("sha256").update(`${botId ?? ""}\0${threadId}`).digest("hex").slice(0, 24);
  return join(DATA_DIR, "hook-tokens", `${digest}.token`);
}

/** The `hooks` block for the private --settings file: one command for each
 * event the harness observes. Claude Code runs it with the event JSON on
 * stdin and applies any hookSpecificOutput it prints. The command string is
 * a shell line, so both paths are quoted (this repo's own path has a space). */
export function claudeHookSettings(helperPath: string): Record<string, unknown> {
  // JSON quoting is not shell quoting: $(), backticks and $names still
  // expand inside double quotes on POSIX. Windows paths come through env
  // variables so their backslashes are not JSON-escaped into the command.
  const command = process.platform === "win32"
    ? '"%OMB_HOOK_NODE%" "%OMB_HOOK_HELPER%"'
    : [process.execPath, helperPath].map(path => `'${path.replace(/'/g, "'\\''")}'`).join(" ");
  const entry = [{ matcher: "", hooks: [{ type: "command", command, timeout: 5 }] }];
  return { PostToolUse: entry, PreCompact: entry, SessionStart: entry, Stop: entry };
}

export function permissionSocketPath(threadId: string, botId?: string) {
  // A readable prefix alone is not unique: ids that agree on their first
  // characters ("t-perm-dup-1", "t-perm-dup-2") would share a socket. POSIX
  // hides that — a new broker's listen replaces the socket FILE, so the name
  // always points at the fresh server — but Windows named pipes live in a
  // global namespace that is never unlinked, and a reused name races the
  // previous broker's async teardown. Half the tag is a digest of the FULL
  // id so distinct threads get distinct sockets; the tag stays at 8 chars
  // total because the POSIX path already brushes the 104-byte sun_path
  // limit under deep tmp home dirs.
  //
  // botId is folded into the digest too (#1017): the driver's session/broker
  // maps are a single process-wide table keyed on threadId alone, so a
  // delegated child turn whose threadId ever coincides with its still-open
  // parent's (or any other bot's) would otherwise collide on the exact same
  // socket. Namespacing by bot makes that collision structurally impossible
  // regardless of how two turns end up sharing a threadId.
  const key = botId ? `${botId}\0${threadId}` : threadId;
  const prefix = threadId.replace(/[^\w-]/g, "").slice(0, 4);
  const digest = createHash("sha256").update(key).digest("hex").slice(0, 4);
  return brokerSocketPath(DATA_DIR, `${prefix}${digest}`);
}

/** Paths the broker may bind, tried in order. Windows named pipes are never
 * unlinkable, and a hung CLI child from an earlier server process can hold a
 * name for minutes, so fresh suffixes let the new broker bind immediately.
 * POSIX gets a short temp fallback because macOS rejects Unix socket paths
 * longer than its small `sun_path` limit; a deep test HOME or long username
 * can otherwise make every approval silently unavailable. The proxy learns
 * the actual bound path from its argv, so either fallback is transparent. */
export function brokerSocketCandidates(threadId: string, botId?: string): string[] {
  const base = permissionSocketPath(threadId, botId);
  if (process.platform !== "win32") {
    const scope = createHash("sha256")
      .update(`${DATA_DIR}\0${process.pid}\0${botId ?? ""}\0${threadId}`)
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
    { ask: Ask; finish: (behavior: AskBehavior, message: string | undefined, source: AskResolutionSource, always?: boolean) => void }
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
        const finish = (behavior: AskBehavior, message: string | undefined, source: AskResolutionSource, always?: boolean) => {
          if (!pending.delete(askId)) return;
          clearTimeout(timer);
          try {
            // `always` rides to the proxy, which hands the CLI's own suggested
            // permission rules back as updatedPermissions: Claude remembers
            // the allow for the session, the harness remembers nothing.
            // `source` travels with the answer too: a proxy that cannot tell
            // the human's words from a timeout note would file the timeout
            // note as the human's words.
            conn.write(
              JSON.stringify({ t: "answer", id: askId, behavior, message, source, ...(always ? { always: true } : {}) }) + "\n",
            );
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
    for (const p of Array.from(pending.values())) {
      const { behavior, message } = systemEndedReply(p.ask.kind);
      p.finish(behavior, message, "system");
    }
  };
  return {
    answer(askId: string, behavior: AskBehavior, message?: string, always?: boolean): boolean {
      const p = pending.get(askId);
      if (!p) return false;
      if (p.ask.kind === "question" ? behavior !== "answer" : behavior === "answer") return false;
      p.finish(behavior, message, "user", always && behavior === "allow");
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
  if (o.configDir !== undefined && typeof o.configDir !== "string") throw new Error("claude: configDir must be a string");
  const configDir = typeof o.configDir === "string" ? o.configDir.trim() : undefined;
  if (configDir) resolveClaudeConfigDir(configDir);
  if (o.managedModels !== undefined && (o.managed !== true || !Array.isArray(o.managedModels) || !o.managedModels.length || o.managedModels.some(model => typeof model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(model)))) throw new Error("Invalid hosted Claude models.");
  return {
    cli: typeof o.cli === "string" ? o.cli : "claude",
    ...(configDir ? { configDir } : {}),
    ...(o.managed === true ? { managed: true } : {}),
    ...(o.managedModels ? { managedModels: o.managedModels as string[] } : {}),
    permissionMode: (mode as ClaudeConfig["permissionMode"]) ?? "acceptEdits",
    ...(tools !== undefined ? { tools } : {}),
    ...(disallowedTools !== undefined ? { disallowedTools } : {}),
    ...(o.requireApiKey === true ? { requireApiKey: true } : {}),
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

/** A turn's own cost from the CLI's total_cost_usd, which is not a per-turn
 * figure: it is "cumulative across turns in streaming-input sessions — each
 * result carries the running total so far" (2.1.282), and a retained process
 * runs turn after turn. So a turn costs the growth since the total its
 * process reported for the turn before — or, for a process's first turn,
 * since the total the CLI restored on --resume (see restoredCostBase). With
 * no known start (null) the turn keeps its whole figure. A total that went
 * down is not the same count, so it is taken whole too rather than booked as
 * a negative cost. Rounding to 1e-10 USD removes only the float noise of the
 * subtraction. */
export function turnCostFromRunningTotal(total: number | null, previous: number | null): number | null {
  if (total === null) return null;
  if (previous === null || total < previous) return total;
  return Number((total - previous).toFixed(10));
}

/** One running cost state, read from a `result`: total_cost_usd and, per
 * model, the [input, cache read, cache write, output] tokens of modelUsage.
 * Both count the whole session so far, including anything --resume restored. */
export interface ClaudeCostSnapshot {
  total: number;
  models: Record<string, [number, number, number, number]>;
}

export function claudeCostSnapshot(total: unknown, modelUsage: unknown): ClaudeCostSnapshot | null {
  if (typeof total !== "number" || !Number.isFinite(total)) return null;
  const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  const models: ClaudeCostSnapshot["models"] = {};
  if (modelUsage && typeof modelUsage === "object" && !Array.isArray(modelUsage)) {
    for (const [model, raw] of Object.entries(modelUsage as Record<string, unknown>)) {
      if (!raw || typeof raw !== "object") continue;
      const u = raw as Record<string, unknown>;
      models[model] = [count(u.inputTokens), count(u.cacheReadInputTokens), count(u.cacheCreationInputTokens), count(u.outputTokens)];
    }
  }
  return { total, models };
}

/** The running total a resumed session already carried before this
 * process's first turn. On --resume the CLI (2.1.282) restores the session's
 * cost from an earlier state — not always the latest one this driver saw —
 * so that turn's total_cost_usd and modelUsage include the earlier turns.
 * The restored state is the earlier state that sits inside the new counts
 * and leaves exactly this turn's own usage: in one model (usage leaves out
 * side calls such as a Haiku title) or summed over all models (a turn split
 * between two); nothing restored is 0. When no state fits exactly — the CLI
 * saved work that never reported a result, like an interrupted turn — the
 * latest state inside the new counts stands, so that work is booked once,
 * with this turn. Either way the latest state wins, not the highest total:
 * a resume that went back to an older state leaves later, lower totals. */
export function restoredCostBase(
  earlier: readonly ClaudeCostSnapshot[],
  current: ClaudeCostSnapshot,
  usage: { input: number; cacheRead: number; cacheWrite: number; output: number },
): number {
  const turn = [usage.input, usage.cacheRead, usage.cacheWrite, usage.output];
  const nothing: ClaudeCostSnapshot = { total: 0, models: {} };
  let exact: number | null = null;
  let inside = 0;
  // oldest first: the session's states in the order they were recorded
  for (const state of [nothing, ...earlier]) {
    const within = Object.entries(state.models).every(([model, counts]) =>
      counts.every((n, i) => n <= (current.models[model]?.[i] ?? 0)));
    if (!within) continue;
    inside = state.total;
    const growth = Object.entries(current.models).map(([model, counts]) =>
      counts.map((n, i) => n - (state.models[model]?.[i] ?? 0)));
    const isTurn = (counts: number[]) => counts.every((n, i) => n === turn[i]);
    const summed = turn.map((_, i) => growth.reduce((sum, counts) => sum + counts[i]!, 0));
    if (growth.some(isTurn) || isTurn(summed)) exact = state.total;
  }
  return exact ?? inside;
}

/** Each Claude session's latest cost states, so the first turn after a
 * --resume can tell what the CLI restored — after an app restart too. Small
 * by design: a few states for the most recent sessions. */
const COST_HISTORY_FILE = join(DATA_DIR, "claude-cost-history.json");
const COST_HISTORY_SESSIONS = 100;
const COST_HISTORY_STATES = 8;

function isCostSnapshot(value: unknown): value is ClaudeCostSnapshot {
  if (!value || typeof value !== "object") return false;
  const { total, models } = value as { total?: unknown; models?: unknown };
  return typeof total === "number" && !!models && typeof models === "object" &&
    Object.values(models).every((counts) => Array.isArray(counts) && counts.length === 4 && counts.every((n) => typeof n === "number"));
}

function readCostHistory(): Record<string, ClaudeCostSnapshot[]> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(COST_HISTORY_FILE, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).map(([id, states]) => [id, Array.isArray(states) ? states.filter(isCostSnapshot) : []]));
  } catch {
    return {};
  }
}

function recordCostState(sessionId: string, state: ClaudeCostSnapshot): void {
  const history = readCostHistory();
  const states = [...(history[sessionId] ?? []), state].slice(-COST_HISTORY_STATES);
  // most recent session last, so the oldest ones are dropped first
  delete history[sessionId];
  history[sessionId] = states;
  const ids = Object.keys(history);
  for (const id of ids.slice(0, Math.max(0, ids.length - COST_HISTORY_SESSIONS))) delete history[id];
  try {
    writeFileAtomic(COST_HISTORY_FILE, JSON.stringify(history), { mode: 0o600 });
  } catch {
    // a lost state only means a later resume keeps its whole figure
  }
}

type ClaudeImage = NonNullable<SendTurnInput["images"]>[number];
type ClaudeUserContent =
  | { type: "image"; source: { type: "base64"; media_type: ClaudeImage["mime"]; data: string } }
  | { type: "text"; text: string };
type ClaudeUserMessage = {
  type: "user";
  /** echoed back with --replay-user-messages; set on steers */
  uuid?: string;
  message: { role: "user"; content: string | ClaudeUserContent[] };
};

/** Claude's stream-json input accepts the same image source blocks as the
 * Anthropic Messages API. Keep the old string form for text-only turns so a
 * CLI update cannot disturb the overwhelmingly common path. */
/** How a mid-session change to the volatile half of the system prompt
 * reaches a model whose process was launched with the old copy. The CLI's
 * own out-of-band convention inside a user turn, and it costs one short
 * append rather than a relaunch that re-uploads the whole prompt cache. */
function withVolatileNote(text: string, volatile: string): string {
  const body = volatile.trim()
    ? `This part of your instructions changed since this session started. It replaces the earlier copy:\n\n${volatile.trim()}`
    : "The notes that were in your instructions when this session started have been cleared.";
  const note = `<system-reminder>\n${body}\n</system-reminder>`;
  return text ? `${note}\n\n${text}` : note;
}

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
    const environment = (model?: string | null) =>
      claudeEnvironment(config.managed ? undefined : model, { ...process.env, ...input.environment }, config.configDir, input.environment);
    const catalogEnv = environment();
    // Say it once where a headless or source run reads its logs; the Engines
    // page carries the same warning for the desktop (claudeInheritWarning).
    if (inheritsUserConfig(catalogEnv)) {
      console.error(`claude (${instanceId}): OMB_CLAUDE_INHERIT_USER_CONFIG=1 — bots inherit this machine's Claude Code MCP servers, skills, hooks and CLAUDE.md on every turn; remove it unless a bot needs a user-scope server`);
    }
    let models = config.managedModels ? { default: config.managedModels[0], options: config.managedModels.map(id => ({ id, label: id })) } : STATIC_CLAUDE_MODELS;
    const refreshModels = async () => {
      if (config.managed) return;
      try {
        const resolved = await mergeLocalInject(readClaudeModelCatalog(catalogEnv), catalogEnv);
        if (resolved.options.length) models = resolved;
      } catch {
        // Keep the last usable catalog when settings.json is unreadable.
      }
    };
    await refreshModels();

    // The installed CLI's version as snapshot() last read it, so a flag the
    // CLI does not know is never passed to it (CLAUDE_FLAG_FLOORS). The
    // harness snapshots every instance whenever it describes them — app
    // load, the Engines page, and right after `claude update`, which is
    // exactly when the answer changes — so a turn normally finds it filled.
    // Most turns before any snapshot assume a current CLI. A coordinated
    // turn checks first because the snapshot-refresh flag is newer than the
    // other context controls and an unknown flag would reject that request.
    let cliVersion: ClaudeCliVersion | null = null;
    let cliVersionChecked = false;
    // Whether `claude --help` lists --autocompact, read once per CLI version
    // by snapshot(). The flag is not in every build above its version floor
    // (2.1.129 rejects it), so the listing wins over the floor; null until
    // probed, or when the probe fails.
    let cliHasAutocompact: boolean | null = null;
    let cliHelpVersion: string | null = null;
    const readCliVersion = (env: NodeJS.ProcessEnv): Promise<string | null> =>
      new Promise((resolve) => {
        execCli(config.cli, ["--version"], { timeout: 8000, env }, (err, stdout) =>
          resolve(err ? null : stdout.trim() || null),
        );
      });
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
      /** the volatile half of the system prompt this process was launched
       * with (see SendTurnInput.systemVolatile). A later turn whose volatile
       * text differs delivers the difference in-turn rather than relaunching. */
      volatile: string;
      /** the CLI's session id from `init`, what --resume takes later */
      sessionId: string | null;
      /** the CLI emitted its `init` frame — it accepted the session and
       * began the turn. The acceptance boundary for --resume: before it,
       * nothing was submitted and the turn has caused nothing. */
      sawInit: boolean;
      /** the permission mode `init` says the session actually runs in. The
       * CLI takes `--permission-mode auto` for any model and starts in
       * "default" without a word when auto mode is unavailable (Haiku 4.5,
       * Sonnet 4.5, an org that disabled it), so the flag we passed is not
       * the truth — this is. null until init, or on a CLI that omits it. */
      nativePermissionMode: string | null;
      /** launched with --replay-user-messages (see CLAUDE_REPLAY_FLOOR) */
      replaysUserMessages: boolean;
      /** the running turn, or null between turns */
      turn: {
        turnId: string;
        input: SendTurnInput;
        retryAbort: AbortController;
        settled: boolean;
        sawStreamDelta: boolean;
        authFailed?: boolean;
        updateRequired?: boolean;
        stopRequested?: boolean;
        /** Steered messages, by the uuid this driver sent them with, that no
         * model call has taken in yet as far as the driver can tell. With
         * --replay-user-messages the CLI echoes each one as a call takes it
         * in; without it, nothing the CLI prints says whether a steer was
         * folded in or runs next, so each one counts until a result holds on
         * it. A `result` with any left is held (see the `result` handling). */
        pendingSteers: Set<string>;
        /** Native results already produced by this logical turn, held while
         * a steered continuation is expected; summed into `turn.completed`. */
        deferred: NativeTurnResult | null;
        /** Armed after a held result: the CLI announces the continuation with
         * `init` within milliseconds, or never — then the held result stands. */
        continuationGrace: ReturnType<typeof setTimeout> | null;
        /** (Re)starts that grace; set with it. A steer that lands while it
         * runs restarts it, so each queued message gets the whole grace. */
        armGrace?: () => void;
        /** Armed by the continuation's `init`: a frame of any other kind must
         * follow within STEERED_CONTINUATION_SILENCE_MS, or the held result stands. */
        continuationSilence: ReturnType<typeof setTimeout> | null;
      } | null;
      idleTimer: ReturnType<typeof setTimeout> | null;
      closing: boolean;
      stderr: string;
      /** The CLI's running total that the next turn's cost is measured from
       * (see turnCostFromRunningTotal): what --resume restored until the
       * first turn settles, then the last settled turn's total_cost_usd.
       * undefined until the first result; null when the start is unknown. */
      costTotal: number | null | undefined;
      /** Root close can precede a failed group stop; retry its finalization. */
      finishClose?: () => Promise<void>;
    }
    const sessions = new Map<string, Session>();
    const { idleMs: SESSION_IDLE_MS } = sessionIdlePolicy("CLAUDE");

    const stopSession = (session: Session) => {
      void killCliTree(session.child).then((stopped) => {
        if (stopped) void session.finishClose?.();
      });
    };
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
        stopSession(s);
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
      for (const l of Array.from(listeners)) l(event);
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
    const retryState = new Map<string, { attempt: number; cancelled: boolean; rebuilt?: boolean }>();

    const sendTurn = async (turn: SendTurnInput, logicalTurnId?: string) => {
      if (config.managedModels && (!turn.model || !config.managedModels.includes(turn.model))) throw new Error("This model is not assigned to this workspace.");
      if (config.requireApiKey && !input.environment.ANTHROPIC_API_KEY) throw new Error(NO_ANTHROPIC_KEY);
      if (config.managed && (!turn.model || turn.model.includes("::") || !config.configDir ||
          !input.environment.ANTHROPIC_API_KEY || !input.environment.ANTHROPIC_BASE_URL)) {
        throw new Error("Company model access is unavailable. Reconnect your organization; personal billing will not be used.");
      }
      const { threadId, botId } = turn;
      // An internal relaunch (transient failure, rejected resume) keeps the
      // logical turn's stop handle in `active` while it sets up, so Stop is
      // never a silent no-op between two CLI processes of the same turn.
      const relaunch = logicalTurnId !== undefined;
      if (active.has(threadId) && !relaunch) throw new Error("a turn is already running on this thread");
      // A bot-level mode is authoritative for this turn. In particular, an
      // old provider instance may still be configured with
      // `bypassPermissions`; Ask/Auto must restore Claude's interactive
      // broker instead of inheriting that silent bypass. Calls without a
      // per-turn mode keep the legacy adapter behavior.
      const permissionMode = turn.approvalMode === undefined
        ? config.permissionMode
        : turn.approvalMode === "full" ? "bypassPermissions"
          : turn.approvalMode === "auto" ? "auto"
            : turn.approvalMode === "edits" ? "acceptEdits" : "default";
      const controlsHost = turn.integrations?.localComputer?.scope === "local-computer";
      if (controlsHost && permissionMode === "bypassPermissions" && turn.approvalMode !== "full") {
        throw new Error("local computer control requires the interactive approval broker");
      }
      // Materialize before creating a broker or process. A missing/corrupt
      // attachment must fail this call without leaving a live session behind.
      const promptMsg = claudeUserMessage(turn.text, turn.images);
      // Internal relaunches are still the turn acknowledged to the harness.
      // A new user message gets a fresh id, but retry/recovery must not orphan
      // its capability, coordination result or queued continuation ownership.
      const turnId = logicalTurnId ?? newId();
      const retryAbort = new AbortController();
      const retry = retryState.get(threadId) ?? { attempt: 0, cancelled: false };
      // A fresh user turn starts un-cancelled. A relaunch must keep a Stop
      // that landed while it was being scheduled.
      if (!relaunch) {
        retry.cancelled = false;
        retry.rebuilt = false;
      }
      retryState.set(threadId, retry);
      // a retry relaunches the whole CLI; the backoff is scaled down in tests
      // so a fake's transient failures don't stall real seconds
      const retryScale = Number(process.env.FAKE_CLAUDE_RETRY_SCALE ?? "1");
      const sessionId = !turn.sessionReset && typeof turn.resumeCursor === "string" ? turn.resumeCursor : null;
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
      // A guest's turn: no command-running tool at all, and no read outside
      // its own folder (GUEST_CLAUDE_TOOLS). It only ever runs in Ask.
      if (turn.guestConfined && permissionMode !== "default") {
        throw new Error("A guest's turn on this Cloud runs only in Ask.");
      }
      if (turn.guestConfined) args.push("--restricted", "--tools", GUEST_CLAUDE_TOOLS.join(","));
      else if (config.tools !== undefined) args.push("--tools", config.tools.join(","));
      if (config.disallowedTools?.length) {
        args.push("--disallowedTools", config.disallowedTools.join(","));
      }
      const turnEnvironment = environment();
      if ((turn.refreshSystemPrompt || turn.guestConfined) && !cliVersionChecked) {
        const version = await readCliVersion(turnEnvironment);
        if (version) {
          cliVersion = parseClaudeCliVersion(version);
          cliVersionChecked = true;
        }
      }
      if (turn.guestConfined && !claudeCliSupports(cliVersion, "--restricted")) {
        throw new Error(withWhy("This Claude Code is too old to run this turn without a shell. Update Claude Code.", turn.confinedWhy));
      }
      // Each stdin message echoed as a model call takes it in: how a turn
      // tells a folded steer from one that runs next (CLAUDE_REPLAY_FLOOR).
      const replaysUserMessages = cliVersion === null || versionAtLeast(cliVersion, CLAUDE_REPLAY_FLOOR);
      if (replaysUserMessages) args.push("--replay-user-messages");
      const isolated = !inheritsUserConfig(turnEnvironment);
      if (isolated) {
        // A bot gets the tools and instructions its owner gave it, not
        // whatever this machine's Claude Code happens to be set up with.
        // Without these the CLI silently adds, to EVERY turn of every bot:
        // the desktop's own MCP servers and claude.ai connectors (one
        // measured desktop mounted 407 extra tools, ~10k tokens), its skill
        // and agent listings, its hooks, and its personal CLAUDE.md. Every
        // model call in the session then re-reads all of it.
        // Each flag only on a CLI that accepts it: an unknown flag is an
        // argument error that would fail every turn (CLAUDE_FLAG_FLOORS).
        // The MCP half has a switch (Plugins → MCP servers → "Also use my
        // Claude Code MCP servers"): with it on, the CLI loads the servers
        // and connectors from the person's own Claude Code config — the way
        // Codex reads its own config.toml — while skills, hooks and the
        // personal CLAUDE.md stay out.
        if (!turn.mcpFromUserConfig && claudeCliSupports(cliVersion, "--strict-mcp-config")) args.push("--strict-mcp-config");
        if (claudeCliSupports(cliVersion, "--setting-sources")) args.push("--setting-sources", "project");
      }
      const compactWindow = autoCompactWindow(turnEnvironment);
      if (compactWindow && (cliHasAutocompact ?? claudeCliSupports(cliVersion, "--autocompact"))) {
        args.push("--autocompact", compactWindow);
      }
      // An old pair conversation can still carry its first assignment in
      // Claude's recorded system prompt. The current brief rides in the user
      // turn, so refresh the recorded prompt on --resume too. Gated by the
      // version floor like every other flag the CLI may predate: an unknown
      // flag is a hard argument error, not a graceful degrade.
      if (turn.refreshSystemPrompt && cliVersionChecked && claudeCliSupports(cliVersion, "--system-prompt-snapshot")) {
        args.push("--system-prompt-snapshot", "off");
      }
      const turnModel = config.managed ? turn.model : await resolveClaudeTurnModel(turn.model, turnEnvironment);
      const injected = config.managed ? { model: turnModel ?? null, injected: false } : applyClaudeInject({ ...turnEnvironment }, turnModel);
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
      if (turn.integrations?.localComputer) {
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
      // A remote entry ({type, url, headers}) is already in the CLI's own
      // shape and the CLI connects to it itself; header values ride in the
      // 0600 config file like every other credential here.
      // Bot-owned servers, gated below: they are the ones that answer for a
      // machine rather than for a context window.
      const botOwned = new Set<string>();
      for (const [name, server] of Object.entries(turn.integrations?.custom ?? {})) {
        if (Object.hasOwn(mcpServers, name)) continue;
        mcpServers[name] = { ...server };
        botOwned.add(name);
      }
      // --strict-mcp-config (above) makes this config the CLI's only source
      // of MCP servers, so a server the bot's OWN project declares would
      // otherwise vanish with the machine's. Merge it last: a project file
      // can add servers but never shadow a harness-owned mount.
      // Never for a guest's turn: its folder is its own to write, and a
      // server declared there would run a command.
      if (isolated && turn.cwd && !turn.guestConfined) {
        for (const [name, server] of Object.entries(projectMcpServers(turn.cwd))) {
          if (Object.hasOwn(mcpServers, name)) continue;
          mcpServers[name] = server;
          botOwned.add(name);
        }
      }
      // One tool call can put more into the conversation than the whole rest
      // of the session: a single product search measured 60-140 KB of JSON,
      // and the CLI re-reads it on every later model call. The harness never
      // sees these calls — the CLI runs the server itself — so the only place
      // to stand is between the two processes. Harness-owned mounts (the
      // permission broker, computer, browser, agents, dweb) are already
      // bounded and are deliberately left alone.
      const budget = resultBudget(turnEnvironment);
      for (const name of botOwned) {
        const gated = gateServer({ name, server: mcpServers[name], threadId, budget, nodeEnv: NODE_ENV_FLAG });
        if (gated) mcpServers[name] = gated;
      }
      // Keep ask_user available even in Full access. Native bypass skips
      // permission prompts, not questions requiring a person's answer.
      let broker: Awaited<ReturnType<typeof createPermissionBroker>> | undefined;
      const socketPath = permissionSocketPath(threadId, botId);
      if (permissionMode !== "bypassPermissions") {
        args.push("--permission-prompt-tool", "mcp__ogb__approve");
      }
      mcpServers.ogb = { command: process.execPath, args: [PERM_PROXY_PATH, socketPath], env: { ...NODE_ENV_FLAG }, alwaysLoad: true };
      allowed.push("mcp__ogb");
      // A guest's turn pre-allows only the harness's own tools: anything
      // else (the browser can open a file: address) asks the owner first.
      if (turn.guestConfined) allowed.splice(0, allowed.length, ...allowed.filter((name) => name === "mcp__ogb" || name === "mcp__agents"));
      // The MCP config carries credentials — a Composio consumer key in a
      // header, the boat token in the computer proxy's env, the comms token in
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

      const env = environment(turnModel);
      const authSettings = isolated && !injected.injected
        ? readClaudeAuthSettings(env, input.environment) : {};
      // Harness hooks (item 0.2): one helper command for the events the
      // harness observes. The helper reads its bearer from a per-thread file
      // the harness rewrites every turn, so a long-lived CLI process never
      // presents a stale token. Registered through the same private
      // --settings file as the auth override; both are 0600 and per launch.
      const hooks = turn.integrations?.hooks;
      const hookTokenPath = hooks ? hookTokenFile(threadId, botId) : null;
      if (hooks && hookTokenPath) {
        mkdirSync(dirname(hookTokenPath), { recursive: true, mode: 0o700 });
        writeFileAtomic(hookTokenPath, hooks.token, { mode: 0o600 });
        env.OMB_HOOK_URL = hooks.url;
        env.OMB_HOOK_TOKEN_FILE = hookTokenPath;
        env.OMB_HOOK_NODE = process.execPath;
        env.OMB_HOOK_HELPER = HOOK_HELPER_PATH;
        // in the packaged app process.execPath is Electron — run the helper as node
        if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = "1";
      }
      const settings: Record<string, unknown> = { ...authSettings };
      if (hooks) settings.hooks = claudeHookSettings(HOOK_HELPER_PATH);
      if (turn.guestConfined) settings.permissions = GUEST_CLAUDE_PERMISSIONS;
      const authSettingsPath = mcpConfigPath && Object.keys(settings).length
        ? join(dirname(mcpConfigPath), "auth-settings.json") : null;
      if (authSettingsPath) args.push("--settings", authSettingsPath);
      // Our approvals and browser credentials expire at the user-turn
      // boundary. Native background workers cannot outlive that boundary;
      // parallel bot work must use the harness's durable delegate_bot path.
      env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = "1";
      const cwd = turn.cwd ?? homedir();
      const commandCwd = permissionLaunchCwd(cwd);
      // Everything that shapes the process, minus session/turn-specific temp
      // paths. Their contents are represented directly in the key instead.
      const privateFileFlags = new Set(["--mcp-config", "--settings"]);
      const keyArgs = args.filter((a, i) => !privateFileFlags.has(a) && !privateFileFlags.has(args[i - 1] ?? ""));
      const argsKey = JSON.stringify({
        args: keyArgs,
        // the volatile half is deliberately absent: it must not respawn a
        // healthy session (see Session.volatile)
        system: turn.systemStable ?? turn.system ?? null,
        mcpServers,
        cwd,
        model: injected.model ?? null,
        base: env.ANTHROPIC_BASE_URL ?? null,
        configDir: env.CLAUDE_CONFIG_DIR ?? null,
        // hooks on/off changes the settings file the process was launched with
        hooks: Boolean(hooks),
        // Rotating an account's key/helper must not reuse the old process.
        auth: createHash("sha256").update(JSON.stringify({
          settings: authSettings,
          env: Object.fromEntries(CLAUDE_ACCOUNT_ENV_KEYS.map((key) => [key, env[key]])),
        })).digest("hex"),
      });

      // Reuse the live process when it is idle, unchanged, and is the session
      // the harness wants resumed. Clearing a cursor alone does not opt out
      // of legacy reuse: an explicit rebuild must discard the idle context.
      const live = sessions.get(threadId);
      if (!turn.sessionReset && live && !live.turn && !live.closing && live.child.exitCode === null && live.argsKey === argsKey && (!sessionId || sessionId === live.sessionId)) {
        if (live.idleTimer) clearTimeout(live.idleTimer);
        live.turn = { turnId, input: turn, retryAbort, settled: false, sawStreamDelta: false, pendingSteers: new Set(), deferred: null, continuationGrace: null, continuationSilence: null };
        active.set(threadId, { stop: () => {
          if (live.turn) live.turn.stopRequested = true;
          closeSession(threadId, "interrupted");
          retry.cancelled = true;
          retryAbort.abort();
          stopSession(live);
        }, turnId, broker: live.broker });
        emit({ ...base(threadId, turnId), type: "turn.started" });
        const volatile = turn.systemVolatile ?? "";
        const message = volatile === live.volatile && !turn.mentionTurn
          ? promptMsg
          : claudeUserMessage(withVolatileNote(turn.text, volatile), turn.images);
        live.volatile = volatile;
        const running = live.turn;
        const written = await writeUser(live, threadId, message);
        if (!written && !running?.stopRequested) {
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
      if (live) closeSession(threadId, turn.sessionReset ? "context reset" : "spawn contract changed");

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
            socketPaths: brokerSocketCandidates(threadId, botId),
            isActive: () => Boolean(sessions.get(threadId)?.turn),
            onAsk: (ask) => {
              const eventTurnId = sessions.get(threadId)?.turn?.turnId ?? turnId;
              askTools.set(ask.id, typeof ask.tool === "string" ? ask.tool : undefined);
              // Auto was requested: say whether the CLI's reviewer is actually
              // running, from init, so the harness can tell a classifier's
              // verdict from a Manual session asking about everything.
              const nativeMode = sessions.get(threadId)?.nativePermissionMode ?? null;
              const nativeReview =
                permissionMode === "auto" && nativeMode !== null
                  ? nativeMode === "auto" ? "active" : "inactive"
                  : undefined;
              const questions = askQuestions(ask);
              emit({
                ...base(threadId, eventTurnId),
                type: "request.opened",
                requestId: ask.id,
                requestType: ask.kind,
                tool: ask.tool,
                summary: askSummary(ask),
                command: ask.kind === "permission" && ask.tool === "Bash"
                  ? permissionCommand(ask.input.command, commandCwd) : undefined,
                requiresExplicitApproval: ask.kind === "permission" && ask.tool === "Bash" && ask.input.dangerouslyDisableSandbox === true || undefined,
                nativeReview,
                // the proxy hands Claude its own suggested rules on `always`;
                // host control stays one action at a time
                allowSession: ask.kind === "permission" && !(controlsHost && typeof ask.tool === "string" && ask.tool.startsWith("mcp__computer")) ? true : undefined,
                approvalScope:
                  typeof ask.tool === "string" && controlsHost && ask.tool.startsWith("mcp__computer")
                    ? "local-computer"
                    : undefined,
                questions: questions ?? undefined,
                // A structured ask still offers flat labels, for the phone
                // companions and any client that predates the question card.
                choices: questions ? questionChoices(questions) : parseChoices(ask.input?.choices),
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
        if (authSettingsPath) {
          writeFileSync(authSettingsPath, JSON.stringify(settings), { mode: 0o600 });
        }
        if (sessionId) args.push("--resume", sessionId);
        else args.push("--session-id", newSessionId!);
      } catch (error) {
        cleanupUnownedLaunch();
        throw error;
      }

      // Stop reached the relaunch handle while this attempt was still setting
      // up (model probe, broker). Settle the logical turn as interrupted
      // instead of spawning a process nobody wants.
      if (relaunch && retry.cancelled) {
        cleanupUnownedLaunch();
        if (active.get(threadId)?.turnId === turnId) active.delete(threadId);
        emit({ ...base(threadId, turnId), type: "turn.completed", ok: false, stopReason: "interrupted", cost: null });
        return { turnId };
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
        volatile: turn.systemVolatile ?? "",
        sessionId: sessionId ?? newSessionId,
        sawInit: false,
        nativePermissionMode: null,
        replaysUserMessages,
        turn: { turnId, input: turn, retryAbort, settled: false, sawStreamDelta: false, pendingSteers: new Set(), deferred: null, continuationGrace: null, continuationSilence: null },
        idleTimer: null,
        closing: false,
        stderr: "",
        costTotal: undefined,
      };
      sessions.set(threadId, session);

      // settles the TURN, not the process: the CLI stays for the next
      // message until it has been quiet for SESSION_IDLE_MS
      const settle = (
        ok: boolean,
        stopReason: string | null,
        total: number | null = null,
        usage?: { input: number; output: number; cachedInput?: number },
      ) => {
        const t = session.turn;
        if (!t || t.settled) return;
        t.settled = true;
        if (t.continuationGrace) {
          clearTimeout(t.continuationGrace);
          t.continuationGrace = null;
        }
        if (t.continuationSilence) {
          clearTimeout(t.continuationSilence);
          t.continuationSilence = null;
        }
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
        // Updating the executable cannot update code already loaded by this
        // pooled child. Retire it before announcing completion so an explicit
        // retry resumes on a fresh process; healthy sibling sessions stay warm.
        if (stopReason === "update_required") closeSession(threadId, "update required");
        // `total` is the CLI's running total for this process; the harness
        // books turn.completed.cost as this turn's own spend
        const cost = turnCostFromRunningTotal(total, session.costTotal ?? null);
        if (total !== null) session.costTotal = total;
        emit({ ...base(threadId, t.turnId), type: "turn.completed", ok, stopReason, cost, ...(usage ? { usage } : {}) });
        if (session.child.exitCode === null && !session.closing) armIdle(threadId);
      };
      const settleResult = (result: NativeTurnResult) => settle(result.ok, result.stopReason, result.cost, result.usage);
      const currentTurnId = () => session.turn?.turnId ?? turnId;
      // The process's first result with a cost says what --resume restored,
      // which its turns are measured from; every result is kept for a later
      // resume. A result without one (an API error) decides nothing yet.
      const noteCostState = (total: unknown, modelUsage: unknown, usage: Parameters<typeof restoredCostBase>[2]) => {
        const state = claudeCostSnapshot(total, modelUsage);
        if (!state) return;
        if (session.costTotal === undefined) {
          session.costTotal = session.sessionId
            ? restoredCostBase(readCostHistory()[session.sessionId] ?? [], state, usage)
            : null;
        }
        if (session.sessionId) recordCostState(session.sessionId, state);
      };

      const handleLine = (line: string) => {
        if (session.closing) return;
        let o: any;
        try {
          o = JSON.parse(line);
        } catch {
          return;
        }
        // A stdin message echoed back (--replay-user-messages) carries its
        // images again: keep their bytes out of the log, as when it was sent.
        appendNative(threadId, { dir: "in", source: "claude.sdk.message", msg: o?.type === "user" && o.isReplay === true && o.message ? diagnosticClaudeUserMessage(o) : o });
        // The continuation a held result waits for has spoken: any frame
        // after its `init` — status, thinking, text, its own result. The
        // echo of its own message is not speech: it comes before the call.
        if (session.turn?.continuationSilence && !(o.type === "system" && o.subtype === "init") && !(o.type === "user" && o.isReplay === true)) {
          clearTimeout(session.turn.continuationSilence);
          session.turn.continuationSilence = null;
        }
        switch (o.type) {
          case "system":
            if (o.subtype === "init") {
              // A guest's session proves its tool set before it does anything:
              // a CLI that kept a command-running tool is stopped here.
              const tools: unknown[] = Array.isArray(o.tools) ? o.tools : [];
              if (session.turn?.input.guestConfined && (o.permissionMode !== "default" || tools.some((tool) => typeof tool === "string" && GUEST_FORBIDDEN_TOOLS.has(tool)))) {
                emit({ ...base(threadId, currentTurnId()), type: "runtime.error", message: withWhy("This Claude Code kept its shell, so it can't run this turn. Update Claude Code.", session.turn?.input.confinedWhy) });
                session.closing = true;
                stopSession(session);
                break;
              }
              session.sawInit = true;
              session.nativePermissionMode = typeof o.permissionMode === "string" ? o.permissionMode : null;
              if (typeof o.session_id === "string") session.sessionId = o.session_id;
              // The turn the CLI starts for a steered message it could not
              // fold (see `result`): the held result now waits for this one's
              // — bounded, so a continuation that announces itself and then
              // never speaks cannot keep the turn's pass open indefinitely.
              const held = session.turn;
              if (held?.continuationGrace) {
                clearTimeout(held.continuationGrace);
                held.continuationGrace = null;
                if (held.continuationSilence) clearTimeout(held.continuationSilence);
                held.continuationSilence = setTimeout(() => {
                  if (session.turn !== held || held.settled || !held.deferred) return;
                  // A Stop or a close settles the turn in finalizeClose.
                  if (held.stopRequested || session.closing) return;
                  held.continuationSilence = null;
                  emit({
                    ...base(threadId, held.turnId),
                    type: "runtime.error",
                    message: "Claude began a steered message but went silent; the turn was closed.",
                  });
                  settleResult(held.deferred);
                }, STEERED_CONTINUATION_SILENCE_MS * steerSilenceScale());
                held.continuationSilence.unref?.();
              }
              emit({ ...base(threadId, currentTurnId()), type: "session.started", sessionId: o.session_id, model: o.model, ...(retry.rebuilt ? { rebuilt: true } : {}) });
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
            // An unauthenticated turn comes back as an api-error frame whose
            // only content is the CLI's own "run /login" instruction — a
            // command this app has no terminal to run, so relaying it as a
            // reply strands the user. Every other engine reports this as a
            // setup error; that is what routes them to the sign-in card.
            if (claudeAuthFailure(o, text)) {
              if (session.turn) session.turn.authFailed = true;
              emit({ ...base(threadId, currentTurnId()), type: "runtime.error", message: text, setup: true });
              break;
            }
            if (claudeVersionTooOld(o, text)) {
              if (session.turn) session.turn.updateRequired = true;
              emit({ ...base(threadId, currentTurnId()), type: "runtime.error", message: text, setup: true, claudeUpdate: true });
              break;
            }
            if (text.trim()) {
              // The CLI's own report of any other API error is still shown,
              // but marked: the model never produced it.
              const synthetic = o.is_api_error_message === true || typeof o.error === "string" ? { synthetic: true } : {};
              // fallback delta for CLIs/paths that never streamed the block
              if (!session.turn?.sawStreamDelta) {
                emit({ ...base(threadId, currentTurnId()), ...synthetic, type: "content.delta", streamKind: "assistant_text", delta: text });
              }
              if (session.turn) session.turn.sawStreamDelta = false;
              emit({ ...base(threadId, currentTurnId()), ...synthetic, type: "item.completed", itemType: "assistant_text", text });
            }
            for (const b of Array.isArray(msg.content) ? msg.content : []) {
              if (b.type === "tool_use") {
                emit({
                  ...base(threadId, currentTurnId()),
                  type: "item.started",
                  itemType: "tool",
                  itemId: b.id,
                  title: b.name,
                  summary: commandSummary(b.input),
                  input: toolDetailPreview(b.input),
                });
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
                // one assistant message = one model call, and its prompt is
                // everything in the window: fresh text, cache reads and writes
                contextTokens: (msg.usage.input_tokens || 0) + (msg.usage.cache_read_input_tokens || 0) + (msg.usage.cache_creation_input_tokens || 0),
              });
            }
            break;
          }
          case "user": {
            // --replay-user-messages: a model call took this stdin message in.
            // A steer echoed before its turn's `result` was folded into it.
            if (o.isReplay === true) {
              if (typeof o.uuid === "string") session.turn?.pendingSteers.delete(o.uuid);
              break;
            }
            for (const b of Array.isArray(o.message?.content) ? o.message.content : []) {
              if (b.type === "tool_result") {
                emit({ ...base(threadId, currentTurnId()), type: "item.completed", itemType: "tool", itemId: b.tool_use_id, ok: !b.is_error, output: toolDetailPreview(b.content) });
                for (const img of extractMcpImages(b.content)) {
                  emit({ ...base(threadId, currentTurnId()), type: "item.completed", itemType: "assistant_image", data: img.data });
                }
              }
            }
            break;
          }
          case "result": {
            // A synthetic background completion is not the result of the
            // submitted user turn. Settling it would revoke browser access
            // and deny approvals while that user turn is still running.
            if (o.origin?.kind === "task-notification") break;
            // result.usage is this turn's own figure, "per-turn in
            // streaming-input sessions" (2.1.282) even on a retained process.
            // cache reads count as input: they are billed (at the cache rate)
            // and they fill the window — but they are reported separately
            // too, so the UI can show how much of the figure was context
            // re-read rather than new text. total_cost_usd is instead the
            // process's running total; settle() books this turn's share.
            noteCostState(o.total_cost_usd, o.modelUsage, {
              input: o.usage?.input_tokens || 0,
              cacheRead: o.usage?.cache_read_input_tokens || 0,
              cacheWrite: o.usage?.cache_creation_input_tokens || 0,
              output: o.usage?.output_tokens || 0,
            });
            const native: NativeTurnResult = {
              ok: o.is_error !== true,
              stopReason: session.turn?.authFailed
                ? "auth_required"
                : session.turn?.updateRequired
                  ? "update_required"
                  : o.stop_reason ?? o.terminal_reason ?? null,
              cost: o.total_cost_usd ?? null,
              ...(o.usage
                ? {
                    usage: {
                      input: (o.usage.input_tokens || 0) + (o.usage.cache_read_input_tokens || 0) + (o.usage.cache_creation_input_tokens || 0),
                      output: o.usage.output_tokens || 0,
                      ...(typeof o.usage.cache_read_input_tokens === "number"
                        ? { cachedInput: o.usage.cache_read_input_tokens }
                        : {}),
                    },
                  }
                : {}),
            };
            const t = session.turn;
            // Does another user turn follow this result without more input?
            // The CLI says so itself when it can: queued_turn_count ("greater
            // than 0 means at least one more user turn (and result) follows",
            // 2.1.282) counts its command queue. A message steered in over
            // stdin is not in that queue when the result is written — the
            // incident's result said 0 and the CLI ran the message 58 ms later
            // — so 0, like an absent field, decides nothing; the steers the
            // driver has not seen taken in do. With --replay-user-messages the
            // CLI echoes a steer as a model call takes it in, so one still
            // pending here runs next. Without it (an older CLI), nothing says
            // whether a steer was folded in or runs next (the time a tool
            // result is read proves nothing about when stdin was taken), so
            // any steer holds the result: if no `init` follows within the
            // grace, it was folded, and the held result is the turn's. A steer
            // landing while a result is held extends the hold.
            const queuedTurns = typeof o.queued_turn_count === "number" ? o.queued_turn_count : 0;
            if (t && !t.settled && (queuedTurns > 0 || t.pendingSteers.size > 0)) {
              // The CLI runs the queued message next, in this process, with
              // this turn's tools, and the harness recorded it as part of this
              // turn. A `turn.completed` now would revoke the turn's
              // capabilities under that continuation (its internal tools would
              // answer 401) and show the bot idle while it works. Hold this
              // result until the continuation's own arrives.
              // Echoed steers leave the set as their turn takes them in;
              // without the echo, this hold answers for every steer so far.
              if (!session.replaysUserMessages) t.pendingSteers.clear();
              t.deferred = sumNativeTurnResults(t.deferred, native);
              t.armGrace = () => {
                if (t.continuationGrace) clearTimeout(t.continuationGrace);
                t.continuationGrace = setTimeout(() => {
                  // No `init` came: the message was folded into the call that
                  // just finished after all (or a queued send was cancelled),
                  // and the held result is the turn's.
                  if (session.turn !== t || t.settled) return;
                  // A Stop or a close settles the turn in finalizeClose: as
                  // interrupted after a Stop, else on the held result, which
                  // the grace still being set tells it the turn owns. (taskkill
                  // is asynchronous on Windows, so the CLI can outlive a Stop
                  // by longer than this grace.)
                  if (t.stopRequested || session.closing) return;
                  t.continuationGrace = null;
                  if (t.deferred) settleResult(t.deferred);
                }, STEERED_CONTINUATION_GRACE_MS * steerGraceScale());
                t.continuationGrace.unref?.();
              };
              t.armGrace();
              appendNative(threadId, { dir: "out", source: "claude.session", msg: { hold: `result: a steered message is still queued (queued_turn_count ${o.queued_turn_count ?? "absent"})` } });
              break;
            }
            settleResult(sumNativeTurnResults(t?.deferred ?? null, native));
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

      let closeFinalized = false;
      const finalizeClose = async (code: number | null) => {
        if (closeFinalized) return;
        // The root can close while its MCP helpers are still running. Join
        // an in-flight stop (or reap its remaining group) before releasing
        // the turn so a replacement cannot overlap the old helpers.
        if (!(await killCliTree(child, 0))) {
          session.broker?.close();
          session.broker = undefined;
          emit({ ...base(threadId, currentTurnId()), type: "runtime.error", message: "Claude could not be confirmed stopped; its helper processes may still be running." });
          return;
        }
        if (closeFinalized) return;
        closeFinalized = true;
        // a turn still running when the process died is a failed turn; a
        // process that exited between turns (idle close, contract change)
        // is just a session ending
        if (session.turn?.stopRequested && !session.turn.settled) {
          settle(false, "interrupted");
        } else if (session.turn?.deferred && !session.turn.settled) {
          // The prompt was answered — a native result is held for a steered
          // continuation — and the process went away. Never relaunch: the
          // prompt already ran. Before the continuation announced itself the
          // held result is the turn's; once it had begun, its words are lost.
          const held = session.turn.deferred;
          if (session.turn.continuationGrace) {
            settleResult(held);
          } else {
            emit({
              ...base(threadId, currentTurnId()),
              type: "runtime.error",
              message: `claude exited ${code} before result${session.stderr ? `: ${session.stderr.trim().slice(-300)}` : ""}`,
            });
            settleResult({ ...held, ok: false, stopReason: "exit_before_result" });
          }
        } else if (session.turn && !session.turn.settled) {
          // A retained process may be running a later user turn. Its close
          // handler must retry that request, not the process's first prompt.
          const { turnId, input: turn, retryAbort } = session.turn;
          const retry = retryState.get(threadId) ?? { attempt: 0, cancelled: false };
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
              // Keep Stop reachable while the relaunch sets up: there is no
              // process yet, so this handle only records the cancellation and
              // the relaunched sendTurn honors it before spawning.
              retryState.set(threadId, retry);
              active.set(threadId, { stop: () => { retry.cancelled = true; retryAbort.abort(); }, turnId });
              try {
                const cursor = session.sessionId ?? sessionId ?? undefined;
                // The reset was consumed by the initial launch. Retry the
                // new session, never the context that launch replaced.
                await sendTurn({ ...turn, sessionReset: false, resumeCursor: cursor }, turnId);
              } catch (e) {
                if (active.get(threadId)?.turnId === turnId) active.delete(threadId);
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
          // A --resume that the CLI never acknowledged: it exited without
          // an `init` frame, so it never read the prompt and this turn has
          // caused nothing. Without this the thread is BRICKED — the dead
          // cursor is never cleared, so every later turn resumes the same
          // missing session and fails identically, and the user has no way
          // back except switching engines. One fresh session, carrying the
          // harness's rebuild of the conversation. Exactly one: the relaunch
          // offers no cursor, so `attempted` is false there and a second
          // failure is reported like any other.
          const resumeFailure = classifyResumeFailure({
            attempted: Boolean(sessionId),
            rejected: !session.sawInit,
            promptSubmitted: session.sawInit,
            producedOutput: session.turn.sawStreamDelta,
          });
          if (mayReplay(resumeFailure) && !retry.cancelled) {
            const recovery = recoveryPromptFor({
              recoveryText: turn.recoveryText,
              currentText: turn.text,
              failure: resumeFailure,
            });
            session.broker?.close();
            session.broker = undefined;
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
            // Same relaunch handle as the transient-retry path above. The new
            // session is announced as rebuilt only when it is actually given
            // the replay: with nothing to replay it gets the turn text alone.
            retry.rebuilt = recovery.replayed;
            retryState.set(threadId, retry);
            active.set(threadId, { stop: () => { retry.cancelled = true; retryAbort.abort(); }, turnId });
            emit({
              ...base(threadId, turnId),
              type: "turn.retrying",
              attempt: retry.attempt + 1,
              delayMs: 0,
              reason: "resume_rejected",
            });
            void (async () => {
              try {
                // no cursor: a fresh session, carrying the rebuild
                await sendTurn({ ...turn, resumeCursor: undefined, recoveryText: undefined, text: recovery.text }, turnId);
              } catch (e) {
                if (active.get(threadId)?.turnId === turnId) active.delete(threadId);
                retryState.delete(threadId);
                emit({
                  ...base(threadId, turnId),
                  type: "runtime.error",
                  message: e instanceof Error ? e.message : String(e),
                });
                emit({ ...base(threadId, turnId), type: "turn.completed", ok: false, stopReason: "exit_before_result", cost: null });
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
      };
      child.on("close", (code) => {
        session.finishClose = () => finalizeClose(code);
        void session.finishClose();
      });

      const stop = () => {
        if (session.turn) session.turn.stopRequested = true;
        // taskkill is asynchronous on Windows. Retire steering and approvals
        // now, before a still-connected child can submit more work.
        closeSession(threadId, "interrupted");
        retry.cancelled = true;
        retryAbort.abort();
        stopSession(session);
      };
      active.set(threadId, { stop, turnId, broker });
      emit({ ...base(threadId, turnId), type: "turn.started" });

      // prompt over stdin as a stream-json message — never argv (ARG_MAX).
      // stdin stays OPEN: that is what keeps the session alive for a
      // mid-turn steer or the next turn; closeSession() ends it.
      if (!(await writeUser(session, threadId, promptMsg))) {
        if (!session.turn?.stopRequested) settle(false, "stdin_write_failed");
        closeSession(threadId, "stdin write failed");
      }

      return { turnId };
    };

    /** A user message into the running turn: the CLI delivers it before its
     * next model call, or — when no call is left in this turn — as its next
     * native turn, which this driver keeps inside the same logical turn.
     * "refused" when nothing is running here to steer or the stdin write
     * provably failed; the caller queues those words. */
    const steer = async (threadId: string, text: string): Promise<SteerOutcome> => {
      const s = sessions.get(threadId);
      if (!s || !s.turn || s.turn.settled || s.closing || s.child.exitCode !== null) return "refused";
      const turn = s.turn;
      // Counted before the write: a `result` read while the words are still
      // on their way must hold for them too. A failed write takes it back.
      // The uuid is what the CLI's echo names when a model call takes it in.
      const id = randomUUID();
      turn.pendingSteers.add(id);
      if (!(await writeUser(s, threadId, { ...claudeUserMessage(text, undefined), uuid: id }))) {
        turn.pendingSteers.delete(id);
        return "refused";
      }
      // Written while a held result waits for a continuation's `init`: these
      // words get the whole grace to be announced too.
      if (!turn.settled && turn.continuationGrace) turn.armGrace?.();
      return "steered";
    };

    // Sign in from Settings: the unmodified CLI's own login, driven over pipes
    // (server/drivers/claude-login-auth.ts). Same environment as every turn.
    const login = new ClaudeLoginController({ cli: config.cli, environment, onAuthenticated: async () => { await refreshModels(); } });

    const snapshot = async (): Promise<ProviderSnapshot> => {
      const env = environment();
      const version = await readCliVersion(env);
      if (!version) return { state: "unavailable", reason: `\`${config.cli}\` CLI not found` };
      cliVersion = parseClaudeCliVersion(version);
      cliVersionChecked = true;
      if (version !== cliHelpVersion) {
        const help = await new Promise<string | null>((resolve) => {
          execCli(config.cli, ["--help"], { timeout: 8000, env }, (err, stdout) => resolve(err ? null : stdout));
        });
        cliHasAutocompact = help === null ? null : /^\s*--autocompact\b/m.test(help);
        cliHelpVersion = version;
      }
      const update = claudeCliUpdate(version, config.cli);
      const warning = claudeInheritWarning(env);
      if (config.requireApiKey) {
        // Never falls back to a login: without the key it is not set up.
        if (!input.environment.ANTHROPIC_API_KEY) return { state: "unavailable", version, reason: NO_ANTHROPIC_KEY };
        return { state: "available", version, authenticated: true, account: { method: "api-key" }, ...(update ? { update } : {}), ...(warning ? { warning } : {}), billing: "metered" };
      }
      const auth = await claudeAuthStatus(config.cli, env);
      // claudeEnvironment strips ANTHROPIC_API_KEY, so turns run on the
      // CLI's own login (Pro/Max): the cost it reports is what the call
      // WOULD bill, not a charge
      return { state: "available", version, ...auth, ...(update ? { update } : {}), ...(warning ? { warning } : {}), billing: "subscription" };
    };

    /** One-shot Claude call with the prompt on stdin, never argv. Approval
     * summaries can contain paths, commands, or secrets, so the generic
     * `claude -p "prompt"` shape is not safe for review. No tools or MCP
     * servers are mounted in this isolated process. */
    const generateReview = (prompt: string, signal?: AbortSignal, onUsage?: TextGenerationOptions["onUsage"]): Promise<string> =>
      new Promise((resolve, reject) => {
        if (config.requireApiKey && !input.environment.ANTHROPIC_API_KEY) {
          reject(new Error(NO_ANTHROPIC_KEY));
          return;
        }
        const model = config.managedModels?.[0] ?? "claude-haiku-4-5";
        const child = spawnCli(
          config.cli,
          ["-p", "--model", model, "--output-format", onUsage ? "json" : "text"],
          {
            stdio: ["pipe", "pipe", "pipe"],
            env: environment(model),
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
          if (settled) return;
          if (onUsage) {
            try {
              const result = JSON.parse(stdout);
              if (!result || result.type !== "result") throw new Error("Claude text generation returned no result");
              const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
              const cachedInput = count(result.usage?.cache_read_input_tokens);
              const inputs = [count(result.usage?.input_tokens), cachedInput, count(result.usage?.cache_creation_input_tokens)]
                .filter((value): value is number => value !== undefined);
              const models = result.modelUsage && typeof result.modelUsage === "object" && !Array.isArray(result.modelUsage)
                ? Object.keys(result.modelUsage) : [];
              onUsage({
                model: models.length === 1 ? models[0]! : models.find(candidate => candidate === model || candidate.startsWith(`${model}-`)) ?? model,
                input: inputs.length ? inputs.reduce((sum, value) => sum + value, 0) : undefined,
                output: count(result.usage?.output_tokens),
                cachedInput,
                costUsd: count(result.total_cost_usd),
              });
              if (result.is_error === true) throw new Error(typeof result.result === "string" && result.result.trim() ? result.result : stderr.trim() || "Claude text generation failed");
              if (typeof result.result !== "string") throw new Error("Claude text generation returned no text");
              stdout = result.result;
            } catch (error) {
              finish(error instanceof Error ? error : new Error(String(error)));
              return;
            }
          }
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
      startAuthentication: () => login.start(),
      getAuthentication: (flowId) => login.get(flowId),
      completeAuthentication: (flowId, code) => login.complete(flowId, code),
      cancelAuthentication: () => login.cancel(),
      signOut: () => login.signOut(),
      adapter: {
        provider: DRIVER_KIND,
        capabilities: {
          sessionModelSwitch: "in-session",
          // A guest's turn runs with no command-running tool and no read
          // outside its folder (guestConfined, GUEST_CLAUDE_TOOLS).
          guestTurns: "confined",
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
          // Only while this CLI can be told to refresh a resumed session's
          // recorded system prompt (--system-prompt-snapshot). Keeping a
          // session across an update from outside it means the harness keeps
          // its prompt too; an older CLI would answer a delegated return with
          // the instructions of the turn that started the session, where a
          // fresh session rebuilt them. Unknown version: not yet.
          get strictResume() {
            return cliVersionChecked && cliVersion !== null && claudeCliSupports(cliVersion, "--system-prompt-snapshot");
          },
          // Harness turns reassert a per-bot mode and restore the broker even
          // when an old instance was configured with bypassPermissions.
          localComputerMcp: true,
          hooks: true,
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
          if (!broker.answer(requestId, behavior, decision.message, decision.always)) return "unavailable";
          return behavior === "allow" ? "allowed-once" : behavior === "answer" ? "answered" : "rejected";
        },
        hasSession: (threadId) => active.has(threadId),
        stopAll: async () => {
          for (const { stop } of active.values()) stop();
          for (const threadId of Array.from(sessions.keys())) closeSession(threadId, "stopAll");
        },
        onEvent: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      generateText: (prompt, options) => generateReview(prompt, options?.signal, options?.onUsage),
      reviewPermission: generateReview,
      dispose: async () => {
        try {
          await login.dispose();
        } finally {
          for (const { stop } of active.values()) stop();
          for (const threadId of Array.from(sessions.keys())) closeSession(threadId, "dispose");
          listeners.clear();
        }
      },
    };
  },
};
