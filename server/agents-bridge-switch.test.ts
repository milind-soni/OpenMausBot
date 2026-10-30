// The harness side of the agents tool bridge (drivers/agents-bridge.ts): the
// switch, the one decision for a turn (which bots, which engines), what the
// prompt builder says on the strength of it, and the name a bridged call is
// given. What the proxy then lists and runs is drivers/agents-bridge.test.ts
// and drivers/agents-proxy.test.ts; its bytes are
// drivers/agents-bridge-wire.test.ts; the mounts that start it unbridged are
// agents-bridge-gates.test.ts; a real turn is agents-bridge.e2e.test.ts.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  AGENTS_PROXY_ENV,
  BRIDGED_THREADS_MAX,
  TOOL_BRIDGE_ENV,
  agentsProxyLaunch,
  agentsToolBridgeEnabled,
  agentsToolBridgeEnv as decide,
  agentsToolBridgeRefusal as refusal,
  applyAgentsBridge,
  bridgedAgents,
  bridgedToolTitle,
  claudeManagedPolicyFiles,
  engineBridgeRefusal,
  turnEngine,
  type BridgeEngine,
  type EngineHost,
} from "./agents-bridge-switch.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { instanceConfigs, parseConfigPatch, parseStoredConfig } from "./config.ts";
import { BRIDGE_HOT_TOOL_NAMES, FIND_TOOL, USE_TOOL, agentsToolBridged } from "./drivers/agents-bridge.ts";
import { SPAWNED_PROXIES } from "./proxy-paths.ts";
import { availableTools } from "./drivers/agents-catalog.ts";
import { WATCHER_OPTIONS_CARD_BOT_ID } from "../shared/options-card.ts";
import { AGENTS_TOOL_BRIDGE_PROMPT, buildSystemPrompt, type PromptPart } from "./system-prompt.ts";

const ON = { features: { agentsToolBridge: true } };
// Every folder a decision below reads is one of these: never the machine's
// own home, project or policy files.
const folders: string[] = [];
const folder = () => { const made = mkdtempSync(join(tmpdir(), "omb-bridge-switch-")); folders.push(made); return made; };
afterAll(async () => { for (const made of folders) await removeTempDir(made); });
/** A machine with no Claude settings anywhere. */
const HOST: EngineHost = { home: folder(), managedPolicyFiles: [join(folder(), "managed-settings.json")] };
/** An engine the bridge is applied on: a current Claude CLI in a folder with no settings of its own. */
const CLAUDE: BridgeEngine = { driverKind: "claudeAgent", version: "2.1.232 (Claude Code)", cwd: folder() };
const agentsToolBridgeEnv = (...args: Parameters<typeof decide> extends [infer A, infer B, infer C, ...unknown[]] ? [A, B, C, NodeJS.ProcessEnv?, EngineHost?] : never) =>
  decide(args[0], args[1], args[2], args[3] ?? {}, args[4] ?? HOST);
const agentsToolBridgeRefusal = (...args: Parameters<typeof refusal> extends [infer A, infer B, infer C, ...unknown[]] ? [A, B, C, NodeJS.ProcessEnv?, EngineHost?] : never) =>
  refusal(args[0], args[1], args[2], args[3] ?? {}, args[4] ?? HOST);
/** Writes one Claude settings file, making its folder. */
const settings = (path: string, content: unknown) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content)); };
// as much of a bot record as the decision reads: one with no tool selection
const bot: { id: string; toolScope?: unknown } = { id: "bot-1" };
const on = { [TOOL_BRIDGE_ENV]: "1" };
const off = { [TOOL_BRIDGE_ENV]: "0" };

describe("the agents tool bridge switch", () => {
  it("is off unless switched on", () => {
    expect(agentsToolBridgeEnabled({}, {})).toBe(false);
    expect(agentsToolBridgeEnabled({ features: {} }, {})).toBe(false);
    expect(agentsToolBridgeEnabled({ features: { agentsToolBridge: false } }, {})).toBe(false);
    expect(agentsToolBridgeEnabled(parseStoredConfig({ features: { skillAuthoring: true, sharedComputers: true } }), {})).toBe(false);
  });

  it("is switched on by the config key or by OMB_AGENTS_TOOL_BRIDGE=1", () => {
    expect(agentsToolBridgeEnabled(ON, {})).toBe(true);
    expect(agentsToolBridgeEnabled({}, { OMB_AGENTS_TOOL_BRIDGE: "1" })).toBe(true);
    expect(TOOL_BRIDGE_ENV).toBe("OMB_AGENTS_TOOL_BRIDGE");
  });

  it("lets the environment override the saved setting either way, and ignores any other value", () => {
    expect(agentsToolBridgeEnabled(ON, { OMB_AGENTS_TOOL_BRIDGE: "0" })).toBe(false);
    expect(agentsToolBridgeEnabled({ features: { agentsToolBridge: false } }, { OMB_AGENTS_TOOL_BRIDGE: "1" })).toBe(true);
    for (const value of ["", "true", "yes", "on", "2"]) {
      expect(agentsToolBridgeEnabled({}, { OMB_AGENTS_TOOL_BRIDGE: value }), value).toBe(false);
      expect(agentsToolBridgeEnabled(ON, { OMB_AGENTS_TOOL_BRIDGE: value }), value).toBe(true);
    }
  });

  it("is a saved setting like the other feature flags: kept by a patch and by the stored file, a boolean only", () => {
    expect(parseConfigPatch({ features: { agentsToolBridge: true } })).toEqual({ features: { agentsToolBridge: true } });
    expect(parseStoredConfig({ features: { agentsToolBridge: true, browser: true } })).toEqual({ features: { agentsToolBridge: true, browser: true } });
    expect(agentsToolBridgeEnabled(parseStoredConfig({ features: { agentsToolBridge: true } }), {})).toBe(true);
    expect(() => parseConfigPatch({ features: { agentsToolBridge: "yes" } })).toThrow("features.agentsToolBridge");
    // the other flags are still read beside it, and an unknown one still drops
    expect(parseConfigPatch({ features: { agentsToolBridge: false, showToolCalls: true, skillRecorder: true } })).toEqual({ features: { agentsToolBridge: false, showToolCalls: true } });
  });
});

