const plainRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** A Custom approval_policy as Codex accepts it: a named policy, or a granular record with only the keys it knows. */
export function effectiveApprovalPolicy(value: unknown): unknown {
  if (value === "untrusted" || value === "on-request" || value === "never") return value;
  const granular = plainRecord(plainRecord(value)?.granular);
  if (
    granular &&
    typeof granular.mcp_elicitations === "boolean" &&
    typeof granular.rules === "boolean" &&
    typeof granular.sandbox_approval === "boolean" &&
    (granular.request_permissions === undefined || typeof granular.request_permissions === "boolean") &&
    (granular.skill_approval === undefined || typeof granular.skill_approval === "boolean")
  ) {
    return {
      granular: {
        mcp_elicitations: granular.mcp_elicitations,
        rules: granular.rules,
        sandbox_approval: granular.sandbox_approval,
        ...(typeof granular.request_permissions === "boolean"
          ? { request_permissions: granular.request_permissions }
          : {}),
        ...(typeof granular.skill_approval === "boolean"
          ? { skill_approval: granular.skill_approval }
          : {}),
      },
    };
  }
  return "on-request";
}

export function effectiveApprovalsReviewer(value: unknown): string {
  return value === "auto_review" || value === "guardian_subagent" ? value : "user";
}

const SANDBOX_ACCESS_ORDER: readonly unknown[] = ["readOnly", "workspaceWrite", "dangerFullAccess"];

/** Codex may resolve a stricter sandbox than asked (read-only on Windows without its own sandbox), never a looser or unknown one. */
export function resolvedSandboxAllowed(requested: unknown, resolved: unknown): boolean {
  if (resolved === requested) return true;
  const access = SANDBOX_ACCESS_ORDER.indexOf(resolved);
  return access >= 0 && access < SANDBOX_ACCESS_ORDER.indexOf(requested);
}
