// Hermes Agent — Nous Research's `hermes acp` CLI. Custom-only: Hermes is
// a BYOK/local harness. ACP ignores `hermes -m` (cmd_acp does not forward
// it), and setting OPENAI_API_KEY makes provider:auto resolve to OpenRouter
// without an OpenRouter key — that is the "HTTP 401: Missing Authentication
// header" failure. Inject writes providers.<host> and session/set_model
// `custom:<host>:<model>` instead.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

import type { ModelCatalog } from "../../contracts.ts";
import { decodeInjectId, hostApiKey, INJECT_SEP, localHost, mergeLocalInject } from "../local-inject.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";

const EMPTY: ModelCatalog = { default: "", options: [] };

function hermesHome(env: Record<string, string | undefined>): string {
  return env.HERMES_HOME || join(env.HOME || env.USERPROFILE || homedir(), ".hermes");
}

function quoteYaml(value: string): string {
  if (/^[\w./:+-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function upsertHermesProvider(text: string, hostId: string, baseUrl: string, apiKey: string): string {
  const block = [`  ${hostId}:`, `    base_url: ${quoteYaml(baseUrl)}`, `    api_key: ${quoteYaml(apiKey)}`, ""].join(
    "\n",
  );
  if (/^providers:\s*$/m.test(text)) {
    const replaced = replaceHermesHostBlock(text, hostId, block);
    if (replaced !== null) return replaced;
    return text.replace(/^providers:\s*$/m, `providers:\n${block.trimEnd()}`);
  }
  const prefix = text && !text.endsWith("\n") ? `${text}\n` : text;
  return `${prefix}\nproviders:\n${block}`;
}

/** Replace `  hostId:` through the next sibling 2-space key or a top-level key. */
function replaceHermesHostBlock(text: string, hostId: string, block: string): string | null {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line === `  ${hostId}:`);
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end]!;
    if (/^  \S/.test(line) || /^\S/.test(line)) break;
    end++;
  }
  while (end > start + 1 && lines[end - 1] === "") end--;
  return [...lines.slice(0, start), ...block.replace(/\n$/, "").split("\n"), ...lines.slice(end)].join("\n");
}

/** Register an OpenAI-compatible host so ACP can `session/set_model custom:host:model`. */
export function ensureHermesInjectProvider(
  modelId: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const inject = decodeInjectId(modelId);
  if (!inject) return modelId;
  const host = localHost(inject.host);
  if (!host) return modelId;

  const dir = hermesHome(env);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "config.yaml");
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    text = "";
  }
  const next = upsertHermesProvider(text, inject.host, host.baseUrl, hostApiKey(host, env));
  if (next !== text) writeFileSync(path, next);
  return hermesAcpModelId(modelId) ?? modelId;
}

/** ACP session/set_model id. Hermes parse_model_input treats `custom:name:model`. */
export function hermesAcpModelId(modelId: string | null | undefined): string | null {
  const inject = decodeInjectId(modelId);
  if (inject) return `custom:${inject.host}:${inject.model}`;
  // Hermes' own ACP ids are `<provider>:<model>` (`openrouter:qwen/qwen3.8-max`).
  // They are not inject ids and must be forwarded untouched; returning null here
  // is what limited the picker to locally injected hosts.
  const native = typeof modelId === "string" ? modelId.trim() : "";
  if (native && !native.includes(INJECT_SEP) && /^[a-z0-9_-]+:[\w./:-]+$/i.test(native)) return native;
  return null;
}

/** The id used when Hermes should run on the provider its own config names.
 *
 * Deliberately not an inject id: `hermesAcpModelId` returns null for it, so
 * `configureSession` sends no `session/set_model` and Hermes falls through to
 * the model in its own `config.yaml`. `spawnArgs` passes no `-m` either (ACP
 * ignores it), so nothing overrides that choice.
 */
export const HERMES_CONFIG_MODEL_ID = "hermes-default";

