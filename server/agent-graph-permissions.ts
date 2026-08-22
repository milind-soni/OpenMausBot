import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { autoVerdict, type AutoVerdict } from "./auto-approve.ts";
import type { AgentGraphPermissionClass } from "./agent-graphs.ts";

const PROTECTED_ACTION = [
  /\b(?:git|gh|glab)\s+(?:push|pull|fetch|clone|merge|rebase|remote|release|pr\s+merge|issue\s+(?:create|edit|close))\b/i,
  /\b(?:deploy|release|publish|submit|upload|promote|ship|rollout)\b/i,
  /\b(?:curl|wget|ssh|scp|sftp|rsync|telnet|nc|netcat)\b/i,
  /https?:\/\//i,
  /\b(?:credential|secret|password|passcode|token|api[_ -]?key|auth(?:enticate|orization)?|login|sign[ -]?in|mfa|2fa|keychain|credvault)\b/i,
  /(?:^|[\s/'"])(?:\.env|\.ssh|\.aws|\.netrc|\.npmrc)(?:[\s/'"]|$)/i,
  /\b(?:composio|gmail|slack|discord|telegram|twilio|email|phone|browser|computer|desktop)\b/i,
  /filesystem_delete/i,
] as const;
const VCS_CONTROL_COMPONENTS = new Set([".git", ".hg", ".svn", ".jj", ".pijul", "_darcs"]);
const VCS_CONTROL_FILES = new Set([".gitmodules", ".gitconfig", ".hgsub", ".hgsubstate"]);
const PREIMAGE = /^(?:absent|sha256:[0-9a-f]{64})$/;

function denied(rule: string): AutoVerdict {
  return { approve: null, source: "agent-graph", rule };
}

function parsedGatewayCall(summary: string): {
  server?: string;
  tool?: string;
  command?: string;
  path?: string;
  cwd?: string;
  expectedSha256?: string;
  append?: boolean;
} | null {
  try {
    const value = JSON.parse(summary) as Record<string, unknown>;
    const args = value.arguments && typeof value.arguments === "object" && !Array.isArray(value.arguments)
      ? value.arguments as Record<string, unknown>
      : value;
    const inner = args.arguments && typeof args.arguments === "object" && !Array.isArray(args.arguments)
      ? args.arguments as Record<string, unknown>
      : {};
    return {
      server: typeof args.server === "string" ? args.server : undefined,
      tool: typeof args.tool === "string" ? args.tool : undefined,
      command: typeof inner.command === "string" ? inner.command : undefined,
      path: typeof inner.path === "string" ? inner.path : undefined,
      cwd: typeof inner.cwd === "string" ? inner.cwd : undefined,
      expectedSha256: typeof inner.expectedSha256 === "string" ? inner.expectedSha256 : undefined,
      append: inner.append === true,
    };
  } catch {
    return null;
  }
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function normalizedWorkspacePath(raw: string, workspaceRoot?: string): { root: string; candidate: string; components: string[] } | null {
  if (!workspaceRoot || !raw.trim() || raw.includes("\0") || /^~(?:[\\/]|$)/.test(raw.trim())) return null;
  const lexicalRoot = resolve(workspaceRoot);
  let root: string;
  try {
    const lexicalInfo = lstatSync(lexicalRoot);
    if (!lexicalInfo.isDirectory() || lexicalInfo.isSymbolicLink()) return null;
    root = realpathSync(lexicalRoot);
    const canonicalInfo = lstatSync(root);
    if (!canonicalInfo.isDirectory() || canonicalInfo.isSymbolicLink() ||
        canonicalInfo.dev !== lexicalInfo.dev || canonicalInfo.ino !== lexicalInfo.ino) return null;
  } catch {
    return null;
  }
  const requested = raw.trim();
  let candidate: string;
  if (isAbsolute(requested)) {
    const lexicalCandidate = resolve(requested);
    if (inside(lexicalRoot, lexicalCandidate)) candidate = resolve(root, relative(lexicalRoot, lexicalCandidate));
    else if (inside(root, lexicalCandidate)) candidate = lexicalCandidate;
    else return null;
  } else {
    candidate = resolve(join(root, requested));
  }
  if (!inside(root, candidate)) return null;
  const rel = relative(root, candidate);
  return { root, candidate, components: rel ? rel.split(sep) : [] };
}

/**
 * Reject lexical escapes and every symlink component, including dangling
 * links. Graph tools do not need symlink traversal, and rejecting it entirely
 * avoids treating a not-yet-created external target as an in-workspace path.
 */
export function agentGraphPathWithinWorkspace(raw: string, workspaceRoot?: string): boolean {
  const normalized = normalizedWorkspacePath(raw, workspaceRoot);
  if (!normalized) return false;
  let current = normalized.root;
  for (const [index, component] of normalized.components.entries()) {
    current = join(current, component);
    try {
      const info = lstatSync(current);
      if (info.isSymbolicLink()) return false;
      if (index === normalized.components.length - 1 && info.isFile() && info.nlink !== 1) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      return false;
    }
  }
  return true;
}

/** Graph writes may change source, never repository control metadata. */
export function agentGraphWritePathAllowed(raw: string, workspaceRoot?: string): boolean {
  if (!agentGraphPathWithinWorkspace(raw, workspaceRoot)) return false;
  const normalized = normalizedWorkspacePath(raw, workspaceRoot);
  if (!normalized?.components.length) return false;
  const components = normalized.components.map((component) => component.toLowerCase());
  if (components.some((component) => VCS_CONTROL_COMPONENTS.has(component)) ||
      VCS_CONTROL_FILES.has(components.at(-1)!)) return false;
  try {
    const info = lstatSync(normalized.candidate);
    return info.isFile() && info.nlink === 1;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

export function agentGraphCommandAllowed(
  _permissionClass: AgentGraphPermissionClass,
  _command: string,
  _workspaceRoot?: string,
): boolean {
  // Repository scripts and apparently read-only shell commands execute
  // mutable workspace code. Graph execution remains gateway-filesystem-only
  // until a separate OS sandbox can enforce process, network, and path scope.
  return false;
}

/**
 * Interpret the exact graph permission class at the server permission fold.
 * The approved DAG grants only ordinary local reads/writes and deterministic
 * checks. Unknown, external, credentialed, destructive, or protected actions
 * stay as human cards even when the selected bot is configured full-auto.
 */
export function agentGraphVerdict(
  permissionClass: AgentGraphPermissionClass,
  tool: string,
  summary: string,
  context: { cwd?: string; scope?: "local-computer" } = {},
): AutoVerdict {
  if (permissionClass === "protected") return denied("protected-class");
  if (context.scope === "local-computer") return denied("local-computer-outside-graph-scope");
  const combined = `${tool}\n${summary}`;
  const protectedRule = PROTECTED_ACTION.find((rule) => rule.test(combined));
  if (protectedRule) return denied(String(protectedRule));

  // Reuse the established destructive/sensitive analyzer before applying the
  // narrower graph allowlist. This intentionally uses the standard posture:
  // graph approval is not the broad full-task auto mode.
  const baseline = autoVerdict({ autoApprove: true }, tool, summary, { cwd: context.cwd });
  if (!baseline.approve) return { ...baseline, source: "agent-graph" };

  const gateway = /call_capability|openmaus_capabilities/i.test(tool) ? parsedGatewayCall(summary) : null;
  if (gateway) {
    if (gateway.server !== "openmaus-host" || !gateway.tool) return denied("non-local-capability");
    if (["filesystem_read", "filesystem_stat"].includes(gateway.tool)) {
      if (!gateway.path || !agentGraphPathWithinWorkspace(gateway.path, context.cwd)) return denied("path-outside-approved-workspace");
      return { approve: "approved by exact agent graph hash", source: "agent-graph", rule: gateway.tool };
    }
    if (gateway.tool === "shell_execute") return denied("graph-shell-requires-separate-sandbox");
    if (permissionClass === "workspace-write" && gateway.tool === "filesystem_write") {
      if (!gateway.path || !agentGraphWritePathAllowed(gateway.path, context.cwd)) {
        return denied("path-outside-approved-write-scope");
      }
      if (gateway.append || !gateway.expectedSha256 || !PREIMAGE.test(gateway.expectedSha256)) {
        return denied("exact-preimage-required");
      }
      return { approve: "approved by exact agent graph hash", source: "agent-graph", rule: gateway.tool };
    }
    return denied("permission-class-capability-mismatch");
  }

  return denied("provider-native-tool-outside-graph-scope");
}
