import { z } from "zod";
import { holdsCredential } from "../../shared/redact.ts";
import { isSecretName } from "../redact.ts";

export const RUNTIME_HEADER_VARIABLES = ["threadId", "botId", "turnId", "providerInstanceId"] as const;
export type RuntimeHeaderVariable = (typeof RUNTIME_HEADER_VARIABLES)[number];

export interface RuntimeHeaderContext {
  threadId?: string;
  botId?: string;
  turnId?: string;
  providerInstanceId?: string;
}

export interface OpenAICompatCustomHeaderRule {
  name: string;
  value: string;
  required: boolean;
  secret: boolean;
}

export interface OpenAICompatCustomHeadersConfig {
  enabled: boolean;
  headers: OpenAICompatCustomHeaderRule[];
}

export interface OpenAICompatCustomHeaderSummary {
  name: string;
  value?: string;
  configured: boolean;
  required: boolean;
  secret: boolean;
}

export interface OpenAICompatCustomHeadersSummary {
  enabled: boolean;
  headers: OpenAICompatCustomHeaderSummary[];
}

export class CustomHeaderValidationError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "CustomHeaderValidationError";
  }
}

export class CustomHeaderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CustomHeaderError";
  }
}

const MIN_MASKABLE_SECRET_LENGTH = 8;
const MAX_CUSTOM_HEADERS = 32;
const MAX_HEADER_NAME_LENGTH = 128;
const MAX_HEADER_VALUE_LENGTH = 2048;
const HEADER_TOKEN_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const CONTROL_CHARS = /\p{Cc}/u;
const hasNonByteChar = (value: string): boolean => {
  for (let i = 0; i < value.length; i++) if (value.charCodeAt(i) > 0xff) return true;
  return false;
};
const PLACEHOLDER_RE = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const PLACEHOLDER_TEST = /\{[A-Za-z_][A-Za-z0-9_]*\}/;
const KNOWN_VARS = new Set<string>(RUNTIME_HEADER_VARIABLES);
const PROTECTED_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "content-type",
  "content-length",
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "cookie",
  "set-cookie",
  "origin",
  "referer",
  "accept-encoding",
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isSensitiveHeader(rule: Pick<OpenAICompatCustomHeaderRule, "name" | "value" | "secret">): boolean {
  return rule.secret === true || isSecretName(rule.name) || holdsCredential(rule.value);
}

function validateHeaderName(raw: unknown): string {
  if (typeof raw !== "string") throw new CustomHeaderValidationError("Header name must be a string.");
  const name = raw.trim();
  if (!name || name.length > MAX_HEADER_NAME_LENGTH || CONTROL_CHARS.test(name) || !HEADER_TOKEN_NAME.test(name)) {
    throw new CustomHeaderValidationError(`Invalid HTTP header name "${name || raw}".`);
  }
  if (PROTECTED_HEADERS.has(name.toLowerCase())) {
    throw new CustomHeaderValidationError(`Header "${name}" is protected and cannot be overridden.`);
  }
  return name;
}

function validateHeaderValue(raw: unknown, name: string): string {
  if (typeof raw !== "string") throw new CustomHeaderValidationError(`Header "${name}" value must be a string.`);
  if (CONTROL_CHARS.test(raw) || hasNonByteChar(raw)) {
    throw new CustomHeaderValidationError(`Header "${name}" value cannot contain CR, LF, control characters, or characters above U+00FF.`);
  }
  const value = raw.trim();
  if (!value) throw new CustomHeaderValidationError(`Header "${name}" value cannot be empty.`);
  if (value.length > MAX_HEADER_VALUE_LENGTH) {
    throw new CustomHeaderValidationError(`Header "${name}" value exceeds ${MAX_HEADER_VALUE_LENGTH} characters.`);
  }
  for (const match of value.matchAll(PLACEHOLDER_RE)) {
    if (!KNOWN_VARS.has(match[1]!)) {
      throw new CustomHeaderValidationError(
        `Header "${name}" references unknown runtime variable "{${match[1]}}". Supported: ${RUNTIME_HEADER_VARIABLES.map((v) => `{${v}}`).join(", ")}.`,
      );
    }
  }
  return value;
}

