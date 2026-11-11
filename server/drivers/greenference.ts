import { z } from "zod";
import type { ModelCatalog, ProviderDriver } from "../contracts.ts";
import { createOpenAIChatRuntime } from "./openai-chat.ts";

// Chat Completions: https://greenference.com/docs/chat-completions
const DEFAULT_URL = "https://llm.eu.greenference.com/v1";
// The tool-calling models in the public catalog on 2026-10-30 (https://greenference.com/docs/models); the live list
// replaces these once a key is saved.
const DEFAULT_MODELS: ModelCatalog = {
  default: "greenference/glm-5.3-flash",
  options: [
    { id: "greenference/glm-5.3-flash", label: "GLM 5.3 Flash", contextWindow: 1048576 },
    { id: "greenference/qwen3.6-27b", label: "Qwen3.6 27B", contextWindow: 262144 },
    { id: "greenference/gemma-4-31b-it", label: "Gemma 4 31B", contextWindow: 262144 },
    { id: "greenference/glm-4.7-flash", label: "GLM 4.7 Flash", contextWindow: 131072 },
    { id: "greenference/qwen3-14b", label: "Qwen3 14B", contextWindow: 41000 },
  ],
};
const DEFAULT_IMAGE_MODELS = ["greenference/glm-5.3-flash"];
const configSchema = z.object({
  url: z.string().trim().url().default(DEFAULT_URL),
  model: z.string().trim().min(1).optional(),
  tools: z.boolean().optional(),
});
type GreenferenceConfig = z.output<typeof configSchema>;

function decodeConfig(raw: unknown): GreenferenceConfig {
  const config = configSchema.parse(raw ?? {});
  config.url = config.url.replace(/\/+$/, "");
  const url = new URL(config.url);
  if (url.protocol !== "https:" && !(url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
    throw new Error("Greenference requires HTTPS, except for a local test endpoint.");
  }
  return config;
}

const modelCard = z.object({
  id: z.string().trim().min(1),
  name: z.string().optional(),
  context_length: z.number().int().positive().optional(),
  input_modalities: z.array(z.string()).optional(),
  output_modalities: z.array(z.string()).optional(),
  supported_features: z.array(z.string()).optional(),
  is_ready: z.boolean().optional(),
});
type ModelCard = z.output<typeof modelCard>;

// A bot's turn always offers tools, so a model that cannot call them is left out of the list.
const answersBots = (model: ModelCard) => model.is_ready !== false &&
  (!model.output_modalities || model.output_modalities.includes("text")) &&
  (!model.supported_features || model.supported_features.some((feature) => feature === "tools" || feature === "function_calling"));
// The catalog names models "Qwen: Qwen3 14B"; the picker already says Greenference.
const modelLabel = (model: ModelCard) => model.name?.replace(/^[^:]+:\s*/, "").trim() || model.id;

export const GreenferenceDriver: ProviderDriver<GreenferenceConfig> = {
  driverKind: "greenference",
  metadata: { displayName: "Greenference (API)", supportsMultipleInstances: true, access: "api" },
  models: DEFAULT_MODELS,
  install: {
    docsUrl: "https://greenference.com/docs",
    settings: "connections",
    signInCommand: "Save a Greenference API key in Settings → API keys, or set GREENFERENCE_API_KEY on the server.",
  },
  decodeConfig,
  defaultConfig: () => decodeConfig({}),
  async create(input) {
    const { config } = input;
    // A custom host must bring its own credential; the workspace key goes only to Greenference.
    const apiKey = (input.environment.GREENFERENCE_API_KEY ??
      (config.url === DEFAULT_URL ? process.env.GREENFERENCE_API_KEY : undefined) ?? "").trim();
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
        // The list is public; with the key it also has the account's own models.
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
          options.push({ id: model.id, label: modelLabel(model), ...(model.context_length ? { contextWindow: model.context_length } : {}) });
          if (model.input_modalities?.includes("image")) images.add(model.id);
        }
        if (options.length) {
          catalog = withConfiguredModel(options);
          imageModels = images;
        }
      } catch {}
    };
    if (apiKey) void refreshModels();
    return createOpenAIChatRuntime({
      input, driverKind: "greenference", apiKey, apiUrl: config.url,
      tools: config.tools, models: () => catalog, refreshModels, reasoning: true,
      computerUse: true, imageInput: (model) => imageModels.has(model),
      nudgeAnnouncedAction: true,
      requestBody: (model, messages, stream) => ({ model, messages, stream }),
      httpErrorLabel: "Greenference",
      missingKeyError: "Save a Greenference API key in Settings → API keys, or set GREENFERENCE_API_KEY.",
      unavailableReason: "No Greenference API key — open Settings → API keys.",
      timeoutMs: 180_000, billing: "metered", includeUsageInCompleted: true,
      nativeLog: {
        source: "greenference.chat.completions",
        outgoing: (_turn, messages, model) => ({ model, messageCount: messages.length }),
        incoming: ({ text, reasoning, usage }) => ({ textLength: text.length, reasoningLength: reasoning.length, usage }),
      },
    });
  },
};
