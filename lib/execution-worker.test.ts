// @vitest-environment node
/// <reference types="vite/client" />
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { convexTest } from "convex-test";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";
import { createSession } from "../convex/lib/auth";
import { executionAction, executionRunDetail, executionSnapshot } from "./execution-browser";
import { executionWorkerRequest } from "./execution-worker";
import { atomicExecution, cloudAllocations, executionAccounts, executionDb, executionDeploymentRuns, executionEvents, executionSetting, readExecutionHost, readExecutionRun, saveExecutionHost, saveExecutionRun, saveCloudAllocation, setExecutionSetting, type ExecutionPrincipal } from "./execution-store";
import { integrationBridge } from "./integration-bridge";
import { prepareRunRepository } from "./github-execution";
import type { ExecutionAccountReport, ExecutionRun, ExecutionUpdate, ExecutionVerification, ExecutionWorkerRun } from "./execution-types";

// Only cross-service seams are replaced; authorization runs against the real Convex functions.
vi.mock("./integration-bridge", () => ({ integrationBridge: vi.fn(), originUrl: () => "http://127.0.0.1:1" }));
vi.mock("./github-execution", () => ({ prepareRunRepository: vi.fn() }));
vi.mock("./execution-cloud", () => ({ cloudAccountUsage: vi.fn(() => { throw new Error("Unexpected cloud request"); }) }));
const modules = import.meta.glob(["../convex/**/*.ts", "!../convex/**/*.test.ts"]);
const now = Date.UTC(2026, 10, 8, 12);
const sha = "a".repeat(40);
const gitToken = "synthetic-git-credential-not-a-real-token";
let directory: string;
beforeAll(() => {
  directory = mkdtempSync(path.join(tmpdir(), "origin-execution-worker-"));
  vi.stubEnv("ORIGIN_LOCAL_DATA_DIR", directory);
});
beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(now);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Execution tests must not contact a live service"); }));
  const db = executionDb();
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'execution_%'").all() as { name: string }[]) db.exec(`DELETE FROM "${name}"`);
  vi.mocked(integrationBridge).mockReset();
  vi.mocked(prepareRunRepository).mockReset();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
afterAll(() => { executionDb().close(); rmSync(directory, { recursive: true, force: true }); vi.unstubAllEnvs(); });

