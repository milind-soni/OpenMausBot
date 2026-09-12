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

const SAFE_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._()\-]{0,79}$/u;
const URL_SCHEMA = z.string().trim().url().refine((value) => /^https?:\/\//i.test(value), "URL must use http or https");

const PRESETS: readonly ProviderConnectionPreset[] = [
  {
    id: "openai",
    displayName: "OpenAI",
    description: "OpenAI API with automatic model discovery.",
    baseUrl: "https://api.openai.com/v1",
    requiresBaseUrl: false,
    capabilities: { streaming: true, reasoning: true, modelDiscovery: true, toolCalls: true },
  },
  {
    id: "openrouter",
    displayName: "OpenRouter",
    description: "OpenAI-compatible access to many hosted model providers.",
    baseUrl: "https://openrouter.ai/api/v1",
    requiresBaseUrl: false,
    capabilities: { streaming: true, reasoning: true, modelDiscovery: true, toolCalls: true },
  },
  {
    id: "groq",
    displayName: "Groq",
    description: "Fast hosted inference through Groq's OpenAI-compatible API.",
    baseUrl: "https://api.groq.com/openai/v1",
    requiresBaseUrl: false,
    capabilities: { streaming: true, reasoning: true, modelDiscovery: true, toolCalls: true },
  },
  {
    id: "mistral",
    displayName: "Mistral",
    description: "Mistral API through its OpenAI-compatible endpoint.",
    baseUrl: "https://api.mistral.ai/v1",
    requiresBaseUrl: false,
    capabilities: { streaming: true, reasoning: true, modelDiscovery: true, toolCalls: true },
  },
  {
    id: "nvidia-nim",
    displayName: "NVIDIA NIM",
    description: "Connect to a self-hosted or managed NVIDIA NIM OpenAI-compatible endpoint.",
    // NIM deployments use their own server base URL; /v1 is appended by the OpenAI-compatible driver.
    baseUrl: "http://localhost:8000/v1",
    requiresBaseUrl: true,
    capabilities: { streaming: true, reasoning: true, modelDiscovery: true, toolCalls: true },
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

function assertSafeSecret(value: string): void {
  if (!value.trim()) throw new Error("API key is required");
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error("API key contains invalid control characters");
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
  const rawBaseUrl = parsed.baseUrl?.trim() || preset.baseUrl;
  const baseUrl = normalizeBaseUrl(URL_SCHEMA.parse(rawBaseUrl));

  if (parsed.provider === "nvidia-nim" && !parsed.baseUrl) {
    throw new Error("NVIDIA NIM requires the base URL of your NIM deployment");
  }

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
