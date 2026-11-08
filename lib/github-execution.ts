import type { ExecutionDeployment, ExecutionMerge, ExecutionVerification } from "./execution-types";
import { integrationBridge } from "./integration-bridge";
import { contextWithToken, createGitHubTask } from "./github-sync";
import { projectInstallationToken, repositoryPath, revokeInstallationToken } from "./github-app";
import { GitHubHttpError, githubRequest } from "./github-workspace";
import { openPR } from "./github-prs";

type RunIdentity = { projectId: string; taskId: string };
type RunResult = RunIdentity & { branch: string; baseBranch: string; headSha: string; title: string; verification: ExecutionVerification[]; smokePassed: boolean; authorize: () => Promise<void> };
type PullRequest = {
  number: number; node_id: string; html_url: string; body: string | null; state: string; draft: boolean; merged: boolean; merged_at: string | null; merge_commit_sha: string | null;
  mergeable: boolean | null; mergeable_state: string;
  head: { sha: string; ref: string; repo: { id: number } | null }; base: { ref: string; sha: string; repo: { id: number } };
};
type Check = { name: string; status: string; conclusion: string | null; app: { id: number } | null };
type Status = { context: string; state: string };
type RequiredCheck = { context: string; app_id?: number | null; integration_id?: number | null };
type Protection = { required_status_checks?: { contexts: string[]; checks?: RequiredCheck[] }; required_pull_request_reviews?: { required_approving_review_count: number; require_code_owner_reviews?: boolean; require_last_push_approval?: boolean }; required_conversation_resolution?: { enabled: boolean } };
type Rule = { type: string; parameters?: { required_status_checks?: RequiredCheck[]; required_approving_review_count?: number; require_code_owner_review?: boolean; require_last_push_approval?: boolean } };
type Review = { data?: { node?: { reviewDecision: string | null; mergeStateStatus: string; baseRef?: { branchProtectionRule: { id: string } | null } | null } | null }; errors?: unknown[] };
const mergePermissions = { statuses: "read", administration: "read" };

async function authorizedRun(input: RunIdentity, pushOnly: boolean) {
  let context = await contextWithToken(input.projectId, input.taskId, "read");
  if (!context.token || !context.project.githubWorkspaceAccess || !context.task || !context.repo) throw new Error("Authorize this project's repository and issue before running code");
  if (!context.task.githubIssueNumber) {
    await createGitHubTask(input.projectId, input.taskId);
    context = await contextWithToken(input.projectId, input.taskId, "read");
  }
  if (!context.token || !context.task?.githubIssueNumber || !context.task.githubIssueUrl || !context.project.repoUrl) throw new Error("Issue synchronization must finish before running code");
  const repoUrl = `https://github.com/${context.repo!.owner}/${context.repo!.repo}`, path = repositoryPath(repoUrl);
  if (context.task.githubIssueUrl.toLowerCase() !== `${repoUrl}/issues/${context.task.githubIssueNumber}`.toLowerCase()) throw new Error("Issue repository linkage changed");
  const credential = context.sharedConnection
    ? await integrationBridge<{ token: string; expiresAt: string; repoUrl: string }>("githubToken", { projectId: input.projectId, access: pushOnly ? "push" : "write", ...(!pushOnly ? { extra: mergePermissions } : {}) })
    : await projectInstallationToken(input.projectId, repoUrl, pushOnly, pushOnly ? {} : mergePermissions);
  try {
    if ("repoUrl" in credential && (typeof credential.repoUrl !== "string" || repositoryPath(credential.repoUrl).toLowerCase() !== path.toLowerCase())) throw new Error("Credential repository changed");
    const remote = await githubRequest<{ id: number; full_name: string }>(path, credential.token);
    if (!Number.isSafeInteger(remote.id) || remote.full_name.toLowerCase() !== path.slice(7).toLowerCase() || context.project.githubRepoId && remote.id !== context.project.githubRepoId || context.task.githubIssueRepoId && remote.id !== context.task.githubIssueRepoId) throw new Error("Repository identity changed");
    // Push-only credentials cannot read issues; the separately authorized read credential can.
    const issue = await githubRequest<{ number: number; node_id: string; pull_request?: unknown }>(`${path}/issues/${context.task.githubIssueNumber}`, context.token!);
    if (issue.pull_request || issue.number !== context.task.githubIssueNumber || context.task.githubIssueNodeId && issue.node_id !== context.task.githubIssueNodeId) throw new Error("Issue linkage changed");
    return { context, credential, repoUrl, path, repoId: remote.id, issueNumber: issue.number };
  } catch (error) { await revokeInstallationToken(credential.token); throw error; }
}

