import { randomBytes } from "node:crypto";
import { z } from "zod";
import { openIntegration, sealIntegration } from "./githubConnection";
import { integrationBridge, originUrl } from "./integration-bridge";
import { executionRunnerPublicKey } from "./execution-bundle";
import { cloudHerdrConnectionPlan, type CloudHerdrConnectionPlan } from "./execution-cloud-runtime";
import { prepareRunRepository } from "./github-execution";
import { executionSelectionKey, routeExecution, verificationMatchesPolicy } from "./execution-policy";
import {
  ExecutionError, executionHarness, executionId, HEARTBEAT_SECONDS, LEASE_SECONDS, observedExecutionHost,
  redactExecutionText, redactExecutionValue, revalidateExecutionPrincipal, sealRunEnvironment, type StoredEnvironment, type StoredCloudProvider,
} from "./execution-common";
import {
  accountIdentity, acknowledgeExecutionControls, appendExecutionEvent, atomicExecution, authenticatedExecutionHost,
  executionAccountBinding, executionAccounts, executionDb, executionHosts, executionRuns, executionSetting, executionUnstoppedHostRuns,
  executionTokenHash, pendingExecutionControls, readExecutionHost, readExecutionRun, replaceExecutionAccounts,
  saveExecutionHost, saveExecutionRun, setExecutionSetting, deleteExecutionSetting, cloudAllocations, patchCloudAllocation,
  type ExecutionPrincipal, type PrivateRun,
} from "./execution-store";
import type { ExecutionAccountReport, ExecutionHost, ExecutionUpdate, ExecutionVerification, ExecutionWorkerRun } from "./execution-types";

const accountSchema = z.object({
  id: executionId, identityHash: z.string().min(16).max(200), provider: z.string().min(1).max(80), label: z.string().max(160),
  authKind: z.enum(["subscription", "api", "unknown"]), authenticated: z.boolean(), harnesses: z.array(executionHarness).max(5),
  models: z.array(z.object({ id: z.string().min(1).max(200), efforts: z.array(z.string().max(40)).max(20).optional() })).max(1000).optional(),
  plan: z.string().max(100).optional(), quota: z.object({ status: z.enum(["available", "unknown", "stale", "error"]), observedAt: z.number().finite().nonnegative(), error: z.string().max(500).optional(),
    windows: z.array(z.object({ id: z.string().min(1).max(120), label: z.string().max(160), usedPercent: z.number().finite().min(0).max(100000), resetsAt: z.number().finite().nonnegative().nullable(), durationMinutes: z.number().positive().optional(), scope: z.enum(["account", "model", "feature", "unknown"]).optional(), modelIds: z.array(z.string().max(200)).max(100).optional() })).max(50) }),
});
const hostDescription = z.object({ name: z.string().trim().min(1).max(100), platform: z.enum(["linux", "darwin"]), kind: z.enum(["nixos", "mac", "boxd", "boat"]), version: z.string().min(1).max(120), capabilities: z.array(executionHarness).max(5), tailnetName: z.string().max(253).regex(/^[a-zA-Z0-9.-]+$/).optional() });
const verificationSchema = z.array(z.object({ command: z.string().max(2000), exitCode: z.number().int(), kind: z.enum(["test", "smoke"]), summary: z.string().max(3000).optional() })).max(20);
const shaSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i);
const updateReportsSchema = z.array(z.object({ component: z.string().min(1).max(100), currentVersion: z.string().max(120).optional(), availableVersion: z.string().max(120).optional(), status: z.enum(["unknown", "current", "available", "pending", "updating", "failed"]), message: z.string().max(1000).optional(), checkedAt: z.number().finite().nonnegative().optional() })).max(20);
const herdrReportSchema = z.object({
  enabled: z.boolean(), cloudConnections: z.boolean(), version: z.string().max(120).optional(),
  status: z.enum(["ready", "unavailable", "needs_auth"]).optional(), message: z.string().max(500).optional(),
}).strict();
const terminalText = z.string().min(1).max(128).regex(/^[^\x00-\x1f\x7f-\x9f]+$/);
const terminalSchema = z.object({ type: z.literal("terminal"), backend: z.literal("herdr"), coreId: terminalText, terminalId: terminalText, name: terminalText, session: terminalText }).strict();

