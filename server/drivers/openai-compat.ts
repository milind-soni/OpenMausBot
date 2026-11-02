// Transcript-replay driver for OpenRouter, Groq, Together, llama.cpp, and
// other endpoints that speak the OpenAI chat-completions contract.
import type { ModelCatalog, ProviderDriver } from "../contracts.ts";
import { isLoopback } from "../provider-key-check.ts";
import { lmStudioV1Catalog } from "./local-inject.ts";
import { createOpenAIChatRuntime } from "./openai-chat.ts";
import {
  freeDefault, freeFallbackCatalog, freeLabel, freeToolModels, freeToolsFirst, isOpenRouterOrigin, openRouterFreeTier,
  withOpenRouterTurns, type OpenRouterModelRow,
} from "./openrouter-free.ts";

const DRIVER_KIND = "openai-compat";
const DEFAULT_IDLE_TIMEOUT_MS = 180_000;
const idleTimeoutMs = () => {
  const raw = process.env.OPENMAUS_OPENAI_COMPAT_IDLE_TIMEOUT_MS;
  if (!raw) return DEFAULT_IDLE_TIMEOUT_MS;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 1_000 && value <= 2_147_483_647 ? value : DEFAULT_IDLE_TIMEOUT_MS;
};
const LIVENESS_EVERY_MS = 30_000;
const livenessEveryMs = () => {
  const value = Number(process.env.OPENMAUS_OPENAI_COMPAT_PROBE_MS);
  return Number.isSafeInteger(value) && value >= 100 ? value : LIVENESS_EVERY_MS;
};
/** Ollama, LM Studio or llama.cpp on this machine or a home or office network: asking it for its models is free. */
export function onThisNetwork(url: string): boolean {
  let host: string;
  try { host = new URL(url).hostname.replace(/^\[|\]$/g, ""); } catch { return false; }
  return isLoopback(host) || host.endsWith(".local") || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) || /^f[cd][0-9a-f]{2}:/i.test(host);
}
const DEFAULT_MODELS: ModelCatalog = {
  default: "meta-llama/llama-3.3-70b-instruct",
  options: [
    { id: "meta-llama/llama-3.3-70b-instruct", label: "Llama 3.3 70B (OpenRouter)", custom: true },
    { id: "llama-3.3-70b-versatile", label: "Llama 3.3 70B (Groq)", custom: true },
  ],
};

const DEFAULT_KEY_ENV = "OPENAI_COMPAT_API_KEY";
/** A provider's own key: such an instance never falls back to the workspace OpenAI-compatible key, URL,
 * model or routing. */
const OWN_KEY_ENVS = new Set(["OMB_OPENAI_API_KEY", "OMB_OPENROUTER_API_KEY"]);

const OPENAI_MODELS: ModelCatalog = {
  default: "gpt-5",
  options: [
    { id: "gpt-5", label: "gpt-5" },
    { id: "gpt-5-mini", label: "gpt-5-mini" },
  ],
};

/** OpenAI's /models also lists embeddings, speech, images, moderation and Responses-only models. */
export function isOpenAIChatModel(id: string): boolean {
  if (!/^(gpt-|chatgpt-|o\d)/i.test(id)) return false;
  return !/(audio|realtime|tts|transcribe|search|image|embedding|moderation|instruct|codex|computer-use|deep-research|-pro\b)/i.test(id);
}

export interface OpenAICompatConfig {
  tools?: boolean;
  url: string;
  apiKeyEnv: string;
  /** Which model list the server serves besides /models: OpenAI's own, or LM Studio's native /api/v1/models. */
  catalog?: "openai" | "lmstudio";
  key?: string;
  model?: string;
  provider?: string;
  managedModels?: string[];
  /** How long a turn waits for the next piece of a reply before giving up; unset follows the server's default. */
  replyWaitMinutes?: number;
}

export const MAX_REPLY_WAIT_MINUTES = 60;
const isReplyWait = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= MAX_REPLY_WAIT_MINUTES;

function positiveTokens(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** The window a /models row advertises: OpenRouter's context_length and top_provider.context_length, vLLM's
 * max_model_len and the like. A serving provider may cap the usable window below the model's nominal one. */
export function advertisedContextWindow(row: Record<string, unknown>): number | undefined {
  const limits = ["context_length", "context_window", "max_model_len", "max_context_length", "contextWindow"].map((key) => positiveTokens(row[key]));
  const provider = row.top_provider;
  if (provider && typeof provider === "object") limits.push(positiveTokens((provider as Record<string, unknown>).context_length));
  const valid = limits.filter((value): value is number => value !== undefined);
  return valid.length ? Math.min(...valid) : undefined;
}

function isOpenRouterUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "openrouter.ai" || host.endsWith(".openrouter.ai");
  } catch {
    return false;
  }
}

function loopbackLmStudioV1Url(baseUrl: string): string | null {
  try {
    const url = new URL(baseUrl);
    const host = url.hostname.toLowerCase();
    if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") return null;
    if (url.pathname.replace(/\/+$/, "") !== "/v1") return null;
    return `${url.origin}/api/v1/models`;
  } catch {
    return null;
  }
}

