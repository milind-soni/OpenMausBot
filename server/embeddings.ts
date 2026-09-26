// Embedding seam for the skills lane (slice R1). One interface, one concrete
// provider: an OpenAI-compatible POST /embeddings against a connection the
// app already has configured. The hard contract is that every failure —
// missing key, unreachable endpoint, timeout, provider error, malformed
// response — throws to the caller, which owns the fallback. Nothing in this
// slice is wired into the turn path; later slices call it from their own
// surfaces and keep their own policy. Local embedding models stay out: they
// surface through local-inject, which already filters embed/bge/nomic ids
// out of chat model lists, and no second key store exists here — resolution
// reads the same config.json surfaces and env fallbacks the chat drivers do.
import type { AppConfig } from "./config.ts";
import type { InstanceConfigMap } from "./contracts.ts";
import { OpenAICompatDriver } from "./drivers/openai-compat.ts";

/** The seam later slices program against: texts in, one vector per text out. */
export interface EmbeddingProvider {
  readonly model: string;
  embed(texts: string[]): Promise<number[][]>;
}

/** Which configured connection an embedding model rides:
 * - "openaiCompat" — the app-level OpenAI-compatible connection
 *   (config.json `openaiCompat`, with the OPENAI_COMPAT_* env fallbacks).
 * - { instance } — a configured provider instance whose driver speaks the
 *   OpenAI-compatible contract. Hosted gateway instances qualify because
 *   hosted-models builds them as openai-compat entries, so an operator
 *   workspace rides this same path without a second resolution rule. */
export type EmbeddingSource = "openaiCompat" | { instance: string };

/** App-level embedding configuration: which model, which connection. */
export interface EmbeddingConfig {
  model: string;
  source: EmbeddingSource;
}

/** A resolved connection: where to call, with which key. Never persisted. */
export interface EmbeddingEndpoint {
  url: string;
  apiKey: string;
}

/** What resolution reads: the stored app config, the runtime instance map,
 * and the process environment. All optional so tests inject fakes. */
export interface EmbeddingSourceInput {
  appConfig?: Pick<AppConfig, "openaiCompat">;
  instances?: InstanceConfigMap;
  env?: Record<string, string | undefined>;
}

const DEFAULT_OPENAI_COMPAT_URL = "https://openrouter.ai/api/v1";

/** Resolve a source to a concrete endpoint, or throw. The fallback order
 * mirrors the openai-compat driver's own: stored config first, then the
 * instance environment, then the process environment. */
export function resolveEmbeddingEndpoint(source: EmbeddingSource, input: EmbeddingSourceInput = {}): EmbeddingEndpoint {
  const env = input.env ?? process.env;
  if (source === "openaiCompat") {
    const url = (input.appConfig?.openaiCompat?.url || env.OPENAI_COMPAT_URL || DEFAULT_OPENAI_COMPAT_URL)
      .replace(/\/+$/, "");
    const apiKey = input.appConfig?.openaiCompat?.key || env.OPENAI_COMPAT_API_KEY || "";
    if (!apiKey) throw new Error("No OpenAI-compatible API key is configured for embeddings.");
    return { url, apiKey };
  }
  const entry = input.instances?.[source.instance];
  if (!entry) throw new Error(`No provider instance named "${source.instance}" is configured.`);
  if (entry.driver !== "openai-compat") {
    throw new Error(`Provider instance "${source.instance}" (${entry.driver}) does not speak the OpenAI-compatible contract.`);
  }
  // decodeConfig is the driver's own normalization: default URL, env URL
  // fallback, trailing-slash trim, apiKeyEnv default. Reusing it here keeps
  // one definition of what an openai-compat connection is.
  const decoded = OpenAICompatDriver.decodeConfig(entry.config);
  const apiKey = decoded.key
    ?? entry.environment?.[decoded.apiKeyEnv]
    ?? entry.environment?.OPENAI_COMPAT_API_KEY
    ?? env[decoded.apiKeyEnv]
    ?? env.OPENAI_COMPAT_API_KEY
    ?? "";
  if (!apiKey) throw new Error(`No API key is configured for provider instance "${source.instance}".`);
  return { url: decoded.url.replace(/\/+$/, ""), apiKey };
}

