// Grok Build: the official `grok` CLI over ACP stdio (`grok … agent stdio`) on the grok.com
// subscription login (~/.grok/auth.json), not the xAI API key. Verified against grok 1.0.0.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parse as parseYaml } from "yaml";

import type { ModelCatalog } from "../../contracts.ts";
import { harnessHome, splitCliString } from "../../env-path.ts";
import type { DeviceSignIn } from "../device-auth.ts";
import { decodeInjectId, hostApiKey, localHost, mergeLocalInject } from "../local-inject.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";
import type { AcpQuestionRequest } from "./question-requests.ts";
import { allowsTool, canUseMcpServer, narrowsNativeTools, parseToolScope } from "../../../shared/tool-scope.ts";
import { OWN_APPS_SERVER } from "../../../shared/own-apps.ts";
import { MAX_QUESTIONS, parseProtocolAskQuestions, pickedOptionLabels, questionAnswersById, repeatsQuestionText } from "../../../shared/ask-question.ts";

export const STATIC_GROK_MODELS: ModelCatalog = {
  default: "grok-4.7",
  options: [
    { id: "grok-4.7", label: "Grok 4.7", contextWindow: 500_000 },
    { id: "grok-4.6", label: "Grok 4.6" },
    { id: "grok-4.5", label: "Grok 4.5" },
  ],
};

const SLUG = /^[a-z0-9][a-z0-9._-]*$/i;

/** `$GROK_HOME`, else `~/.grok`: Grok's sign-in, config and catalog. */
export function grokHome(env: Record<string, string | undefined> = process.env): string {
  return env.GROK_HOME || harnessHome("grok", env);
}

export function grokSignedIn(env: Record<string, string | undefined>): boolean {
  return existsSync(join(grokHome(env), "auth.json"));
}

function grokLoginFailure(output: string): string {
  if (/(unexpected argument|unrecognized (argument|option)|unknown option).*device-(auth|code)/i.test(output)) {
    return "This server's Grok is too old to sign in with a code. Update Grok on the server, then try again.";
  }
  if (/device-code login is not available/i.test(output)) {
    return "This Grok account can't sign in with a code. Use an xAI API key instead.";
  }
  if (/expired/i.test(output)) return "The Grok sign-in code expired. Start sign-in again for a new code.";
  if (/denied|rejected/i.test(output)) return "Grok sign-in was declined in the browser. Start sign-in again to try once more.";
  return "Grok sign-in did not finish. Check the server's connection, then try again.";
}

/** `grok login --device-auth` on the grok.com subscription (grok 1.0.25 and 1.0.41). Grok has no
 * status command, so nothing is checked first. */
export const GROK_DEVICE_SIGN_IN: DeviceSignIn = {
  provider: "grok",
  product: "Grok",
  account: "Grok",
  homeEnv: "GROK_HOME",
  homeDir: ".grok",
  loginArgs: ["login", "--device-auth"],
  install: "Install it with xAI's installer (https://x.ai/cli), then try again.",
  failure: grokLoginFailure,
  signedIn: grokSignedIn,
};

function unquote(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"');
  }
  return value;
}

