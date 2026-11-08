import { describe, expect, it } from "vitest";

import { BACKOFF_BASE_MS, RETRY_MAX_ATTEMPTS, classifyError, computeBackoff, mayResendTurn } from "./retry.ts";

describe("classifyError", () => {
  it("does not retry a provider safety block even inside a 503 or rate-limit error", () => {
    for (const text of ["HTTP 503: blocked by our safety systems", "429: safety monitoring paused this task"]) {
      expect(classifyError({ text })).toEqual({ transient: false, reason: "provider_safety" });
      expect(classifyError({ exitCode: 1, stderr: text })).toEqual({ transient: false, reason: "provider_safety" });
    }
    expect(classifyError({ text: "503: checking deployment safety" }).reason).toBe("server_error");
  });
  it("calls provider rate limits transient", () => {
    expect(classifyError(new Error("xAI HTTP 429: Too Many Requests"))).toEqual({
      transient: true,
      reason: "rate_limited",
    });
    expect(classifyError({ text: "rate limit exceeded, slow down" })).toEqual({
      transient: true,
      reason: "rate_limited",
    });
  });

  it("calls 5xx and overloaded transient", () => {
    expect(classifyError(new Error("xAI HTTP 503: Service Unavailable"))).toEqual({
      transient: true,
      reason: "server_error",
    });
    expect(classifyError(new Error("Internal Server Error"))).toEqual({ transient: true, reason: "server_error" });
    expect(classifyError(new Error("The API is temporarily overloaded"))).toEqual({
      transient: true,
      reason: "overloaded",
    });
    expect(classifyError(new Error("upstream error (529 overloaded)"))).toEqual({
      transient: true,
      reason: "overloaded",
    });
  });

  it("calls Codex's failed workspace routing discovery transient, but not a refused sign-in", () => {
    expect(classifyError({ text: "stream error: workspace routing discovery failed: error sending request" })).toEqual({ transient: true, reason: "server_error" });
    expect(classifyError(new Error("workspace routing discovery timed out"))).toEqual({ transient: true, reason: "server_error" });
    expect(classifyError({ exitCode: 1, stderr: "Error: workspace routing discovery failed" })).toEqual({ transient: true, reason: "server_error" });
    expect(classifyError({ text: "workspace routing discovery unauthorized (401)" })).toEqual({ transient: false, reason: "auth" });
  });

  it("calls connection failures and timeouts transient", () => {
    expect(classifyError(new Error("fetch failed"))).toMatchObject({ transient: true });
    expect(classifyError(new Error("read ECONNRESET"))).toMatchObject({ transient: true, reason: "connection_reset" });
    expect(classifyError(new Error("request timed out after 120000ms"))).toMatchObject({
      transient: true,
      reason: "timeout",
    });
  });

  it("never retries auth, quota, unknown model, or invalid request", () => {
    expect(classifyError(new Error("unexpected status 401 Unauthorized: Missing bearer"))).toEqual({
      transient: false,
      reason: "auth",
    });
    expect(classifyError(new Error("invalid api key"))).toEqual({ transient: false, reason: "auth" });
    expect(classifyError(new Error("quota exceeded for this plan"))).toEqual({ transient: false, reason: "quota" });
    expect(classifyError(new Error("model not found: grok-99"))).toEqual({
      transient: false,
      reason: "unknown_model",
    });
    expect(classifyError(new Error("400 invalid request body"))).toEqual({
      transient: false,
      reason: "invalid_request",
    });
  });

  it("treats a bare nonzero CLI exit as terminal", () => {
    expect(classifyError({ exitCode: 3 })).toEqual({ transient: false, reason: "terminal_exit" });
  });

  it("never retries a signal kill or interrupt", () => {
    expect(classifyError({ exitCode: -1 })).toEqual({ transient: false, reason: "interrupted" });
    expect(classifyError(new Error("interrupted"))).toEqual({ transient: false, reason: "interrupted" });
    expect(classifyError(new Error("turn cancelled by user"))).toEqual({ transient: false, reason: "interrupted" });
  });

  it("prefers the transient reading when stderr carries both shapes", () => {
    expect(classifyError({ exitCode: 1, stderr: "error: 429 too many requests" })).toEqual({
      transient: true,
      reason: "rate_limited",
    });
  });

  it("classifies unrecognizable input as terminal", () => {
    expect(classifyError(null)).toEqual({ transient: false, reason: "unknown" });
    expect(classifyError(new Error(""))).toEqual({ transient: false, reason: "unknown" });
  });
});

