import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { validateSequentialPlan, type PlanningPolicy, type ValidatedSequentialPlan } from "./graph.ts";
import { renderClarificationCard, renderPlanStatusCard, type InboundCard } from "./message-renderer.ts";
import { enqueueInboundCard } from "./outbox.ts";
import { parsePlannerProposal, PlanValidationError, type PlannerPort, type WorkNodeType } from "./planner.ts";
import { evaluateDefinitionReadiness, type ClarificationQuestion } from "./readiness.ts";
import { assertLedgerArmed } from "./restore-guard.ts";
import {
  appendWorkItemSnapshot,
  readLatestWorkItemSnapshot,
  readWorkItemSnapshotRevision,
  type WorkItemSnapshot,
  type WorkItemSnapshotPatch,
} from "./snapshot.ts";

export type PriorNodeClassification = "valid" | "revalidate" | "obsolete";

export interface DefinitionRevisionOutcome {
  workItemId: string;
  snapshotRevision: number;
  definitionStatus: "waiting_clarification" | "ready_for_execution" | "planning_failed";
  clarificationQuestions: ClarificationQuestion[];
  planRevision: number | null;
  card: InboundCard;
  failures?: string[];
}

export interface PlanningCoordinatorOptions {
  planner: PlannerPort;
  policy: PlanningPolicy;
  defaultDefinition?: {
    repository: string;
    acceptanceConditions: WorkItemSnapshot["acceptanceConditions"];
  };
}

function equal(value: unknown, other: unknown): boolean {
  return JSON.stringify(value) === JSON.stringify(other);
}

export function classifyPreviousPlanNodes(
  previous: WorkItemSnapshot,
  current: WorkItemSnapshot,
): Record<WorkNodeType, { classification: PriorNodeClassification; reason: string }> {
  if (previous.goal !== current.goal || previous.repository !== current.repository) {
    return Object.fromEntries(
      ["analyze", "modify", "validate", "report"].map((type) => [
        type,
        { classification: "obsolete", reason: "goal or repository changed" },
      ]),
    ) as Record<WorkNodeType, { classification: PriorNodeClassification; reason: string }>;
  }
  if (!equal(previous.facts, current.facts) || !equal(previous.assumptions, current.assumptions)) {
    return Object.fromEntries(
      ["analyze", "modify", "validate", "report"].map((type) => [
        type,
        { classification: "revalidate", reason: "facts or assumptions changed" },
      ]),
    ) as Record<WorkNodeType, { classification: PriorNodeClassification; reason: string }>;
  }
  if (!equal(previous.acceptanceConditions, current.acceptanceConditions)) {
    return Object.fromEntries(
      ["analyze", "modify", "validate", "report"].map((type) => [
        type,
        { classification: "revalidate", reason: "acceptance conditions changed" },
      ]),
    ) as Record<WorkNodeType, { classification: PriorNodeClassification; reason: string }>;
  }
  return {
    analyze: { classification: "valid", reason: "definition unchanged" },
    modify: { classification: "valid", reason: "definition unchanged" },
    validate: { classification: "valid", reason: "definition unchanged" },
    report: { classification: "valid", reason: "definition unchanged" },
  };
}

function unknownHash(value: unknown): string {
  let representation: string;
  try {
    representation = JSON.stringify(value) ?? String(value);
  } catch {
    representation = Object.prototype.toString.call(value);
  }
  return createHash("sha256").update(representation).digest("hex");
}

function plannerFailures(error: unknown): string[] {
  if (error instanceof PlanValidationError) return error.issues;
  const message = error instanceof Error ? error.message : String(error);
  return [`planner failed: ${message.slice(0, 500)}`];
}

export class PlanningCoordinator {
  private readonly database: DatabaseSync;
  private readonly options: PlanningCoordinatorOptions;
  private closed = false;

  constructor(databaseFile: string, options: PlanningCoordinatorOptions) {
    this.options = options;
    this.database = new DatabaseSync(databaseFile);
    this.database.exec("PRAGMA foreign_keys = ON");
    this.database.exec("PRAGMA busy_timeout = 5000");
    const version = this.database.prepare("PRAGMA user_version").get() as { user_version: number };
    if (version.user_version < 3) throw new Error("Collaboration planning schema is not installed");
  }

