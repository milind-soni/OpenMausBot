import { beforeEach, describe, expect, it } from "vitest";

import {
  _resetExternalReviewerState,
  buildReviewContextFromMessages,
  compactRawInput,
  evaluateExternalApprovalReview,
  externalApprovalReviewerConfig,
  isStrictReadOnlyCacheable,
  redactSecretsOnly,
} from "./external-approval-reviewer.ts";

describe("externalApprovalReviewerConfig", () => {
  it("is disabled by default and enables cleanly via config or env", () => {
    expect(externalApprovalReviewerConfig({}, {}).enabled).toBe(false);
    expect(externalApprovalReviewerConfig({ externalApprovalReviewer: { enabled: true } }, {}).enabled).toBe(true);
    expect(externalApprovalReviewerConfig({}, { OMB_EXTERNAL_APPROVAL_REVIEWER: "1" }).enabled).toBe(true);
    expect(externalApprovalReviewerConfig({ externalApprovalReviewer: { enabled: true } }, { OMB_EXTERNAL_APPROVAL_REVIEWER: "0" }).enabled).toBe(false);
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

  it("redacts secrets in payloads and compacts large nested rawInput while preserving priority keys", () => {
    expect(redactSecretsOnly("Authorization: Bearer super_secret_token_123456")).toContain("<REDACTED>");
    const compacted = compactRawInput({
      z_blob: "x".repeat(2500),
      toolSummary: "Click unread button",
      pid: 42,
    });
    expect(compacted.indexOf("pid")).toBeLessThan(compacted.indexOf("z_blob"));
    expect(compacted).toContain("Click unread button");
    expect(compacted).toContain("truncated");
  });

  it("classifies strict read-only cacheable tools conservatively", () => {
    expect(isStrictReadOnlyCacheable({ tool: "other", summary: "Run mcp_computer_get_guide", approvalScope: "local-computer" })).toBe(true);
    expect(isStrictReadOnlyCacheable({ tool: "other", summary: "Run mcp_computer_run_steps", approvalScope: "local-computer" })).toBe(false);
    expect(isStrictReadOnlyCacheable({ tool: "shell", command: "ls -la" })).toBe(true);
    expect(isStrictReadOnlyCacheable({ tool: "shell", command: "rm -rf /tmp/a" })).toBe(false);
  });
});

describe("evaluateExternalApprovalReview", () => {
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

  it("never retries a legitimate ask or deny verdict", async () => {
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