type HostSession = { hostId: string; hostToken: string };
async function worker<T>(host: HostSession, body: Record<string, unknown>): Promise<T> {
  return await executionWorkerRequest(host.hostToken, { protocolVersion: 1, hostId: host.hostId, ...body }) as T;
}
function reporter(id: string, harness: "codex" | "claude-code" = "codex", patch: Partial<ExecutionAccountReport> = {}): ExecutionAccountReport {
  return { id, identityHash: `synthetic-provider-identity-${id}`, provider: "fixture", label: id, authKind: "subscription", authenticated: true, harnesses: [harness], models: [{ id: `model-${id}`, efforts: ["high"] }], quota: { status: "available", observedAt: now, windows: [] }, ...patch };
}
async function fixture() {
  const t = convexTest(schema, modules);
  const owner = await t.run(async ctx => {
    const id = await ctx.db.insert("users", { name: "Runner owner", email: "runner@execution.test", role: "user", status: "active", passwordHash: "unused", salt: "unused", iterations: 1, createdAt: now, updatedAt: now });
    return { id, token: await createSession(ctx, id) };
  });
  const { teamId } = await t.mutation(api.workspaces.create, { sessionToken: owner.token, name: "Execution tests" });
  const projectId = await t.mutation(api.projects.create, { sessionToken: owner.token, teamId, name: "Runner project", repoUrl: "https://github.com/fixture/execution" });
  const columnId = (await t.query(api.tasks.board, { sessionToken: owner.token, projectId })).columns.find(column => !column.isDraft)!._id;
  const taskId = await t.mutation(api.tasks.createTask, { sessionToken: owner.token, projectId, columnId, title: "Implement fixture behavior", priority: "low", assignedToEmail: "runner@execution.test", dueDate: "2026-12-31" });
  const principal: ExecutionPrincipal = JSON.parse(await t.query(api.executionAccess.browserContext, { sessionToken: owner.token, teamId, projectId, taskId }));
  vi.mocked(integrationBridge).mockImplementation(async (operation, args) => {
    if (operation !== "executionContext") throw new Error(`Unexpected integration operation: ${operation}`);
    return JSON.parse(await t.query(internal.executionAccess.runContext, args as never));
  });
  const repository = { repositoryUrl: "https://github.com/fixture/execution", baseBranch: "main", issueNumber: 7, gitCredential: { username: "x-access-token", token: gitToken, expiresAt: now + 3600000 } };
  vi.mocked(prepareRunRepository).mockResolvedValue(repository);
  const reports = [reporter("primary"), reporter("backup", "claude-code")];
  async function heartbeat(host: HostSession, accounts = reports, activeRunIds: string[] = []) {
    return worker<{ cancelRunIds: string[] }>(host, { op: "heartbeat", version: "1.0.0", platform: "linux", capabilities: ["codex", "claude-code"], capacity: 1, paused: false, accounts, activeRunIds });
  }
  async function enroll(name: string) {
    const enrollment = await executionAction(principal, { action: "enrollHost", name, kind: "nixos", projectIds: [projectId] }) as { hostId: string; enrollmentToken: string };
    const host = await executionWorkerRequest(enrollment.enrollmentToken, { protocolVersion: 1, op: "enroll", host: { name, kind: "nixos", platform: "linux", version: "1.0.0", capabilities: ["codex", "claude-code"] } }) as HostSession;
    await heartbeat(host);
    return { ...host, enrollment };
  }
  const host = await enroll("Local runner");
  const accounts = executionAccounts(teamId, owner.id);
  const fallback = reports.map(report => ({ accountId: accounts.find(account => account.identityHash === report.identityHash)!.id, harness: report.harnesses[0]!, model: report.models![0]!.id, effort: "high" }));
  await executionAction(principal, { action: "savePolicy", scope: "project", policy: { fallback, verificationCommands: ["npm test", "npm run typecheck"], smokeCommand: "npm run smoke" } });
  async function start(actor = principal, overrides = {}) {
    return (await executionAction(actor, { action: "startRun", overrides }) as { run: ExecutionRun }).run;
  }
  async function claim(target: HostSession = host) { return (await worker<{ run: ExecutionWorkerRun | null }>(target, { op: "claim" })).run; }
  function events(run: ExecutionWorkerRun, target: HostSession = host) {
    let sequence = 0;
    return (event: Record<string, unknown>) => worker(target, { op: "event", runId: run.id, leaseToken: run.leaseToken, sequence: ++sequence, event });
  }
  const verification: ExecutionVerification[] = [{ command: "npm test", kind: "test", exitCode: 0 }, { command: "npm run typecheck", kind: "test", exitCode: 0 }, { command: "npm run smoke", kind: "smoke", exitCode: 0 }];
  return { t, owner, teamId, projectId, taskId, principal, repository, reports, host, fallback, enroll, heartbeat, start, claim, events, verification };
}

test("a runner restart confirms only its own pending update, not native tool versions", async () => {
  const f = await fixture();
  setExecutionSetting(f.teamId, "updates", f.host.hostId, [
    { component: "origin-runner", status: "updating", availableVersion: "1.0.0", checkedAt: now },
    { component: "codex:private", status: "updating", availableVersion: "1.0.0", checkedAt: now },
  ]);
  await f.heartbeat(f.host);
  expect(executionSetting<ExecutionUpdate[]>(f.teamId, "updates", f.host.hostId)).toMatchObject([
    { component: "origin-runner", status: "current", currentVersion: "1.0.0" },
    { component: "codex:private", status: "updating" },
  ]);
});

