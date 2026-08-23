export const UNATTENDED_FORBIDDEN_ACTIONS = [
  "credential-value-access",
  "deploy",
  "destructive-cleanup",
  "external-message",
  "force-push",
  "merge",
  "provider-default-change",
  "release",
  "upload",
  "write-outside-worktree",
  "write-protected-branch",
] as const;

export interface WorkRequestFields {
  repository: string;
  issue: string;
  repoPath: string;
  baselineSha: string;
  taskBranch: string;
  allowedPaths: string;
  acceptanceTests: string;
  tokenBudget: string;
  maxRuntimeSeconds: string;
}

const lines = (value: string) => value.split("\n").map((item) => item.trim()).filter(Boolean);

export function buildOpenMausWorkRequest(fields: WorkRequestFields) {
  const repository = fields.repository.trim();
  const issue = Number(fields.issue);
  return {
    schema: "aos.work-request.v1",
    ingress: "openmausbot",
    idempotency_key: `work:${repository}:${fields.issue.trim()}`,
    repository,
    issue,
    card: {
      schema: "aos.hermes-card.v1",
      repo_path: fields.repoPath.trim(),
      github_issue: `${repository}#${fields.issue.trim()}`,
      baseline_sha: fields.baselineSha.trim().toLowerCase(),
      acceptance_tests: lines(fields.acceptanceTests),
      token_budget: Number(fields.tokenBudget),
      mutation_boundary: {
        allowed: lines(fields.allowedPaths),
        forbidden: [...UNATTENDED_FORBIDDEN_ACTIONS],
      },
      blocker_state: "unblocked",
      protected_gates: ["no-merge", "no-deploy", "no-release", "no-external-send", "no-provider-change"],
      task_class: "implementation",
      priority: "P1",
      not_before: null,
      max_runtime_seconds: Number(fields.maxRuntimeSeconds),
      task_branch: fields.taskBranch.trim(),
    },
  };
}
