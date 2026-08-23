import { z } from "zod";

import { DshApiClient, DshRpcError } from "./drivers/deepseek-harness/client.ts";
import type { DeepSeekHarnessConfig } from "./drivers/deepseek-harness/index.ts";
import { dshJsonValueSchema, type DshJsonValue } from "./drivers/deepseek-harness/protocol.ts";
import {
  DEEPSEEK_HARNESS_MAX_TOKEN_LIMIT,
  type DeepSeekHarnessPublicErrorCode,
} from "../shared/deepseek-harness.ts";

const MAX_BODY_BYTES = 16 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_PAIRING_LINK_LENGTH = 4_096;
const MAX_PAIR_TOKEN_LENGTH = 512;
const MAX_COOKIE_LENGTH = 4_096;
const MAX_IDENTIFIER_LENGTH = 160;
const MAX_DISPLAY_NAME_LENGTH = 240;
const MAX_PROVIDERS = 128;
const MAX_MODELS = 2_000;
const DEFAULT_TIMEOUT_MS = 8_000;
const PAIRED_CATALOG_REASON = "Update @linxin666/dsh-remote-web-ui to a version that supports paired model management.";
const REASONING_EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type DeepSeekHarnessReasoningEffort = typeof REASONING_EFFORTS[number];

const safeString = (max: number) => z.string().trim().min(1).max(max)
  .refine((value) => !/[\r\n\0]/.test(value), "must not contain a newline or NUL");
