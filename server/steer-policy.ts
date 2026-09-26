// The steer-policy chooser for the 1:1 busy-send seam: the admission lane's
// phase-1 consumer of the decision-model connection (issue #1630's plumbing,
// PR #1634). When a calibrated model is configured and opted in, a bounded
// text-only classifier may override the user's per-bot admission preference
// in either direction — but only at confidence, and with asymmetric
// thresholds. A wrong queue costs one turn-cycle and is undone with the
// queued chip's Steer button, so overriding toward queue needs a low bar; a
// wrong steer can derail the whole running turn and recovery is Stop, so
// overriding toward steer needs a high one. Every other outcome — abstain,
// below threshold, error, timeout — falls back to the preference. The
// model's only power is a confident override; it never invents actions, and
// mechanical clamps (images, engines without live steering, pending computer
// selections) never reach it.
import type { DecisionModelClient } from "./decision-model.ts";
import { redactSecrets } from "./redact.ts";

/** The user's per-bot fallback, patched like parkDirectMessages. Absent on
 * older records means "steer", the historical byte-for-byte default. */
export type AdmissionPreference = "steer" | "queue";

/** Who decided an admission, for telemetry: the user's configured fallback,
 * a confident model override, a hard mechanical rule, or the human pressing
 * Steer. Without this attribution, misqueue/missteer regret metrics cannot
 * tell the model's calls from the user's own preference. */
export type AdmissionLayer = "preference-default" | "model-override" | "mechanical-clamp" | "human";

/** Overriding toward queue is cheap to undo (the Steer chip), so the bar is
 * low. Default chosen below the lane's 0.9 acting threshold on purpose. */
export const DEFAULT_QUEUE_OVERRIDE_THRESHOLD = 0.7;
/** Overriding toward steer can cost the whole running turn, so the bar
 * matches the lane's acting threshold. */
export const DEFAULT_STEER_OVERRIDE_THRESHOLD = 0.9;
/** The hot send path must never wait on a slow classifier. Tight budget,
 * abortable per call; a timeout is a preference fallback, never a delay. */
export const DEFAULT_ADMISSION_BUDGET_MS = 1_000;
export const MIN_ADMISSION_BUDGET_MS = 250;
export const MAX_ADMISSION_BUDGET_MS = 1_500;
/** Same hard wire cap as the computer-use chooser's request. */
export const MAX_ADMISSION_STATE_BYTES = 65_536;

const MAX_MESSAGE_CHARS = 1_000;
const MAX_OPENING_CHARS = 500;
const MAX_ENGINE_CHARS = 128;
const MAX_SENDER_CHARS = 32;

/** Bounded, privacy-shaped state: the submitted words, the running turn's
 * opening request as the intent anchor, and a handful of signals the harness
 * already knows. No screenshots, no tool arguments, no full transcript. */
export type AdmissionState = {
  surface: "direct";
  message: string;
  running_turn: {
    opening_request: string;
    elapsed_ms?: number;
  };
  queue_depth: number;
  /** The reply targets a message born inside the running turn — a strong
   * steer prior, and the only reason to consult the model for a
   * queue-preferring bot. */
  reply_to_running_turn: boolean;
  unattended: boolean;
  engine: string;
  sender: string;
};

export function admissionBudgetMs(configured: number | undefined): number {
  return typeof configured === "number" && Number.isFinite(configured)
    ? Math.min(MAX_ADMISSION_BUDGET_MS, Math.max(MIN_ADMISSION_BUDGET_MS, Math.round(configured)))
    : DEFAULT_ADMISSION_BUDGET_MS;
}

function boundedText(value: unknown, limit: number): string {
  const text = typeof value === "string" ? value : "";
  return text.slice(0, limit);
}

export function buildAdmissionState(input: {
  message: string;
  runningTurnOpeningRequest: string | null;
  runningTurnStartedAt?: number | null;
  queueDepth: number;
  replyToRunningTurn: boolean;
  unattended: boolean;
  engine: string;
  sender: string;
}): AdmissionState {
  const state: AdmissionState = {
    surface: "direct",
    message: boundedText(input.message, MAX_MESSAGE_CHARS),
    running_turn: {
      opening_request: boundedText(input.runningTurnOpeningRequest ?? "", MAX_OPENING_CHARS),
      ...(typeof input.runningTurnStartedAt === "number" && Number.isFinite(input.runningTurnStartedAt)
        ? { elapsed_ms: Math.max(0, Date.now() - input.runningTurnStartedAt) }
        : {}),
    },
    queue_depth: Math.max(0, Math.floor(input.queueDepth) || 0),
    reply_to_running_turn: input.replyToRunningTurn === true,
    unattended: input.unattended === true,
    engine: boundedText(input.engine, MAX_ENGINE_CHARS),
    sender: boundedText(input.sender, MAX_SENDER_CHARS),
  };
  // The state crosses to the decision-model provider; keep the shape and
  // lose any credential-shaped values, exactly like the protocol log.
  return redactSecrets(state) as AdmissionState;
}

/** Structural gate before the state leaves the process: right keys, bounded
 * strings and numbers, and inside the hard wire cap. */