describe("which engines a turn is bridged on", () => {
  // The default is no bridge: an engine is bridged only where the harness
  // pre-approves the whole agents server, passes no pattern that names it,
  // and everything else the engine reads about a tool's name can be read too.
  it.each([
    // the chat-completions runtime, by every driver that runs on it
    ["openai-compat"], ["cerebras"], ["grok"], ["groq"], ["meta"], ["minimax"], ["mistral"],
  ])("bridges %s", (driverKind) => {
    expect(engineBridgeRefusal(ON, { driverKind }, {}, HOST)).toBeNull();
    expect(agentsToolBridgeEnv(ON, bot, { driverKind }, {})).toEqual(on);
  });

  it("bridges Claude Code, on a current CLI in a folder whose settings name none of these tools", () => {
    expect(engineBridgeRefusal(ON, CLAUDE, {}, HOST)).toBeNull();
    expect(agentsToolBridgeEnv(ON, bot, CLAUDE, {})).toEqual(on);
  });

  it("does not bridge Codex: it reads a layered configuration and hooks of its own that are not examined", () => {
    // ~/.codex/config.toml or CODEX_HOME, a Company engine's own home under
    // this server's data, a trusted project's .codex/config.toml,
    // /etc/codex/config.toml and managed_config.toml, and its PreToolUse and
    // PermissionRequest hooks: each can take a rule about a tool by name.
    const reason = "Codex reads its own layered configuration and hooks, which this version does not examine";
    expect(engineBridgeRefusal(ON, { driverKind: "codex", instanceId: "codex" }, {}, HOST)).toBe(reason);
    expect(engineBridgeRefusal(ON, { driverKind: "codex", instanceId: "chatgpt", config: { authMode: "chatgpt-plan" } }, {}, HOST)).toBe(reason);
    // whatever its environment says about where that configuration is
    expect(agentsToolBridgeEnv(ON, bot, { driverKind: "codex", environment: { CODEX_HOME: join(folder(), "gone") } }, { HOME: folder() })).toEqual(off);
    expect(agentsToolBridgeEnv({}, bot, { driverKind: "codex" }, { OMB_AGENTS_TOOL_BRIDGE: "1" })).toEqual(off);
  });

  it("does not bridge Pi: it loads the person's own extensions, which can block a tool by its name", () => {
    // pi is launched with -e for this server's extension and nothing that
    // keeps its own out (drivers/pi.ts PI_ARGS), in the person's home. An
    // extension's tool_call handler sees the name in the call, as this
    // server's own does (drivers/pi-mcp-extension.ts).
    const reason = "Pi loads the person's own extensions, which can block a tool by its name, and this version does not examine them";
    expect(engineBridgeRefusal(ON, { driverKind: "piAgent", instanceId: "pi" }, {}, HOST)).toBe(reason);
    expect(engineBridgeRefusal(ON, { driverKind: "piAgent", cwd: folder() }, {}, HOST)).toBe(reason);
    expect(agentsToolBridgeEnv(ON, bot, { driverKind: "piAgent" }, {})).toEqual(off);
    expect(agentsToolBridgeEnv({}, bot, { driverKind: "piAgent" }, { OMB_AGENTS_TOOL_BRIDGE: "1" })).toEqual(off);
  });

  it.each([
    // ACP agents keep their own permissions, Grok among them
    ["grokAgent"], ["geminiAgent"], ["qwenAgent"], ["kimiAgent"], ["droidAgent"], ["cursorAgent"], ["clineAgent"], ["copilotAgent"], ["hermesAgent"],
    ["opencodeGo"], ["antigravityAgent"], ["customAcp"],
    // not shown to qualify, and anything nobody has heard of
    ["museCode"], ["someFutureDriver"], [""],
  ])("does not bridge %s", (driverKind) => {
    expect(engineBridgeRefusal(ON, { driverKind, version: "2.1.232" }, {}, HOST)).toEqual(expect.any(String));
    expect(agentsToolBridgeEnv(ON, bot, { driverKind }, {})).toEqual(off);
    expect(agentsToolBridgeEnv({}, bot, { driverKind }, { OMB_AGENTS_TOOL_BRIDGE: "1" })).toEqual(off);
  });

  it("does not bridge a turn with no engine at all", () => {
    expect(agentsToolBridgeEnv(ON, bot, undefined, {})).toEqual(off);
  });

  it("sorts the default fleet the same way: its Claude and API-model engines, and none of Codex, Pi or its ACP agents", () => {
    const fleet = instanceConfigs({});
    const bridged = new Set(Object.entries(fleet).filter(([, instance]) => engineBridgeRefusal(ON, turnEngine({ instanceId: "any", driverKind: instance.driver }, { any: instance }, { version: "2.1.232 (Claude Code)" }, CLAUDE.cwd), {}, HOST) === null).map(([id]) => id));
    for (const id of ["claude", "openaiCompat", "mistral", "cerebras", "groq", "meta"]) expect(bridged.has(id), id).toBe(true);
    // the default `grok` is the ACP agent, not the API-key driver
    for (const id of ["codex", "chatgpt", "pi", "grok", "kimi", "droid", "cursor", "antigravity", "opencodeGo", "museCode", "qwen", "hermes", "cline"]) expect(bridged.has(id), id).toBe(false);
    for (const id of bridged) expect(["claudeAgent", "openai-compat", "cerebras", "grok", "groq", "meta", "minimax", "mistral"], id).toContain(fleet[id]!.driver);
  });

  describe("Claude Code's exceptions", () => {
    it("is not bridged when the bot inherits this machine's own Claude Code setup", () => {
      // settings the harness never sees may deny an agents tool by name
      expect(agentsToolBridgeEnv(ON, bot, CLAUDE, { OMB_CLAUDE_INHERIT_USER_CONFIG: "1" })).toEqual(off);
      expect(agentsToolBridgeEnv(ON, bot, { ...CLAUDE, environment: { OMB_CLAUDE_INHERIT_USER_CONFIG: "1" } }, {})).toEqual(off);
      // the instance's environment is laid over the server's, as the driver lays it
      expect(agentsToolBridgeEnv(ON, bot, { ...CLAUDE, environment: { OMB_CLAUDE_INHERIT_USER_CONFIG: "0" } }, { OMB_CLAUDE_INHERIT_USER_CONFIG: "1" })).toEqual(on);
      // and the person's own Claude Code MCP servers are part of that setup
      expect(agentsToolBridgeEnv({ features: { agentsToolBridge: true, claudeUserMcp: true } }, bot, CLAUDE, {})).toEqual(off);
      expect(agentsToolBridgeEnv({ features: { agentsToolBridge: true, claudeUserMcp: false } }, bot, CLAUDE, {})).toEqual(on);
      // neither is a reason on another engine
      expect(agentsToolBridgeEnv({ features: { agentsToolBridge: true, claudeUserMcp: true } }, bot, { driverKind: "openai-compat" }, { OMB_CLAUDE_INHERIT_USER_CONFIG: "1" })).toEqual(on);
    });

    const PATTERNS = "the engine's tool patterns name the agents server or match tools by pattern";

    it.each([
      [{ disallowedTools: ["mcp__agents__vm_exec"] }],
      [{ disallowedTools: ["Bash", "mcp__agents"] }],
      [{ disallowedTools: ["MCP__Agents__start_thread"] }],
      // a wildcard in the server position may reach the agents server
      [{ disallowedTools: ["mcp__*"] }],
      [{ disallowedTools: ["MCP__*"] }],
      [{ disallowedTools: ["mcp__*__vm_exec"] }],
      [{ disallowedTools: ["mcp__?__vm_exec"] }],
      [{ tools: ["Read", "mcp__agents__list_bots"] }],
      // The driver takes any text as an entry and joins the entries with a
      // comma for the CLI, so one entry can hold several patterns.
      [{ disallowedTools: ["Bash,mcp__agents__vm_exec"] }],
      [{ disallowedTools: ["Bash, mcp__agents__vm_exec"] }],
      [{ disallowedTools: ["Bash(rm *),mcp__agents__vm_exec"] }],
      [{ disallowedTools: ["Read", "Edit mcp__agents__start_thread"] }],
      [{ disallowedTools: ["Bash,mcp__*"] }],
      // "contains", as for a settings file: a server whose name merely starts the same way counts
      [{ disallowedTools: ["mcp__agentsmith__run"] }],
      // The CLI matches a deny rule's whole tool name as a glob, so a
      // wildcard anywhere in a tool's name can reach an agents tool, whatever
      // else the rule says. "In a tool's name" is outside parentheses, with
      // one flag set at "(" and cleared at ")", as the CLI splits the list.
      [{ disallowedTools: ["*"] }],
      [{ disallowedTools: ["mcp__a*__vm_exec"] }],
      [{ disallowedTools: ["*exec*"] }],
      [{ disallowedTools: ["*__vm_exec"] }],
      [{ disallowedTools: ["mcp_*"] }],
      [{ disallowedTools: ["mcp__composio__*"] }],
      [{ disallowedTools: ["Bash", "WebFetch", "mcp__composio__GMAIL_SEND_EMAIL", "mcp__composio__*"] }],
      [{ disallowedTools: ["Read?"] }],
      [{ tools: ["Read", "Edi*"] }],
      [{ disallowedTools: ["Bash(echo ( x),mcp__a*__vm_exec"] }],
      [{ disallowedTools: ["Bash(\\(a),*exec*"] }],
      [{ disallowedTools: ["Bash(a),mcp__a*__vm_exec,Read(b)"] }],
      [{ disallowedTools: ["Bash(a)*"] }],
      // a list the driver itself would refuse is never a reason to bridge
      [{ disallowedTools: "mcp__agents__vm_exec" }],
      [{ disallowedTools: [7] }],
    ])("is not bridged when a pattern the CLI is handed names the agents server or matches tools by pattern: %j", (config) => {
      expect(agentsToolBridgeRefusal(ON, bot, { ...CLAUDE, config }, {})).toBe(PATTERNS);
      expect(agentsToolBridgeEnv(ON, bot, { ...CLAUDE, config }, {})).toEqual(off);
    });

    it.each([
      [undefined], [{}], [{ disallowedTools: [] }], [{ disallowedTools: ["Bash", "WebFetch", "mcp__composio__GMAIL_SEND_EMAIL", "Bash(git *),mcp__notes__read"] }],
      [{ tools: ["Read", "Grep"], disallowedTools: ["Bash(rm *)"] }], [{ cli: "claude", permissionMode: "auto" }],
      // a wildcard inside the parentheses is in the rule's specifier, not in a tool's name
      [{ disallowedTools: ["Bash(git *)"] }], [{ disallowedTools: ["Read(./src/**)"] }], [{ disallowedTools: ["Bash(npm run test:*)"] }],
      [{ disallowedTools: ["Bash(git *),Read(./src/**)", "WebFetch(domain:*.example.com)"] }],
    ])("is bridged when none of them does: %j", (config) => {
      expect(agentsToolBridgeEnv(ON, bot, { ...CLAUDE, config }, {})).toEqual(on);
    });

    it("decides an entry of many wildcards at once: no pattern is ever built from configuration text", () => {
      // Built into a regular expression, this entry took about a minute of
      // the server's one thread to test against the catalog's names. It is a
      // wildcard in a tool's name, so it refuses, and the test's own timeout
      // is the guard: a regression takes minutes.
      const stars = "**********#";
      expect(agentsToolBridgeRefusal(ON, bot, { ...CLAUDE, config: { disallowedTools: [stars] } }, {})).toBe(PATTERNS);
      expect(agentsToolBridgeRefusal(ON, bot, { ...CLAUDE, config: { tools: [stars, `${stars}${stars}`] } }, {})).toBe(PATTERNS);
      expect(agentsToolBridgeRefusal(ON, bot, inFolder("settings.json", { permissions: { deny: [stars] } }))).toBe(WILDCARD);
      // an allow rule does not glob
      expect(agentsToolBridgeEnv(ON, bot, inFolder("settings.json", { permissions: { allow: [stars] } }))).toEqual(on);
    });

    it("is not bridged when a settings file's deny or ask rules match tools by pattern, whatever server they are about", () => {
      // The CLI matches a deny or ask rule's whole tool name as a glob, so
      // such a rule can reach a MausBot tool by pattern even when it was
      // written for another server; allow rules do not glob.
      expect(agentsToolBridgeRefusal(ON, bot, inFolder("settings.json", { permissions: { deny: ["mcp__github__*"] } }))).toBe(WILDCARD);
      expect(agentsToolBridgeRefusal(ON, bot, inFolder("settings.json", { permissions: { ask: ["*exec*"] } }))).toBe(WILDCARD);
      expect(agentsToolBridgeRefusal(ON, bot, inFolder("settings.local.json", { permissions: { deny: ["Bash(a)", "mcp__a*__vm_exec"] } }))).toBe(WILDCARD);
      expect(agentsToolBridgeRefusal(ON, bot, inFolder("settings.json", { permissions: { deny: ["Read?"] } }))).toBe(WILDCARD);
      // the keys in any case, as for hooks
      expect(agentsToolBridgeRefusal(ON, bot, inFolder("settings.json", { Permissions: { DENY: ["*"] } }))).toBe(WILDCARD);
      expect(agentsToolBridgeRefusal(ON, bot, inFolder("settings.json", { permissions: { Ask: ["mcp__github__*"] } }))).toBe(WILDCARD);
      const policy = join(folder(), "managed-settings.json");
      settings(policy, { permissions: { deny: ["mcp__github__*"] } });
      expect(agentsToolBridgeRefusal(ON, bot, CLAUDE, {}, { ...HOST, managedPolicyFiles: [policy] })).toBe(WILDCARD);
      // naming the agents server is still the first thing seen
      expect(agentsToolBridgeRefusal(ON, bot, inFolder("settings.json", { permissions: { deny: ["mcp__github__*", "mcp__agents__vm_exec"] } }))).toBe(NAMES);
      // not given the wildcard test: allow rules, additional directories, anything outside permissions
      expect(agentsToolBridgeEnv(ON, bot, inFolder("settings.json", { permissions: { allow: ["mcp__github__*", "*"] } }))).toEqual(on);
      expect(agentsToolBridgeEnv(ON, bot, inFolder("settings.json", { permissions: { additionalDirectories: ["/tmp/*"], deny: ["Bash(git *)", "Read(./src/**)", "Bash(npm run test:*)"] } }))).toEqual(on);
      expect(agentsToolBridgeEnv(ON, bot, inFolder("settings.json", { env: { GLOB: "*" }, deny: ["*"], hooks: { PostToolUse: [{ matcher: "*", hooks: [] }] } }))).toEqual(on);
      // a rule that is not a string is walked like anything else
      expect(agentsToolBridgeEnv(ON, bot, inFolder("settings.json", { permissions: { deny: [{ tool: "Bash" }, 7] } }))).toEqual(on);
    });

    it("is not bridged when a managed policy allows only its own permission rules, which may void the pre-approval", () => {
      const only = (content: unknown) => { const policy = join(folder(), "managed-settings.json"); settings(policy, content); return { ...HOST, managedPolicyFiles: [policy] }; };
      expect(agentsToolBridgeRefusal(ON, bot, CLAUDE, {}, only({ allowManagedPermissionRulesOnly: true }))).toBe(MANAGED_ONLY);
      // any value but false or null, the key in any case, in a drop-in too
      expect(agentsToolBridgeRefusal(ON, bot, CLAUDE, {}, only({ allowmanagedpermissionrulesonly: 1 }))).toBe(MANAGED_ONLY);
      expect(agentsToolBridgeRefusal(ON, bot, CLAUDE, {}, only({ AllowManagedPermissionRulesOnly: "yes" }))).toBe(MANAGED_ONLY);
      const base = folder();
      settings(join(base, "managed-settings.d", "10-rules.json"), { allowManagedPermissionRulesOnly: {} });
      expect(agentsToolBridgeRefusal(ON, bot, CLAUDE, {}, { ...HOST, managedPolicyFiles: [join(base, "managed-settings.json")] })).toBe(MANAGED_ONLY);
      expect(agentsToolBridgeEnv(ON, bot, CLAUDE, {}, only({ allowManagedPermissionRulesOnly: false }))).toEqual(on);
      expect(agentsToolBridgeEnv(ON, bot, CLAUDE, {}, only({ allowManagedPermissionRulesOnly: null }))).toEqual(on);
      expect(agentsToolBridgeEnv(ON, bot, CLAUDE, {}, only({ permissions: { allow: ["Read"] } }))).toEqual(on);
      // the key means nothing in a project's or folder's own settings
      expect(agentsToolBridgeEnv(ON, bot, inFolder("settings.json", { allowManagedPermissionRulesOnly: true }))).toEqual(on);
      expect(agentsToolBridgeEnv(ON, bot, inFolder("settings.local.json", { allowManagedPermissionRulesOnly: true }))).toEqual(on);
    });

    // An isolated turn is launched with --setting-sources project, so the
    // CLI still reads the settings of the folder it is launched in, and the
    // machine's managed policy always applies.
    const NAMES = "a Claude settings file names the agents server";
    const HOOKS = "a Claude settings file sets a hook that judges tool calls";
    const WILDCARD = "a Claude settings file denies or asks for tools by pattern";
    const MANAGED_ONLY = "a managed Claude policy allows only its own permission rules";
    const UNREADABLE = "a Claude settings file cannot be read";
    const inFolder = (file: string, content: unknown) => { const cwd = folder(); settings(join(cwd, ".claude", file), content); return { ...CLAUDE, cwd }; };

    it("is not bridged when the project's settings name the agents server anywhere", () => {
      expect(agentsToolBridgeRefusal(ON, bot, inFolder("settings.json", { permissions: { deny: ["Bash(rm *)", "mcp__agents__vm_exec"] } }))).toBe(NAMES);
      expect(agentsToolBridgeEnv(ON, bot, inFolder("settings.json", { permissions: { ask: ["mcp__agents"] } }))).toEqual(off);
      // anywhere in the file, however it is nested or cased: a rule, a hook's matcher, a note
      expect(agentsToolBridgeEnv(ON, bot, inFolder("settings.json", { permissions: { rules: [{ tool: "MCP__Agents__start_thread", effect: "deny" }] } }))).toEqual(off);
      expect(agentsToolBridgeRefusal(ON, bot, inFolder("settings.json", { hooks: { PostToolUse: [{ matcher: "mcp__agents__vm_exec", hooks: [{ type: "command", command: "audit.sh" }] }] } }))).toBe(NAMES);
      expect(agentsToolBridgeRefusal(ON, bot, inFolder("settings.json", { env: { NOTE: "mcp__agents__vm_exec" }, permissions: { allow: ["Read"] } }))).toBe(NAMES);
      expect(agentsToolBridgeEnv(ON, bot, inFolder("settings.json", { permissions: { allow: ["mcp__agents__list_bots"] } }))).toEqual(off);
      // the test is "contains", so a server whose name merely starts the same way counts too: the cautious side
      expect(agentsToolBridgeEnv(ON, bot, inFolder("settings.json", { permissions: { deny: ["mcp__agentsmith__run"] } }))).toEqual(off);
      // a wildcard in the server position, the same test as for the engine's own pattern lists
      expect(agentsToolBridgeRefusal(ON, bot, inFolder("settings.json", { permissions: { deny: ["mcp__*__vm_exec"] } }))).toBe(NAMES);
      expect(agentsToolBridgeRefusal(ON, bot, inFolder("settings.local.json", { permissions: { allow: ["Read", "MCP__?"] } }))).toBe(NAMES);
    });

    it("is not bridged when the name is spelled with JSON escapes, which the raw text does not show", () => {
      // "mcp__agents" is "mcp__agents" once parsed: every string value and every key is walked
      expect(agentsToolBridgeRefusal(ON, bot, inFolder("settings.json", '{"permissions":{"deny":["mcp\\u005f\\u005fagents\\u005f\\u005fvm_exec"]}}'))).toBe(NAMES);
      expect(agentsToolBridgeRefusal(ON, bot, inFolder("settings.json", '{"permissions":{"deny":["\\u006dcp__*"]}}'))).toBe(NAMES);
      expect(agentsToolBridgeRefusal(ON, bot, inFolder("settings.local.json", '{"hooks":{"PostToolUse":[{"matcher":"MCP\\u005f\\u005fAGENTS","hooks":[]}]}}'))).toBe(NAMES);
      expect(agentsToolBridgeRefusal(ON, bot, inFolder("settings.json", '{"env":{"mcp\\u005f\\u005fagents":"1"}}'))).toBe(NAMES);
      // deep in a list of lists, as a key
      expect(agentsToolBridgeRefusal(ON, bot, inFolder("settings.json", '{"a":[[{"MCP\\u005f\\u005fAgents\\u005f\\u005fvm_exec":true}]]}'))).toBe(NAMES);
      // the escaped spelling of something else is read for what it is
      expect(agentsToolBridgeEnv(ON, bot, inFolder("settings.json", '{"permissions":{"deny":["mcp\\u005f\\u005fcomposio"]}}'))).toEqual(on);
    });

    it("is not bridged when the folder's local settings do", () => {
      expect(agentsToolBridgeRefusal(ON, bot, inFolder("settings.local.json", { permissions: { deny: ["mcp__agents__shared_computer"] } }))).toBe(NAMES);
    });

    it("is not bridged when the machine's managed policy does", () => {
      const policy = join(folder(), "managed-settings.json");
      settings(policy, { permissions: { deny: ["mcp__agents__vm_exec"] } });
      expect(agentsToolBridgeRefusal(ON, bot, CLAUDE, {}, { ...HOST, managedPolicyFiles: [policy] })).toBe(NAMES);
      // every documented location is read: the rule may be in the second
      expect(agentsToolBridgeEnv(ON, bot, CLAUDE, {}, { ...HOST, managedPolicyFiles: [join(folder(), "absent.json"), policy] })).toEqual(off);
    });

    it("reads the folder the turn is launched in: the person's home when the turn has none", () => {
      // drivers/claude.ts launches in turn.cwd ?? homedir()
      const home = folder();
      settings(join(home, ".claude", "settings.json"), { permissions: { deny: ["mcp__agents__vm_exec"] } });
      expect(agentsToolBridgeEnv(ON, bot, { ...CLAUDE, cwd: undefined }, {}, { ...HOST, home })).toEqual(off);
      expect(agentsToolBridgeEnv(ON, bot, { ...CLAUDE, cwd: undefined }, {})).toEqual(on);
      // and never the home when the turn has a folder of its own
      expect(agentsToolBridgeEnv(ON, bot, CLAUDE, {}, { ...HOST, home })).toEqual(on);
    });

    it.each([
      ["{ not json"], [""], ["null"], ["[]"], ['"mcp__composio"'],
    ])("is not bridged when a settings file is there and cannot be read as settings: %j", (content) => {
      expect(agentsToolBridgeRefusal(ON, bot, inFolder("settings.json", content))).toBe(UNREADABLE);
      expect(agentsToolBridgeRefusal(ON, bot, inFolder("settings.local.json", content))).toBe(UNREADABLE);
    });

    it("is not bridged when something that is not a file sits where a settings file would", () => {
      const cwd = folder();
      mkdirSync(join(cwd, ".claude", "settings.json"), { recursive: true });
      expect(agentsToolBridgeRefusal(ON, bot, { ...CLAUDE, cwd })).toBe(UNREADABLE);
    });

    it("is bridged when the files are absent, or neither name the agents server nor judge tool calls", () => {
      expect(agentsToolBridgeEnv(ON, bot, { ...CLAUDE, cwd: folder() })).toEqual(on);
      // a folder that is not there at all has no settings either
      expect(agentsToolBridgeEnv(ON, bot, { ...CLAUDE, cwd: join(folder(), "gone") })).toEqual(on);
      expect(agentsToolBridgeEnv(ON, bot, inFolder("settings.json", {}))).toEqual(on);
      expect(agentsToolBridgeEnv(ON, bot, inFolder("settings.json", { permissions: { deny: ["Bash(rm *)", "mcp__composio__GMAIL_SEND_EMAIL", "mcp__notes"], allow: ["Read"] } }))).toEqual(on);
      // hooks that only watch what happened are no judge of a call
      const watching = [{ matcher: "", hooks: [{ type: "command", command: "log.sh" }] }];
      expect(agentsToolBridgeEnv(ON, bot, inFolder("settings.json", { hooks: { PostToolUse: watching, Stop: watching, SessionStart: watching, PreCompact: watching } }))).toEqual(on);
      // a key that holds null, or is not there, sets none
      expect(agentsToolBridgeEnv(ON, bot, inFolder("settings.json", { hooks: { PreToolUse: null, PermissionRequest: null } }))).toEqual(on);
      expect(agentsToolBridgeEnv(ON, bot, inFolder("settings.json", { hooks: {} }))).toEqual(on);
      // "hooks" somewhere other than as a key is a word, not a block
      expect(agentsToolBridgeEnv(ON, bot, inFolder("settings.json", { permissions: { deny: ["hooks", "PreToolUse"] } }))).toEqual(on);
    });

    it.each([
      // whatever it matches: a script can test the name itself, and an empty or wildcard matcher sees every call
      [{ PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "check.sh" }] }] }],
      [{ PreToolUse: [{ matcher: "", hooks: [{ type: "command", command: "check.sh" }] }] }],
      [{ PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "check.sh" }] }] }],
      [{ PermissionRequest: [{ hooks: [{ type: "command", command: "decide.sh" }] }] }],
      // any value but null: a list of none, a string, an object, a number
      [{ PreToolUse: [] }],
      [{ PermissionRequest: [] }],
      [{ PreToolUse: "check.sh" }],
      [{ PermissionRequest: { matcher: "" } }],
      [{ PreToolUse: 0 }],
      [{ PreToolUse: false }],
      // in any case: the key is compared case-insensitively
      [{ pretooluse: [{ matcher: "Bash", hooks: [{ type: "command", command: "check.sh" }] }] }],
      [{ preToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "check.sh" }] }] }],
      [{ PRETOOLUSE: [] }],
      [{ permissionrequest: [{ hooks: [{ type: "command", command: "decide.sh" }] }] }],
      [{ PermissionREQUEST: {} }],
    ])("is not bridged when a settings file sets a hook that judges tool calls: %j", (hooks) => {
      expect(agentsToolBridgeRefusal(ON, bot, inFolder("settings.json", { hooks }))).toBe(HOOKS);
      expect(agentsToolBridgeRefusal(ON, bot, inFolder("settings.local.json", { hooks }))).toBe(HOOKS);
      const policy = join(folder(), "managed-settings.json");
      settings(policy, { hooks });
      expect(agentsToolBridgeRefusal(ON, bot, CLAUDE, {}, { ...HOST, managedPolicyFiles: [policy] })).toBe(HOOKS);
      // and so is the outer key, wherever the block sits
      expect(agentsToolBridgeRefusal(ON, bot, inFolder("settings.json", { Hooks: hooks }))).toBe(HOOKS);
      expect(agentsToolBridgeRefusal(ON, bot, inFolder("settings.json", { HOOKS: hooks }))).toBe(HOOKS);
      expect(agentsToolBridgeRefusal(ON, bot, inFolder("settings.json", { profiles: [{ hooks }] }))).toBe(HOOKS);
    });

    it("is not bridged when a file's hooks cannot be read as hooks", () => {
      expect(agentsToolBridgeRefusal(ON, bot, inFolder("settings.json", { hooks: "PreToolUse" }))).toBe(UNREADABLE);
      expect(agentsToolBridgeRefusal(ON, bot, inFolder("settings.json", { hooks: [] }))).toBe(UNREADABLE);
      expect(agentsToolBridgeRefusal(ON, bot, inFolder("settings.json", { Hooks: 1 }))).toBe(UNREADABLE);
    });

    it("is not bridged when a settings file is larger than it reads, and does not read it", () => {
      // valid, harmless settings, one byte past the cap
      const padded = (bytes: number) => `{${" ".repeat(bytes - 2)}}`;
      const cwd = folder();
      settings(join(cwd, ".claude", "settings.json"), padded(1024 * 1024 + 1));
      expect(agentsToolBridgeRefusal(ON, bot, { ...CLAUDE, cwd })).toBe(UNREADABLE);
      // at the cap it is read
      const fits = folder();
      settings(join(fits, ".claude", "settings.json"), padded(1024 * 1024));
      expect(agentsToolBridgeEnv(ON, bot, { ...CLAUDE, cwd: fits })).toEqual(on);
    });

    it.skipIf(process.platform === "win32")("is not bridged when a FIFO sits where a settings file would, and does not open it", () => {
      // A writer stands ready with harmless settings: were the FIFO opened
      // and read, the turn would be bridged. It is refused on sight, and the
      // writer never gets to write.
      const cwd = folder();
      mkdirSync(join(cwd, ".claude"));
      const fifo = join(cwd, ".claude", "settings.json");
      execFileSync("mkfifo", [fifo]);
      const writer = spawn("sh", ["-c", 'echo "{}" > "$0"', fifo], { stdio: "ignore" });
      try {
        expect(agentsToolBridgeRefusal(ON, bot, { ...CLAUDE, cwd })).toBe(UNREADABLE);
      } finally {
        writer.kill("SIGKILL");
      }
    });

    it.skipIf(process.platform === "win32")("is not bridged when a device sits where a settings file would", () => {
      // reached through a link, as the CLI would reach it; its text, "", would read as unreadable anyway, so the reason is the same
      const cwd = folder();
      mkdirSync(join(cwd, ".claude"));
      symlinkSync("/dev/null", join(cwd, ".claude", "settings.json"));
      expect(agentsToolBridgeRefusal(ON, bot, { ...CLAUDE, cwd })).toBe(UNREADABLE);
    });

    it("reads every settings file in the managed policy's drop-in folder", () => {
      const base = folder();
      const host = { ...HOST, managedPolicyFiles: [join(base, "managed-settings.json")] };
      // no such folder: nothing to read
      expect(agentsToolBridgeEnv(ON, bot, CLAUDE, {}, host)).toEqual(on);
      settings(join(base, "managed-settings.d", "10-defaults.json"), { permissions: { deny: ["WebFetch"] } });
      settings(join(base, "managed-settings.d", "notes.txt"), "mcp__agents__vm_exec is mentioned here, in a file the CLI does not read");
      expect(agentsToolBridgeEnv(ON, bot, CLAUDE, {}, host)).toEqual(on);
      settings(join(base, "managed-settings.d", "20-tools.json"), { permissions: { deny: ["mcp__agents__vm_exec"] } });
      expect(agentsToolBridgeRefusal(ON, bot, CLAUDE, {}, host)).toBe(NAMES);
      // one that is there and cannot be read
      const broken = folder();
      settings(join(broken, "managed-settings.d", "10-defaults.json"), "{ not json");
      expect(agentsToolBridgeRefusal(ON, bot, CLAUDE, {}, { ...HOST, managedPolicyFiles: [join(broken, "managed-settings.json")] })).toBe(UNREADABLE);
      // and something that is not a folder where the folder would be
      const odd = folder();
      settings(join(odd, "managed-settings.d"), "not a folder");
      expect(agentsToolBridgeRefusal(ON, bot, CLAUDE, {}, { ...HOST, managedPolicyFiles: [join(odd, "managed-settings.json")] })).toBe(UNREADABLE);
    });

    it.each([
      ["1.0.121 (Claude Code)"], ["1.0.0"], ["0.2.9 (Claude Code)"],
    ])("is not bridged on a CLI older than the one that keeps the person's settings out: %s", (version) => {
      expect(agentsToolBridgeRefusal(ON, bot, { ...CLAUDE, version })).toBe("the Claude CLI is too old to leave the person's own settings out");
    });

    it.each([[undefined], [null], [""], ["Claude Code"], ["wrapper v2"]])("is not bridged when the harness does not know the CLI's version: %j", (version) => {
      expect(agentsToolBridgeRefusal(ON, bot, { ...CLAUDE, version })).toBe("the Claude CLI's version is not known");
    });

    it("is bridged from the first CLI that takes --setting-sources", () => {
      for (const version of ["1.0.122 (Claude Code)", "1.0.122", "2.1.232 (Claude Code)", "3.0.0"]) expect(agentsToolBridgeEnv(ON, bot, { ...CLAUDE, version }), version).toEqual(on);
    });

    it("reads none of this for another engine", () => {
      const cwd = inFolder("settings.json", { permissions: { deny: ["mcp__agents__vm_exec"] } }).cwd;
      for (const driverKind of ["openai-compat", "mistral"]) expect(agentsToolBridgeEnv(ON, bot, { driverKind, cwd }), driverKind).toEqual(on);
    });
  });

  it("knows where a machine's managed Claude policy lives, on each platform", () => {
    expect(claudeManagedPolicyFiles("darwin")).toEqual(["/Library/Application Support/ClaudeCode/managed-settings.json"]);
    expect(claudeManagedPolicyFiles("linux")).toEqual(["/etc/claude-code/managed-settings.json"]);
    expect(claudeManagedPolicyFiles("win32")).toEqual(["C:\\Program Files\\ClaudeCode\\managed-settings.json", "C:\\ProgramData\\ClaudeCode\\managed-settings.json"]);
    expect(claudeManagedPolicyFiles("freebsd")).toEqual(claudeManagedPolicyFiles("linux"));
  });

  it("describes a turn's engine from what the harness holds: the instance, its config, its last snapshot and the turn's folder", () => {
    const configs = { claude: { driver: "claudeAgent", config: { disallowedTools: ["Bash"] }, environment: { OMB_CLAUDE_INHERIT_USER_CONFIG: "0" } } };
    expect(turnEngine({ instanceId: "claude", driverKind: "claudeAgent" }, configs, { version: "2.1.232 (Claude Code)" }, "/work/site")).toEqual({
      driverKind: "claudeAgent", instanceId: "claude", config: { disallowedTools: ["Bash"] }, environment: { OMB_CLAUDE_INHERIT_USER_CONFIG: "0" }, version: "2.1.232 (Claude Code)", cwd: "/work/site",
    });
    // nothing configured, never described, no folder of its own
    expect(turnEngine({ instanceId: "pi", driverKind: "piAgent" }, {}, undefined, undefined)).toEqual({ driverKind: "piAgent", instanceId: "pi" });
  });
});

