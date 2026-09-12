import { z } from "zod";

export type ProviderPresetId =
  | "openai"
  | "openrouter"
  | "groq"
  | "mistral"
  | "nvidia-nim"
  | "custom-openai-compatible";

export type ProviderConnectionPreset = {
  id: ProviderPresetId;
  displayName: string;
  description: string;
  baseUrl: string;
  requiresBaseUrl: boolean;
  capabilities: {
    streaming: boolean;
    reasoning: boolean;
    modelDiscovery: boolean;
    toolCalls: boolean;
  };
};

export type ProviderConnectionInput = {
  provider: ProviderPresetId;
  name: string;
  apiKey: string;
  baseUrl?: string;
  model?: string;
};

export type ProviderConnectionInstanceConfig = {
  driver: "openai-compat";
  displayName: string;
  environment: Record<string, string>;
  config: {
    url: string;
    apiKeyEnv: string;
    model?: string;
  };
  meta: {
    providerPreset: ProviderPresetId;
    connectionType: "api";
  };
};

const SAFE_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._()-]{0,79}$/u;
const URL_SCHEMA = z.string().trim().max(2048).url();
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

const PRESETS: readonly ProviderConnectionPreset[] = [
  {
    id: "openai",
    displayName: "OpenAI",
    description: "OpenAI API with automatic model discovery.",
    baseUrl: "https://api.openai.com/v1",
    requiresBaseUrl: false,
    capabilities: { streaming: true, reasoning: true, modelDiscovery: true, toolCalls: false },
  },
  {
    id: "openrouter",
    displayName: "OpenRouter",
    description: "OpenAI-compatible access to many hosted model providers.",
    baseUrl: "https://openrouter.ai/api/v1",
    requiresBaseUrl: false,
    capabilities: { streaming: true, reasoning: true, modelDiscovery: true, toolCalls: false },
  },
  {
    id: "groq",
    displayName: "Groq",
    description: "Fast hosted inference through Groq's OpenAI-compatible API.",
    baseUrl: "https://api.groq.com/openai/v1",
    requiresBaseUrl: false,
    capabilities: { streaming: true, reasoning: true, modelDiscovery: true, toolCalls: false },
  },
  {
    id: "mistral",
    displayName: "Mistral",
    description: "Mistral API through its OpenAI-compatible endpoint.",
    baseUrl: "https://api.mistral.ai/v1",
    requiresBaseUrl: false,
    capabilities: { streaming: true, reasoning: true, modelDiscovery: true, toolCalls: false },
  },
  {
    id: "nvidia-nim",
    displayName: "NVIDIA NIM",
    description: "Connect to a self-hosted or managed NVIDIA NIM OpenAI-compatible endpoint.",
    baseUrl: "http://localhost:8000/v1",
    requiresBaseUrl: true,
    capabilities: { streaming: true, reasoning: true, modelDiscovery: true, toolCalls: false },
  },
  {
    id: "custom-openai-compatible",
    displayName: "Custom OpenAI-compatible",
    description: "Any endpoint implementing the OpenAI-compatible /chat/completions and /models APIs.",
    baseUrl: "http://localhost:1234/v1",
    requiresBaseUrl: true,
    capabilities: { streaming: true, reasoning: true, modelDiscovery: true, toolCalls: false },
  },
];

export function providerConnectionPresets(): readonly ProviderConnectionPreset[] {
  return PRESETS;
}

export function getProviderConnectionPreset(id: ProviderPresetId): ProviderConnectionPreset {
  const preset = PRESETS.find((item) => item.id === id);
  if (!preset) throw new Error(`Unknown provider preset: ${id}`);
  return preset;
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

export function validateProviderBaseUrl(value: string): string {
  const url = new URL(URL_SCHEMA.parse(value));
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Provider URL must not contain credentials, query parameters, or fragments");
  }
  const loopback = LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("Provider API URLs must use HTTPS; HTTP is allowed only for loopback endpoints");
  }
  return normalizeBaseUrl(url.toString());
}

function assertSafeSecret(value: string): void {
  if (!value.trim()) throw new Error("API key is required");
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) throw new Error("API key contains invalid control characters");
  }
}

export function slugifyProviderConnectionName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "provider";
}

export function allocateProviderInstanceId(name: string, existingIds: Iterable<string>): string {
  const used = new Set(existingIds);
  const base = `api-${slugifyProviderConnectionName(name)}`;
  if (!used.has(base)) return base;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${base}-${i}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new Error("Unable to allocate a unique provider connection id");
}

export function normalizeProviderConnectionInput(
  input: ProviderConnectionInput,
  existingIds: Iterable<string> = [],
): { instanceId: string; instanceConfig: ProviderConnectionInstanceConfig } {
  const parsed = z.object({
    provider: z.enum(["openai", "openrouter", "groq", "mistral", "nvidia-nim", "custom-openai-compatible"]),
    name: z.string().trim().min(1).max(80),
    apiKey: z.string().min(1),
    baseUrl: z.string().trim().optional(),
    model: z.string().trim().max(200).optional(),
  }).parse(input);

  if (!SAFE_NAME.test(parsed.name)) throw new Error("Connection name contains unsupported characters");
  assertSafeSecret(parsed.apiKey);

  const preset = getProviderConnectionPreset(parsed.provider);
  if (preset.requiresBaseUrl && !parsed.baseUrl) {
    throw new Error(`${preset.displayName} requires a base URL`);
  }
  const rawBaseUrl = parsed.baseUrl?.trim() || preset.baseUrl;
  const baseUrl = validateProviderBaseUrl(rawBaseUrl);

  const instanceId = allocateProviderInstanceId(parsed.name, existingIds);
  const secretEnv = `OPENMAUSBOT_API_${instanceId.replace(/[^A-Z0-9]+/gi, "_").toUpperCase()}_KEY`;

  return {
    instanceId,
    instanceConfig: {
      driver: "openai-compat",
      displayName: parsed.name,
      environment: { [secretEnv]: parsed.apiKey },
      config: {
        url: baseUrl,
        apiKeyEnv: secretEnv,
        ...(parsed.model ? { model: parsed.model } : {}),
      },
      meta: {
        providerPreset: parsed.provider,
        connectionType: "api",
      },
    },
  };
}

export function isProviderConnectionInstance(value: unknown): value is ProviderConnectionInstanceConfig {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ProviderConnectionInstanceConfig>;
  return candidate.driver === "openai-compat"
    && !!candidate.meta
    && candidate.meta.connectionType === "api"
    && typeof candidate.meta.providerPreset === "string";
}
