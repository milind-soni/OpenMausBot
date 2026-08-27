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

export function appendControlAudit(
  database: DatabaseSync,
  input: {
    actorPrincipalId?: string;
    workItemId?: string;
    requestId: string;
    action: string;
    outcome: "allow" | "deny";
    policyRule: string;
    resource: Record<string, unknown>;
    beforeHash?: string;
    afterHash?: string;
    error?: string;
    now: number;
  },
): void {
  database
    .prepare(
      "INSERT INTO collaboration_audit_events " +
        "(id, action, outcome, resource_json, created_at, actor_principal_id, work_item_id, request_id, " +
        "policy_rule, before_hash, after_hash, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      randomUUID(),
      input.action,
      input.outcome,
      JSON.stringify(input.resource),
      input.now,
      input.actorPrincipalId ?? null,
      input.workItemId ?? null,
      input.requestId,
      input.policyRule,
      input.beforeHash ?? null,
      input.afterHash ?? null,
      input.error ?? null,
    );
}
