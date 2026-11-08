import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { getConvexClient } from "./localRealtime";
import { integrationBridge, originUrl } from "./integration-bridge";
import { openIntegration, sealIntegration } from "./githubConnection";
import { effectiveExecutionPolicy } from "./execution-policy";
import { executionDb, executionSetting, executionTokenHash, readExecutionRun, saveExecutionHost, type ExecutionPrincipal, type PrivateRun } from "./execution-store";
import type { ExecutionCloudProviderStatus, ExecutionEnvironment, ExecutionHost, ExecutionPolicyOverride } from "./execution-types";
import type { BoxdBillingBinding, BoxdBillingReport } from "./execution-cloud/billing";

export class ExecutionError extends Error {
  constructor(message: string, public status = 400) { super(message); this.name = "ExecutionError"; }
}
export const executionId = z.string().min(1).max(200);
export const executionHarness = z.enum(["omp", "claude-code", "codex", "pi", "t3"]);
export type StoredEnvironment = ExecutionEnvironment & { sealed: string; teamId: string };
export type StoredCloudProvider = ExecutionCloudProviderStatus & { sealedKey?: string; boxdBinding?: BoxdBillingBinding; nativeBilling?: BoxdBillingReport };
export const LEASE_SECONDS = 60;
export const HEARTBEAT_SECONDS = 15;
export const activeExecutionStatuses: Record<string, true> = { queued: true, preparing: true, running: true, verifying: true, blocked: true, awaiting_checks: true };

