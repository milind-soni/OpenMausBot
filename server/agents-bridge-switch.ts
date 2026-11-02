// Whether a turn's agents proxy lists its tools through the tool bridge.
// Security invariant: the default is no bridge. A use_tool call reaches the host and the engine as
// use_tool, so a turn is bridged only when nothing judges an agents tool by its own name: the bot has
// no tool selection and its engine pre-approves the whole agents server.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { parseToolScope } from "../shared/tool-scope.ts";

import { bridgedCallName } from "./agents-bridge-names.ts";
import { TOOL_BRIDGE_ENV } from "./drivers/agents-bridge.ts";
import { claudeCliSupports, parseClaudeCliVersion } from "./drivers/claude.ts";
import { AGENTS_NODE_FLAG, SPAWNED_PROXIES } from "./proxy-paths.ts";

export { TOOL_BRIDGE_ENV };

/** The command that starts a turn's agents proxy. */
export const agentsProxyLaunch = () => ({ command: process.execPath, args: [SPAWNED_PROXIES.agents] });

/** Every agents proxy's starting environment. The bridge is always set, never inherited: an engine may
 * hand its MCP children this server's environment, where OMB_AGENTS_TOOL_BRIDGE=1 is the operator switch. */
export const AGENTS_PROXY_ENV = { ...AGENTS_NODE_FLAG, [TOOL_BRIDGE_ENV]: "0" } as const;

type BridgeConfig = { features?: { agentsToolBridge?: boolean; claudeUserMcp?: boolean } };

/** The workspace switch: `{"features": {"agentsToolBridge": true}}` in ~/.openmausbot/config.json, or
 * OMB_AGENTS_TOOL_BRIDGE set to exactly "1" or "0", which wins over the saved setting. */
export function agentsToolBridgeEnabled(cfg: BridgeConfig, env: NodeJS.ProcessEnv = process.env): boolean {
  const override = env[TOOL_BRIDGE_ENV];
  if (override === "1") return true;
  if (override === "0") return false;
  return cfg.features?.agentsToolBridge === true;
}

/** The engine a turn runs on, as far as the decision reads it. */
export interface BridgeEngine {
  driverKind: string;
  instanceId?: string;
  config?: unknown;
  environment?: Record<string, string | undefined>;
  /** The engine CLI's version from the instance's last snapshot; absent before the first one. */
  version?: string | null;
  /** The turn's launch folder; absent when the engine falls back to its default. */
  cwd?: string;
}

