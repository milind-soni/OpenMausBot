import { z } from "zod";
import type { ModelCatalog, ProviderDriver } from "../contracts.ts";
import { createOpenAIChatRuntime } from "./openai-chat.ts";

// Chat Completions: https://llmtr.com/v1/chat/completions
const DEFAULT_URL = "https://llmtr.com/v1";
// A short fallback list from the public catalog on 2026-11-14 (https://llmtr.com/v1/models); the live list
// replaces these once a key is saved.
const DEFAULT_MODELS: ModelCatalog = {
  default: "minimax/minimax-m3.1-flash-free",
  options: [
    { id: "minimax/minimax-m3.1-flash-free", label: "MiniMax M3.1 Flash (free)", contextWindow: 1000000 },
    { id: "minimax/minimax-m3.1-flash", label: "MiniMax M3.1 Flash", contextWindow: 1000000 },
    { id: "qwen/qwen3.8-27b-free", label: "Qwen3.8 27B (free)", contextWindow: 131042 },
    { id: "nvidia/nemotron-3.5-super-vl-free", label: "Nemotron 3.5 Super VL (free)", contextWindow: 1000000 },
    { id: "agnes/agnes-3.0-flash", label: "Agnes 3.0 Flash", contextWindow: 524288 },
  ],
};
const DEFAULT_IMAGE_MODELS = ["nvidia/nemotron-3.5-super-vl-free"];
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
// The catalog sometimes prefixes names with a vendor; the picker already says LLMTR.
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