test("heartbeat update evidence is host-bound and cannot overwrite newer observations", async () => {
  const f = await fixture();
  const report = { component: "codex:private", status: "failed", checkedAt: now + 10000, hostId: "another-host" };
  const body = { op: "heartbeat", version: "1.0.0", platform: "linux", capabilities: ["codex"], capacity: 1, paused: false, accounts: f.reports, activeRunIds: [] };
  await worker(f.host, { ...body, updateReports: [report] });
  await worker(f.host, { ...body, updateReports: [{ ...report, status: "current", checkedAt: now - 1000 }] });
  expect(executionSetting<ExecutionUpdate[]>(f.teamId, "updates", f.host.hostId)).toMatchObject([
    { component: "codex:private", status: "failed", hostId: f.host.hostId, checkedAt: now },
  ]);
});

async function cloudFixture(enabled: boolean) {
  const f = await fixture(), local = await f.enroll("Offline local");
  saveExecutionHost({ ...readExecutionHost(local.hostId)!, lastSeenAt: now - 90000, online: false, status: "offline", tailnetOnline: false, presenceObservedAt: now });
  saveExecutionHost({ ...readExecutionHost(f.host.hostId)!, kind: "boxd" });
  saveCloudAllocation({ id: "allocation", teamId: f.teamId, ownerId: f.owner.id, projectId: f.projectId, provider: "boxd", status: "ready", hostId: f.host.hostId, machineId: "private-machine", name: "Private cloud", idempotencyKey: "one-machine", createdAt: now, updatedAt: now, lastActiveAt: now });
  setExecutionSetting(f.teamId, "cloud", "boxd", { provider: "boxd", enabled, keyConfigured: true, updatedAt: now, usage: { status: "unknown" } });
  const queued = await f.start(f.principal, { cloudEnabled: true });
  return { ...f, queued };
}

test("claim selects the authorized subscription profile rather than an earlier paid sibling", async () => {
  const f = await fixture();
  const primary = f.reports[0]!;
  await f.heartbeat(f.host, [reporter("aaa-paid", "codex", { ...primary, id: "aaa-paid", authKind: "api" }), primary, f.reports[1]!]);
  await f.start();
  expect((await f.claim())?.selection.accountId).toBe(primary.id);
});

test.each(["available", "stale"] as const)("a telemetry-free profile cannot erase %s quota evidence for the same account", async status => {
  const f = await fixture(), primary = f.reports[0]!;
  const quota = { status, observedAt: now - (status === "available" ? 10000 : 600000), windows: [{ id: "weekly", label: "Weekly", scope: "account" as const, usedPercent: 37, resetsAt: now + 3600000 }] };
  await f.heartbeat(f.host, [{ ...primary, quota }, { ...primary, id: "same-account-other-profile", quota: { status: "unknown", observedAt: now, windows: [] } }]);
  expect(executionAccounts(f.teamId, f.owner.id).find(account => account.identityHash === primary.identityHash)?.quota).toEqual(quota);
});

test("a long pending queue cannot cancel or replace an existing worker lease", async () => {
  const f = await fixture(); await f.start();
  const claimed = (await f.claim())!, template = readExecutionRun(claimed.id)!;
  atomicExecution(() => {
    for (let index = 0; index < 510; index++) saveExecutionRun({ ...template, leaseHash: null, leaseExpiresAt: 0, run: { ...template.run, id: `pending-${index}`, taskId: `pending-task-${index}`, hostId: undefined, status: "queued", processStopped: true, attempt: 0, updatedAt: now + index + 1 } });
  });
  expect((await f.heartbeat(f.host, f.reports, [claimed.id])).cancelRunIds).toEqual([]);
  expect(readExecutionHost(f.host.hostId)?.activeRunIds).toEqual([claimed.id]);
  expect(await f.claim()).toBeNull();
});

