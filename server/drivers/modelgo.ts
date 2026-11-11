import { z } from "zod";
import { MODELGO_URL } from "../../shared/modelgo.ts";
import type { ModelCatalog, ProviderDriver } from "../contracts.ts";
import { createOpenAIChatRuntime } from "./openai-chat.ts";

// POST /v1/chat/completions with a Bearer key, tools and tool_choice in the OpenAI shape, SSE ending in [DONE] with a usage
// frame whose `choices` is empty: https://modelgo.ai/docs/models/text/chat-completions and
// /docs/models/text/model-protocol-parameters, read 2026-11-10.
const DEFAULT_URL = "https://api.modelgo.ai/v1";
// No built-in models: the public catalog (https://modelgo.ai/models) showed no model data when read on 2026-11-10, and every
// id must come from it or from GET /models. Until a key is saved the list is empty.
const NO_MODELS: ModelCatalog = { default: "", options: [] };
const configSchema = z.object({
  url: z.string().trim().url().default(DEFAULT_URL),
  model: z.string().trim().min(1).optional(),
  tools: z.boolean().optional(),
});
type ModelgoConfig = z.output<typeof configSchema>;

function decodeConfig(raw: unknown): ModelgoConfig {
  const config = configSchema.parse(raw ?? {});
  config.url = config.url.replace(/\/+$/, "");
  const url = new URL(config.url);
  if (url.protocol !== "https:" && !(url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
    throw new Error("ModelGo requires HTTPS, except for a local test endpoint.");
  }
  return config;
}

// GET /models, measured 2026-11-10: rows carry id, context_length, input_modalities and output_modalities, with no field for
// tool support, and the list mixes in image, video and speech models.
const modelCard = z.object({
  id: z.string().trim().min(1),
  context_length: z.number().int().positive().optional(),
  input_modalities: z.array(z.string()).optional(),
  output_modalities: z.array(z.string()).optional(),
});
type ModelCard = z.output<typeof modelCard>;

const writesText = (model: ModelCard) => model.output_modalities?.includes("text") === true;

// ModelGo's documented refusals (https://modelgo.ai/docs/quickstart/errors, read 2026-11-10): the code may sit in error.code,
// error.type or error.metadata, so the whole body is searched. "billing" keeps a 402 classified as a quota failure.
const REFUSALS = [
  { status: 402, code: "billing_insufficient", sentence: "Your ModelGo balance has run out, so billing stopped this request. Top up in the ModelGo console, then run it again." },
  { status: 403, code: "first_recharge_required", sentence: "ModelGo's free models need a first top-up on your account. Top up in the ModelGo console, then run it again." },
] as const;
const plainRefusal = (status: number, body: string) =>
  REFUSALS.find((refusal) => refusal.status === status && body.includes(refusal.code))?.sentence;

export const ModelgoDriver: ProviderDriver<ModelgoConfig> = {
  driverKind: "modelgo",
  metadata: { displayName: "ModelGo (API)", supportsMultipleInstances: true, access: "api" },
  models: NO_MODELS,
  install: {
    docsUrl: MODELGO_URL,
    settings: "connections",
    signInCommand: "Save a ModelGo API key in Settings → API keys, or set MODELGO_API_KEY on the server.",
  },
  decodeConfig,
  defaultConfig: () => decodeConfig({}),
  async create(input) {
    const { config } = input;
    // A custom host must bring its own credential; the workspace key goes only to ModelGo.
    const apiKey = (input.environment.MODELGO_API_KEY ??
      (config.url === DEFAULT_URL ? process.env.MODELGO_API_KEY : undefined) ?? "").trim();
    const withConfiguredModel = (options: ModelCatalog["options"]): ModelCatalog => {
      if (config.model && !options.some((option) => option.id === config.model)) {
        options = [{ id: config.model, label: config.model }, ...options];
      }
      return { default: config.model ?? options[0]?.id ?? "", options };
    };
    let catalog = withConfiguredModel(NO_MODELS.options);
    let imageModels = new Set<string>();
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
          if (!parsed.success || !writesText(parsed.data) || options.some((option) => option.id === parsed.data.id)) continue;
          const model = parsed.data;
          options.push({ id: model.id, label: model.id, ...(model.context_length ? { contextWindow: model.context_length } : {}) });
          if (model.input_modalities?.includes("image")) images.add(model.id);
        }
        if (options.length) {
          catalog = withConfiguredModel(options);
          imageModels = images;
        }
      } catch {}
    };
    const firstRefresh = refreshModels();
    return createOpenAIChatRuntime({
      input, driverKind: "modelgo", apiKey, apiUrl: config.url,
      tools: config.tools, models: () => catalog, refreshModels, reasoning: true,
      computerUse: true, imageInput: (model) => imageModels.has(model),
      nudgeAnnouncedAction: true,
      requestBody: (model, messages, stream) => ({ model, messages, stream }),
      httpErrorLabel: "ModelGo",
      plainRefusal,
      missingKeyError: "Save a ModelGo API key in Settings → API keys, or set MODELGO_API_KEY.",
      unavailableReason: "No ModelGo API key — open Settings → API keys.",
      serverUnavailable: async () => {
        await firstRefresh;
        return apiKey && !catalog.options.length ? { reason: "ModelGo listed no models for this key. Check the key in the ModelGo console, then check again." } : null;
      },
      timeoutMs: 180_000, billing: "metered", includeUsageInCompleted: true,
      nativeLog: {
        source: "modelgo.chat.completions",
        outgoing: (_turn, messages, model) => ({ model, messageCount: messages.length }),
        incoming: ({ text, reasoning, usage }) => ({ textLength: text.length, reasoningLength: reasoning.length, usage }),
      },
    });
  },
};
