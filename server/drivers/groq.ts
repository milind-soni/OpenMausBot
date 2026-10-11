import { z } from "zod";
import type { ModelCatalog, ProviderDriver } from "../contracts.ts";
import { createOpenAIChatRuntime } from "./openai-chat.ts";

const DEFAULT_URL = "https://api.groq.com/openai/v1";
// Production text models: https://console.groq.com/docs/models
const DEFAULT_MODELS: ModelCatalog = {
  default: "openai/gpt-oss-120b",
  options: [
    { id: "openai/gpt-oss-120b", label: "GPT OSS 120B", contextWindow: 131072 },
    { id: "openai/gpt-oss-20b", label: "GPT OSS 20B", contextWindow: 131072 },
  ],
};
const configSchema = z.object({
  url: z.string().trim().url().default(DEFAULT_URL),
  model: z.string().trim().min(1).optional(),
  tools: z.boolean().optional(),
});
type GroqConfig = z.output<typeof configSchema>;

function decodeConfig(raw: unknown): GroqConfig {
  const config = configSchema.parse(raw ?? {});
  config.url = config.url.replace(/\/+$/, "");
  const url = new URL(config.url);
  if (url.protocol !== "https:" && !(url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
    throw new Error("Groq requires HTTPS, except for a local test endpoint.");
  }
  return config;
}

const modelCard = z.object({
  id: z.string().trim().min(1),
  active: z.boolean().optional(),
  context_window: z.number().int().positive().optional(),
});
// /models also lists speech and safety models, which cannot answer a chat turn.
const NON_CHAT_MODELS = /^(?:whisper|distil-whisper|playai-tts|canopylabs\/orpheus|meta-llama\/llama-(?:guard|prompt-guard))/i;

export const GroqDriver: ProviderDriver<GroqConfig> = {
  driverKind: "groq",
  metadata: { displayName: "Groq (API)", supportsMultipleInstances: true, access: "api" },
  models: DEFAULT_MODELS,
  install: {
    docsUrl: "https://console.groq.com/docs/overview",
    settings: "connections",
    signInCommand: "Save a Groq API key in Settings → API keys, or set GROQ_API_KEY on the server.",
  },
  decodeConfig,
  defaultConfig: () => decodeConfig({}),
  async create(input) {
    const { config } = input;
    // An instance with a custom host must bring its own credential. The
    // workspace injects its key only for its explicitly configured endpoint.
    const apiKey = (input.environment.GROQ_API_KEY ??
      (config.url === DEFAULT_URL ? process.env.GROQ_API_KEY : undefined) ?? "").trim();
    const known = new Map(DEFAULT_MODELS.options.map(option => [option.id, option]));
    const withConfiguredModel = (options: ModelCatalog["options"]): ModelCatalog => {
      const preferred = config.model ?? DEFAULT_MODELS.default;
      if (config.model && !options.some(option => option.id === config.model)) {
        options = [{ id: config.model, label: config.model }, ...options];
      }
      return { default: options.some(option => option.id === preferred) ? preferred : options[0].id, options };
    };
    let catalog = withConfiguredModel(DEFAULT_MODELS.options);
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
        const seen = new Set<string>();
        for (const row of rows) {
          const parsed = modelCard.safeParse(row);
          if (!parsed.success || parsed.data.active === false || NON_CHAT_MODELS.test(parsed.data.id) || seen.has(parsed.data.id)) continue;
          const { id, context_window } = parsed.data;
          seen.add(id);
          options.push({ ...(known.get(id) ?? { id, label: id }), ...(context_window ? { contextWindow: context_window } : {}) });
        }
        if (options.length) catalog = withConfiguredModel(options);
      } catch {
        // A failed or malformed refresh keeps the last usable catalog.
      }
    };
    if (apiKey) void refreshModels();
    return createOpenAIChatRuntime({
      input, driverKind: "groq", apiKey, apiUrl: config.url,
      tools: config.tools, models: () => catalog, refreshModels, reasoning: true,
      reasoningReplayField: "reasoning", computerUse: true, imageInput: () => false,
      requestBody: (model, messages, stream) => ({ model, messages, stream }),
      httpErrorLabel: "Groq",
      missingKeyError: "Save a Groq API key in Settings → API keys, or set GROQ_API_KEY.",
      unavailableReason: "No Groq API key — open Settings → API keys.",
      timeoutMs: 180_000, billing: "metered", includeUsageInCompleted: true,
      nativeLog: {
        source: "groq.chat.completions",
        outgoing: (_turn, messages, model) => ({ model, messageCount: messages.length }),
        incoming: ({ text, reasoning, usage }) => ({ textLength: text.length, reasoningLength: reasoning.length, usage }),
      },
    });
  },
};
