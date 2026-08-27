import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { FakeDingTalkAdapter } from "../integrations/dingtalk/fake-adapter.ts";
import type { DingTalkInboundMessage } from "../integrations/dingtalk/types.ts";
import type { PlannerProposal } from "./planner.ts";
import { policy, validProposal } from "./planner.test-fixtures.ts";
import { startCollaborationService } from "./service.ts";

const scratch: string[] = [];

afterEach(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "openmausbot-plan-reviser-"));
  scratch.push(directory);
  return directory;
}

function inboundMessage(): DingTalkInboundMessage {
  return {
    sourceEventId: "event-plan-1",
    transportMessageId: "transport-plan-1",
    conversationId: "conversation-plan-1",
    addressedToBot: true,
    text: "修复登录反馈",
    sender: {
      senderCorpId: "corp-1",
      senderStaffId: "owner-candidate",
      senderId: "sender-1",
      displayName: "Contributor",
    },
    receivedAt: 1_000,
  };
}

function createHarness(proposal: () => unknown = validProposal) {
  const directory = temporaryDirectory();
  const repository = join(directory, "fixture-repo");
  let plannerCalls = 0;
  const bootstrap = startCollaborationService({ dataDirectory: directory });
  const adapter = new FakeDingTalkAdapter((event) => bootstrap.ingestDingTalkMessage(event));
  const ingress = adapter.receive(inboundMessage());
  if (!ingress.accepted || !ingress.workItemId) throw new Error("Expected a Work Item");
  bootstrap.close();
  const service = startCollaborationService({
    dataDirectory: directory,
    planning: {
      planner: {
        propose() {
          plannerCalls += 1;
          return proposal();
        },
      },
      policy: { ...policy, allowedRepositories: [repository] },
    },
  });
  return {
    directory,
    repository,
    service,
    workItemId: ingress.workItemId,
    plannerCalls: () => plannerCalls,
  };
}

function database(directory: string): DatabaseSync {
  return new DatabaseSync(join(directory, "collaboration", "collaboration.sqlite"));
}

const definition = (repository: string) => ({
  goal: "登录失败时展示可操作反馈",
  goalConfirmed: true,
  repository,
  facts: ["空 token 可以稳定复现"],
  assumptions: [],
  acceptanceConditions: [
    { description: "空 token 时显示反馈", observation: "目标测试断言错误提示和下一步操作" },
  ],
  blockingAmbiguities: [],
});