/** A turn's engine from its live instance, the instance configs, its last snapshot and its folder. */
export function turnEngine(
  instance: { instanceId: string; driverKind: string },
  configs: Record<string, { config?: unknown; environment?: Record<string, string> } | undefined>,
  snapshot: { version?: string | null } | undefined,
  cwd: string | undefined,
): BridgeEngine {
  const { config, environment } = configs[instance.instanceId] ?? {};
  return {
    driverKind: instance.driverKind,
    instanceId: instance.instanceId,
    ...(config !== undefined ? { config } : {}),
    ...(environment !== undefined ? { environment } : {}),
    ...(snapshot?.version != null ? { version: snapshot.version } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
  };
}

/** The person's home and managed Claude Code policy files; passed in so a test never reads the real ones. */
export interface EngineHost {
  home: string;
  managedPolicyFiles: readonly string[];
}

const CHAT_RUNTIME_DRIVERS: ReadonlySet<string> = new Set(["cerebras", "greenference", "grok", "groq", "meta", "minimax", "mistral", "openai-compat"]);

/** Whether text may name the agents server: it contains `mcp__agents` (a server merely starting so counts
 * too) or `mcp__` then a wildcard. Security: plain substring tests; no pattern is ever built from config text. */
function namesAgentsServer(text: string): boolean {
  const lower = text.toLowerCase();
  return lower.includes("mcp__agents") || lower.includes("mcp__*") || lower.includes("mcp__?");
}

/** Whether a permission rule has a wildcard in its tool name. The Claude CLI globs a deny or ask rule's
 * whole tool name, so `mcp__a*__x` or `*` reaches an agents tool called directly and misses it as use_tool.
 * A wildcard in parentheses is the rule's specifier (`Bash(git *)`); "inside" is one flag set at `(` and
 * cleared at `)`, as the CLI splits a `--disallowedTools` list. */
function wildcardInToolName(rule: string): boolean {
  let inside = false;
  for (const char of rule) {
    if (char === "(") inside = true;
    else if (char === ")") inside = false;
    else if (!inside && (char === "*" || char === "?")) return true;
  }
  return false;
}

/** Whether a tool-pattern entry could match an agents tool. Entries are comma-joined for the CLI, so one
 * may hold several patterns and both tests read the whole entry; an entry that is not text counts. */
function namesAgentsTools(entry: unknown): boolean {
  return typeof entry !== "string" || namesAgentsServer(entry) || wildcardInToolName(entry);
}

/** Claude Code's documented managed-policy files for a platform; the CLI applies them whatever
 * --setting-sources says. */
export function claudeManagedPolicyFiles(platform: NodeJS.Platform = process.platform): string[] {
  if (platform === "darwin") return ["/Library/Application Support/ClaudeCode/managed-settings.json"];
  if (platform === "win32") return ["C:\\Program Files\\ClaudeCode\\managed-settings.json", "C:\\ProgramData\\ClaudeCode\\managed-settings.json"];
  return ["/etc/claude-code/managed-settings.json"];
}

const SETTINGS_FILE_MAX_BYTES = 1024 * 1024;

/** A settings file's text, null when absent, or "unreadable". Security: only a regular file of at most
 * 1 MB is opened, so a FIFO (which would hold the server's one thread), socket or device never is. */
function textOf(file: string): string | null | "unreadable" {
  try {
    const stat = statSync(file);
    if (!stat.isFile() || stat.size > SETTINGS_FILE_MAX_BYTES) return "unreadable";
    return readFileSync(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? null : "unreadable";
  }
}

/** The files of a managed policy's `managed-settings.d` drop-in folder, or "unreadable". */
function managedDropIns(policyFile: string): string[] | "unreadable" {
  const folder = join(dirname(policyFile), "managed-settings.d");
  try {
    return readdirSync(folder).filter((name) => name.endsWith(".json")).sort().map((name) => join(folder, name));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" ? [] : "unreadable";
  }
}

/** Claude Code hook events that judge a call before it runs (lower case); they see a bridged call as use_tool. */
const JUDGING_HOOKS: ReadonlySet<string> = new Set(["pretooluse", "permissionrequest"]);

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** The permission lists the CLI matches as globs (lower case); allow rules do not glob. */
const GLOBBING_RULE_LISTS: ReadonlySet<string> = new Set(["deny", "ask"]);

/** The managed-policy key that may void the `--allowedTools mcp__agents` pre-approval (lower case). */
const MANAGED_RULES_ONLY_KEY = "allowmanagedpermissionrulesonly";

interface SettingsFindings { names: boolean; hooks: boolean; wildcard: boolean; managedOnly: boolean }

/** Walks every key and value of a parsed settings file, so a name the raw text hides behind JSON escapes is
 * seen. Keys match in any case and at any depth, on the cautious side; a hook list of none still counts. */
function walkSettings(value: unknown, found: SettingsFindings): void {
  if (typeof value === "string") {
    if (namesAgentsServer(value)) found.names = true;
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) walkSettings(item, found);
    return;
  }
  if (!record(value)) return;
  for (const [key, inner] of Object.entries(value)) {
    if (namesAgentsServer(key)) found.names = true;
    const lower = key.toLowerCase();
    if (lower === "hooks" && record(inner)) {
      for (const [event, setting] of Object.entries(inner)) if (JUDGING_HOOKS.has(event.toLowerCase()) && setting !== null) found.hooks = true;
    }
    if (lower === "permissions" && record(inner)) {
      for (const [list, rules] of Object.entries(inner)) {
        if (!GLOBBING_RULE_LISTS.has(list.toLowerCase()) || !Array.isArray(rules)) continue;
        if (rules.some((rule) => typeof rule === "string" && wildcardInToolName(rule))) found.wildcard = true;
      }
    }
    if (lower === MANAGED_RULES_ONLY_KEY && inner !== null && inner !== false) found.managedOnly = true;
    walkSettings(inner, found);
  }
}

type SettingsReading = "silent" | "names" | "hooks" | "wildcard" | "managed-only" | "unreadable";

/** What one Claude settings file means for the bridge; the first reading that holds wins. Security:
 * OpenMausBot's own hooks reach the CLI through a private --settings file this never reads, so none of
 * them may be a PreToolUse or PermissionRequest hook. */
function claudeSettings(file: string, managed: boolean): SettingsReading {
  const text = textOf(file);
  if (text === null) return "silent";
  if (text === "unreadable") return "unreadable";
  if (namesAgentsServer(text)) return "names";
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return "unreadable";
  }
  if (!record(parsed)) return "unreadable";
  const hooks = Object.entries(parsed).find(([key]) => key.toLowerCase() === "hooks")?.[1];
  if (hooks !== undefined && hooks !== null && !record(hooks)) return "unreadable";
  const found: SettingsFindings = { names: false, hooks: false, wildcard: false, managedOnly: false };
  walkSettings(parsed, found);
  if (found.names) return "names";
  if (found.hooks) return "hooks";
  if (found.wildcard) return "wildcard";
  if (managed && found.managedOnly) return "managed-only";
  return "silent";
}