const providerIdSchema = safeString(MAX_IDENTIFIER_LENGTH);
const displayNameSchema = safeString(MAX_DISPLAY_NAME_LENGTH);
const agentPresetSchema = safeString(512);
const deviceCookieSchema = z.string().min(1).max(MAX_COOKIE_LENGTH).regex(/^[^\r\n]+$/);
const canonicalEffortsSchema = z.array(z.enum(REASONING_EFFORTS)).min(1).max(REASONING_EFFORTS.length).refine(
  (efforts) => efforts.every((effort, index) => index === 0 || REASONING_EFFORTS.indexOf(efforts[index - 1]!) < REASONING_EFFORTS.indexOf(effort)),
  "reasoning efforts must be unique and in canonical order",
);
const modelProfileSchema = z.object({
  id: providerIdSchema,
  name: displayNameSchema.optional(),
  contextWindow: z.number().int().safe().positive().max(DEEPSEEK_HARNESS_MAX_TOKEN_LIMIT).optional(),
  maxTokens: z.number().int().safe().positive().max(DEEPSEEK_HARNESS_MAX_TOKEN_LIMIT).optional(),
  reasoningEfforts: canonicalEffortsSchema.optional(),
}).strict();
const connectionPatchSchema = z.object({
  baseUrl: z.string().trim().min(1).max(2_048).optional(),
  transport: z.enum(["direct", "paired"]).optional(),
  agentPreset: z.union([agentPresetSchema, z.null()]).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "at least one setting is required");
const pairRequestSchema = z.object({ pairingLink: z.string().trim().min(1).max(MAX_PAIRING_LINK_LENGTH) }).strict();
const discoverRequestSchema = z.object({ provider: providerIdSchema }).strict();
const upsertRequestSchema = z.object({ provider: providerIdSchema, model: modelProfileSchema }).strict();

const providerViewSchema = z.object({
  provider: providerIdSchema,
  displayName: displayNameSchema,
  settingsNs: z.string().max(MAX_IDENTIFIER_LENGTH),
  settingsPath: z.array(z.string().max(MAX_IDENTIFIER_LENGTH)).max(8),
  active: z.boolean(),
  declared: z.boolean().optional(),
});
const providersValueSchema = z.object({ providers: z.array(providerViewSchema).max(MAX_PROVIDERS) });
const namespaceViewSchema = z.object({
  ns: providerIdSchema,
  schema: dshJsonValueSchema,
  value: dshJsonValueSchema,
  base: dshJsonValueSchema.optional(),
  user: dshJsonValueSchema.optional(),
  applies: z.enum(["live", "restart"]),
  secrets: z.array(z.object({ path: z.array(z.string()).max(16), set: z.boolean() })).max(256),
  revision: z.number().int().safe().nonnegative(),
});
const settingsValueSchema = z.object({
  writable: z.boolean(),
  hasDocument: z.boolean(),
  namespaces: z.array(namespaceViewSchema).max(128),
});
const candidateSchema = z.object({
  id: providerIdSchema,
  name: displayNameSchema.optional(),
  contextWindow: z.number().int().safe().positive().max(DEEPSEEK_HARNESS_MAX_TOKEN_LIMIT).optional(),
  maxTokens: z.number().int().safe().positive().max(DEEPSEEK_HARNESS_MAX_TOKEN_LIMIT).optional(),
});
const candidatesValueSchema = z.object({ models: z.array(candidateSchema).max(MAX_MODELS) });
const jsonArraySchema = z.array(dshJsonValueSchema).max(MAX_MODELS);
const jsonObjectSchema = z.record(z.string(), dshJsonValueSchema);
const catalogModelSchema = z.object({
  id: providerIdSchema,
  name: displayNameSchema,
  description: z.string().max(2_000).optional(),
  reasoning: z.object({
    efforts: z.array(z.object({ id: providerIdSchema, name: displayNameSchema, description: z.string().max(2_000).optional() })).max(REASONING_EFFORTS.length),
    defaultEffort: providerIdSchema.optional(),
  }).optional(),
});
const catalogSchema = z.object({
  groups: z.array(z.object({
    id: providerIdSchema,
    name: displayNameSchema,
    models: z.array(catalogModelSchema).max(MAX_MODELS),
  })).max(MAX_PROVIDERS),
  failures: z.array(z.object({ id: providerIdSchema, name: displayNameSchema, message: z.string() })).max(MAX_PROVIDERS),
});
const pairedCatalogCapabilitySchema = z.object({
  capability: z.literal("paired-model-catalog"),
  providers: z.array(z.object({ provider: providerIdSchema, displayName: displayNameSchema })).max(MAX_PROVIDERS),
});

export interface DeepSeekHarnessConnectionPatch {
  baseUrl?: string;
  transport?: "direct" | "paired";
  agentPreset?: string | null;
}

export interface DeepSeekHarnessPairRequest {
  pairingLink: string;
}

export interface DeepSeekHarnessDiscoverRequest {
  provider: string;
}

export interface DeepSeekHarnessModelProfile {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoningEfforts?: DeepSeekHarnessReasoningEffort[];
}

export interface DeepSeekHarnessUpsertRequest {
  provider: string;
  model: DeepSeekHarnessModelProfile;
}

export interface DeepSeekHarnessManagementDescription {
  available: boolean;
  supported: boolean;
  providers: Array<{ provider: string; displayName: string }>;
  reasonCode?: "host-unavailable" | "paired-device-unauthorized" | "paired-plugin-update-required";
  reason?: string;
}

interface ParsedPairingLink {
  baseUrl: string;
  token: string;
}

interface DshJsonObject {
  [key: string]: DshJsonValue;
}

interface ConfiguredModelOverrides {
  present: boolean;
  values: Map<string, DshJsonObject>;
}

export interface DeepSeekHarnessPublicCatalog {
  groups: Array<{
    id: string;
    name: string;
    models: Array<{
      id: string;
      name: string;
      description?: string;
      reasoning?: { efforts: Array<{ id: string; name: string; description?: string }>; defaultEffort?: string };
    }>;
  }>;
  failures: Array<{ id: string; name: string; message: string }>;
}

type SettingsMutationOp =
  | { op: "set"; path: string[]; value: DshJsonValue }
  | { op: "unset"; path: string[] };

export class DeepSeekHarnessSettingsError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "DeepSeekHarnessSettingsError";
    this.status = status;
    this.code = code;
  }
}

