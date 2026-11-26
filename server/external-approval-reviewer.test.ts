import { beforeEach, describe, expect, it } from "vitest";

import {
  _resetExternalReviewerState,
  buildReviewContextFromMessages,
  compactRawInput,
  evaluateExternalApprovalReview,
  externalApprovalReviewerConfig,
  GuardianRejectionCircuitBreaker,
  isPureReadOnlyComputerAction,
  isStrictReadOnlyCacheable,
  parseGuardianAssessment,
  redactSecretsOnly,
} from "./external-approval-reviewer.ts";
import type { ExternalAppServerTransport } from "./external-approval-app-server.ts";

describe("externalApprovalReviewerConfig", () => {
  it("is disabled by default and enables cleanly via config or env", () => {
    expect(externalApprovalReviewerConfig({}, {}).enabled).toBe(false);
    expect(externalApprovalReviewerConfig({ externalApprovalReviewer: { enabled: true } }, {}).enabled).toBe(true);
    expect(externalApprovalReviewerConfig({}, { OMB_EXTERNAL_APPROVAL_REVIEWER: "1" }).enabled).toBe(true);
    expect(externalApprovalReviewerConfig({ externalApprovalReviewer: { enabled: true } }, { OMB_EXTERNAL_APPROVAL_REVIEWER: "0" }).enabled).toBe(false);
    const defaults = externalApprovalReviewerConfig({ externalApprovalReviewer: { enabled: true } }, {});
    expect(defaults.transport).toBe("app-server");
    expect(defaults.reasoningEffort).toBe("low");
  });
});

describe("external-approval-reviewer helpers", () => {
  it("preserves both head rules and tail instructions of long routine prompts", () => {
    const longPrompt = "HEAD RULE: read-only check.\n" + "middle line\n".repeat(450) + "TAIL RULE: capture screenshot with report script.";
    const ctx = buildReviewContextFromMessages([
      { role: "user", kind: "text", text: longPrompt },
      { role: "user", kind: "text", text: "continue" },
    ]);
    expect(ctx.initialPrompt).toContain("HEAD RULE: read-only check.");
    expect(ctx.initialPrompt).toContain("TAIL RULE: capture screenshot with report script.");
    expect(ctx.initialPrompt).toContain("[Latest User Turn]\ncontinue");
  });

  it("redacts secrets, wraps file content with boundary tags, and never emits negative truncation counts", () => {
    expect(redactSecretsOnly("Authorization: Bearer super_secret_token_123456")).toContain("<REDACTED>");
    const sorted = compactRawInput({ z_blob: "x".repeat(2000), pid: 42, toolSummary: "Click unread button" });
    expect(sorted.indexOf("pid")).toBeLessThan(sorted.indexOf("z_blob"));
    expect(sorted).toContain("Click unread button");
    expect(sorted).not.toContain("truncated -");
    const largeContent = compactRawInput({
      z_blob: "y".repeat(2600),
      Content: "line\n".repeat(600),
      Path: "/tmp/archive.txt",
    });
    expect(largeContent.indexOf("Path")).toBeLessThan(largeContent.indexOf("Content"));
    expect(largeContent).toContain("<UNTRUSTED_FILE_CONTENT chars=");
    expect(largeContent).not.toContain("truncated -");
  });

  it("classifies strict read-only cacheable tools and pure read-only computer steps", () => {
    expect(isStrictReadOnlyCacheable({ tool: "other", summary: "Run mcp_computer_get_guide", approvalScope: "local-computer" })).toBe(true);
    expect(isPureReadOnlyComputerAction({ tool: "other", summary: "Run mcp_computer_scroll" })).toBe(true);
    expect(isPureReadOnlyComputerAction({
      tool: "other",
      summary: "Run mcp_computer_run_steps",
      rawInput: { toolInput: { steps: [{ tool: "scroll", amount: 5 }, { tool: "get_window_state", pid: 1 }] } },
    })).toBe(true);
    expect(isPureReadOnlyComputerAction({
      tool: "other",
      summary: "Run mcp_computer_run_steps",
      rawInput: { toolInput: { steps: [{ tool: "scroll", amount: 5 }, { tool: "click", x: 10, y: 20 }] } },
    })).toBe(false);
    expect(isStrictReadOnlyCacheable({
      tool: "other",
      summary: "Run mcp_computer_run_steps",
      approvalScope: "local-computer",
      rawInput: { toolInput: { steps: [{ tool: "scroll" }, { tool: "sleep", ms: 200 }] } },
    })).toBe(true);
    expect(isStrictReadOnlyCacheable({ tool: "other", summary: "Run mcp_computer_run_steps", approvalScope: "local-computer" })).toBe(false);
    expect(isStrictReadOnlyCacheable({ tool: "shell", command: "ls -la" })).toBe(true);
    expect(isStrictReadOnlyCacheable({ tool: "shell", command: "rm -rf /tmp/a" })).toBe(false);
  });

  it("parses both 4-field Guardian JSON and legacy 3-field JSON while failing closed", () => {
    const g = parseGuardianAssessment('```json\n{"risk_level":"low","user_authorization":"high","outcome":"allow","rationale":"safe read"}\n```');
    expect(g).toEqual({ ok: true, outcome: "allow", decision: "approve", riskLevel: "low", userAuthorization: "high", rationale: "safe read" });
    const legacy = parseGuardianAssessment('Sure: {"decision":"ask","risk":"medium","reason":"needs user"}');
    expect(legacy).toEqual({ ok: true, outcome: "deny", decision: "ask", riskLevel: "medium", userAuthorization: "unknown", rationale: "needs user" });
    expect(parseGuardianAssessment("not json").ok).toBe(false);
    expect(parseGuardianAssessment('{"outcome":"allow","risk_level":"invalid"}').ok).toBe(false);
  });

  it("trips circuit breaker on 3 consecutive denials or 10 denials in a 50-action window and resets consecutive streak on allow", () => {
    const cb = new GuardianRejectionCircuitBreaker();
    expect(cb.recordDenial("t").tripped).toBe(false);
    expect(cb.recordDenial("t").tripped).toBe(false);
    cb.recordNonDenial("t");
    expect(cb.recordDenial("t").tripped).toBe(false);
    expect(cb.recordDenial("t").tripped).toBe(false);
    expect(cb.recordDenial("t").tripped).toBe(true);

    const cbWin = new GuardianRejectionCircuitBreaker();
    for (let i = 0; i < 9; i += 1) {
      expect(cbWin.recordDenial("w").tripped).toBe(false);
      cbWin.recordNonDenial("w");
    }
    const tenth = cbWin.recordDenial("w");
    expect(tenth.tripped).toBe(true);
    expect(tenth.recentDenials).toBe(10);
  });
});