function nonEmptyDotenvValue(text: string, name: string): string | null {
  const match = new RegExp(`^[ \\t]*(?:export[ \\t]+)?${name}[ \\t]*=[ \\t]*([^\\r\\n]*)$`, "m").exec(text);
  if (!match) return null;
  const raw = match[1].trim();
  if (!raw || raw.startsWith("#")) return null;
  const quote = raw[0];
  if (quote === '"' || quote === "'") {
    const closing = raw.indexOf(quote, 1);
    if (closing < 0) return null;
    const trailing = raw.slice(closing + 1).trim();
    if (trailing && !trailing.startsWith("#")) return null;
    return raw.slice(1, closing).trim() || null;
  }
  return raw.replace(/[ \t]+#.*$/, "").trim() || null;
}

const HERMES_HOSTED_PROVIDER_KEYS = [
  "OPENROUTER_API_KEY",
  "GLM_API_KEY",
  "ZAI_API_KEY",
  "Z_AI_API_KEY",
] as const;

const HERMES_LOCAL_CONFIG_PROVIDERS = new Set(["custom", "lmstudio", "ollama", "vllm", "llamacpp"]);

function yamlString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Read the model/provider forms accepted by Hermes' `_normalize_root_model_keys`:
 * a scalar `model`, or a mapping whose id is `default`, `model`, or `name`.
 * Those id fields may themselves be `{ provider, model/default }` mappings.
 * An explicit outer provider wins, except `auto`, where the nested provider is
 * the more specific routing choice. Root-level `provider` is Hermes' legacy
 * fallback. YAML parsing also handles quotes and trailing comments correctly.
 */
function hermesConfigDefault(text: string): { model: string; provider: string } | null {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const config = raw as Record<string, unknown>;
  const rootProvider = yamlString(config.provider);
  if (typeof config.model === "string") {
    const model = config.model.trim();
    return model ? { model, provider: rootProvider } : null;
  }
  if (!config.model || typeof config.model !== "object" || Array.isArray(config.model)) return null;

  const modelConfig = config.model as Record<string, unknown>;
  const outerProvider = yamlString(modelConfig.provider) || rootProvider;
  for (const key of ["default", "model", "name"] as const) {
    const candidate = modelConfig[key];
    const scalar = yamlString(candidate);
    if (scalar) return { model: scalar, provider: outerProvider };
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const nested = candidate as Record<string, unknown>;
    const nestedModel = yamlString(nested.model) || yamlString(nested.default);
    if (!nestedModel) continue;
    const nestedProvider = yamlString(nested.provider);
    const provider = !outerProvider || outerProvider === "auto" ? nestedProvider || outerProvider : outerProvider;
    return { model: nestedModel, provider };
  }
  return null;
}

/** Detect whether Hermes has a hosted provider configured.
 *
 * Hermes supports multiple auth methods:
 * - OpenRouter API key in `~/.hermes/.env` (OPENROUTER_API_KEY)
 * - Nous Portal OAuth (tokens stored in `~/.hermes/` — the default for
 *   `hermes setup` / `hermes login`)
 * - Z.AI / GLM keys in `~/.hermes/.env`
 *
 * Previously only OPENROUTER_API_KEY was checked, so a Nous Portal user
 * — logged in via OAuth, no OpenRouter key — saw "No local models found"
 * despite Hermes being installed, authenticated, and serving 100+ models.
 *
 * Read-only on purpose. `ensureHermesInjectProvider` writes `config.yaml`,
 * and doing that from a catalog probe would rewrite the user's real Hermes
 * config as a side effect of opening a menu.
 *
 * Returns null when no hosted provider is configured, which leaves the
 * catalog exactly as it was for local-only setups.
 */
export function hermesConfiguredModel(
  env: Record<string, string | undefined> = process.env,
): { id: string; label: string; custom: true } | null {
  const dir = hermesHome(env);
  let secrets = "";
  try {
    secrets = readFileSync(join(dir, ".env"), "utf8");
  } catch {
    /* .env may not exist — check OAuth below */
  }

  const hasHostedProviderKey = HERMES_HOSTED_PROVIDER_KEYS.some((name) => nonEmptyDotenvValue(secrets, name));

  // `hermes login` / `hermes setup` records the selected default in
  // config.yaml while the OAuth token lives in Hermes' auth store. An explicit
  // local/custom provider must not trigger the hosted catalog probe.
  let configuredDefault: { model: string; provider: string } | null = null;
  try {
    configuredDefault = hermesConfigDefault(readFileSync(join(dir, "config.yaml"), "utf8"));
  } catch {
    /* config may not exist or may be unreadable */
  }

  const configuredProvider = configuredDefault?.provider.toLowerCase() ?? "";
  // The model/provider selected in config.yaml is the user's explicit routing
  // choice. A stale hosted key must not override an explicitly local setup.
  const configIsLocal =
    HERMES_LOCAL_CONFIG_PROVIDERS.has(configuredProvider) || configuredProvider.startsWith("custom:");
  if (configuredDefault && configIsLocal) return null;

  const configIsHosted = configuredDefault !== null;
  if (!hasHostedProviderKey && !configIsHosted) return null;

  const model = configuredDefault?.model ?? "";
  // `custom: true` is not cosmetic. ModelPicker renders a custom-only agent's
  // *custom* pane exclusively, and that pane lists only options carrying this
  // flag; anything without it lands in the "official" bucket the pane never
  // shows. Omitting it puts the option in the API response while leaving the
  // picker saying "No local models found" — present, but unselectable.
  return {
    id: HERMES_CONFIG_MODEL_ID,
    label: model ? `${model} (Hermes config)` : "Hermes default (config)",
    custom: true as const,
  };
}

/** Ask a short-lived `hermes acp` session what models it can actually run.
 *
 * Hermes advertises its full catalog on `session/new` — every model its
 * configured providers expose, ids shaped `openrouter:qwen/qwen3.8-max`. There
 * is no `hermes models` subcommand, so a throwaway session is the only way to
 * read it, and it is worth the spawn: without it the picker can only offer
 * locally injected hosts, which is a fraction of what the user is paying for.
 *
 * Failure is non-fatal and returns [] — a catalog probe must never be the
 * reason an agent becomes unselectable.
 */
async function fetchHermesAcpModels(
  cli: string,
  env: Record<string, string | undefined>,
): Promise<{ id: string; label: string; custom: true }[]> {
  return await new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cli, ["acp"], { stdio: ["pipe", "pipe", "ignore"], env: env as NodeJS.ProcessEnv });
    } catch {
      return resolve([]);
    }
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let hardKillTimer: ReturnType<typeof setTimeout> | undefined;
    const done = (out: { id: string; label: string; custom: true }[]) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try {
        if (child.kill()) {
          hardKillTimer = setTimeout(() => {
            try {
              child.kill("SIGKILL");
            } catch {
              /* already gone */
            }
          }, 1_000);
          hardKillTimer.unref?.();
        }
      } catch {
        /* already gone */
      }
      resolve(out);
    };
    timer = setTimeout(() => done([]), 5_000);
    child.once("error", () => done([]));
    child.once("close", () => {
      if (hardKillTimer) clearTimeout(hardKillTimer);
      done([]);
    });

    let buf = "";
    let id = 0;
    const send = (method: string, params: unknown) => {
      id += 1;
      try {
        if (!child.stdin?.writable) {
          done([]);
          return 0;
        }
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, (error) => {
          if (error) done([]);
        });
      } catch {
        done([]);
        return 0;
      }
      return id;
    };
    let initId = 0;
    let sessionId = 0;
    child.stdout?.on("data", (chunk) => {
      buf += String(chunk);
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg?.id === initId) {
          if (!msg.result) return done([]);
          sessionId = send("session/new", { cwd: env.HOME || env.USERPROFILE || homedir(), mcpServers: [] });
        } else if (sessionId && msg?.id === sessionId) {
          const list = Array.isArray(msg.result?.models?.availableModels)
            ? msg.result.models.availableModels
            : [];
          done(
            list
              .filter((m: any) => typeof m?.modelId === "string" && m.modelId)
              .map((m: any) => ({
                id: m.modelId as string,
                // Hermes labels these "OpenRouter · <model>"; keep its wording.
                label: (typeof m.name === "string" && m.name.trim()) || (m.modelId as string),
                custom: true as const,
              })),
          );
        }
      }
    });
    initId = send("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });
  });
}

