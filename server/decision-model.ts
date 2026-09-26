// The opt-in decision-model connection (issue #1630): a bounded System One
// classifier that answers "which of these N actions next" for computer-use
// steps without a screenshot or an LLM turn. This module owns the wire:
// four provider lanes, the calibration probe the Settings Test button runs,
// and the calibrated verdict the chooser gates on. The key is write-only —
// it lives in config.json or env, is never echoed in a verdict or a status,
// and is never logged.
import { createHash } from "node:crypto";
import { TypeSafeClient, choice as choiceQuestion, type EntryType } from "@typesafe-ai/sdk";
import { DECISION_MODEL_PROVIDERS, type AppConfig } from "./config.ts";

export type DecisionModelProvider = (typeof DECISION_MODEL_PROVIDERS)[number];

/** Confidence at or above which the chooser may act. The issue's default. */
export const DEFAULT_DECISION_THRESHOLD = 0.9;

export type DecisionModelConfig = NonNullable<AppConfig["decisionModel"]>;

const DEFAULT_URLS: Record<DecisionModelProvider, string> = {
  typesafe: "https://api.typesafe.ai",
  // The gateway serves the evaluation dialect under /v1 (specification v4),
  // the same body the TypeSafe SDK sends; the probe verifies what a given
  // deployment actually answers.
  vercel: "https://ai-gateway.vercel.sh/v1",
  openrouter: "https://openrouter.ai/api/v1",
  custom: "",
};

export function decisionModelProvider(value: unknown): DecisionModelProvider | null {
  return typeof value === "string" && (DECISION_MODEL_PROVIDERS as readonly string[]).includes(value)
    ? (value as DecisionModelProvider)
    : null;
}

/** The lane's API root. The custom lane has no default: a user-run
 * endpoint is the whole point of it. */
