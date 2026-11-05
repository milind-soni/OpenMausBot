import type { InstanceConfig } from "./contracts.ts";
import { CLAUDE_MODEL_ID } from "./drivers/claude-model-extras.ts";
import { isLoopback, providerModelsUrl } from "./provider-key-check.ts";

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
  const modelsUrl = providerModelsUrl(codex ? "openai" : "anthropic", baseUrl);
  const failure = (detail: string) => Object.assign(new Error(`Could not discover gateway models: ${detail}`), { status: 400 });
  let response: Response;
  try {
    // A redirect must never replay the credential to another address.
    response = await fetchImpl(modelsUrl, {
      headers, redirect: "manual", signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    const timeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    const localHint = isLoopback(new URL(modelsUrl).hostname)
      ? " localhost refers to OpenMausBot's server or container. If both apps run on this computer, try 127.0.0.1; otherwise use an address reachable from that server."
      : " Check that the gateway address is reachable from OpenMausBot's server.";
    throw failure((timeout ? "The request timed out." : "OpenMausBot's server could not reach the gateway.") + localHint);
  }
  if (response.status === 401 || response.status === 403) {
    throw failure(`The gateway rejected the API key (HTTP ${response.status}). Use the gateway's client API key, not a ChatGPT or Claude login token.`);
  }
  if (response.status === 404) throw failure("The model catalog was not found (HTTP 404). Check the base URL; Codex usually needs /v1 and requests /v1/models.");
  if (response.status >= 300 && response.status < 400) throw failure("The gateway redirected the model request. Enter the final API base URL; credentials are never forwarded through redirects.");
  if (!response.ok) throw failure(`The model request failed (HTTP ${response.status}). Check the gateway's status and model catalog support.`);
  const body: unknown = await response.json().catch(() => { throw failure("The gateway did not return a JSON model catalog. Check that the base URL points to its API, not its dashboard."); });
  const data = body && typeof body === "object" ? (body as { data?: unknown }).data : undefined;
  const pattern = codex ? /^[\w][\w./+-]*$/ : CLAUDE_MODEL_ID;
  const models = Array.isArray(data) ? [...new Set(data.flatMap((item: unknown) => {
    const id = item && typeof item === "object" ? (item as { id?: unknown }).id : undefined;
    return typeof id === "string" && id.length <= 160 && pattern.test(id) ? [id] : [];
  }))].slice(0, 1000) : [];
  if (!models.length) throw failure("The gateway returned no supported model IDs. Connect a provider account in the gateway and check its /models catalog.");
  if (codex) config.endpoint!.models = models;
  else config.endpointModels = models;
}
