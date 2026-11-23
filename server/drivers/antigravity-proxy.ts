import { ProxyAgent, fetch as undiciFetch } from "undici";

const proxyAgents = new Map<string, ProxyAgent>();
const MAX_PROXY_AGENTS = 128;

function envValue(env: NodeJS.ProcessEnv | undefined, keys: readonly string[]): string | undefined {
  if (!env) return undefined;
  for (const key of keys) {
    const raw = env[key]?.trim();
    if (raw) return raw;
  }
  return undefined;
}

function noProxyMatches(noProxy: string | undefined, targetUrl: string): boolean {
  if (!noProxy) return false;
  let hostname: string;
  let port: string;
  try {
    const parsed = new URL(targetUrl);
    hostname = parsed.hostname.toLowerCase();
    port = parsed.port;
  } catch {
    return false;
  }
  const hostPort = port ? `${hostname}:${port}` : hostname;
  for (const rawRule of noProxy.split(",")) {
    const rule = rawRule.trim().toLowerCase();
    if (!rule) continue;
    if (rule === "*") return true;
    const ruleHost = rule.replace(/^\./, "");
    if (ruleHost === hostPort || ruleHost === hostname) return true;
    if (!rule.includes(":") && hostname.endsWith(`.${ruleHost}`)) return true;
  }
  return false;
}

export function resolveProxyUrl(env: NodeJS.ProcessEnv | undefined, targetUrl?: string): string | undefined {
  if (!env) return undefined;
  if (targetUrl && noProxyMatches(envValue(env, ["NO_PROXY", "no_proxy"]), targetUrl)) return undefined;
  const candidate = targetUrl?.startsWith("http:")
    ? envValue(env, ["HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy", "HTTPS_PROXY", "https_proxy"])
    : envValue(env, ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"]);
  if (!candidate) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error("Invalid proxy URL configured in instance environment");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Unsupported proxy protocol "${parsed.protocol}" in instance environment`);
  }
  return candidate;
}

export function proxyAgentFor(proxyUrl: string): ProxyAgent {
  const existing = proxyAgents.get(proxyUrl);
  if (existing) return existing;
  const agent = new ProxyAgent(proxyUrl);
  if (proxyAgents.size >= MAX_PROXY_AGENTS) {
    const oldest = proxyAgents.keys().next().value;
    if (oldest !== undefined) proxyAgents.delete(oldest);
  }
  proxyAgents.set(proxyUrl, agent);
  return agent;
}

export function createProxyFetch<T = typeof globalThis.fetch>(env?: NodeJS.ProcessEnv): T {
  const configured = envValue(env, ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"]);
  if (!configured) {
    return ((url: any, init?: any) => globalThis.fetch(url, init)) as unknown as T;
  }
  return (async (url: string | URL | Request, init?: any) => {
    const targetUrl = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
    const proxyUrl = resolveProxyUrl(env, targetUrl);
    if (!proxyUrl) return globalThis.fetch(url as any, init);
    const agent = proxyAgentFor(proxyUrl);
    return undiciFetch(url as any, { ...(init ?? {}), dispatcher: agent });
  }) as unknown as T;
}
