import { randomUUID } from "node:crypto";
import { z } from "zod";
import { sealIntegration } from "./githubConnection";
import { cloudAccountUsage } from "./execution-cloud";
import { effectiveExecutionPolicy, executionBillingAllowed, parseExecutionPolicyOverride } from "./execution-policy";
import {
  activeExecutionStatuses, enrolledHost, ExecutionError, executionId, executionPolicies, observedExecutionHost,
  requireExecutionAdmin, requireExecutionRun, requireExecutionWrite, type StoredCloudProvider, type StoredEnvironment,
} from "./execution-common";
import {
  appendExecutionEvent, atomicExecution, deleteExecutionSetting, executionAccounts, executionAudit, executionEvents,
  executionHosts, executionRuns, executionSetting, executionSettings, queueExecutionControl, readExecutionHost,
  readExecutionRun, saveExecutionHost, saveExecutionRun, setExecutionSetting, type ExecutionPrincipal, type PrivateRun,
} from "./execution-store";
import type { ExecutionCloudProviderStatus, ExecutionPolicyOverride, ExecutionRun, ExecutionRunDetail, ExecutionSnapshot, ExecutionUpdate } from "./execution-types";

export function executionSnapshot(principal: ExecutionPrincipal): ExecutionSnapshot {
  const visible = new Set(principal.projectIds);
  const hosts = executionHosts(principal.teamId).filter(host => principal.admin || host.ownerId === principal.userId || host.projectIds.some(id => visible.has(id)))
    .map(host => ({ ...observedExecutionHost(host), projectIds: host.projectIds.filter(id => visible.has(id)) }));
  const accounts = executionAccounts(principal.teamId, principal.userId).map(account => ({
    ...account, quota: account.quota.status === "available" && Date.now() - account.quota.observedAt > 300000 ? { ...account.quota, status: "stale" as const } : account.quota,
  }));
  const runs = executionRuns(principal.teamId).map(record => record.run).filter(run => visible.has(run.projectId)
    && (!principal.project || run.projectId === principal.project.id) && (!principal.task || run.taskId === principal.task.id)).slice(0, 100);
  const environments = executionSettings<StoredEnvironment>(principal.teamId, "environment").filter(environment => visible.has(environment.projectId)
    && (!principal.project || environment.projectId === principal.project.id)).map(({ sealed: _sealed, teamId: _team, ...metadata }) => metadata);
  const cloudProviders: ExecutionCloudProviderStatus[] = ["boxd", "boat"].map(provider => {
    const stored = executionSetting<StoredCloudProvider>(principal.teamId, "cloud", provider);
    return stored ? { provider: stored.provider, enabled: stored.enabled, keyConfigured: stored.keyConfigured, updatedAt: stored.updatedAt, usage: stored.usage }
      : { provider: provider as "boxd" | "boat", enabled: false, keyConfigured: false, updatedAt: 0, usage: { status: "unknown" } };
  });
  const updates = executionSettings<ExecutionUpdate[]>(principal.teamId, "updates").flat().filter(update => !update.hostId || hosts.some(host => host.id === update.hostId));
  return { hosts, accounts, runs, environments, cloudProviders, updates,
    ...executionPolicies(principal.teamId, principal.project?.id, principal.task?.id), permissions: { admin: principal.admin || principal.projectAdmin, write: principal.write } };
}
export function executionRunDetail(principal: ExecutionPrincipal, runId: string, cursor = 0): ExecutionRunDetail {
  const record = requireExecutionRun(principal, runId);
  const events = executionEvents(runId, Math.max(0, Math.trunc(cursor)));
  return { run: record.run, events, nextCursor: events.at(-1)?.id ?? Math.max(0, Math.trunc(cursor)) };
}
const administratorPolicyFields = new Set(["allowPaidApi", "autoMerge", "baseBranch", "verificationCommands", "smokeCommand", "cloudEnabled"]);
const connectorPolicyFields = new Set(["machine", "environment", "cloudProvider", "fallback", "fallbackMode", "reservePercent", "allowCrossHarness", "timeoutSeconds"]);
function protectedPolicyFields(policy: ExecutionPolicyOverride | undefined, source: "browser" | "mcp"): ExecutionPolicyOverride {
  return Object.fromEntries(Object.entries(policy || {}).filter(([key]) => source === "mcp" ? !connectorPolicyFields.has(key) : administratorPolicyFields.has(key)));
}
function taskPolicyPermissions(principal: ExecutionPrincipal, policy: ExecutionPolicyOverride) {
  if (principal.admin || principal.projectAdmin) return;
  if (Object.keys(policy).some(key => administratorPolicyFields.has(key))) throw new ExecutionError("An administrator configures spending, verification and merge permissions", 403);
}
function validatePolicyAccounts(principal: ExecutionPrincipal, policy: ExecutionPolicyOverride) {
  if (!policy.fallback) return;
  const accounts = executionAccounts(principal.teamId, principal.userId);
  if (policy.fallback.some(selection => !accounts.some(account => account.id === selection.accountId))) throw new ExecutionError("Select accounts owned by you; consumer subscription credentials cannot be shared with a teammate");
}
function startRun(principal: ExecutionPrincipal, body: Record<string, unknown>, source: "browser" | "mcp") {
  requireExecutionWrite(principal);
  if (!principal.project || !principal.task) throw new ExecutionError("Choose a project and issue");
  if (principal.project.status !== "active" || principal.task.done) throw new ExecutionError("Reactivate the project or reopen the issue before starting development");
  const repositoryUrl = principal.project.repositoryUrl?.replace(/\.git\/?$/, "").replace(/\/$/, "");
  if (!repositoryUrl || !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(repositoryUrl)) throw new ExecutionError("Connect this project to its GitHub repository first");
  const existing = executionRuns(principal.teamId, true).find(record => record.run.taskId === principal.task!.id);
  if (existing && (existing.run.requestedBy !== principal.userId || existing.run.status !== "blocked" || !existing.run.processStopped)) return { run: existing.run, existing: true };
  const overrides = parseExecutionPolicyOverride(body.overrides ?? {});
  taskPolicyPermissions(principal, overrides); validatePolicyAccounts(principal, overrides);
  const policy = effectiveExecutionPolicy(executionPolicies(principal.teamId, principal.project.id, principal.task.id).effectivePolicy, overrides);
  if (existing && (source === "mcp" || !principal.admin && !principal.projectAdmin)) Object.assign(policy, protectedPolicyFields(existing.policy, source));
  validatePolicyAccounts(principal, policy);
  if (!policy.fallback.length) throw new ExecutionError("Configure at least one account, harness and model");
  if (!policy.verificationCommands.length || !policy.smokeCommand) throw new ExecutionError("Configure the project's verification commands and a runnable smoke check before starting");
  const accounts = executionAccounts(principal.teamId, principal.userId);
  const profiles = policy.fallback.flatMap(selection => Object.values(accounts.find(account => account.id === selection.accountId)?.bindings ?? {}).flat().filter(binding => binding.harnesses.includes(selection.harness)));
  if (!profiles.some(profile => executionBillingAllowed(profile.authKind, policy.allowPaidApi))) throw new ExecutionError(profiles.some(profile => profile.authKind === "api") ? "Paid API use is disabled for this task" : "The selected profiles have unknown billing; verify their native authentication type before starting");
  if (policy.platform === "apple" && policy.machine !== "auto" && readExecutionHost(policy.machine)?.platform !== "darwin") throw new ExecutionError("This project requires a Mac");
  if (existing) {
    existing.policy = policy; existing.attempted = []; existing.run.status = "queued"; existing.run.reason = undefined; existing.run.updatedAt = Date.now(); existing.cancelRequested = false;
    existing.grantId = principal.grantId; existing.run.baseBranch = policy.baseBranch; existing.run.environment = policy.environment;
    existing.run.verificationOnly = undefined; existing.run.verifiedBaseSha = undefined;
    saveExecutionRun(existing); appendExecutionEvent(existing.run.id, { type: "status", text: "Requester resumed the stopped run with the current policy" });
    return { run: existing.run };
  }
  const id = randomUUID(), now = Date.now();
  const run: ExecutionRun = { id, teamId: principal.teamId, projectId: principal.project.id, taskId: principal.task.id, requestedBy: principal.userId,
    title: principal.task.title, status: "queued", createdAt: now, updatedAt: now, attempt: 0, repositoryUrl,
    baseBranch: policy.baseBranch, branch: `origin/${principal.task.id.slice(-10)}/${id.slice(0, 8)}`, environment: policy.environment,
    verification: [], deployment: { status: "unknown", message: "A merge is not evidence of a deployment" }, approvals: [],
    usage: { inputTokens: 0, outputTokens: 0, estimatedApiUsd: null }, processStopped: true };
  const record: PrivateRun = { run, policy, prompt: `Implement this Origin issue in the assigned worktree. Do not change host credentials, bypass approvals or push the production branch.\n\nIssue: ${principal.task.title}\n\n${principal.task.description}`,
    ...(principal.grantId ? { grantId: principal.grantId } : {}), attempted: [], leaseHash: null, leaseExpiresAt: 0, sequence: 0, cancelRequested: false, logBytes: 0 };
  atomicExecution(() => { saveExecutionRun(record); appendExecutionEvent(id, { type: "status", text: "Queued; destination will follow the project's local-first policy" }); executionAudit(principal, "start_run", id); });
  return { run };
}

