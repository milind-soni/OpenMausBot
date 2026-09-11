// Does this key open the provider's door? One cheap, read-only request (the
// models list) with a short timeout, from the server that will use the key.
// The answer is a verdict and, on success, a few model ids; never the key,
// never the raw response. Keys travel only over TLS, except to a loopback
// test double.
export type ProviderKeyKind = "anthropic" | "openaiCompat" | "xai";

export type ProviderKeyVerdict =
  | { ok: true; models: string[] }
  | { ok: false; reason: "rejected" | "unreachable" | "unexpected"; status?: number };

export const PROVIDER_KEY_KINDS: readonly ProviderKeyKind[] = ["anthropic", "openaiCompat", "xai"];

const DEFAULT_URLS: Record<ProviderKeyKind, string> = {
  anthropic: "https://api.anthropic.com",
  openaiCompat: "https://openrouter.ai/api/v1",
  xai: "https://api.x.ai/v1",
};

const MAX_MODELS = 5;

function isLoopback(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host.startsWith("127.");
}

/** The models endpoint for a provider, from its base URL or the default. */
export function providerModelsUrl(provider: ProviderKeyKind, base?: string | null): string {
  const root = (base?.trim() || DEFAULT_URLS[provider]).replace(/\/+$/, "");
  if (provider === "anthropic") return root.endsWith("/v1") ? `${root}/models` : `${root}/v1/models`;
  return `${root}/models`;
}

function modelIds(body: unknown): string[] {
  const record = body && typeof body === "object" ? (body as { data?: unknown; models?: unknown }) : null;
  const list = Array.isArray(record?.data) ? record.data : Array.isArray(record?.models) ? record.models : [];
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
  let url: URL;
  try {
    url = new URL(providerModelsUrl(input.provider, input.url));
  } catch {
    return { ok: false, reason: "unexpected" };
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
    return { ok: false, reason: "unexpected" };
  }
  const headers: Record<string, string> =
    input.provider === "anthropic"
      ? { "x-api-key": input.key, "anthropic-version": "2023-06-01" }
      : { authorization: `Bearer ${input.key}` };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // A redirect is never followed: the key must not be replayed to
    // whichever host the provider's front door points at today.
    const response = await fetchImpl(url, { headers, signal: controller.signal, redirect: "manual" });
    if (response.status === 401 || response.status === 403) return { ok: false, reason: "rejected", status: response.status };
    if (!response.ok) return { ok: false, reason: "unexpected", status: response.status };
    const body: unknown = await response.json().catch(() => null);
    return { ok: true, models: modelIds(body) };
  } catch {
    return { ok: false, reason: "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}
