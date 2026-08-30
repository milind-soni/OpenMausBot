import { describe, expect, it } from "vitest";

import type { IssueOwnerActionInput } from "../../collaboration/actions.ts";
import {
  issueDingTalkCandidateOwnerCard,
  isDingTalkCandidateOwnerCard,
  isDingTalkCandidateOwnerCardRequest,
  isDingTalkCandidateTextDecisionRequest,
  materializeDingTalkCandidateOwnerCard,
  materializeDingTalkCandidateTextDecision,
  renderDingTalkOwnerStatusCard,
} from "./cards.ts";

describe("DingTalk Owner status card", () => {
  it("carries only per-action opaque values and no client-side privilege claims", () => {
    const card = renderDingTalkOwnerStatusCard({
      cardTemplateId: "template-1",
      outTrackId: "out-track-1",
      title: "等待 Owner 决策",
      workItemId: "WI-1",
      status: "paused",
      summary: "候选已保留",
      actions: [{ label: "恢复", actionToken: "opaque-token" }],
    });
    expect(card).toMatchObject({ cardTemplateId: "template-1", outTrackId: "out-track-1", callbackType: "STREAM" });
    const serialized = JSON.stringify(card);
    expect(serialized).toContain("opaque-token");
    expect(serialized).not.toContain("administrator");
    expect(serialized).not.toContain("requiredRole");
    expect(serialized).not.toContain("expectedVersion");
  });

  it("renders a SHA-bound candidate decision card with accept and reject buttons", () => {
    const candidateSha = "2570cfb4692ad7775e261f403964d5585a95de7e";
    const card = renderDingTalkOwnerStatusCard({
      cardTemplateId: "template-1",
      outTrackId: "candidate-WI-1",
      title: "候选等待 Owner 验收",
      workItemId: "WI-1",
      status: "candidate_ready",
      summary: "目标测试已通过",
      candidateSha,
      actions: [
        { label: "接受候选", actionToken: "accept-opaque-token" },
        { label: "拒绝候选", actionToken: "reject-opaque-token" },
      ],
    });
    expect(card).toMatchObject({
      cardData: {
        cardParamMap: {
          title: "执行完成，请验收",
          status: "等待验收",
          actions: JSON.stringify([
            { id: "action-1", label: "接受候选" },
            { id: "action-2", label: "拒绝候选" },
          ]),
        },
      },
      privateData: {
        actionTokens: {
          "action-1": "accept-opaque-token",
          "action-2": "reject-opaque-token",
        },
      },
    });
    expect(JSON.stringify(card)).not.toContain(candidateSha);
  });

  it("issues server-side accept and reject tokens for one exact candidate version", () => {
    const issued: IssueOwnerActionInput[] = [];
    const card = issueDingTalkCandidateOwnerCard(
      {
        cardTemplateId: "template-1",
        outTrackId: "candidate-WI-1",
        workItemId: "WI-1",
        workItemVersion: 4,
        candidateSha: "2570cfb4692ad7775e261f403964d5585a95de7e",
        summary: "目标测试已通过",
        now: 1_000,
      },
      {
        issueOwnerAction(input) {
          issued.push(input);
          return {
            token: `${input.action}-opaque-token`,
            tokenVersion: 1,
            action: input.action,
            workItemId: input.workItemId,
            aggregateVersion: input.expectedVersion,
            candidateSha: input.candidateSha ?? null,
            expiresAt: 1_801_000,
          };
        },
      },
    );
    expect(issued).toEqual([
      {
        action: "accept",
        workItemId: "WI-1",
        expectedVersion: 4,
        candidateSha: "2570cfb4692ad7775e261f403964d5585a95de7e",
        ttlMs: 1_800_000,
        now: 1_000,
      },
      {
        action: "reject",
        workItemId: "WI-1",
        expectedVersion: 4,
        candidateSha: "2570cfb4692ad7775e261f403964d5585a95de7e",
        ttlMs: 1_800_000,
        now: 1_000,
      },
    ]);
    expect(card).toMatchObject({
      type: "plan_status_card",
      workItemId: "WI-1",
      workItemVersion: 4,
      candidateSha: "2570cfb4692ad7775e261f403964d5585a95de7e",
      actions: [
        { label: "接受候选", actionToken: "accept-opaque-token" },
        { label: "拒绝候选", actionToken: "reject-opaque-token" },
      ],
    });
  });

  it("materializes tokens only when a durable candidate request is delivered", () => {
    const request = {
      type: "plan_status_card" as const,
      headline: "候选已就绪" as const,
      cardTemplateId: "template-1",
      outTrackId: "candidate-run-1",
      workItemId: "WI-1",
      workItemVersion: 4,
      status: "candidate_ready" as const,
      summary: "目标测试已通过",
      candidateSha: "2".repeat(40),
      candidatePreview: "@@ -1 +1 @@\n-pending\n+hello pilot",
    };
    expect(isDingTalkCandidateOwnerCardRequest(request)).toBe(true);
    expect(isDingTalkCandidateOwnerCard(request)).toBe(false);
    const card = materializeDingTalkCandidateOwnerCard(request, {
      issueOwnerAction(input) {
        return {
          token: `${input.action}-ephemeral-token`,
          tokenVersion: 1,
          action: input.action,
          workItemId: input.workItemId,
          aggregateVersion: input.expectedVersion,
          candidateSha: input.candidateSha ?? null,
          expiresAt: 1_801_000,
        };
      },
    }, 1_000);
    expect(isDingTalkCandidateOwnerCard(card)).toBe(true);
    expect(card.actions.map((action) => action.actionToken)).toEqual([
      "accept-ephemeral-token",
      "reject-ephemeral-token",
    ]);
    expect(renderDingTalkOwnerStatusCard(card)).toMatchObject({
      cardData: {
        cardParamMap: {
          title: "执行完成，请验收",
          status: "等待验收",
          candidatePreview: expect.stringContaining("修改前"),
        },
      },
    });
    const visible = JSON.stringify(renderDingTalkOwnerStatusCard(card));
    expect(visible).toContain("修改后");
    expect(visible).toContain("hello pilot");
    expect(visible).not.toContain("candidate_ready");
    expect(visible).not.toContain("target_passed");
    expect(JSON.stringify(request)).not.toContain("ephemeral-token");
  });

  it("materializes the same SHA-bound decisions for ordinary messages", () => {
    const request = {
      type: "plan_status_card" as const,
      headline: "候选已就绪" as const,
      workItemId: "WI-1",
      workItemVersion: 7,
      status: "candidate_ready" as const,
      summary: "目标测试已通过",
      candidateSha: "3".repeat(40),
    };
    expect(isDingTalkCandidateTextDecisionRequest(request)).toBe(true);
    const issued: IssueOwnerActionInput[] = [];
    const message = materializeDingTalkCandidateTextDecision(request, {
      issueOwnerAction(input) {
        issued.push(input);
        return {
          token: `${input.action}_code_12345678901234567890123456789012`,
          tokenVersion: 1,
          action: input.action,
          workItemId: input.workItemId,
          aggregateVersion: input.expectedVersion,
          candidateSha: input.candidateSha ?? null,
          expiresAt: 1_801_000,
        };
      },
    }, 1_000);
    expect(issued).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "accept", expectedVersion: 7, candidateSha: "3".repeat(40) }),
      expect.objectContaining({ action: "reject", expectedVersion: 7, candidateSha: "3".repeat(40) }),
    ]));
    expect(message.actions).toHaveLength(2);
    expect(JSON.stringify(request)).not.toContain("_code_");
  });
});