  reviseDefinition(
    workItemId: string,
    patch: WorkItemSnapshotPatch,
    now = Date.now(),
  ): DefinitionRevisionOutcome {
    if (this.closed) throw new Error("Planning coordinator is closed");
    this.database.exec("BEGIN IMMEDIATE");
    let snapshots: { previous: WorkItemSnapshot | null; current: WorkItemSnapshot };
    try {
      assertLedgerArmed(this.database);
      snapshots = appendWorkItemSnapshot(this.database, workItemId, patch, now);
      const readiness = evaluateDefinitionReadiness(snapshots.current, this.options.policy.allowedRepositories);
      if (!readiness.ready) {
        this.database
          .prepare("UPDATE collaboration_work_items SET definition_status = 'waiting_clarification', updated_at = ? WHERE id = ?")
          .run(now, workItemId);
        this.database
          .prepare(
            "INSERT INTO collaboration_clarification_rounds " +
              "(id, work_item_id, snapshot_revision, questions_json, created_at) VALUES (?, ?, ?, ?, ?)",
          )
          .run(randomUUID(), workItemId, snapshots.current.revision, JSON.stringify(readiness.frontier), now);
        const card = renderClarificationCard({
          workItemId,
          snapshotRevision: snapshots.current.revision,
          questions: readiness.frontier.map(({ id, title, question, recommendedAnswer }) => ({
            id,
            title,
            question,
            recommendedAnswer,
          })),
        });
        enqueueInboundCard(this.database, {
          sourceEventId: `definition:${workItemId}:snapshot:${snapshots.current.revision}`,
          aggregateType: "plan",
          aggregateId: workItemId,
          aggregateVersion: snapshots.current.revision,
          card,
          supersessionKey: `work-item:${workItemId}:planning-status`,
          now,
        });
        this.database.exec("COMMIT");
        return {
          workItemId,
          snapshotRevision: snapshots.current.revision,
          definitionStatus: "waiting_clarification",
          clarificationQuestions: readiness.frontier,
          planRevision: null,
          card,
        };
      }
      this.database
        .prepare("UPDATE collaboration_work_items SET definition_status = 'planning', updated_at = ? WHERE id = ?")
        .run(now, workItemId);
      this.database
        .prepare(
          "INSERT INTO collaboration_planning_attempts " +
            "(id, work_item_id, snapshot_revision, status, created_at) VALUES (?, ?, ?, 'pending', ?)",
        )
        .run(randomUUID(), workItemId, snapshots.current.revision, now);
      const planningCard = renderPlanStatusCard({
        workItemId,
        snapshotRevision: snapshots.current.revision,
        status: "planning",
      });
      enqueueInboundCard(this.database, {
        sourceEventId: `planning:${workItemId}:snapshot:${snapshots.current.revision}`,
        aggregateType: "plan",
        aggregateId: workItemId,
        aggregateVersion: snapshots.current.revision,
        card: planningCard,
        supersessionKey: `work-item:${workItemId}:planning-status`,
        now,
      });
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }

    let rawProposal: unknown;
    let plan: ValidatedSequentialPlan;
    try {
      rawProposal = this.options.planner.propose(snapshots.current);
      plan = validateSequentialPlan(parsePlannerProposal(rawProposal), this.options.policy);
    } catch (error) {
      return this.persistPlanningFailure(workItemId, snapshots.current, rawProposal, plannerFailures(error), now);
    }
    return this.persistPublishedPlan(workItemId, snapshots.current, plan, now);
  }