/** Why a Claude Code turn is not bridged, or null. `--allowedTools mcp__agents` pre-allows the whole
 * agents server, so the harness asks nothing by name; what the CLI itself reads is checked here. */
function claudeRefusal(cfg: BridgeConfig, engine: BridgeEngine, env: NodeJS.ProcessEnv, host: EngineHost): string | null {
  if ({ ...env, ...engine.environment }.OMB_CLAUDE_INHERIT_USER_CONFIG === "1" || cfg.features?.claudeUserMcp === true) {
    return "the bot inherits this machine's own Claude Code setup";
  }
  const config = engine.config && typeof engine.config === "object" ? engine.config as { tools?: unknown; disallowedTools?: unknown } : {};
  for (const list of [config.tools, config.disallowedTools]) {
    if (list !== undefined && (!Array.isArray(list) || list.some(namesAgentsTools))) return "the engine's tool patterns name the agents server or match tools by pattern";
  }
  // Unlike the driver, which takes an unreadable version for a current CLI, an unknown version is no bridge.
  const version = parseClaudeCliVersion(engine.version);
  if (version === null) return "the Claude CLI's version is not known";
  if (!claudeCliSupports(version, "--setting-sources")) return "the Claude CLI is too old to leave the person's own settings out";
  // With --setting-sources project the CLI still reads the launch folder's .claude settings,
  // and a managed policy with its drop-in folder always applies.
  const folder = join(engine.cwd ?? host.home, ".claude");
  const read = [join(folder, "settings.json"), join(folder, "settings.local.json")].map((file) => claudeSettings(file, false));
  for (const policy of host.managedPolicyFiles) {
    const dropIns = managedDropIns(policy);
    if (dropIns === "unreadable") return "a Claude settings file cannot be read";
    read.push(...[policy, ...dropIns].map((file) => claudeSettings(file, true)));
  }
  if (read.includes("unreadable")) return "a Claude settings file cannot be read";
  if (read.includes("names")) return "a Claude settings file names the agents server";
  if (read.includes("hooks")) return "a Claude settings file sets a hook that judges tool calls";
  if (read.includes("wildcard")) return "a Claude settings file denies or asks for tools by pattern";
  if (read.includes("managed-only")) return "a managed Claude policy allows only its own permission rules";
  return null;
}

/** Why this engine's turns are not bridged, or null. An engine qualifies only when the harness
 * pre-approves the whole agents server and everything the engine reads that could name an agents tool
 * can be read here: Claude Code (claudeRefusal) and the chat runtime, which never asks for an agents
 * tool and reads no per-tool configuration. Left out:
 *   Codex       reads layered config.toml files (CODEX_HOME or ~/.codex, a trusted project's .codex/,
 *               /etc/codex, managed_config.toml) and PreToolUse/PermissionRequest hooks, any of which
 *               can name a tool.
 *   Pi          loads the extensions in the person's home, and an extension's tool_call handler can
 *               block a call by the name it sees.
 *   ACP agents  keep their own permissions: one "always allow" for use_tool would cover every hidden
 *               tool, hidden reads would lose their read-only marks, and Grok has a native use_tool.
 *   the rest    have not been shown to qualify. */
export function engineBridgeRefusal(
  cfg: BridgeConfig,
  engine: BridgeEngine | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
  host: EngineHost = { home: homedir(), managedPolicyFiles: claudeManagedPolicyFiles() },
): string | null {
  if (!engine) return "no engine";
  const { driverKind } = engine;
  if (driverKind === "claudeAgent") return claudeRefusal(cfg, engine, env, host);
  if (CHAT_RUNTIME_DRIVERS.has(driverKind)) return null;
  if (driverKind === "codex") return "Codex reads its own layered configuration and hooks, which this version does not examine";
  if (driverKind === "piAgent") return "Pi loads the person's own extensions, which can block a tool by its name, and this version does not examine them";
  return "this engine keeps its own tool permissions";
}