const PUBLIC_ERROR_COPY = {
  "settings-busy": "Another provider update is still finishing. Wait a moment and try again.",
  "invalid-request": "The DeepSeek Harness settings request was invalid.",
  "invalid-base-url": "Enter an absolute HTTP or HTTPS origin, including its port when needed.",
  "pairing-required": "No approved paired device is stored. Paste a pairing link generated by DSH to connect this device.",
  "pairing-unavailable": "OpenMausBot could not reach the DSH pairing endpoint. Check the base URL and network or Tailscale access, then retry.",
  "pairing-rejected": "DSH rejected this pairing link or token because it is invalid or expired. Generate a fresh pairing link and try again.",
  "host-unavailable": "DeepSeek Harness is unreachable from this OpenMausBot host.",
  "paired-device-unauthorized": "Pair this DeepSeek Harness again to restore paired access.",
  "paired-plugin-update-required": "Update @linxin666/dsh-remote-web-ui, then check again.",
  "provider-not-eligible": "This provider is not eligible for pi-ai model management.",
  "model-update-conflict": "DSH settings changed elsewhere. Refresh the catalog and try again.",
  "model-update-rejected": "DeepSeek Harness rejected the model update.",
  "invalid-response": "DeepSeek Harness returned an invalid model-management response.",
  "request-failed": "DeepSeek Harness request failed. Check the connection and try again.",
} satisfies Readonly<Record<DeepSeekHarnessPublicErrorCode, string>>;

export interface PublicDeepSeekHarnessSettingsError {
  status: number;
  code: DeepSeekHarnessPublicErrorCode;
  error: string;
}

export function publicDeepSeekHarnessSettingsError(
  error: DeepSeekHarnessSettingsError,
): PublicDeepSeekHarnessSettingsError {
  let code: DeepSeekHarnessPublicErrorCode;
  switch (error.code) {
    case "invalid-request":
    case "invalid-pairing-link":
    case "invalid-deepseek-config":
    case "deepseek-instance-not-found":
      code = "invalid-request";
      break;
    case "invalid-base-url":
      code = "invalid-base-url";
      break;
    case "pairing-required":
      code = "pairing-required";
      break;
    case "pairing-unavailable":
    case "pairing-redirect-refused":
      code = "pairing-unavailable";
      break;
    case "pairing-rejected":
      code = "pairing-rejected";
      break;
    case "paired-device-unauthorized":
      code = "paired-device-unauthorized";
      break;
    case "paired-model-catalog-unavailable":
      code = "paired-plugin-update-required";
      break;
    case "provider-not-eligible":
      code = "provider-not-eligible";
      break;
    case "model-update-conflict":
      code = "model-update-conflict";
      break;
    case "model-update-rejected":
      code = "model-update-rejected";
      break;
    case "invalid-dsh-response":
    case "invalid-paired-response":
      code = "invalid-response";
      break;
    case "paired-host-unavailable":
    case "paired-redirect-refused":
    case "paired-model-management-failed":
    case "dsh-management-failed":
      code = "host-unavailable";
      break;
    default:
      code = "request-failed";
  }
  return { status: error.status, code, error: PUBLIC_ERROR_COPY[code] };
}

export function normalizeDeepSeekHarnessBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new DeepSeekHarnessSettingsError(400, "invalid-base-url", "DeepSeek Harness base URL must be an absolute HTTP or HTTPS origin");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:")
    || url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash
  ) {
    throw new DeepSeekHarnessSettingsError(400, "invalid-base-url", "DeepSeek Harness base URL must be an absolute HTTP or HTTPS origin");
  }
  return url.origin;
}

export function parseDeepSeekHarnessConnectionPatch(value: z.input<typeof connectionPatchSchema>): DeepSeekHarnessConnectionPatch {
  const parsed = parseBounded(connectionPatchSchema, value, "invalid DeepSeek Harness connection settings");
  const patch: DeepSeekHarnessConnectionPatch = {};
  if (parsed.baseUrl !== undefined) patch.baseUrl = normalizeDeepSeekHarnessBaseUrl(parsed.baseUrl);
  if (parsed.transport !== undefined) patch.transport = parsed.transport;
  if (parsed.agentPreset !== undefined) patch.agentPreset = parsed.agentPreset;
  return patch;
}

export function parseDeepSeekHarnessPairRequest(value: z.input<typeof pairRequestSchema>): DeepSeekHarnessPairRequest {
  const parsed = parseBounded(pairRequestSchema, value, "invalid DeepSeek Harness pairing request");
  parsePairingLink(parsed.pairingLink);
  return parsed;
}

export function parseDeepSeekHarnessDiscoverRequest(value: z.input<typeof discoverRequestSchema>): DeepSeekHarnessDiscoverRequest {
  return parseBounded(discoverRequestSchema, value, "invalid DeepSeek Harness model discovery request");
}

