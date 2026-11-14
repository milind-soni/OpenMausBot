import { z } from "zod";
import type { ModelCatalog, ProviderDriver } from "../contracts.ts";
import { createOpenAIChatRuntime } from "./openai-chat.ts";

// Meta Model API: Muse Spark and Muse Wonder over the OpenAI chat contract.
// https://dev.meta.ai/docs/protocols/chat-completions
const DEFAULT_URL = "https://api.meta.ai/v1";
const MUSE_CONTEXT_WINDOW = 1_048_576;
// https://dev.meta.ai/docs/models (Muse Wonder's id is from Muse Code's own `model/list`; the docs omit it)
const DEFAULT_MODELS: ModelCatalog = {
  default: "muse-wonder-1.0",
  options: [
    { id: "muse-wonder-1.0", label: "Muse Wonder 1.0", contextWindow: MUSE_CONTEXT_WINDOW },
    { id: "muse-spark-1.3", label: "Muse Spark 1.3", contextWindow: MUSE_CONTEXT_WINDOW },
    { id: "muse-spark-1.3-contributor", label: "Muse Spark 1.3 Contributor", contextWindow: MUSE_CONTEXT_WINDOW },
  ],
};
const configSchema = z.object({
  url: z.string().trim().url().default(DEFAULT_URL),
  model: z.string().trim().min(1).optional(),
  tools: z.boolean().optional(),
});
type MetaConfig = z.output<typeof configSchema>;

function decodeConfig(raw: unknown): MetaConfig {
  const config = configSchema.parse(raw ?? {});
  config.url = config.url.replace(/\/+$/, "");
  const url = new URL(config.url);
  if (url.protocol !== "https:" && !(url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
    throw new Error("Meta requires HTTPS, except for a local test endpoint.");
  }
  return config;
}

const modelCard = z.object({ id: z.string().trim().min(1) });
// /models also lists image, speech and segmentation models, which cannot answer a chat turn.
const NON_CHAT_MODELS = /^(?:muse-image|muse-voice|sam-)/i;

/** "muse-spark-1.3-contributor" → "Muse Spark 1.3 Contributor". */
function museLabel(id: string): string {
  if (!/^muse-/i.test(id)) return id;
  return id.split("-").map(word => /^\d/.test(word) ? word : word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}

/** Muse Wonder has no documented API id: follow Meta's listing, standard-tier Wonder before Full. */
function wonderModel(options: ModelCatalog["options"]): string | undefined {
  return options.map(option => option.id)
    .filter(id => /^muse-wonder/i.test(id) && !/contributor/i.test(id))
    .sort((a, b) => Number(/full/i.test(a)) - Number(/full/i.test(b)))[0];
}

export const MetaDriver: ProviderDriver<MetaConfig> = {
  driverKind: "meta",
  metadata: { displayName: "Meta Muse (API)", supportsMultipleInstances: true, access: "api" },
  models: DEFAULT_MODELS,
  install: {
    docsUrl: "https://dev.meta.ai/docs/authentication",
    settings: "connections",
    signInCommand: "Save a Meta Model API key in Settings → API keys, or set META_API_KEY on the server.",
  },
  decodeConfig,
  defaultConfig: () => decodeConfig({}),
  async create(input) {
    const { config } = input;
      // A custom host must bring its own credential; the workspace key goes only to its configured endpoint.
    const apiKey = (input.environment.META_API_KEY ??
      (config.url === DEFAULT_URL ? process.env.META_API_KEY : undefined) ?? "").trim();
    const known = new Map(DEFAULT_MODELS.options.map(option => [option.id, option]));
    const withConfiguredModel = (options: ModelCatalog["options"]): ModelCatalog => {
      const preferred = config.model ?? wonderModel(options) ?? DEFAULT_MODELS.default;
      if (config.model && !options.some(option => option.id === config.model)) {
        options = [{ id: config.model, label: museLabel(config.model) }, ...options];
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
          if (!parsed.success || NON_CHAT_MODELS.test(parsed.data.id) || seen.has(parsed.data.id)) continue;
          const { id } = parsed.data;
          seen.add(id);
          options.push(known.get(id) ?? { id, label: museLabel(id),
            ...(/^muse-(?:spark|wonder)/i.test(id) ? { contextWindow: MUSE_CONTEXT_WINDOW } : {}) });
        }
        if (options.length) catalog = withConfiguredModel(options);
      } catch {}
    };
    if (apiKey) void refreshModels();
    return createOpenAIChatRuntime({
      input, driverKind: "meta", apiKey, apiUrl: config.url,
      tools: config.tools, models: () => catalog, refreshModels, reasoning: true,
      computerUse: true, imageInput: model => /^muse-/i.test(model),
      requestBody: (model, messages, stream) => ({
        model, messages, stream,
        ...(stream ? { stream_options: { include_usage: true } } : {}),
      }),
      httpErrorLabel: "Meta",
      missingKeyError: "Save a Meta Model API key in Settings → API keys, or set META_API_KEY.",
      unavailableReason: "No Meta Model API key — open Settings → API keys.",
      // Muse reasons privately and streams nothing until it answers.
      timeoutMs: 600_000, billing: "metered", includeUsageInCompleted: true,
      nativeLog: {
        source: "meta.chat.completions",
        outgoing: (_turn, messages, model) => ({ model, messageCount: messages.length }),
        incoming: ({ text, reasoning, usage }) => ({ textLength: text.length, reasoningLength: reasoning.length, usage }),
      },
    });
  },
};