/** One request stays a bounded, retryable unit: a small batch of texts,
 * none of them book-length. Callers chunk on their own policy. */
const MAX_TEXTS_PER_REQUEST = 128;
const MAX_TEXT_CHARS = 32_768;
const DEFAULT_EMBEDDING_TIMEOUT_MS = 30_000;

function isLoopback(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host.startsWith("127.");
}

function embeddingsUrl(base: string): URL {
  let url: URL;
  try {
    url = new URL(`${base.replace(/\/+$/, "")}/embeddings`);
  } catch {
    throw new Error(`The embedding endpoint address "${base}" is not a valid URL.`);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
    throw new Error("Embedding keys travel only over HTTPS (except to a loopback test double).");
  }
  return url;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export interface EmbeddingOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** The one concrete provider: OpenAI-compatible /embeddings. Any failure
 * throws; there is no retry and no silent fallback in here. */
export function openAICompatEmbedder(
  endpoint: EmbeddingEndpoint,
  config: { model: string },
  options: EmbeddingOptions = {},
): EmbeddingProvider {
  const model = config.model.trim();
  if (!model) throw new Error("An embedding model id is required.");
  const url = embeddingsUrl(endpoint.url);
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_EMBEDDING_TIMEOUT_MS;
  return {
    model,
    async embed(texts: string[]): Promise<number[][]> {
      if (!Array.isArray(texts) || !texts.length) throw new Error("Embedding requires at least one text.");
      if (texts.length > MAX_TEXTS_PER_REQUEST) {
        throw new Error(`Embedding accepts at most ${MAX_TEXTS_PER_REQUEST} texts per request; got ${texts.length}.`);
      }
      for (const text of texts) {
        if (typeof text !== "string" || !text.trim()) throw new Error("Every text sent for embedding must be a non-empty string.");
        if (text.length > MAX_TEXT_CHARS) {
          throw new Error(`A text sent for embedding exceeds the ${MAX_TEXT_CHARS.toLocaleString("en-US")}-character cap.`);
        }
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        // redirect: "manual" — a key must never be replayed to whichever
        // host the provider's front door points at today.
        const response = await fetchImpl(url, {
          method: "POST",
          headers: { authorization: `Bearer ${endpoint.apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({ model, input: texts }),
          signal: controller.signal,
          redirect: "manual",
        });
        if (!response.ok) {
          const body = await response.text().catch(() => "");
          throw new Error(`The embedding request failed: HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
        }
        const body: unknown = await response.json().catch(() => null);
        const rows = body && typeof body === "object" ? (body as { data?: unknown }).data : null;
        if (!Array.isArray(rows) || rows.length !== texts.length) {
          throw new Error(
            `The embedding provider returned ${Array.isArray(rows) ? rows.length : "no"} vectors for ${texts.length} texts.`,
          );
        }
        const vectors: number[][] = [];
        for (const row of rows) {
          const vector = row && typeof row === "object" ? (row as { embedding?: unknown }).embedding : null;
          if (!Array.isArray(vector) || !vector.length || !vector.every(isFiniteNumber)) {
            throw new Error("The embedding provider returned a malformed vector.");
          }
          vectors.push(vector);
        }
        return vectors;
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          throw new Error(`The embedding request to ${url.host} timed out after ${timeoutMs}ms.`);
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export interface EmbeddingDeps extends EmbeddingSourceInput, EmbeddingOptions {}

/** Resolve the configured connection, then build the provider. */
export function createEmbeddingProvider(config: EmbeddingConfig, deps: EmbeddingDeps = {}): EmbeddingProvider {
  const endpoint = resolveEmbeddingEndpoint(config.source, deps);
  return openAICompatEmbedder(endpoint, config, deps);
}
