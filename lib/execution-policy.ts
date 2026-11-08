import { z } from "zod";
import type { ExecutionAccount, ExecutionAccountReport, ExecutionHost, ExecutionPolicy, ExecutionPolicyOverride, ExecutionSelection } from "./execution-types";

export const executionSelectionSchema = z.object({
  accountId: z.string().min(1).max(200),
  harness: z.enum(["omp", "claude-code", "codex", "pi", "t3"]),
  model: z.string().trim().min(1).max(200),
  effort: z.string().trim().min(1).max(40).optional(),
}).strict();
export const executionPolicySchema = z.object({
  machine: z.string().min(1).max(200), platform: z.enum(["portable", "apple"]),
  environment: z.string().trim().min(1).max(80), cloudProvider: z.enum(["boxd", "boat"]), cloudEnabled: z.boolean(),
  fallback: z.array(executionSelectionSchema).max(12), fallbackMode: z.enum(["disabled", "quota", "quota-and-outage"]),
  reservePercent: z.number().min(0).max(95), allowPaidApi: z.boolean(), allowCrossHarness: z.boolean(),
  verificationCommands: z.array(z.string().trim().min(1).max(2000)).max(12), smokeCommand: z.string().trim().max(2000),
  baseBranch: z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/).refine(value => !value.includes("..") && !value.endsWith("/") && !value.endsWith(".") && !value.endsWith(".lock"), "Invalid branch name"),
  autoMerge: z.boolean(), timeoutSeconds: z.number().int().min(60).max(28800),
}).strict();

export const defaultExecutionPolicy: ExecutionPolicy = {
  machine: "auto", platform: "portable", environment: "development", cloudProvider: "boxd", cloudEnabled: false,
  fallback: [], fallbackMode: "quota", reservePercent: 0, allowPaidApi: false, allowCrossHarness: true,
  verificationCommands: [], smokeCommand: "", baseBranch: "main", autoMerge: true, timeoutSeconds: 3600,
};

export function parseExecutionPolicyOverride(value: unknown): ExecutionPolicyOverride {
  return executionPolicySchema.partial().parse(value);
}
export function effectiveExecutionPolicy(...policies: (ExecutionPolicyOverride | undefined)[]): ExecutionPolicy {
  return executionPolicySchema.parse(Object.assign({}, defaultExecutionPolicy, ...policies));
}
export function executionSelectionKey(selection: ExecutionSelection) {
  return JSON.stringify([selection.accountId, selection.harness, selection.model, selection.effort || ""]);
}

export function executionBillingAllowed(kind: ExecutionAccountReport["authKind"], allowPaidApi: boolean) {
  return kind === "subscription" || kind === "api" && allowPaidApi;
}
export function executionProfileMatchesSelection(profile: Pick<ExecutionAccountReport, "authKind" | "authenticated" | "harnesses" | "models">, selection: ExecutionSelection, allowPaidApi: boolean) {
  return profile.authenticated && executionBillingAllowed(profile.authKind, allowPaidApi)
    && profile.harnesses.includes(selection.harness)
    && (!profile.models?.length || profile.models.some(model => model.id === selection.model && (!selection.effort || !model.efforts?.length || model.efforts.includes(selection.effort))));
}

export function quotaBlocksSelection(account: ExecutionAccount, selection: ExecutionSelection, reservePercent: number, now: number) {
  const quota = account.quota;
  if (quota.status !== "available" || quota.observedAt > now + 60000 || now - quota.observedAt > 300000) return false;
  return quota.windows.some(window => {
    if (window.resetsAt !== null && window.resetsAt <= now) return false;
    const scope = window.scope;
    if (scope === "feature" || scope === "unknown") return false;
    if (scope === "model" && !window.modelIds?.includes(selection.model)) return false;
    // Only known shared windows can drive preflight; unknown vendor buckets remain display-only.
    if (!scope && !["five_hour", "seven_day", "primary", "secondary", "codex.primary", "codex.secondary"].includes(window.id)) return false;
    return window.usedPercent >= 100 - reservePercent;
  });
}

