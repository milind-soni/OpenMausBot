// TypeSafe Jev over its HTTP API: POST {base}/v1/systemone with a Bearer
// key and { state, model, questions }. Questions use `instructions` +
// `criteria` (the older question/options shape is refused with a 422).
// Answers come back as { answers: { id: { choice, probabilities } |
// { score, probabilities } | { noul } }, usage: { input_tokens } }.
//
// Every answer is checked before anyone acts on it: a choice must be one of
// the offered keys and the most likely one, every probability a number in
// [0, 1]. Anything else is `malformed`, and the caller keeps today's rule.
// Error bodies are never read into a message: they can echo the request.
import type {
  BackendRequest, BackendResult, ChoiceAnswer, DeciderAnswer, DeciderBackend, DeciderQuestion, ScoreAnswer, YesNoAnswer,
} from "./types.ts";

export const JEV_DEFAULT_BASE_URL = "https://api.typesafe.ai";
export const JEV_MODEL = "jev-latest";
export const JEV_MAX_OPTIONS = 255;
export const JEV_MIN_LEVELS = 2;
export const JEV_MAX_LEVELS = 10;

function isLoopback(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host.startsWith("127.");
}

/** The endpoint for a base URL, or null when the key must not be sent there:
 * https anywhere, plain http only to this machine (a local Jev-compatible
 * server or a test double). */
export function jevEndpoint(baseUrl?: string | null): URL | null {
  const root = (baseUrl?.trim() || JEV_DEFAULT_BASE_URL).replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(`${root}/v1/systemone`);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (url.protocol === "https:") return url;
  return url.protocol === "http:" && isLoopback(url.hostname) ? url : null;
}

/** Questions within the API's limits: 2–255 options, 2–10 levels. */
export function questionsFit(questions: Record<string, DeciderQuestion>): boolean {
  const entries = Object.entries(questions);
  if (!entries.length) return false;
  return entries.every(([, question]) => {
    if (question.type === "choice") {
      const count = Object.keys(question.options).length;
      return count >= 2 && count <= JEV_MAX_OPTIONS;
    }
    if (question.type === "score") return question.levels.length >= JEV_MIN_LEVELS && question.levels.length <= JEV_MAX_LEVELS;
    return true;
  });
}

type WireQuestion =
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] }
  | { type: "noul"; instructions: string; criteria?: { true?: string; false?: string } };

export function jevRequestBody(state: unknown, questions: Record<string, DeciderQuestion>) {
  const wire: Record<string, WireQuestion> = {};
  for (const [id, question] of Object.entries(questions)) {
    if (question.type === "choice") {
      wire[id] = { type: "choice", instructions: question.instructions, criteria: { ...question.options } };
    } else if (question.type === "score") {
      wire[id] = { type: "score", instructions: question.instructions, criteria: [...question.levels] };
    } else {
      const criteria = question.criteria?.yes || question.criteria?.no
        ? { ...(question.criteria.yes ? { true: question.criteria.yes } : {}), ...(question.criteria.no ? { false: question.criteria.no } : {}) }
        : undefined;
      wire[id] = { type: "noul", instructions: question.instructions, ...(criteria ? { criteria } : {}) };
    }
  }
  return { state, model: JEV_MODEL, questions: wire };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isProbability = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
/** Jev rounds to two places, so a map can sum to 0.98 or 1.02. */
const SUM_TOLERANCE = 0.1;
const EPSILON = 1e-9;

function parseChoice(raw: Record<string, unknown>, question: Extract<DeciderQuestion, { type: "choice" }>): ChoiceAnswer | null {
  const offered = new Set(Object.keys(question.options));
  const choice = raw.choice;
  if (typeof choice !== "string" || !offered.has(choice)) return null;
  if (!isRecord(raw.probabilities)) return null;
  const probabilities: Record<string, number> = {};
  let sum = 0;
  for (const [key, value] of Object.entries(raw.probabilities)) {
    if (!offered.has(key) || !isProbability(value)) return null;
    probabilities[key] = value;
    sum += value;
  }
  if (!(Math.abs(sum - 1) <= SUM_TOLERANCE)) return null;
  const pTop = probabilities[choice];
  if (pTop === undefined) return null;
  const others = Object.entries(probabilities).filter(([key]) => key !== choice).map(([, value]) => value);
  const runnerUp = others.length ? Math.max(...others) : 0;
  // Ties break to the first key on the vendor side; a choice that is not
  // the most likely option means the answer is not what it claims to be.
  if (runnerUp > pTop + EPSILON) return null;
  return { type: "choice", choice, pTop, margin: pTop - runnerUp, probabilities };
}

function parseScore(raw: Record<string, unknown>, question: Extract<DeciderQuestion, { type: "score" }>): ScoreAnswer | null {
  const levels = question.levels.length;
  const score = raw.score;
  if (typeof score !== "number" || !Number.isFinite(score) || score < -EPSILON || score > levels - 1 + EPSILON) return null;
  if (!isRecord(raw.probabilities)) return null;
  const probabilities = Array.from({ length: levels }, () => 0);
  for (const [key, value] of Object.entries(raw.probabilities)) {
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0 || index >= levels || String(index) !== key || !isProbability(value)) return null;
    probabilities[index] = value;
  }
  const sum = probabilities.reduce((total, value) => total + value, 0);
  if (!(Math.abs(sum - 1) <= SUM_TOLERANCE)) return null;
  const level = probabilities.indexOf(Math.max(...probabilities));
  return { type: "score", score, level, probabilities };
}

