import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classifyAntigravityUsage, classifyClaudeUsage, classifyCodexUsage, classifyGrokUsage, usageLimitReset } from "./usage-classifiers.ts";
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./testing/fixtures/usage/${name}.json`, import.meta.url), "utf8"));

describe("usage classifiers", () => {
  it("reads real Codex windows and constructed notifications without mistaking empty extra credits for exhaustion", () => {
    const capture = fixture("codex-read-observed");
    expect(classifyCodexUsage(capture)).toMatchObject({ usage: { status: "ok", source: "reported", windows: [{ id: "codex:primary", remainingPercent: 93, resetsAt: new Date(capture.result.rateLimits.primary.resetsAt * 1000).toISOString() }, { remainingPercent: 99 }] } });
    const examples = fixture("codex-notifications-schema-examples").notifications;
    expect(classifyCodexUsage(examples[0]).usage?.windows).toHaveLength(2);
    expect(classifyCodexUsage(examples[1]).failure).toEqual({ kind: "usage_limit" });
    expect(classifyCodexUsage({ params: { turn: { error: { codexErrorInfo: "usageLimitExceeded" } } } }).failure?.kind).toBe("usage_limit");
  });
  it("keeps absent sparse values absent and distinguishes plan errors from throttling and local budgets", () => {
    expect(classifyCodexUsage({ params: { rateLimits: { limitId: "codex", primary: { usedPercent: null, resetsAt: null } } } }).usage?.windows?.[0]).toMatchObject({ remainingPercent: undefined, resetsAt: undefined });
    for (const code of ["rateLimitExceeded", "sessionBudgetExceeded", "contextWindowExceeded", "unauthorized"]) {
      expect(classifyCodexUsage({ params: { error: { codexErrorInfo: code } } }).failure).toBeUndefined();
    }
    expect(classifyCodexUsage({ result: { ordinaryUsageAllowed: false, rateLimits: { limitId: "codex", rateLimitReachedType: "workspace_owner_credits_depleted" } } }).usage?.status).toBe("exhausted");
  });
  it("handles passive Claude limits while leaving unverified percentages and resets unknown", () => {
    const events = fixture("claude-events-schema-examples").events;
    expect(classifyClaudeUsage(events[0])).toEqual({ usage: { status: "unknown", source: "reported" } });
    for (const event of events.slice(1)) {
      expect(classifyClaudeUsage(event).failure).toEqual({ kind: "usage_limit" });
      expect(classifyClaudeUsage(event).usage?.status).toBe("exhausted");
    }
    for (const error of ["rate_limit", "billing_error"]) expect(classifyClaudeUsage({ type: "assistant", error }).failure?.kind).toBe("usage_limit");
    for (const error of ["overloaded", "authentication_failed", "unknown"]) expect(classifyClaudeUsage({ type: "assistant", error }).failure).toBeUndefined();
    expect(classifyClaudeUsage(fixture("claude-events-schema-examples").otherErrorEvidence.result)).toEqual({});
  });
  it("does not turn binary string evidence or generic resource errors into invented wire contracts", () => {
    expect(classifyGrokUsage(fixture("grok-binary-observations"))).toEqual({});
    expect(classifyAntigravityUsage(fixture("antigravity-binary-observations"))).toEqual({});
    for (const payload of [null, "quota exceeded", { status: 429 }, { error: "RESOURCE_EXHAUSTED" }]) {
      expect(classifyAntigravityUsage(payload).failure).toBeUndefined();
      expect(classifyGrokUsage(payload).failure).toBeUndefined();
    }
  });
  it("returns a reset only when all exhausted windows have a known future reset", () => {
    const windows = [{ id: "p", label: "Current", remainingPercent: 0, resetsAt: "2030-01-01T00:00:00Z" }];
    expect(usageLimitReset(windows, 0)).toBe("2030-01-01T00:00:00Z");
    expect(usageLimitReset([...windows, { ...windows[0], id: "w", resetsAt: null }], 0)).toBeUndefined();
    expect(usageLimitReset(windows, Date.parse("2031-01-01"))).toBeUndefined();
  });
});