/** Why a turn of `bot` on `engine` is not bridged, or null: the one decision. Security: anything thrown
 * means no bridge, and the log names only the error's class and code, never its message (it may hold a
 * path or file content). */
export function agentsToolBridgeRefusal(
  cfg: BridgeConfig,
  bot: { toolScope?: unknown } | null | undefined,
  engine: BridgeEngine | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
  host?: EngineHost,
): string | null {
  try {
    if (!agentsToolBridgeEnabled(cfg, env)) return "the switch is off";
    // Security: selection gates match the name in the call, so any selection, even one that permits
    // everything or cannot be read, means no bridge.
    const selection = bot ? parseToolScope(bot.toolScope) : undefined;
    if (selection?.ok !== true || selection.scope !== undefined) return "the bot has a tool selection";
    return engineBridgeRefusal(cfg, engine, env, host);
  } catch (error) {
    const kind = logWord(() => (error instanceof Error ? error.name : typeof error));
    const code = logWord(() => (error as { code?: unknown } | null)?.code, true);
    console.warn(`[agents] the tool bridge decision failed (${kind}${code === null ? "" : ` ${code}`}); the turn is not bridged`);
    return "the decision failed";
  }
}

/** A thrown value's `name` or `code` if it is a short safe word, else "unknown"; with `absent`, a missing value is null. */
function logWord(read: () => unknown, absent = false): string | null {
  try {
    const value = read();
    if (absent && (value === undefined || value === null)) return null;
    return typeof value === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(value) ? value : "unknown";
  } catch {
    return "unknown";
  }
}

/** The decision as the agents proxy's environment entry: "1" or "0", never left out. */
export function agentsToolBridgeEnv(
  cfg: BridgeConfig,
  bot: { toolScope?: unknown } | null | undefined,
  engine: BridgeEngine | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
  host?: EngineHost,
): { [TOOL_BRIDGE_ENV]: "1" | "0" } {
  return { [TOOL_BRIDGE_ENV]: agentsToolBridgeRefusal(cfg, bot, engine, env, host) === null ? "1" : "0" };
}

/** Caps the bridged-thread marks so the set cannot grow with every thread ever bridged. */
export const BRIDGED_THREADS_MAX = 5_000;

/** Threads whose turn in flight was asked to bridge, oldest first; a still-running turn whose mark was
 * dropped shows its rows as use_tool. */
const BRIDGED_THREADS = new Set<string>();

/** A turn's agents integration with its bridge decision written in; no agents tools clears the thread's mark. */
export function bridgedAgents<Agents extends { env: Record<string, string> }>(
  threadId: string,
  agents: Agents | undefined,
  cfg: BridgeConfig,
  bot: { toolScope?: unknown } | null | undefined,
  engine: BridgeEngine | null | undefined,
  env?: NodeJS.ProcessEnv,
  host?: EngineHost,
): Agents | undefined {
  BRIDGED_THREADS.delete(threadId);
  if (!agents) return undefined;
  const decided = agentsToolBridgeEnv(cfg, bot, engine, env, host);
  if (decided[TOOL_BRIDGE_ENV] === "1") {
    BRIDGED_THREADS.add(threadId);
    if (BRIDGED_THREADS.size > BRIDGED_THREADS_MAX) BRIDGED_THREADS.delete(BRIDGED_THREADS.values().next().value!);
  }
  return { ...agents, env: { ...agents.env, ...decided } };
}

/** Decides a turn and writes the decision into its integrations in place; call once the turn's folder is
 * known and before its prompt is built. */
export function applyAgentsBridge<Agents extends { env: Record<string, string> }>(
  threadId: string,
  integrations: { agents?: Agents },
  cfg: BridgeConfig,
  bot: { toolScope?: unknown } | null | undefined,
  engine: BridgeEngine | null | undefined,
  env?: NodeJS.ProcessEnv,
  host?: EngineHost,
): void {
  const agents = bridgedAgents(threadId, integrations.agents, cfg, bot, engine, env, host);
  if (agents !== undefined) integrations.agents = agents;
}

/** A tool call's row name: on a bridged turn an agents use_tool naming a catalog tool reads as that tool.
 * Elsewhere use_tool may be another server's (Grok's native one, or one on Codex, whose events omit the server). */
export function bridgedToolTitle(threadId: string, title: string, input: unknown): string {
  return BRIDGED_THREADS.has(threadId) ? bridgedCallName(title, input) : title;
}