  observeAcceptedEvent(workItemId: string, text: string, now = Date.now()): DefinitionRevisionOutcome | null {
    assertLedgerArmed(this.database);
    const latest = readLatestWorkItemSnapshot(this.database, workItemId);
    const normalized = text.trim();
    if (latest?.facts.includes(normalized)) return null;
    const facts = [...(latest?.facts ?? []), normalized];
    if (!latest && this.options.defaultDefinition) {
      return this.reviseDefinition(workItemId, {
        goal: normalized,
        goalConfirmed: true,
        repository: this.options.defaultDefinition.repository,
        acceptanceConditions: this.options.defaultDefinition.acceptanceConditions,
        blockingAmbiguities: [],
        facts,
      }, now);
    }
    return this.reviseDefinition(workItemId, { facts }, now);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  private nextPlanRevision(workItemId: string): number {
    const row = this.database
      .prepare("SELECT coalesce(max(revision), 0) AS revision FROM collaboration_plan_revisions WHERE work_item_id = ?")
      .get(workItemId) as { revision: number };
    return row.revision + 1;
  }

  private persistPlanningFailure(
    workItemId: string,
    snapshot: WorkItemSnapshot,
    rawProposal: unknown,
    failures: string[],
    now: number,
  ): DefinitionRevisionOutcome {
    if (!this.beginCurrentAttempt(workItemId, snapshot.revision, now)) {
      throw new Error(`Planning snapshot ${snapshot.revision} was superseded before failure persistence`);
    }
    try {
      const revision = this.nextPlanRevision(workItemId);
      this.database
        .prepare(
          "INSERT INTO collaboration_plan_revisions " +
            "(id, work_item_id, revision, snapshot_revision, status, proposal_hash, failure_json, created_at) " +
            "VALUES (?, ?, ?, ?, 'planning_failed', ?, ?, ?)",
        )
        .run(randomUUID(), workItemId, revision, snapshot.revision, unknownHash(rawProposal), JSON.stringify(failures), now);
      this.database
        .prepare("UPDATE collaboration_work_items SET definition_status = 'planning_failed', updated_at = ? WHERE id = ?")
        .run(now, workItemId);
      this.database
        .prepare(
          "UPDATE collaboration_planning_attempts SET status = 'failed', completed_at = ? " +
            "WHERE work_item_id = ? AND snapshot_revision = ? AND status = 'pending'",
        )
        .run(now, workItemId, snapshot.revision);
      const card = renderPlanStatusCard({
        workItemId,
        planRevision: revision,
        status: "planning_failed",
        failures,
      });
      enqueueInboundCard(this.database, {
        sourceEventId: `plan:${workItemId}:revision:${revision}`,
        aggregateType: "plan",
        aggregateId: workItemId,
        aggregateVersion: revision,
        card,
        supersessionKey: `work-item:${workItemId}:planning-status`,
        now,
      });
      this.database.exec("COMMIT");
      return {
        workItemId,
        snapshotRevision: snapshot.revision,
        definitionStatus: "planning_failed",
        clarificationQuestions: [],
        planRevision: revision,
        card,
        failures,
      };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private persistPublishedPlan(
    workItemId: string,
    snapshot: WorkItemSnapshot,
    plan: ValidatedSequentialPlan,
    now: number,
  ): DefinitionRevisionOutcome {
    if (!this.beginCurrentAttempt(workItemId, snapshot.revision, now)) {
      throw new Error(`Planning snapshot ${snapshot.revision} was superseded before publication`);
    }
    try {
      const revision = this.nextPlanRevision(workItemId);
      const planHash = unknownHash(plan);
      this.database
        .prepare(
          "INSERT INTO collaboration_plan_revisions " +
            "(id, work_item_id, revision, snapshot_revision, status, summary, proposal_hash, created_at) " +
            "VALUES (?, ?, ?, ?, 'published', ?, ?, ?)",
        )
        .run(randomUUID(), workItemId, revision, snapshot.revision, plan.summary, planHash, now);
      const insertNode = this.database.prepare(
        "INSERT INTO collaboration_work_nodes " +
          "(work_item_id, plan_revision, node_id, node_type, status, assigned_agent_id, objective, input_evidence_json, " +
          "instructions, read_scope_json, write_scope_json, deny_scope_json, commands_json, expected_artifacts_json, " +
          "completion_definition, risk, budget_json, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      for (const node of plan.nodes) {
        insertNode.run(
          workItemId,
          revision,
          node.id,
          node.type,
          node.type === "analyze" ? "ready" : "pending",
          node.agentId,
          node.objective,
          JSON.stringify(node.inputEvidence),
          node.instructions,
          JSON.stringify(node.readScope),
          JSON.stringify(node.writeScope),
          JSON.stringify(node.denyScope),
          JSON.stringify(node.commands),
          JSON.stringify(node.expectedArtifacts),
          node.completionDefinition,
          node.risk,
          JSON.stringify(node.budget),
          now,
        );
      }
      const insertEdge = this.database.prepare(
        "INSERT INTO collaboration_work_edges " +
          "(work_item_id, plan_revision, from_node_id, to_node_id, kind) VALUES (?, ?, ?, ?, 'blocks')",
      );
      for (const node of plan.nodes) {
        for (const dependency of node.dependsOn) insertEdge.run(workItemId, revision, dependency, node.id);
      }

      const previousPlan = this.database
        .prepare(
          "SELECT revision, snapshot_revision, proposal_hash FROM collaboration_plan_revisions " +
            "WHERE work_item_id = ? AND status = 'published' AND revision < ? ORDER BY revision DESC LIMIT 1",
        )
        .get(workItemId, revision) as
        | { revision: number; snapshot_revision: number; proposal_hash?: string }
        | undefined;
      const previousSnapshot = previousPlan
        ? readWorkItemSnapshotRevision(this.database, workItemId, previousPlan.snapshot_revision)
        : null;
      if (previousPlan && previousSnapshot) {
        let classifications = classifyPreviousPlanNodes(previousSnapshot, snapshot);
        if (
          previousPlan.proposal_hash &&
          previousPlan.proposal_hash !== planHash &&
          Object.values(classifications).every((value) => value.classification === "valid")
        ) {
          classifications = Object.fromEntries(
            ["analyze", "modify", "validate", "report"].map((type) => [
              type,
              { classification: "revalidate", reason: "planner contract changed" },
            ]),
          ) as typeof classifications;
        }
        const priorNodes = this.database
          .prepare(
            "SELECT node_id, node_type FROM collaboration_work_nodes " +
              "WHERE work_item_id = ? AND plan_revision = ? ORDER BY rowid",
          )
          .all(workItemId, previousPlan.revision) as Array<{ node_id: string; node_type: WorkNodeType }>;
        const insertClassification = this.database.prepare(
          "INSERT INTO collaboration_plan_node_classifications " +
            "(work_item_id, new_plan_revision, previous_plan_revision, previous_node_id, classification, reason) " +
            "VALUES (?, ?, ?, ?, ?, ?)",
        );
        for (const prior of priorNodes) {
          const classification = classifications[prior.node_type];
          insertClassification.run(
            workItemId,
            revision,
            previousPlan.revision,
            prior.node_id,
            classification.classification,
            classification.reason,
          );
        }
        this.database
          .prepare(
            "UPDATE collaboration_work_nodes SET active = 0, version = version + 1 " +
              "WHERE work_item_id = ? AND plan_revision = ?",
          )
          .run(workItemId, previousPlan.revision);
      }

      this.database
        .prepare(
          "UPDATE collaboration_work_items SET definition_status = 'ready_for_execution', " +
            "current_plan_revision = ?, updated_at = ? WHERE id = ?",
        )
        .run(revision, now, workItemId);
      this.database
        .prepare(
          "UPDATE collaboration_planning_attempts SET status = 'published', completed_at = ? " +
            "WHERE work_item_id = ? AND snapshot_revision = ? AND status = 'pending'",
        )
        .run(now, workItemId, snapshot.revision);
      const card = renderPlanStatusCard({
        workItemId,
        planRevision: revision,
        status: "ready_for_execution",
        summary: plan.summary,
      });
      enqueueInboundCard(this.database, {
        sourceEventId: `plan:${workItemId}:revision:${revision}`,
        aggregateType: "plan",
        aggregateId: workItemId,
        aggregateVersion: revision,
        card,
        supersessionKey: `work-item:${workItemId}:planning-status`,
        now,
      });
      this.database.exec("COMMIT");
      return {
        workItemId,
        snapshotRevision: snapshot.revision,
        definitionStatus: "ready_for_execution",
        clarificationQuestions: [],
        planRevision: revision,
        card,
      };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private beginCurrentAttempt(workItemId: string, snapshotRevision: number, now: number): boolean {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const latest = this.database
        .prepare("SELECT max(revision) AS revision FROM collaboration_work_item_snapshots WHERE work_item_id = ?")
        .get(workItemId) as { revision: number };
      if (latest.revision === snapshotRevision) return true;
      this.database
        .prepare(
          "UPDATE collaboration_planning_attempts SET status = 'stale', completed_at = ? " +
            "WHERE work_item_id = ? AND snapshot_revision = ? AND status = 'pending'",
        )
        .run(now, workItemId, snapshotRevision);
      this.database.exec("COMMIT");
      return false;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}
