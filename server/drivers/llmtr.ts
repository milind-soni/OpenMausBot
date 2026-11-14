import { z } from "zod";
import type { ModelCatalog, ProviderDriver } from "../contracts.ts";
import { createOpenAIChatRuntime } from "./openai-chat.ts";

// OpenAI-compatible Chat Completions: https://llmtr.com
const DEFAULT_URL = "https://llmtr.com/v1";
// LLMTR's own tool-calling models from the public catalog on 2026-11-14 (https://llmtr.com/v1/models); the live list
// replaces these once a key is saved.
const DEFAULT_MODELS: ModelCatalog = {
  default: "llmtr/qwen3-8-27b",
  options: [
    { id: "llmtr/qwen3-8-27b", label: "Qwen 3.8 27B", contextWindow: 262144 },
    { id: "llmtr/qwen3-6-35b", label: "Qwen 3.6 35B-A3B", contextWindow: 262144 },
    { id: "llmtr/gemma-4", label: "Gemma 4", contextWindow: 131072 },
    { id: "llmtr/muse-glimmer-30b-tr", label: "Muse Glimmer 30B (Türkiye)", contextWindow: 131072 },
  ],
};
const DEFAULT_IMAGE_MODELS = ["llmtr/gemma-4", "llmtr/muse-glimmer-30b-tr"];
const configSchema = z.object({
  url: z.string().trim().url().default(DEFAULT_URL),
  model: z.string().trim().min(1).optional(),
  tools: z.boolean().optional(),
});
type LlmtrConfig = z.output<typeof configSchema>;

function decodeConfig(raw: unknown): LlmtrConfig {
  const config = configSchema.parse(raw ?? {});
  config.url = config.url.replace(/\/+$/, "");
  const url = new URL(config.url);
  if (url.protocol !== "https:" && !(url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
    throw new Error("LLMTR requires HTTPS, except for a local test endpoint.");
  }
  return config;
}

// GET /models, measured 2026-11-14: OpenRouter's shape. Modalities sit under `architecture`, tool support in
// `supported_parameters`, and the list also holds image, video, embedding and speech models.
const modelCard = z.object({
  id: z.string().trim().min(1),
  name: z.string().optional(),
  context_length: z.number().int().positive().optional(),
  architecture: z.object({
    input_modalities: z.array(z.string()).optional(),
    output_modalities: z.array(z.string()).optional(),
  }).optional(),
  supported_parameters: z.array(z.string()).optional(),
  supported_operations: z.array(z.string()).optional(),
});
type ModelCard = z.output<typeof modelCard>;

// A bot's turn always offers tools, so a model that cannot call them is left out of the list.
const answersBots = (model: ModelCard) =>
  (!model.supported_operations || model.supported_operations.includes("CHAT_COMPLETIONS")) &&
  (!model.architecture?.output_modalities || model.architecture.output_modalities.includes("text")) &&
  Boolean(model.supported_parameters?.includes("tools"));
// Some names carry a vendor prefix ("Qwen: Qwen3 14B"); the picker already says LLMTR.
const modelLabel = (model: ModelCard) => model.name?.replace(/^[^:]+:\s*/, "").trim() || model.id;

export const LlmtrDriver: ProviderDriver<LlmtrConfig> = {
  driverKind: "llmtr",
  metadata: { displayName: "LLMTR (API)", supportsMultipleInstances: true, access: "api" },
  models: DEFAULT_MODELS,
  install: {
    docsUrl: "https://llmtr.com",
    settings: "connections",
    signInCommand: "Save an LLMTR API key in Settings → API keys, or set LLMTR_API_KEY on the server.",
  },
  decodeConfig,
  defaultConfig: () => decodeConfig({}),
  async create(input) {
    const { config } = input;
    // A custom host must bring its own credential; the workspace key goes only to LLMTR.
    const apiKey = (input.environment.LLMTR_API_KEY ??
      (config.url === DEFAULT_URL ? process.env.LLMTR_API_KEY : undefined) ?? "").trim();
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
          options.push({ id: model.id, label: modelLabel(model), ...(model.context_length ? { contextWindow: model.context_length } : {}) });
          if (model.architecture?.input_modalities?.includes("image")) images.add(model.id);
        }
        if (options.length) {
          catalog = withConfiguredModel(options);
          imageModels = images;
        }
      } catch {}
    };
    if (apiKey) void refreshModels();
    return createOpenAIChatRuntime({
      input, driverKind: "llmtr", apiKey, apiUrl: config.url,
      tools: config.tools, models: () => catalog, refreshModels, reasoning: true,
      computerUse: true, imageInput: (model) => imageModels.has(model),
      nudgeAnnouncedAction: true,
      requestBody: (model, messages, stream) => ({ model, messages, stream }),
      httpErrorLabel: "LLMTR",
      missingKeyError: "Save an LLMTR API key in Settings → API keys, or set LLMTR_API_KEY.",
      unavailableReason: "No LLMTR API key — open Settings → API keys.",
      timeoutMs: 180_000, billing: "metered", includeUsageInCompleted: true,
      nativeLog: {
        source: "llmtr.chat.completions",
        outgoing: (_turn, messages, model) => ({ model, messageCount: messages.length }),
        incoming: ({ text, reasoning, usage }) => ({ textLength: text.length, reasoningLength: reasoning.length, usage }),
      },
    });
  },
};
