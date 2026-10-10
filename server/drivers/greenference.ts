import { z } from "zod";
import type { ModelCatalog, ProviderDriver } from "../contracts.ts";
import { normalizeApiUrl } from "../cli-api-setup.ts";
import { createOpenAIChatRuntime } from "./openai-chat.ts";

// https://greenference.com/docs — use Chat Completions, not the limited
// Responses subset. Model availability and image support come from /models.
const DEFAULT_URL = "https://llm.eu.greenference.com/v1";
// A tool-capable model observed in the public catalog on 2026-10-08.
// Only a startup fallback: the live catalog replaces it, including its limits.
const DEFAULT_MODELS: ModelCatalog = {
  default: "greenference/qwen3.6-27b",
  options: [{ id: "greenference/qwen3.6-27b", label: "Qwen3.6 27B", contextWindow: 262144 }],
};
const configSchema = z.object({
  url: z.string().default(DEFAULT_URL), model: z.string().trim().min(1).optional(), tools: z.boolean().optional(),
});
type GreenferenceConfig = z.output<typeof configSchema>;
const decodeConfig = (raw: unknown): GreenferenceConfig => {
  const config = configSchema.parse(raw ?? {});
  return { ...config, url: normalizeApiUrl(config.url) };
};
const modelCard = z.object({
  id: z.string().trim().min(1), name: z.string().optional(),
  context_length: z.number().int().positive().optional(),
  input_modalities: z.array(z.string()).optional(), output_modalities: z.array(z.string()).optional(),
  is_ready: z.boolean().optional(),
});

export const GreenferenceDriver: ProviderDriver<GreenferenceConfig> = {
  driverKind: "greenference",
  metadata: { displayName: "Greenference (API)", supportsMultipleInstances: true, access: "api" },
  models: DEFAULT_MODELS,
  install: {
    docsUrl: "https://greenference.com/dashboard/tokens", settings: "connections",
    signInCommand: "Save a Greenference API token in Settings → API keys, or set GREENFERENCE_TOKEN on the server.",
  },
  decodeConfig, defaultConfig: () => decodeConfig({}),
  async create(input) {
    const { config } = input;
    const apiKey = (input.environment.GREENFERENCE_TOKEN
      ?? (config.url === DEFAULT_URL ? process.env.GREENFERENCE_TOKEN : undefined) ?? "").trim();
    const withConfiguredModel = (options: ModelCatalog["options"]): ModelCatalog => {
      const preferred = config.model ?? DEFAULT_MODELS.default;
      if (config.model && !options.some((option) => option.id === config.model)) {
        options = [{ id: config.model, label: config.model, custom: true }, ...options];
      }
      return { default: options.some((option) => option.id === preferred) ? preferred : options[0]?.id ?? preferred, options };
    };
    let catalog = withConfiguredModel(DEFAULT_MODELS.options);
    let imageModels = new Set<string>();
    const refreshModels = async () => {
      if (!apiKey) return;
      try {
        const response = await fetch(`${config.url}/models`, {
          headers: { authorization: `Bearer ${apiKey}` }, redirect: "error", signal: AbortSignal.timeout(8_000),
        });
        if (!response.ok) return;
        const { data } = z.object({ data: z.array(z.unknown()) }).parse(await response.json());
        const options: ModelCatalog["options"] = [];
        const seen = new Set<string>();
        const images = new Set<string>();
        for (const row of data) {
          const parsed = modelCard.safeParse(row);
          if (!parsed.success) continue;
          const model = parsed.data;
          if (seen.has(model.id) || model.is_ready === false || (model.output_modalities && !model.output_modalities.includes("text"))) continue;
          seen.add(model.id);
          options.push({ id: model.id, label: model.name?.trim() || model.id,
            ...(model.context_length ? { contextWindow: model.context_length } : {}) });
          if (model.input_modalities?.includes("image")) images.add(model.id);
        }
        catalog = withConfiguredModel(options);
        imageModels = images;
      } catch {
        // Failed refreshes retain the last catalog; a valid empty catalog does not.
      }
    };
    if (apiKey) await refreshModels();
    return createOpenAIChatRuntime({
      input, driverKind: "greenference", apiKey, apiUrl: config.url,
      tools: config.tools, models: () => catalog, refreshModels, reasoning: true,
      computerUse: true, imageInput: (model) => imageModels.has(model),
      requestBody: (model, messages, stream) => ({ model, messages, stream }),
      httpErrorLabel: "Greenference",
      missingKeyError: "Save a Greenference API token in Settings → API keys, or set GREENFERENCE_TOKEN.",
      unavailableReason: "No Greenference API token — open Settings → API keys.",
      timeoutMs: 180_000, billing: "metered", includeUsageInCompleted: true,
      nativeLog: {
        source: "greenference.chat.completions",
        outgoing: (_turn, messages, model) => ({ model, messageCount: messages.length }),
        incoming: ({ text, reasoning, usage }) => ({ textLength: text.length, reasoningLength: reasoning.length, usage }),
      },
    });
  },
};
