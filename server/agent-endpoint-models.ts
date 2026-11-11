import type { InstanceConfig } from "./contracts.ts";
import { CLAUDE_MODEL_ID } from "./drivers/claude-model-extras.ts";
import { STATIC_CODEX_MODELS } from "./drivers/codex-catalog.ts";
import { currentEngineCatalog } from "./model-manifest/manifest.ts";
import { isLoopback, providerModelsUrl } from "./provider-key-check.ts";

const OFFICIAL_URL = { codex: "https://api.openai.com/v1", claude: "https://api.anthropic.com" } as const;
const MAX_CATALOG_BYTES = 2 * 1024 * 1024;
const MAX_MODELS = 1000;
const TYPE_MODEL = " Or type the model the host serves in Model.";

export function agentEndpointAddress(entry: InstanceConfig): string {
  return entry.driver === "codex"
    ? (entry.config as { endpoint: { url: string } }).endpoint.url
    : entry.environment!.ANTHROPIC_BASE_URL;
}

export function isGatewayEndpoint(entry: InstanceConfig): boolean {
  return agentEndpointAddress(entry) !== OFFICIAL_URL[entry.driver === "codex" ? "codex" : "claude"];
}

/** An endpoint saved with a fixed model keeps it; discovery never replaces it. */
export function hasExplicitModel(entry: InstanceConfig): boolean {
  return entry.driver === "codex"
    ? Boolean((entry.config as { endpoint?: { model?: string } }).endpoint?.model)
    : Boolean(entry.environment?.ANTHROPIC_MODEL);
}

export function officialModels(codex: boolean): string[] {
  const catalog = codex ? STATIC_CODEX_MODELS : currentEngineCatalog("claude");
  return [...new Set([catalog.default, ...catalog.options.map(option => option.id)])];
}

/** Reads at most `limit` bytes, so a gateway cannot make the server buffer an unbounded body. */
async function readCatalog(response: Response, limit: number): Promise<string | null> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel().catch(() => {}); return null; }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Resolves the catalog for per-agent selection without storing a provider-wide model choice. */
export async function discoverAgentEndpointModels(entry: InstanceConfig, fetchImpl: typeof fetch = fetch): Promise<void> {
  const codex = entry.driver === "codex";
  const config = entry.config as { endpoint?: { url: string; models: string[] }; endpointModels?: string[] };
  const setModels = (models: string[]) => { if (codex) config.endpoint!.models = models; else config.endpointModels = models; };
  if (!isGatewayEndpoint(entry)) return setModels(officialModels(codex));
  const env = entry.environment ?? {};
  const token = codex ? env.OPENMAUSBOT_CODEX_API_KEY : env.ANTHROPIC_API_KEY;
  const headers = codex ? { authorization: `Bearer ${token}` } : { authorization: `Bearer ${token}`, "x-api-key": token!, "anthropic-version": "2023-06-01" };
  const modelsUrl = providerModelsUrl(codex ? "openai" : "anthropic", agentEndpointAddress(entry));
  const failure = (detail: string) => Object.assign(new Error(`Could not discover gateway models: ${detail}`), { status: 400 });
  // Same rule as checkProviderKey: the key goes out only over HTTPS, or over plain HTTP to this computer.
  const target = new URL(modelsUrl);
  if (target.protocol !== "https:" && !(target.protocol === "http:" && isLoopback(target.hostname))) {
    throw failure(`OpenMausBot reads a model list only over HTTPS or from this computer, so your key is not sent in the clear.${TYPE_MODEL}`);
  }
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
  if (!response.ok) await response.body?.cancel().catch(() => {});
  if (response.status === 401 || response.status === 403) {
    throw failure(`The gateway rejected the API key (HTTP ${response.status}). Use the gateway's client API key, not a ChatGPT or Claude login token.`);
  }
  if (response.status === 404) throw failure(`The model catalog was not found (HTTP 404). Check the base URL; Codex usually needs /v1 and requests /v1/models.${TYPE_MODEL}`);
  if (response.status >= 300 && response.status < 400) throw failure("The gateway redirected the model request. Enter the final API base URL; credentials are never forwarded through redirects.");
  if (!response.ok) throw failure(`The model request failed (HTTP ${response.status}). Check the gateway's status and model catalog support.`);
  const text = await readCatalog(response, MAX_CATALOG_BYTES)
    .catch(() => { throw failure("The gateway closed the connection while sending its model catalog. Try again, or check the gateway's logs."); });
  if (text === null) throw failure("The model catalog is larger than 2 MB. Check that the base URL points to the gateway's API.");
  let body: unknown;
  try { body = JSON.parse(text); } catch { throw failure("The gateway did not return a JSON model catalog. Check that the base URL points to its API, not its dashboard."); }
  const data = body && typeof body === "object" ? (body as { data?: unknown }).data : undefined;
  const pattern = codex ? /^[\w][\w./+-]*$/ : CLAUDE_MODEL_ID;
  const models = new Set<string>();
  for (const item of Array.isArray(data) ? data : []) {
    if (models.size >= MAX_MODELS) break;
    const id = item && typeof item === "object" ? (item as { id?: unknown }).id : undefined;
    // Claude Code reads `--model default` as its own default model, not a gateway model id.
    if (typeof id === "string" && id.length <= 160 && pattern.test(id) && (codex || id !== "default")) models.add(id);
  }
  if (!models.size) throw failure(`The gateway returned no supported model IDs. Connect a provider account in the gateway and check its /models catalog.${TYPE_MODEL}`);
  setModels([...models]);
}
