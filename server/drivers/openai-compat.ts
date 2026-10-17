// Transcript-replay driver for OpenRouter, Groq, Together, llama.cpp, and
// other endpoints that speak the OpenAI chat-completions contract.
import type { ModelCatalog, ProviderDriver } from "../contracts.ts";
import { createOpenAIChatRuntime } from "./openai-chat.ts";

const DRIVER_KIND = "openai-compat";
const DEFAULT_IDLE_TIMEOUT_MS = 180_000;
const idleTimeoutMs = () => {
  const raw = process.env.OPENMAUS_OPENAI_COMPAT_IDLE_TIMEOUT_MS;
  if (!raw) return DEFAULT_IDLE_TIMEOUT_MS;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 1_000 && value <= 2_147_483_647 ? value : DEFAULT_IDLE_TIMEOUT_MS;
};
const DEFAULT_MODELS: ModelCatalog = {
  default: "meta-llama/llama-3.3-70b-instruct",
  options: [
    { id: "meta-llama/llama-3.3-70b-instruct", label: "Llama 3.3 70B (OpenRouter)", custom: true },
    { id: "llama-3.3-70b-versatile", label: "Llama 3.3 70B (Groq)", custom: true },
  ],
};

const DEFAULT_KEY_ENV = "OPENAI_COMPAT_API_KEY";
 const OWN_KEY_ENVS = new Set(["OMB_OPENAI_API_KEY", "OMB_OPENROUTER_API_KEY"]);

 const OPENAI_MODELS: ModelCatalog = {
  default: "gpt-5",
  options: [
    { id: "gpt-5", label: "gpt-5" },
    { id: "gpt-5-mini", label: "gpt-5-mini" },
  ],
};

 export function isOpenAIChatModel(id: string): boolean {
  if (!/^(gpt-|chatgpt-|o\d)/i.test(id)) return false;
  return !/(audio|realtime|tts|transcribe|search|image|embedding|moderation|instruct|codex|computer-use|deep-research|-pro\b)/i.test(id);
}

export interface OpenAICompatConfig {
  tools?: boolean;
  url: string;
  apiKeyEnv: string;
  catalog?: "openai";
  key?: string;
  model?: string;
  provider?: string;
  managedModels?: string[];
  contextWindows?: Record<string, number>;
}

function positiveTokens(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function advertisedContextWindow(row: Record<string, unknown>): number | undefined {
  const limits = ["context_length", "context_window", "max_model_len", "max_context_length", "contextWindow"]
    .map(key => positiveTokens(row[key]));
  const provider = row.top_provider;
  if (provider && typeof provider === "object") limits.push(positiveTokens((provider as Record<string, unknown>).context_length));
  const valid = limits.filter((value): value is number => value !== undefined);
  // A serving provider may cap the usable window below the model's nominal limit.
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

function decodeConfig(raw: unknown): OpenAICompatConfig {
  const config = (raw ?? {}) as Record<string, unknown>;
  if (config.tools !== undefined && typeof config.tools !== "boolean") throw new Error("tools must be a boolean");
  if (config.managedModels !== undefined && (!Array.isArray(config.managedModels) || !config.managedModels.length || config.managedModels.some(model => typeof model !== "string" || !model.trim()))) throw new Error("Invalid managed models.");
  const windows = config.contextWindows;
  if (windows !== undefined && (typeof windows !== "object" || windows === null || Array.isArray(windows)
    || Object.entries(windows).some(([id, value]) => !id.trim() || typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0))) {
    throw new Error("contextWindows must map model IDs to positive integer token limits");
  }
  const ownKey = typeof config.apiKeyEnv === "string" && OWN_KEY_ENVS.has(config.apiKeyEnv);
  if (config.catalog !== undefined && config.catalog !== "openai") throw new Error("catalog must be \"openai\"");
  const envUrl = ownKey ? undefined : process.env.OPENAI_COMPAT_URL;
  return {
    ...(config.tools !== undefined ? { tools: config.tools as boolean } : {}),
    ...(windows ? { contextWindows: windows as Record<string, number> } : {}),
    ...(config.managedModels ? { managedModels: config.managedModels as string[] } : {}),
    url: (typeof config.url === "string" && config.url ? config.url : envUrl || "https://openrouter.ai/api/v1")
      .replace(/\/+$/, ""),
    apiKeyEnv: typeof config.apiKeyEnv === "string" && config.apiKeyEnv
      ? config.apiKeyEnv
      : DEFAULT_KEY_ENV,
    ...(config.catalog === "openai" ? { catalog: "openai" as const } : {}),
    key: typeof config.key === "string" && config.key ? config.key : undefined,
    model: typeof config.model === "string" && config.model
      ? config.model
      : ownKey ? undefined : process.env.OPENAI_COMPAT_MODEL || undefined,
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

    const fetchModels = async () => {
      if (config.managedModels) return;
      if (!apiKey) return;
      try {
        const response = await fetch(`${config.url}/models`, {
          headers: { authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(8_000),
        });
        if (!response.ok) return;
        type Row = Record<string, unknown>;
        const json = await response.json() as { data?: Row[] } | Row[];
        let rows = Array.isArray(json) ? json : Array.isArray(json.data) ? json.data : [];
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
          const contextWindow = advertisedContextWindow(row);
          options.push({
            id,
            label: typeof row.name === "string" && row.name.trim() ? row.name : id,
            ...(contextWindow ? { contextWindow } : {}),
            ...(config.catalog === "openai" ? {} : { custom: true }),
          });
        }
        if (!options.length) return;
        // llama.cpp's training window can exceed its configured slot size.
        // Query the active model without autoloading another model.
        for (const selected of rows.filter(row => row.owned_by === "llamacpp" && typeof row.id === "string")) {
          try {
            const url = new URL(config.url);
            url.pathname = url.pathname.replace(/\/v1\/?$/, "").replace(/\/$/, "") + "/props";
            url.searchParams.set("model", String(selected.id));
            url.searchParams.set("autoload", "false");
            const props = await fetch(url, { redirect: "error", headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(3_000) });
            if (props.ok) {
              const json = await props.json() as { default_generation_settings?: { n_ctx?: unknown } };
              const window = positiveTokens(json.default_generation_settings?.n_ctx);
              const option = options.find(option => option.id === selected.id);
              if (window && option) option.contextWindow = window;
            }
          } catch { /* optional runtime metadata; retain the catalog */ }
        }
        if (config.model && !options.some((model) => model.id === config.model)) {
          options.unshift({ id: config.model, label: config.model, custom: true });
        }
        catalog = { default: config.model ?? options[0].id, options };
      } catch {
        // Catalog refresh is opportunistic; keep the seeded options.
      }
    };
    if (apiKey) void fetchModels();

    return createOpenAIChatRuntime({
      input,
      driverKind: DRIVER_KIND,
      apiKey,
      apiUrl: config.url,
      tools: config.tools,
      computerUse: true,
      models: () => {
        const windows = config.contextWindows;
        if (!windows || !Object.keys(windows).length) return catalog;
        const options = catalog.options.map(option => windows[option.id] ? { ...option, contextWindow: windows[option.id] } : option);
        if (!config.managedModels) for (const [id, contextWindow] of Object.entries(windows)) {
          if (!options.some(option => option.id === id)) options.push({ id, label: id, custom: true, contextWindow });
        }
        return { ...catalog, options };
      },
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
      timeoutMs: idleTimeoutMs(),
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
  },
};
