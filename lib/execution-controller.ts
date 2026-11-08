import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { integrationBridge } from "./integration-bridge";
import { finalizeRunPullRequest, readRunDeployment, reconcileMergedRunPullRequest } from "./github-execution";
import { cloudExecutionStopProof, maintainCloudExecution } from "./execution-cloud-runtime";
import { ExecutionError, executionId, observedExecutionHost, revalidateExecutionPrincipal } from "./execution-common";
import { routeExecution, verificationMatchesPolicy } from "./execution-policy";
import {
  acquireExecutionLock, appendExecutionEvent, atomicExecution, executionAccounts, executionDeploymentRuns, executionHosts, executionRuns,
  executionTokenHash, readExecutionHost, readExecutionRun, releaseExecutionLock, saveExecutionHost, saveExecutionRun,
  type ExecutionPrincipal, type PrivateRun,
} from "./execution-store";

export function acceptExecutionControllerTick(token: string, body: unknown) {
  const expected = process.env.ORIGIN_EXECUTION_CONTROLLER_TOKEN_HASH;
  const teamId = process.env.ORIGIN_EXECUTION_TEAM_ID;
  if (!expected || !/^[a-f0-9]{64}$/.test(expected) || !teamId) throw new ExecutionError("Execution controller is not configured", 503);
  if (token.length < 32 || token.length > 200 || !timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(executionTokenHash(token), "hex"))) throw new ExecutionError("Controller authentication failed", 401);
  const input = z.object({ op: z.literal("tick"), localPresence: z.array(z.object({ hostId: executionId, tailnetName: z.string().max(253).regex(/^[a-zA-Z0-9.-]+$/), online: z.boolean(), observedAt: z.number().finite().nonnegative() })).max(500) }).strict().parse(body);
  const now = Date.now();
  atomicExecution(() => {
    for (const report of input.localPresence) {
      if (report.observedAt > now + 10000 || now - report.observedAt > 60000) continue;
      const host = readExecutionHost(report.hostId);
      const name = report.tailnetName.toLowerCase().replace(/\.$/, "");
      if (!host || host.teamId !== teamId || host.revoked || !["nixos", "mac"].includes(host.kind) || !host.tailnetName || ![name, name.split(".")[0]].includes(host.tailnetName)) continue;
      if (host.presenceObservedAt && host.presenceObservedAt > report.observedAt) continue;
      host.tailnetOnline = report.online; host.presenceObservedAt = report.observedAt;
      saveExecutionHost(observedExecutionHost(host, now));
    }
  });
  return teamId;
}

// Read-only recovery remains owner/grant/project scoped, but a closed issue is not a revocation.
async function readOnlyPrincipal(record: PrivateRun): Promise<ExecutionPrincipal> {
  const principal = await integrationBridge<ExecutionPrincipal>("executionContext", {
    userId: record.run.requestedBy, teamId: record.run.teamId, projectId: record.run.projectId, taskId: record.run.taskId,
    ...(record.grantId ? { grantId: record.grantId } : {}),
  });
  if (!principal.write || principal.project?.status !== "active" || principal.project.id !== record.run.projectId
    || principal.task?.id !== record.run.taskId
    || principal.project.repositoryUrl?.replace(/\.git\/?$/, "").replace(/\/$/, "").toLowerCase() !== record.run.repositoryUrl.toLowerCase()) throw new ExecutionError("Repository or requester authorization changed", 403);
  return principal;
}

