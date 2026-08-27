import type { DatabaseSync } from "node:sqlite";

export interface AcceptanceCondition {
  description: string;
  observation: string;
}

export interface BlockingAmbiguity {
  id: string;
  question: string;
  dependsOn: string[];
  recommendedAnswer: string;
}

export interface WorkItemSnapshot {
  workItemId: string;
  revision: number;
  sourceWorkItemVersion: number;
  goal: string | null;
  goalConfirmed: boolean;
  repository: string | null;
  facts: string[];
  assumptions: string[];
  acceptanceConditions: AcceptanceCondition[];
  blockingAmbiguities: BlockingAmbiguity[];
  createdAt: number;
}

export interface WorkItemSnapshotPatch {
  goal?: string | null;
  goalConfirmed?: boolean;
  repository?: string | null;
  facts?: string[];
  assumptions?: string[];
  acceptanceConditions?: AcceptanceCondition[];
  blockingAmbiguities?: Array<string | BlockingAmbiguity>;
}

interface SnapshotRow {
  work_item_id: string;
  revision: number;
  source_work_item_version: number;
  goal: string | null;
  goal_confirmed: number;
  repository: string | null;
  facts_json: string;
  assumptions_json: string;
  acceptance_json: string;
  blocking_ambiguities_json: string;
  created_at: number;
}

function strings(values: readonly string[], field: string): string[] {
  if (values.length > 100) throw new Error(`${field} exceeds 100 entries`);
  return values.map((value) => {
    const normalized = value.trim();
    if (!normalized) throw new Error(`${field} contains an empty value`);
    if (normalized.length > 2_000) throw new Error(`${field} entry exceeds 2000 characters`);
    return normalized;
  });
}

function acceptance(values: readonly AcceptanceCondition[]): AcceptanceCondition[] {
  if (values.length > 50) throw new Error("acceptanceConditions exceeds 50 entries");
  return values.map((condition) => {
    const description = condition.description.trim();
    const observation = condition.observation.trim();
    if (!description || !observation) {
      throw new Error("Every acceptance condition requires a description and observable evidence");
    }
    if (description.length > 2_000 || observation.length > 2_000) {
      throw new Error("Acceptance condition exceeds 2000 characters");
    }
    return { description, observation };
  });
}

function ambiguities(values: readonly (string | BlockingAmbiguity)[]): BlockingAmbiguity[] {
  if (values.length > 50) throw new Error("blockingAmbiguities exceeds 50 entries");
  const normalized = values.map((value, index) => {
    if (typeof value === "string") {
      return {
        id: `ambiguity-${index + 1}`,
        question: value.trim(),
        dependsOn: [],
        recommendedAnswer: "选择一个明确边界，并说明未选择分支是否属于本次范围。",
      };
    }
    return {
      id: value.id.trim(),
      question: value.question.trim(),
      dependsOn: strings(value.dependsOn, "blockingAmbiguities.dependsOn"),
      recommendedAnswer: value.recommendedAnswer.trim(),
    };
  });
  if (new Set(normalized.map((value) => value.id)).size !== normalized.length) {
    throw new Error("blockingAmbiguities IDs must be unique");
  }
  for (const value of normalized) {
    if (!/^[a-z][a-z0-9-]{0,63}$/u.test(value.id) || !value.question || !value.recommendedAnswer) {
      throw new Error("blockingAmbiguities require a stable id, question and recommended answer");
    }
  }
  return normalized;
}

function rowToSnapshot(row: SnapshotRow): WorkItemSnapshot {
  return {
    workItemId: row.work_item_id,
    revision: row.revision,
    sourceWorkItemVersion: row.source_work_item_version,
    goal: row.goal,
    goalConfirmed: row.goal_confirmed === 1,
    repository: row.repository,
    facts: JSON.parse(row.facts_json) as string[],
    assumptions: JSON.parse(row.assumptions_json) as string[],
    acceptanceConditions: JSON.parse(row.acceptance_json) as AcceptanceCondition[],
    blockingAmbiguities: JSON.parse(row.blocking_ambiguities_json) as BlockingAmbiguity[],
    createdAt: row.created_at,
  };
}

export function readLatestWorkItemSnapshot(database: DatabaseSync, workItemId: string): WorkItemSnapshot | null {
  const row = database
    .prepare("SELECT * FROM collaboration_work_item_snapshots WHERE work_item_id = ? ORDER BY revision DESC LIMIT 1")
    .get(workItemId) as SnapshotRow | undefined;
  return row ? rowToSnapshot(row) : null;
}

export function readWorkItemSnapshotRevision(
  database: DatabaseSync,
  workItemId: string,
  revision: number,
): WorkItemSnapshot | null {
  const row = database
    .prepare("SELECT * FROM collaboration_work_item_snapshots WHERE work_item_id = ? AND revision = ?")
    .get(workItemId, revision) as SnapshotRow | undefined;
  return row ? rowToSnapshot(row) : null;
}

export function appendWorkItemSnapshot(
  database: DatabaseSync,
  workItemId: string,
  patch: WorkItemSnapshotPatch,
  now: number,
): { previous: WorkItemSnapshot | null; current: WorkItemSnapshot } {
  const item = database
    .prepare("SELECT version FROM collaboration_work_items WHERE id = ?")
    .get(workItemId) as { version: number } | undefined;
  if (!item) throw new Error(`Unknown Work Item: ${workItemId}`);
  const previous = readLatestWorkItemSnapshot(database, workItemId);
  const goal = patch.goal === undefined ? (previous?.goal ?? null) : patch.goal?.trim() || null;
  const goalChanged = patch.goal !== undefined && goal !== (previous?.goal ?? null);
  const repository =
    patch.repository === undefined ? (previous?.repository ?? null) : patch.repository?.trim() || null;
  const current: WorkItemSnapshot = {
    workItemId,
    revision: (previous?.revision ?? 0) + 1,
    sourceWorkItemVersion: item.version,
    goal,
    goalConfirmed: patch.goalConfirmed ?? (goalChanged ? false : (previous?.goalConfirmed ?? false)),
    repository,
    facts: strings(patch.facts ?? previous?.facts ?? [], "facts"),
    assumptions: strings(patch.assumptions ?? previous?.assumptions ?? [], "assumptions"),
    acceptanceConditions: acceptance(patch.acceptanceConditions ?? previous?.acceptanceConditions ?? []),
    blockingAmbiguities: ambiguities(patch.blockingAmbiguities ?? previous?.blockingAmbiguities ?? []),
    createdAt: now,
  };
  database
    .prepare(
      "INSERT INTO collaboration_work_item_snapshots " +
        "(work_item_id, revision, source_work_item_version, goal, goal_confirmed, repository, facts_json, " +
        "assumptions_json, acceptance_json, blocking_ambiguities_json, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      current.workItemId,
      current.revision,
      current.sourceWorkItemVersion,
      current.goal,
      current.goalConfirmed ? 1 : 0,
      current.repository,
      JSON.stringify(current.facts),
      JSON.stringify(current.assumptions),
      JSON.stringify(current.acceptanceConditions),
      JSON.stringify(current.blockingAmbiguities),
      current.createdAt,
    );
  return { previous, current };
}