describe("definition readiness and immutable plan revisions", () => {
  it("turns an accepted event into a durable clarification without a manual revision call", () => {
    const directory = temporaryDirectory();
    let plannerCalls = 0;
    const service = startCollaborationService({
      dataDirectory: directory,
      planning: {
        planner: { propose: () => (plannerCalls += 1, validProposal()) },
        policy: { ...policy, allowedRepositories: [join(directory, "fixture-repo")] },
      },
    });
    const adapter = new FakeDingTalkAdapter((event) => service.ingestDingTalkMessage(event));
    const result = adapter.receive(inboundMessage());
    expect(result).toMatchObject({ accepted: true, association: "created" });
    expect(plannerCalls).toBe(0);
    expect(service.pendingOutbox().map((entry) => entry.kind)).toContain("clarification_card");
    service.close();
    const db = database(directory);
    expect(db.prepare("SELECT definition_status FROM collaboration_work_items").get()).toEqual({
      definition_status: "waiting_clarification",
    });
    expect(db.prepare("SELECT facts_json FROM collaboration_work_item_snapshots").get()).toEqual({
      facts_json: JSON.stringify(["修复登录反馈"]),
    });
    db.close();
  });

  it("asks only the current clarification frontier and delays dependent acceptance", () => {
    const harness = createHarness();
    const first = harness.service.reviseWorkItemDefinition(
      harness.workItemId,
      {
        blockingAmbiguities: [
          {
            id: "page-boundary",
            question: "应该修改旧页面还是新页面？",
            dependsOn: [],
            recommendedAnswer: "选择当前线上入口。",
          },
          {
            id: "anonymous-compatibility",
            question: "是否需要兼容匿名用户？",
            dependsOn: ["page-boundary"],
            recommendedAnswer: "在入口确定后说明兼容范围。",
          },
          "是否修改文案？",
          "是否增加指标？",
        ],
      },
      2_000,
    );
    expect(first).toMatchObject({
      definitionStatus: "waiting_clarification",
      snapshotRevision: 1,
      planRevision: null,
      card: { type: "clarification_card" },
    });
    expect(first.clarificationQuestions).toHaveLength(3);
    expect(first.clarificationQuestions.map((question) => question.id)).toEqual(["goal", "repository", "page-boundary"]);
    expect(first.clarificationQuestions.some((question) => question.id === "anonymous-compatibility")).toBe(false);
    expect(first.clarificationQuestions.some((question) => question.id === "acceptance")).toBe(false);
    expect(harness.plannerCalls()).toBe(0);

    const second = harness.service.reviseWorkItemDefinition(
      harness.workItemId,
      {
        goal: "登录失败时展示可操作反馈",
        goalConfirmed: true,
        blockingAmbiguities: [],
      },
      3_000,
    );
    expect(second.clarificationQuestions.map((question) => question.id)).toEqual(["repository", "acceptance"]);
    expect(harness.plannerCalls()).toBe(0);
    const unconfigured = harness.service.reviseWorkItemDefinition(
      harness.workItemId,
      {
        repository: join(harness.directory, "not-configured"),
        acceptanceConditions: [
          { description: "错误反馈可见", observation: "目标测试断言错误反馈" },
        ],
      },
      4_000,
    );
    expect(unconfigured.clarificationQuestions.map((question) => question.id)).toEqual(["repository"]);
    expect(harness.plannerCalls()).toBe(0);
    harness.service.close();
  });

  it("automatically publishes a strict sequential graph when definition-ready", () => {
    const harness = createHarness();
    const outcome = harness.service.reviseWorkItemDefinition(
      harness.workItemId,
      definition(join(harness.directory, "fixture-repo")),
      2_000,
    );
    expect(outcome).toMatchObject({
      definitionStatus: "ready_for_execution",
      snapshotRevision: 1,
      planRevision: 1,
      clarificationQuestions: [],
      card: {
        type: "plan_status_card",
        headline: "计划已发布",
        status: "ready_for_execution",
        sequence: ["analyze", "modify", "validate", "report"],
      },
    });
    expect(harness.plannerCalls()).toBe(1);
    harness.service.close();

    const db = database(harness.directory);
    expect(db.prepare("SELECT definition_status FROM collaboration_work_items WHERE id = ?").get(harness.workItemId)).toEqual({
      definition_status: "ready_for_execution",
    });
    expect(
      db
        .prepare(
          "SELECT node_type, status, assigned_agent_id FROM collaboration_work_nodes " +
            "WHERE work_item_id = ? AND plan_revision = 1 ORDER BY rowid",
        )
        .all(harness.workItemId),
    ).toEqual([
      { node_type: "analyze", status: "ready", assigned_agent_id: "coordinator" },
      { node_type: "modify", status: "pending", assigned_agent_id: "developer-1" },
      { node_type: "validate", status: "pending", assigned_agent_id: "test-executor" },
      { node_type: "report", status: "pending", assigned_agent_id: "coordinator" },
    ]);
    expect(
      db.prepare("SELECT count(*) AS count FROM collaboration_work_edges WHERE work_item_id = ?").get(harness.workItemId),
    ).toEqual({ count: 3 });
    db.close();
  });

  it("records malformed, cyclic or over-capability output as observable planning failure", () => {
    const cyclic = validProposal();
    cyclic.nodes[0].dependsOn = ["report-evidence"];
    cyclic.nodes[1].agentId = "unconfigured-agent";
    cyclic.nodes[2].budget.maxTokens = 99_999;
    const harness = createHarness(() => cyclic);
    const outcome = harness.service.reviseWorkItemDefinition(
      harness.workItemId,
      definition(join(harness.directory, "fixture-repo")),
      2_000,
    );
    expect(outcome.definitionStatus).toBe("planning_failed");
    expect(outcome.failures?.join(" ")).toMatch(/unsupported|budget|acyclic/u);
    expect(outcome.card).toMatchObject({ type: "plan_status_card", headline: "计划生成失败" });
    harness.service.close();

    const db = database(harness.directory);
    expect(db.prepare("SELECT status, failure_json FROM collaboration_plan_revisions").get()).toMatchObject({
      status: "planning_failed",
    });
    expect(db.prepare("SELECT count(*) AS count FROM collaboration_work_nodes").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT definition_status FROM collaboration_work_items WHERE id = ?").get(harness.workItemId)).toEqual({
      definition_status: "planning_failed",
    });
    db.close();
  });

  it("creates immutable revisions and classifies prior nodes when acceptance changes", () => {
    let proposal: PlannerProposal = validProposal();
    const harness = createHarness(() => structuredClone(proposal));
    const repository = join(harness.directory, "fixture-repo");
    const first = harness.service.reviseWorkItemDefinition(harness.workItemId, definition(repository), 2_000);
    expect(first.planRevision).toBe(1);
    proposal = { ...validProposal(), summary: "修订后的计划仍保留固定顺序" };
    const second = harness.service.reviseWorkItemDefinition(
      harness.workItemId,
      {
        acceptanceConditions: [
          { description: "空 token 时显示反馈", observation: "目标测试断言错误提示和下一步操作" },
          { description: "合法 token 行为不变", observation: "登录成功回归测试通过" },
        ],
      },
      3_000,
    );
    expect(second).toMatchObject({ snapshotRevision: 2, planRevision: 2, definitionStatus: "ready_for_execution" });
    const third = harness.service.reviseWorkItemDefinition(harness.workItemId, {}, 4_000);
    expect(third).toMatchObject({ snapshotRevision: 3, planRevision: 3, definitionStatus: "ready_for_execution" });
    harness.service.close();

    const db = database(harness.directory);
    expect(db.prepare("SELECT revision, summary FROM collaboration_plan_revisions ORDER BY revision").all()).toEqual([
      { revision: 1, summary: "顺序完成分析、修改、验证和汇报" },
      { revision: 2, summary: "修订后的计划仍保留固定顺序" },
      { revision: 3, summary: "修订后的计划仍保留固定顺序" },
    ]);
    expect(db.prepare("SELECT count(*) AS count FROM collaboration_work_nodes").get()).toEqual({ count: 12 });
    expect(
      db
        .prepare(
          "SELECT classification, count(*) AS count FROM collaboration_plan_node_classifications " +
            "WHERE new_plan_revision = 2 GROUP BY classification ORDER BY classification",
        )
        .all(),
    ).toEqual([{ classification: "revalidate", count: 4 }]);
    expect(
      db
        .prepare(
          "SELECT classification, count(*) AS count FROM collaboration_plan_node_classifications " +
            "WHERE new_plan_revision = 3 GROUP BY classification",
        )
        .all(),
    ).toEqual([{ classification: "valid", count: 4 }]);
    expect(db.prepare("SELECT current_plan_revision FROM collaboration_work_items WHERE id = ?").get(harness.workItemId)).toEqual({
      current_plan_revision: 3,
    });
    expect(
      db
        .prepare(
          "SELECT plan_revision, active, count(*) AS count FROM collaboration_work_nodes " +
            "GROUP BY plan_revision, active ORDER BY plan_revision",
        )
        .all(),
    ).toEqual([
      { plan_revision: 1, active: 0, count: 4 },
      { plan_revision: 2, active: 0, count: 4 },
      { plan_revision: 3, active: 1, count: 4 },
    ]);
    expect(
      db.prepare("SELECT status, count(*) AS count FROM collaboration_planning_attempts GROUP BY status").all(),
    ).toEqual([{ status: "published", count: 3 }]);
    expect(
      db
        .prepare(
          "SELECT count(*) AS count FROM collaboration_outbox " +
            "WHERE supersession_key = ? AND sent_at IS NULL AND superseded_at IS NULL",
        )
        .get(`work-item:${harness.workItemId}:planning-status`),
    ).toEqual({ count: 1 });
    expect(() =>
      db.prepare("UPDATE collaboration_work_item_snapshots SET goal = 'rewritten' WHERE work_item_id = ?").run(
        harness.workItemId,
      ),
    ).toThrow("work item snapshots are immutable");
    expect(() =>
      db.prepare("UPDATE collaboration_plan_revisions SET summary = 'rewritten' WHERE work_item_id = ?").run(
        harness.workItemId,
      ),
    ).toThrow("plan revisions are immutable");
    db.close();
  });

  it("classifies all previous nodes obsolete when the confirmed goal changes", () => {
    const harness = createHarness();
    const repository = join(harness.directory, "fixture-repo");
    harness.service.reviseWorkItemDefinition(harness.workItemId, definition(repository), 2_000);
    harness.service.reviseWorkItemDefinition(
      harness.workItemId,
      { goal: "改为重构整个认证流程", goalConfirmed: true },
      3_000,
    );
    harness.service.close();
    const db = database(harness.directory);
    expect(
      db
        .prepare(
          "SELECT classification, count(*) AS count FROM collaboration_plan_node_classifications " +
            "WHERE new_plan_revision = 2 GROUP BY classification",
        )
        .all(),
    ).toEqual([{ classification: "obsolete", count: 4 }]);
    db.close();
  });

  it("fences a slower planner result after a newer snapshot publishes", () => {
    const directory = temporaryDirectory();
    const repository = join(directory, "fixture-repo");
    const bootstrap = startCollaborationService({ dataDirectory: directory });
    const ingress = new FakeDingTalkAdapter((event) => bootstrap.ingestDingTalkMessage(event)).receive(inboundMessage());
    if (!ingress.accepted || !ingress.workItemId) throw new Error("Expected Work Item");
    const workItemId = ingress.workItemId;
    bootstrap.close();

    let calls = 0;
    let service: ReturnType<typeof startCollaborationService>;
    service = startCollaborationService({
      dataDirectory: directory,
      planning: {
        policy: { ...policy, allowedRepositories: [repository] },
        planner: {
          propose() {
            calls += 1;
            if (calls === 1) {
              const newer = service.reviseWorkItemDefinition(workItemId, { facts: ["newer requirement"] }, 3_000);
              expect(newer.definitionStatus).toBe("ready_for_execution");
            }
            return validProposal();
          },
        },
      },
    });
    expect(() => service.reviseWorkItemDefinition(workItemId, definition(repository), 2_000)).toThrow("superseded");
    service.close();
    const db = database(directory);
    expect(db.prepare("SELECT snapshot_revision, status FROM collaboration_planning_attempts ORDER BY snapshot_revision").all()).toEqual([
      { snapshot_revision: 1, status: "stale" },
      { snapshot_revision: 2, status: "published" },
    ]);
    expect(db.prepare("SELECT snapshot_revision, status FROM collaboration_plan_revisions").all()).toEqual([
      { snapshot_revision: 2, status: "published" },
    ]);
    db.close();
  });
});
