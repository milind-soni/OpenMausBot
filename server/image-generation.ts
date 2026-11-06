import type { ReadableStreamReadResult } from "node:stream/web";
import { z } from "zod";

import { IMAGE_DEFAULT_MODELS, IMAGE_PROVIDERS, looksLikeApiKey, normalizeImageGenerationUrl, type ImageGenerationConfig, type ImageProvider } from "../shared/image-generation.ts";
import { decodeGeneratedImage } from "./generated-image.ts";

export const IMAGE_GENERATION_TIMEOUT_MS = 120_000;
const MAX_UPSTREAM_RESPONSE_BYTES = 15 * 1024 * 1024;

const imagesApiResponseSchema = z.object({
  // OpenAI-compatible gateways (DeepInfra and others) send unused fields such as url as null.
  data: z.array(z.object({ b64_json: z.string().min(1).nullish() })).min(1),
});

export interface ImageCredentials {
  imageGen?: ImageGenerationConfig;
  xai?: { key?: string };
  openrouter?: { key?: string };
}

export interface ImageSlot {
  provider: ImageProvider;
  model: string;
}

export type ImageAspect = "1:1" | "16:9" | "9:16";

export interface ImageRequest {
  prompt: string;
  aspect?: ImageAspect;
  draft?: boolean;
}

export interface GeneratedImage {
  bytes: Buffer;
  mime: "image/png" | "image/jpeg" | "image/webp";
}

export interface GeneratedSlotImage extends GeneratedImage, ImageSlot {
  usedFallback: boolean;
  /** Why the base did not make it, when the backup did. */
  baseError?: string;
}

const OPENAI_SIZES: Record<ImageAspect, string> = { "1:1": "1024x1024", "16:9": "1536x1024", "9:16": "1024x1536" };

const PROVIDERS: Record<ImageProvider, {
  name: string;
  missing: string;
  key: (cfg: ImageCredentials) => string | undefined;
  url: (cfg: ImageCredentials) => string;
  body: (request: ImageRequest) => Record<string, unknown>;
}> = {
  openai: {
    name: "OpenAI",
    missing: "Add an OpenAI image API key first",
    key: (cfg) => cfg.imageGen?.key,
    url: () => "https://api.openai.com/v1/images/generations",
    body: (request) => ({ size: OPENAI_SIZES[request.aspect ?? "1:1"], quality: request.draft ? "low" : "auto", output_format: "webp" }),
  },
  xai: {
    name: "xAI",
    missing: "Add an xAI API key first",
    key: (cfg) => cfg.xai?.key,
    url: () => "https://api.x.ai/v1/images/generations",
    body: (request) => ({ response_format: "b64_json", aspect_ratio: request.aspect ?? "1:1" }),
  },
  gemini: {
    name: "Gemini",
    missing: "Add a Gemini API key first",
    key: (cfg) => cfg.imageGen?.geminiKey,
    // Google's OpenAI-compatible route; the native API has no stable Images shape.
    url: () => "https://generativelanguage.googleapis.com/v1beta/openai/images/generations",
    body: (request) => ({ response_format: "b64_json", size: OPENAI_SIZES[request.aspect ?? "1:1"], n: 1 }),
  },
  openrouter: {
    name: "OpenRouter",
    missing: "Add an OpenRouter API key first",
    key: (cfg) => cfg.openrouter?.key,
    url: () => "https://openrouter.ai/api/v1/images",
    body: (request) => ({ aspect_ratio: request.aspect ?? "1:1" }),
  },
  custom: {
    name: "Custom",
    missing: "Set a valid custom image API URL and model first",
    key: (cfg) => cfg.imageGen?.customApiKey,
    url: (cfg) => `${customImageUrl(cfg)}/images/generations`,
    body: (request) => ({ response_format: "b64_json", size: OPENAI_SIZES[request.aspect ?? "1:1"], n: 1 }),
  },
};

