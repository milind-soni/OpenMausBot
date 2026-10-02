// Grok Build harness support — the official `grok` CLI over ACP stdio
// (`grok … agent stdio`), on the grok.com subscription login
// (~/.grok/auth.json), NOT the xAI API key (that driver is drivers/grok.ts).
// The generic protocol runtime lives in acp/core.ts; this file is only the
// per-harness quirks. Verified against grok 1.0.0.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parse as parseYaml } from "yaml";

import type { ModelCatalog } from "../../contracts.ts";
import { harnessHome, splitCliString } from "../../env-path.ts";
import { decodeInjectId, hostApiKey, localHost, mergeLocalInject } from "../local-inject.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";
import { allowsTool, canUseMcpServer, narrowsNativeTools, parseToolScope } from "../../../shared/tool-scope.ts";

export const STATIC_GROK_MODELS: ModelCatalog = {
  default: "grok-4.7",
  options: [
    { id: "grok-4.7", label: "Grok 4.7", contextWindow: 500_000 },
    { id: "grok-4.6", label: "Grok 4.6" },
    { id: "grok-4.5", label: "Grok 4.5" },
  ],
};

const SLUG = /^[a-z0-9][a-z0-9._-]*$/i;

function unquote(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"');
  }
  return value;
}

/** Local slugs from ~/.grok/config.toml, plus the cloud defaults.
 *  `grok -m <slug>` already accepts these; the picker just didn't list them. */
export function readGrokModelCatalog(env: Record<string, string | undefined> = process.env): ModelCatalog {
  const path = join(env.GROK_HOME || harnessHome("grok", env), "config.toml");
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return STATIC_GROK_MODELS;
  }

  const options = STATIC_GROK_MODELS.options.map((o) => ({ ...o }));
  const seen = new Set(options.map((o) => o.id));
  let configuredDefault: string | null = null;
  let current: { slug: string; name?: string } | null = null;
  let inModels = false;

  const flush = () => {
    if (!current || !SLUG.test(current.slug) || seen.has(current.slug)) {
      current = null;
      return;
    }
    seen.add(current.slug);
    options.push({ id: current.slug, label: current.name || current.slug, custom: true });
    current = null;
  };

  for (const line of text.split(/\r?\n/)) {
    const stripped = line.trim();
    if (stripped === "[models]") {
      flush();
      inModels = true;
      continue;
    }
    if (stripped.startsWith("[model.") && stripped.endsWith("]")) {
      flush();
      inModels = false;
      let inner = stripped.slice("[model.".length, -1);
      if (inner.startsWith('"') && inner.endsWith('"')) inner = inner.slice(1, -1);
      current = { slug: inner };
      continue;
    }
    if (stripped.startsWith("[")) {
      flush();
      inModels = false;
      continue;
    }
    if (!stripped || stripped.startsWith("#") || !stripped.includes("=")) continue;
    const eq = stripped.indexOf("=");
    const key = stripped.slice(0, eq).trim();
    const value = unquote(stripped.slice(eq + 1));
    if (current && key === "name" && value) current.name = value;
    if (!current && inModels && key === "default") configuredDefault = value;
  }
  flush();

  return {
    default: configuredDefault && seen.has(configuredDefault) ? configuredDefault : STATIC_GROK_MODELS.default,
    options,
  };
}

function suggestGrokSlug(host: string, model: string, taken: Set<string>): string {
  let base = `${host}-${model}`.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (!base || !/^[a-z]/.test(base)) base = `m-${base || "model"}`;
  let slug = base;
  let n = 2;
  while (taken.has(slug)) {
    slug = `${base}-${n}`;
    n += 1;
  }
  return slug;
}

