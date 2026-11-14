export type AvatarImageProvider = "openai" | "xai" | "custom";
export const IMAGE_PROVIDERS = ["openai", "xai", "gemini", "openrouter", "custom"] as const;
export type ImageProvider = (typeof IMAGE_PROVIDERS)[number];

export const IMAGE_MAX_PER_TURN_DEFAULT = 4;
export const IMAGE_DEFAULT_MODELS: Record<ImageProvider, string> = {
  openai: "gpt-image-2", xai: "grok-imagine-image-2.0", gemini: "gemini-2.5-flash-image", openrouter: "google/gemini-2.5-flash-image", custom: "",
};

/** What Settings' Test learns about a provider; no image is made. */
export type ImageProviderTest =
  | { ok: true; check: "authentication" | "models"; freeTier?: boolean }
  | { ok: false; reason: "no_key" | "no_url" | "rejected" | "unreachable" | "unexpected"; status?: number }
  | { ok: false; reason: "model_missing"; model: string };

export interface ImageModelChoice {
  id: string;
  name: string;
}

/** Offered first in Settings; OpenRouter adds the rest of its live image catalog, and any other ID can be typed. */
export const IMAGE_MODEL_CHOICES: Record<ImageProvider, readonly ImageModelChoice[]> = {
  openai: [
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
  /** An OpenAI key; never sent to another provider. */
  key?: string;
  geminiKey?: string;
  customApiKey?: string;
  customUrl?: string;
  provider?: AvatarImageProvider;
  customModel?: string;
}

/** A deliberately configured Images API endpoint, not a provider-returned URL.
 * Local HTTP is useful for self-hosted routers; internet endpoints require TLS.
 * Unique-local, link-local, metadata, and unspecified addresses are refused on either scheme. */
const API_KEY_SHAPE = /^(sk-|sk_|xai-|gsk_|AIza)[A-Za-z0-9_-]{12,}$/;

function bareHost(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/^\[|\]$/g, "").split("%", 1)[0] ?? "";
}

function ipv4Octets(host: string): number[] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return null;
  const octets = match.slice(1).map(Number);
  return octets.every((octet) => octet <= 255) ? octets : null;
}

/** Eight groups, with a trailing dotted IPv4 folded into the last two. */
function ipv6Groups(host: string): number[] | null {
  const dotted = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(host);
  let text = host;
  if (dotted) {
    const octets = ipv4Octets(dotted[2] ?? "");
    if (!octets) return null;
    text = `${dotted[1]}${((octets[0]! << 8) | octets[1]!).toString(16)}:${((octets[2]! << 8) | octets[3]!).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array<string>(missing).fill("0"), ...tail].map((part) => /^[0-9a-f]{1,4}$/.test(part) ? Number.parseInt(part, 16) : Number.NaN);
  return groups.length === 8 && groups.every((part) => Number.isInteger(part)) ? groups : null;
}

function octetsFromGroups(high: number, low: number): number[] {
  return [high >> 8, high & 0xff, low >> 8, low & 0xff];
}

/** IPv4 carried in a mapped, NAT64, or 6to4 address. A translator sends that IPv4 on. */
function embeddedOctets(groups: number[]): number[] | null {
  const prefix = (count: number) => groups.slice(0, count).every((part) => part === 0);
  if (prefix(5) && groups[5] === 0xffff) return octetsFromGroups(groups[6]!, groups[7]!);
  if (groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((part) => part === 0)) return octetsFromGroups(groups[6]!, groups[7]!);
  if (groups[0] === 0x2002) return octetsFromGroups(groups[1]!, groups[2]!);
  return null;
}

/** Cloud metadata, link-local, unique-local, and the unspecified address, including the IPv4 a translator would send.
 * The settings page imports this file, so this stays free of node:net. */
function refusedImageHost(host: string): boolean {
  const bare = bareHost(host);
  const ipv4 = ipv4Octets(bare);
  if (ipv4) return ipv4[0] === 0 || (ipv4[0] === 169 && ipv4[1] === 254) || (ipv4[0] === 100 && ipv4[1] === 100 && ipv4[2] === 100 && ipv4[3] === 200);
  const groups = ipv6Groups(bare);
  if (!groups) return false;
  const first = groups[0]!;
  if (groups.every((part) => part === 0) || (first >= 0xfc00 && first <= 0xfdff) || (first >= 0xfe80 && first <= 0xfebf)) return true;
  const embedded = embeddedOctets(groups);
  return embedded !== null && refusedImageHost(embedded.join("."));
}

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
  if (refusedImageHost(host)) throw new Error(message);
  const ipv4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  const local = host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")
    || host === "host.docker.internal" || host === "host.containers.internal"
    || host === "[::1]"
    || (ipv4 && (Number(ipv4[1]) === 127 || Number(ipv4[1]) === 10
      || (Number(ipv4[1]) === 192 && Number(ipv4[2]) === 168)
      || (Number(ipv4[1]) === 172 && Number(ipv4[2]) >= 16 && Number(ipv4[2]) <= 31)));
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw new Error(message);
  url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/images\/generations$/, "");
  return url.toString().replace(/\/+$/, "");
}
