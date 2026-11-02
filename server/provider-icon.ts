import { z } from "zod";
import { persistableInstanceConfigs, type AppConfig } from "./config.ts";
import type { InstanceConfig } from "./contracts.ts";
import { PROVIDER_ICON_PRESETS, type ProviderIcon, type ProviderIconPreset } from "../shared/provider-icon.ts";

const iconSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("preset"), preset: z.enum(PROVIDER_ICON_PRESETS) }).strict(),
  z.object({ kind: z.literal("custom"), dataUrl: z.string() }).strict(),
]);

export const providerIconPatchSchema = z.object({ icon: iconSchema.nullable() }).strict();

export function withInstanceIcon(cfg: AppConfig, instanceId: string, icon: ProviderIcon | null) {
  const next: AppConfig = structuredClone(cfg);
  const instances = persistableInstanceConfigs(next);
  if (!Object.hasOwn(instances, instanceId)) return { ok: false as const, config: cfg, instances };
  if (icon) instances[instanceId].icon = icon;
  else delete instances[instanceId].icon;
  next.instances = instances;
  return { ok: true as const, config: next, instances };
}

/** Who runs a server, by its host. `*` is one DNS label, or the rest of one. Only providers we have a mark for:
 * Groq, Together, Fireworks, Ollama and LM Studio servers keep the driver's own mark. */
const SERVER_HOSTS: Record<string, ProviderIconPreset> = {
  "api.openai.com": "openai", "*.api.openai.com": "openai",
  "*.openai.azure.com": "azure", "*.services.ai.azure.com": "azure", "*.cognitiveservices.azure.com": "azure",
  "bedrock-runtime.*.amazonaws.com": "aws",
  "generativelanguage.googleapis.com": "google", "aiplatform.googleapis.com": "google", "*-aiplatform.googleapis.com": "google",
  "api.x.ai": "xai",
  "api.deepseek.com": "deepseek",
  "dashscope.aliyuncs.com": "qwen", "dashscope-*.aliyuncs.com": "qwen",
  "api.moonshot.ai": "moonshot", "api.moonshot.cn": "moonshot",
  "api.mistral.ai": "mistral", "codestral.mistral.ai": "mistral",
  "api.cohere.com": "cohere", "api.cohere.ai": "cohere",
  "openrouter.ai": "openrouter", "*.openrouter.ai": "openrouter",
  "api.anthropic.com": "anthropic",
  "api.llama.com": "meta", "api.meta.ai": "meta",
};
const SERVER_MARKS = Object.entries(SERVER_HOSTS).map(([host, preset]) =>
  [new RegExp(`^${host.replaceAll(".", "\\.").replaceAll("*", "[a-z0-9-]+")}$`), preset] as const);

/** The provider whose mark a server address shows. Only the host counts, so a look-alike host
 * (api.openai.com.evil.test) or a provider named in the path or user name never matches. */
export function serverIconPreset(url: string): ProviderIconPreset | undefined {
  let host: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;
    host = parsed.hostname.replace(/\.$/, "");
  } catch {
    return undefined;
  }
  return SERVER_MARKS.find(([pattern]) => pattern.test(host))?.[1];
}

/** The mark an instance shows everywhere the instance list goes: a stored icon (set before v0.1.102) wins; an
 * OpenAI-compatible server otherwise shows the mark of whoever runs it; anything else keeps its driver's mark. */
export function instanceIcon(entry: InstanceConfig | undefined): { icon?: ProviderIcon } {
  if (entry?.icon) return { icon: entry.icon };
  const url = entry?.driver === "openai-compat" ? (entry.config as { url?: unknown } | undefined)?.url : undefined;
  const preset = typeof url === "string" ? serverIconPreset(url) : undefined;
  return preset ? { icon: { kind: "preset", preset } } : {};
}
