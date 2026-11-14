// Cloudflare Workers AI: Clef and Clef-flash for decisions here, Clairic for extraction in server/extractor. Formats from
// developers.cloudflare.com/workers-ai/models/{clef,clef-flash,clairic} (Oct 2026): POST
// <root>/accounts/<account>/ai/run/@cf/cloudflare/<model> with a Bearer token; the REST answer wraps the model's own
// answer as { result, success, errors, messages }. Clef takes and returns Jev's System One shape with `model` set to
// "clef" or "clef-flash". Error bodies are never read into a message: they can echo the request.
import { isLoopback } from "../provider-key-check.ts";
import { jevRequestBody, parseJevResponse, questionsFit, refusal } from "./jev.ts";
import type { BackendRequest, BackendResult, DeciderBackend } from "./types.ts";

export const WORKERS_AI_DEFAULT_BASE_URL = "https://api.cloudflare.com/client/v4";
export type WorkersAiModel = "clef" | "clef-flash" | "clairic";
/** Fast by default; Clef for a hard case. */
export const CLEF_FLASH: WorkersAiModel = "clef-flash";
export const CLEF: WorkersAiModel = "clef";

/** Null when the token must not be sent there: https anywhere, plain http only to this machine, and a well-formed account. */
export function workersAiEndpoint(baseUrl: string | undefined | null, accountId: string | undefined, model: WorkersAiModel): URL | null {
  if (!accountId || !/^[0-9a-f]{32}$/i.test(accountId)) return null;
  const root = (baseUrl?.trim() || WORKERS_AI_DEFAULT_BASE_URL).replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(`${root}/accounts/${accountId.toLowerCase()}/ai/run/@cf/cloudflare/${model}`);
  } catch {
    return null;
  }
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.protocol === "https:") return url;
  return url.protocol === "http:" && isLoopback(url.hostname) ? url : null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** The model's own answer out of the REST envelope; a body without the envelope (a Worker binding's) is taken as is. */
export function workersAiResult(body: unknown): unknown {
  if (!isRecord(body)) return undefined;
  if (body.success === false) return undefined;
  return "result" in body ? body.result : body;
}

export type WorkersAiCall = { ok: true; result: unknown } | { ok: false; reason: "unreachable" | "malformed" | "rejected" | "rate_limited" | "overloaded" | "too_large" | "http_error"; status?: number };

/** One POST to a Workers AI model. Never follows a redirect with the token. */
export async function callWorkersAi(input: { fetch: typeof fetch; url: URL; token: string; body: unknown; signal: AbortSignal }): Promise<WorkersAiCall> {
  let response: Response;
  try {
    response = await input.fetch(input.url, {
      method: "POST",
      headers: { authorization: `Bearer ${input.token}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(input.body),
      signal: input.signal,
      redirect: "error",
    });
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return refusal(response.status) as Exclude<WorkersAiCall, { ok: true }>;
  }
  try {
    const result = workersAiResult(await response.json());
    return result === undefined ? { ok: false, reason: "malformed" } : { ok: true, result };
  } catch {
    return { ok: false, reason: "malformed" };
  }
}

/** Clef's request: Jev's body with Clef's model selector. */
export function clefRequestBody(state: unknown, questions: BackendRequest["questions"], model: WorkersAiModel = CLEF_FLASH) {
  return { ...jevRequestBody(state, questions), model };
}

async function decide(request: BackendRequest): Promise<BackendResult> {
  const model = request.careful ? CLEF : CLEF_FLASH;
  const url = workersAiEndpoint(request.baseUrl, request.accountId, model);
  if (!url || !questionsFit(request.questions)) return { ok: false, reason: "misconfigured" };
  const called = await callWorkersAi({ fetch: request.fetch, url, token: request.key, body: clefRequestBody(request.state, request.questions, model), signal: request.signal });
  if (!called.ok) return { ok: false, reason: called.reason, ...(called.status ? { status: called.status } : {}) };
  const parsed = parseJevResponse(called.result, request.questions);
  return parsed.ok ? { ...parsed, model: parsed.model ?? model } : { ok: false, reason: "malformed" };
}

export const workersAiBackend: DeciderBackend = { id: "workersai", decide };