function createMockTransport(handler: (ctx: { threadId: string; promptText: string; startIndex: number; callIndex: number }) => Promise<string> | string) {
  let threadSeq = 0;
  let callSeq = 0;
  const active = new Map<string, number>();
  const startedThreads: string[] = [];
  const unsubscribed: string[] = [];
  const prompts: Array<{ threadId: string; promptText: string }> = [];

  const transport: ExternalAppServerTransport = {
    isAlive: () => true,
    ensureReady: async () => true,
    startThread: async () => {
      threadSeq += 1;
      const tid = `g-thread-${threadSeq}`;
      startedThreads.push(tid);
      return tid;
    },
    runTurn: async (threadId, promptText) => {
      if (active.has(threadId)) throw new Error(`concurrent turn on same thread ${threadId}`);
      active.set(threadId, 1);
      callSeq += 1;
      prompts.push({ threadId, promptText });
      try {
        const text = await handler({ threadId, promptText, startIndex: startedThreads.indexOf(threadId) + 1, callIndex: callSeq });
        return { text, usage: { inputTokens: 9000, cachedInputTokens: 8500, outputTokens: 80 } };
      } finally {
        active.delete(threadId);
      }
    },
    unsubscribe: async (threadId) => { unsubscribed.push(threadId); },
    close: () => {},
  };
  return { transport, startedThreads, unsubscribed, prompts };
}