function decodeConfig(raw: unknown): OpenAICompatConfig {
  const config = (raw ?? {}) as Record<string, unknown>;
  if (config.tools !== undefined && typeof config.tools !== "boolean") throw new Error("tools must be a boolean");
  if (config.managedModels !== undefined && (!Array.isArray(config.managedModels) || !config.managedModels.length || config.managedModels.some(model => typeof model !== "string" || !model.trim()))) throw new Error("Invalid managed models.");
  const ownKey = typeof config.apiKeyEnv === "string" && OWN_KEY_ENVS.has(config.apiKeyEnv);
  if (config.catalog !== undefined && config.catalog !== "openai" && config.catalog !== "lmstudio") throw new Error("catalog must be \"openai\" or \"lmstudio\"");
  if (config.replyWaitMinutes !== undefined && !isReplyWait(config.replyWaitMinutes)) throw new Error(`replyWaitMinutes must be a whole number from 1 to ${MAX_REPLY_WAIT_MINUTES}`);
  const envUrl = ownKey ? undefined : process.env.OPENAI_COMPAT_URL;
  return {
    ...(config.tools !== undefined ? { tools: config.tools as boolean } : {}),
    ...(config.managedModels ? { managedModels: config.managedModels as string[] } : {}),
    ...(isReplyWait(config.replyWaitMinutes) ? { replyWaitMinutes: config.replyWaitMinutes } : {}),
    url: (typeof config.url === "string" && config.url ? config.url : envUrl || "https://openrouter.ai/api/v1")
      .replace(/\/+$/, ""),
    apiKeyEnv: typeof config.apiKeyEnv === "string" && config.apiKeyEnv
      ? config.apiKeyEnv
      : DEFAULT_KEY_ENV,
    ...(config.catalog === "openai" || config.catalog === "lmstudio" ? { catalog: config.catalog } : {}),
    key: typeof config.key === "string" && config.key ? config.key : undefined,
    model: typeof config.model === "string" && config.model
      ? config.model
      : ownKey ? undefined : process.env.OPENAI_COMPAT_MODEL || undefined,
    // An explicit empty override disables inherited routing; absent still inherits the global pin.
    provider: typeof config.provider === "string"
      ? config.provider || undefined
      : ownKey ? undefined : process.env.OPENAI_COMPAT_PROVIDER || undefined,
  };
}

