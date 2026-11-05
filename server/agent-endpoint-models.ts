import type { InstanceConfig } from "./contracts.ts";
import { CLAUDE_MODEL_ID } from "./drivers/claude-model-extras.ts";
import { providerModelsUrl } from "./provider-key-check.ts";

export function agentEndpointAddress(entry: InstanceConfig): string {
  return entry.driver === "codex"
    ? (entry.config as { endpoint: { url: string } }).endpoint.url
    : entry.environment!.ANTHROPIC_BASE_URL;
}

/** Resolves the catalog for per-agent selection without storing a provider-wide model choice. */
export async function discoverAgentEndpointModels(entry: InstanceConfig, fetchImpl: typeof fetch = fetch): Promise<void> {
  const codex = entry.driver === "codex";
  const config = entry.config as { endpoint?: { url: string; models: string[] }; endpointModels?: string[] };
  const env = entry.environment ?? {};
  const baseUrl = agentEndpointAddress(entry);
  if (baseUrl === (codex ? "https://api.openai.com/v1" : "https://api.anthropic.com")) return;
  const token = codex ? env.OPENMAUSBOT_CODEX_API_KEY : env.ANTHROPIC_API_KEY;
  const headers = codex ? { authorization: `Bearer ${token}` } : { authorization: `Bearer ${token}`, "x-api-key": token!, "anthropic-version": "2023-06-01" };
  let models: string[];
  try {
    // A redirect must never replay the credential to another address.
    const response = await fetchImpl(providerModelsUrl(codex ? "openai" : "anthropic", baseUrl), {
      headers, redirect: "manual", signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error();
    const body: unknown = await response.json();
    const data = body && typeof body === "object" ? (body as { data?: unknown }).data : undefined;
    const pattern = codex ? /^[\w][\w./+-]*$/ : CLAUDE_MODEL_ID;
    models = Array.isArray(data) ? [...new Set(data.flatMap((item: unknown) => {
      const id = item && typeof item === "object" ? (item as { id?: unknown }).id : undefined;
      return typeof id === "string" && id.length <= 160 && pattern.test(id) ? [id] : [];
    }))].slice(0, 1000) : [];
    if (!models.length) throw new Error();
  } catch {
    throw Object.assign(new Error("Could not discover gateway models. Check its URL, API key and /models support."), { status: 400 });
  }
  if (codex) config.endpoint!.models = models;
  else config.endpointModels = models;
}