function storeUpdateReports(host: ExecutionHost, reports: ExecutionUpdate[]) {
  const updates = new Map((executionSetting<ExecutionUpdate[]>(host.teamId, "updates", host.id) ?? []).map(update => [update.component, update]));
  for (const report of reports) {
    const update = { ...report, hostId: host.id };
    update.component = redactExecutionText(update.component);
    if (update.message !== undefined) update.message = redactExecutionText(update.message);
    if (update.currentVersion !== undefined) update.currentVersion = redactExecutionText(update.currentVersion);
    if (update.availableVersion !== undefined) update.availableVersion = redactExecutionText(update.availableVersion);
    if (update.checkedAt !== undefined) update.checkedAt = Math.min(update.checkedAt, Date.now());
    if ((updates.get(update.component)?.checkedAt ?? -1) <= (update.checkedAt ?? -1)) updates.set(update.component, update);
  }
  setExecutionSetting(host.teamId, "updates", host.id, [...updates.values()].sort((a, b) => (b.checkedAt ?? -1) - (a.checkedAt ?? -1)).slice(0, 20));
}

async function hostPrincipal(host: ExecutionHost) {
  const principal = await integrationBridge<ExecutionPrincipal>("executionContext", { userId: host.ownerId, teamId: host.teamId });
  if (!principal.write || principal.userId !== host.ownerId || principal.teamId !== host.teamId) throw new ExecutionError("Machine owner's workspace access has been revoked", 403);
  return principal;
}
function leaseMatches(record: PrivateRun, host: ExecutionHost, token: string) {
  return record.run.hostId === host.id && record.run.teamId === host.teamId && record.run.requestedBy === host.ownerId && record.leaseHash === executionTokenHash(token);
}
function activeHostRuns(hostId: string) {
  return executionUnstoppedHostRuns(hostId).map(record => record.run.id);
}
function updateHostActivity(host: ExecutionHost) {
  const current = readExecutionHost(host.id);
  if (!current) return;
  current.activeRunIds = activeHostRuns(host.id); host.activeRunIds = current.activeRunIds; saveExecutionHost(current);
}
async function enroll(token: string, body: Record<string, unknown>) {
  const enrollmentToken = typeof body.enrollmentToken === "string" ? body.enrollmentToken : token;
  if (!enrollmentToken || token && token !== enrollmentToken) throw new ExecutionError("Enrollment token mismatch", 401);
  const description = hostDescription.parse(body.host);
  const row = executionDb().prepare("SELECT payload,expires FROM execution_enrollments WHERE hash=?").get(executionTokenHash(enrollmentToken)) as { payload: string; expires: number } | undefined;
  if (!row || row.expires <= Date.now()) throw new ExecutionError("Enrollment expired or already used", 401);
  const enrollment = JSON.parse(row.payload) as { host: ExecutionHost; allocationId?: string };
  const principal = await hostPrincipal(enrollment.host);
  if (!principal.admin || enrollment.host.projectIds.some(id => !principal.projectIds.includes(id))) throw new ExecutionError("Enrollment authorization has changed", 403);
  if (description.kind !== enrollment.host.kind || description.platform !== enrollment.host.platform) throw new ExecutionError("Machine platform does not match its enrollment");
  const runnerUpdates = { baseUrl: `${originUrl().replace(/\/$/, "")}/api/execution/releases`, publicKey: executionRunnerPublicKey() };
  const hostToken = randomBytes(32).toString("base64url");
  atomicExecution(() => {
    if (readExecutionHost(enrollment.host.id)?.revoked !== false) throw new ExecutionError("Machine enrollment was revoked", 403);
    const consumed = executionDb().prepare("DELETE FROM execution_enrollments WHERE hash=? AND expires>? RETURNING hash").get(executionTokenHash(enrollmentToken), Date.now());
    if (!consumed) throw new ExecutionError("Enrollment expired or already used", 401);
    saveExecutionHost({ ...enrollment.host, version: description.version, capabilities: description.capabilities, online: true, status: "online", lastSeenAt: Date.now(), ...(description.tailnetName ? { tailnetName: description.tailnetName.toLowerCase().replace(/\.$/, "") } : {}) }, executionTokenHash(hostToken));
  });
  return { hostId: enrollment.host.id, hostToken, protocolVersion: 1, heartbeatSeconds: HEARTBEAT_SECONDS, leaseDurationSeconds: LEASE_SECONDS, runnerUpdates };
}
async function desktopHerdrPlans(host: ExecutionHost): Promise<CloudHerdrConnectionPlan[]> {
  const version = /^(\d+)\.(\d+)\.(\d+)$/.exec(host.version);
  if (!version || !(Number(version[1]) > 1 || Number(version[1]) === 1 && Number(version[2]) >= 1) || !host.herdr?.enabled || !host.herdr.cloudConnections || !["nixos", "mac"].includes(host.kind)) return [];
  const plans: CloudHerdrConnectionPlan[] = [];
  for (const allocation of cloudAllocations(host.teamId)) {
    if (plans.length >= 32) break;
    if (allocation.teamId !== host.teamId || allocation.ownerId !== host.ownerId || !host.projectIds.includes(allocation.projectId) || allocation.status !== "ready" || !allocation.hostId) continue;
    const assertCurrent = () => {
      const current = readExecutionHost(host.id);
      if (!current || current.revoked || current.ownerId !== host.ownerId || current.teamId !== host.teamId || current.kind !== host.kind || !current.herdr?.enabled || !current.herdr.cloudConnections || !current.projectIds.includes(allocation.projectId) || current.lastSeenAt > Date.now() || Date.now() - current.lastSeenAt > 45_000) throw new ExecutionError("Desktop connection authorization expired", 403);
      const cloudHost = readExecutionHost(allocation.hostId!);
      if (!cloudHost || cloudHost.revoked || cloudHost.paused || cloudHost.teamId !== host.teamId || cloudHost.ownerId !== host.ownerId || cloudHost.kind !== allocation.provider || !cloudHost.projectIds.includes(allocation.projectId) || cloudHost.lastSeenAt > Date.now() || Date.now() - cloudHost.lastSeenAt > 45_000) throw new ExecutionError("Cloud worker authorization expired", 403);
      const active = executionUnstoppedHostRuns(allocation.hostId!).some(record => record.run.teamId === host.teamId && record.run.requestedBy === host.ownerId && record.run.projectId === allocation.projectId && !record.run.processStopped && !record.cancelRequested && record.leaseExpiresAt > Date.now());
      if (!active) throw new ExecutionError("No active authorized cloud task", 403);
    };
    const authorize = async () => {
      assertCurrent();
      const principal = await integrationBridge<ExecutionPrincipal>("executionContext", { userId: host.ownerId, teamId: host.teamId, projectId: allocation.projectId });
      if (principal.userId !== host.ownerId || principal.teamId !== host.teamId || !principal.write || !principal.admin || !principal.projectIds.includes(allocation.projectId)) throw new ExecutionError("Cloud project access revoked", 403);
      assertCurrent();
      return principal;
    };
    try { plans.push(await cloudHerdrConnectionPlan(allocation.id, allocation.provider, host.kind === "mac" ? "macos" : "nixos", authorize)); }
    catch { /* No private allocation details or provider failures cross the host boundary. */ }
  }
  return plans;
}
async function heartbeat(host: ExecutionHost, body: Record<string, unknown>) {
  const principal = await hostPrincipal(host);
  const input = z.object({ version: z.string().max(120), platform: z.enum(["linux", "darwin"]), capabilities: z.array(executionHarness).max(5), activeRunIds: z.array(executionId).max(10), accounts: z.array(accountSchema).max(30), capacity: z.literal(1), paused: z.boolean(), updateReports: updateReportsSchema.optional(), herdr: herdrReportSchema.optional() }).parse(body);
  if (input.platform !== host.platform) throw new ExecutionError("Machine platform changed; enroll it again");
  const accounts: ExecutionAccountReport[] = input.accounts.map(account => ({ ...account, quota: { ...account.quota, observedAt: Math.min(account.quota.observedAt, Date.now()), ...(account.quota.error ? { error: redactExecutionText(account.quota.error) } : {}) } }));
  let refreshUsage = false;
  const maintenance: { id: string; op: "checkUpdates" | "applyUpdates" }[] = [];
  atomicExecution(() => {
    const current = readExecutionHost(host.id)!;
    current.lastSeenAt = Date.now(); current.version = input.version; current.capabilities = input.capabilities; current.capacity = 1;
    current.online = true; current.status = "online"; current.projectIds = current.projectIds.filter(id => principal.projectIds.includes(id));
    current.locallyPaused = input.paused; current.paused = Boolean(current.pauseRequested || current.locallyPaused);
    current.herdr = input.herdr ? { ...input.herdr, ...(input.herdr.version ? { version: redactExecutionText(input.herdr.version).slice(0, 120) } : {}), ...(input.herdr.message ? { message: redactExecutionText(input.herdr.message).slice(0, 500) } : {}), updatedAt: Date.now() } : undefined;
    current.accountIds = [...new Set(accounts.map(account => accountIdentity(current.ownerId, account)))];
    replaceExecutionAccounts(current, accounts); saveExecutionHost(current); updateHostActivity(current);
    if (input.updateReports) storeUpdateReports(current, input.updateReports);
    const refresh = executionSetting<{ requestedAt: number }>(host.teamId, "refresh_usage", host.id);
    refreshUsage = Boolean(refresh); if (refresh) deleteExecutionSetting(host.teamId, "refresh_usage", host.id);
    const request = executionSetting<{ id: string; op: "checkUpdates" | "applyUpdates" }>(host.teamId, "maintenance", host.id);
    if (request && !current.activeRunIds.length && !input.activeRunIds.length) maintenance.push({ id: request.id, op: request.op });
    const updates = executionSetting<ExecutionUpdate[]>(host.teamId, "updates", host.id);
    if (updates?.some(update => update.component === "origin-runner" && update.status === "updating" && update.availableVersion === input.version)) {
      setExecutionSetting(host.teamId, "updates", host.id, updates.map(update => update.component === "origin-runner" && update.status === "updating" && update.availableVersion === input.version ? { ...update, currentVersion: input.version, status: "current", message: "New version confirmed by the restarted worker", checkedAt: Date.now() } : update));
    }
  });
  const current = readExecutionHost(host.id)!;
  const known = new Set(activeHostRuns(host.id));
  const cancelRunIds = input.activeRunIds.filter(id => !known.has(id) || readExecutionRun(id)?.cancelRequested);
  const herdrPlans = await desktopHerdrPlans(current);
  return { cancelRunIds, refreshUsage, maintenance, herdrPlans, paused: Boolean(current.pauseRequested), serverTime: Date.now(), leaseDurationSeconds: LEASE_SECONDS };
}
async function claim(host: ExecutionHost) {
  await hostPrincipal(host);
  if (host.paused || activeHostRuns(host.id).length >= host.capacity) return { run: null, reason: "Machine paused or busy" };
  if ((host.kind === "boxd" || host.kind === "boat") && executionSetting<StoredCloudProvider>(host.teamId, "cloud", host.kind)?.enabled !== true) return { run: null, reason: "Cloud provider is disabled" };
  for (const candidate of executionRuns(host.teamId, true).filter(record => record.run.status === "queued" && record.run.requestedBy === host.ownerId && host.projectIds.includes(record.run.projectId)).sort((a, b) => a.run.createdAt - b.run.createdAt)) {
    const route = routeExecution({ policy: candidate.policy, projectId: candidate.run.projectId, ownerId: candidate.run.requestedBy, hosts: executionHosts(host.teamId).map(host => observedExecutionHost(host)), accounts: candidate.run.verificationOnly ? [] : executionAccounts(host.teamId, host.ownerId), attempted: candidate.attempted, verificationOnly: candidate.run.verificationOnly });
    if (route.host?.id !== host.id || !candidate.run.verificationOnly && !route.selection) continue;
    await revalidateExecutionPrincipal(candidate);
    const repository = await prepareRunRepository({ projectId: candidate.run.projectId, taskId: candidate.run.taskId, baseBranch: candidate.policy.baseBranch });
    await revalidateExecutionPrincipal(candidate);
    if (repository.repositoryUrl.replace(/\.git\/?$/, "").replace(/\/$/, "").toLowerCase() !== candidate.run.repositoryUrl.toLowerCase()) throw new ExecutionError("Repository changed since the run was queued");
    const leaseToken = randomBytes(32).toString("base64url");
    const accepted = atomicExecution(() => {
      const record = readExecutionRun(candidate.run.id), currentHost = readExecutionHost(host.id);
      if (!record || record.run.status !== "queued" || !record.run.processStopped || record.cancelRequested || !currentHost || currentHost.paused || currentHost.revoked || activeHostRuns(host.id).length >= currentHost.capacity) return null;
      const cloud = currentHost.kind === "boxd" || currentHost.kind === "boat";
      const allocation = cloud ? cloudAllocations(host.teamId).find(allocation => allocation.hostId === host.id) : undefined;
      if (cloud && (executionSetting<StoredCloudProvider>(host.teamId, "cloud", currentHost.kind)?.enabled !== true || allocation?.status !== "ready")) return null;
      if (executionSetting(host.teamId, "maintenance", host.id)) return null;
      const currentRoute = routeExecution({ policy: record.policy, projectId: record.run.projectId, ownerId: host.ownerId, hosts: executionHosts(host.teamId).map(host => observedExecutionHost(host)), accounts: record.run.verificationOnly ? [] : executionAccounts(host.teamId, host.ownerId), attempted: record.attempted, verificationOnly: record.run.verificationOnly });
      if (currentRoute.host?.id !== host.id) return null;
      const selection = record.run.verificationOnly ? record.run.selection : currentRoute.selection;
      if (!selection || record.run.verificationOnly && !record.run.checkpoint) return null;
      const binding = record.run.verificationOnly ? undefined : executionAccountBinding(selection, host.id, record.policy.allowPaidApi);
      const billingKind = record.run.verificationOnly ? record.billingKind : binding?.authKind;
      if (!billingKind || billingKind === "unknown") return null;
      const environment = executionSetting<StoredEnvironment>(host.teamId, "environment", `${record.run.projectId}:${record.policy.environment}`);
      if (environment && (!environment.automationEnabled || !environment.hostIds.includes(host.id))) {
        record.run.reason = "This environment is not authorized for the selected machine"; record.run.updatedAt = Date.now(); saveExecutionRun(record); return null;
      }
      const variables = environment ? JSON.parse(openIntegration(environment.sealed, `execution-environment:${host.teamId}:${environment.id}`)) as Record<string, string> : {};
      record.attemptStartedAt = Date.now(); record.attemptUsage = { inputTokens: 0, outputTokens: 0, estimatedApiUsd: 0 }; record.billingKind = billingKind;
      record.environmentRevision = environment?.updatedAt ?? 0;
      record.run.status = "preparing"; record.run.hostId = host.id; record.run.selection = selection; record.run.attempt += 1;
      record.run.updatedAt = Date.now(); record.run.reason = undefined; record.run.processStopped = false; record.run.verification = [];
      record.run.verifiedBaseSha = undefined;
      record.run.herdr = undefined;
      record.leaseHash = executionTokenHash(leaseToken); record.leaseExpiresAt = Date.now() + LEASE_SECONDS * 1000; record.sequence = 0;
      record.sealedEnvironment = sealRunEnvironment(record.run.id, variables);
      if (repository.gitCredential) { record.sealedGitCredential = sealIntegration(JSON.stringify(repository.gitCredential), `execution-git:${record.run.id}`); record.gitCredentialExpiresAt = repository.gitCredential.expiresAt; }
      if (allocation) patchCloudAllocation(allocation.id, { runDeadline: { runId: record.run.id, attempt: record.run.attempt, deadline: record.attemptStartedAt + record.policy.timeoutSeconds * 1000 + 300000 }, runnerStoppedAt: undefined, stopProof: undefined });
      saveExecutionRun(record); appendExecutionEvent(record.run.id, { type: "status", text: record.run.verificationOnly ? `Claimed by ${host.name} to align and re-verify the checkpoint; no model will run` : `Claimed by ${host.name} using ${selection.harness} / ${selection.model}` }); updateHostActivity(currentHost);
      const run: ExecutionWorkerRun = { id: record.run.id, attempt: record.run.attempt, verificationOnly: record.run.verificationOnly, taskId: record.run.taskId, projectId: record.run.projectId, leaseToken, leaseDurationSeconds: LEASE_SECONDS,
        repositoryUrl: record.run.repositoryUrl, baseBranch: record.policy.baseBranch, branch: record.run.branch, environment: record.policy.environment, prompt: record.prompt,
        selection: { ...selection, accountId: binding?.id ?? selection.accountId, logicalAccountId: selection.accountId }, billingKind, verificationCommands: record.policy.verificationCommands, smokeCommand: record.policy.smokeCommand,
        environmentVariables: variables, ...(repository.gitCredential ? { gitCredential: repository.gitCredential } : {}),
        ...(record.run.checkpoint ? { resume: { checkpointSha: record.run.checkpoint.sha, summary: record.run.checkpoint.summary } } : {}),
        timeoutSeconds: record.policy.timeoutSeconds, permissionMode: "ask", cloud: host.kind === "boxd" || host.kind === "boat" };
      return run;
    });
    if (accepted) return { run: accepted };
  }
  return { run: null, reason: "No eligible queued work for this machine and account" };
}
async function control(host: ExecutionHost, body: Record<string, unknown>) {
  const input = z.object({ runId: executionId, leaseToken: z.string().min(32).max(200), ackMessageIds: z.array(executionId).max(100).optional(), ackApprovalIds: z.array(executionId).max(100).optional(), refreshGitCredential: z.boolean().optional() }).parse(body);
  const record = readExecutionRun(input.runId);
  if (!record || !leaseMatches(record, host, input.leaseToken)) throw new ExecutionError("Invalid execution lease", 403);
  if (record.leaseExpiresAt <= Date.now() || record.run.processStopped) return { cancel: true, leaseValid: false, messages: [], approvals: [], leaseDurationSeconds: LEASE_SECONDS };
  let authorizationFailed = false;
  try { await revalidateExecutionPrincipal(record); }
  catch { authorizationFailed = true; }
  let gitCredential: ExecutionWorkerRun["gitCredential"];
  if (!authorizationFailed && !record.cancelRequested && (input.refreshGitCredential || record.gitCredentialExpiresAt && record.gitCredentialExpiresAt < Date.now() + 300000)) {
    try { gitCredential = (await prepareRunRepository({ projectId: record.run.projectId, taskId: record.run.taskId, baseBranch: record.policy.baseBranch })).gitCredential; }
    catch { /* An expired Git credential is never extended by a failed refresh. */ }
    try { await revalidateExecutionPrincipal(record); }
    catch { authorizationFailed = true; gitCredential = undefined; }
  }
  return atomicExecution(() => {
    const latest = readExecutionRun(input.runId)!;
    if (!leaseMatches(latest, host, input.leaseToken) || latest.leaseExpiresAt <= Date.now() || latest.run.processStopped) return { cancel: true, leaseValid: false, messages: [], approvals: [], leaseDurationSeconds: LEASE_SECONDS };
    const environment = executionSetting<StoredEnvironment>(host.teamId, "environment", `${latest.run.projectId}:${latest.policy.environment}`);
    if ((environment?.updatedAt ?? 0) !== (latest.environmentRevision ?? 0) || environment && (!environment.automationEnabled || !environment.hostIds.includes(host.id))) {
      latest.cancelRequested = true; latest.run.reason = "Project environment or machine authorization changed; restart with the current scope";
    }
    if (authorizationFailed) { latest.cancelRequested = true; latest.run.reason = "Project, issue or requester authorization is unavailable"; }
    if (latest.cancelRequested) gitCredential = undefined;
    latest.leaseExpiresAt = Date.now() + LEASE_SECONDS * 1000;
    if (gitCredential) { latest.sealedGitCredential = sealIntegration(JSON.stringify(gitCredential), `execution-git:${latest.run.id}`); latest.gitCredentialExpiresAt = gitCredential.expiresAt; }
    acknowledgeExecutionControls(latest.run.id, [...(input.ackMessageIds || []), ...(input.ackApprovalIds || []).map(id => `approval:${latest.run.id}:${id}`)]);
    saveExecutionRun(latest);
    const pending = pendingExecutionControls(latest.run.id);
    return { cancel: latest.cancelRequested, leaseValid: true, leaseDurationSeconds: LEASE_SECONDS,
      messages: pending.filter(item => item.kind === "message").map(item => ({ id: item.id, text: item.value.text })),
      approvals: pending.filter(item => item.kind === "approval").map(item => item.value), ...(gitCredential ? { gitCredential } : {}) };
  });
}
function finished(record: PrivateRun, event: Record<string, unknown>, expired: boolean) {
  const input = z.object({ result: z.enum(["succeeded", "failed", "cancelled", "quota", "provider_unavailable", "needs_auth", "needs_approval"]), summary: z.string().max(12000), headSha: shaSchema.optional(), baseSha: shaSchema.optional(), branch: z.string().max(250).optional(), verification: verificationSchema.optional(), processStopped: z.literal(true), checkpointSha: shaSchema.optional(), activityStarted: z.boolean().optional() }).parse(event);
  record.run.processStopped = true; record.leaseExpiresAt = 0; record.run.summary = redactExecutionText(input.summary, record).slice(0, 12000);
  if (input.branch && input.branch !== record.run.branch) throw new ExecutionError("Worker reported a different task branch");
  if (input.checkpointSha) record.run.checkpoint = { sha: input.checkpointSha, summary: record.run.summary };
  record.run.verification = (input.verification || []).map(result => ({ ...result, ...(result.summary ? { summary: redactExecutionText(result.summary, record) } : {}) })) as ExecutionVerification[];
  if (record.cancelRequested || input.result === "cancelled") { record.run.status = "cancelled"; record.run.reason = "Worker confirmed its processes stopped"; return; }
  if (expired) { record.run.status = "blocked"; record.run.reason = "The worker stopped after its lease expired. Review the checkpoint before resuming"; return; }
  if (record.run.verificationOnly && input.activityStarted !== false) { record.run.status = "blocked"; record.run.reason = "Verification-only attempt did not prove that no model work was started"; return; }
  if (input.result === "succeeded") {
    if (!input.headSha || !input.baseSha || input.checkpointSha && input.checkpointSha !== input.headSha || !verificationMatchesPolicy(record.policy, record.run.verification)) { record.run.status = "failed"; record.run.reason = "Missing exact-head/base evidence or configured test/smoke verification"; return; }
    record.run.checkpoint = { sha: input.headSha, summary: record.run.summary };
    record.run.verifiedBaseSha = input.baseSha;
    record.run.status = record.policy.autoMerge ? "awaiting_checks" : "succeeded";
    record.run.reason = record.policy.autoMerge ? "Code verified; waiting for GitHub checks and merge authorization" : "Verified branch pushed; automatic merging is disabled";
    return;
  }
  const fallback = !record.run.verificationOnly && (input.result === "quota" && record.policy.fallbackMode !== "disabled" || input.result === "provider_unavailable" && record.policy.fallbackMode === "quota-and-outage");
  if (fallback && record.run.selection) {
    const key = executionSelectionKey(record.run.selection);
    if (!record.attempted.includes(key)) record.attempted.push(key);
    const remaining = record.policy.fallback.some(selection => !record.attempted.includes(executionSelectionKey(selection)) && (record.policy.allowCrossHarness || selection.harness === record.policy.fallback[0]?.harness));
    if (remaining && (input.activityStarted === false || input.checkpointSha)) {
      record.run.status = "queued"; record.run.reason = "Previous process stopped; continuing from its checkpoint with the next approved selection"; return;
    }
    record.run.status = "blocked"; record.run.reason = remaining ? "Partial work needs a pushed checkpoint before another harness can continue" : "No remaining approved account/model fallback is available"; return;
  }
  record.run.status = input.result === "needs_auth" || input.result === "needs_approval" ? "blocked" : "failed";
  record.run.reason = record.run.summary || input.result;
}
function acceptEvent(host: ExecutionHost, body: Record<string, unknown>) {
  const input = z.object({ runId: executionId, leaseToken: z.string().min(32).max(200), sequence: z.number().int().positive(), event: z.record(z.string(), z.unknown()) }).parse(body);
  return atomicExecution(() => {
    const record = readExecutionRun(input.runId);
    if (!record || !leaseMatches(record, host, input.leaseToken)) throw new ExecutionError("Invalid execution lease", 403);
    if (input.sequence <= record.sequence) return { accepted: true };
    const expired = host.revoked || record.leaseExpiresAt <= Date.now();
    const event = input.event;
    if (expired && !(event.type === "finished" && event.processStopped === true)) throw new ExecutionError("Execution lease expired", 409);
    if (record.run.processStopped) {
      if (event.type === "finished" && event.processStopped === true) return { accepted: true };
      throw new ExecutionError("This run attempt is already stopped", 409);
    }
    switch (event.type) {
      case "terminal": {
        const terminal = terminalSchema.parse(event);
        record.run.herdr = { backend: terminal.backend, coreId: redactExecutionText(terminal.coreId, record).slice(0, 128), terminalId: redactExecutionText(terminal.terminalId, record).slice(0, 128), name: redactExecutionText(terminal.name, record).slice(0, 128), session: redactExecutionText(terminal.session, record).slice(0, 128), updatedAt: Date.now() };
        break;
      }
      case "log": {
        const log = z.object({ stream: z.enum(["stdout", "stderr", "system"]), text: z.string().max(32000) }).parse(event);
        if (record.logBytes < 20 * 1024 * 1024) { const text = redactExecutionText(log.text, record); record.logBytes += Buffer.byteLength(text); appendExecutionEvent(record.run.id, { type: "log", stream: log.stream, text }); }
        else if (!record.logsCapped) { record.logsCapped = true; appendExecutionEvent(record.run.id, { type: "log", stream: "system", text: "Run log reached its 20 MiB limit; additional log output is not retained" }); }
        break;
      }
      case "status": {
        const status = z.enum(["preparing", "running", "verifying", "blocked"]).parse(event.status);
        record.run.status = status; if (typeof event.message === "string") record.run.reason = redactExecutionText(event.message.slice(0, 3000), record);
        appendExecutionEvent(record.run.id, { type: "status", text: record.run.reason || status }); break;
      }
      case "approval": {
        const approvalId = executionId.parse(event.approvalId), tool = redactExecutionText(z.string().max(200).parse(event.tool), record);
        if (!record.run.approvals.some(approval => approval.id === approvalId)) {
          if (record.run.approvals.length >= 1000) throw new ExecutionError("This run reached its approval limit");
          const encoded = JSON.stringify(event.input ?? null); if (encoded.length > 16000) throw new ExecutionError("Approval input is too large");
          const approval = { id: approvalId, tool, input: redactExecutionValue(event.input ?? null, record), createdAt: Date.now() };
          record.run.approvals.push(approval); record.run.status = "blocked"; record.run.reason = `Owner approval required: ${tool}`;
          appendExecutionEvent(record.run.id, { type: "approval", text: record.run.reason, data: { approvalId, tool } });
        }
        break;
      }
      case "checkpoint": {
        const sha = shaSchema.parse(event.sha); if (event.branch !== record.run.branch) throw new ExecutionError("Checkpoint belongs to a different branch");
        record.run.checkpoint = { sha, summary: redactExecutionText(z.string().max(12000).parse(event.summary), record) };
        appendExecutionEvent(record.run.id, { type: "checkpoint", text: sha }); break;
      }
      case "usage": {
        const inputTokens = z.number().finite().nonnegative().optional().parse(event.inputTokens), outputTokens = z.number().finite().nonnegative().optional().parse(event.outputTokens), estimatedApiUsd = z.number().finite().nonnegative().optional().parse(event.estimatedApiUsd);
        const previous = record.attemptUsage ||= { inputTokens: 0, outputTokens: 0, estimatedApiUsd: 0 };
        if (inputTokens !== undefined) { record.run.usage.inputTokens += Math.max(0, inputTokens - previous.inputTokens); previous.inputTokens = Math.max(previous.inputTokens, inputTokens); }
        if (outputTokens !== undefined) { record.run.usage.outputTokens += Math.max(0, outputTokens - previous.outputTokens); previous.outputTokens = Math.max(previous.outputTokens, outputTokens); }
        if (estimatedApiUsd !== undefined && record.billingKind === "api") { record.run.usage.estimatedApiUsd = (record.run.usage.estimatedApiUsd || 0) + Math.max(0, estimatedApiUsd - previous.estimatedApiUsd); previous.estimatedApiUsd = Math.max(previous.estimatedApiUsd, estimatedApiUsd); }
        break;
      }
      case "finished": finished(record, event, expired); appendExecutionEvent(record.run.id, { type: "finished", text: record.run.reason || record.run.summary || record.run.status }); break;
      default: throw new ExecutionError("Unknown worker event");
    }
    record.sequence = input.sequence; record.run.updatedAt = Date.now(); saveExecutionRun(record); updateHostActivity(host);
    return { accepted: true };
  });
}
export async function executionWorkerRequest(token: string, body: Record<string, unknown>): Promise<unknown> {
  if (body.protocolVersion !== 1) throw new ExecutionError("Unsupported worker protocol version");
  if (body.op === "enroll") return enroll(token, body);
  const stoppedReceipt = body.op === "event" && !!body.event && typeof body.event === "object" && (body.event as Record<string, unknown>).type === "finished" && (body.event as Record<string, unknown>).processStopped === true;
  const host = authenticatedExecutionHost(token, stoppedReceipt);
  if (!host || body.hostId !== host.id) throw new ExecutionError("Machine authentication failed", 401);
  switch (body.op) {
    case "heartbeat": return heartbeat(host, body);
    case "claim": return claim(host);
    case "control": return control(host, body);
    case "event": return acceptEvent(host, body);
    case "maintenanceResult": {
      const id = executionId.parse(body.id), pending = executionSetting<{ id: string }>(host.teamId, "maintenance", host.id);
      if (pending?.id !== id) return { accepted: true };
      storeUpdateReports(host, updateReportsSchema.parse(body.updates));
      deleteExecutionSetting(host.teamId, "maintenance", host.id); return { accepted: true };
    }
    default: throw new ExecutionError("Unknown worker operation");
  }
}
