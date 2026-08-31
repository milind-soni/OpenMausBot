// MiniMax API driver. The wire protocol is OpenAI chat completions; this file
// keeps only MiniMax's credentials, catalog, and request differences.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import type { ModelCatalog, ProviderDriver } from "../contracts.ts";
import { createOpenAIChatRuntime } from "./openai-chat.ts";

const DRIVER_KIND = "minimax";
const API_KEY_ENV = "MINIMAX_API_KEY";
const DEFAULT_URL = "https://api.minimax.io/v1";
const CN_URL = "https://api.minimaxi.com/v1";
const MODELS: ModelCatalog = {
  default: "MiniMax-M3",
  options: [
    { id: "MiniMax-M3", label: "MiniMax M3", contextWindow: 1_000_000 },
    { id: "MiniMax-M2.7", label: "MiniMax M2.7", contextWindow: 204_800 },
    { id: "MiniMax-M2.7-highspeed", label: "MiniMax M2.7 Highspeed", contextWindow: 204_800 },
  ],
};

export interface MinimaxConfig {
  url: string;
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
  const parsed = driverConfigSchema.safeParse(raw ?? {});
  const config = parsed.success ? parsed.data : {};
  return {
    url: normalizedApiUrl(config.url?.trim() || process.env.MINIMAX_BASE_URL?.trim() || DEFAULT_URL),
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
    const apiUrl = input.config.url === DEFAULT_URL && local.url !== DEFAULT_URL
      ? local.url
      : input.config.url;
    const models = local.defaultModel && MODELS.options.some((model) => model.id === local.defaultModel)
      ? { ...MODELS, default: local.defaultModel }
      : MODELS;

    return createOpenAIChatRuntime({
      input,
      driverKind: DRIVER_KIND,
      apiKey,
      apiUrl,
      models: () => models,
      requestBody: (model, messages, stream) => ({
        model,
        messages,
        stream,
        reasoning_split: true,
        stream_options: stream ? { include_usage: true } : undefined,
      }),
      httpErrorLabel: "MiniMax",
      missingKeyError: `no MiniMax key — set ${API_KEY_ENV} or run mmx auth login --api-key …`,
      unavailableReason: `no MiniMax API key — run mmx auth login --api-key … or set ${API_KEY_ENV}`,
      timeoutMs: 180_000,
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