export function imageProviderName(provider: ImageProvider): string {
  return PROVIDERS[provider].name;
}

export function imageProviderKey(cfg: ImageCredentials, provider: ImageProvider): string {
  return PROVIDERS[provider].key(cfg)?.trim() ?? "";
}

const UNREACHED_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH"]);
/** Answers that refuse before any work: no access, no credit, or rate limited. */
const NOT_STARTED_STATUSES = new Set([401, 402, 403, 429]);

function fail(message: string, status: number, neverStarted = false): never {
  throw Object.assign(new Error(message), { status, neverStarted });
}

export function shouldUseFallback(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { neverStarted?: unknown }).neverStarted === true);
}

export function customImageUrl(cfg: ImageCredentials): string {
  try {
    if (cfg.imageGen?.customUrl?.trim()) return normalizeImageGenerationUrl(cfg.imageGen.customUrl);
  } catch {
    // A manually edited invalid URL must not become an outbound request.
  }
  return "";
}

export function imageSlots(cfg: ImageCredentials): { primary: ImageSlot; fallback: ImageSlot | null } {
  // A key saved as a model before saves were checked is never sent or shown: the slot acts as if no model was typed.
  const keys = new Set(IMAGE_PROVIDERS.map((provider) => imageProviderKey(cfg, provider)).filter(Boolean));
  const usable = (model?: string) => {
    const id = model?.trim() ?? "";
    return id && !keys.has(id) && !looksLikeApiKey(id) ? id : "";
  };
  // Custom has no default model, so a Custom slot saved without one uses the last model typed for Custom.
  const resolveSlot = (provider: ImageProvider, model?: string): ImageSlot => ({
    provider,
    model: usable(model) || (provider === "custom" ? usable(cfg.imageGen?.customModel) : "") || IMAGE_DEFAULT_MODELS[provider],
  });
  const saved = cfg.imageGen?.primary;
  const primary = saved ? resolveSlot(saved.provider, saved.model) : resolveSlot(cfg.imageGen?.provider ?? "openai");
  const backup = cfg.imageGen?.fallback;
  const fallback = backup ? resolveSlot(backup.provider, backup.model) : null;
  const same = fallback && fallback.provider === primary.provider && fallback.model === primary.model;
  return { primary, fallback: same ? null : fallback };
}

export function primaryImageSlot(cfg: ImageCredentials): ImageSlot {
  return imageSlots(cfg).primary;
}

export function imageSlotConfigured(cfg: ImageCredentials, slot: ImageSlot): boolean {
  if (slot.provider === "custom") return Boolean(customImageUrl(cfg) && slot.model);
  return Boolean(PROVIDERS[slot.provider].key(cfg)?.trim() && slot.model);
}

export function imageGenerationReady(cfg: ImageCredentials): boolean {
  const { primary, fallback } = imageSlots(cfg);
  return imageSlotConfigured(cfg, primary) || Boolean(fallback && imageSlotConfigured(cfg, fallback));
}

/** The image API returns base64 JSON, so a byte cap on the untrusted body is the real memory boundary. */
async function boundedResponseText(response: Response): Promise<string> {
  const advertised = Number(response.headers.get("content-length"));
  if (Number.isFinite(advertised) && advertised > MAX_UPSTREAM_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {});
    fail("Generated image exceeded the response limit", 502);
  }
  const reader = response.body?.getReader();
  if (!reader) return "";

  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let received = 0;
  try {
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch {
        fail("Could not read the generated image response", 502);
      }
      const { done, value } = chunk;
      if (done) break;
      received += value.byteLength;
      if (received > MAX_UPSTREAM_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        fail("Generated image exceeded the response limit", 502);
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join("");
  } finally {
    reader.releaseLock();
  }
}

function unreached(error: unknown): boolean {
  const code = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  return typeof code === "string" && UNREACHED_CODES.has(code);
}