/** Local slugs from ~/.grok/config.toml, which `grok -m <slug>` accepts, plus the cloud defaults. */
export function readGrokModelCatalog(env: Record<string, string | undefined> = process.env): ModelCatalog {
  const path = join(grokHome(env), "config.toml");
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

  const path = join(grokHome(env), "config.toml");
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

/** Grok 1.0.25 consumes native image blocks but advertises image:false; other versions negotiate. */
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

// Original names in the official 1.0.41 default registry, never owner strings.
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

export function grokInheritedProfile(cli: string, env: Record<string, string | undefined>, cwd: string): GrokScopeProfile | undefined {
  const unsupported = () => { throw new Error("Grok's existing agent profile cannot be safely intersected with tool selection. Use a profile file with explicit tools or a separate default Grok account."); };
  if ((env.GROK_AGENT && env.GROK_AGENT !== "grok-build") || env.GROK_CONFIG || env.GROK_CONFIG_PATH) return unsupported();
  const args = splitCliString(cli);
  // The CLI applies operator filters after ACP's profile, so unverified overrides refuse.
  if (args.some(arg => /^(--tools|--disallowed-tools|--disallowedTools|--agent)(=|$)/.test(arg))) return unsupported();
  const flags = args.flatMap((arg, index) => arg === "--agent-profile" || arg.startsWith("--agent-profile=") ? [index] : []);
  if (flags.length > 1) return unsupported();
  const flag = flags[0] ?? -1;
  let path = flag >= 0 ? (args[flag]!.includes("=") ? args[flag]!.slice(args[flag]!.indexOf("=") + 1) : args[flag + 1]) : undefined;
  if (flag >= 0 && (!path || path.startsWith("-"))) return unsupported();
  const files = [join(grokHome(env), "config.toml")];
  for (let directory = resolve(cwd);;) {
    const file = join(directory, ".grok", "config.toml"); if (!files.includes(file)) files.push(file);
    const parent = dirname(directory); if (parent === directory) break; directory = parent;
  }
  for (const file of files) {
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8"); if (text.length > 262_144) return unsupported();
    // A small TOML subset over the whole file; unsupported syntax refuses the scoped turn.
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
      // Grok expands environment variables in paths.
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
  // Grok rejects an empty curated construction.
  return {
    ...inherited, name: inherited?.name ?? "openmausbot-tools", description: inherited?.description ?? "Owner-selected tools",
    injectDefaultTools: false, discoverSkills: false,
    toolConfig: { ...inherited?.toolConfig, tools: selected.length ? selected : [{ id: "GrokBuild:read_file", name_override: "read_file" }] },
    tools: [], disallowedTools: [...new Set([...(inherited?.disallowedTools ?? []), ...(selected.length ? [] : ["read_file"])])],
  };
}

/** Grok's `ask_user_question` blocks its turn on this extension request (xai-org/grok-build ask_user_question/types.rs);
 * ACP's Rust SDK adds the `_` prefix on the wire. Answers are keyed by Grok's question text, one label per pick; own
 * words ride as "Other" with the text in annotations[].notes. */
export const GROK_ASK_USER_QUESTION: AcpQuestionRequest = {
  cancelled: { outcome: "cancelled" },
  parse(params) {
    const raw = (params as { questions?: unknown } | null)?.questions;
    // Refused whole: answering only the first ones would read the rest as accepted.
    if (!Array.isArray(raw) || raw.length > MAX_QUESTIONS) return null;
    // The index is the id, so each card question maps back to Grok's exact text; `multi_select` is its model-facing name.
    const parsed = parseProtocolAskQuestions(raw.map((entry, index) =>
      entry && typeof entry === "object"
        ? { ...entry, id: String(index), multiSelect: entry.multiSelect === true || entry.multi_select === true }
        : entry));
    if (!parsed || repeatsQuestionText(parsed)) return null;
    return {
      questions: parsed.map(({ question }) => question),
      answered(message) {
        const byId = questionAnswersById(message, parsed);
        // Null prototype: a question text such as __proto__ is a real key.
        const answers: Record<string, string[]> = Object.create(null);
        const annotations: Record<string, { notes: string }> = Object.create(null);
        for (const { id, question } of parsed) {
          const reply = byId[id];
          if (reply === undefined) continue;
          const text = (raw[Number(id)] as { question: string }).question;
          const { labels, other } = pickedOptionLabels(reply, question);
          answers[text] = other === undefined ? labels : [...labels, "Other"];
          if (other !== undefined) annotations[text] = { notes: other };
        }
        if (!Object.keys(answers).length) return null;
        return { outcome: "accepted", answers, ...(Object.keys(annotations).length ? { annotations } : {}) };
      },
    };
  },
};

const support: AcpSupport = {
  driverKind: "grokAgent",
  questionRequests: {
    "_x.ai/ask_user_question": GROK_ASK_USER_QUESTION,
    "x.ai/ask_user_question": GROK_ASK_USER_QUESTION,
  },
  displayName: "Grok",
  images: true,
  acceptsUnadvertisedImages: grokAcceptsUnadvertisedImages,
  models: STATIC_GROK_MODELS,
  resolveModels: (env) => mergeLocalInject(readGrokModelCatalog(env), env),
  // Grok's levels vary by model and the CLI validates lazily (a rejected level only logs); grok-4.5 rejects xhigh.
  effortLevels: ["low", "medium", "high"],
  defaultCli: "grok",
  nativeSource: "grok.acp",
  loginNote: "Grok is not signed in to your grok.com account — choose Sign in to Grok in engine setup",

  // No Windows one-liner: the installer is a POSIX shell script.
  install: {
    command: {
      darwin: "curl -fsSL https://x.ai/cli/install.sh | bash",
      linux: "curl -fsSL https://x.ai/cli/install.sh | bash",
    },
    docsUrl: "https://x.ai/cli",
    signInCommand: "grok login",
  },
  deviceSignIn: GROK_DEVICE_SIGN_IN,

  // With the instance HOME/GROK_HOME: ensureGrokInjectSlug defaults to process.env.
  resolveTurnModel: (model, env) => (model ? ensureGrokInjectSlug(model, env) : model),

  // --permission-mode is global; -m and --reasoning-effort only apply between `agent` and `stdio`
  // (Grok 1.0.6; -m first is taken as a TUI option and ignored). Auto selects Grok's native
  // classifier, never bypassPermissions. xai-org/grok-build@37949780 crates/codegen/xai-grok-pager-bin/src/main.rs:1259-1273.
  spawnArgs: (config, turn) => [
    "--permission-mode",
    config.fullAuto
      ? "bypassPermissions"
      : turn.approvalMode === "auto" ? "auto" : turn.approvalMode === "edits" ? "acceptEdits" : "default",
    "agent",
    ...(turn.toolScope !== undefined ? ["--no-leader"] : []),
    ...(turn.model ? ["-m", turn.model] : []),
    // Long form: `--effort` is only an alias.
    ...(turn.effort ? ["--reasoning-effort", turn.effort] : []),
    "stdio",
  ],

  toolScopeSessionParams: (turn, init, hasMcp, { config, env, cwd }) => {
    if (!narrowsNativeTools(turn.toolScope)) return {};
    const profile = grokToolScopeProfile(turn.toolScope, init, grokInheritedProfile(config.cli, env, cwd), hasMcp);
      // Changing harnesses after session/new can discard an ACP profile and restore default tools.
    if (turn.model) profile.model = ensureGrokInjectSlug(turn.model, env);
    return { _meta: { agentProfile: profile } };
  },
  toolScopeCacheKey: ({ config, env, cwd }) => JSON.stringify(grokInheritedProfile(config.cli, env, cwd) ?? null),

  // -m on argv is not enough: session/new still starts on [models].default.
  async configureSession({ request, sessionId, turn, currentModelId }) {
    if (turn.toolScope !== undefined) {
      const available = new Set([
        ...(turn.integrations?.agents ? ["agents"] : []), ...(turn.integrations?.composio ? ["composio"] : []), ...(turn.integrations?.composioOwn ? [OWN_APPS_SERVER] : []),
        ...(turn.integrations?.browser ? ["browser"] : []), ...(turn.integrations?.localComputer ? ["computer"] : []),
        ...(turn.integrations?.data ? ["data"] : []), ...(turn.integrations?.highlevel ? ["highlevel"] : []),
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
        // Repeating set_model can rebuild the harness or reject a valid resumed profile.
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

  // A leaked API key silently flips the grok.com subscription to pay-as-you-go.
  transformEnv: (env) => {
    delete env.XAI_API_KEY;
  },
  applyTurnEnv: (env, { toolScope }) => {
    if (toolScope !== undefined) {
      // These env switches outrank account defaults in the verified runtime.
      env.GROK_MANAGED_MCPS_ENABLED = "false";
      env.GROK_MANAGED_MCP_GATEWAY_TOOLS_ENABLED = "false";
      if (narrowsNativeTools(toolScope)) {
        if (env.GROK_AGENT && env.GROK_AGENT !== "grok-build") {
          throw new Error("Grok's existing agent profile cannot be safely intersected with tool selection. Use a separate default Grok account.");
        }
        // A model's agent_type otherwise takes priority over ACP profiles.
        env.GROK_AGENT = "grok-build";
      }
    }
  },

  pickAuthMethod: (methods) => (methods.some((m) => m.id === "cached_token") ? "cached_token" : null),
  authFailure: "fail",
  isAuthenticated: (env) => grokSignedIn(env),

  // `--append-system-prompt`/`--rules` do not reach the agent-stdio system prompt (1.0.0).
  buildPromptText: (turn) => (turn.system ? `${turn.system}\n\n${turn.text}` : turn.text),
};

export const GrokAgentDriver = createAcpDriver(support);
