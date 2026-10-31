import { z } from "zod";
import { BlockList, isIP } from "node:net";

/** Owner-controlled integration settings. The Brave key stays on the server. */
export interface WebSearchConfig { searxngUrl?: string; braveApiKey?: string }

export function searxngBase(value: string): URL {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || value.includes("?") || value.includes("#")) {
    throw new Error("SearXNG needs an HTTP(S) base URL without credentials, query or fragment.");
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

export const webSearchConfigSchema = z.object({
  searxngUrl: z.string().trim().max(2048).refine(value => { try { if (value) searxngBase(value); return true; } catch { return false; } }, "Invalid SearXNG base URL").optional(),
  braveApiKey: z.string().trim().max(4096).regex(/^[\x21-\x7e]*$/).optional(),
});

export function validStoredWebSearch(value: unknown): Record<string, string> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const stored = value as Record<string, unknown>;
  const clean: Record<string, string> = {};
  for (const field of ["searxngUrl", "braveApiKey"] as const) {
    const parsed = webSearchConfigSchema.shape[field].safeParse(stored[field]);
    if (parsed.success && parsed.data !== undefined) clean[field] = parsed.data;
  }
  return clean;
}

export function configuredWebSearch(config?: WebSearchConfig): "searxng" | "brave" | null {
  return config?.searxngUrl?.trim() ? "searxng" : config?.braveApiKey?.trim() ? "brave" : null;
}

export function webSearchStatus(config?: WebSearchConfig) {
  return { searxngUrl: config?.searxngUrl ?? "", braveConfigured: Boolean(config?.braveApiKey), backend: configuredWebSearch(config) };
}

const privateV4 = new BlockList();
for (const [ip, bits] of [["127.0.0.0", 8], ["10.0.0.0", 8], ["172.16.0.0", 12], ["192.168.0.0", 16]] as const) privateV4.addSubnet(ip, bits);
const privateV6 = new BlockList();
privateV6.addAddress("::1", "ipv6");
privateV6.addSubnet("fc00::", 7, "ipv6");

export function privateSearchAddress(address: string): boolean {
  return isIP(address) === 4 ? privateV4.check(address) : isIP(address) === 6 && privateV6.check(address, "ipv6");
}
