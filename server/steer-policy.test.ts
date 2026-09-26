// Unit coverage for the steer-policy chooser: the asymmetric threshold
// gates, the mandatory preference fallback, the abort budget, and the
// bounded state builder. The client is always a fake; e2e coverage for the
// seam lives in steer-e2e.test.ts and steer-queue.test.ts.
import { describe, expect, it } from "vitest";
import type { DecisionChoice, DecisionModelClient } from "./decision-model.ts";
import {
  admissionBudgetMs,
  buildAdmissionState,
  decideAdmission,
  steerPrior,
  validateAdmissionState,
  type AdmissionState,
} from "./steer-policy.ts";

function distribution(selectedId: string, confidence: number): Record<string, number> {
  const probabilities: Record<string, number> = { steer: 0, queue: 0, abstain: 0 };
  probabilities[selectedId] = confidence;
  const others = (["steer", "queue", "abstain"] as const).filter((id) => id !== selectedId);
  const rest = Math.round(((1 - confidence) / 2) * 1e6) / 1e6;
  probabilities[others[0]] = rest;
  probabilities[others[1]] = Math.round((1 - confidence - rest) * 1e6) / 1e6;
  return probabilities;
}

function answer(selectedId: string, confidence: number, model?: string): DecisionChoice {
  return { selectedId, confidence, probabilities: distribution(selectedId, confidence), ...(model ? { model } : {}) };
}

function clientOf(impl: (signal?: AbortSignal) => Promise<DecisionChoice>): DecisionModelClient {
  return { decide: (request) => impl(request.signal) };
}

const state: AdmissionState = buildAdmissionState({
  message: "while you are at it, also draft the launch email",
  runningTurnOpeningRequest: "refactor the parser module",
  runningTurnStartedAt: Date.now() - 5_000,
  queueDepth: 1,
  replyToRunningTurn: false,
  unattended: false,
  engine: "claude",
  sender: "loopback",
});

const run = (client: DecisionModelClient, preference: "steer" | "queue" = "steer") =>
  decideAdmission({
    client,
    preference,
    queueOverrideThreshold: 0.7,
    steerOverrideThreshold: 0.9,
    budgetMs: 250,
    state,
  });

