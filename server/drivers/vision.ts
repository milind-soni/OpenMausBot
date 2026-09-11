// Unified Vision Engine — combines all model providers through freellmapi
// with optional DeepSeek direct and RLM harness support
import type { ModelCatalog, ProviderDriver } from "../contracts.ts";
import { createOpenAIChatRuntime } from "./openai-chat.ts";

const DRIVER_KIND = "vision";

// Every seeded option carries `custom: true`: this engine advertises
// `access: "custom"`, and the picker renders only custom-flagged options for
// such engines — an unflagged one is invisible in its own picker.
const DEFAULT_MODELS: ModelCatalog = {
  default: "auto",
  options: [
    { id: "auto", label: "Auto (freellmapi routes to best)", custom: true },
    { id: "openrouter:anthropic/claude-3.5-sonnet", label: "Claude 3.5 Sonnet (OpenRouter)", custom: true },
    { id: "openrouter:deepseek/deepseek-v4-flash", label: "DeepSeek V4 Flash (OpenRouter)", custom: true },
    { id: "openrouter:deepseek/deepseek-coder", label: "DeepSeek Coder (OpenRouter)", custom: true },
    { id: "openrouter:meta-llama/llama-3.3-70b-instruct", label: "Llama 3.3 70B (OpenRouter)", custom: true },
    { id: "openrouter:google/gemini-2.0-flash", label: "Gemini 2.0 Flash (OpenRouter)", custom: true },
    { id: "openrouter:qwen/qwen-2.5-coder-32b-instruct", label: "Qwen 2.5 Coder 32B (OpenRouter)", custom: true },
    { id: "openrouter:z-ai/glm-4.5-air", label: "GLM 4.5 Air (OpenRouter)", custom: true },
    { id: "direct:deepseek-chat", label: "DeepSeek Chat (Direct API)", custom: true },
    { id: "direct:deepseek-coder", label: "DeepSeek Coder (Direct API)", custom: true },
    { id: "rlm:auto", label: "RLM Auto (Harness)", custom: true },
  ],
};

export interface VisionConfig {
  url: string;
  apiKeyEnv: string;
  key?: string;
  model?: string;
}

// freellmapi routes by model-name prefix (direct:* -> DeepSeek, rlm:* -> the
// RLM harness, everything else through its own provider pool), so the driver
// config needs only an endpoint, a credential env name, and a default model.
function decodeConfig(raw: unknown): VisionConfig {
  const config = (raw ?? {}) as Record<string, unknown>;
  const envUrl = process.env.VISION_URL;
  return {
    url: (typeof config.url === "string" && config.url ? config.url : envUrl || "http://localhost:3001/v1")
      .replace(/\/+$/, ""),
    apiKeyEnv: typeof config.apiKeyEnv === "string" && config.apiKeyEnv
      ? config.apiKeyEnv
      : "FREELLMAPI_API_KEY",
    key: typeof config.key === "string" && config.key ? config.key : undefined,
    model: typeof config.model === "string" && config.model
      ? config.model
      : process.env.VISION_MODEL || "auto",
  };
}

export const VisionDriver: ProviderDriver<VisionConfig> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Vision (Unified: freellmapi + DeepSeek + RLM)",
    supportsMultipleInstances: true,
    access: "custom",
  },
  models: DEFAULT_MODELS,
  install: {
    docsUrl: "https://github.com/freellmapi/freellmapi",
    signInCommand:
      'add {"vision":{"key":"sk-..."}} to ~/.openmausbot/config.json (or set FREELLMAPI_API_KEY)',
    command: {
      darwin: "Get a free key from freellmapi or set up local proxy at http://localhost:3001/v1",
      linux: "Get a free key from freellmapi or set up local proxy at http://localhost:3001/v1",
      win32: "Get a free key from freellmapi or set up local proxy at http://localhost:3001/v1",
    },
  },
  decodeConfig,
  defaultConfig: () => decodeConfig({}),

  async create(input) {
    const { config } = input;
    const apiKey =
      config.key ??
      input.environment[config.apiKeyEnv] ??
      input.environment.FREELLMAPI_API_KEY ??
      process.env[config.apiKeyEnv] ??
      process.env.FREELLMAPI_API_KEY ??
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

    // The freellmapi handles model routing via model name prefixes
    // Models prefixed with "direct:" go to DeepSeek, "rlm:" goes to RLM harness
    // Others go through freellmapi which routes to OpenRouter/other providers

    return createOpenAIChatRuntime({
      input,
      driverKind: DRIVER_KIND,
      apiKey,
      apiUrl: config.url,
      models: () => catalog,
      refreshModels: fetchModels,
      requestBody: (model, messages, stream) => ({
        // freellmapi handles routing based on model name:
        // direct:* -> DeepSeek, rlm:* -> RLM, others -> OpenRouter via freellmapi
        model,
        messages,
        stream,
      }),
      httpErrorLabel: "upstream",
      missingKeyError: `no API key — set ${config.apiKeyEnv} or add it to the instance config`,
      unavailableReason: `no API key — set ${config.apiKeyEnv} or add it to the instance config`,
      timeoutMs: 120_000,
      reasoning: true,
      billing: "metered",
      includeUsageInCompleted: true,
      nativeLog: {
        source: "vision.chat.completions",
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