/** Server-only: callers authorize the run owner; these credentials must never be returned to a browser. */
export async function prepareRunRepository(input: RunIdentity & { baseBranch: string }) {
  if (!input.baseBranch.trim()) throw new Error("An explicit base branch is required");
  const run = await authorizedRun(input, true);
  try {
    const ref = await githubRequest<{ ref: string }>(`${run.path}/git/ref/heads/${encodeURIComponent(input.baseBranch)}`, run.credential.token);
    if (ref.ref !== `refs/heads/${input.baseBranch}`) throw new Error("Configured base branch could not be verified");
    return { repositoryUrl: run.repoUrl, baseBranch: input.baseBranch, issueNumber: run.issueNumber,
      gitCredential: { username: "x-access-token", token: run.credential.token, expiresAt: Date.parse(run.credential.expiresAt) } };
  } catch (error) { await revokeInstallationToken(run.credential.token); throw error; }
}

export function checkMergeGates(input: { checks: Check[]; statuses: Status[]; required: RequiredCheck[]; reviewDecision: string | null; reviewRequired: boolean; mergeStateStatus: string; mergeable: boolean | null; draft: boolean }): Pick<ExecutionMerge, "state" | "reason"> | null {
  if (input.draft) return { state: "blocked", reason: "Pull request is still a draft" };
  if (input.checks.some(check => check.status === "completed" && !["success", "neutral", "skipped"].includes(check.conclusion || "")) || input.statuses.some(status => ["failure", "error"].includes(status.state))) return { state: "blocked", reason: "GitHub checks failed" };
  if (input.checks.some(check => check.status !== "completed") || input.statuses.some(status => status.state === "pending")) return { state: "awaiting_checks", reason: "GitHub checks are pending" };
  for (const required of input.required) {
    const appId = required.app_id ?? required.integration_id;
    const check = input.checks.find(check => check.name === required.context && (appId == null || appId < 0 || check.app?.id === appId));
    const status = appId == null || appId < 0 ? input.statuses.find(status => status.context === required.context) : undefined;
    if (!check && !status) return { state: "awaiting_checks", reason: `Required GitHub check has not reported: ${required.context}` };
  }
  if (input.reviewDecision === "CHANGES_REQUESTED" || input.reviewRequired && input.reviewDecision !== "APPROVED" || input.reviewDecision === "REVIEW_REQUIRED") return { state: "blocked", reason: "Required pull request approvals are outstanding" };
  if (input.mergeable === null || input.mergeStateStatus === "UNKNOWN") return { state: "awaiting_checks", reason: "GitHub is calculating mergeability" };
  if (!input.mergeable || input.mergeStateStatus !== "CLEAN") return { state: "blocked", reason: `GitHub branch protections prevent merging (${input.mergeStateStatus || "unknown"})` };
  return null;
}

async function gates(path: string, baseBranch: string, pr: PullRequest, token: string) {
  const checks: Check[] = [], statuses: Status[] = [];
  for (let page = 1; ; page++) {
    const response = await githubRequest<{ total_count: number; check_runs: Check[] }>(`${path}/commits/${pr.head.sha}/check-runs?filter=latest&per_page=100&page=${page}`, token);
    checks.push(...response.check_runs);
    if (checks.length >= response.total_count) break;
    if (!response.check_runs.length || page >= 20) throw new Error("Cannot verify all GitHub checks; merge blocked");
  }
  // The statuses endpoint is newest-first; only the newest result for each context is authoritative.
  for (let page = 1; ; page++) {
    const response = await githubRequest<Status[]>(`${path}/commits/${pr.head.sha}/statuses?per_page=100&page=${page}`, token);
    for (const status of response) if (!statuses.some(existing => existing.context === status.context)) statuses.push(status);
    if (response.length < 100) break;
    if (page >= 20) throw new Error("Cannot verify all GitHub commit statuses; merge blocked");
  }
  const review = await githubRequest<Review>("/graphql", token, { method: "POST", body: JSON.stringify({
    query: "query($id:ID!){node(id:$id){... on PullRequest{reviewDecision mergeStateStatus baseRef{branchProtectionRule{id}}}}}", variables: { id: pr.node_id },
  }) });
  if (review.errors?.length || !review.data?.node) throw new Error("Cannot verify GitHub review and protection requirements");
  let protection: Protection = {};
  try { protection = await githubRequest<Protection>(`${path}/branches/${encodeURIComponent(baseBranch)}/protection`, token); }
  catch (error) { if (!(error instanceof GitHubHttpError) || error.status !== 404 || review.data.node.baseRef?.branchProtectionRule !== null) throw error; }
  // Active repository/organization rulesets apply even when there is no legacy branch protection rule.
  const rules = await githubRequest<Rule[]>(`${path}/rules/branches/${encodeURIComponent(baseBranch)}`, token);
  const required: RequiredCheck[] = [...(protection.required_status_checks?.checks || []), ...(protection.required_status_checks?.contexts || []).map(context => ({ context }))];
  for (const rule of rules) if (rule.type === "required_status_checks") required.push(...(rule.parameters?.required_status_checks || []));
  const reviewRequired = Boolean(protection.required_pull_request_reviews && (protection.required_pull_request_reviews.required_approving_review_count > 0 || protection.required_pull_request_reviews.require_code_owner_reviews || protection.required_pull_request_reviews.require_last_push_approval)
    || rules.some(rule => rule.type === "pull_request" && ((rule.parameters?.required_approving_review_count || 0) > 0 || rule.parameters?.require_code_owner_review || rule.parameters?.require_last_push_approval)));
  return checkMergeGates({ checks, statuses, required, reviewRequired, reviewDecision: review.data.node.reviewDecision, mergeStateStatus: review.data.node.mergeStateStatus, mergeable: pr.mergeable, draft: pr.draft });
}

