// Codex approval-config helpers — the pure half of the driver's approval
// surface: translating harness approval modes (and a custom app-server
// config) into the per-thread/per-turn permission params, and recognizing
// the schema-backed MCP app-access approval form. Split from codex.ts the
// same way codex-catalog.ts holds the model-catalog half; the impure RPC
// flow that consumes these stays in the driver.
import type { ApprovalMode } from "../../shared/approval-mode.ts";

export interface CodexApprovalParams {
  thread: Record<string, unknown>;
  turn: Record<string, unknown>;
  /** Safe legacy settings used only when an older app-server rejects the
   * negotiated named-profile field. */
  fallback?: Omit<CodexApprovalParams, "fallback">;
}

/** RequestPermissionProfile uses null for permission families that were not
 * requested; GrantedPermissionProfile requires those keys to be absent. */
export function grantedPermissions(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).filter(([, value]) => value !== null && value !== undefined),
  );
}

export function additionalPermissionSummary(permissions: unknown, reason: unknown): string {
  const requested = grantedPermissions(permissions);
  const exact = JSON.stringify(requested);
  const prefix = typeof reason === "string" && reason.trim() ? `${reason.trim()} — ` : "";
  return `${prefix}Requested permissions: ${exact}`;
}

export type McpApprovalForm = {
  tool: string;
  summary: string;
  allowResult: { action: "accept"; content: Record<string, string> };
};

const plainRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const containsControlCharacter = (value: string): boolean => {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
};

function boundedLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const label = value.trim();
  return label && label.length <= 160 && !containsControlCharacter(label) ? label : null;
}

function ordinaryApprovalValue(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (/session|always|permanent|forever|persistent/.test(normalized)) return false;
  return normalized === "once" ||
    /^(?:accept(?:ed|[-_]?once)?|approve(?:d|[-_]?once)?|allow(?:ed|[-_]?once)?)$/.test(normalized);
}

/** Recognize only schema-backed app-access approvals. Arbitrary MCP forms
 * (credentials, free text, URLs, or required fields without a one-time enum)
 * remain user input and are declined; Full access never fabricates them.
 * Acceptance requires the app-server's persist marker and the schema shape
 * generated from it, so a relayed look-alike stays an ordinary form. */
export function mcpAppApprovalForm(params: unknown): McpApprovalForm | null {
  const request = plainRecord(params);
  if (!request || request.mode !== "form") return null;
  const metadata = plainRecord(request._meta);
  const target = plainRecord(metadata?.target);
  const toolParams = plainRecord(metadata?.tool_params);
  const message = boundedLabel(request.message) ?? "App access requested";
  const appName = [
    metadata?.app_name,
    metadata?.appName,
    metadata?.app,
    target?.app,
    target?.name,
    toolParams?.app_name,
    toolParams?.app,
    metadata?.connector_name,
    metadata?.connectorName,
  ].map(boundedLabel).find((value): value is string => value !== null);
  // The application identity is the second half of the discriminator. A
  // required approval-looking enum by itself must not turn an arbitrary form
  // into a permission prompt.
  if (!appName) return null;

  // The trusted app-access marker is the persist policy the app-server
  // generated the form from: the durations an approval may extend to, in the
  // established session/always vocabulary. An elicitation without that
  // marker is an ordinary form, whatever its enum looks like.
  const persist = metadata?.persist;
  if (
    !Array.isArray(persist) ||
    !persist.every((value) => value === "session" || value === "always")
  ) return null;
  const durations = new Set(persist);

  const schema = plainRecord(request.requestedSchema);
  const properties = plainRecord(schema?.properties);
  const required = schema?.required;
  if (
    !properties ||
    !Array.isArray(required) ||
    required.length === 0 ||
    required.length > 8 ||
    !required.every((key) => typeof key === "string" && key.length > 0 && key.length <= 100)
  ) return null;

  const content: Record<string, string> = {};
  for (const key of required as string[]) {
    const field = plainRecord(properties[key]);
    if (!field) return null;
    const enumValues = Array.isArray(field.enum)
      ? field.enum.filter((value): value is string => typeof value === "string")
      : [];
    const oneOfValues = Array.isArray(field.oneOf)
      ? field.oneOf
          .map((option) => boundedLabel(plainRecord(option)?.const))
          .filter((value): value is string => Boolean(value))
      : [];
    // The options must be exactly the one-time choice plus the declared
    // durations — the generated schema shape, not a look-alike enum a
    // relaying server planted to win an automatic accept.
    const options = new Set([...oneOfValues, ...enumValues]);
    if (
      options.size !== durations.size + 1 ||
      ![...options].every((value) => value === "once" || durations.has(value))
    ) return null;
    const chosen = [...oneOfValues, ...enumValues].find(ordinaryApprovalValue);
    if (!chosen) return null;
    content[key] = chosen;
  }

  const tool = boundedLabel(appName) ?? boundedLabel(request.serverName) ?? "app_access";
  return { tool, summary: message, allowResult: { action: "accept", content } };
}

/** Codex persists these values on its native thread. Keep them explicit on
 * start, resume, and every turn so switching modes cannot leave a more
 * permissive sandbox/reviewer stuck to the next request. */
/** Ask and Edits both run Codex's workspace-write sandbox with the person as
 * reviewer: Codex has no narrower "edits only" mode, so the selector never
 * offers Edits for it (supportsApprovalMode) and a stray value asks. */
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

function effectiveApprovalsReviewer(value: unknown): string {
  return value === "auto_review" || value === "guardian_subagent" ? value : "user";
}

export function legacyCustomApprovalParams(config: Record<string, unknown>): CodexApprovalParams {
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

/** config/read is the app-server's parsed, effective config boundary. Keep the
 * remaining wire validation deliberately small so quoted user profile ids are
 * not accidentally reinterpreted or logged as arbitrary config. */
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
  // Codex 0.151 profiles define the sandbox, but approval policy remains an
  // independent setting. Reassert both approval fields so a resumed Full
  // thread cannot keep `never`; omit only the mutually-exclusive sandboxes.
  return permissions
    ? {
        thread: { permissions, approvalPolicy, approvalsReviewer },
        turn: { permissions, approvalPolicy, approvalsReviewer },
        fallback,
      }
    : fallback;
}
