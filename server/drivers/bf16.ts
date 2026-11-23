import { z } from "zod";
import type { ModelCatalog, ProviderDriver } from "../contracts.ts";
import { createOpenAIChatRuntime } from "./openai-chat.ts";

// OpenAI-compatible Chat Completions: https://bf16.ai/docs
const DEFAULT_URL = "https://api.bf16.ai/v1";
// Active tool-calling uncensored open-weight models in bf16.ai's public catalog; the live list
// replaces these once a key is saved.
const DEFAULT_MODELS: ModelCatalog = {
  default: "deepseek/deepseek-v4.1-flash-uncensored",
  options: [
    { id: "deepseek/deepseek-v4.1-flash-uncensored", label: "DeepSeek V4.1 Flash (Uncensored)", contextWindow: 1048576 },
    { id: "deepseek/deepseek-v4.1-flash-uncensored-fast", label: "DeepSeek V4.1 Flash Fast (Uncensored)", contextWindow: 1048576 },
    { id: "zai-org/glm-5.3-flash-uncensored", label: "GLM-5.3 Flash Vision (Uncensored)", contextWindow: 1048576 },
    { id: "zai-org/glm-5.3-uncensored", label: "GLM-5.3 Flagship (Uncensored)", contextWindow: 1048576 },
    { id: "moonshotai/kimi-k3.1-pro-uncensored", label: "Kimi K3.1 Pro (Uncensored)", contextWindow: 1048576 },
    { id: "bf16/auto", label: "bf16 Auto Router", contextWindow: 1048576 },
  ],
};
const DEFAULT_IMAGE_MODELS = [
  "deepseek/deepseek-v4.1-flash-uncensored",
  "deepseek/deepseek-v4.1-flash-uncensored-fast",
  "zai-org/glm-5.3-flash-uncensored",
  "moonshotai/kimi-k3.1-pro-uncensored",
  "bf16/auto",
];
const configSchema = z.object({
  url: z.string().trim().url().default(DEFAULT_URL),
  model: z.string().trim().min(1).optional(),
  tools: z.boolean().optional(),
});
type Bf16Config = z.output<typeof configSchema>;

function decodeConfig(raw: unknown): Bf16Config {
  const config = configSchema.parse(raw ?? {});
  if (config.url.includes("?") || config.url.includes("#")) {
    throw new Error("bf16.ai base URL must not include a query string or fragment.");
  }
  config.url = config.url.replace(/\/+$/, "");
  const url = new URL(config.url);
  if (url.protocol !== "https:" && !(url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
    throw new Error("bf16.ai requires HTTPS, except for a local test endpoint.");
  }
  return config;
}

const modelCard = z.object({
  id: z.string().trim().min(1),
  name: z.string().optional(),
  context_window: z.number().int().positive().optional(),
  context_length: z.number().int().positive().optional(),
  input_modalities: z.array(z.string()).optional(),
  output_modalities: z.array(z.string()).optional(),
  supports_tools: z.boolean().optional(),
  supports_vision: z.boolean().optional(),
  bf16: z.object({
    family: z.string().optional(),
    display_name: z.string().optional(),
    status: z.string().optional(),
    supports_tools: z.boolean().optional(),
    supports_vision: z.boolean().optional(),
  }).optional(),
});
type ModelCard = z.output<typeof modelCard>;

const answersBots = (model: ModelCard) => {
  if (model.bf16?.status && model.bf16.status !== "active") return false;
  if (model.output_modalities && !model.output_modalities.includes("text")) return false;
  if (model.bf16?.family === "router") return true;
  const tools = model.supports_tools ?? model.bf16?.supports_tools;
  return tools !== false;
};
const modelLabel = (model: ModelCard) => model.name?.trim() || model.bf16?.display_name?.trim() || model.id;

export const Bf16Driver: ProviderDriver<Bf16Config> = {
  driverKind: "bf16",
  metadata: { displayName: "bf16.ai (API)", supportsMultipleInstances: true, access: "api" },
  models: DEFAULT_MODELS,
  install: {
    docsUrl: "https://bf16.ai/docs/clients/openmausbot",
    settings: "connections",
    signInCommand: "Save a bf16.ai API key in Settings → AI → Providers, or set BF16_API_KEY on the server.",
  },
  decodeConfig,
  defaultConfig: () => decodeConfig({}),
  async create(input) {
    const { config } = input;
    const apiKey = (input.environment.BF16_API_KEY ??
      (config.url === DEFAULT_URL ? process.env.BF16_API_KEY : undefined) ?? "").trim();
    const withConfiguredModel = (options: ModelCatalog["options"]): ModelCatalog => {
      const preferred = config.model ?? DEFAULT_MODELS.default;
      if (config.model && !options.some((option) => option.id === config.model)) {
        options = [{ id: config.model, label: config.model }, ...options];
      }
      return { default: options.some((option) => option.id === preferred) ? preferred : options[0].id, options };
    };
    let catalog = withConfiguredModel(DEFAULT_MODELS.options);
    let imageModels = new Set(DEFAULT_IMAGE_MODELS);
    const refreshModels = async () => {
      if (!apiKey) return;
      try {
        const response = await fetch(`${config.url}/models`, {
          headers: { authorization: `Bearer ${apiKey}` }, redirect: "error",
          signal: AbortSignal.timeout(8_000),
        });
        if (!response.ok) return;
        const rows = z.object({ data: z.array(z.unknown()) }).parse(await response.json()).data;
        const options: ModelCatalog["options"] = [];
        const images = new Set<string>();
        for (const row of rows) {
          const parsed = modelCard.safeParse(row);
          if (!parsed.success || !answersBots(parsed.data) || options.some((option) => option.id === parsed.data.id)) continue;
          const model = parsed.data;
          const contextWindow = model.context_window ?? model.context_length;
          options.push({ id: model.id, label: modelLabel(model), ...(contextWindow ? { contextWindow } : {}) });
          if (model.supports_vision || model.bf16?.supports_vision || model.input_modalities?.includes("image")) {
            images.add(model.id);
          }
        }
        if (options.length) {
          catalog = withConfiguredModel(options);
          imageModels = images;
        }
      } catch {}
    };
    if (apiKey) void refreshModels();
    return createOpenAIChatRuntime({
      input, driverKind: "bf16", apiKey, apiUrl: config.url,
      tools: config.tools, models: () => catalog, refreshModels, reasoning: true,
      computerUse: true, imageInput: (model) => imageModels.has(model),
      nudgeAnnouncedAction: true,
      requestBody: (model, messages, stream) => ({ model, messages, stream }),
      httpErrorLabel: "bf16.ai",
      missingKeyError: "Save a bf16.ai API key in Settings → AI → Providers, or set BF16_API_KEY.",
      unavailableReason: "No bf16.ai API key — open Settings → AI → Providers.",
      timeoutMs: 180_000, billing: "metered", includeUsageInCompleted: true,
      nativeLog: {
        source: "bf16.chat.completions",
        outgoing: (_turn, messages, model) => ({ model, messageCount: messages.length }),
        incoming: ({ text, reasoning, usage }) => ({ textLength: text.length, reasoningLength: reasoning.length, usage }),
      },
    });
  },
};