export async function browserExecutionPrincipal(token: string, teamId: string, projectId?: string, taskId?: string): Promise<ExecutionPrincipal> {
  if (!token) throw new ExecutionError("Sign in to Origin", 401);
  try {
    const value = await getConvexClient().query(api.executionAccess.browserContext, {
      sessionToken: token, teamId: teamId as Id<"teams">,
      ...(projectId ? { projectId: projectId as Id<"projects"> } : {}), ...(taskId ? { taskId: taskId as Id<"tasks"> } : {}),
    });
    return JSON.parse(value);
  } catch { throw new ExecutionError("Workspace, project or issue access is unavailable", 403); }
}
export async function mcpExecutionPrincipal(token: string, projectId?: string, taskId?: string, write = false): Promise<ExecutionPrincipal> {
  try {
    return JSON.parse(await getConvexClient().query(api.executionAccess.mcpContext, {
      token, write, ...(projectId ? { projectId: projectId as Id<"projects"> } : {}), ...(taskId ? { taskId: taskId as Id<"tasks"> } : {}),
    }));
  } catch { throw new ExecutionError("The Origin connection cannot access this workspace or project", 403); }
}
export async function revalidateExecutionPrincipal(record: PrivateRun): Promise<ExecutionPrincipal> {
  const principal = await integrationBridge<ExecutionPrincipal>("executionContext", {
    userId: record.run.requestedBy, teamId: record.run.teamId, projectId: record.run.projectId, taskId: record.run.taskId,
    ...(record.grantId ? { grantId: record.grantId } : {}),
  });
  if (!principal.write || principal.project?.status !== "active" || !principal.task || principal.task.done) throw new ExecutionError("Issue or project is no longer available for development", 403);
  return principal;
}
export function requireExecutionWrite(principal: ExecutionPrincipal) {
  if (!principal.write) throw new ExecutionError("You have read-only access", 403);
}
export function requireExecutionAdmin(principal: ExecutionPrincipal, project = false) {
  if (!principal.admin && !(project && principal.projectAdmin)) throw new ExecutionError("An administrator must authorize this change", 403);
}
export function requireExecutionRun(principal: ExecutionPrincipal, id: string, write = false) {
  const record = readExecutionRun(id);
  if (!record || record.run.teamId !== principal.teamId || !principal.projectIds.includes(record.run.projectId)
    || principal.project && principal.project.id !== record.run.projectId) throw new ExecutionError("Run not found", 404);
  if (write && (!principal.write || record.run.requestedBy !== principal.userId && !principal.admin && !principal.projectAdmin)) throw new ExecutionError("Only the requester or a project administrator can control this run", 403);
  return record;
}
export function executionPolicies(teamId: string, projectId?: string, taskId?: string) {
  const workspacePolicy = effectiveExecutionPolicy(executionSetting<ExecutionPolicyOverride>(teamId, "policy", "workspace"));
  const projectPolicy = projectId ? executionSetting<ExecutionPolicyOverride>(teamId, "policy", `project:${projectId}`) : undefined;
  const taskPolicy = taskId ? executionSetting<ExecutionPolicyOverride>(teamId, "policy", `task:${taskId}`) : undefined;
  return { workspacePolicy, projectPolicy, taskPolicy, effectivePolicy: effectiveExecutionPolicy(workspacePolicy, projectPolicy, taskPolicy) };
}
export function observedExecutionHost(host: ExecutionHost, now = Date.now()): ExecutionHost {
  const heartbeatFresh = now - host.lastSeenAt <= 45000;
  const presenceFresh = Boolean(host.presenceObservedAt && now - host.presenceObservedAt <= 120000);
  const online = host.revoked ? null : heartbeatFresh ? true : presenceFresh ? host.tailnetOnline ?? null : null;
  return { ...host, online, status: host.revoked ? "revoked" : online === false ? "offline" : online === null ? "unknown" : host.paused ? "paused" : host.activeRunIds.length >= host.capacity ? "busy" : "online" };
}
export function redactExecutionText(value: string, record?: PrivateRun) {
  let text = value;
  if (record) {
    const secrets: string[] = [];
    if (record.sealedEnvironment) secrets.push(...Object.values(JSON.parse(openIntegration(record.sealedEnvironment, `execution-env:${record.run.id}`)) as Record<string, string>));
    if (record.sealedGitCredential) {
      const credential = JSON.parse(openIntegration(record.sealedGitCredential, `execution-git:${record.run.id}`)) as { token?: string };
      if (credential.token) secrets.push(credential.token);
    }
    for (const secret of secrets.sort((a, b) => b.length - a.length)) if (secret) text = text.split(secret).join("[REDACTED]");
  }
  return text.replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})\b/g, "[REDACTED]");
}
export function redactExecutionValue(value: unknown, record: PrivateRun): unknown {
  if (typeof value === "string") return redactExecutionText(value, record);
  if (Array.isArray(value)) return value.map(item => redactExecutionValue(item, record));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [redactExecutionText(key, record), redactExecutionValue(item, record)]));
  return value;
}
export function sealRunEnvironment(runId: string, variables: Record<string, string>) {
  return sealIntegration(JSON.stringify(variables), `execution-env:${runId}`);
}
export function enrolledHost(principal: Pick<ExecutionPrincipal, "teamId" | "userId" | "projectIds">, input: { name: string; kind: ExecutionHost["kind"]; projectIds: string[]; tailnetName?: string }, allocationId?: string) {
  if (!input.projectIds.length || input.projectIds.some(id => !principal.projectIds.includes(id))) throw new ExecutionError("Select authorized projects for this machine");
  if (!executionDb().isTransaction) throw new Error("Host enrollment requires an execution transaction");
  const token = randomBytes(32).toString("base64url"), hostId = randomUUID(), expiresAt = Date.now() + 15 * 60000;
  const host: ExecutionHost = {
    id: hostId, teamId: principal.teamId, ownerId: principal.userId, name: input.name, kind: input.kind,
    platform: input.kind === "mac" ? "darwin" : "linux", status: "unknown", online: null, paused: false, revoked: false,
    lastSeenAt: 0, version: "", capabilities: [], accountIds: [], projectIds: [...new Set(input.projectIds)], activeRunIds: [], capacity: 1,
    ...(input.tailnetName ? { tailnetName: input.tailnetName.toLowerCase().replace(/\.$/, "") } : {}),
  };
  executionDb().prepare("DELETE FROM execution_enrollments WHERE expires<?").run(Date.now());
  executionDb().prepare("INSERT INTO execution_enrollments VALUES(?,?,?)").run(executionTokenHash(token), expiresAt, JSON.stringify({ host, allocationId }));
  saveExecutionHost(host, null);
  return {
    hostId, enrollmentToken: token, expiresAt,
    command: ["origin-runner", "enroll", "--url", originUrl(), "--name", input.name, "--kind", input.kind, ...(input.tailnetName ? ["--tailnet-name", input.tailnetName] : [])].map(value => `'${value.replaceAll("'", "'\\''")}'`).join(" "),
  };
}