async function resolveModels(
  env: Record<string, string | undefined>,
  config?: { cli?: string },
): Promise<ModelCatalog> {
  const catalog = await mergeLocalInject(EMPTY, env);
  const configured = hermesConfiguredModel(env);
  // Only probe when a hosted provider is configured; a local-only install has
  // nothing to gain from the spawn.
  const remote = configured ? await fetchHermesAcpModels(config?.cli || "hermes", env) : [];
  const seen = new Set<string>();
  const options = [...(configured ? [configured] : []), ...remote, ...catalog.options].filter((o) => {
    if (seen.has(o.id)) return false;
    seen.add(o.id);
    return true;
  });
  return { default: options[0]?.id ?? "", options };
}

async function applySetting(
  request: (method: string, params: unknown, timeoutMs?: number) => Promise<any>,
  method: string,
  params: Record<string, unknown>,
  what: string,
) {
  try {
    await request(method, params);
  } catch (e) {
    throw new Error(`Hermes rejected ${what} via ${method}: ${(e as Error).message}`);
  }
}

const support: AcpSupport = {
  driverKind: "hermesAgent",
  displayName: "Hermes",
  access: "custom",
  models: EMPTY,
  resolveModels: (env: Record<string, string | undefined>, config: any) => resolveModels(env, config),
  resolveTurnModel: (model, env) => {
    if (!model) return model;
    ensureHermesInjectProvider(model, env);
    return model;
  },
  defaultCli: "hermes",
  nativeSource: "hermes.acp",
  loginNote: "Hermes CLI is not installed",
  install: {
    command: {
      darwin: "curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash",
      linux: "curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash",
      win32: "iex (irm https://hermes-agent.nousresearch.com/install.ps1)",
    },
    docsUrl: "https://hermes-agent.nousresearch.com/docs/getting-started/quickstart",
    signInCommand: "hermes setup",
  },
  spawnArgs: () => ["acp"],
  transformEnv: (env) => {
    // A leftover OPENAI_API_KEY makes Hermes auto-resolve to OpenRouter and
    // send no Authorization header. ACP also reloads ~/.hermes/.env, so the
    // named custom provider + session/set_model is the real route.
    delete env.OPENAI_API_KEY;
    delete env.OPENROUTER_API_KEY;
  },
  pickAuthMethod: () => null,
  authFailure: "continue",
  isAuthenticated: () => true,
  async configureSession({ request, sessionId, turn }) {
    // Decode only — resolveTurnModel already wrote the named provider using
    // the instance HOME. Calling ensure* again here would hit process.env
    // and rewrite the user's real ~/.hermes/config.yaml.
    const native = hermesAcpModelId(turn.model);
    if (!native) return;
    await applySetting(
      request,
      "session/set_model",
      { sessionId, modelId: native },
      `model "${native}"`,
    );
  },
  buildPromptText: (turn) => (turn.system ? `${turn.system}\n\n${turn.text}` : turn.text),
};

export const HermesAgentDriver = createAcpDriver(support);