function quoteToml(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Write a [model.slug] block so `grok -m` can reach the injected host. */
export function ensureGrokInjectSlug(
  modelId: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const inject = decodeInjectId(modelId);
  if (!inject) return modelId;
  const host = localHost(inject.host);
  if (!host) return modelId;

  const path = join(env.GROK_HOME || harnessHome("grok", env), "config.toml");
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    text = "";
  }

  const taken = new Set<string>(STATIC_GROK_MODELS.options.map((option) => option.id));
  let current: { slug: string; model?: string; baseUrl?: string } | null = null;
  const flush = () => {
    if (!current) return;
    taken.add(current.slug);
    if (current.model === inject.model && current.baseUrl === host.baseUrl) {
      found = current.slug;
    }
    current = null;
  };
  let found: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const stripped = line.trim();
    if (stripped.startsWith("[model.") && stripped.endsWith("]")) {
      flush();
      let inner = stripped.slice("[model.".length, -1);
      if (inner.startsWith('"') && inner.endsWith('"')) inner = inner.slice(1, -1);
      current = { slug: inner };
      continue;
    }
    if (stripped.startsWith("[")) {
      flush();
      continue;
    }
    if (!current || !stripped.includes("=")) continue;
    const eq = stripped.indexOf("=");
    const key = stripped.slice(0, eq).trim();
    const value = unquote(stripped.slice(eq + 1));
    if (key === "model") current.model = value;
    if (key === "base_url") current.baseUrl = value;
  }
  flush();
  if (found) return found;

  const slug = suggestGrokSlug(inject.host, inject.model, taken);
  const heading = /[^a-z0-9_-]/i.test(slug) ? `[model."${slug}"]` : `[model.${slug}]`;
  const block = [
    heading,
    `model = ${quoteToml(inject.model)}`,
    `base_url = ${quoteToml(host.baseUrl)}`,
    `name = ${quoteToml(`${inject.model} (${host.label})`)}`,
    `api_backend = "chat_completions"`,
    `api_key = ${quoteToml(hostApiKey(host, env))}`,
    "",
  ].join("\n");
  const next = text && !text.endsWith("\n") ? `${text}\n\n${block}` : `${text}${text ? "\n" : ""}${block}`;
  writeFileSync(path, next);
  return slug;
}

/** Grok 1.0.25 consumes native image blocks but advertises image:false.
 * Verified with the real CLI and a loopback model: scripts/verify-grok-images.ts.
 * Keep unknown/older runtimes on the normal capability negotiation path. */
export function grokAcceptsUnadvertisedImages(init: unknown): boolean {
  const meta = (init as { _meta?: { grokShell?: unknown; agentVersion?: unknown } } | null)?._meta;
  if (meta?.grokShell !== true || typeof meta.agentVersion !== "string") return false;
  const version = /^1\.0\.(\d+)$/.exec(meta.agentVersion);
  return Boolean(version && Number(version[1]) >= 25);
}

interface GrokToolConfig { id: string; name_override?: string; [key: string]: unknown }
interface GrokScopeProfile {
  name: string;
  description: string;
  toolConfig: { tools: GrokToolConfig[]; [key: string]: unknown };
  injectDefaultTools?: boolean;
  tools?: string[];
  disallowedTools?: string[];
  [key: string]: unknown;
}

// Original names in the official 1.0.41 default registry, not arbitrary
// owner strings forwarded into Grok's inherit-all profile allowlist.
const GROK_NATIVE_TOOLS = [
  ["read_file", "GrokBuild:read_file"], ["search_replace", "GrokBuild:search_replace"], ["write", "OpenCode:write"],
  ["run_terminal_command", "GrokBuild:run_terminal_cmd"], ["list_dir", "GrokBuild:list_dir"], ["grep", "GrokBuild:grep"],
  ["kill_command_or_subagent", "GrokBuild:kill_task"], ["todo_write", "GrokBuild:todo_write"],
  ["get_command_or_subagent_output", "GrokBuild:get_task_output"], ["spawn_subagent", "GrokBuild:task"],
  ["scheduler_create", "GrokBuild:scheduler_create"], ["scheduler_delete", "GrokBuild:scheduler_delete"], ["scheduler_list", "GrokBuild:scheduler_list"],
  ["monitor", "GrokBuild:monitor"], ["search_tool", "GrokBuild:search_tool"], ["use_tool", "GrokBuild:use_tool"],
  ["workflow", "GrokBuild:workflow"], ["enter_plan_mode", "GrokBuild:enter_plan_mode"], ["exit_plan_mode", "GrokBuild:exit_plan_mode"],
  ["ask_user_question", "GrokBuild:ask_user_question"], ["send_feedback", "GrokBuild:send_feedback"],
  ["image_gen", "GrokBuild:image_gen"], ["image_edit", "GrokBuild:image_edit"],
  ["image_to_video", "GrokBuild:image_to_video"], ["reference_to_video", "GrokBuild:reference_to_video"],
] as const;

