// Transcript-replay driver for OpenRouter, Groq, Together, llama.cpp, and
// other endpoints that speak the OpenAI chat-completions contract.
import type { ModelCatalog, ProviderDriver } from "../contracts.ts";
import { normalizeApiUrl } from "../cli-api-setup.ts";
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

export interface OpenAICompatConfig {
  tools?: boolean;
  /** Present for independent connections; absence retains legacy environment defaults. */
  auth?: "bearer" | "none";
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
  if (config.tools !== undefined && typeof config.tools !== "boolean") throw new Error("tools must be a boolean");
  if (config.auth !== undefined && config.auth !== "bearer" && config.auth !== "none") throw new Error("auth must be bearer or none");
  const independent = config.auth !== undefined;
  if (independent && (typeof config.url !== "string" || !config.url.trim())) throw new Error("An independent connection requires an API URL");
  const envUrl = independent ? undefined : process.env.OPENAI_COMPAT_URL;
  const url = (typeof config.url === "string" && config.url ? config.url : envUrl || "https://openrouter.ai/api/v1").replace(/\/+$/, "");
  return {
    ...(independent ? { auth: config.auth as "bearer" | "none" } : {}),
    ...(config.tools !== undefined ? { tools: config.tools as boolean } : {}),
    url: independent ? normalizeApiUrl(url) : url,
    apiKeyEnv: typeof config.apiKeyEnv === "string" && config.apiKeyEnv
      ? config.apiKeyEnv
      : "OPENAI_COMPAT_API_KEY",
    key: typeof config.key === "string" && config.key ? config.key : undefined,
    model: typeof config.model === "string" && config.model
      ? config.model
      : independent ? undefined : process.env.OPENAI_COMPAT_MODEL || undefined,
    // An explicit empty override disables inherited routing for an isolated
    // connection (CLI setup uses this). Absent still inherits the global pin.
    provider: typeof config.provider === "string"
      ? config.provider || undefined
      : independent ? undefined : process.env.OPENAI_COMPAT_PROVIDER || undefined,
  };
}

/** Resolve exactly the credential the runtime sends, without making a request. */
export function resolveOpenAICompatKey(config: OpenAICompatConfig, environment: Record<string, string>): string {
  if (config.auth === "none") return "";
  if (config.auth === "bearer") return config.key ?? "";
  return config.key ?? environment[config.apiKeyEnv] ?? environment.OPENAI_COMPAT_API_KEY
    ?? process.env[config.apiKeyEnv] ?? process.env.OPENAI_COMPAT_API_KEY ?? "";
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
    const apiKey = resolveOpenAICompatKey(config, input.environment);
    const configured = config.auth === "none" || !!apiKey;
    const missingKey = config.auth === "bearer"
      ? "no API key — add one to this connection"
      : `no API key — set ${config.apiKeyEnv} or add it to the instance config`;
    let catalog: ModelCatalog = config.auth !== undefined
      ? { default: config.model ?? "", options: config.model ? [{ id: config.model, label: config.model, custom: true }] : [] }
      : config.model
      ? {
          default: config.model,
          options: DEFAULT_MODELS.options.some((model) => model.id === config.model)
            ? DEFAULT_MODELS.options
            : [{ id: config.model, label: config.model, custom: true }, ...DEFAULT_MODELS.options],
        }
      : DEFAULT_MODELS;

    const fetchModels = async () => {
      if (!configured) return;
      try {
        const response = await fetch(`${config.url}/models`, {
          headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
          redirect: "error",
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
    if (configured) void fetchModels();

    return createOpenAIChatRuntime({
      input,
      driverKind: DRIVER_KIND,
      apiKey,
      allowUnauthenticated: config.auth === "none",
      apiUrl: config.url,
      tools: config.tools,
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
      timeoutMs: idleTimeoutMs(),
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
