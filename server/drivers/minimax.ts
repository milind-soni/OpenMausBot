// MiniMax API driver over the OpenAI chat-completions protocol.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { titleCaseModelId, type ModelCatalog, type ProviderDriver } from "../contracts.ts";
import { createOpenAIChatRuntime } from "./openai-chat.ts";

const DRIVER_KIND = "minimax";
const API_KEY_ENV = "MINIMAX_API_KEY";
const DEFAULT_URL = "https://api.minimax.io/v1";
const CN_URL = "https://api.minimaxi.com/v1";
const FLASH_MODEL = "MiniMax-M3.1-Flash";
const M3_MODEL = "MiniMax-M3";
/** The thinking depths MiniMax's own API takes for `reasoning_effort`; it answers 400 to any other value. */
const THINKING_DEPTHS = ["low", "medium", "high", "xhigh", "max"];
const MODELS: ModelCatalog = {
  default: M3_MODEL,
  // `custom: true` is load-bearing: a custom-access engine's picker pane lists only custom-flagged models.
  options: [
    {
      id: FLASH_MODEL,
      label: "MiniMax M3.1 Flash",
      contextWindow: 1_000_000,
      custom: true,
      // MiniMax-M3.1-Flash always thinks; only its depth is a choice.
      variants: THINKING_DEPTHS.map((id) => ({ id, label: titleCaseModelId(id, /[-_ ]+/) })),
    },
    {
      id: M3_MODEL,
      label: "MiniMax M3",
      contextWindow: 1_000_000,
      custom: true,
      // MiniMax-M3 answers straight when its thinking is off; its depth is not a choice.
      variants: [{ id: "off", label: "No thinking" }],
    },
    { id: "MiniMax-M2.7", label: "MiniMax M2.7", contextWindow: 204_800, custom: true },
    { id: "MiniMax-M2.7-highspeed", label: "MiniMax M2.7 Highspeed", contextWindow: 204_800, custom: true },
  ],
};

/** MiniMax's own thinking controls: `reasoning_effort` sets the depth on MiniMax-M3.1-Flash, and
 * `thinking: { type: "disabled" }` answers straight on MiniMax-M3. The API answers 400 to
 * `reasoning_effort: "none"` and to a disabled thinking on MiniMax-M3.1-Flash, which always thinks. */
function thinkingParams(model: string, variant: string | undefined): Record<string, unknown> {
  if (!variant) return {};
  if (model === FLASH_MODEL) return THINKING_DEPTHS.includes(variant) ? { reasoning_effort: variant } : {};
  if (model === M3_MODEL) return variant === "off" ? { thinking: { type: "disabled" } } : {};
  return {};
}

export interface MinimaxConfig {
  tools?: boolean;
  /** An explicit instance or environment URL; absent uses mmx-cli's endpoint, then the international API. */
  url?: string;
}

interface LocalMiniMaxConfig {
  apiKey: string;
  url: string;
  defaultModel: string;
}

const localConfigSchema = z.object({
  api_key: z.string().optional(),
  region: z.enum(["global", "cn"]).optional(),
  base_url: z.string().optional(),
  default_text_model: z.string().optional(),
});
const driverConfigSchema = z.object({ url: z.string().optional() });

function normalizedApiUrl(value: string): string {
  const root = value.trim().replace(/\/+$/, "");
  return root.endsWith("/v1") ? root : `${root}/v1`;
}

export function loadLocalMiniMaxConfig(home = homedir()): LocalMiniMaxConfig {
  try {
    const raw = localConfigSchema.parse(JSON.parse(readFileSync(join(home, ".mmx", "config.json"), "utf8")));
    const configuredUrl = raw.base_url?.trim()
      ? raw.base_url
      : raw.region === "cn" ? CN_URL : DEFAULT_URL;
    return {
      apiKey: raw.api_key?.trim() ?? "",
      url: normalizedApiUrl(configuredUrl),
      defaultModel: raw.default_text_model?.trim() ?? "",
    };
  } catch {
    return { apiKey: "", url: DEFAULT_URL, defaultModel: "" };
  }
}

export function decodeMinimaxConfig(raw: unknown): MinimaxConfig {
  const tools = ((raw ?? {}) as Record<string, unknown>).tools;
  if (tools !== undefined && typeof tools !== "boolean") throw new Error("tools must be a boolean");
  const parsed = driverConfigSchema.safeParse(raw ?? {});
  const config = parsed.success ? parsed.data : {};
  const url = config.url?.trim() || process.env.MINIMAX_BASE_URL?.trim();
  return {
    ...(tools !== undefined ? { tools } : {}),
    ...(url ? { url: normalizedApiUrl(url) } : {}),
  };
}

export const MinimaxDriver: ProviderDriver<MinimaxConfig> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "MiniMax (API)", supportsMultipleInstances: true, access: "custom" },
  models: MODELS,
  install: {
    docsUrl: "https://platform.minimax.io/docs/token-plan/minimax-cli",
    command: {
      darwin: "npm install -g mmx-cli",
      linux: "npm install -g mmx-cli",
      win32: "npm install -g mmx-cli",
    },
    signInCommand: "mmx auth login --api-key YOUR_MINIMAX_API_KEY",
    needsNode: true,
  },
  decodeConfig: decodeMinimaxConfig,
  defaultConfig: () => decodeMinimaxConfig({}),

  async create(input) {
    const local = loadLocalMiniMaxConfig();
    const apiKey =
      input.environment[API_KEY_ENV]?.trim() ||
      process.env[API_KEY_ENV]?.trim() ||
      local.apiKey;
    const apiUrl = input.config.url ?? local.url;
    const models = local.defaultModel && MODELS.options.some((model) => model.id === local.defaultModel)
      ? { ...MODELS, default: local.defaultModel }
      : MODELS;

    return createOpenAIChatRuntime({
      input,
      driverKind: DRIVER_KIND,
      apiKey,
      apiUrl,
      tools: input.config.tools,
      models: () => models,
      modelVariants: true,
      requestBody: (model, messages, stream, variant) => ({
        model,
        messages,
        stream,
        reasoning_split: true,
        ...thinkingParams(model, variant),
        stream_options: stream ? { include_usage: true } : undefined,
      }),
      // MiniMax has no `reasoning_effort: "none"`: its own switch turns thinking off, and on
      // MiniMax-M3.1-Flash, which always thinks, there is nothing to send.
      reasoningOffBody: (model) => (model === M3_MODEL ? { thinking: { type: "disabled" } } : {}),
      httpErrorLabel: "MiniMax",
      missingKeyError: `no MiniMax key — set ${API_KEY_ENV} or run mmx auth login --api-key …`,
      unavailableReason: `no MiniMax API key — run mmx auth login --api-key … or set ${API_KEY_ENV}`,
      timeoutMs: 180_000,
      reasoning: true,
      billing: "metered",
      includeUsageInCompleted: true,
      noBodyError: "MiniMax returned no response body",
      nativeLog: {
        source: "minimax.chat.completions",
        outgoing: (_turn, messages, model) => ({ model, messageCount: messages.length }),
        incoming: ({ text, usage }) => ({ textLength: text.length, usage }),
      },
    });
  },
};