function normalizeEntries(rawHeaders: unknown): Array<Record<string, unknown>> {
  if (rawHeaders === undefined) return [];
  if (Array.isArray(rawHeaders)) {
    if (rawHeaders.length > MAX_CUSTOM_HEADERS) {
      throw new CustomHeaderValidationError(`Use at most ${MAX_CUSTOM_HEADERS} custom headers.`);
    }
    return rawHeaders.map((entry) => {
      if (!isPlainRecord(entry)) throw new CustomHeaderValidationError("Each custom header must be an object.");
      return entry;
    });
  }
  if (isPlainRecord(rawHeaders)) {
    const entries = Object.entries(rawHeaders);
    if (entries.length > MAX_CUSTOM_HEADERS) {
      throw new CustomHeaderValidationError(`Use at most ${MAX_CUSTOM_HEADERS} custom headers.`);
    }
    return entries.map(([name, value]) => ({ name, value }));
  }
  throw new CustomHeaderValidationError("customHeaders.headers must be an array or object map.");
}

export function decodeCustomHeaders(raw: unknown): OpenAICompatCustomHeadersConfig {
  if (!isPlainRecord(raw)) throw new CustomHeaderValidationError("customHeaders must be an object.");
  if (typeof raw.enabled !== "boolean") throw new CustomHeaderValidationError("customHeaders.enabled must be a boolean.");
  const seen = new Set<string>();
  const headers: OpenAICompatCustomHeaderRule[] = [];
  for (const entry of normalizeEntries(raw.headers)) {
    const name = validateHeaderName(entry.name);
    const lower = name.toLowerCase();
    if (seen.has(lower)) throw new CustomHeaderValidationError(`Duplicate custom header name "${name}".`);
    seen.add(lower);
    if (entry.required !== undefined && typeof entry.required !== "boolean") {
      throw new CustomHeaderValidationError(`Header "${name}" required flag must be a boolean.`);
    }
    if (entry.secret !== undefined && typeof entry.secret !== "boolean") {
      throw new CustomHeaderValidationError(`Header "${name}" secret flag must be a boolean.`);
    }
    const value = validateHeaderValue(entry.value, name);
    const rule: OpenAICompatCustomHeaderRule = {
      name,
      value,
      required: entry.required !== false,
      secret: entry.secret === true || isSecretName(name) || holdsCredential(value),
    };
    headers.push(rule);
  }
  return { enabled: raw.enabled, headers };
}

export function mergeCustomHeadersPatch(
  patch: unknown,
  previous?: unknown,
): OpenAICompatCustomHeadersConfig {
  if (!isPlainRecord(patch)) throw new CustomHeaderValidationError("customHeaders must be an object.");
  if (typeof patch.enabled !== "boolean") throw new CustomHeaderValidationError("customHeaders.enabled must be a boolean.");
  const priorHeaders = previous === undefined ? [] : decodeCustomHeaders(previous).headers;
  const prevByName = new Map(priorHeaders.map((entry) => [entry.name.toLowerCase(), entry]));
  const rawEntries = normalizeEntries(patch.headers);
  const resolved = rawEntries.map((entry) => {
    const name = validateHeaderName(entry.name);
    const keepExisting = entry.keepExisting === true || (entry.value === undefined && entry.secret === true);
    if (keepExisting && (entry.value === undefined || entry.value === "")) {
      const prior = prevByName.get(name.toLowerCase());
      if (!prior) {
        throw new CustomHeaderValidationError(`Header "${name}" has no saved secret value to keep; enter a value.`);
      }
      if (isSensitiveHeader(prior) && entry.secret === false) {
        throw new CustomHeaderValidationError(
          `Header "${name}" has a saved secret value; enter a new value to mark it non-secret.`,
        );
      }
      return {
        name,
        value: prior.value,
        required: entry.required ?? prior.required,
        secret: entry.secret ?? prior.secret,
      };
    }
    return {
      name,
      value: entry.value,
      ...(entry.required !== undefined ? { required: entry.required } : {}),
      ...(entry.secret !== undefined ? { secret: entry.secret } : {}),
    };
  });
  return decodeCustomHeaders({ enabled: patch.enabled, headers: resolved });
}

export function summarizeCustomHeaders(raw: unknown): OpenAICompatCustomHeadersSummary | undefined {
  let decoded: OpenAICompatCustomHeadersConfig;
  try {
    decoded = decodeCustomHeaders(raw);
  } catch {
    return undefined;
  }
  return {
    enabled: decoded.enabled,
    headers: decoded.headers.map((rule) => {
      const sensitive = isSensitiveHeader(rule);
      return {
        name: rule.name,
        ...(sensitive ? {} : { value: rule.value }),
        configured: true,
        required: rule.required,
        secret: sensitive,
      };
    }),
  };
}

