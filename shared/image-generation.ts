export type AvatarImageProvider = "openai" | "xai" | "custom";
export const IMAGE_PROVIDERS = ["openai", "xai", "gemini", "openrouter", "higgsfield", "custom"] as const;
export type ImageProvider = (typeof IMAGE_PROVIDERS)[number];

export const IMAGE_MAX_PER_TURN_DEFAULT = 4;
export const IMAGE_COMPLEXITIES = ["low", "medium", "high"] as const;
export type ImageComplexity = (typeof IMAGE_COMPLEXITIES)[number];

/** `complexity` is a GPT-Image-2.6 request field; other models would reject it. */
export function supportsImageComplexity(slot: { provider: ImageProvider; model: string }): boolean {
  return slot.provider === "openai" && slot.model.startsWith("gpt-image-2.6-");
}

export const IMAGE_DEFAULT_MODELS: Record<ImageProvider, string> = {
  openai: "gpt-image-2", xai: "grok-imagine-image-2.0", gemini: "gemini-2.5-flash-image", openrouter: "google/gemini-2.5-flash-image", higgsfield: "nano_banana_pro", custom: "",
};

/** What Settings' Test learns about a provider; no image is made. */
export type ImageProviderTest =
  | { ok: true; check: "authentication" | "models"; freeTier?: boolean }
  | { ok: false; reason: "no_key" | "no_url" | "not_connected" | "rejected" | "unreachable" | "unexpected"; status?: number }
  | { ok: false; reason: "model_missing"; model: string };

export interface ImageModelChoice {
  id: string;
  name: string;
}

/** Offered first in Settings; OpenRouter adds the rest of its live image catalog, and any other ID can be typed. */
export const IMAGE_MODEL_CHOICES: Record<ImageProvider, readonly ImageModelChoice[]> = {
  openai: [
    { id: "gpt-image-2.6-sunburst", name: "GPT Image 2.6 Sunburst" },
    { id: "gpt-image-2.6-flare", name: "GPT Image 2.6 Flare" },
    { id: "gpt-image-2", name: "GPT Image 2" },
    { id: "gpt-image-1", name: "GPT Image 1" },
    { id: "gpt-image-1-mini", name: "GPT Image 1 Mini" },
  ],
  xai: [{ id: "grok-imagine-image-2.0", name: "Grok Imagine Image 2.0" }],
  gemini: [{ id: "gemini-2.5-flash-image", name: "Nano Banana (Gemini 2.5 Flash Image)" }],
  openrouter: [
    { id: "google/gemini-2.5-flash-image", name: "Google: Nano Banana (Gemini 2.5 Flash Image)" },
    { id: "google/gemini-3.1-flash-image", name: "Google: Nano Banana 2 (Gemini 3.1 Flash Image)" },
    { id: "google/gemini-3-pro-image", name: "Google: Nano Banana Pro (Gemini 3 Pro Image)" },
    { id: "openai/gpt-image-2", name: "OpenAI: GPT Image 2" },
    { id: "black-forest-labs/flux-3-image", name: "Black Forest Labs: FLUX 3 Image" },
    { id: "bytedance-seed/seedream-5-0-pro", name: "ByteDance Seed: Seedream 5.0 Pro" },
    { id: "x-ai/grok-imagine-image-2.0", name: "xAI: Grok Imagine Image 2.0" },
    { id: "qwen/qwen-image-3", name: "Qwen: Qwen Image 3" },
  ],
  higgsfield: [
    { id: "nano_banana_pro", name: "Nano Banana Pro" },
    { id: "gpt_image_2_6", name: "GPT Image 2.6" },
    { id: "seedream_v5_pro", name: "Seedream 5.0 Pro" },
    { id: "flux_3_image", name: "FLUX 3 Image" },
  ],
  custom: [],
};

export interface ImageSlotConfig {
  provider: ImageProvider;
  model?: string;
}

export interface ImageGenerationConfig {
  primary?: ImageSlotConfig;
  fallback?: ImageSlotConfig;
  maxPerTurn?: number;
  /** Sent only to GPT-Image-2.6 models; they use high when it is unset. */
  complexity?: ImageComplexity;
  /** An OpenAI key; never sent to another provider. */
  key?: string;
  geminiKey?: string;
  customApiKey?: string;
  customUrl?: string;
  provider?: AvatarImageProvider;
  customModel?: string;
}

/** A deliberately configured Images API endpoint, not a provider-returned URL.
 * Local HTTP is useful for self-hosted routers; internet endpoints require TLS. */
const API_KEY_SHAPE = /^(sk-|sk_|xai-|gsk_|AIza)[A-Za-z0-9_-]{12,}$/;

/** A value pasted into a model field that has the shape of a provider's API key. */
export function looksLikeApiKey(value: string): boolean {
  return API_KEY_SHAPE.test(value.trim());
}

export function normalizeImageGenerationUrl(value: string): string {
  const message = "Use an HTTPS API base URL, or HTTP for a local router, without passwords, query parameters or fragments";
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error(message); }
  if (value.length > 2048 || url.username || url.password || url.search || url.hash) throw new Error(message);
  const host = url.hostname.toLowerCase();
  const ipv4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  const local = host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")
    || host === "host.docker.internal" || host === "host.containers.internal"
    || host === "[::1]" || /^\[f[cd][0-9a-f]{2}:/.test(host)
    || (ipv4 && (Number(ipv4[1]) === 127 || Number(ipv4[1]) === 10
      || (Number(ipv4[1]) === 192 && Number(ipv4[2]) === 168)
      || (Number(ipv4[1]) === 172 && Number(ipv4[2]) >= 16 && Number(ipv4[2]) <= 31)));
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw new Error(message);
  if (ipv4 && (Number(ipv4[1]) === 0 || (Number(ipv4[1]) === 169 && Number(ipv4[2]) === 254))) throw new Error(message);
  url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/images\/generations$/, "");
  return url.toString().replace(/\/+$/, "");
}
