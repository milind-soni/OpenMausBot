// Extraction on the person's own Workers AI account. Clairic's field types (developers.cloudflare.com/workers-ai/models/
// clairic, Oct 2026) are text, number, date, time, datetime, duration, list, estimate and forecast: it has no boolean and
// no enum. So string, number and date fields go to Clairic, and boolean and enum fields to Clef-flash as yes/no and choice
// questions about the same input; the two answers are merged. Clairic's answer is { model, answers: { [field]: { type,
// value, ... } }, truncated, usage }, with value null when the input does not determine it.
import { parseJevResponse } from "../decider/jev.ts";
import type { DeciderQuestion } from "../decider/types.ts";
import { callWorkersAi, clefRequestBody, CLEF_FLASH, workersAiEndpoint } from "../decider/workers-ai.ts";
import { typedValue } from "./contract.ts";
import type { ExtractBackendRequest, ExtractBackendResult, ExtractedValues, FieldSchema, FieldSpec } from "./types.ts";

const CLAIRIC_TYPE = { string: "text", number: "number", date: "date" } as const;
/** Clef's yes/no reads as true or false only when it leans clearly; in between, the input does not say. */
const YES_AT = 0.6;
const NO_AT = 0.4;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const images = (request: ExtractBackendRequest) => request.input.images?.length
  ? { images: request.input.images.map((image) => ({ content_type: image.mime, base64: image.data })) }
  : {};

function split(fields: FieldSchema): { clairic: FieldSchema; clef: FieldSchema } {
  const clairic: FieldSchema = {}, clef: FieldSchema = {};
  for (const [name, spec] of Object.entries(fields)) (spec.type === "boolean" || spec.type === "enum" ? clef : clairic)[name] = spec;
  return { clairic, clef };
}

export function clairicRequestBody(request: Pick<ExtractBackendRequest, "input" | "referenceDate">, fields: FieldSchema) {
  return {
    model: "clairic",
    state: request.input.text ?? "",
    fields: Object.fromEntries(Object.entries(fields).map(([name, spec]) => [name, {
      type: CLAIRIC_TYPE[spec.type as keyof typeof CLAIRIC_TYPE],
      ...(spec.description ? { instructions: spec.description } : {}),
    }])),
    ...images(request as ExtractBackendRequest),
    ...(Object.values(fields).some((spec) => spec.type === "date") ? { reference_date: request.referenceDate } : {}),
  };
}

export function clefQuestions(fields: FieldSchema): Record<string, DeciderQuestion> {
  return Object.fromEntries(Object.entries(fields).map(([name, spec]): [string, DeciderQuestion] => spec.type === "enum"
    ? [name, { type: "choice", instructions: spec.description || `Which ${name} is it?`, options: Object.fromEntries((spec.options ?? []).map((option) => [option, option])) }]
    : [name, { type: "yesno", instructions: spec.description || `Is ${name} true?` }]));
}

function clairicValues(result: unknown, fields: FieldSchema): ExtractedValues | null {
  if (!isRecord(result) || !isRecord(result.answers)) return null;
  const out: ExtractedValues = {};
  for (const [name, spec] of Object.entries(fields)) {
    const answer = result.answers[name];
    if (!isRecord(answer)) return null;
    const value = typedValue(spec, answer.value);
    if (value === undefined) return null;
    out[name] = value;
  }
  return out;
}

function clefValues(result: unknown, fields: FieldSchema): ExtractedValues | null {
  const parsed = parseJevResponse(result, clefQuestions(fields));
  if (!parsed.ok) return null;
  return Object.fromEntries(Object.entries(fields).map(([name, spec]: [string, FieldSpec]) => {
    const answer = parsed.answers[name]!;
    if (spec.type === "enum") return [name, answer.type === "choice" ? answer.choice : null];
    const p = answer.type === "yesno" ? answer.p : 0.5;
    return [name, p >= YES_AT ? true : p <= NO_AT ? false : null];
  }));
}

export async function extractWithWorkersAi(request: ExtractBackendRequest): Promise<ExtractBackendResult> {
  const { clairic, clef } = split(request.fields);
  const clairicUrl = workersAiEndpoint(request.baseUrl, request.accountId, "clairic");
  const clefUrl = workersAiEndpoint(request.baseUrl, request.accountId, CLEF_FLASH);
  if (!clairicUrl || !clefUrl) return { ok: false, reason: "misconfigured" };
  const call = (url: URL, body: unknown) => callWorkersAi({ fetch: request.fetch, url, token: request.key, body, signal: request.signal });
  const state = request.input.text ?? "";
  const [read, decided] = await Promise.all([
    Object.keys(clairic).length ? call(clairicUrl, clairicRequestBody(request, clairic)) : null,
    Object.keys(clef).length ? call(clefUrl, { ...clefRequestBody(state, clefQuestions(clef), CLEF_FLASH), ...images(request) }) : null,
  ]);
  for (const called of [read, decided]) if (called && !called.ok) return { ok: false, reason: called.reason, ...(called.status ? { status: called.status } : {}) };
  const fromClairic = read?.ok ? clairicValues(read.result, clairic) : {};
  const fromClef = decided?.ok ? clefValues(decided.result, clef) : {};
  if (!fromClairic || !fromClef) return { ok: false, reason: "malformed" };
  const values = Object.fromEntries(Object.keys(request.fields).map((name) => [name, fromClairic[name] ?? fromClef[name] ?? null]));
  return { ok: true, values, model: [read && "clairic", decided && CLEF_FLASH].filter(Boolean).join("+") };
}