describe("which bots a turn is bridged for", () => {
  it("writes the switch on every turn, so a value inherited from the server's own environment cannot stand in", () => {
    expect(agentsToolBridgeEnv({}, bot, CLAUDE, {})).toEqual(off);
    expect(agentsToolBridgeEnv(ON, bot, CLAUDE, {})).toEqual(on);
    expect(agentsToolBridgeEnv({}, bot, CLAUDE, { OMB_AGENTS_TOOL_BRIDGE: "1" })).toEqual(on);
    expect(agentsToolBridgeEnv(ON, bot, CLAUDE, { OMB_AGENTS_TOOL_BRIDGE: "0" })).toEqual(off);
    expect(Object.keys(agentsToolBridgeEnv(ON, bot, CLAUDE, {}))).toEqual([TOOL_BRIDGE_ENV]);
    expect(agentsToolBridgeRefusal({}, bot, CLAUDE, {})).toBe("the switch is off");
  });

  it("starts every agents proxy unbridged until a turn's decision says otherwise", () => {
    // what server/index.ts spreads into each agents integration it builds
    expect(agentsProxyLaunch()).toEqual({ command: process.execPath, args: [SPAWNED_PROXIES.agents] });
    expect(AGENTS_PROXY_ENV).toEqual({ ELECTRON_RUN_AS_NODE: "1", OMB_AGENTS_TOOL_BRIDGE: "0" });
  });

  it("gives back the integration a turn mounts with the decision in it, over whatever it carried, and leaves the rest alone", () => {
    const agents = { command: "node", args: ["agents-proxy.js"], env: { OMB_BOT_ID: "bot-1", OMB_AGENTS_TOOL_BRIDGE: "0", OMB_COMMS_TOKEN: "t" } };
    const mounted = bridgedAgents("thread-mount", agents, ON, bot, CLAUDE, {}, HOST);
    expect(mounted).toEqual({ command: "node", args: ["agents-proxy.js"], env: { OMB_BOT_ID: "bot-1", OMB_AGENTS_TOOL_BRIDGE: "1", OMB_COMMS_TOKEN: "t" } });
    // a new value for the turn to assign: what was handed in is not rewritten
    expect(agents.env.OMB_AGENTS_TOOL_BRIDGE).toBe("0");
    const asked = { ...agents, env: { ...agents.env, OMB_AGENTS_TOOL_BRIDGE: "1" } };
    expect(bridgedAgents("thread-mount-acp", asked, ON, bot, { driverKind: "grokAgent" }, {}, HOST)!.env.OMB_AGENTS_TOOL_BRIDGE).toBe("0");
    // a turn that mounts no agents tools has nothing to decide
    expect(bridgedAgents("thread-mount-none", undefined, ON, bot, CLAUDE, {}, HOST)).toBeUndefined();
    expect(agentsToolBridged(mounted)).toBe(true);
    expect(agentsToolBridged(agents)).toBe(false);
    // no agents tools mounted, or an integration that says nothing: no bridge
    for (const none of [undefined, {}, { env: {} }, { env: { OMB_AGENTS_TOOL_BRIDGE: "true" } }]) expect(agentsToolBridged(none)).toBe(false);
  });

  it("writes the decision into the integrations a turn mounts, and gives a turn with no agents tools no agents key at all", () => {
    // what server/index.ts does once per turn, before the prompt is built
    const integrations: { agents?: { command: string; args: string[]; env: Record<string, string> }; composio?: { env: Record<string, string> } } = { composio: { env: { KEY: "k" } } };
    applyAgentsBridge("thread-apply-none", integrations, ON, bot, CLAUDE, {}, HOST);
    expect(Object.hasOwn(integrations, "agents")).toBe(false);
    expect(integrations).toEqual({ composio: { env: { KEY: "k" } } });
    const mounted = { agents: { command: "node", args: ["agents-proxy.js"], env: { OMB_BOT_ID: "bot-1", OMB_AGENTS_TOOL_BRIDGE: "0" } } };
    applyAgentsBridge("thread-apply", mounted, ON, bot, CLAUDE, {}, HOST);
    expect(mounted.agents).toEqual({ command: "node", args: ["agents-proxy.js"], env: { OMB_BOT_ID: "bot-1", OMB_AGENTS_TOOL_BRIDGE: "1" } });
    expect(agentsToolBridged(mounted.agents)).toBe(true);
    expect(bridgedToolTitle("thread-apply", "use_tool", { name: "list_triggers" })).toBe("list_triggers");
    // the next turn of that thread mounts no agents tools: its mark goes
    applyAgentsBridge("thread-apply", {}, ON, bot, CLAUDE, {}, HOST);
    expect(bridgedToolTitle("thread-apply", "use_tool", { name: "list_triggers" })).toBe("use_tool");
    // a bot or an engine that is turned down is written in as "0"
    const turnedDown = { agents: { command: "node", args: [] as string[], env: { OMB_AGENTS_TOOL_BRIDGE: "1" } } };
    applyAgentsBridge("thread-apply-acp", turnedDown, ON, bot, { driverKind: "grokAgent" }, {}, HOST);
    expect(turnedDown.agents.env).toEqual({ OMB_AGENTS_TOOL_BRIDGE: "0" });
  });

  it("stays off for a bot with a tool selection, whose gates read the tool's own name", () => {
    // mcp-gate.ts, the chat runtime and the Pi extension all refuse an
    // excluded tool by the name in the call. Behind use_tool that name is
    // use_tool, so a denied vm_exec would run. Any selection at all mounts
    // those gates, even one that permits everything.
    for (const toolScope of [
      { deny: ["mcp:agents:vm_exec"] },
      { allow: ["native:*", "mcp:agents:list_bots"] },
      { allow: ["mcp:agents:*"] },
      { allow: [] },
      {},
    ]) {
      expect(agentsToolBridgeRefusal(ON, { ...bot, toolScope }, CLAUDE, {}), JSON.stringify(toolScope)).toBe("the bot has a tool selection");
      expect(agentsToolBridgeEnv(ON, { ...bot, toolScope }, CLAUDE, {}), JSON.stringify(toolScope)).toEqual(off);
      expect(agentsToolBridgeEnv({}, { ...bot, toolScope }, CLAUDE, { OMB_AGENTS_TOOL_BRIDGE: "1" }), JSON.stringify(toolScope)).toEqual(off);
    }
    // a stored selection that cannot be read refuses the turn elsewhere; never on here
    for (const toolScope of [false, [], "all", { allow: "all" }, { unrecognized: true }, null]) {
      expect(agentsToolBridgeEnv(ON, { ...bot, toolScope }, CLAUDE, {}), JSON.stringify(toolScope)).toEqual(off);
    }
    expect(agentsToolBridgeEnv(ON, { ...bot, toolScope: undefined }, CLAUDE, {})).toEqual(on);
  });

  it("stays off when there is no such bot", () => {
    // null is what the store answers for a bot that is gone
    expect(agentsToolBridgeEnv(ON, null, CLAUDE, {})).toEqual(off);
    expect(agentsToolBridgeEnv(ON, undefined, CLAUDE, {})).toEqual(off);
  });
});