export function parseDeepSeekHarnessUpsertRequest(value: z.input<typeof upsertRequestSchema>): DeepSeekHarnessUpsertRequest {
  return parseBounded(upsertRequestSchema, value, "invalid DeepSeek Harness model update request");
}

export async function acceptDeepSeekHarnessPairing(
  pairingLink: string,
  options: { timeoutMs?: number } = {},
): Promise<{ baseUrl: string; deviceCookie: string }> {
  const { baseUrl, token } = parsePairingLink(pairingLink);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), boundedTimeout(options.timeoutMs));
  timer.unref?.();
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/api/pair/accept`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ token }),
      redirect: "manual",
      signal: controller.signal,
    });
  } catch {
    throw new DeepSeekHarnessSettingsError(502, "pairing-unavailable", "DeepSeek Harness pairing could not reach the configured host");
  } finally {
    clearTimeout(timer);
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => {});
    throw new DeepSeekHarnessSettingsError(502, "pairing-redirect-refused", "DeepSeek Harness pairing refused an unexpected redirect");
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new DeepSeekHarnessSettingsError(400, "pairing-rejected", "DeepSeek Harness rejected the one-time pairing link");
  }
  try {
    return { baseUrl, deviceCookie: extractDeviceCookie(response.headers) };
  } finally {
    await response.body?.cancel().catch(() => {});
  }
}

export class DeepSeekHarnessManagementClient {
  private readonly config: DeepSeekHarnessConfig;
  private readonly direct: DshApiClient | undefined;
  private readonly timeoutMs: number;

  constructor(config: DeepSeekHarnessConfig, options: { timeoutMs?: number } = {}) {
    const baseUrl = normalizeDeepSeekHarnessBaseUrl(config.baseUrl);
    if (config.transport === "paired" && !deviceCookieSchema.safeParse(config.deviceCookie).success) {
      throw new DeepSeekHarnessSettingsError(400, "pairing-required", "DeepSeek Harness paired transport requires a paired device");
    }
    this.config = { ...config, baseUrl };
    this.timeoutMs = boundedTimeout(options.timeoutMs);
    if (config.transport === "direct") this.direct = new DshApiClient({ ...this.config, timeoutMs: this.timeoutMs });
  }

  close(): void {
    this.direct?.close();
  }

  async describe(): Promise<DeepSeekHarnessManagementDescription> {
    if (this.config.transport === "paired") return this.describePaired();
    try {
      await this.direct!.unary("host.describe", {});
      const eligible = await this.directProviders();
      return { available: true, supported: true, providers: eligible.map(({ provider, displayName }) => ({ provider, displayName })) };
    } catch (error) {
      throw settingsError(error, "DeepSeek Harness model management is unavailable");
    }
  }

  async discover(request: DeepSeekHarnessDiscoverRequest): Promise<{ models: DeepSeekHarnessModelProfile[] }> {
    const checked = parseDeepSeekHarnessDiscoverRequest(request);
    if (this.config.transport === "paired") {
      const response = await this.pairedRequest("/api/pair/model-catalog/discover", "POST", checked);
      if (response.status === 403 || response.status === 404) return this.pairedProviderUnavailable(checked.provider);
      requirePairedSuccess(response, "DeepSeek Harness paired model discovery failed");
      return parseResponse(candidatesValueSchema, response.body, "DeepSeek Harness returned an invalid model discovery response");
    }
    try {
      await this.directProvider(checked.provider);
      const result = await this.direct!.unary<DshJsonValue>("llm.discoverModels", { settingsNs: "llm-pi-ai", provider: checked.provider });
      return parseResponse(candidatesValueSchema, result.value, "DeepSeek Harness returned an invalid model discovery response");
    } catch (error) {
      throw settingsError(error, `DeepSeek Harness model discovery failed for provider ${checked.provider}`);
    }
  }

  async upsert(request: DeepSeekHarnessUpsertRequest): Promise<{ updated: true; catalog: DeepSeekHarnessPublicCatalog }> {
    const checked = parseDeepSeekHarnessUpsertRequest(request);
    if (this.config.transport === "paired") {
      const response = await this.pairedRequest("/api/pair/model-catalog/upsert", "POST", checked);
      if (response.status === 403 || response.status === 404) return this.pairedProviderUnavailable(checked.provider);
      requirePairedSuccess(response, "DeepSeek Harness paired model update failed");
      return { updated: true, catalog: publicCatalog(response.body) };
    }
    try {
      const eligible = await this.directProvider(checked.provider);
      const before = await this.directCatalog();
      const ops = modelMutationPlan(eligible.profile, checked.provider, checked.model, before);
      await this.direct!.unary<DshJsonValue>("settings.mutate", {
        ns: "llm-pi-ai",
        expectedRevision: eligible.revision,
        ops,
      });
      const after = await this.directCatalog();
      return { updated: true, catalog: after };
    } catch (error) {
      throw settingsError(error, `DeepSeek Harness model update failed for provider ${checked.provider}`);
    }
  }

  private async describePaired(): Promise<DeepSeekHarnessManagementDescription> {
    const response = await this.pairedRequest("/api/pair/model-catalog", "GET");
    if (response.status === 404) {
      return {
        available: false,
        supported: false,
        providers: [],
        reasonCode: "paired-plugin-update-required",
        reason: PAIRED_CATALOG_REASON,
      };
    }
    requirePairedSuccess(response, "DeepSeek Harness paired model management is unavailable");
    const parsed = parseResponse(pairedCatalogCapabilitySchema, response.body, "DeepSeek Harness returned an invalid paired model catalog response");
    return { available: true, supported: true, providers: parsed.providers };
  }

  private async pairedProviderUnavailable(provider: string): Promise<never> {
    const capability = await this.describePaired();
    if (!capability.available) throw pairedCapabilityUnavailable();
    throw new DeepSeekHarnessSettingsError(404, "provider-not-eligible", `DeepSeek Harness provider ${provider} is not available for paired model management`);
  }

  private async directProviders(): Promise<EligibleProvider[]> {
    const [providerResponse, settingsResponse] = await Promise.all([
      this.direct!.unary<DshJsonValue>("llm.providers", {}),
      this.direct!.unary<DshJsonValue>("settings.describe", {}),
    ]);
    const providers = parseResponse(providersValueSchema, providerResponse.value, "DeepSeek Harness returned an invalid provider directory");
    const settings = parseResponse(settingsValueSchema, settingsResponse.value, "DeepSeek Harness returned an invalid settings descriptor");
    if (!settings.writable) return [];
    const namespace = settings.namespaces.find((candidate) => candidate.ns === "llm-pi-ai");
    const root = namespace ? jsonObjectSchema.safeParse(namespace.value).data : undefined;
    const providerMap = root ? jsonObjectSchema.safeParse(root.providers).data : undefined;
    if (!namespace || !providerMap) return [];
    return providers.providers.flatMap((candidate) => {
      const profile = jsonObjectSchema.safeParse(providerMap[candidate.provider]).data;
      if (
        !candidate.active
        || candidate.settingsNs !== "llm-pi-ai"
        || candidate.settingsPath.length !== 2
        || candidate.settingsPath[0] !== "providers"
        || candidate.settingsPath[1] !== candidate.provider
        || !profile
      ) return [];
      return [{ provider: candidate.provider, displayName: candidate.displayName, profile, revision: namespace.revision }];
    });
  }

  private async directProvider(provider: string): Promise<EligibleProvider> {
    const eligible = (await this.directProviders()).find((candidate) => candidate.provider === provider);
    if (!eligible) throw new DeepSeekHarnessSettingsError(404, "provider-not-eligible", `DeepSeek Harness provider ${provider} is not an active configurable pi-ai provider`);
    return eligible;
  }

  private async directCatalog(): Promise<DeepSeekHarnessPublicCatalog> {
    const response = await this.direct!.unary<DshJsonValue>("llm.models", {});
    return publicCatalog(response.value);
  }

  private async pairedRequest(
    path: string,
    method: "GET" | "POST",
    body?: DeepSeekHarnessDiscoverRequest | DeepSeekHarnessUpsertRequest,
  ): Promise<{ status: number; body: DshJsonValue }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    try {
      let response: Response;
      try {
        const headers = new Headers({ accept: "application/json", Cookie: this.config.deviceCookie! });
        const request: RequestInit = {
          method,
          headers,
          redirect: "manual",
          signal: controller.signal,
        };
        if (body !== undefined) {
          headers.set("content-type", "application/json");
          request.body = JSON.stringify(body);
        }
        response = await fetch(`${this.config.baseUrl}${path}`, request);
      } catch {
        throw new DeepSeekHarnessSettingsError(502, "paired-host-unavailable", "DeepSeek Harness paired model management could not reach the configured host");
      }
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => {});
        throw new DeepSeekHarnessSettingsError(502, "paired-redirect-refused", "DeepSeek Harness paired model management refused an unexpected redirect");
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        return { status: response.status, body: null };
      }
      try {
        const text = await readBoundedText(response, MAX_RESPONSE_BYTES);
        const value = dshJsonValueSchema.safeParse(text ? JSON.parse(text) : null);
        if (!value.success) throw new Error("response is not JSON data");
        return { status: response.status, body: value.data };
      } catch {
        throw new DeepSeekHarnessSettingsError(502, "invalid-paired-response", "DeepSeek Harness returned an invalid paired model management response");
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

export function unavailableDeepSeekHarnessManagement(error: DeepSeekHarnessSettingsError): DeepSeekHarnessManagementDescription {
  if (error.code === "paired-device-unauthorized") {
    return {
      available: false,
      supported: true,
      providers: [],
      reasonCode: "paired-device-unauthorized",
      reason: "Pair this DeepSeek Harness again to restore model management.",
    };
  }
  return {
    available: false,
    supported: true,
    providers: [],
    reasonCode: "host-unavailable",
    reason: "DeepSeek Harness model management could not reach the configured host.",
  };
}

interface EligibleProvider {
  provider: string;
  displayName: string;
  profile: DshJsonObject;
  revision: number;
}

function parsePairingLink(value: string): ParsedPairingLink {
  const checked = z.string().trim().min(1).max(MAX_PAIRING_LINK_LENGTH).safeParse(value);
  if (!checked.success) {
    throw new DeepSeekHarnessSettingsError(400, "invalid-pairing-link", "DeepSeek Harness pairing link is invalid");
  }
  let url: URL;
  try {
    url = new URL(checked.data);
  } catch {
    throw new DeepSeekHarnessSettingsError(400, "invalid-pairing-link", "DeepSeek Harness pairing link is invalid");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.hash) {
    throw new DeepSeekHarnessSettingsError(400, "invalid-pairing-link", "DeepSeek Harness pairing link must use HTTP or HTTPS without credentials or a fragment");
  }
  const tokens = url.searchParams.getAll("pair");
  const token = tokens[0];
  if (tokens.length !== 1 || token === undefined || !safeString(MAX_PAIR_TOKEN_LENGTH).safeParse(token).success) {
    throw new DeepSeekHarnessSettingsError(400, "invalid-pairing-link", "DeepSeek Harness pairing link must contain one bounded pair token");
  }
  return { baseUrl: url.origin, token };
}

function extractDeviceCookie(headers: Headers): string {
  const separated = headers.getSetCookie();
  const raw = separated.length ? separated : splitSetCookie(headers.get("set-cookie") ?? "");
  const cookies = raw.flatMap((line) => {
    if (!/(?:^|;)\s*HttpOnly(?:;|$)/i.test(line)) return [];
    const pair = line.split(";", 1)[0]!.trim();
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+=[\x21-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]+$/.test(pair)) return [];
    return [pair];
  });
  const deviceCookie = cookies[0];
  if (cookies.length !== 1 || deviceCookie === undefined || deviceCookie.length > MAX_COOKIE_LENGTH) {
    throw new DeepSeekHarnessSettingsError(502, "invalid-device-cookie", "DeepSeek Harness pairing did not return one valid device cookie");
  }
  return deviceCookie;
}

function splitSetCookie(value: string): string[] {
  return value ? value.split(/,(?=\s*[!#$%&'*+.^_`|~0-9A-Za-z-]+=)/) : [];
}

