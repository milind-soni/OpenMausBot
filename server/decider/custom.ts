// A gateway the person points at, speaking one of two protocols. Error bodies are never read into a message: they can
// echo the request. Answers from `/decisions` are matched by position: `name` is optional there and may repeat.
import type { BackendRequest, BackendResult, CustomApi, DeciderBackend, DeciderQuestion } from "./types.ts";
import { keySafeUrl } from "../provider-key-check.ts";
import { jevRequestBody, parseJevResponse, questionsFit, refusal } from "./jev.ts";

export const CUSTOM_DEFAULT_API: CustomApi = "systemone";

/** Null without a base URL, or when the key must not be sent there. */
export function customEndpoint(baseUrl: string | undefined, api: CustomApi): URL | null {
  return baseUrl?.trim() ? keySafeUrl(baseUrl, api) : null;
}

export function systemOneBody(state: unknown, questions: Record<string, DeciderQuestion>, model: string) {
  return { ...jevRequestBody(state, questions), model };
}

function decisionsQuestion(name: string, question: DeciderQuestion) {
  if (question.type === "choice") {
    return {
      type: "choice", name, instructions: question.instructions,
      choices: Object.entries(question.options).map(([value, description]) => ({ value, description })),
    };
  }
  if (question.type === "score") {
    return { type: "score", name, instructions: question.instructions, levels: question.levels.map((label) => ({ label, description: label })) };
  }
  return { type: "predicate", name, instructions: question.instructions };
}

export function decisionsBody(state: unknown, questions: Record<string, DeciderQuestion>, model: string) {
  return {
    model,
    input: typeof state === "string" ? state : JSON.stringify(state),
    questions: Object.entries(questions).map(([id, question]) => decisionsQuestion(id, question)),
    stream: false,
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const WIRE_TYPE = { choice: "choice", score: "score", yesno: "predicate" } as const;

/** One `/decisions` answer in Jev's answer shape, for `parseJevResponse` to check; null when it cannot be one. */
function asJevAnswer(raw: unknown, question: DeciderQuestion): Record<string, unknown> | null {
  if (!isRecord(raw) || raw.type !== WIRE_TYPE[question.type]) return null;
  if (question.type === "yesno") return { noul: raw.probability };
  if (!Array.isArray(raw.probabilities)) return null;
  const probabilities: Record<string, unknown> = {};
  for (const entry of raw.probabilities) {
    if (!isRecord(entry)) return null;
    const key = question.type === "choice" ? entry.value : typeof entry.value === "number" ? String(entry.value) : undefined;
    if (typeof key !== "string" || key in probabilities) return null;
    probabilities[key] = entry.probability;
  }
  return question.type === "choice" ? { choice: raw.choice, probabilities } : { score: raw.score, probabilities };
}

export function parseDecisionsResponse(body: unknown, questions: Record<string, DeciderQuestion>) {
  const entries = Object.entries(questions);
  if (!isRecord(body) || !Array.isArray(body.answers) || body.answers.length !== entries.length) return { ok: false as const };
  const answers: Record<string, unknown> = {};
  for (const [index, [id, question]] of entries.entries()) {
    const answer = asJevAnswer(body.answers[index], question);
    if (!answer) return { ok: false as const };
    answers[id] = answer;
  }
  return parseJevResponse({ answers, usage: body.usage, model: body.model }, questions);
}

async function decide(request: BackendRequest): Promise<BackendResult> {
  const api: CustomApi = request.api === "decisions" ? "decisions" : CUSTOM_DEFAULT_API;
  const endpoint = customEndpoint(request.baseUrl, api);
  const model = request.model?.trim();
  if (!endpoint || !model || !questionsFit(request.questions)) return { ok: false, reason: "misconfigured" };
  let response: Response;
  try {
    response = await request.fetch(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${request.key}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(api === "decisions"
        ? decisionsBody(request.state, request.questions, model)
        : systemOneBody(request.state, request.questions, model)),
      signal: request.signal,
      // Never replay the key to wherever a redirect points.
      redirect: "error",
    });
  } catch {
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
  const parsed = api === "decisions" ? parseDecisionsResponse(body, request.questions) : parseJevResponse(body, request.questions);
  return parsed.ok ? parsed : { ok: false, reason: "malformed" };
}

export const customBackend: DeciderBackend = { id: "custom", decide };