test("deployment polling retains old verified merges and rotates past inspected receipts", async () => {
  const f = await fixture(), queued = await f.start(), template = readExecutionRun(queued.id)!;
  atomicExecution(() => {
    for (let index = 0; index < 510; index++) saveExecutionRun({ ...template, run: { ...template.run, id: `recent-${index}`, status: "succeeded", updatedAt: now + index } });
    for (let index = 0; index < 25; index++) saveExecutionRun({ ...template, run: { ...template.run, id: `old-${String(index).padStart(2, "0")}`, status: "merged", updatedAt: 1, merge: { state: "merged", mergeSha: sha } } });
    saveExecutionRun({ ...template, run: { ...template.run, id: "unconfirmed", status: "merged", updatedAt: 0 } });
    saveExecutionRun({ ...template, run: { ...template.run, id: "foreign", teamId: "other-team", status: "merged", updatedAt: 0, merge: { state: "merged", mergeSha: sha } } });
  });
  const first = executionDeploymentRuns(f.teamId);
  expect(first.some(record => record.run.id === "old-00")).toBe(true);
  expect(first.some(record => ["unconfirmed", "foreign"].includes(record.run.id))).toBe(false);
  atomicExecution(() => { for (const record of first) { record.controllerCheckedAt = now; saveExecutionRun(record); } });
  expect(executionDeploymentRuns(f.teamId)[0]?.run.id).toBe("old-20");
});

test("a cloud claim journals its new attempt before any maintenance observation", async () => {
  const f = await cloudFixture(true), allocation = cloudAllocations(f.teamId)[0]!;
  saveCloudAllocation({ ...allocation, runDeadline: { runId: "old-run", attempt: 4, deadline: now }, runnerStoppedAt: now - 1000, stopProof: { kind: "provider-cold-stop", machineId: allocation.machineId!, observedAt: now - 1000, environmentClean: true } });
  const run = await f.claim();
  expect(run?.id).toBe(f.queued.id);
  const current = cloudAllocations(f.teamId)[0]!;
  expect(current.runDeadline).toEqual({ runId: f.queued.id, attempt: 1, deadline: now + run!.timeoutSeconds * 1000 + 300000 });
  expect(current.stopProof).toBeUndefined();
  expect(current.runnerStoppedAt).toBeUndefined();
});

test.each([false, true])("provider disablement fences a ready worker, including during Git preparation: %s", async duringPreparation => {
  const f = await cloudFixture(duringPreparation);
  if (duringPreparation) vi.mocked(prepareRunRepository).mockImplementationOnce(async () => {
    setExecutionSetting(f.teamId, "cloud", "boxd", { enabled: false }); return f.repository;
  });
  expect(await f.claim()).toBeNull();
  expect(readExecutionRun(f.queued.id)?.run).toMatchObject({ status: "queued", attempt: 0, processStopped: true });
  expect(readExecutionRun(f.queued.id)?.leaseHash).toBeNull();
});

test("enrollment is single-use and cannot change the approved platform", async () => {
  const f = await fixture();
  await expect(executionWorkerRequest(f.host.enrollment.enrollmentToken, { protocolVersion: 1, op: "enroll", host: { name: "Replay", platform: "linux", kind: "nixos", version: "1.0.0", capabilities: ["codex"] } })).rejects.toThrow(/expired|used/i);
  await expect(worker(f.host, { op: "heartbeat", version: "1.0.0", platform: "darwin", capabilities: ["codex"], capacity: 1, paused: false, accounts: [], activeRunIds: [] })).rejects.toThrow(/platform/i);
  expect(readExecutionHost(f.host.hostId)?.platform).toBe("linux");
});

test("claim is atomic and binds events to both the exact host and attempt lease", async () => {
  const f = await fixture(), other = await f.enroll("Other runner");
  const queued = await f.start();
  const results = await Promise.all([f.claim(), f.claim()]);
  expect(results.filter(Boolean)).toHaveLength(1);
  const run = results.find(Boolean)!;
  expect(run.id).toBe(queued.id);
  expect(await f.claim(other)).toBeNull();
  await expect(worker(other, { op: "event", runId: run.id, leaseToken: run.leaseToken, sequence: 1, event: { type: "log", stream: "stdout", text: "forged" } })).rejects.toThrow(/lease/i);
  await expect(worker(f.host, { op: "event", runId: run.id, leaseToken: "wrong-token".repeat(5), sequence: 1, event: { type: "status", status: "running" } })).rejects.toThrow(/lease/i);
  const body = { op: "event", runId: run.id, leaseToken: run.leaseToken, sequence: 1, event: { type: "log", stream: "stdout", text: "one visible log" } };
  await worker(f.host, body); await worker(f.host, body);
  expect(executionEvents(run.id, 0).filter(event => event.text === "one visible log")).toHaveLength(1);
  expect(readExecutionRun(run.id)?.run.attempt).toBe(1);
});