export async function reconcileExecution(teamId: string) {
  const lockName = `controller:${teamId}`;
  const lock = acquireExecutionLock(lockName, 15 * 60000);
  if (!lock) return;
  try {
    const candidates = executionRuns(teamId, true).filter(record => Date.now() - (record.controllerCheckedAt || 0) >= (record.run.status === "awaiting_checks" ? 60000 : 10000))
      .sort((a, b) => (a.controllerCheckedAt || 0) - (b.controllerCheckedAt || 0)).slice(0, 20);
    for (const candidate of candidates) {
      atomicExecution(() => {
        const current = readExecutionRun(candidate.run.id);
        if (!current) return;
        current.controllerCheckedAt = Date.now();
        if (!current.run.processStopped && current.leaseExpiresAt <= Date.now()) {
          current.cancelRequested = true; current.run.status = "blocked";
          current.run.reason = "Lease expired; waiting for proof that the old process stopped. No replacement will start";
          const proof = current.run.hostId ? cloudExecutionStopProof(teamId, current.run.hostId) : undefined;
          if (proof && proof.observedAt >= (current.attemptStartedAt || current.run.createdAt) && proof.runId === current.run.id && proof.attempt === current.run.attempt) {
            current.run.processStopped = true; current.leaseExpiresAt = 0;
            current.run.reason = proof.environmentClean ? "Cloud stop confirmed; review the checkpoint before resuming" : "Cloud stop confirmed; environment cleanup and checkpoint recovery require operator review";
            appendExecutionEvent(current.run.id, { type: "status", text: current.run.reason });
          }
        }
        saveExecutionRun(current);
      });
      const record = readExecutionRun(candidate.run.id);
      if (!record || record.cancelRequested || record.run.status === "blocked") continue;
      let principal: ExecutionPrincipal;
      try {
        principal = await readOnlyPrincipal(record);
      } catch {
        atomicExecution(() => {
          const latest = readExecutionRun(record.run.id);
          if (!latest || latest.run.attempt !== record.run.attempt) return;
          latest.run.reason = "Waiting for current project, issue and requester authorization";
          if (!latest.run.processStopped) { latest.cancelRequested = true; latest.run.status = "blocked"; }
          saveExecutionRun(latest);
        });
        continue;
      }
      if (principal.task!.done) {
        const recoverable = record.run.status === "awaiting_checks" && record.run.processStopped && record.run.checkpoint && verificationMatchesPolicy(record.policy, record.run.verification);
        const merge = recoverable ? await reconcileMergedRunPullRequest({
          projectId: record.run.projectId, taskId: record.run.taskId, repositoryUrl: record.run.repositoryUrl,
          branch: record.run.branch, baseBranch: record.policy.baseBranch, headSha: record.run.checkpoint!.sha,
          authorize: async () => {
            const latest = readExecutionRun(record.run.id);
            if (!latest || latest.cancelRequested || latest.run.attempt !== record.run.attempt || latest.run.status !== "awaiting_checks"
              || !latest.run.processStopped || latest.run.checkpoint?.sha !== record.run.checkpoint!.sha
              || !verificationMatchesPolicy(latest.policy, latest.run.verification)) throw new ExecutionError("Run authorization changed during receipt recovery", 403);
            await readOnlyPrincipal(latest);
          },
        }) : undefined;
        atomicExecution(() => {
          const latest = readExecutionRun(record.run.id);
          if (!latest || latest.cancelRequested || latest.run.attempt !== record.run.attempt || latest.run.status !== record.run.status || latest.run.checkpoint?.sha !== record.run.checkpoint?.sha) return;
          if (merge?.state === "merged") {
            latest.run.status = "merged"; latest.run.merge = merge;
            latest.run.reason = "Exact-head GitHub merge confirmed; deployment is reported separately";
          } else if (merge?.state === "awaiting_checks") {
            latest.run.merge = merge; latest.run.reason = merge.reason;
          } else {
            latest.cancelRequested = true; latest.run.status = latest.run.processStopped ? "cancelled" : "blocked";
            latest.run.reason = "Issue completed outside this run; no additional code will be merged";
          }
          latest.run.updatedAt = Date.now(); saveExecutionRun(latest);
        });
        continue;
      }
      if (record.run.status === "queued") {
        const route = routeExecution({ policy: record.policy, projectId: record.run.projectId, ownerId: record.run.requestedBy, hosts: executionHosts(teamId).map(host => observedExecutionHost(host)), accounts: executionAccounts(teamId, record.run.requestedBy), attempted: record.attempted });
        atomicExecution(() => {
          const latest = readExecutionRun(record.run.id);
          if (latest?.run.status === "queued" && !latest.cancelRequested && latest.run.reason !== route.reason) { latest.run.reason = route.reason; latest.run.updatedAt = Date.now(); saveExecutionRun(latest); }
        });
      } else if (record.run.status === "awaiting_checks" && record.run.processStopped) {
        if (!record.policy.autoMerge || !record.run.checkpoint || !verificationMatchesPolicy(record.policy, record.run.verification)) {
          atomicExecution(() => {
            const latest = readExecutionRun(record.run.id);
            if (latest?.run.status !== "awaiting_checks") return;
            latest.run.status = "blocked"; latest.run.reason = "Merge requires the configured tests and smoke check on the exact pushed head"; saveExecutionRun(latest);
          });
          continue;
        }
        const merge = await finalizeRunPullRequest({ projectId: record.run.projectId, taskId: record.run.taskId, branch: record.run.branch, baseBranch: record.policy.baseBranch,
          headSha: record.run.checkpoint.sha, title: record.run.title, verification: record.run.verification, smokePassed: true,
          authorize: async () => {
            const latest = readExecutionRun(record.run.id);
            if (!latest || latest.cancelRequested || latest.run.status !== "awaiting_checks" || latest.run.checkpoint?.sha !== record.run.checkpoint!.sha) throw new ExecutionError("Run authorization changed before merge", 403);
            await revalidateExecutionPrincipal(latest);
          } });
        atomicExecution(() => {
          const latest = readExecutionRun(record.run.id);
          if (!latest || latest.run.attempt !== record.run.attempt || latest.run.checkpoint?.sha !== record.run.checkpoint!.sha) return;
          if (merge.state !== "merged" && (latest.cancelRequested || latest.run.status !== "awaiting_checks")) return;
          latest.run.merge = merge; latest.run.status = merge.state === "merged" ? "merged" : "awaiting_checks";
          latest.run.reason = merge.state === "merged" ? "Exact-head GitHub merge confirmed; deployment is reported separately" : merge.reason;
          latest.run.updatedAt = Date.now(); saveExecutionRun(latest);
          appendExecutionEvent(latest.run.id, { type: "merge", text: latest.run.reason || merge.state });
        });
      }
    }
    await maintainCloudExecution(teamId);
    // Terminal merged runs need continued observation: later deployment failures supersede success.
    for (const record of executionDeploymentRuns(teamId)) {
      if (Date.now() - (record.controllerCheckedAt || 0) < 60000 || !record.run.merge?.mergeSha) continue;
      const mergeSha = record.run.merge.mergeSha;
      atomicExecution(() => {
        const latest = readExecutionRun(record.run.id);
        if (!latest || latest.run.status !== "merged" || latest.run.merge?.mergeSha !== mergeSha) return;
        latest.controllerCheckedAt = Date.now(); saveExecutionRun(latest);
      });
      const deployment = await readRunDeployment({
        projectId: record.run.projectId, taskId: record.run.taskId, repositoryUrl: record.run.repositoryUrl, mergeSha,
        authorize: async () => {
          const latest = readExecutionRun(record.run.id);
          if (!latest || latest.run.status !== "merged" || latest.run.merge?.mergeSha !== mergeSha) throw new ExecutionError("Confirmed merge changed during deployment inspection", 403);
          await readOnlyPrincipal(latest);
        },
      });
      atomicExecution(() => {
        const latest = readExecutionRun(record.run.id);
        if (!latest || latest.run.status !== "merged" || latest.run.merge?.mergeSha !== mergeSha) return;
        latest.run.deployment = deployment; latest.run.updatedAt = Date.now(); saveExecutionRun(latest);
      });
      // One deployment observation per tick bounds GitHub traffic as run history grows.
      break;
    }
  } finally { releaseExecutionLock(lockName, lock); }
}