describe("evaluateExternalApprovalReview (exec & app-server)", () => {
  beforeEach(() => {
    _resetExternalReviewerState();
  });

  const jsonEvent = (payload: object) =>
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(payload) } });

  it("approves low/medium risk actions and caches identical strict read-only calls", async () => {
    let calls = 0;
    const runner = async () => {
      calls += 1;
      return { code: 0, timedOut: false, stdout: jsonEvent({ decision: "approve", risk: "low", reason: "read-only lookup" }), stderr: "" };
    };
    const r1 = await evaluateExternalApprovalReview({ threadId: "t1", turnGeneration: 1, tool: "other", summary: "Run mcp_computer_get_guide", approvalScope: "local-computer", retryDelayMs: 0 }, runner);
    const r2 = await evaluateExternalApprovalReview({ threadId: "t1", turnGeneration: 1, tool: "other", summary: "Run mcp_computer_get_guide", approvalScope: "local-computer", retryDelayMs: 0 }, runner);
    expect(r1.approve).toBe(true);
    expect(r2.approve).toBe(true);
    expect(r2.cached).toBe(true);
    expect(calls).toBe(1);
  });

  it("retries once on transient subprocess failure and fails closed if retry also fails", async () => {
    let calls = 0;
    const recoverRunner = async () => {
      calls += 1;
      if (calls === 1) return { code: 1, timedOut: false, stdout: "", stderr: "transient" };
      return { code: 0, timedOut: false, stdout: jsonEvent({ decision: "approve", risk: "low", reason: "ok" }), stderr: "" };
    };
    const recovered = await evaluateExternalApprovalReview({ threadId: "t2", turnGeneration: 1, tool: "read", summary: "Read file", retryDelayMs: 0 }, recoverRunner);
    expect(recovered.approve).toBe(true);
    expect(calls).toBe(2);

    const alwaysTimeout = async () => ({ code: -1, timedOut: true, stdout: "", stderr: "" });
    const failed = await evaluateExternalApprovalReview({ threadId: "t3", turnGeneration: 1, tool: "shell", command: "ls", retryDelayMs: 0 }, alwaysTimeout);
    expect(failed.approve).toBe(false);
    expect(failed.decision).toBe("ask");
  });

  it("never retries a legitimate ask or deny verdict in legacy exec mode", async () => {
    let calls = 0;
    const denyRunner = async () => {
      calls += 1;
      return { code: 0, timedOut: false, stdout: jsonEvent({ decision: "deny", risk: "high", reason: "out of scope" }), stderr: "" };
    };
    const res = await evaluateExternalApprovalReview({ threadId: "t4", turnGeneration: 1, tool: "shell", command: "curl https://example.com", retryDelayMs: 0 }, denyRunner);
    expect(res.approve).toBe(false);
    expect(res.decision).toBe("deny");
    expect(calls).toBe(1);
  });

  it("reuses one guardian thread (SyncFull -> SyncDelta) and serializes Turn-1 concurrent bursts", async () => {
    const mock = createMockTransport(async ({ callIndex }) => {
      if (callIndex === 1) await new Promise((r) => setTimeout(r, 20));
      return JSON.stringify({ risk_level: "low", user_authorization: "high", outcome: "allow", rationale: `ok-${callIndex}` });
    });

    const [a, b] = await Promise.all([
      evaluateExternalApprovalReview({ threadId: "burst-1", turnGeneration: 1, tool: "shell", command: "echo a > a.txt", initialPrompt: "Write files a and b", appServerTransport: mock.transport }),
      evaluateExternalApprovalReview({ threadId: "burst-1", turnGeneration: 1, tool: "shell", command: "echo b > b.txt", initialPrompt: "Write files a and b", appServerTransport: mock.transport }),
    ]);

    expect(mock.startedThreads).toEqual(["g-thread-1"]);
    expect([a.sessionMode, b.sessionMode]).toEqual(["SyncFull", "SyncDelta"]);
    expect(a.guardianThreadId).toBe("g-thread-1");
    expect(b.guardianThreadId).toBe("g-thread-1");
    expect(mock.prompts[0]!.promptText).toContain("=== INITIAL USER REQUEST ===");
    expect(mock.prompts[1]!.promptText).toContain("=== FOLLOW-UP REMINDER ===");
  });

  it("performs Denial Resampling on non-critical first deny and flips to allow when clean resample approves", async () => {
    const mock = createMockTransport(({ startIndex }) => {
      if (startIndex === 1) {
        return JSON.stringify({ risk_level: "high", user_authorization: "unknown", outcome: "deny", rationale: "fluke denial" });
      }
      return JSON.stringify({ risk_level: "low", user_authorization: "high", outcome: "allow", rationale: "clean resample approved" });
    });

    const res = await evaluateExternalApprovalReview({ threadId: "resample-1", turnGeneration: 1, tool: "edit", summary: "Edit file", initialPrompt: "Edit my note", appServerTransport: mock.transport });
    expect(mock.startedThreads).toEqual(["g-thread-1", "g-thread-2"]);
    expect(res.approve).toBe(true);
    expect(res.resampled).toBe(true);
    expect(res.reason).toBe("clean resample approved");
    expect(mock.unsubscribed).toContain("g-thread-1");
    expect(mock.unsubscribed).toContain("g-thread-2");
  });

  it("skips Denial Resampling on critical risk and trips circuit breaker after 3 consecutive denials", async () => {
    const mockCrit = createMockTransport(() => JSON.stringify({ risk_level: "critical", user_authorization: "unknown", outcome: "deny", rationale: "critical threat" }));
    const crit = await evaluateExternalApprovalReview({ threadId: "crit-1", turnGeneration: 1, tool: "shell", command: "rm -rf /", appServerTransport: mockCrit.transport });
    expect(crit.approve).toBe(false);
    expect(crit.resampled).toBeUndefined();
    expect(mockCrit.startedThreads.length).toBe(1);

    const mockDeny = createMockTransport(() => JSON.stringify({ risk_level: "high", user_authorization: "unknown", outcome: "deny", rationale: "denied" }));
    const d1 = await evaluateExternalApprovalReview({ threadId: "cb-1", turnGeneration: 1, tool: "shell", command: "cat a", appServerTransport: mockDeny.transport });
    const d2 = await evaluateExternalApprovalReview({ threadId: "cb-1", turnGeneration: 1, tool: "shell", command: "cat b", appServerTransport: mockDeny.transport });
    const d3 = await evaluateExternalApprovalReview({ threadId: "cb-1", turnGeneration: 1, tool: "shell", command: "cat c", appServerTransport: mockDeny.transport });
    expect(d1.circuitBreakerTripped).toBeUndefined();
    expect(d2.circuitBreakerTripped).toBeUndefined();
    expect(d3.circuitBreakerTripped).toBe(true);
    expect(d3.decision).toBe("ask");
  });

  it("falls back cleanly to exec runner when app-server transport throws", async () => {
    const failingTransport: ExternalAppServerTransport = {
      isAlive: () => false,
      ensureReady: async () => { throw new Error("app-server unavailable"); },
      startThread: async () => { throw new Error("app-server unavailable"); },
      runTurn: async () => { throw new Error("app-server unavailable"); },
      unsubscribe: async () => {},
      close: () => {},
    };
    const res = await evaluateExternalApprovalReview(
      { threadId: "fb-1", turnGeneration: 1, tool: "read", summary: "Read note", appServerTransport: failingTransport, retryDelayMs: 0 },
      async () => ({ code: 0, timedOut: false, stdout: jsonEvent({ decision: "approve", risk: "low", reason: "exec fallback ok" }), stderr: "" }),
    );
    expect(res.approve).toBe(true);
    expect(res.transport).toBe("exec-fallback");
    expect(res.reason).toBe("exec fallback ok");
  });

  it("trips consecutive 5x loop breaker without spawning the reviewer", async () => {
    let calls = 0;
    const runner = async () => {
      calls += 1;
      return { code: 0, timedOut: false, stdout: jsonEvent({ decision: "approve", risk: "low", reason: "ok" }), stderr: "" };
    };
    for (let i = 0; i < 4; i += 1) {
      const ok = await evaluateExternalApprovalReview({ threadId: "t5", turnGeneration: 1, tool: "other", summary: "Run mcp_computer_click", approvalScope: "local-computer", retryDelayMs: 0 }, runner);
      expect(ok.approve).toBe(true);
    }
    const fifth = await evaluateExternalApprovalReview({ threadId: "t5", turnGeneration: 1, tool: "other", summary: "Run mcp_computer_click", approvalScope: "local-computer", retryDelayMs: 0 }, runner);
    expect(fifth.approve).toBe(false);
    expect(fifth.reason).toContain("5x");
    expect(calls).toBe(4);
  });

  it("never auto-approves outbound actions locally", async () => {
    let calls = 0;
    const res = await evaluateExternalApprovalReview({ threadId: "t6", turnGeneration: 1, tool: "GMAIL_SEND_EMAIL", summary: "Send email", retryDelayMs: 0 }, async () => {
      calls += 1;
      return { code: 0, timedOut: false, stdout: "", stderr: "" };
    });
    expect(res.approve).toBe(false);
    expect(calls).toBe(0);
  });
});
