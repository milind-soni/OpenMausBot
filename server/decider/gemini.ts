import { jevRequestBody, parseJevResponse, questionsFit, refusal } from "./jev.ts";
import type { BackendRequest, BackendResult, DeciderBackend } from "./types.ts";

export const GEMINI_DECIDER_URL = "https://generativelanguage.googleapis.com/v1beta/decisions";
export const GEMINI_DECIDER_MODEL = "gemini-decision-1";

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

async function decide(request: BackendRequest): Promise<BackendResult> {
  if (!questionsFit(request.questions)) return { ok: false, reason: "misconfigured" };
  const wire = jevRequestBody(request.state, request.questions).questions;
  const questions = Object.fromEntries(Object.entries(request.questions).map(([id, question]) => {
    if (question.type !== "yesno") return [id, wire[id]];
    const criteria = question.criteria?.yes || question.criteria?.no ? {
      ...(question.criteria.yes ? { true_description: question.criteria.yes } : {}),
      ...(question.criteria.no ? { false_description: question.criteria.no } : {}),
    } : undefined;
    return [id, { type: "noul", instructions: question.instructions, ...(criteria ? { criteria } : {}) }];
  }));
  let response: Response;
  try {
    response = await request.fetch(GEMINI_DECIDER_URL, {
      method: "POST",
      headers: { "x-goog-api-key": request.key, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ model: GEMINI_DECIDER_MODEL, input: typeof request.state === "string" ? request.state : JSON.stringify(request.state), questions }),
      signal: request.signal,
      redirect: "error",
    });
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  if (!response.ok) {
    if (response.status === 400) {
      const body = await response.json().catch(() => null);
      const details = isRecord(body) && isRecord(body.error) ? body.error.details : undefined;
      if (Array.isArray(details) && details.some((detail) => isRecord(detail) && detail.reason === "API_KEY_INVALID")) return { ok: false, reason: "rejected", status: 400 };
      return refusal(400);
    }
    await response.body?.cancel().catch(() => undefined);
    return refusal(response.status);
  }
  try {
    const body = await response.json() as unknown;
    if (!isRecord(body)) return { ok: false, reason: "malformed" };
    const usage = "usage" in body && body.usage && typeof body.usage === "object" && "total_input_tokens" in body.usage ? body.usage.total_input_tokens : undefined;
    const parsed = parseJevResponse({ ...body, model: GEMINI_DECIDER_MODEL, usage: { input_tokens: usage } }, request.questions);
    return parsed.ok ? parsed : { ok: false, reason: "malformed" };
  } catch {
    return { ok: false, reason: "malformed" };
  }
}

export const geminiBackend: DeciderBackend = { id: "gemini", decide };