export async function executionAction(principal: ExecutionPrincipal, body: Record<string, unknown>, source: "browser" | "mcp" = "browser"): Promise<unknown> {
  requireExecutionWrite(principal);
  const action = z.string().parse(body.action);
  if (source === "mcp" && !["startRun", "cancelRun", "messageRun", "savePolicy", "refreshUsage"].includes(action)) throw new ExecutionError("This operation requires the owner's Origin interface", 403);
  if (source === "mcp" && (action === "startRun" || action === "savePolicy")) {
    const changes = parseExecutionPolicyOverride(action === "startRun" ? body.overrides ?? {} : body.policy);
    if (Object.keys(changes).some(key => !connectorPolicyFields.has(key))) throw new ExecutionError("Hermes cannot change spending consent, secret grants or verification/merge gates", 403);
  }
  switch (action) {
    case "startRun": return startRun(principal, body, source);
    case "savePolicy": {
      const scope = z.enum(["workspace", "project", "task"]).parse(body.scope);
      const policy = parseExecutionPolicyOverride(body.policy);
      if (scope === "workspace") requireExecutionAdmin(principal);
      else if (scope === "project") requireExecutionAdmin(principal, true);
      else taskPolicyPermissions(principal, policy);
      if (scope !== "workspace" && !principal.project || scope === "task" && !principal.task) throw new ExecutionError("Policy scope is missing");
      validatePolicyAccounts(principal, policy);
      const reference = scope === "workspace" ? "workspace" : `${scope}:${scope === "project" ? principal.project!.id : principal.task!.id}`;
      atomicExecution(() => {
        const previous = executionSetting<ExecutionPolicyOverride>(principal.teamId, "policy", reference);
        const saved = source === "mcp" ? { ...previous, ...policy }
          : scope === "task" && !principal.admin && !principal.projectAdmin ? { ...policy, ...protectedPolicyFields(previous, source) } : policy;
        setExecutionSetting(principal.teamId, "policy", reference, saved); executionAudit(principal, `${source}:save_policy`, reference);
      });
      return { ok: true, ...executionPolicies(principal.teamId, principal.project?.id, principal.task?.id) };
    }
    case "cancelRun": {
      const id = executionId.parse(body.runId); requireExecutionRun(principal, id, true);
      return atomicExecution(() => {
        const record = readExecutionRun(id)!;
        if (!activeExecutionStatuses[record.run.status]) return { run: record.run };
        record.cancelRequested = true; record.run.updatedAt = Date.now(); record.run.reason = "Cancellation requested";
        if (record.run.processStopped) { record.run.status = "cancelled"; record.run.reason = "Cancelled before execution or after a confirmed stop"; }
        saveExecutionRun(record); appendExecutionEvent(id, { type: "status", text: record.run.reason }); executionAudit(principal, "cancel_run", id);
        return { run: record.run };
      });
    }
    case "messageRun": {
      const id = executionId.parse(body.runId), text = z.string().trim().min(1).max(12000).parse(body.text);
      const record = requireExecutionRun(principal, id, true);
      if (!activeExecutionStatuses[record.run.status] || record.run.processStopped) throw new ExecutionError("The run is not accepting live follow-ups");
      const requestId = body.messageId === undefined ? randomUUID() : z.string().min(1).max(120).parse(body.messageId);
      const messageId = queueExecutionControl(id, "message", { text }, `message:${id}:${requestId}`);
      executionAudit(principal, "message_run", id); return { ok: true, messageId };
    }
    case "approve": {
      const id = executionId.parse(body.runId), approvalId = executionId.parse(body.approvalId), decision = z.enum(["allow", "deny"]).parse(body.decision);
      requireExecutionRun(principal, id, true);
      return atomicExecution(() => {
        const record = readExecutionRun(id)!;
        const approval = record.run.approvals.find(approval => approval.id === approvalId);
        if (!approval || approval.decision || record.run.processStopped) throw new ExecutionError("This approval is no longer pending");
        approval.decision = decision; approval.decidedAt = Date.now(); record.run.updatedAt = Date.now();
        queueExecutionControl(id, "approval", { approvalId, decision }, `approval:${id}:${approvalId}`); saveExecutionRun(record);
        executionAudit(principal, `approval:${decision}`, `${id}:${approvalId}`); return { ok: true };
      });
    }
    case "enrollHost": {
      requireExecutionAdmin(principal);
      const input = z.object({ name: z.string().trim().min(1).max(100), kind: z.enum(["nixos", "mac", "boxd", "boat"]), projectIds: z.array(executionId).min(1).max(100), tailnetName: z.string().trim().min(1).max(253).regex(/^[a-zA-Z0-9.-]+$/).optional() }).parse(body);
      return atomicExecution(() => { const result = enrolledHost(principal, input); executionAudit(principal, "enroll_host", result.hostId); return result; });
    }
    case "revokeHost": case "pauseHost": case "resumeHost": {
      requireExecutionAdmin(principal);
      const id = executionId.parse(body.hostId), host = readExecutionHost(id);
      if (!host || host.teamId !== principal.teamId) throw new ExecutionError("Machine not found", 404);
      atomicExecution(() => {
        if (action === "revokeHost") {
          host.revoked = true; host.status = "revoked"; host.online = null;
          for (const record of executionRuns(principal.teamId, true)) if (record.run.hostId === id && !record.run.processStopped) { record.cancelRequested = true; saveExecutionRun(record); }
        } else { host.pauseRequested = action === "pauseHost"; host.paused = host.pauseRequested || Boolean(host.locallyPaused); }
        saveExecutionHost(host); executionAudit(principal, action, id);
      });
      return { ok: true };
    }
    case "saveCloudProvider": {
      requireExecutionAdmin(principal);
      const input = z.object({ provider: z.enum(["boxd", "boat"]), apiKey: z.string().trim().min(10).max(16000).optional(), enabled: z.boolean() }).parse(body);
      const old = executionSetting<StoredCloudProvider>(principal.teamId, "cloud", input.provider);
      if (input.enabled && !input.apiKey && !old?.sealedKey) throw new ExecutionError("Enter the provider API key first");
      let usage: StoredCloudProvider["usage"] = old?.usage || { status: "unknown" };
      if (input.apiKey) {
        try { usage = { ...await cloudAccountUsage({ provider: input.provider, apiKey: input.apiKey }), observedAt: Date.now() }; }
        catch { usage = { status: "unknown", error: "The provider did not return a verified balance", observedAt: Date.now() }; }
      }
      const stored: StoredCloudProvider = { provider: input.provider, enabled: input.enabled, keyConfigured: Boolean(input.apiKey || old?.sealedKey), updatedAt: Date.now(), usage,
        sealedKey: input.apiKey ? sealIntegration(input.apiKey, `execution-cloud:${principal.teamId}:${input.provider}`) : old?.sealedKey };
      setExecutionSetting(principal.teamId, "cloud", input.provider, stored); executionAudit(principal, "save_cloud_provider", input.provider);
      return { ok: true };
    }
    case "saveEnvironment": {
      requireExecutionAdmin(principal, true);
      if (!principal.project) throw new ExecutionError("Choose a project for these secrets");
      const input = z.object({ name: z.string().trim().min(1).max(80), variables: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(100), z.string().max(32000)).refine(value => Object.keys(value).length <= 100, "Use at most 100 environment entries"), hostIds: z.array(executionId).max(100), automationEnabled: z.boolean() }).parse(body);
      const hosts = executionHosts(principal.teamId).filter(host => !host.revoked && host.projectIds.includes(principal.project!.id));
      if (input.hostIds.some(id => !hosts.some(host => host.id === id)) || input.automationEnabled && !input.hostIds.length) throw new ExecutionError("Explicitly select the enrolled machines allowed to receive this environment");
      const id = `${principal.project.id}:${input.name}`;
      const environment: StoredEnvironment = { id, teamId: principal.teamId, projectId: principal.project.id, name: input.name, keys: Object.keys(input.variables).sort(), hostIds: [...new Set(input.hostIds)], automationEnabled: input.automationEnabled, updatedAt: Date.now(), sealed: sealIntegration(JSON.stringify(input.variables), `execution-environment:${principal.teamId}:${id}`) };
      setExecutionSetting(principal.teamId, "environment", id, environment); executionAudit(principal, "replace_environment", id); return { ok: true };
    }
    case "deleteEnvironment": {
      requireExecutionAdmin(principal, true);
      const id = executionId.parse(body.environmentId), environment = executionSetting<StoredEnvironment>(principal.teamId, "environment", id);
      if (!environment || !principal.project || environment.projectId !== principal.project.id) throw new ExecutionError("Environment not found", 404);
      deleteExecutionSetting(principal.teamId, "environment", id); executionAudit(principal, "delete_environment", id); return { ok: true };
    }
    case "refreshUsage": {
      for (const host of executionHosts(principal.teamId)) if (host.ownerId === principal.userId) setExecutionSetting(principal.teamId, "refresh_usage", host.id, { requestedAt: Date.now() });
      return { ok: true };
    }
    case "checkUpdates": case "applyUpdates": {
      requireExecutionAdmin(principal);
      const hostId = body.hostId === undefined ? undefined : executionId.parse(body.hostId);
      const hosts = executionHosts(principal.teamId).filter(host => !host.revoked && (!hostId || host.id === hostId));
      if (hostId && !hosts.length) throw new ExecutionError("Machine not found", 404);
      for (const host of hosts) {
        const id = randomUUID();
        setExecutionSetting(principal.teamId, "maintenance", host.id, { id, op: action, requestedAt: Date.now(), requestedBy: principal.userId });
        setExecutionSetting(principal.teamId, "updates", host.id, [{ hostId: host.id, component: "origin-runner", currentVersion: host.version, status: "pending", message: host.activeRunIds.length ? "Maintenance waits for all work to stop" : "Waiting for the machine to acknowledge maintenance" } satisfies ExecutionUpdate]);
      }
      executionAudit(principal, action, hostId || "all_hosts"); return { ok: true };
    }
    default: throw new ExecutionError("Unknown execution operation");
  }
}