export function validateAdmissionState(state: unknown): AdmissionState | null {
  if (!state || typeof state !== "object" || Array.isArray(state)) return null;
  const value = state as Record<string, unknown>;
  if (value.surface !== "direct") return null;
  if (typeof value.message !== "string" || value.message.length > MAX_MESSAGE_CHARS) return null;
  const running = value.running_turn;
  if (!running || typeof running !== "object" || Array.isArray(running)) return null;
  const turn = running as Record<string, unknown>;
  if (typeof turn.opening_request !== "string" || turn.opening_request.length > MAX_OPENING_CHARS) return null;
  if (turn.elapsed_ms !== undefined && (typeof turn.elapsed_ms !== "number" || !Number.isFinite(turn.elapsed_ms) || turn.elapsed_ms < 0)) return null;
  if (typeof value.queue_depth !== "number" || !Number.isInteger(value.queue_depth) || value.queue_depth < 0) return null;
  if (typeof value.reply_to_running_turn !== "boolean") return null;
  if (typeof value.unattended !== "boolean") return null;
  if (typeof value.engine !== "string" || value.engine.length > MAX_ENGINE_CHARS) return null;
  if (typeof value.sender !== "string" || value.sender.length > MAX_SENDER_CHARS) return null;
  const allowed = ["surface", "message", "running_turn", "queue_depth", "reply_to_running_turn", "unattended", "engine", "sender"];
  if (Object.keys(value).some((key) => !allowed.includes(key))) return null;
  try {
    if (Buffer.byteLength(JSON.stringify(state), "utf8") > MAX_ADMISSION_STATE_BYTES) return null;
  } catch {
    return null;
  }
  return state as AdmissionState;
}

/** The volume cut for queue-preferring bots: consult the model only when a
 * steer prior exists. (The amendment also sketches correction-shaped text
 * as a prior; that half is deliberately unimplemented — text shape is a
 * judgment the model itself should make, not a regex in the hot path.) */
export function steerPrior(state: AdmissionState): boolean {
  return state.reply_to_running_turn;
}

export const ADMISSION_CRITERIA = {
  steer: "The words belong to the running work: a correction, an addition, or an answer to an open ask from the live turn.",
  queue: "A new, independent request: keep the transcript clean and run it as the next turn.",
  abstain: "Decline to decide; the user's own preference applies.",
} as const;

export type AdmissionDecision = {
  /** What the seam actually does. */
  action: AdmissionPreference;
  layer: "preference-default" | "model-override";
  preference: AdmissionPreference;
  confidence?: number;
  model?: string;
  /** Stable, bounded reason: abstain | below-threshold | error:… | timeout |
   * override:steer|queue | model-agreed:steer|queue. */
  detail: string;
};

function fallback(preference: AdmissionPreference, detail: string): AdmissionDecision {
  return { action: preference, layer: "preference-default", preference, detail };
}

/** One bounded admission decision for the hot send path. Never throws: every
 * failure mode collapses to the user's preference. */
export async function decideAdmission(options: {
  client: DecisionModelClient;
  preference: AdmissionPreference;
  queueOverrideThreshold: number;
  steerOverrideThreshold: number;
  budgetMs: number;
  state: AdmissionState;
}): Promise<AdmissionDecision> {
  const { preference } = options;
  const budget = admissionBudgetMs(options.budgetMs);
  let decision;
  let decisionTimeout: ReturnType<typeof setTimeout> | undefined;
  const decisionAbort = new AbortController();
  try {
    decision = await Promise.race([
      options.client.decide({
        state: options.state,
        criteria: ADMISSION_CRITERIA,
        instructions: "Select exactly one candidate ID: whether the submitted message belongs to the running turn (steer), is an independent new request (queue), or cannot be judged (abstain).",
        signal: decisionAbort.signal,
      }),
      new Promise<never>((_, reject) => {
        decisionTimeout = setTimeout(() => {
          decisionAbort.abort();
          reject(new Error("decision timed out"));
        }, budget);
        decisionTimeout.unref?.();
      }),
    ]);
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 120);
    return fallback(preference, message === "decision timed out" ? "timeout" : `error: ${message}`);
  } finally {
    if (decisionTimeout) clearTimeout(decisionTimeout);
  }
  const confidence = decision.confidence;
  const model = typeof decision.model === "string" && decision.model ? decision.model : undefined;
  if (decision.selectedId === "abstain") {
    return { ...fallback(preference, "abstain"), confidence, ...(model ? { model } : {}) };
  }
  // Asymmetric gates: each direction clears its own bar. A "queue" pick
  // below the queue threshold and a "steer" pick below the steer threshold
  // both fall back to the preference.
  const action: AdmissionPreference | null =
    decision.selectedId === "queue" && confidence >= options.queueOverrideThreshold
      ? "queue"
      : decision.selectedId === "steer" && confidence >= options.steerOverrideThreshold
        ? "steer"
        : null;
  if (!action) {
    return { ...fallback(preference, "below-threshold"), confidence, ...(model ? { model } : {}) };
  }
  if (action === preference) {
    return { action, layer: "preference-default", preference, confidence, ...(model ? { model } : {}), detail: `model-agreed:${action}` };
  }
  return { action, layer: "model-override", preference, confidence, ...(model ? { model } : {}), detail: `override:${action}` };
}