export function decisionModelBaseUrl(config: DecisionModelConfig): string | null {
  const provider = decisionModelProvider(config.provider);
  if (!provider) return null;
  const url = (config.url ?? "").trim() || DEFAULT_URLS[provider];
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    return parsed.origin + parsed.pathname.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

/** A configured key must never travel in cleartext: an http: endpoint is
 * only for the keyless custom lane on the operator's own machine. */
export function keyOverInsecureTransport(config: DecisionModelConfig): boolean {
  if (!config.apiKey?.trim()) return false;
  const baseUrl = decisionModelBaseUrl(config);
  if (!baseUrl) return false;
  try {
    return new URL(baseUrl).protocol === "http:";
  } catch {
    return false;
  }
}

/** A connection is configured when it names a lane and a model and has a
 * key wherever the lane bills by one; the custom lane may run keyless on
 * the operator's own machine. */
export function decisionModelConfigured(config: DecisionModelConfig | undefined): boolean {
  if (!config) return false;
  const provider = decisionModelProvider(config.provider);
  if (!provider || !config.model?.trim()) return false;
  if (provider === "custom" && !(config.url ?? "").trim()) return false;
  return provider === "custom" || Boolean(config.apiKey?.trim());
}

export function decisionThreshold(config: DecisionModelConfig | undefined): number {
  const threshold = config?.threshold;
  return typeof threshold === "number" && Number.isFinite(threshold) && threshold >= 0.5 && threshold <= 1
    ? threshold
    : DEFAULT_DECISION_THRESHOLD;
}

export type DecisionChoice = {
  selectedId: string;
  confidence: number;
  probabilities: Record<string, number>;
  model?: string;
};

/** One bounded choice question, in the System One dialect every lane
 * speaks: {state, questions:{next_action:{type:"choice",…}}}. */
export interface DecisionModelClient {
  decide(request: { state: EntryType; criteria: Record<string, string>; instructions?: string; signal?: AbortSignal }): Promise<DecisionChoice>;
}

function validateChoice(answer: { choice?: unknown; confidence?: unknown; probabilities?: unknown }, criteria: Record<string, string>): DecisionChoice | null {
  if (typeof answer.choice !== "string" || !Object.hasOwn(criteria, answer.choice)) return null;
  if (typeof answer.confidence !== "number" || !Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1) return null;
  const raw = answer.probabilities;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const probabilities: Record<string, number> = {};
  for (const [id, probability] of Object.entries(raw as Record<string, unknown>)) {
    if (!Object.hasOwn(criteria, id)) continue;
    if (typeof probability !== "number" || !Number.isFinite(probability) || probability < 0 || probability > 1) return null;
    probabilities[id] = probability;
  }
  if (Object.keys(probabilities).length !== Object.keys(criteria).length) return null;
  const total = Object.values(probabilities).reduce((sum, value) => sum + value, 0);
  if (Math.abs(total - 1) > 0.001) return null;
  return { selectedId: answer.choice, confidence: answer.confidence, probabilities };
}

/** The native dialect shared by the typesafe, vercel and openrouter lanes:
 * one zero-dependency SDK pointed at each lane's root. */
function systemOneClient(options: { baseUrl: string; apiKey?: string; model: string; fetchImpl?: typeof fetch }): DecisionModelClient {
  const client = new TypeSafeClient({
    ...(options.apiKey ? { apiKey: options.apiKey } : {}),
    baseURL: options.baseUrl,
    ...(options.fetchImpl ? { fetch: options.fetchImpl } : {}),
  });
  return {
    async decide(request) {
      const response = await client.systemOne(
        {
          model: options.model,
          state: request.state,
          questions: {
            next_action: choiceQuestion(request.instructions ?? null, request.criteria),
          },
        },
        request.signal ? { signal: request.signal } : undefined,
      );
      const answer = (response.answers as Record<string, unknown>).next_action as Record<string, unknown>;
      if (answer?.type !== "choice") throw new Error("decision model returned a non-choice answer");
      const choice = validateChoice(answer as { choice?: unknown; confidence?: unknown; probabilities?: unknown }, request.criteria);
      if (!choice) throw new Error("decision model returned an invalid choice answer");
      return typeof response.model === "string" && response.model.trim()
        ? { ...choice, model: response.model }
        : choice;
    },
  };
}

const CUSTOM_ENVELOPE = {
  type: "object",
  additionalProperties: false,
  required: ["choice", "confidence", "probabilities"],
  properties: {
    choice: { type: "string" },
    confidence: { type: "number" },
    probabilities: { type: "object", additionalProperties: { type: "number" } },
  },
} as const;

/** The custom lane: a user-run OpenAI-compatible endpoint (issue #1630).
 * Chat transports carry no evaluation semantics, so the canary probe is
 * what makes this lane's numbers trustworthy — an uncalibrated server
 * never gets to act. */
function chatCompletionsClient(options: { baseUrl: string; apiKey?: string; model: string; fetchImpl?: typeof fetch }): DecisionModelClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = options.baseUrl.endsWith("/chat/completions")
    ? options.baseUrl
    : `${options.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  return {
    async decide(request) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30_000);
      const signal = request.signal ? AbortSignal.any([request.signal, controller.signal]) : controller.signal;
      try {
        const response = await fetchImpl(url, {
          method: "POST",
          // a 3xx could replay this POST — state, criteria, and the key —
          // over cleartext http; the configured URL is the only destination
          redirect: "error",
          headers: {
            "content-type": "application/json",
            ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
          },
          body: JSON.stringify({
            model: options.model,
            messages: [
              {
                role: "system",
                content:
                  "You are a calibrated classifier. Choose exactly one candidate id and return its probability distribution. " +
                  "Reply with JSON only: {\"choice\": string, \"confidence\": number, \"probabilities\": {candidate id: number}}. " +
                  "Probabilities must sum to 1.",
              },
              { role: "user", content: JSON.stringify({ state: request.state, criteria: request.criteria, ...(request.instructions ? { instructions: request.instructions } : {}) }) },
            ],
            response_format: { type: "json_schema", json_schema: { name: "decision", strict: true, schema: CUSTOM_ENVELOPE } },
            temperature: 0,
          }),
          signal,
        });
        if (!response.ok) throw Object.assign(new Error(`decision endpoint answered ${response.status}`), { status: response.status });
        const body: unknown = await response.json().catch(() => null);
        const content = (body as { choices?: Array<{ message?: { content?: unknown } }> } | null)?.choices?.[0]?.message?.content;
        const parsed: unknown = typeof content === "string" ? JSON.parse(content) : content;
        if (!parsed || typeof parsed !== "object") throw new Error("decision endpoint returned no JSON decision");
        const choice = validateChoice(parsed as { choice?: unknown; confidence?: unknown; probabilities?: unknown }, request.criteria);
        if (!choice) throw new Error("decision endpoint returned an invalid decision envelope");
        return choice;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export function createDecisionModelClient(
  config: DecisionModelConfig,
  fetchImpl?: typeof fetch,
): { client: DecisionModelClient; provider: DecisionModelProvider; baseUrl: string; model: string } | null {
  const provider = decisionModelProvider(config.provider);
  const baseUrl = decisionModelBaseUrl(config);
  const model = config.model?.trim();
  if (!provider || !baseUrl || !model) return null;
  const apiKey = config.apiKey?.trim() || undefined;
  const shared = { baseUrl, apiKey, model, fetchImpl };
  return { provider, baseUrl, model, client: provider === "custom" ? chatCompletionsClient(shared) : systemOneClient(shared) };
}

export type DecisionModelVerdict =
  | { ok: true; check: "calibration"; model: string; confidence: number; deterministic: true }
  | { ok: false; reason: "rejected" | "unreachable" | "unexpected" | "uncalibrated"; detail?: string; status?: number };

// A canary with exactly one defensible answer: any calibrated classifier
// lands on it with near-total mass, whatever its tuning.
const CANARY_STATE = "The assistant must pick the only even prime number.";
const CANARY_CRITERIA = {
  two: "The only even prime number.",
  three: "An odd prime number.",
  seventeen: "An odd prime number.",
  reobserve: "Look again before deciding.",
  abstain: "Decline to answer.",
};

/** The calibration probe (the row's Test button): one canary decision,
 * then the same request again. Passing requires the obviously-right
 * answer both times, probabilities that sum to one, and identical
 * distributions — the sharpest discriminator against a generative wrapper
 * fabricating plausible numbers. */
export async function probeDecisionModel(
  config: DecisionModelConfig,
  fetchImpl?: typeof fetch,
): Promise<DecisionModelVerdict> {
  if (keyOverInsecureTransport(config)) {
    return {
      ok: false,
      reason: "uncalibrated",
      detail: "an API key must not be sent over an http: endpoint — use https:, or remove the key (the custom lane runs keyless on your own machine)",
    };
  }
  const built = createDecisionModelClient(config, fetchImpl);
  if (!built) return { ok: false, reason: "uncalibrated", detail: "the connection is incomplete: provider, model and (outside the custom lane) key are required" };
  let first: DecisionChoice;
  try {
    first = await built.client.decide({ state: CANARY_STATE, criteria: CANARY_CRITERIA, instructions: "Pick the candidate that is factually correct." });
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 401 || status === 403) return { ok: false, reason: "rejected", status };
    if (error instanceof Error && /not found|does not exist|no such model/i.test(error.message)) {
      return { ok: false, reason: "unexpected", detail: "the model does not exist on that server", status };
    }
    return { ok: false, reason: "unreachable" };
  }
  if (first.selectedId !== "two") return { ok: false, reason: "uncalibrated", detail: "the canary decision chose the wrong candidate" };
  let second: DecisionChoice;
  try {
    second = await built.client.decide({ state: CANARY_STATE, criteria: CANARY_CRITERIA, instructions: "Pick the candidate that is factually correct." });
  } catch {
    return { ok: false, reason: "uncalibrated", detail: "the repeat canary decision failed" };
  }
  if (second.selectedId !== "two") return { ok: false, reason: "uncalibrated", detail: "the repeat canary decision chose the wrong candidate" };
  const keys = Object.keys(CANARY_CRITERIA);
  if (keys.some((key) => first.probabilities[key] !== second.probabilities[key])) {
    return { ok: false, reason: "uncalibrated", detail: "the same request twice returned different distributions (a generative wrapper, not a calibrated classifier)" };
  }
  if (first.confidence !== second.confidence) {
    return { ok: false, reason: "uncalibrated", detail: "the same request twice returned different confidence (a generative wrapper, not a calibrated classifier)" };
  }
  return { ok: true, check: "calibration", model: first.model ?? built.model, confidence: first.confidence, deterministic: true };
}

/** The runtime gate: confidence-based acting only for a connection whose
 * probe passed in this process. One verdict per fingerprint, so a key or
 * URL change re-probes; failures back off for a minute before retrying. */
export interface CalibrationGate {
  fingerprint(config: DecisionModelConfig): string;
  /** Synchronous: true only when a probe already passed for this exact
   * connection. Mounts consult this so enabling the chooser never adds
   * turn-start latency. */
  cached(config: DecisionModelConfig): boolean;
  calibrated(config: DecisionModelConfig): Promise<boolean>;
  probe(config: DecisionModelConfig): Promise<DecisionModelVerdict>;
}

export function createCalibrationGate(probe: (config: DecisionModelConfig) => Promise<DecisionModelVerdict> = probeDecisionModel): CalibrationGate {
  type Entry = { verdict: DecisionModelVerdict; at: number };
  const cache = new Map<string, Promise<Entry | null>>();
  const settled = new Map<string, Entry>();
  const fingerprintOf = (config: DecisionModelConfig) => {
    const provider = decisionModelProvider(config.provider) ?? "";
    const key = config.apiKey?.trim() ?? "";
    return [provider, decisionModelBaseUrl(config) ?? "", config.model?.trim() ?? "", createHash("sha256").update(key).digest("hex").slice(0, 12)].join("|");
  };
  // A pass stands until the fingerprint changes; a failure is retried after
  // a minute so a flaky network cannot permanently disarm the chooser.
  const probeFor = (config: DecisionModelConfig): Promise<DecisionModelVerdict> => {
    const fingerprint = fingerprintOf(config);
    const inFlight = cache.get(fingerprint);
    if (inFlight) {
      return inFlight.then((entry) => {
        if (entry && (entry.verdict.ok || Date.now() - entry.at < 60_000)) return entry.verdict;
        return reprobe(fingerprint, config);
      });
    }
    return reprobe(fingerprint, config);
  };
  return {
    fingerprint: fingerprintOf,
    cached(config) {
      return settled.get(fingerprintOf(config))?.verdict.ok === true;
    },
    probe: probeFor,
    calibrated: (config) => probeFor(config).then((verdict) => verdict.ok),
  };

  function reprobe(fingerprint: string, config: DecisionModelConfig): Promise<DecisionModelVerdict> {
    const pending = probe(config)
      .then((verdict): Entry => {
        const entry = { verdict, at: Date.now() };
        settled.set(fingerprint, entry);
        return entry;
      })
      .catch((): Entry => {
        const verdict: DecisionModelVerdict = { ok: false, reason: "unreachable" };
        const entry = { verdict, at: Date.now() };
        settled.set(fingerprint, entry);
        return entry;
      });
    cache.set(fingerprint, pending);
    return pending.then((entry) => entry.verdict);
  }
}