export function resolveCustomHeaders(
  config: OpenAICompatCustomHeadersConfig | undefined,
  context: RuntimeHeaderContext,
): Record<string, string> {
  if (!config?.enabled || config.headers.length === 0) return {};
  const resolved: Record<string, string> = {};
  for (const rule of config.headers) {
    let missingVar: string | null = null;
    const value = rule.value.replace(PLACEHOLDER_RE, (_whole, key: string) => {
      const raw = context[key as RuntimeHeaderVariable];
      const text = typeof raw === "string" ? raw.trim() : "";
      if (!text) {
        missingVar ??= key;
        return "";
      }
      return text;
    });
    if (missingVar) {
      if (rule.required !== false) {
        throw new CustomHeaderError(
          `Cannot send required custom header "${rule.name}": runtime variable "{${missingVar}}" is unavailable for this request.`,
        );
      }
      continue;
    }
    if (CONTROL_CHARS.test(value) || hasNonByteChar(value)) {
      throw new CustomHeaderError(`Cannot send custom header "${rule.name}": resolved value contains unsafe control characters or characters above U+00FF.`);
    }
    resolved[rule.name] = value;
  }
  return resolved;
}

export function customHeaderSecrets(
  config: OpenAICompatCustomHeadersConfig | undefined,
  context: RuntimeHeaderContext,
): string[] {
  if (!config?.enabled || config.headers.length === 0) return [];
  const out = new Set<string>();
  for (const rule of config.headers) {
    if (!isSensitiveHeader(rule)) continue;
    if (!PLACEHOLDER_TEST.test(rule.value) && rule.value.length >= MIN_MASKABLE_SECRET_LENGTH) {
      out.add(rule.value);
    }
    try {
      const one = resolveCustomHeaders({ enabled: true, headers: [rule] }, context)[rule.name];
      if (one && one.length >= MIN_MASKABLE_SECRET_LENGTH) out.add(one);
    } catch {
      // Missing optional/required runtime var here simply has no resolved secret to register.
    }
  }
  return [...out];
}

export function maskCustomSecrets(text: string, secrets: readonly string[]): string {
  let masked = text;
  for (const secret of secrets) if (secret) masked = masked.split(secret).join("[redacted]");
  return masked;
}

export function scrubErrorSecrets(error: unknown, secrets: readonly string[]): unknown {
  if (secrets.length === 0) return error;
  if (typeof error === "string") return maskCustomSecrets(error, secrets);
  if (!(error instanceof Error)) return error;
  const masked = maskCustomSecrets(error.message, secrets);
  if (masked === error.message) return error;
  try {
    error.message = masked;
    return error;
  } catch {
    return new Error(masked, { cause: error });
  }
}

export function stripSensitiveCustomHeaders(raw: unknown): OpenAICompatCustomHeadersConfig | undefined {
  let decoded: OpenAICompatCustomHeadersConfig;
  try {
    decoded = decodeCustomHeaders(raw);
  } catch {
    return undefined;
  }
  const kept = decoded.headers.filter((rule) => !isSensitiveHeader(rule));
  return kept.length ? { enabled: decoded.enabled, headers: kept } : undefined;
}

export function applyOpenAiCompatHeaderDefaults(
  merged: Record<string, unknown>,
  defaults: OpenAICompatCustomHeadersConfig | undefined,
): void {
  if (defaults && merged.customHeaders === undefined) {
    merged.customHeaders = defaults;
  }
}

export const openAiCompatConfigHeadersSchema: z.ZodType<OpenAICompatCustomHeadersConfig> = z.unknown().transform((val, ctx) => {
  try {
    return decodeCustomHeaders(val);
  } catch (error) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: error instanceof Error ? error.message : String(error) });
    return z.NEVER;
  }
});

const patchEntrySchema = z.object({
  name: z.string(),
  value: z.string().optional(),
  keepExisting: z.boolean().optional(),
  required: z.boolean().optional(),
  secret: z.boolean().optional(),
}).strict();

export const customHeadersPatchSchema = z.object({
  enabled: z.boolean(),
  headers: z.union([z.array(patchEntrySchema).max(MAX_CUSTOM_HEADERS), z.record(z.string(), z.string())]).default([]),
}).strict();
