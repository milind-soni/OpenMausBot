// A Claude endpoint the person configures: its own base URL, token and models, in its own instance,
// so the Claude Code on this computer keeps its own sign-in. The token lives in the instance
// environment like every other provider key, and the entry is never read by ~/.claude.
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";

import type { ClaudeEndpointInfo } from "../shared/claude-endpoint.ts";
import { assertSeparateClaudeAccount } from "./claude-accounts.ts";
import { DATA_DIR, persistableInstanceConfigs, type AppConfig } from "./config.ts";
import type { InstanceConfig, InstanceConfigMap } from "./contracts.ts";
import { officialModels } from "./agent-endpoint-models.ts";
import { CLAUDE_MODEL_ID } from "./drivers/claude-model-extras.ts";
import { endpointBaseUrl } from "./openai-compat-endpoints.ts";

const displayName = z.string().trim().min(1).max(80).refine((value) => !/\p{Cc}/u.test(value), "Name cannot contain control characters");
const model = z.string().trim().max(160).regex(CLAUDE_MODEL_ID, "Use the model id the endpoint serves.")
  .refine((value) => value !== "default", "Claude Code reserves `default`; use the model id the endpoint serves.");
const optionalModel = z.union([model, z.literal("")]);
const token = z.string().trim().min(1).max(4096).refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value), "Token cannot contain control characters");
const baseUrl = z.string().trim().max(2048).refine((value) => endpointBaseUrl(value) !== null, "Enter an http(s) base URL.");

export const claudeEndpointSchema = z.object({
  displayName,
  baseUrl,
  token,
  model: model.optional(),
  opusModel: optionalModel.optional(),
  sonnetModel: optionalModel.optional(),
  haikuModel: optionalModel.optional(),
  smallFastModel: optionalModel.optional(),
}).strict();

