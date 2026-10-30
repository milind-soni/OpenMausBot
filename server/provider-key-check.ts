// OpenRouter's catalog is public, so /key proves the key there; elsewhere /models proves only catalog access. Keys go only over TLS (or loopback).
export type ProviderKeyKind = "anthropic" | "openai" | "openrouter" | "openaiCompat" | "xai" | "mistral" | "cerebras" | "groq" | "meta";

export type ProviderKeyVerdict =
  /** `freeTier`: OpenRouter's /key says the account never bought credit, so paid models refuse it. */
  | { ok: true; check: "authentication" | "models"; models: string[]; freeTier?: boolean }
  | { ok: false; reason: "rejected" | "unreachable" | "unexpected"; status?: number };

export const PROVIDER_KEY_KINDS: readonly ProviderKeyKind[] = ["anthropic", "openai", "openrouter", "openaiCompat", "xai", "mistral", "cerebras", "groq", "meta"];

const DEFAULT_URLS: Record<ProviderKeyKind, string> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  openaiCompat: "https://openrouter.ai/api/v1",
  xai: "https://api.x.ai/v1",
  mistral: "https://api.mistral.ai/v1",
  cerebras: "https://api.cerebras.ai/v1",
  groq: "https://api.groq.com/openai/v1",
  meta: "https://api.meta.ai/v1",
};

const MAX_MODELS = 5;

/** A URL hostname on this machine: the only place a key may go over plain http. */
export function isLoopback(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host.startsWith("127.");
}

export function providerBaseUrl(provider: ProviderKeyKind, base?: string | null): string {
  return (base?.trim() || DEFAULT_URLS[provider]).replace(/\/+$/, "");
}

export function providerModelsUrl(provider: ProviderKeyKind, base?: string | null): string {
  const root = providerBaseUrl(provider, base);
  if (provider === "anthropic") return root.endsWith("/v1") ? `${root}/models` : `${root}/v1/models`;
  return `${root}/models`;
}

function modelIds(body: unknown): string[] {
  const record = body && typeof body === "object" ? (body as { data?: unknown; models?: unknown }) : null;
  const list = Array.isArray(body) ? body : Array.isArray(record?.data) ? record.data : Array.isArray(record?.models) ? record.models : [];
  const ids: string[] = [];
  for (const entry of list) {
    const item = entry && typeof entry === "object" ? (entry as { id?: unknown; name?: unknown }) : null;
    const id = typeof item?.id === "string" ? item.id : typeof item?.name === "string" ? item.name : null;
    if (id && id.length <= 120) ids.push(id);
    if (ids.length === MAX_MODELS) break;
  }
  return ids;
}

export async function checkProviderKey(
  input: { provider: ProviderKeyKind; key: string; url?: string | null },
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 10_000,
): Promise<ProviderKeyVerdict> {
  if (!input.key.trim()) return { ok: false, reason: "rejected" };
  let url: URL;
  try {
    url = new URL(providerModelsUrl(input.provider, input.url));
  } catch {
    return { ok: false, reason: "unexpected" };
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
    return { ok: false, reason: "unexpected" };
  }
  const authenticate = (input.provider === "openaiCompat" || input.provider === "openrouter")
    && url.origin === "https://openrouter.ai" && url.pathname === "/api/v1/models";
  if (authenticate) url.pathname = "/api/v1/key";
  const headers: Record<string, string> =
    input.provider === "anthropic"
      ? { "x-api-key": input.key, "anthropic-version": "2023-06-01" }
      : { authorization: `Bearer ${input.key}` };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Never follow a redirect: the key must not be replayed to whichever host the front door points at.
    const response = await fetchImpl(url, { headers, signal: controller.signal, redirect: "manual" });
    if (response.status === 401 || response.status === 403) return { ok: false, reason: "rejected", status: response.status };
    if (!response.ok) return { ok: false, reason: "unexpected", status: response.status };
    const body: unknown = await response.json().catch(() => null);
    if (!body || typeof body !== "object") return { ok: false, reason: "unexpected", status: response.status };
    if (authenticate) {
      const data = (body as { data?: unknown }).data;
      const freeTier = data && typeof data === "object" && !Array.isArray(data) ? (data as { is_free_tier?: unknown }).is_free_tier : undefined;
      if (typeof freeTier !== "boolean") return { ok: false, reason: "unexpected", status: response.status };
      return { ok: true, check: "authentication", models: [], freeTier };
    }
    return { ok: true, check: "models", models: modelIds(body) };
  } catch {
    return { ok: false, reason: "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}