describe("the decision cannot fail a turn", () => {
  const FAILED = "the decision failed";
  const agents = () => ({ command: "node", args: [] as string[], env: { OMB_BOT_ID: "bot-1" } as Record<string, string> });
  /** A machine whose home cannot be asked for without an error that carries a path. */
  const throwingHost = (message: string): EngineHost => ({ get home(): string { throw new Error(message); }, managedPolicyFiles: [] });
  const quiet = () => vi.spyOn(console, "warn").mockImplementation(() => {});

  it("answers no bridge when something it reads throws: the integration exactly as the switch off gives it, and one line that says so", () => {
    const warn = quiet();
    try {
      const host = throwingHost("EACCES: permission denied, open '/Users/someone/.claude/settings.json'");
      const engine = { ...CLAUDE, cwd: undefined };
      expect(agentsToolBridgeRefusal(ON, bot, engine, {}, host)).toBe(FAILED);
      expect(agentsToolBridgeEnv(ON, bot, engine, {}, host)).toEqual(off);
      const asked = { ...agents(), env: { ...agents().env, OMB_AGENTS_TOOL_BRIDGE: "1" } };
      expect(bridgedAgents("thread-throws", asked, ON, bot, engine, {}, host)).toEqual(bridgedAgents("thread-off-for-comparison", asked, {}, bot, CLAUDE, {}, HOST));
      expect(bridgedToolTitle("thread-throws", "mcp__agents__use_tool", { name: "list_triggers" })).toBe("mcp__agents__use_tool");
      const integrations = { agents: asked };
      applyAgentsBridge("thread-throws-apply", integrations, ON, bot, engine, {}, host);
      expect(integrations.agents.env.OMB_AGENTS_TOOL_BRIDGE).toBe("0");
      // one line each time, naming the class of what was thrown and nothing it carried
      expect(warn).toHaveBeenCalledTimes(4);
      for (const [line] of warn.mock.calls) {
        expect(line).toMatch(/^\[agents\] .*tool bridge.*\(Error\)/);
        expect(line).not.toContain("/Users");
        expect(line).not.toContain("permission denied");
        expect(line).not.toContain("settings.json");
      }
      // and the next turn, with what it reads in order, is bridged again
      expect(agentsToolBridgeEnv(ON, bot, CLAUDE, {})).toEqual(on);
      expect(warn).toHaveBeenCalledTimes(4);
    } finally {
      warn.mockRestore();
    }
  });

  it("names the class of whatever was thrown, from wherever it was thrown", () => {
    const warn = quiet();
    try {
      const last = () => String(warn.mock.calls.at(-1)?.[0]);
      // the bot's record
      class VaultLocked extends Error { override name = "VaultLocked"; }
      const lockedBot = { get toolScope(): unknown { throw new VaultLocked("token=abc123"); } };
      expect(agentsToolBridgeEnv(ON, lockedBot, CLAUDE, {})).toEqual(off);
      expect(last()).toContain("(VaultLocked)");
      expect(last()).not.toContain("abc123");
      // the engine's config
      const oddEngine = { ...CLAUDE, get config(): unknown { throw new TypeError("config has {\"disallowedTools\": [\"mcp__agents__vm_exec\"]}"); } };
      expect(agentsToolBridgeEnv(ON, bot, oddEngine, {})).toEqual(off);
      expect(last()).toContain("(TypeError)");
      expect(last()).not.toContain("vm_exec");
      // a file system error keeps its code, which names no path
      const denied = Object.assign(new Error("EACCES: permission denied, open '/etc/claude-code/managed-settings.json'"), { code: "EACCES" });
      const deniedHost: EngineHost = { home: folder(), get managedPolicyFiles(): readonly string[] { throw denied; } };
      expect(agentsToolBridgeRefusal(ON, bot, CLAUDE, {}, deniedHost)).toBe(FAILED);
      expect(last()).toContain("(Error EACCES)");
      expect(last()).not.toContain("/etc");
      // something thrown that is not an error at all
      const rude = { ...CLAUDE, get environment(): Record<string, string> | undefined { throw 42; } };
      expect(agentsToolBridgeEnv(ON, bot, rude, {})).toEqual(off);
      expect(last()).toContain("(number)");
      // a name or code that is not a short plain word is not printed as given
      const loud = Object.assign(new Error("x"), { name: "Boom: /Users/someone/.claude\nsettings", code: { path: "/etc/claude-code" } });
      expect(agentsToolBridgeEnv(ON, bot, { ...CLAUDE, get config(): unknown { throw loud; } }, {})).toEqual(off);
      expect(last()).toContain("(unknown unknown)");
      expect(last()).not.toContain("/Users");
      expect(last()).not.toContain("/etc");
      expect(last()).not.toMatch(/\n/);
      const long = Object.assign(new Error("x"), { name: "E".repeat(65), code: "ENOENT" });
      expect(agentsToolBridgeEnv(ON, bot, { ...CLAUDE, get config(): unknown { throw long; } }, {})).toEqual(off);
      expect(last()).toContain("(unknown ENOENT)");
      // and reading them cannot throw out of the handler
      const hostile = new Proxy(new Error("x"), { get(target, key) { if (key === "name" || key === "code") throw new Error("/Users/someone"); return Reflect.get(target, key); } });
      expect(agentsToolBridgeEnv(ON, bot, { ...CLAUDE, get config(): unknown { throw hostile; } }, {})).toEqual(off);
      expect(last()).toContain("(unknown unknown)");
      expect(last()).not.toContain("/Users");
      // nor can asking what kind of value it is (a revoked proxy throws on instanceof)
      const { proxy: revoked, revoke } = Proxy.revocable(new Error("x"), {});
      revoke();
      expect(agentsToolBridgeEnv(ON, bot, { ...CLAUDE, get config(): unknown { throw revoked; } }, {})).toEqual(off);
      expect(last()).toContain("(unknown unknown)");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("the name a bridged call is given", () => {
  const agents = () => ({ command: "node", args: [] as string[], env: { OMB_BOT_ID: "bot-1" } as Record<string, string> });

  it("is the tool it ran on a turn that was bridged, for any tool of today's catalog, and its own for anything else", () => {
    bridgedAgents("thread-bridged", agents(), ON, bot, CLAUDE, {}, HOST);
    for (const tool of ["list_triggers", "vm_exec", "shared_computer", "create_bot", "create_options_card", "memory_log", "post_to_room"]) {
      expect(bridgedToolTitle("thread-bridged", "mcp__agents__use_tool", JSON.stringify({ name: tool, arguments: {} }, null, 2)), tool).toBe(`mcp__agents__${tool}`);
      expect(bridgedToolTitle("thread-bridged", "agents_use_tool", { name: tool }), tool).toBe(`agents_${tool}`);
      expect(bridgedToolTitle("thread-bridged", "use_tool", { name: tool }), tool).toBe(tool);
    }
    expect(bridgedToolTitle("thread-bridged", "mcp__agents__use_tool", { name: "made_up" })).toBe("mcp__agents__use_tool");
    expect(bridgedToolTitle("thread-bridged", "mcp__agents__use_tool", { name: FIND_TOOL })).toBe("mcp__agents__use_tool");
    expect(bridgedToolTitle("thread-bridged", "mcp__agents__use_tool", undefined)).toBe("mcp__agents__use_tool");
    expect(bridgedToolTitle("thread-bridged", "mcp__agents__list_triggers", {})).toBe("mcp__agents__list_triggers");
    expect(bridgedToolTitle("thread-bridged", "Bash", { name: "vm_exec" })).toBe("Bash");
  });

  it("leaves a use_tool row alone on a turn that was not bridged: it is some other server's tool of that name", () => {
    // Grok has a native use_tool, and Codex reports any server's tool by its
    // bare name. Neither turn started a bridged agents server.
    const call = { name: "list_triggers", arguments: {} };
    // never decided, switched off, an engine that is not bridged, a bot with a selection
    bridgedAgents("thread-off", agents(), {}, bot, CLAUDE, {}, HOST);
    bridgedAgents("thread-acp", agents(), ON, bot, { driverKind: "grokAgent" }, {}, HOST);
    bridgedAgents("thread-selected", agents(), ON, { toolScope: { deny: ["mcp:agents:vm_exec"] } }, CLAUDE, {}, HOST);
    for (const threadId of ["thread-never", "thread-off", "thread-acp", "thread-selected"]) {
      for (const title of ["use_tool", "mcp__agents__use_tool", "agents_use_tool"]) expect(bridgedToolTitle(threadId, title, call), `${threadId} ${title}`).toBe(title);
    }
  });

  it("follows the thread's latest turn: bridged, then not, then bridged again", () => {
    const call = { name: "list_triggers" };
    bridgedAgents("thread-moves", agents(), ON, bot, CLAUDE, {}, HOST);
    expect(bridgedToolTitle("thread-moves", "use_tool", call)).toBe("list_triggers");
    // its engine was switched to an ACP agent
    bridgedAgents("thread-moves", agents(), ON, bot, { driverKind: "qwenAgent" }, {}, HOST);
    expect(bridgedToolTitle("thread-moves", "use_tool", call)).toBe("use_tool");
    // a turn with no agents tools at all
    bridgedAgents("thread-moves", agents(), ON, bot, CLAUDE, {}, HOST);
    bridgedAgents("thread-moves", undefined, ON, bot, CLAUDE, {}, HOST);
    expect(bridgedToolTitle("thread-moves", "use_tool", call)).toBe("use_tool");
    bridgedAgents("thread-moves", agents(), ON, bot, CLAUDE, {}, HOST);
    expect(bridgedToolTitle("thread-moves", "use_tool", call)).toBe("list_triggers");
  });
});

describe("the record of bridged turns", () => {
  const agents = () => ({ command: "node", args: [] as string[], env: {} as Record<string, string> });
  const call = { name: "list_triggers" };

  it("is bounded: the oldest mark goes first, and all it costs is a row shown as use_tool", () => {
    bridgedAgents("thread-oldest", agents(), ON, bot, CLAUDE, {}, HOST);
    bridgedAgents("thread-kept-fresh", agents(), ON, bot, CLAUDE, {}, HOST);
    for (let n = 0; n < BRIDGED_THREADS_MAX - 2; n++) bridgedAgents(`thread-filler-${n}`, agents(), ON, bot, CLAUDE, {}, HOST);
    expect(bridgedToolTitle("thread-oldest", "use_tool", call)).toBe("list_triggers");
    // a thread whose turn is decided again is the newest again
    bridgedAgents("thread-kept-fresh", agents(), ON, bot, CLAUDE, {}, HOST);
    bridgedAgents("thread-one-more", agents(), ON, bot, CLAUDE, {}, HOST);
    expect(bridgedToolTitle("thread-oldest", "use_tool", call)).toBe("use_tool");
    expect(bridgedToolTitle("thread-kept-fresh", "use_tool", call)).toBe("list_triggers");
    expect(bridgedToolTitle("thread-one-more", "use_tool", call)).toBe("list_triggers");
    expect(bridgedToolTitle("thread-filler-0", "use_tool", call)).toBe("list_triggers");
  });
});

describe("what the prompt builder and the Activity log load", () => {
  it("is no engine driver: the rule's text and the question of whether a turn is bridged need none", async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const loaded = async (entry: string) => {
      const result = await build({ entryPoints: [join(here, entry)], bundle: true, platform: "node", format: "esm", write: false, metafile: true, logLevel: "silent", packages: "external" });
      return Object.keys(result.metafile.inputs);
    };
    for (const entry of ["system-prompt.ts", "activity.ts", "agents-bridge-names.ts", "mcp-gate.ts", "drivers/agents-proxy.ts"]) {
      const inputs = await loaded(entry);
      const drivers = inputs.filter((input) => /server\/drivers\/(claude|codex|pi|openai-chat|muse-code)\.ts$|server\/drivers\/acp\/|agents-bridge-switch\.ts$/.test(input));
      expect(drivers, entry).toEqual([]);
    }
    // and the switch, which reads the drivers to decide, is where they are loaded from
    expect((await loaded("agents-bridge-switch.ts")).some((input) => input.endsWith("server/drivers/claude.ts"))).toBe(true);
  }, 60_000);
});

describe("the prompt of a bridged turn", () => {
  const parts: PromptPart[] = [
    { id: "routine", label: "Routines", text: " If the user explicitly asks to schedule routines, use list_triggers and create_trigger." },
    { id: "memory", label: "Memory", text: "\nMEMORY: the deploy script lives in scripts/." },
    { id: "credential", label: "Credentials", text: " Use request_credential for a missing key." },
  ];
  const bridged = { env: { OMB_AGENTS_TOOL_BRIDGE: "1", OMB_BOT_ID: "bot-1" } };

  it("is unchanged, to the byte, without the bridge", () => {
    const plain = buildSystemPrompt("You are Kiwi.", "Be brief.", parts);
    expect(buildSystemPrompt("You are Kiwi.", "Be brief.", parts, undefined)).toEqual(plain);
    expect(buildSystemPrompt("You are Kiwi.", "Be brief.", parts, { env: { OMB_AGENTS_TOOL_BRIDGE: "0" } })).toEqual(plain);
    expect(buildSystemPrompt("You are Kiwi.", "Be brief.", parts, { env: {} })).toEqual(plain);
    expect(buildSystemPrompt("You are Kiwi.", "Be brief.", parts, {})).toEqual(plain);
    expect(plain.text).not.toContain(FIND_TOOL);
    expect(plain.sections.map((section) => section.id)).toEqual(["persona", "soul", "routine", "memory", "credential", "reply-habits"]);
  });

  it("has the section only when this turn was asked to bridge, once, right after the soul", () => {
    const built = buildSystemPrompt("You are Kiwi.", "Be brief.", parts, bridged);
    expect(built.sections.map((section) => section.id)).toEqual(["persona", "soul", "tool-bridge", "routine", "memory", "credential", "reply-habits"]);
    const section = built.sections.find((entry) => entry.id === "tool-bridge")!;
    expect(section.text).toBe(AGENTS_TOOL_BRIDGE_PROMPT);
    expect(section.bytes).toBe(Buffer.byteLength(AGENTS_TOOL_BRIDGE_PROMPT, "utf8"));
    expect(built.text.split(AGENTS_TOOL_BRIDGE_PROMPT)).toHaveLength(2);
    // every other section is exactly what it was
    const plain = buildSystemPrompt("You are Kiwi.", "Be brief.", parts);
    expect(built.sections.filter((entry) => entry.id !== "tool-bridge")).toEqual(plain.sections);
    expect(built.text.replace(AGENTS_TOOL_BRIDGE_PROMPT, "")).toBe(plain.text);
    // the decision's own output is what switches it: off for an engine or a bot that is turned down
    for (const [agents, has] of [
      [{ env: agentsToolBridgeEnv(ON, bot, CLAUDE, {}) }, true],
      [{ env: agentsToolBridgeEnv(ON, bot, { driverKind: "grokAgent" }, {}) }, false],
      [{ env: agentsToolBridgeEnv(ON, { toolScope: { deny: ["mcp:agents:vm_exec"] } }, CLAUDE, {}) }, false],
      [{ env: agentsToolBridgeEnv({}, bot, CLAUDE, {}) }, false],
    ] as const) {
      expect(buildSystemPrompt("You are Kiwi.", "", parts, agents).sections.some((entry) => entry.id === "tool-bridge")).toBe(has);
    }
  });

  it("never names a tool the bridge may have hidden, so it cannot send a bot to call one directly", () => {
    const everyTool = availableTools({ skillAuthoring: true, sharedComputers: true, voiceNotes: true, cloudHome: false, chief: true, botId: WATCHER_OPTIONS_CARD_BOT_ID }).map((tool) => tool.name);
    expect(everyTool.length).toBeGreaterThan(BRIDGE_HOT_TOOL_NAMES.size);
    for (const tool of everyTool) expect(AGENTS_TOOL_BRIDGE_PROMPT, tool).not.toContain(tool);
  });

  it("reads true when the bridge tools are not in the turn's list after all", () => {
    // A tool selection saved after the prompt was built gives the turn an
    // unbridged proxy at its mount. So nothing is said about find_tool or
    // use_tool except on the condition that they are listed, and what is
    // said without that condition is true of every turn.
    const sentences = AGENTS_TOOL_BRIDGE_PROMPT.trim().split(/(?<=\.)\s+/);
    const aboutTheBridge = sentences.filter((sentence) => sentence.includes(FIND_TOOL) || sentence.includes(USE_TOOL));
    expect(aboutTheBridge).toHaveLength(1);
    expect(aboutTheBridge[0]!.startsWith(`If ${FIND_TOOL} and ${USE_TOOL} are in your tool list, `)).toBe(true);
    expect(sentences.filter((sentence) => !aboutTheBridge.includes(sentence))).toEqual(["A tool that is in your tool list is always called directly."]);
    // one sentence-run, joined to its neighbours like every other section
    expect(AGENTS_TOOL_BRIDGE_PROMPT.startsWith(" ")).toBe(true);
    expect(AGENTS_TOOL_BRIDGE_PROMPT).not.toMatch(/\n/);
  });

  it("sits in the stable half, so a warm engine is not relaunched by it turn after turn", () => {
    const first = buildSystemPrompt("You are Kiwi.", "Be brief.", parts, bridged);
    const later = buildSystemPrompt("You are Kiwi.", "Be brief.", parts.map((part) => part.id === "memory" ? { ...part, text: "\nMEMORY: the deploy script moved to tools/." } : part), bridged);
    expect(first.stable).toContain(AGENTS_TOOL_BRIDGE_PROMPT);
    expect(first.volatile).not.toContain(FIND_TOOL);
    expect(later.stable).toBe(first.stable);
    expect(later.volatile).not.toBe(first.volatile);
    // and it is the same text for every bot and every turn that has it
    expect(buildSystemPrompt("You are Pip.", "", [], { env: { OMB_AGENTS_TOOL_BRIDGE: "1", OMB_CHIEF_OF_STAFF: "1" } }).sections.find((entry) => entry.id === "tool-bridge")!.text).toBe(AGENTS_TOOL_BRIDGE_PROMPT);
  });
});
