export type AvatarImageProvider = "openai" | "xai" | "custom";

export interface ImageGenerationConfig {
  provider?: AvatarImageProvider;
  /** Legacy OpenAI key; never sent to another provider. */
  key?: string;
  customApiKey?: string;
  customUrl?: string;
  customModel?: string;
}

/** A deliberately configured Images API endpoint, not a provider-returned URL.
 * Local HTTP is useful for self-hosted routers; internet endpoints require TLS. */
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
