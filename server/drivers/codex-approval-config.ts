import type { ApprovalMode } from "../../shared/approval-mode.ts";
import { containsControlCharacter } from "./codex-app-approval.ts";

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

export interface CodexApprovalParams {
  thread: Record<string, unknown>;
  turn: Record<string, unknown>;
  /** Legacy settings for an older app-server that rejects the named-profile field. */
  fallback?: Omit<CodexApprovalParams, "fallback">;
}

/** Codex persists these on its native thread, so they are explicit on start, resume and every turn.
 * Codex has no narrower "edits only" sandbox, so a stray Edits value asks. */
export function namedApprovalParams(mode: Exclude<ApprovalMode, "custom">): CodexApprovalParams {
  if (mode === "full") {
    return {
      thread: {
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandbox: "danger-full-access",
      },
      turn: {
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandboxPolicy: { type: "dangerFullAccess" },
      },
    };
  }
  return {
    thread: {
      approvalPolicy: "on-request",
      approvalsReviewer: mode === "auto" ? "auto_review" : "user",
      sandbox: "workspace-write",
    },
    turn: {
      approvalPolicy: "on-request",
      approvalsReviewer: mode === "auto" ? "auto_review" : "user",
      sandboxPolicy: { type: "workspaceWrite" },
    },
  };
}

export function withResolvedSandbox(params: CodexApprovalParams, session: unknown): CodexApprovalParams {
  const requested = plainRecord(params.turn.sandboxPolicy);
  if (!requested) return params;
  const sandbox = plainRecord(plainRecord(session)?.sandbox);
  if (!sandbox || typeof sandbox.type !== "string") {
    throw new Error("Codex did not return its resolved sandbox policy. Update Codex, then retry; the turn was not started because its permissions could not be verified.");
  }
  if (sandbox.type !== requested.type) {
    throw new Error("Codex did not apply the requested sandbox mode; cannot safely start the turn.");
  }
  return { ...params, turn: { ...params.turn, sandboxPolicy: sandbox } };
}

function legacyCustomApprovalParams(config: Record<string, unknown>): CodexApprovalParams {
  const approvalPolicy = effectiveApprovalPolicy(config.approval_policy);
  const approvalsReviewer = effectiveApprovalsReviewer(config.approvals_reviewer);
  const sandbox = config.sandbox_mode === "workspace-write" ||
    config.sandbox_mode === "danger-full-access" ||
    config.sandbox_mode === "read-only"
    ? config.sandbox_mode
    : "read-only";
  let sandboxPolicy: Record<string, unknown>;
  if (sandbox === "danger-full-access") sandboxPolicy = { type: "dangerFullAccess" };
  else if (sandbox === "read-only") sandboxPolicy = { type: "readOnly" };
  else {
    const workspace = config.sandbox_workspace_write && typeof config.sandbox_workspace_write === "object"
      ? config.sandbox_workspace_write as Record<string, unknown>
      : {};
    sandboxPolicy = {
      type: "workspaceWrite",
      ...(Array.isArray(workspace.writable_roots) ? { writableRoots: workspace.writable_roots } : {}),
      ...(typeof workspace.network_access === "boolean" ? { networkAccess: workspace.network_access } : {}),
      ...(typeof workspace.exclude_slash_tmp === "boolean" ? { excludeSlashTmp: workspace.exclude_slash_tmp } : {}),
      ...(typeof workspace.exclude_tmpdir_env_var === "boolean"
        ? { excludeTmpdirEnvVar: workspace.exclude_tmpdir_env_var }
        : {}),
    };
  }
  return {
    thread: { approvalPolicy, approvalsReviewer, sandbox },
    turn: { approvalPolicy, approvalsReviewer, sandboxPolicy },
  };
}

function configuredPermissionProfile(config: Record<string, unknown>): string | null {
  if (typeof config.default_permissions !== "string") return null;
  const profile = config.default_permissions.trim();
  if (!profile || profile.length > 240 || containsControlCharacter(profile)) return null;
  return profile;
}

export function customApprovalParams(raw: unknown): CodexApprovalParams {
  const config = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const fallback = legacyCustomApprovalParams(config);
  const permissions = configuredPermissionProfile(config);
  const approvalPolicy = effectiveApprovalPolicy(config.approval_policy);
  const approvalsReviewer = effectiveApprovalsReviewer(config.approvals_reviewer);
  // Codex 0.151 profiles define the sandbox but not the approval policy: reassert both approval
  // fields so a resumed Full thread cannot keep `never`.
  return permissions
    ? {
        thread: { permissions, approvalPolicy, approvalsReviewer },
        turn: { permissions, approvalPolicy, approvalsReviewer },
        fallback,
      }
    : fallback;
}

export function permissionProfileUnsupported(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:experimental api|invalid params|unknown field|unknown.*permissions|permissions.*(?:unsupported|sandbox)|cannot.*permissions)/i.test(message);
}