function catalogGroup(catalog: DeepSeekHarnessPublicCatalog, provider: string): DeepSeekHarnessPublicCatalog["groups"][number] {
  const group = catalog.groups.find((candidate) => candidate.id === provider);
  if (!group || catalog.failures.some((failure) => failure.id === provider)) {
    throw new DeepSeekHarnessSettingsError(502, "catalog-unavailable", `DeepSeek Harness model catalog is unavailable for provider ${provider}`);
  }
  return group;
}

function explicitConfiguredModels(profile: DshJsonObject): DshJsonObject[] | null {
  if (!Object.hasOwn(profile, "models")) return null;
  const configured = jsonArraySchema.safeParse(profile.models);
  if (!configured.success) {
    throw new DeepSeekHarnessSettingsError(502, "invalid-configured-models", "DeepSeek Harness returned an invalid configured model list");
  }
  if (!configured.data.length) return null;
  return configured.data.map((entry) => {
    const model = jsonObjectSchema.safeParse(entry);
    const id = model.success ? providerIdSchema.safeParse(model.data.id) : undefined;
    if (!model.success || !id?.success || id.data !== model.data.id) {
      throw new DeepSeekHarnessSettingsError(502, "invalid-configured-models", "DeepSeek Harness returned an invalid configured model list");
    }
    return model.data;
  });
}