test("a disconnect or expired lease does not replay uncertain work on another host", async () => {
  const f = await fixture(), other = await f.enroll("Other runner");
  await f.start(); const run = (await f.claim())!, send = f.events(run);
  await send({ type: "status", status: "running" });
  vi.mocked(Date.now).mockReturnValue(now + (run.leaseDurationSeconds + 1) * 1000);
  expect(await worker(f.host, { op: "control", runId: run.id, leaseToken: run.leaseToken })).toMatchObject({ cancel: true, leaseValid: false });
  await f.heartbeat(other);
  expect(await f.claim(other)).toBeNull();
  await expect(send({ type: "log", stream: "stdout", text: "too late" })).rejects.toThrow(/expired/i);
  expect(readExecutionRun(run.id)?.run).toMatchObject({ status: "running", processStopped: false });
  await send({ type: "finished", result: "quota", summary: "Stopped late", processStopped: true, checkpointSha: sha });
  expect(readExecutionRun(run.id)?.run).toMatchObject({ status: "blocked", processStopped: true, checkpoint: { sha } });
  expect(await f.claim(other)).toBeNull();
});

test("cancellation stays pending until process stop and overrides an apparent success", async () => {
  const f = await fixture(); await f.start(); const run = (await f.claim())!, send = f.events(run);
  await send({ type: "status", status: "running" });
  await executionAction(f.principal, { action: "cancelRun", runId: run.id });
  expect(readExecutionRun(run.id)?.run).toMatchObject({ status: "running", processStopped: false });
  expect(await worker(f.host, { op: "control", runId: run.id, leaseToken: run.leaseToken })).toMatchObject({ cancel: true, leaseValid: true });
  expect(await f.heartbeat(f.host, f.reports, [run.id, "unrecognized-process"])).toMatchObject({ cancelRunIds: [run.id, "unrecognized-process"] });
  await expect(send({ type: "finished", result: "cancelled", summary: "not yet stopped", processStopped: false })).rejects.toThrow();
  expect(readExecutionRun(run.id)?.run.processStopped).toBe(false);
  await send({ type: "finished", result: "succeeded", summary: "Late success", processStopped: true, headSha: sha, verification: f.verification });
  expect(readExecutionRun(run.id)?.run).toMatchObject({ status: "cancelled", processStopped: true });
  expect(readExecutionHost(f.host.hostId)?.activeRunIds).toEqual([]);
});

test.each([
  { started: false, checkpoint: false, expected: "queued" },
  { started: true, checkpoint: false, expected: "blocked" },
  { started: undefined, checkpoint: false, expected: "blocked" },
  { started: true, checkpoint: true, expected: "queued" },
])("fallback requires stopped processes and safe partial-work evidence: $expected ($started/$checkpoint)", async ({ started, checkpoint, expected }) => {
  const f = await fixture(); await f.start(); const run = (await f.claim())!;
  await f.events(run)({ type: "finished", result: "quota", summary: "Preserve this partial implementation", processStopped: true, ...(started === undefined ? {} : { activityStarted: started }), ...(checkpoint ? { checkpointSha: sha } : {}) });
  expect(readExecutionRun(run.id)?.run).toMatchObject({ status: expected, processStopped: true });
  const next = await f.claim();
  if (expected === "blocked") { expect(next).toBeNull(); return; }
  expect(next?.selection).toMatchObject({ accountId: "backup", harness: "claude-code", model: "model-backup", effort: "high" });
  expect(next?.leaseToken).not.toBe(run.leaseToken);
  if (checkpoint) expect(next?.resume).toEqual({ checkpointSha: sha, summary: "Preserve this partial implementation" });
  await expect(worker(f.host, { op: "event", runId: run.id, leaseToken: run.leaseToken, sequence: 2, event: { type: "status", status: "running" } })).rejects.toThrow(/lease/i);
  expect(readExecutionRun(run.id)?.run.attempt).toBe(2);
});

