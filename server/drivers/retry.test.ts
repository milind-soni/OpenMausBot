import { describe, expect, it } from "vitest";

import { BACKOFF_BASE_MS, RETRY_MAX_ATTEMPTS, classifyError, computeBackoff } from "./retry.ts";

describe("classifyError", () => {
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
    // a crash whose stderr mentions throttling is worth one more try
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
