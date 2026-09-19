// Independent API connections use the existing provider-instance envelope.
// These helpers validate drafts and redact views; callers own persistence and
// provider replacement so one edit cannot restart unrelated conversations.
import type { InstanceConfig } from "./contracts.ts";
import { fetchSetupModels, normalizeApiUrl, verifySetupCompletion } from "./cli-api-setup.ts";
import { OpenAICompatDriver, resolveOpenAICompatKey } from "./drivers/openai-compat.ts";

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

function field(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || value.length > max || /\p{Cc}/u.test(value)) {
    throw new Error(`${name} must be text without control characters (up to ${max} characters).`);
  }
  return value.trim();
}

function effectiveConfig(entry: InstanceConfig) {
  if (entry.driver !== "openai-compat") throw new Error("This is not an OpenAI-compatible connection.");
  return OpenAICompatDriver.decodeConfig(entry.config);
}

export function openAIConnectionMetadata(instanceId: string, entry: InstanceConfig) {
  const config = effectiveConfig(entry);
  const auth = config.auth ?? "bearer";
  return {
    instanceId,
    displayName: entry.displayName || (instanceId === "openaiCompat" ? "OpenAI-compatible" : instanceId),
    url: config.url,
    auth,
    configured: auth === "none" || !!resolveOpenAICompatKey(config, entry.environment ?? {}),
    model: config.model ?? "",
    tools: config.tools !== false,
    provider: config.provider ?? "",
    legacy: config.auth === undefined,
  };
}

/** Omitted keys retain the saved key only at the same API URL. */
export function prepareOpenAIConnection(
  body: unknown,
  existing?: InstanceConfig,
  effective: InstanceConfig | undefined = existing,
): InstanceConfig {
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw new Error("A connection object is required.");
  const draft = object(body);
  const previous = effective ? effectiveConfig(effective) : undefined;
  const name = draft.displayName === undefined && existing
    ? existing.displayName || "OpenAI-compatible" : field(draft.displayName, "Connection name", 120);
  if (!name) throw new Error("A connection name is required.");
  const url = normalizeApiUrl(draft.url === undefined && previous ? previous.url : field(draft.url, "API URL", 2048));
  const auth = draft.auth === undefined ? previous?.auth ?? "bearer" : draft.auth;
  if (auth !== "bearer" && auth !== "none") throw new Error("Authentication must be bearer or none.");
  if (draft.tools !== undefined && typeof draft.tools !== "boolean") throw new Error("tools must be a boolean.");
  const model = draft.model === undefined ? previous?.model ?? "" : field(draft.model, "Model ID", 512);
  const provider = draft.provider === undefined ? previous?.provider ?? "" : field(draft.provider, "Upstream provider", 256);
  let key = "";
  if (auth === "bearer") {
    if (draft.key !== undefined) {
      key = field(draft.key, "API key", 8192);
      if (/\s/u.test(key)) throw new Error("The API key must not contain spaces or line breaks.");
    } else if (previous && normalizeApiUrl(previous.url) === url) {
      key = resolveOpenAICompatKey(previous, effective?.environment ?? {});
    } else if (previous) {
      throw new Error("Enter the API key again when changing the API URL.");
    }
    if (!key) throw new Error("An API key is required for bearer authentication.");
  }
  const config = {
    ...object(existing?.config),
    url, auth, key, model, provider,
    tools: draft.tools ?? previous?.tools ?? true,
  };
  return { ...existing, driver: "openai-compat", displayName: name, config };
}

/** Catalog success proves catalog access; only the explicit response probe bills. */
export async function probeOpenAIConnection(body: unknown, effective?: InstanceConfig): Promise<{
  ok: true;
  check: "models" | "response";
  models: string[];
}> {
  const draft = object(body);
  if (draft.kind !== "catalog" && draft.kind !== "response") throw new Error("Choose a catalog or response test.");
  const entry = prepareOpenAIConnection({ ...draft, displayName: draft.displayName || "Connection test" }, effective);
  const config = effectiveConfig(entry);
  const key = resolveOpenAICompatKey(config, entry.environment ?? {});
  if (draft.kind === "response") {
    await verifySetupCompletion(config.url, key, config.model ?? "", config.provider, config.auth);
    return { ok: true, check: "response", models: [config.model!] };
  }
  const models = await fetchSetupModels(config.url, key, config.auth);
  return { ok: true, check: "models", models: models.map(({ id }) => id) };
}
