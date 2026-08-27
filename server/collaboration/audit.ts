import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export function appendExecutionAudit(
  database: DatabaseSync,
  input: {
    runId: string;
    action: string;
    outcome: string;
    resource: Record<string, unknown>;
    now: number;
  },
): void {
  database
    .prepare(
      "INSERT INTO collaboration_audit_events (id, run_id, action, outcome, resource_json, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(randomUUID(), input.runId, input.action, input.outcome, JSON.stringify(input.resource), input.now);
}