test.each(["quota", "quota-and-outage", "disabled"] as const)("provider outage respects fallback mode %s", async fallbackMode => {
  const f = await fixture(); await f.start(f.principal, { fallbackMode }); const run = (await f.claim())!;
  await f.events(run)({ type: "finished", result: "provider_unavailable", summary: "Provider unavailable", processStopped: true, activityStarted: false });
  expect(readExecutionRun(run.id)?.run.status).toBe(fallbackMode === "quota-and-outage" ? "queued" : "failed");
});

test("a failed checkpoint from another branch cannot change the resumable state", async () => {
  const f = await fixture(); await f.start(); const run = (await f.claim())!;
  await expect(f.events(run)({ type: "checkpoint", branch: "main", sha, summary: "Wrong branch" })).rejects.toThrow(/branch/i);
  expect(readExecutionRun(run.id)?.run.checkpoint).toBeUndefined();
  expect(readExecutionRun(run.id)?.sequence).toBe(0);
});

test.each(["missing", "substituted", "failed", "wrong-kind", "extra", "no-head", "exact"])("success receipt %s cannot bypass configured merge gates", async variant => {
  const f = await fixture(); await f.start(); const run = (await f.claim())!;
  let verification = f.verification;
  if (variant === "missing") verification = verification.slice(0, 2);
  if (variant === "substituted") verification = verification.map((check, i) => i === 0 ? { ...check, command: "echo success" } : check);
  if (variant === "failed") verification = verification.map((check, i) => i === 0 ? { ...check, exitCode: 1 } : check);
  if (variant === "wrong-kind") verification = verification.map(check => ({ ...check, kind: "test" }));
  if (variant === "extra") verification = [...verification, verification[0]!];
  await f.events(run)({ type: "finished", result: "succeeded", summary: "Done", processStopped: true, ...(variant === "no-head" ? {} : { headSha: sha }), verification });
  const result = executionRunDetail(f.principal, run.id).run;
  expect(result.status).toBe(variant === "exact" ? "awaiting_checks" : "failed");
  expect(result.merge).toBeUndefined();
  expect(result.deployment.status).toBe("unknown");
});

test("environment values reach only explicitly authorized hosts and never browser snapshots or event text", async () => {
  const f = await fixture(), other = await f.enroll("Other runner");
  const secret = "synthetic-environment-password";
  await executionAction(f.principal, { action: "saveEnvironment", name: "development", variables: { DATABASE_PASSWORD: secret }, hostIds: [other.hostId], automationEnabled: true });
  const queued = await f.start();
  expect(await f.claim()).toBeNull();
  expect(readExecutionRun(queued.id)?.run).toMatchObject({ status: "queued", processStopped: true });
  await executionAction(f.principal, { action: "saveEnvironment", name: "development", variables: { DATABASE_PASSWORD: secret }, hostIds: [f.host.hostId], automationEnabled: true });
  const run = (await f.claim())!, send = f.events(run);
  expect(run.environmentVariables).toEqual({ DATABASE_PASSWORD: secret });
  expect(run.gitCredential?.token).toBe(gitToken);
  await send({ type: "log", stream: "stderr", text: `password=${secret}; credential=${gitToken}` });
  await send({ type: "status", status: "running", message: secret });
  await send({ type: "approval", approvalId: "approval", tool: "shell", input: { command: `echo ${secret}` } });
  await send({ type: "checkpoint", branch: run.branch, sha, summary: secret });
  await send({ type: "finished", result: "failed", summary: secret, processStopped: true, verification: [{ command: "npm test", exitCode: 1, kind: "test", summary: gitToken }] });
  const encoded = JSON.stringify({ snapshot: executionSnapshot(f.principal), detail: executionRunDetail(f.principal, run.id) });
  for (const value of [secret, gitToken, run.leaseToken, "sealedEnvironment", "sealedGitCredential", "leaseHash"]) expect(encoded).not.toContain(value);
  expect(encoded).toContain("[REDACTED]");
});