function configuredModelOverrides(profile: DshJsonObject): ConfiguredModelOverrides {
  if (!Object.hasOwn(profile, "modelOverrides")) return { present: false, values: new Map() };
  const configured = jsonObjectSchema.safeParse(profile.modelOverrides);
  if (!configured.success) {
    throw new DeepSeekHarnessSettingsError(502, "invalid-model-overrides", "DeepSeek Harness returned invalid model overrides");
  }
  const values = new Map<string, DshJsonObject>();
  for (const [id, value] of Object.entries(configured.data)) {
    const override = jsonObjectSchema.safeParse(value);
    const checkedId = providerIdSchema.safeParse(id);
    if (!checkedId.success || checkedId.data !== id || !override.success) {
      throw new DeepSeekHarnessSettingsError(502, "invalid-model-overrides", "DeepSeek Harness returned invalid model overrides");
    }
    values.set(id, override.data);
  }
  return { present: true, values };
}

function modelMutationPlan(
  profile: DshJsonObject,
  provider: string,
  model: DeepSeekHarnessModelProfile,
  catalog: DeepSeekHarnessPublicCatalog,
): SettingsMutationOp[] {
  const configured = explicitConfiguredModels(profile);
  const overrides = configuredModelOverrides(profile);
  const modelsPath = ["providers", provider, "models"];
  const overridesPath = ["providers", provider, "modelOverrides"];
  if (configured) {
    if (overrides.values.size) {
      throw new DeepSeekHarnessSettingsError(502, "conflicting-model-configuration", "DeepSeek Harness returned conflicting models and model overrides");
    }
    const ops: SettingsMutationOp[] = [{ op: "set", path: modelsPath, value: upsertModel(configured, model) }];
    if (overrides.present) ops.push({ op: "unset", path: overridesPath });
    return ops;
  }

  const group = catalogGroup(catalog, provider);
  if (group.models.some((candidate) => candidate.id === model.id)) {
    const existing = overrides.values.get(model.id) ?? {};
    return [{
      op: "set",
      path: [...overridesPath, model.id],
      value: { ...existing, ...modelFields(model, false) },
    }];
  }

  const materialized: DshJsonValue[] = [];
  const materializedIds = new Set<string>();
  for (const installed of group.models) {
    materialized.push({ ...overrides.values.get(installed.id), id: installed.id });
    materializedIds.add(installed.id);
  }
  for (const [id, override] of overrides.values) {
    if (materializedIds.has(id)) continue;
    materialized.push({ ...override, id });
  }
  const ops: SettingsMutationOp[] = [{ op: "set", path: modelsPath, value: upsertModel(materialized, model) }];
  if (overrides.present) ops.push({ op: "unset", path: overridesPath });
  return ops;
}

