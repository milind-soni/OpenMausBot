import { z } from "zod";
import type { ModelCatalog, ProviderDriver } from "../contracts.ts";
import { createOpenAIChatRuntime } from "./openai-chat.ts";

const DEFAULT_URL = "https://api.mistral.ai/v1";
const DEFAULT_MODELS: ModelCatalog = {
  default: "mistral-large-latest",
  options: [
    { id: "mistral-large-latest", label: "Mistral Large (latest)" },
    { id: "mistral-small-latest", label: "Mistral Small (latest)" },
  ],
};
const configSchema = z.object({
  url: z.string().trim().url().default(DEFAULT_URL),
  model: z.string().trim().min(1).optional(),
  tools: z.boolean().optional(),
});
type MistralConfig = z.output<typeof configSchema>;

function decodeConfig(raw: unknown): MistralConfig {
  const config = configSchema.parse(raw ?? {});
  config.url = config.url.replace(/\/+$/, "");
  const url = new URL(config.url);
  if (url.protocol !== "https:" && !(url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
    throw new Error("Mistral requires HTTPS, except for a local test endpoint.");
  }
  return config;
}

const modelCard = z.object({
  id: z.string().min(1),
  name: z.string().nullable().optional(),
  aliases: z.array(z.string()).optional(),
  archived: z.boolean().optional(),
  capabilities: z.object({ completion_chat: z.boolean().optional() }).optional(),
  max_context_length: z.number().int().positive().optional(),
});

/** Mistral can return plain text or a list of typed content chunks. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((chunk) => chunk?.type === "text" && typeof chunk.text === "string" ? chunk.text : "").join("");
}

export const MistralDriver: ProviderDriver<MistralConfig> = {
  driverKind: "mistral",
  metadata: { displayName: "Mistral (API)", supportsMultipleInstances: true, access: "api" },
  models: DEFAULT_MODELS,
  install: {
    docsUrl: "https://console.mistral.ai/api-keys",
    signInCommand: "Save a Mistral API key in Settings → Connections, or set MISTRAL_API_KEY on the server.",
  },
  decodeConfig,
  defaultConfig: () => decodeConfig({}),
  async create(input) {
    const { config } = input;
    const apiKey = (input.environment.MISTRAL_API_KEY ?? process.env.MISTRAL_API_KEY ?? "").trim();
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
          if (!parsed.success || parsed.data.archived || parsed.data.capabilities?.completion_chat === false) continue;
          const card = parsed.data;
          for (const id of [card.id, ...(card.aliases ?? [])]) {
            if (!id.trim() || seen.has(id)) continue;
            seen.add(id);
            options.push({ id, label: id === card.id ? card.name?.trim() || id : id,
              ...(card.max_context_length ? { contextWindow: card.max_context_length } : {}) });
          }
        }
        if (options.length) catalog = withConfiguredModel(options);
      } catch {
        // A failed refresh keeps the last usable catalog, including custom models.
      }
    };
    if (apiKey) void refreshModels();
    return createOpenAIChatRuntime({
      input, driverKind: "mistral", apiKey, apiUrl: config.url,
      tools: config.tools, models: () => catalog, refreshModels, contentText,
      requestBody: (model, messages, stream) => ({ model, messages, stream }),
      httpErrorLabel: "Mistral",
      missingKeyError: "Save a Mistral API key in Settings → Connections, or set MISTRAL_API_KEY.",
      unavailableReason: "No Mistral API key — open Settings → Connections.",
      timeoutMs: 180_000, billing: "metered", includeUsageInCompleted: true,
      nativeLog: {
        source: "mistral.chat.completions",
        outgoing: (_turn, messages, model) => ({ model, messageCount: messages.length }),
        incoming: ({ text, usage }) => ({ textLength: text.length, usage }),
      },
    });
  },
};