/** Merge is not deployment: returns only a verified GitHub merge receipt. No bypass, auto-approval or protection edits. */
export async function finalizeRunPullRequest(input: RunResult): Promise<ExecutionMerge> {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(input.headSha) || !input.branch || !input.baseBranch || input.branch === input.baseBranch) return { state: "blocked", reason: "A distinct pushed task branch and exact verified head SHA are required" };
  if (!input.smokePassed || !input.verification.length || input.verification.some(result => !result.command.trim() || result.exitCode !== 0) || !input.verification.some(result => result.kind === "test") || !input.verification.some(result => result.kind === "smoke")) return { state: "blocked", reason: "Configured tests and smoke verification must pass on this head before merging" };
  let credential: string | undefined;
  let receipt: { url: string; number: number } | undefined;
  try {
    const run = await authorizedRun(input, false);
    credential = run.credential.token;
    const owner = run.path.slice(7).split("/")[0];
    const existing = await githubRequest<{ number: number; html_url: string; body: string | null; head: { ref: string } }[]>(`${run.path}/pulls?state=all&head=${encodeURIComponent(`${owner}:${input.branch}`)}&per_page=100`, credential);
    const linked = existing.find(pr => pr.head.ref === input.branch && pr.body?.includes(`<!-- origin-task:${input.taskId} -->`));
    if (linked) receipt = { url: linked.html_url, number: linked.number };
    else {
      const head = await githubRequest<{ object: { sha: string } }>(`${run.path}/git/ref/heads/${encodeURIComponent(input.branch)}`, credential);
      if (head.object.sha !== input.headSha) return { state: "blocked", reason: "Task branch head changed after verification; rerun verification on the new head" };
      await input.authorize();
      const snapshot = await openPR(run.repoUrl, input.taskId, input.branch, input.title,
        `${run.context.task!.description || ""}\n\nCloses #${run.issueNumber}`, credential, false, input.baseBranch);
      receipt = { url: snapshot.url, number: snapshot.number };
    }
    const read = () => githubRequest<PullRequest>(`${run.path}/pulls/${receipt!.number}`, credential!);
    const pr = await read();
    const matches = (value: PullRequest) => value.head.sha === input.headSha && value.head.ref === input.branch && value.base.ref === input.baseBranch && value.base.repo.id === run.repoId && value.head.repo?.id === run.repoId;
    if (!matches(pr)) return { ...receipt, state: "blocked", reason: "Pull request head, base or repository changed; verification is stale" };
    let merged = pr;
    if (!pr.merged) {
      if (pr.state !== "open") return { ...receipt, state: "blocked", reason: "Pull request was closed without merging" };
      const gate = await gates(run.path, input.baseBranch, pr, credential);
      if (gate) return { ...receipt, ...gate };
      const current = await read();
      if (!matches(current) || current.base.sha !== pr.base.sha || current.draft || current.state !== "open") return { ...receipt, state: "blocked", reason: "Pull request changed while checking merge gates; retry after verifying its current head" };
      const context = await contextWithToken(input.projectId, input.taskId, "read");
      if (!context.token || !context.project.githubWorkspaceAccess || !context.task || context.task.githubIssueNumber !== run.issueNumber || repositoryPath(context.project.repoUrl || "").toLowerCase() !== run.path.toLowerCase()) throw new Error("Repository authorization or issue linkage changed before merge");
      await input.authorize();
      try {
        const response = await githubRequest<{ merged: boolean; sha: string }>(`${run.path}/pulls/${pr.number}/merge`, credential, { method: "PUT", body: JSON.stringify({ sha: input.headSha, merge_method: "squash" }) });
        if (!response.merged) return { ...receipt, state: "blocked", reason: "GitHub declined the exact-head merge; no protection was bypassed" };
        merged = await read();
        if (merged.merge_commit_sha !== response.sha) throw new Error("GitHub merge receipt could not be verified");
      } catch (error) {
        // PUT may have succeeded before the transport failed. Re-read, never equate a timeout with failure.
        const observed = await read().catch(() => null);
        if (observed?.merged && matches(observed)) merged = observed;
        else if (!(error instanceof GitHubHttpError) || error.status >= 500) return { ...receipt, state: "awaiting_checks", reason: "Merge outcome is uncertain; waiting for an exact-head GitHub receipt" };
        else throw error;
      }
    }
    if (!matches(merged) || !merged.merged || !merged.merged_at || !merged.merge_commit_sha) throw new Error("Exact-head merge has not been confirmed");
    await integrationBridge("completeMergedIssue", { projectId: input.projectId, taskId: input.taskId, repoUrl: run.repoUrl, issueNumber: run.issueNumber,
      pullRequest: { number: merged.number, headSha: input.headSha, mergeSha: merged.merge_commit_sha, mergedAt: Date.parse(merged.merged_at) } });
    return { ...receipt, state: "merged", mergeSha: merged.merge_commit_sha };
  } catch (error) {
    return { ...receipt, state: "blocked", reason: error instanceof Error ? error.message : "Unable to verify GitHub merge gates" };
  } finally { if (credential) await revokeInstallationToken(credential); }
}

