import { z } from "zod";
import type { ModelCatalog, ProviderDriver } from "../contracts.ts";
import { createOpenAIChatRuntime } from "./openai-chat.ts";

// Cerebras serves open models on wafer-scale chips: same OpenAI chat
// contract, several times the tokens per second of a GPU cloud.
const DEFAULT_URL = "https://api.cerebras.ai/v1";
// The account tier is unknown: use the shared free-tier limit, not paid 128K.
// https://inference-docs.cerebras.ai/models/overview
const DEFAULT_MODELS: ModelCatalog = {
  default: "gpt-oss-120b",
  options: [
    { id: "gpt-oss-120b", label: "GPT OSS 120B", contextWindow: 65536 },
    { id: "qwen-3.8-27b", label: "Qwen3.8 27B", contextWindow: 65536 },
  ],
};
const configSchema = z.object({
  url: z.string().trim().url().default(DEFAULT_URL),
  model: z.string().trim().min(1).optional(),
  tools: z.boolean().optional(),
});
type CerebrasConfig = z.output<typeof configSchema>;

function decodeConfig(raw: unknown): CerebrasConfig {
  const config = configSchema.parse(raw ?? {});
  config.url = config.url.replace(/\/+$/, "");
  const url = new URL(config.url);
  if (url.protocol !== "https:" && !(url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
    throw new Error("Cerebras requires HTTPS, except for a local test endpoint.");
  }
  return config;
}

const modelCard = z.object({ id: z.string().min(1) });

/** Cerebras answers "Only 'text' content type can be used" for these. */
const TEXT_ONLY_MODELS = /^(?:gpt-oss|llama3\.1-8b|llama-3\.3-70b)/i;

export const CerebrasDriver: ProviderDriver<CerebrasConfig> = {
  driverKind: "cerebras",
  metadata: { displayName: "Cerebras (API)", supportsMultipleInstances: true, access: "api" },
  models: DEFAULT_MODELS,
  install: {
    docsUrl: "https://cloud.cerebras.ai/",
    settings: "connections",
    signInCommand: "Save a Cerebras API key in Settings → Connections, or set CEREBRAS_API_KEY on the server.",
  },
  decodeConfig,
  defaultConfig: () => decodeConfig({}),
  async create(input) {
    const { config } = input;
    const apiKey = (input.environment.CEREBRAS_API_KEY ?? process.env.CEREBRAS_API_KEY ?? "").trim();
    const known = new Map(DEFAULT_MODELS.options.map((option) => [option.id, option]));
    const withConfiguredModel = (options: ModelCatalog["options"]): ModelCatalog => {
      const preferred = config.model ?? DEFAULT_MODELS.default;
      if (config.model && !options.some((option) => option.id === config.model)) {
        options = [{ id: config.model, label: config.model }, ...options];
      }
      return { default: options.some((option) => option.id === preferred) ? preferred : options[0].id, options };
    };
    let catalog = withConfiguredModel(DEFAULT_MODELS.options);
    const refreshModels = async () => {
      if (!apiKey) return;
      try {
        const response = await fetch(`${config.url}/models`, {
          headers: { authorization: `Bearer ${apiKey}` },
          redirect: "error",
          signal: AbortSignal.timeout(8_000),
        });
        if (!response.ok) return;
        const json: unknown = await response.json();
        const rows = Array.isArray(json) ? json : z.object({ data: z.array(z.unknown()) }).parse(json).data;
        const options: ModelCatalog["options"] = [];
        const seen = new Set<string>();
        for (const row of rows) {
          const parsed = modelCard.safeParse(row);
          if (!parsed.success || !parsed.data.id.trim() || seen.has(parsed.data.id)) continue;
          seen.add(parsed.data.id);
          options.push(known.get(parsed.data.id) ?? { id: parsed.data.id, label: parsed.data.id });
        }
        if (options.length) catalog = withConfiguredModel(options);
      } catch {
        // A failed refresh keeps the last usable catalog, including custom models.
      }
    };
    if (apiKey) void refreshModels();
    return createOpenAIChatRuntime({
      input, driverKind: "cerebras", apiKey, apiUrl: config.url,
      tools: config.tools, models: () => catalog, refreshModels, reasoning: true,
      reasoningReplayField: "reasoning",
      computerUse: true, imageInput: (model) => !TEXT_ONLY_MODELS.test(model),
      nudgeAnnouncedAction: true,
      requestBody: (model, messages, stream) => ({
        model, messages, stream,
        ...(stream ? { stream_options: { include_usage: true } } : {}),
      }),
      httpErrorLabel: "Cerebras",
      missingKeyError: "Save a Cerebras API key in Settings → Connections, or set CEREBRAS_API_KEY.",
      unavailableReason: "No Cerebras API key — open Settings → Connections.",
      timeoutMs: 180_000, billing: "metered", includeUsageInCompleted: true,
      nativeLog: {
        source: "cerebras.chat.completions",
        outgoing: (_turn, messages, model) => ({ model, messageCount: messages.length }),
        incoming: ({ text, reasoning, usage }) => ({ textLength: text.length, reasoningLength: reasoning.length, usage }),
      },
    });
  },
};