function upsertModel(existing: DshJsonValue[], model: DeepSeekHarnessModelProfile): DshJsonValue[] {
  const next = existing.map((entry) => jsonObjectSchema.safeParse(entry).data ?? entry);
  const patch = modelFields(model, true);
  const index = next.findIndex((entry) => jsonObjectSchema.safeParse(entry).data?.id === model.id);
  if (index === -1) next.push(patch);
  else next[index] = { ...jsonObjectSchema.parse(next[index]), ...patch };
  return next;
}

function modelFields(model: DeepSeekHarnessModelProfile, includeId: boolean): DshJsonObject {
  const fields: DshJsonObject = {};
  if (includeId) fields.id = model.id;
  if (model.name !== undefined) fields.name = model.name;
  if (model.contextWindow !== undefined) fields.contextWindow = model.contextWindow;
  if (model.maxTokens !== undefined) fields.maxTokens = model.maxTokens;
  if (model.reasoningEfforts !== undefined) {
    fields.reasoningEfforts = Object.fromEntries(model.reasoningEfforts.map((effort) => [effort, effort === "off" ? null : effort]));
  }
  return fields;
}

function publicCatalog(value: DshJsonValue): DeepSeekHarnessPublicCatalog {
  const parsed = parseResponse(catalogSchema, value, "DeepSeek Harness returned an invalid model catalog");
  return {
    groups: parsed.groups.map((group) => ({
      id: group.id,
      name: group.name,
      models: group.models.map((model) => {
        const publicModel: DeepSeekHarnessPublicCatalog["groups"][number]["models"][number] = { id: model.id, name: model.name };
        if (model.description !== undefined) publicModel.description = model.description;
        if (model.reasoning !== undefined) publicModel.reasoning = model.reasoning;
        return publicModel;
      }),
    })),
    failures: parsed.failures.map((failure) => ({
      id: failure.id,
      name: failure.name,
      message: `model catalog unavailable for provider ${failure.id}`,
    })),
  };
}