type ReadIdentity = RunIdentity & { repositoryUrl: string; authorize: () => Promise<void> };

/** Read-only repository inspection never repairs issue sync or opens/merges a PR. */
async function authorizedRepositoryRead(input: ReadIdentity) {
  await input.authorize();
  const context = await contextWithToken(input.projectId, input.taskId, "read");
  const path = repositoryPath(input.repositoryUrl);
  if (!context.token || !context.project.githubWorkspaceAccess || !context.task || !context.repo
    || repositoryPath(context.project.repoUrl || "").toLowerCase() !== path.toLowerCase()) throw new Error("Repository authorization or task linkage changed");
  if (context.task.githubIssueUrl && (!context.task.githubIssueNumber || context.task.githubIssueUrl.toLowerCase() !== `${input.repositoryUrl}/issues/${context.task.githubIssueNumber}`.toLowerCase())) throw new Error("Issue repository linkage changed");
  const remote = await githubRequest<{ id: number; full_name: string }>(path, context.token);
  if (!Number.isSafeInteger(remote.id) || remote.full_name.toLowerCase() !== path.slice(7).toLowerCase()
    || context.project.githubRepoId && context.project.githubRepoId !== remote.id
    || context.task.githubIssueRepoId && context.task.githubIssueRepoId !== remote.id) throw new Error("Repository identity changed");
  return { context, path, repoId: remote.id, token: context.token };
}

/** Recover an exact verified merge after a lost response, including an auto-closed issue. */
export async function reconcileMergedRunPullRequest(input: ReadIdentity & { branch: string; baseBranch: string; headSha: string }): Promise<ExecutionMerge> {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(input.headSha) || !input.branch || !input.baseBranch || input.branch === input.baseBranch) return { state: "blocked", reason: "No exact verified task head is available" };
  try {
    const run = await authorizedRepositoryRead(input);
    const owner = run.path.slice(7).split("/")[0];
    for (let page = 1; ; page++) {
      const pulls = await githubRequest<PullRequest[]>(`${run.path}/pulls?state=closed&head=${encodeURIComponent(`${owner}:${input.branch}`)}&base=${encodeURIComponent(input.baseBranch)}&per_page=100&page=${page}`, run.token);
      for (const candidate of pulls) {
        if (!candidate.body?.includes(`<!-- origin-task:${input.taskId} -->`)) continue;
        const pr = await githubRequest<PullRequest>(`${run.path}/pulls/${candidate.number}`, run.token);
        if (!pr.body?.includes(`<!-- origin-task:${input.taskId} -->`) || !pr.merged || !pr.merged_at || !Number.isFinite(Date.parse(pr.merged_at))
          || !pr.merge_commit_sha || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(pr.merge_commit_sha)
          || pr.head.sha !== input.headSha || pr.head.ref !== input.branch || pr.base.ref !== input.baseBranch
          || pr.head.repo?.id !== run.repoId || pr.base.repo.id !== run.repoId) continue;
        await input.authorize();
        return { state: "merged", number: pr.number, url: `${input.repositoryUrl}/pull/${pr.number}`, mergeSha: pr.merge_commit_sha };
      }
      if (pulls.length < 100) {
        await input.authorize();
        return { state: "blocked", reason: "No exact-head merged pull request matches this completed issue" };
      }
      if (page >= 20) throw new Error("Cannot inspect all matching pull requests");
    }
  } catch {
    return { state: "awaiting_checks", reason: "Merge outcome is uncertain; waiting for a read-only exact-head GitHub receipt" };
  }
}

