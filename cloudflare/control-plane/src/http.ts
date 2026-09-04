import { z } from "zod";

import type { ControlPlaneConfig } from "./config";

export const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
} as const;

const jsonValueSchema = z.json();
export type JSONValue = z.infer<typeof jsonValueSchema>;

export const MAX_API_BODY_BYTES = 16 * 1024;
const BODYLESS_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const ALLOWED_CORS_METHODS = new Set(["GET", "POST", "DELETE"]);
const ALLOWED_CORS_HEADERS = new Set(["authorization", "content-type"]);

export class HTTPError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(code);
  }
}

export function json(value: JSONValue, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: JSON_HEADERS });
}

export function errorResponse(status: number, code: string): Response {
  return json({ error: code }, status);
}

function validateDeclaredBodyLength(request: Request, maxBytes: number) {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (!Number.isSafeInteger(declared) || declared < 0) throw new HTTPError(400, "invalid_request");
    if (declared > maxBytes) throw new HTTPError(413, "request_too_large");
  }
}

async function readBoundedBody(request: Request, maxBytes = MAX_API_BODY_BYTES): Promise<Uint8Array<ArrayBuffer>> {
  validateDeclaredBodyLength(request, maxBytes);
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel();
        throw new HTTPError(413, "request_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function withBoundedRequestBody(request: Request, maxBytes = MAX_API_BODY_BYTES): Promise<Request> {
  if (BODYLESS_METHODS.has(request.method.toUpperCase())) return request;
  const bytes = await readBoundedBody(request, maxBytes);
  if (!request.body) return request;

  const headers = new Headers(request.headers);
  headers.delete("content-length");
  // Mutating methods are the only path here; safe methods returned above.
  // oxlint-disable-next-line unicorn/no-invalid-fetch-options
  return new Request(request, { body: bytes.buffer, headers });
}

export async function readBoundedJSON(request: Request): Promise<JSONValue> {
  return readBoundedJSONWithLimit(request, MAX_API_BODY_BYTES);
}

export async function readBoundedJSONWithLimit(request: Request, maxBytes: number): Promise<JSONValue> {
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (mediaType !== "application/json") throw new HTTPError(415, "unsupported_media_type");
  if (!request.body) throw new HTTPError(400, "invalid_request");

  const bytes = await readBoundedBody(request, maxBytes);
  try {
    return jsonValueSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  } catch {
    throw new HTTPError(400, "invalid_request");
  }
}

function appendVary(headers: Headers, name: string) {
  const current = headers.get("vary")?.split(",").map((value) => value.trim()).filter(Boolean) ?? [];
  if (!current.some((value) => value.toLowerCase() === name.toLowerCase())) current.push(name);
  headers.set("vary", current.join(", "));
}

function requestOriginAllowed(request: Request, config: ControlPlaneConfig): string | null {
  const origin = request.headers.get("origin");
  if (!origin) return null;
  return config.allowedOrigins.has(origin) ? origin : null;
}

export function preflight(request: Request, config: ControlPlaneConfig): Response {
  const origin = requestOriginAllowed(request, config);
  if (!origin) return errorResponse(403, "origin_not_allowed");

  const requestedMethod = request.headers.get("access-control-request-method")?.toUpperCase();
  if (!requestedMethod || !ALLOWED_CORS_METHODS.has(requestedMethod)) {
    return errorResponse(403, "origin_not_allowed");
  }
  const requestedHeaders = (request.headers.get("access-control-request-headers") ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (requestedHeaders.some((name) => !ALLOWED_CORS_HEADERS.has(name))) {
    return errorResponse(403, "origin_not_allowed");
  }

  return new Response(null, {
    status: 204,
    headers: {
      "cache-control": "no-store",
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "GET, POST, DELETE",
      "access-control-allow-headers": "authorization, content-type",
      "vary": "Origin",
    },
  });
}

export function secureResponse(
  response: Response,
  request: Request,
  config: ControlPlaneConfig | null,
  requestId: string,
): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-request-id", requestId);
  headers.delete("access-control-allow-origin");

  if (config) {
    const origin = requestOriginAllowed(request, config);
    if (origin) {
      headers.set("access-control-allow-origin", origin);
      appendVary(headers, "Origin");
    }
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