test("disabled automation does not release an environment even to an enrolled host", async () => {
  const f = await fixture();
  await executionAction(f.principal, { action: "saveEnvironment", name: "development", variables: { TOKEN: "synthetic-secret" }, hostIds: [f.host.hostId], automationEnabled: false });
  await f.start();
  expect(await f.claim()).toBeNull();
});

test("revoked automation grants prevent claims and cancel already-running work", async () => {
  const f = await fixture();
  const grant = await f.t.mutation(api.connectors.createGrant, { sessionToken: f.owner.token, teamId: f.teamId, name: "Hermes fixture", write: true });
  const principal: ExecutionPrincipal = JSON.parse(await f.t.query(api.executionAccess.mcpContext, { token: grant.token, projectId: f.projectId, taskId: f.taskId, write: true }));
  await f.start(principal); const run = (await f.claim())!;
  await f.t.mutation(api.connectors.revoke, { sessionToken: f.owner.token, teamId: f.teamId, grantId: grant.grantId });
  expect(await worker(f.host, { op: "control", runId: run.id, leaseToken: run.leaseToken })).toMatchObject({ cancel: true });
  expect(readExecutionRun(run.id)?.cancelRequested).toBe(true);
  await f.events(run)({ type: "finished", result: "quota", summary: "Stopped", processStopped: true, activityStarted: false });
  expect(readExecutionRun(run.id)?.run.status).toBe("cancelled");
});

test("grant revocation during repository preparation cannot issue a lease or credentials", async () => {
  const f = await fixture();
  const grant = await f.t.mutation(api.connectors.createGrant, { sessionToken: f.owner.token, teamId: f.teamId, name: "Revoked while preparing", write: true });
  const principal: ExecutionPrincipal = JSON.parse(await f.t.query(api.executionAccess.mcpContext, { token: grant.token, projectId: f.projectId, taskId: f.taskId, write: true }));
  const queued = await f.start(principal);
  vi.mocked(prepareRunRepository).mockImplementationOnce(async () => {
    await f.t.mutation(api.connectors.revoke, { sessionToken: f.owner.token, teamId: f.teamId, grantId: grant.grantId });
    return f.repository;
  });
  await expect(f.claim()).rejects.toThrow(/revoked|authorization/i);
  expect(readExecutionRun(queued.id)?.run.processStopped).toBe(true);
  expect(readExecutionRun(queued.id)?.leaseHash).toBeNull();
});

test("revoking the connector that resumed a browser run prevents its next claim", async () => {
  const f = await fixture(); await f.start(); const run = (await f.claim())!;
  await f.events(run)({ type: "finished", result: "needs_auth", summary: "Stopped for operator review", processStopped: true, activityStarted: false });
  expect(readExecutionRun(run.id)?.run.status).toBe("blocked");
  const grant = await f.t.mutation(api.connectors.createGrant, { sessionToken: f.owner.token, teamId: f.teamId, name: "Resume authorization", write: true });
  const principal: ExecutionPrincipal = JSON.parse(await f.t.query(api.executionAccess.mcpContext, { token: grant.token, projectId: f.projectId, taskId: f.taskId, write: true }));
  await executionAction(principal, { action: "startRun" }, "mcp");
  await f.t.mutation(api.connectors.revoke, { sessionToken: f.owner.token, teamId: f.teamId, grantId: grant.grantId });
  await expect(f.claim()).rejects.toThrow(/revoked|authorization/i);
  expect(readExecutionRun(run.id)?.run).toMatchObject({ attempt: 1, processStopped: true });
});