export type ExecutionRouting = { host?: ExecutionHost; selection?: ExecutionSelection; reason: string; needsCloud: boolean };
export function routeExecution(input: {
  policy: ExecutionPolicy; projectId: string; ownerId: string; hosts: ExecutionHost[]; accounts: ExecutionAccount[];
  attempted?: string[]; now?: number;
}): ExecutionRouting {
  const { policy, projectId, ownerId } = input;
  const now = input.now ?? Date.now();
  const hosts = input.hosts.filter(host => !host.revoked && host.ownerId === ownerId && host.projectIds.includes(projectId));
  const pinned = policy.machine !== "auto" ? hosts.find(host => host.id === policy.machine) : undefined;
  const waiting = (reason: string, needsCloud = false): ExecutionRouting => ({ reason, needsCloud });
  if (policy.machine !== "auto" && !pinned) return waiting("The selected machine is not enrolled for this owner and project");
  if (pinned && policy.platform === "apple" && pinned.platform !== "darwin") return waiting("This project requires macOS; a Linux cloud machine cannot build or sign Apple apps");
  const eligibleLocal = hosts.filter(host => policy.platform === "apple" ? host.kind === "mac" : host.kind === "nixos" || host.id === pinned?.id && host.kind === "mac");
  const tried = new Set(input.attempted || []);
  const choices = policy.fallbackMode === "disabled" ? policy.fallback.slice(0, 1) : policy.fallback;
  const choose = (candidates: ExecutionHost[]): ExecutionRouting | null => {
    for (const selection of choices) {
      if (tried.has(executionSelectionKey(selection))) continue;
      if (!policy.allowCrossHarness && selection.harness !== policy.fallback[0]?.harness) continue;
      const account = input.accounts.find(account => account.id === selection.accountId && account.ownerId === ownerId);
      if (!account || !account.authenticated || !account.harnesses.includes(selection.harness)) continue;
      if (quotaBlocksSelection(account, selection, policy.reservePercent, now)) continue;
      for (const host of candidates) {
        if (host.online !== true || host.paused || host.activeRunIds.length >= host.capacity || now - host.lastSeenAt > 45000) continue;
        if (!host.capabilities.includes(selection.harness) || !account.hostIds.includes(host.id) || !host.accountIds.includes(account.id)) continue;
        const bindings = account.bindings?.[host.id];
        if (!bindings?.some(binding => executionProfileMatchesSelection(binding, selection, policy.allowPaidApi))) continue;
        return { host, selection, reason: "Ready", needsCloud: false };
      }
    }
    return null;
  };
  if (!choices.length) return waiting("Choose an account, harness and model in the execution policy");
  if (pinned && ["nixos", "mac"].includes(pinned.kind)) return choose([pinned]) || waiting("The pinned local machine or selected account is unavailable; its destination will not change");
  if (!eligibleLocal.length) return waiting("Enroll an eligible local machine before enabling offline-only cloud fallback");
  const allLocalOffline = eligibleLocal.every(host => host.online === false && Boolean(host.presenceObservedAt && now - host.presenceObservedAt <= 120000) && now - host.lastSeenAt > 45000);
  if (!pinned) {
    const local = choose(eligibleLocal);
    if (local) return local;
  }
  if (!allLocalOffline) return waiting("Waiting for the local machine or account; busy, paused, stale or unknown is not permission to use cloud");
  if (policy.platform === "apple") return waiting("Waiting for the Mac; cloud Linux cannot replace Apple tooling");
  if (!policy.cloudEnabled) return waiting("Local machine is offline; cloud fallback is disabled");
  const cloud = hosts.filter(host => host.kind === policy.cloudProvider && (!pinned || host.id === pinned.id));
  if (pinned && pinned.kind !== policy.cloudProvider) return waiting("The pinned cloud machine does not match the selected cloud provider");
  return choose(cloud) || waiting(`Eligible local machines are confirmed offline; preparing ${policy.cloudProvider}`, true);
}

export function verificationMatchesPolicy(policy: ExecutionPolicy, results: { command: string; exitCode: number; kind: "test" | "smoke" }[]) {
  if (!policy.verificationCommands.length || !policy.smokeCommand) return false;
  const expected = [...policy.verificationCommands.map(command => ({ command, kind: "test" as const })), { command: policy.smokeCommand, kind: "smoke" as const }];
  return results.length === expected.length && expected.every((check, index) => results[index]?.command === check.command && results[index]?.kind === check.kind && results[index]?.exitCode === 0);
}