/** Read a supported on-disk profile rather than overriding its restriction. */
export function grokInheritedProfile(cli: string, env: Record<string, string | undefined>, cwd: string): GrokScopeProfile | undefined {
  const unsupported = () => { throw new Error("Grok's existing agent profile cannot be safely intersected with tool selection. Use a profile file with explicit tools or a separate default Grok account."); };
  if ((env.GROK_AGENT && env.GROK_AGENT !== "grok-build") || env.GROK_CONFIG || env.GROK_CONFIG_PATH) return unsupported();
  const args = splitCliString(cli);
  // Operator filters are applied after ACP's profile by the CLI. Refuse
  // unverified overrides rather than replacing an inherited restriction.
  if (args.some(arg => /^(--tools|--disallowed-tools|--disallowedTools|--agent)(=|$)/.test(arg))) return unsupported();
  const flags = args.flatMap((arg, index) => arg === "--agent-profile" || arg.startsWith("--agent-profile=") ? [index] : []);
  if (flags.length > 1) return unsupported();
  const flag = flags[0] ?? -1;
  let path = flag >= 0 ? (args[flag]!.includes("=") ? args[flag]!.slice(args[flag]!.indexOf("=") + 1) : args[flag + 1]) : undefined;
  if (flag >= 0 && (!path || path.startsWith("-"))) return unsupported();
  const files = [join(env.GROK_HOME || harnessHome("grok", env), "config.toml")];
  for (let directory = resolve(cwd);;) {
    const file = join(directory, ".grok", "config.toml"); if (!files.includes(file)) files.push(file);
    const parent = dirname(directory); if (parent === directory) break; directory = parent;
  }
  for (const file of files) {
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8"); if (text.length > 262_144) return unsupported();
    // Support a deliberately small, unambiguous TOML subset. Scan the whole
    // file: quoted/dotted keys, inline agent tables and multiline constructs
    // must never be silently missed by a section regex. Unsupported syntax
    // refuses this scoped turn; ordinary unrestricted turns are unaffected.
    let section = "";
    for (const line of text.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith("#"))) {
      const header = /^\[([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)\]\s*(?:#.*)?$/.exec(line);
      if (header) { section = header[1]!; if (section.startsWith("agent.")) return unsupported(); continue; }
      const assignment = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
      if (!assignment || /'''|"""/.test(assignment[2]!) || (!section && assignment[1] === "agent")) return unsupported();
      if (section !== "agent") continue;
      const match = /^(name|definition)\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*(?:#.*)?$/.exec(line);
      if (!match) return unsupported();
      let value: string;
      try { value = match[2]!.startsWith('"') ? JSON.parse(match[2]!) as string : match[2]!.slice(1, -1); }
      catch { return unsupported(); }
      // Grok expands environment variables in paths. Do not resolve a
      // different literal file or fall back when that contract is unknown.
      if (value.includes("$") || !value) return unsupported();
      if (match[1] === "name" && value !== "grok-build") return unsupported();
      if (match[1] === "definition" && flag < 0) {
        if (path !== undefined && path !== value) return unsupported();
        path = value;
      }
    }
  }
  if (!path) return;
  const text = readFileSync(resolve(cwd, path), "utf8"); if (text.length > 262_144) return unsupported();
  const match = /^\s*---\r?\n([\s\S]*?)\r?\n---(?:\r?\n([\s\S]*))?$/.exec(text);
  if (!match) return unsupported();
  const profile = parseYaml(match[1]!) as Partial<GrokScopeProfile> | null;
  if (!profile || typeof profile.name !== "string" || typeof profile.description !== "string"
    || (profile.tools !== undefined && (!Array.isArray(profile.tools) || !profile.tools.every((tool) => typeof tool === "string")))
    || (profile.disallowedTools !== undefined && (!Array.isArray(profile.disallowedTools) || !profile.disallowedTools.every((tool) => typeof tool === "string")))) return unsupported();
  const toolConfig = profile.toolConfig ?? { tools: GROK_NATIVE_TOOLS.map(([name, id]) => ({ id, name_override: name })) };
  if (!Array.isArray(toolConfig.tools) || !toolConfig.tools.every((tool) => typeof tool?.id === "string" && (tool.name_override === undefined || typeof tool.name_override === "string"))) return unsupported();
  return { ...profile, name: profile.name, description: profile.description, toolConfig, ...(match[2]?.trim() ? { promptBody: match[2].trim() } : {}) };
}

/** A curated registry: empty/unknown selections never inherit Grok's defaults. */
export function grokToolScopeProfile(scope: unknown, init: unknown, inherited?: GrokScopeProfile, hasMcp = false): GrokScopeProfile {
  const parsed = parseToolScope(scope);
  if (!parsed.ok) throw new Error(parsed.error);
  const meta = (init as { _meta?: { grokShell?: unknown; agentVersion?: unknown } } | null)?._meta;
  if (meta?.grokShell !== true || meta.agentVersion !== "1.0.41") {
    throw new Error("This Grok runtime does not have verified native tool selection. Use Grok 1.0.41 or Pi; update Grok support before using another version.");
  }
  if (hasMcp && (!allowsTool(scope, { kind: "native", name: "search_tool" }) || !allowsTool(scope, { kind: "native", name: "use_tool" }))) {
    throw new Error("Grok requires native:search_tool and native:use_tool to find and call selected MCP tools. Allow both explicitly or use Pi.");
  }
  const candidates = inherited?.toolConfig.tools ?? GROK_NATIVE_TOOLS.map(([name, id]) => ({ id, name_override: name }));
  const selected = candidates.filter((tool) => {
    const name = tool.name_override ?? GROK_NATIVE_TOOLS.find(([, id]) => id === tool.id)?.[0];
    return name !== undefined && allowsTool(scope, { kind: "native", name })
      && (!inherited?.tools?.length || inherited.tools.includes(name) || inherited.tools.includes(tool.id))
      && !inherited?.disallowedTools?.some((denied) => denied === name || denied === tool.id);
  });
  // Grok rejects an empty curated construction. A real read entry explicitly
  // disabled by its exact native name constructs an empty final registry.
  return {
    ...inherited, name: inherited?.name ?? "openmausbot-tools", description: inherited?.description ?? "Owner-selected tools",
    injectDefaultTools: false, discoverSkills: false,
    toolConfig: { ...inherited?.toolConfig, tools: selected.length ? selected : [{ id: "GrokBuild:read_file", name_override: "read_file" }] },
    tools: [], disallowedTools: [...new Set([...(inherited?.disallowedTools ?? []), ...(selected.length ? [] : ["read_file"])])],
  };
}

const support: AcpSupport = {
  driverKind: "grokAgent",
  displayName: "Grok",
  images: true,
  acceptsUnadvertisedImages: grokAcceptsUnadvertisedImages,
  models: STATIC_GROK_MODELS,
  resolveModels: (env) => mergeLocalInject(readGrokModelCatalog(env), env),
  // Grok's accepted levels vary by model and the CLI validates lazily — a
  // rejected level only logs and falls back. Offer the intersection shared
  // by every model in this driver's picker; notably, grok-4.5 rejects xhigh.
  effortLevels: ["low", "medium", "high"],
  defaultCli: "grok",
  nativeSource: "grok.acp",
  loginNote: "Grok CLI is not signed in — run `grok login` in a terminal",

  // No Windows one-liner: the installer is a POSIX shell script, and offering
  // `curl … | bash` there would be advice that cannot run. Windows falls back
  // to docsUrl, which is honest rather than broken.
  install: {
    command: {
      darwin: "curl -fsSL https://x.ai/cli/install.sh | bash",
      linux: "curl -fsSL https://x.ai/cli/install.sh | bash",
    },
    docsUrl: "https://x.ai/cli",
    signInCommand: "grok login",
  },

  // Write the [model.slug] block with the instance HOME/GROK_HOME, then pass
  // the slug on argv. spawnArgs must not call ensureGrokInjectSlug itself —
  // that helper defaults to process.env and would miss the instance override.
  resolveTurnModel: (model, env) => (model ? ensureGrokInjectSlug(model, env) : model),

  // --permission-mode is a global grok flag. -m and --reasoning-effort are
  // agent flags: Grok 1.0.6 only applies them when they sit AFTER `agent`
  // and BEFORE `stdio` (`grok agent -m slug stdio`). Putting -m first is
  // accepted as a TUI option and then ignored, so ACP session/new keeps
  // [models].default (currently grok-4.7) and oMLX never sees a request.
  // Auto selects Grok's native classifier; if its feature gate is disabled,
  // residual requests still ask. Never replace it with bypassPermissions.
  // Verified: grok 1.0.3 --help and xai-org/grok-build@37949780,
  // crates/codegen/xai-grok-pager-bin/src/main.rs:1259-1273.
  spawnArgs: (config, turn) => [
    "--permission-mode",
    config.fullAuto
      ? "bypassPermissions"
      : turn.approvalMode === "auto" ? "auto" : turn.approvalMode === "edits" ? "acceptEdits" : "default",
    "agent",
    ...(turn.toolScope !== undefined ? ["--no-leader"] : []),
    ...(turn.model ? ["-m", turn.model] : []),
    // long form on purpose: `--effort` is documented as an alias, and an
    // alias is the part a CLI is free to rename
    ...(turn.effort ? ["--reasoning-effort", turn.effort] : []),
    "stdio",
  ],

  toolScopeSessionParams: (turn, init, hasMcp, { config, env, cwd }) => {
    if (!narrowsNativeTools(turn.toolScope)) return {};
    const profile = grokToolScopeProfile(turn.toolScope, init, grokInheritedProfile(config.cli, env, cwd), hasMcp);
    // Establish on the selected model. Changing harnesses after session/new
    // can discard an ACP profile and restore the model's default tools.
    if (turn.model) profile.model = ensureGrokInjectSlug(turn.model, env);
    return { _meta: { agentProfile: profile } };
  },
  toolScopeCacheKey: ({ config, env, cwd }) => JSON.stringify(grokInheritedProfile(config.cli, env, cwd) ?? null),

  // -m on argv is necessary but not sufficient: session/new still starts on
  // [models].default. Pin the slug over the wire, same as Hermes/Droid.
  async configureSession({ request, sessionId, turn, currentModelId }) {
    if (turn.toolScope !== undefined) {
      const available = new Set([
        ...(turn.integrations?.agents ? ["agents"] : []), ...(turn.integrations?.composio ? ["composio"] : []),
        ...(turn.integrations?.browser ? ["browser"] : []), ...(turn.integrations?.localComputer ? ["computer"] : []),
        ...Object.keys(turn.integrations?.custom ?? {}),
      ].filter((name) => canUseMcpServer(turn.toolScope, name)));
      const deadline = Date.now() + 10_000;
      for (;;) {
        const reply = await request("_x.ai/mcp/list", { sessionId, cache: true }, 10_000);
        const catalog = reply?.result;
        if (!Array.isArray(catalog?.servers)) throw new Error("Grok could not confirm its MCP catalog. No prompt was sent.");
        for (const server of catalog.servers) {
          if (server?.session?.enabled === false) continue;
          if (!available.has(server?.name)) throw new Error("Grok has an MCP connection outside the bot's selection. Disable native MCP connections before using tool selection. No prompt was sent.");
          if (Array.isArray(server?.session?.tools) && server.session.tools.some((tool: { name?: unknown }) => typeof tool.name !== "string" || !allowsTool(turn.toolScope, { kind: "mcp", server: server.name, name: tool.name }))) {
            throw new Error("Grok could not enforce the selected MCP catalog. No prompt was sent.");
          }
        }
        if (catalog.sessionMcpResolved === true) {
          if ([...available].some((name) => !catalog.servers.some((server: { name?: string; session?: { enabled?: boolean; status?: string } }) => server.name === name && server.session?.enabled === true && server.session.status === "ready"))) {
            throw new Error("Grok could not connect a selected MCP server. No prompt was sent.");
          }
          break;
        }
        if (Date.now() >= deadline) throw new Error("Grok did not confirm its selected MCP catalog in time. No prompt was sent.");
        await delay(50);
      }
    }
    if (!turn.model) return;
    if (narrowsNativeTools(turn.toolScope)) {
      if (currentModelId !== turn.model) {
        throw new Error("Grok could not confirm the selected model without replacing its tool profile. Start a new conversation or choose a model with a supported Grok profile. No prompt was sent.");
      }
      // The inline profile already pins this model. Repeating set_model can
      // rebuild the harness, or reject an otherwise valid resumed profile.
      return;
    }
    try {
      await request("session/set_model", { sessionId, modelId: turn.model });
    } catch (e) {
      throw new Error(
        `Grok rejected model "${turn.model}" via session/set_model: ${(e as Error).message}. ` +
          `Check that grok is current (1.0.6+ supports it) and that this slug exists in ~/.grok/config.toml.`,
      );
    }
  },

  // The CLI owns its own grok.com login; a leaked API key silently flips
  // billing from the subscription to pay-as-you-go.
  transformEnv: (env) => {
    delete env.XAI_API_KEY;
  },
  applyTurnEnv: (env, { toolScope }) => {
    if (toolScope !== undefined) {
      // The verified runtime gives these local env switches priority over
      // account defaults, preventing an unfiltered managed gateway fallback.
      env.GROK_MANAGED_MCPS_ENABLED = "false";
      env.GROK_MANAGED_MCP_GATEWAY_TOOLS_ENABLED = "false";
      if (narrowsNativeTools(toolScope)) {
        if (env.GROK_AGENT && env.GROK_AGENT !== "grok-build") {
          throw new Error("Grok's existing agent profile cannot be safely intersected with tool selection. Use a separate default Grok account.");
        }
        // A model's agent_type otherwise takes priority over ACP profiles.
        // Preserve profile-file restrictions when intersecting them below.
        env.GROK_AGENT = "grok-build";
      }
    }
  },

  // Bind the grok.com subscription login. No API-key fallback by design —
  // an unauthenticated CLI is a user action, not something to paper over.
  pickAuthMethod: (methods) => (methods.some((m) => m.id === "cached_token") ? "cached_token" : null),
  authFailure: "fail",
  isAuthenticated: (env) => existsSync(join(harnessHome("grok", env), "auth.json")),

  // `--append-system-prompt`/`--rules` are accepted by the CLI but do NOT
  // reach the agent-stdio system prompt (verified against 1.0.0), so the
  // persona is prepended codex-style.
  buildPromptText: (turn) => (turn.system ? `${turn.system}\n\n${turn.text}` : turn.text),
};

export const GrokAgentDriver = createAcpDriver(support);