function parseYesNo(raw: Record<string, unknown>): YesNoAnswer | null {
  return isProbability(raw.noul) ? { type: "yesno", p: raw.noul } : null;
}

const WIRE_TYPE = { choice: "choice", score: "score", yesno: "noul" } as const;

/** Strictly decode one response body against the questions that were asked. */
export function parseJevResponse(
  body: unknown,
  questions: Record<string, DeciderQuestion>,
): { ok: true; answers: Record<string, DeciderAnswer>; inputTokens?: number; model?: string } | { ok: false } {
  if (!isRecord(body) || !isRecord(body.answers)) return { ok: false };
  const answers: Record<string, DeciderAnswer> = {};
  for (const [id, question] of Object.entries(questions)) {
    const raw = body.answers[id];
    if (!isRecord(raw)) return { ok: false };
    if (raw.type !== undefined && raw.type !== WIRE_TYPE[question.type]) return { ok: false };
    const parsed = question.type === "choice" ? parseChoice(raw, question)
      : question.type === "score" ? parseScore(raw, question)
        : parseYesNo(raw);
    if (!parsed) return { ok: false };
    answers[id] = parsed;
  }
  const usage = isRecord(body.usage) ? body.usage.input_tokens : undefined;
  const inputTokens = typeof usage === "number" && Number.isFinite(usage) && usage >= 0 ? usage : undefined;
  const model = typeof body.model === "string" && body.model.length <= 80 ? body.model : undefined;
  return { ok: true, answers, ...(inputTokens !== undefined ? { inputTokens } : {}), ...(model ? { model } : {}) };
}

function refusal(status: number): BackendResult {
  if (status === 401 || status === 403) return { ok: false, reason: "rejected", status };
  if (status === 429) return { ok: false, reason: "rate_limited", status };
  if (status === 529 || status === 503) return { ok: false, reason: "overloaded", status };
  return { ok: false, reason: "http_error", status };
}

async function decide(request: BackendRequest): Promise<BackendResult> {
  const endpoint = jevEndpoint(request.baseUrl);
  if (!endpoint || !questionsFit(request.questions)) return { ok: false, reason: "misconfigured" };
  let response: Response;
  try {
    response = await request.fetch(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${request.key}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(jevRequestBody(request.state, request.questions)),
      signal: request.signal,
      // Never replay the key to wherever a redirect points.
      redirect: "error",
    });
  } catch {
    // The caller tells a timeout or a Stop from a dead network by its own signals.
    return { ok: false, reason: "unreachable" };
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return refusal(response.status);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const parsed = parseJevResponse(body, request.questions);
  return parsed.ok ? parsed : { ok: false, reason: "malformed" };
}

export const jevBackend: DeciderBackend = { id: "jev", decide };