describe("mayResendTurn", () => {
  const failed = { endedBeforeTurn: false, exitCode: 5, transient: true, streamed: false, answered: false, attempt: 0 };

  it("resends a launch that never took the prompt, and a transient failure before anything answered", () => {
    expect(mayResendTurn({ ...failed, endedBeforeTurn: true, answered: true, transient: false })).toBe(true);
    expect(mayResendTurn(failed)).toBe(true);
  });

  it("never resends once a model call answered or text streamed", () => {
    expect(mayResendTurn({ ...failed, answered: true })).toBe(false);
    expect(mayResendTurn({ ...failed, streamed: true })).toBe(false);
  });

  it("never resends a clean exit, a terminal failure, or past the attempt cap", () => {
    expect(mayResendTurn({ ...failed, exitCode: 0 })).toBe(false);
    expect(mayResendTurn({ ...failed, transient: false })).toBe(false);
    expect(mayResendTurn({ ...failed, attempt: RETRY_MAX_ATTEMPTS - 1 })).toBe(false);
  });
});

describe("computeBackoff", () => {
  it("follows the capped exponential schedule", () => {
    expect(BACKOFF_BASE_MS).toHaveLength(RETRY_MAX_ATTEMPTS);
    for (const [attempt, base] of BACKOFF_BASE_MS.entries()) {
      const mid = computeBackoff(attempt, () => 0.5);
      expect(mid).toBe(base);
    }
  });

  it("jitter stays within ±25% of the schedule", () => {
    for (const attempt of [0, 1, 2, 5]) {
      const low = computeBackoff(attempt, () => 0);
      const high = computeBackoff(attempt, () => 1);
      const base = BACKOFF_BASE_MS[Math.min(attempt, BACKOFF_BASE_MS.length - 1)];
      expect(low).toBeGreaterThanOrEqual(base * 0.75);
      expect(high).toBeLessThanOrEqual(base * 1.25 + 1);
    }
  });
});

describe("classifyError — usage limits", () => {
  it("keeps a generic short-lived 429 transient in both transport shapes", () => {
    const text = "HTTP 429: rate limit reached; retry after 1s";
    expect(classifyError({ text })).toEqual({ transient: true, reason: "rate_limited" });
    expect(classifyError({ exitCode: 1, stderr: text })).toEqual({ transient: true, reason: "rate_limited" });
    expect(classifyError({ exitCode: 1, stderr: "API Error: 429 Rate limit reached: weekly limit reached" })).toEqual({ transient: false, reason: "quota" });
  });
  it("calls a subscription usage limit a quota problem, not a retry", () => {
    for (const text of [
      "You've hit your usage limit for this session. Try again at 7pm.",
      "Usage limit reached for Claude Max",
      "Rate limit reached: weekly limit reached",
      "You are out of credits",
      // Claude Code 2.1.295 names what ran out; the first matched no pattern
      "You've hit your weekly limit \u00b7 resets Oct 12 at 2:30pm (Asia/Calcutta)",
      "You've hit your session limit \u00b7 resets 3pm",
      "You've hit your Opus limit",
      "You've hit your org's monthly spend limit.",
      "You've hit your team's shared budget. /model to switch models.",
      "You're out of usage credits. Contact your admin to add more.",
      "You're out of extra usage",
    ]) {
      expect(classifyError({ text }), text).toEqual({ transient: false, reason: "quota" });
      expect(classifyError({ exitCode: 1, stderr: text }), text).toEqual({ transient: false, reason: "quota" });
    }
  });

  it("keeps a per-minute rate limit transient, however it is worded", () => {
    for (const text of ["You've hit your rate limit, retry in 5s", "You hit your API rate limit"]) {
      expect(classifyError({ text }), text).toEqual({ transient: true, reason: "rate_limited" });
    }
  });
});