test("revoked project membership cancels the live process rather than silently renewing it", async () => {
  const f = await fixture(); await f.start(); const run = (await f.claim())!;
  await f.t.run(async ctx => {
    const member = await ctx.db.query("teamMembers").withIndex("by_user", q => q.eq("userId", f.owner.id)).first();
    await ctx.db.delete(member!._id);
  });
  expect(await worker(f.host, { op: "control", runId: run.id, leaseToken: run.leaseToken })).toMatchObject({ cancel: true });
  expect(readExecutionRun(run.id)?.run.processStopped).toBe(false);
});

test("cancelling queued work prevents any lease or repository credential request", async () => {
  const f = await fixture(), queued = await f.start();
  await executionAction(f.principal, { action: "cancelRun", runId: queued.id });
  expect(await f.claim()).toBeNull();
  expect(readExecutionRun(queued.id)?.run).toMatchObject({ status: "cancelled", processStopped: true, attempt: 0 });
  expect(prepareRunRepository).not.toHaveBeenCalled();
});

test("a shared subscription selects the local profile supporting the exact requested model", async () => {
  const f = await fixture();
  const primary = f.reports[0]!;
  await f.heartbeat(f.host, [
    { ...primary, id: "wrong-model-profile", models: [{ id: "not-requested", efforts: ["high"] }] },
    { ...primary, id: "correct-model-profile" },
    f.reports[1]!,
  ]);
  expect(executionAccounts(f.teamId, f.owner.id)).toHaveLength(2);
  await f.start();
  const run = await f.claim();
  expect(run?.selection).toMatchObject({ accountId: "correct-model-profile", logicalAccountId: f.fallback[0]!.accountId, harness: "codex", model: primary.models![0]!.id, effort: "high" });
});

test("control messages and approvals remain pending until acknowledged by the current lease", async () => {
  const f = await fixture(); await f.start(); const run = (await f.claim())!, send = f.events(run);
  const message = await executionAction(f.principal, { action: "messageRun", runId: run.id, text: "Keep the public API unchanged" }) as { messageId: string };
  await send({ type: "approval", approvalId: "shell-approval", tool: "shell", input: { command: "npm test" } });
  await executionAction(f.principal, { action: "approve", runId: run.id, approvalId: "shell-approval", decision: "deny" });
  const control = { op: "control", runId: run.id, leaseToken: run.leaseToken };
  const pending = { messages: [{ id: message.messageId, text: "Keep the public API unchanged" }], approvals: [{ approvalId: "shell-approval", decision: "deny" }] };
  expect(await worker(f.host, control)).toMatchObject(pending);
  expect(await worker(f.host, control)).toMatchObject(pending);
  await expect(worker(f.host, { ...control, leaseToken: "stale-lease".repeat(5), ackMessageIds: [message.messageId], ackApprovalIds: ["shell-approval"] })).rejects.toThrow(/lease/i);
  expect(await worker(f.host, control)).toMatchObject(pending);
  expect(await worker(f.host, { ...control, ackMessageIds: [message.messageId], ackApprovalIds: ["shell-approval"] })).toMatchObject({ messages: [], approvals: [] });
  await expect(executionAction(f.principal, { action: "approve", runId: run.id, approvalId: "shell-approval", decision: "allow" })).rejects.toThrow(/no longer pending/i);
});

test("structured approval arguments redact secrets before JSON escaping", async () => {
  const f = await fixture(), secret = "synthetic-\"quoted\"-password\\with\nnewline";
  await executionAction(f.principal, { action: "saveEnvironment", name: "development", variables: { PASSWORD: secret }, hostIds: [f.host.hostId], automationEnabled: true });
  await f.start(); const run = (await f.claim())!;
  await f.events(run)({ type: "approval", approvalId: "structured-secret", tool: "shell", input: { nested: [{ password: secret, command: `echo ${secret}` }], harmless: "leave this visible" } });
  const approval = executionRunDetail(f.principal, run.id).run.approvals[0]!;
  expect(approval.input).toEqual({ nested: [{ password: "[REDACTED]", command: "echo [REDACTED]" }], harmless: "leave this visible" });
  expect(JSON.stringify(executionSnapshot(f.principal))).not.toContain(JSON.stringify(secret).slice(1, -1));
});