type Deployment = { id: number; sha: string; environment: string; created_at: string };
type DeploymentStatus = { id: number; state: string; created_at: string; updated_at?: string };

/** Deployment evidence is independent of CI and merge. This never initiates a deployment. */
export async function readRunDeployment(input: ReadIdentity & { mergeSha: string }): Promise<ExecutionDeployment> {
  const observedAt = Date.now();
  const unknown = (message: string): ExecutionDeployment => ({ status: "unknown", mergeSha: input.mergeSha, observedAt, message });
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(input.mergeSha)) return unknown("An exact confirmed merge SHA is required");
  let credential: string | undefined;
  try {
    const run = await authorizedRepositoryRead(input);
    const permission = { deployments: "read" };
    const scoped = run.context.sharedConnection
      ? await integrationBridge<{ token: string; repoUrl: string }>("githubToken", { projectId: input.projectId, access: "read", extra: permission })
      : await projectInstallationToken(input.projectId, input.repositoryUrl, false, { contents: "read", issues: "read", pull_requests: "read", checks: "read", ...permission });
    credential = scoped.token;
    if ("repoUrl" in scoped && repositoryPath(scoped.repoUrl).toLowerCase() !== run.path.toLowerCase()) throw new Error("Deployment credential repository changed");
    let latest: { deployment: Deployment; state: string; at: number; statusId: number; url: string } | undefined;
    for (let page = 1; ; page++) {
      const deployments = await githubRequest<Deployment[]>(`${run.path}/deployments?sha=${encodeURIComponent(input.mergeSha)}&per_page=100&page=${page}`, credential);
      for (const deployment of deployments) {
        if (deployment.sha !== input.mergeSha) continue;
        if (!Number.isSafeInteger(deployment.id) || !Number.isFinite(Date.parse(deployment.created_at))) throw new Error("Invalid deployment evidence");
        // A newer deployment with no status supersedes an older success, but remains unknown.
        let evidence = { deployment, state: "unknown", at: Date.parse(deployment.created_at), statusId: 0, url: `https://api.github.com${run.path}/deployments/${deployment.id}` };
        for (let statusPage = 1; ; statusPage++) {
          const statuses = await githubRequest<DeploymentStatus[]>(`${run.path}/deployments/${deployment.id}/statuses?per_page=100&page=${statusPage}`, credential);
          for (const status of statuses) {
            const at = Date.parse(status.updated_at || status.created_at);
            if (!Number.isFinite(at) || !Number.isSafeInteger(status.id)) throw new Error("Invalid deployment status evidence");
            if (at > evidence.at || at === evidence.at && status.id > evidence.statusId) evidence = { deployment, state: status.state, at, statusId: status.id, url: `https://api.github.com${run.path}/deployments/${deployment.id}/statuses/${status.id}` };
          }
          if (statuses.length < 100) break;
          if (statusPage >= 20) throw new Error("Cannot inspect all deployment statuses");
        }
        if (!latest || evidence.at > latest.at || evidence.at === latest.at && (deployment.id > latest.deployment.id || deployment.id === latest.deployment.id && evidence.statusId > latest.statusId)) latest = evidence;
      }
      if (deployments.length < 100) break;
      if (page >= 20) throw new Error("Cannot inspect all deployments");
    }
    await input.authorize();
    if (!latest) return unknown("No GitHub deployment evidence for the exact merge SHA");
    const status = latest.state === "success" ? "succeeded" : ["failure", "error"].includes(latest.state) ? "failed" : ["queued", "pending", "in_progress"].includes(latest.state) ? "pending" : "unknown";
    return { status, mergeSha: input.mergeSha, observedAt, evidenceAt: latest.at, environment: latest.deployment.environment, url: latest.url,
      message: `Latest GitHub deployment evidence (${latest.deployment.environment}): ${latest.state}` };
  } catch {
    return unknown("GitHub deployment evidence is unavailable; deployment has not been inferred from the merge or CI");
  } finally { if (credential) await revokeInstallationToken(credential); }
}