export const claudeEndpointUpdateSchema = z.object({
  displayName: displayName.optional(),
  /** Omitted keeps the saved token, unless the address changes. */
  token: token.optional(),
  baseUrl: baseUrl.optional(),
  model: model.optional(),
  opusModel: optionalModel.optional(),
  sonnetModel: optionalModel.optional(),
  haikuModel: optionalModel.optional(),
  smallFastModel: optionalModel.optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "No settings supplied");

type EndpointFields = z.infer<typeof claudeEndpointUpdateSchema>;

const TIERS = [
  ["opusModel", "ANTHROPIC_DEFAULT_OPUS_MODEL"],
  ["sonnetModel", "ANTHROPIC_DEFAULT_SONNET_MODEL"],
  ["haikuModel", "ANTHROPIC_DEFAULT_HAIKU_MODEL"],
  ["smallFastModel", "ANTHROPIC_SMALL_FAST_MODEL"],
] as const;

function rawConfig(entry: InstanceConfig): Record<string, unknown> {
  return entry.config && typeof entry.config === "object" && !Array.isArray(entry.config)
    ? entry.config as Record<string, unknown> : {};
}

/** A Claude instance the person pointed at another host, rather than a named Claude account or Bedrock. */
export function isClaudeEndpoint(entry: InstanceConfig | undefined): boolean {
  return entry?.driver === "claudeAgent" && Array.isArray(rawConfig(entry).endpointModels) && rawConfig(entry).bedrock !== true;
}

export type { ClaudeEndpointInfo };

/** What the settings UI may know about an endpoint: where it points and which models, never the token. */
export function claudeEndpointInfo(entry: InstanceConfig): ClaudeEndpointInfo {
  const config = rawConfig(entry);
  const environment = entry.environment ?? {};
  return {
    baseUrl: environment.ANTHROPIC_BASE_URL ?? "",
    models: Array.isArray(config.endpointModels) ? [...config.endpointModels] : [],
    tokenSaved: Boolean(environment.ANTHROPIC_AUTH_TOKEN || environment.ANTHROPIC_API_KEY),
    opusModel: environment.ANTHROPIC_DEFAULT_OPUS_MODEL ?? "",
    sonnetModel: environment.ANTHROPIC_DEFAULT_SONNET_MODEL ?? "",
    haikuModel: environment.ANTHROPIC_DEFAULT_HAIKU_MODEL ?? "",
    smallFastModel: environment.ANTHROPIC_SMALL_FAST_MODEL ?? "",
  };
}

/** Adds each endpoint's address and models to the engine list; the token stays on the server. */
export function withClaudeEndpointInfo(described: unknown, configs: InstanceConfigMap): unknown {
  if (!Array.isArray(described)) return described;
  return described.map((instance: { instanceId?: string }) => {
    const entry = instance.instanceId ? configs[instance.instanceId] : undefined;
    return entry && isClaudeEndpoint(entry)
      ? { ...instance, url: claudeEndpointInfo(entry).baseUrl, claudeEndpoint: claudeEndpointInfo(entry) }
      : instance;
  });
}

function endpointEnvironment(url: string, secret: string, fields: EndpointFields): Record<string, string> {
  const address = endpointBaseUrl(url);
  if (!address) throw Object.assign(new Error("Enter an http(s) base URL."), { status: 400 });
  const environment: Record<string, string> = {
    ANTHROPIC_BASE_URL: address,
    ...(address === "https://api.anthropic.com" ? {} : { ANTHROPIC_AUTH_TOKEN: secret }),
    // Claude Code's own auth probe and a turn both need a key they recognize; the endpoint's token is that key.
    ANTHROPIC_API_KEY: secret,
    ...(fields.model ? { ANTHROPIC_MODEL: fields.model.trim() } : {}),
  };
  for (const [field, key] of TIERS) {
    const value = fields[field]?.trim();
    if (value) environment[key] = value;
  }
  return environment;
}

function endpointModels(fields: EndpointFields): string[] {
  const tiers = TIERS.map(([field]) => fields[field]?.trim() ?? "").filter(Boolean);
  return [...new Set([(fields.model ?? "").trim(), ...tiers].filter(Boolean))];
}

/** The installed binary, not another account's environment: an endpoint has no login of its own. */
function inheritedCli(instances: InstanceConfigMap): string | undefined {
  for (const entry of Object.values(instances)) {
    if (entry.driver !== "claudeAgent" || isClaudeEndpoint(entry)) continue;
    const cli = rawConfig(entry).cli;
    if (typeof cli === "string" && cli) return cli;
  }
  return undefined;
}

export function newClaudeEndpoint(cfg: AppConfig, body: z.infer<typeof claudeEndpointSchema>) {
  const instances = persistableInstanceConfigs(cfg);
  const instanceId = `claude-${randomUUID()}`;
  const cli = inheritedCli(instances);
  const entry: InstanceConfig = {
    driver: "claudeAgent",
    displayName: body.displayName,
    // Its own credential: the sign-in state of this Claude instance must not gate it.
    access: "custom",
    config: {
      ...(cli ? { cli } : {}),
      configDir: join(DATA_DIR, "providers", instanceId),
      requireApiKey: true,
      endpointModels: body.model ? endpointModels(body) : officialModels(false),
    },
    environment: endpointEnvironment(body.baseUrl, body.token, body),
  };
  assertSeparateClaudeAccount(instances, instanceId, entry);
  instances[instanceId] = entry;
  return { instanceId, instances };
}

/** Changes the endpoint in place; the token is replaced only when one is given. */
export function updateClaudeEndpoint(cfg: AppConfig, instanceId: string, body: EndpointFields) {
  const instances = persistableInstanceConfigs(cfg);
  const entry = instances[instanceId];
  if (!entry) throw Object.assign(new Error("unknown instance"), { status: 404 });
  if (!isClaudeEndpoint(entry)) throw Object.assign(new Error("This Claude instance is not a custom endpoint."), { status: 400 });
  const saved = claudeEndpointInfo(entry);
  if (!saved.baseUrl || !saved.models.length) throw Object.assign(new Error("This endpoint is missing its address or model. Remove it and add it again."), { status: 409 });
  const address = body.baseUrl === undefined ? saved.baseUrl : endpointBaseUrl(body.baseUrl);
  if (!address) throw Object.assign(new Error("Enter an http(s) base URL."), { status: 400 });
  // A saved token belongs to the address it was entered for.
  if (body.token === undefined && address !== endpointBaseUrl(saved.baseUrl)) throw Object.assign(new Error("Enter the endpoint's token again for the new address."), { status: 400 });
  const fields: EndpointFields = { baseUrl: address, model: body.model ?? entry.environment?.ANTHROPIC_MODEL };
  if (body.displayName !== undefined) fields.displayName = body.displayName;
  for (const [field, key] of TIERS) {
    const value = body[field] !== undefined ? body[field] : entry.environment?.[key];
    if (value !== undefined) fields[field] = value;
  }
  const secret = body.token ?? entry.environment?.ANTHROPIC_AUTH_TOKEN ?? entry.environment?.ANTHROPIC_API_KEY;
  if (!secret) throw Object.assign(new Error("Enter the endpoint's token."), { status: 400 });
  instances[instanceId] = {
    ...entry,
    ...(fields.displayName ? { displayName: fields.displayName } : {}),
    environment: endpointEnvironment(address, secret, fields),
    config: { ...rawConfig(entry), endpointModels: fields.model && (body.model !== undefined || TIERS.some(([field]) => body[field] !== undefined)) ? endpointModels(fields) : saved.models },
  };
  return { instances };
}
