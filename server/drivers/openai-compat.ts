// Transcript-replay driver for OpenRouter, Groq, Together, llama.cpp, and
// other endpoints that speak the OpenAI chat-completions contract.
import type { ModelCatalog, ProviderDriver } from "../contracts.ts";
import { createOpenAIChatRuntime } from "./openai-chat.ts";

const DRIVER_KIND = "openai-compat";
const DEFAULT_MODELS: ModelCatalog = {
  default: "meta-llama/llama-3.3-70b-instruct",
  options: [
    { id: "meta-llama/llama-3.3-70b-instruct", label: "Llama 3.3 70B (OpenRouter)", custom: true },
    { id: "llama-3.3-70b-versatile", label: "Llama 3.3 70B (Groq)", custom: true },
  ],
};

export interface OpenAICompatConfig {
  url: string;
  apiKeyEnv: string;
  key?: string;
  model?: string;
  provider?: string;
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
  const envUrl = process.env.OPENAI_COMPAT_URL;
  return {
    url: (typeof config.url === "string" && config.url ? config.url : envUrl || "https://openrouter.ai/api/v1")
      .replace(/\/+$/, ""),
    apiKeyEnv: typeof config.apiKeyEnv === "string" && config.apiKeyEnv
      ? config.apiKeyEnv
      : "OPENAI_COMPAT_API_KEY",
    key: typeof config.key === "string" && config.key ? config.key : undefined,
    model: typeof config.model === "string" && config.model
      ? config.model
      : process.env.OPENAI_COMPAT_MODEL || undefined,
    // An explicit empty override disables inherited routing for an isolated
    // connection (CLI setup uses this). Absent still inherits the global pin.
    provider: typeof config.provider === "string"
      ? config.provider || undefined
      : process.env.OPENAI_COMPAT_PROVIDER || undefined,
  };
}

export const OpenAICompatDriver: ProviderDriver<OpenAICompatConfig> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "OpenAI-compatible (OpenRouter / Groq)",
    supportsMultipleInstances: true,
    access: "custom",
  },
  models: DEFAULT_MODELS,
  install: {
    docsUrl: "https://openrouter.ai/keys",
    signInCommand:
      "add {\"openaiCompat\":{\"key\":\"sk-or-v1-…\"}} to ~/.openmausbot/config.json (or set OPENAI_COMPAT_API_KEY)",
    command: {
      darwin:
        "Get a free key at https://openrouter.ai/keys (or https://console.groq.com) then add it to ~/.openmausbot/config.json under openaiCompat.key",
      linux:
        "Get a free key at https://openrouter.ai/keys (or https://console.groq.com) then add it to ~/.openmausbot/config.json under openaiCompat.key",
      win32:
        "Get a free key at https://openrouter.ai/keys (or https://console.groq.com) then add it to %USERPROFILE%\\.openmausbot\\config.json under openaiCompat.key",
    },
  },
  decodeConfig,
  defaultConfig: () => decodeConfig({}),

  async create(input) {
    const { config } = input;
    const apiKey =
      config.key ??
      input.environment[config.apiKeyEnv] ??
      input.environment.OPENAI_COMPAT_API_KEY ??
      process.env[config.apiKeyEnv] ??
      process.env.OPENAI_COMPAT_API_KEY ??
      "";
    let catalog: ModelCatalog = config.model
      ? {
          default: config.model,
          options: DEFAULT_MODELS.options.some((model) => model.id === config.model)
            ? DEFAULT_MODELS.options
            : [{ id: config.model, label: config.model, custom: true }, ...DEFAULT_MODELS.options],
        }
      : DEFAULT_MODELS;

    const fetchModels = async () => {
      if (!apiKey) return;
      try {
        const response = await fetch(`${config.url}/models`, {
          headers: { authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(8_000),
        });
        if (!response.ok) return;
        const json = await response.json() as { data?: Array<{ id?: unknown; name?: unknown }> } | Array<{ id?: unknown; name?: unknown }>;
        const rows = Array.isArray(json) ? json : Array.isArray(json.data) ? json.data : [];
        const seen = new Set<string>();
        const options: ModelCatalog["options"] = [];
        for (const row of rows) {
          const id = typeof row.id === "string" ? row.id : "";
          if (!id || seen.has(id)) continue;
          seen.add(id);
          options.push({
            id,
            label: typeof row.name === "string" && row.name.trim() ? row.name : id,
            custom: true,
          });
        }
        if (!options.length) return;
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
      models: () => catalog,
      refreshModels: fetchModels,
      requestBody: (model, messages, stream) => ({
        model,
        messages,
        stream,
        ...(config.provider && isOpenRouterUrl(config.url)
          ? { provider: { order: [config.provider], allow_fallbacks: false } }
          : {}),
      }),
      httpErrorLabel: "upstream",
      missingKeyError: `no API key — set ${config.apiKeyEnv} or add it to the instance config`,
      unavailableReason: `no API key — set ${config.apiKeyEnv} or add it to the instance config`,
      timeoutMs: 120_000,
      reasoning: true,
      billing: "metered",
      includeUsageInCompleted: true,
      nativeLog: {
        source: "openai-compat.chat.completions",
        outgoing: (_turn, messages, model) => ({ model, messageCount: messages.length }),
        incoming: ({ text, reasoning, usage }) => ({
          textLength: text.length,
          reasoningLength: reasoning.length,
          usage,
        }),
      },
    });
  },
};
