import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";

import type { CodexEndpointInfo } from "../shared/claude-endpoint.ts";
import { officialModels } from "./agent-endpoint-models.ts";
import { claudeEndpointSchema } from "./claude-endpoints.ts";
import { DATA_DIR, persistableInstanceConfigs, type AppConfig } from "./config.ts";
import type { InstanceConfig, InstanceConfigMap } from "./contracts.ts";
import { endpointBaseUrl } from "./openai-compat-endpoints.ts";

export const codexEndpointSchema = claudeEndpointSchema.pick({ displayName: true, baseUrl: true, token: true, model: true })
  .extend({ model: z.string().trim().min(1).max(160).regex(/^[\w][\w./+-]*$/, "Use the model id the Responses endpoint serves.").optional(), baseUrl: claudeEndpointSchema.shape.baseUrl.refine(value => {
    const address = endpointBaseUrl(value);
    if (!address) return false;
    const url = new URL(address);
    return url.protocol === "https:" || url.hostname === "localhost" || url.hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  }, "Use HTTPS, or HTTP on localhost through a secure tunnel.") });
export const codexEndpointUpdateSchema = codexEndpointSchema.partial().refine(value => Object.keys(value).length > 0, "No settings supplied");

type Fields = Partial<z.infer<typeof codexEndpointSchema>>;

function configOf(entry: InstanceConfig) {
  return (entry.config ?? {}) as { cli?: string; endpoint?: { url: string; models: string[]; model?: string } };
}

export function isCodexEndpoint(entry: InstanceConfig | undefined): boolean {
  if (entry?.driver !== "codex") return false;
  const endpoint = configOf(entry).endpoint;
  return Boolean(endpoint && typeof endpoint.url === "string" && endpointBaseUrl(endpoint.url)
    && Array.isArray(endpoint.models) && endpoint.models.every(model => typeof model === "string"));
}

function infoOf(entry: InstanceConfig): CodexEndpointInfo {
  const endpoint = configOf(entry).endpoint!;
  return { baseUrl: endpoint.url, models: [...endpoint.models], tokenSaved: Boolean(entry.environment?.OPENMAUSBOT_CODEX_API_KEY) };
}

export function withCodexEndpointInfo(described: unknown, configs: InstanceConfigMap): unknown {
  if (!Array.isArray(described)) return described;
  return described.map((instance: { instanceId?: string }) => {
    const entry = instance.instanceId ? configs[instance.instanceId] : undefined;
    return entry && isCodexEndpoint(entry) ? { ...instance, url: infoOf(entry).baseUrl, codexEndpoint: infoOf(entry) } : instance;
  });
}

export function newCodexEndpoint(cfg: AppConfig, body: z.infer<typeof codexEndpointSchema>) {
  const instances = persistableInstanceConfigs(cfg);
  const instanceId = `codex-endpoint-${randomUUID()}`;
  const source = Object.values(instances).find(entry => entry.driver === "codex" && configOf(entry).cli);
  const cli = source ? configOf(source).cli : undefined;
  instances[instanceId] = {
    driver: "codex", access: "custom", displayName: body.displayName,
    config: { ...(cli ? { cli } : {}), endpoint: { url: endpointBaseUrl(body.baseUrl)!, ...(body.model ? { model: body.model, models: [body.model] } : { models: officialModels(true) }) } },
    environment: { CODEX_HOME: join(DATA_DIR, "providers", instanceId), OPENMAUSBOT_CODEX_API_KEY: body.token },
  };
  return { instanceId, instances };
}

export function updateCodexEndpoint(cfg: AppConfig, instanceId: string, body: Fields) {
  const instances = persistableInstanceConfigs(cfg);
  const entry = instances[instanceId];
  if (!entry) throw Object.assign(new Error("unknown instance"), { status: 404 });
  if (!isCodexEndpoint(entry)) throw Object.assign(new Error("This Codex instance is not a direct API endpoint."), { status: 400 });
  const saved = infoOf(entry);
  const address = body.baseUrl === undefined ? saved.baseUrl : endpointBaseUrl(body.baseUrl)!;
  // A saved credential belongs only to the address it was entered for.
  if (body.token === undefined && address !== saved.baseUrl) throw Object.assign(new Error("Enter the endpoint's token again for the new address."), { status: 400 });
  const token = body.token ?? entry.environment?.OPENMAUSBOT_CODEX_API_KEY;
  if (!token) throw Object.assign(new Error("Enter the endpoint's token."), { status: 400 });
  instances[instanceId] = {
    ...entry, ...(body.displayName ? { displayName: body.displayName } : {}),
    config: { ...configOf(entry), endpoint: { ...configOf(entry).endpoint!, url: address, ...(body.model ? { model: body.model, models: [body.model] } : {}) } },
    environment: { ...entry.environment, OPENMAUSBOT_CODEX_API_KEY: token },
  };
  return { instances };
}