describe("steer-policy chooser", () => {
  it("overrides toward queue at the low bar: a wrong queue is undone with the Steer chip", async () => {
    const decision = await run(clientOf(async () => answer("queue", 0.95, "jev-latest")));
    expect(decision).toMatchObject({ action: "queue", layer: "model-override", preference: "steer", confidence: 0.95, model: "jev-latest", detail: "override:queue" });
  });

  it("a queue pick below the queue threshold falls back to the preference", async () => {
    const decision = await run(clientOf(async () => answer("queue", 0.65)));
    expect(decision).toMatchObject({ action: "steer", layer: "preference-default", preference: "steer", detail: "below-threshold", confidence: 0.65 });
  });

  it("overrides toward steer only at the high bar: a wrong steer can cost the whole turn", async () => {
    const decision = await run(clientOf(async () => answer("steer", 0.95)), "queue");
    expect(decision).toMatchObject({ action: "steer", layer: "model-override", preference: "queue", detail: "override:steer" });
  });

  it("a steer pick below the steer threshold falls back to the queue preference", async () => {
    const decision = await run(clientOf(async () => answer("steer", 0.85)), "queue");
    expect(decision).toMatchObject({ action: "queue", layer: "preference-default", preference: "queue", detail: "below-threshold" });
  });

  it("the same middling confidence can queue you but cannot steer you: asymmetry, not one threshold", async () => {
    expect(await run(clientOf(async () => answer("queue", 0.8)))).toMatchObject({ action: "queue", layer: "model-override" });
    expect(await run(clientOf(async () => answer("steer", 0.8)), "queue")).toMatchObject({ action: "queue", layer: "preference-default" });
  });

  it("a model that agrees with the preference credits the preference, not itself", async () => {
    const decision = await run(clientOf(async () => answer("queue", 0.95)), "queue");
    expect(decision).toMatchObject({ action: "queue", layer: "preference-default", preference: "queue", detail: "model-agreed:queue" });
  });

  it("abstain is mandatory and maps to the user's preference", async () => {
    const decision = await run(clientOf(async () => answer("abstain", 0.9)));
    expect(decision).toMatchObject({ action: "steer", layer: "preference-default", detail: "abstain" });
    expect((await run(clientOf(async () => answer("abstain", 0.9)), "queue")).action).toBe("queue");
  });

  it("a failing decide falls back to the preference with a bounded reason", async () => {
    const decision = await run(clientOf(async () => { throw new Error("connection reset by peer"); }));
    expect(decision).toMatchObject({ action: "steer", layer: "preference-default", detail: "error: connection reset by peer" });
  });

  it("a slow decide is aborted at the budget and never delays the send past it", async () => {
    let observed: AbortSignal | undefined;
    const decision = await run(clientOf((signal) => new Promise<DecisionChoice>((_, reject) => {
      observed = signal;
      signal?.addEventListener("abort", () => reject(new Error("decision timed out")), { once: true });
    })));
    expect(decision).toMatchObject({ action: "steer", layer: "preference-default", detail: "timeout" });
    expect(observed?.aborted).toBe(true);
  });

  it("builds bounded state: truncated words, integer queue depth, positive elapsed time", () => {
    const built = buildAdmissionState({
      message: "x".repeat(2_000),
      runningTurnOpeningRequest: "y".repeat(900),
      runningTurnStartedAt: Date.now() - 2_500,
      queueDepth: 2.7,
      replyToRunningTurn: true,
      unattended: true,
      engine: "e".repeat(300),
      sender: "session",
    });
    expect(built.message).toHaveLength(1_000);
    expect(built.running_turn.opening_request).toHaveLength(500);
    expect(built.running_turn.elapsed_ms).toBeGreaterThanOrEqual(2_400);
    expect(built.queue_depth).toBe(2);
    expect(built.reply_to_running_turn).toBe(true);
    expect(built.unattended).toBe(true);
    expect(built.engine).toHaveLength(128);
    expect(validateAdmissionState(built)).toBe(built);
  });

  it("state without a known start still validates, just without the elapsed signal", () => {
    const built = buildAdmissionState({
      message: "no goal recorded",
      runningTurnOpeningRequest: null,
      runningTurnStartedAt: null,
      queueDepth: 0,
      replyToRunningTurn: false,
      unattended: false,
      engine: "codex",
      sender: "session",
    });
    expect(built.running_turn.elapsed_ms).toBeUndefined();
    expect(validateAdmissionState(built)).toBe(built);
  });

  it("the structural gate rejects foreign shapes before anything leaves the process", () => {
    expect(validateAdmissionState(null)).toBeNull();
    expect(validateAdmissionState({ ...state, extra: true })).toBeNull();
    expect(validateAdmissionState({ ...state, surface: "rooms" })).toBeNull();
    expect(validateAdmissionState({ ...state, queue_depth: -1 })).toBeNull();
    expect(validateAdmissionState({ ...state, message: 7 })).toBeNull();
    expect(validateAdmissionState({ ...state, reply_to_running_turn: "yes" })).toBeNull();
  });

  it("the steer prior is the reply-inside-the-running-turn signal", () => {
    expect(steerPrior(state)).toBe(false);
    expect(steerPrior({ ...state, reply_to_running_turn: true })).toBe(true);
  });

  it("the abort budget clamps into the designed 250–1500ms window", () => {
    expect(admissionBudgetMs(undefined)).toBe(1_000);
    expect(admissionBudgetMs(50)).toBe(250);
    expect(admissionBudgetMs(9_999)).toBe(1_500);
    expect(admissionBudgetMs(750)).toBe(750);
  });
});