export async function generateImageWith(
  cfg: ImageCredentials,
  slot: ImageSlot,
  request: ImageRequest,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = IMAGE_GENERATION_TIMEOUT_MS,
  cancel?: AbortSignal,
): Promise<GeneratedImage> {
  const provider = PROVIDERS[slot.provider];
  if (!imageSlotConfigured(cfg, slot)) fail(provider.missing, 409, true);

  const apiKey = provider.key(cfg)?.trim();
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const body = { model: slot.model, prompt: request.prompt, ...provider.body(request) };

  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const cancelled = () => cancel?.aborted === true && !timeoutSignal.aborted;
  let response: Response;
  try {
    response = await fetchImpl(provider.url(cfg), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      redirect: "error",
      signal: cancel ? AbortSignal.any([timeoutSignal, cancel]) : timeoutSignal,
    });
  } catch (error) {
    if (cancelled()) fail("Image generation was cancelled", 409);
    const timedOut = timeoutSignal.aborted || (error instanceof Error && error.name === "TimeoutError");
    if (timedOut) fail("Image generation timed out", 502);
    fail(`Could not reach ${provider.name} image generation`, 502, unreached(error));
  }

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    // Upstream errors can repeat authorization headers or signed URLs: return only the provider and status, never the body.
    fail(`${provider.name} image generation failed (HTTP ${response.status}, model ${slot.model})`, response.status === 401 ? 401 : 502,
      NOT_STARTED_STATUSES.has(response.status));
  }

  let text: string;
  try {
    text = await boundedResponseText(response);
  } catch (error) {
    if (cancelled()) fail("Image generation was cancelled", 409);
    // When the timeout aborts the body after headers, undici may surface TimeoutError or AbortError; the signal decides.
    if (timeoutSignal.aborted || (error instanceof Error && error.name === "TimeoutError")) {
      fail("Image generation timed out", 502);
    }
    throw error;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(text);
  } catch {
    fail(`${provider.name} returned an invalid image response`, 502);
  }
  const parsed = imagesApiResponseSchema.safeParse(parsedJson);
  if (!parsed.success) fail(`${provider.name} returned no generated image`, 502);
  const encoded = parsed.data.data[0]!.b64_json;
  if (!encoded) {
    // Never fetch a URL a provider returns; compatible gateways must answer with inline b64_json.
    fail(`${provider.name} image generation must return base64 image data (b64_json)`, 502);
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
    fail(`${provider.name} returned invalid image data`, 502);
  }
  try {
    const image = decodeGeneratedImage(encoded);
    if (image.mime === "image/gif") throw new Error("unsupported image format");
    return { bytes: image.bytes, mime: image.mime };
  } catch {
    fail(`${provider.name} returned invalid or oversized image data; expected PNG, JPEG, or WebP`, 502);
  }
}

export async function generateImage(
  cfg: ImageCredentials,
  request: ImageRequest,
  options: { slot?: "primary" | "fallback"; fetchImpl?: typeof fetch; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<GeneratedSlotImage> {
  const { primary, fallback } = imageSlots(cfg);
  const attempt = async (slot: ImageSlot, usedFallback: boolean): Promise<GeneratedSlotImage> => ({
    ...await generateImageWith(cfg, slot, request, options.fetchImpl, options.timeoutMs, options.signal),
    ...slot,
    usedFallback,
  });
  if (options.slot === "fallback") {
    if (!fallback) fail("No backup image provider is set", 409);
    return attempt(fallback, true);
  }
  try {
    return await attempt(primary, false);
  } catch (error) {
    if (!fallback || options.slot === "primary" || !shouldUseFallback(error)) throw error;
    const baseError = error instanceof Error ? error.message : String(error);
    try {
      return { ...await attempt(fallback, true), baseError };
    } catch (backupError) {
      if (!(backupError instanceof Error)) throw backupError;
      throw Object.assign(new Error(`${backupError.message}; the base first failed: ${baseError}`), {
        status: (backupError as { status?: unknown }).status,
      });
    }
  }
}