function requirePairedSuccess(response: { status: number }, message: string): void {
  if (response.status >= 200 && response.status < 300) return;
  if (response.status === 401 || response.status === 403) {
    throw new DeepSeekHarnessSettingsError(403, "paired-device-unauthorized", "DeepSeek Harness paired device is no longer authorized");
  }
  if (response.status === 409) throw new DeepSeekHarnessSettingsError(409, "model-update-conflict", "DeepSeek Harness model update conflicted with another settings change");
  if (response.status === 422) throw new DeepSeekHarnessSettingsError(422, "model-update-rejected", "DeepSeek Harness rejected the model update");
  throw new DeepSeekHarnessSettingsError(502, "paired-model-management-failed", message);
}

function pairedCapabilityUnavailable(): DeepSeekHarnessSettingsError {
  return new DeepSeekHarnessSettingsError(409, "paired-model-catalog-unavailable", PAIRED_CATALOG_REASON);
}

function settingsError(cause: unknown, message: string): DeepSeekHarnessSettingsError {
  if (cause instanceof DeepSeekHarnessSettingsError) return cause;
  if (cause instanceof DshRpcError) {
    if (cause.code === "settings-conflict") return new DeepSeekHarnessSettingsError(409, "model-update-conflict", "DeepSeek Harness model update conflicted with another settings change");
    if (cause.code === "settings-rejected") return new DeepSeekHarnessSettingsError(422, "model-update-rejected", "DeepSeek Harness rejected the model update");
  }
  return new DeepSeekHarnessSettingsError(502, "dsh-management-failed", message);
}

function parseBounded<T extends z.ZodType>(schema: T, value: z.input<T>, message: string): z.output<T> {
  let bytes: number;
  try { bytes = Buffer.byteLength(JSON.stringify(value)); } catch { bytes = MAX_BODY_BYTES + 1; }
  const parsed = bytes <= MAX_BODY_BYTES ? schema.safeParse(value) : { success: false } as const;
  if (!parsed.success) throw new DeepSeekHarnessSettingsError(bytes > MAX_BODY_BYTES ? 413 : 400, "invalid-request", message);
  return parsed.data;
}

function parseResponse<T extends z.ZodType>(schema: T, value: DshJsonValue, message: string): z.output<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new DeepSeekHarnessSettingsError(502, "invalid-dsh-response", message);
  return parsed.data;
}

function boundedTimeout(value: number | undefined): number {
  return z.number().int().safe().positive().max(60_000).safeParse(value).data ?? DEFAULT_TIMEOUT_MS;
}

async function readBoundedText(response: Response, limit: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    bytes += next.value.byteLength;
    if (bytes > limit) {
      await reader.cancel().catch(() => {});
      throw new Error("response too large");
    }
    chunks.push(next.value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}