export const OpenAICompatDriver: ProviderDriver<OpenAICompatConfig> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Other (OpenAI-compatible)",
    supportsMultipleInstances: true,
    access: "api",
  },
  models: DEFAULT_MODELS,
  install: {
    docsUrl: "https://openrouter.ai/keys",
    settings: "connections",
    signInCommand: "Save an OpenAI-compatible API key in Settings → API keys, or set OPENAI_COMPAT_API_KEY on the server.",
  },
  decodeConfig,
  defaultConfig: () => decodeConfig({}),

  async create(input) {
    const { config } = input;
    // An instance naming its own key variable reads only that one: the workspace key must not reach its host.
    const ownKeyVariable = config.apiKeyEnv !== DEFAULT_KEY_ENV;
    const apiKey =
      config.key ??
      input.environment[config.apiKeyEnv] ??
      (ownKeyVariable ? undefined : input.environment[DEFAULT_KEY_ENV]) ??
      process.env[config.apiKeyEnv] ??
      (ownKeyVariable ? undefined : process.env[DEFAULT_KEY_ENV]) ??
      "";
    const missingKey = !ownKeyVariable || OWN_KEY_ENVS.has(config.apiKeyEnv)
      ? "No API key — open Settings → API keys."
      : `no API key — set ${config.apiKeyEnv} or add it to the instance config`;
    const seeded = config.catalog === "openai" ? OPENAI_MODELS : DEFAULT_MODELS;
    let catalog: ModelCatalog = config.managedModels
      ? { default: config.managedModels[0], options: config.managedModels.map(id => ({ id, label: id })) }
      : config.model
      ? {
          default: config.model,
          options: seeded.options.some((model) => model.id === config.model)
            ? seeded.options
            : [{ id: config.model, label: config.model, custom: true }, ...seeded.options],
        }
      : seeded;
    const openRouter = Boolean(apiKey) && !config.managedModels && isOpenRouterOrigin(config.url);
    const freeTier = () => openRouter ? openRouterFreeTier(apiKey, config.url) : Promise.resolve(null);

    const fetchModels = async () => {
      if (config.managedModels) return;
      if (!apiKey) return;
      try {
        // Only a server added as LM Studio: any other local server would get a request it never serves.
        const nativeUrl = config.catalog === "lmstudio" ? loopbackLmStudioV1Url(config.url) : null;
        if (nativeUrl) {
          try {
            const native = await fetch(nativeUrl, {
              headers: { authorization: `Bearer ${apiKey}` },
              signal: AbortSignal.timeout(8_000),
            });
            if (native.ok) {
              let parsed: ReturnType<typeof lmStudioV1Catalog> = null;
              try {
                parsed = lmStudioV1Catalog(await native.json());
              } catch {
                parsed = null;
              }
              if (parsed?.ids.length) {
                const options = parsed.ids.map((id) => ({ id, label: id, custom: true as const }));
                if (config.model && !options.some((model) => model.id === config.model)) {
                  options.unshift({ id: config.model, label: config.model, custom: true });
                }
                catalog = {
                  default: config.model ?? options[0]!.id,
                  options,
                };
                return;
              }
            }
          } catch {
            // Native LM Studio catalog unavailable; try OpenAI-compatible /models below.
          }
        }
        const response = await fetch(`${config.url}/models`, {
          headers: { authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(8_000),
        });
        if (!response.ok) return;
        type Row = OpenRouterModelRow & Record<string, unknown> & { name?: unknown; created?: unknown; owned_by?: unknown };
        const json = await response.json() as { data?: Row[] } | Row[];
        let rows = Array.isArray(json) ? json : Array.isArray(json.data) ? json.data : [];
        // OpenAI lists its catalog unordered and mixed with non-chat models.
        if (config.catalog === "openai") {
          rows = rows
            .filter((row) => typeof row.id === "string" && isOpenAIChatModel(row.id))
            .sort((a, b) => (typeof b.created === "number" ? b.created : 0) - (typeof a.created === "number" ? a.created : 0));
        }
        const seen = new Set<string>();
        const options: ModelCatalog["options"] = [];
        for (const row of rows) {
          const id = typeof row.id === "string" ? row.id : "";
          if (!id || seen.has(id)) continue;
          seen.add(id);
          const label = typeof row.name === "string" && row.name.trim() ? row.name : id;
          const contextWindow = advertisedContextWindow(row);
          options.push({
            id,
            label: openRouter ? freeLabel(label, row) : label,
            ...(contextWindow ? { contextWindow } : {}),
            ...(config.catalog === "openai" ? {} : { custom: true }),
          });
        }
        if (!options.length) return;
        // llama.cpp serves its configured slot size, which can be below the model's training window; never autoload.
        for (const selected of rows.filter((row) => row.owned_by === "llamacpp" && typeof row.id === "string")) {
          try {
            const url = new URL(config.url);
            url.pathname = url.pathname.replace(/\/v1\/?$/, "").replace(/\/$/, "") + "/props";
            url.searchParams.set("model", String(selected.id));
            url.searchParams.set("autoload", "false");
            const props = await fetch(url, { redirect: "error", headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(3_000) });
            if (!props.ok) continue;
            const json = await props.json() as { default_generation_settings?: { n_ctx?: unknown } };
            const window = positiveTokens(json.default_generation_settings?.n_ctx);
            const option = options.find((option) => option.id === selected.id);
            if (window && option) option.contextWindow = window;
          } catch {}
        }
        const freeTools = await freeTier() ? freeToolModels(rows) : [];
        const ordered = freeToolsFirst(options, freeTools);
        if (config.model && !ordered.some((model) => model.id === config.model)) {
          ordered.unshift({ id: config.model, label: config.model, custom: true });
        }
        catalog = { default: config.model ?? freeDefault(freeTools) ?? ordered[0].id, options: ordered };
      } catch {}
    };
    const loading = apiKey ? Promise.all([
      config.model ? null : freeTier().then((free) => {
        if (free && catalog === seeded) catalog = freeFallbackCatalog(seeded);
      }),
      fetchModels(),
    ]) : null;

    const runtime = createOpenAIChatRuntime({
      input,
      driverKind: DRIVER_KIND,
      apiKey,
      apiUrl: config.url,
      tools: config.tools,
      computerUse: true,
      nudgeAnnouncedAction: true,
      models: () => catalog,
      refreshModels: fetchModels,
      requestBody: (model, messages, stream) => ({
        model,
        messages,
        stream,
        stream_options: stream ? { include_usage: true } : undefined,
        ...(config.provider && isOpenRouterUrl(config.url)
          ? { provider: { order: [config.provider], allow_fallbacks: false } }
          : {}),
      }),
      httpErrorLabel: "upstream",
      missingKeyError: missingKey,
      unavailableReason: missingKey,
      timeoutMs: config.replyWaitMinutes ? config.replyWaitMinutes * 60_000 : idleTimeoutMs(),
      ...(onThisNetwork(config.url) ? { livenessEveryMs: livenessEveryMs() } : {}),
      reasoning: true,
      billing: "metered",
      includeUsageInCompleted: true,
      nativeLog: {
        source: "openai-compat.chat.completions",
        outgoing: (_turn, messages, model, tools) => ({
          model,
          messageCount: messages.length,
          tools: tools.map(tool => tool.function.name),
        }),
        incoming: ({ text, reasoning, usage }) => ({
          textLength: text.length,
          reasoningLength: reasoning.length,
          usage,
        }),
      },
    });
    return openRouter && loading ? withOpenRouterTurns(runtime, loading) : runtime;
  },
};
