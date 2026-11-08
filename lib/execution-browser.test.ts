// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { executionAction, executionRunDetail, executionSnapshot } from "./execution-browser";
import { accountIdentity, atomicExecution, executionAccounts, executionDb, executionSetting, readExecutionRun, replaceExecutionAccounts, saveExecutionHost, saveExecutionRun, type ExecutionPrincipal } from "./execution-store";
import { cloudAccountUsage } from "./execution-cloud";
import { enrolledHost } from "./execution-common";
import { boxdOrganization } from "./execution-cloud/boxd";
import type { StoredCloudProvider } from "./execution-common";
import type { ExecutionAccountReport, ExecutionHost, ExecutionPolicyOverride, ExecutionRun } from "./execution-types";

vi.mock("./execution-cloud", () => ({ cloudAccountUsage: vi.fn() }));
vi.mock("./execution-cloud/boxd", () => ({ boxdOrganization: vi.fn() }));
const now = Date.UTC(2026, 10, 8, 12);
let directory: string;
beforeAll(() => { directory = mkdtempSync(path.join(tmpdir(), "origin-execution-browser-")); vi.stubEnv("ORIGIN_LOCAL_DATA_DIR", directory); });
beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(now);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Execution tests must not contact a live service"); }));
  const db = executionDb();
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'execution_%'").all() as { name: string }[]) db.exec(`DELETE FROM "${name}"`);
  vi.mocked(cloudAccountUsage).mockReset().mockResolvedValue({ status: "unknown" });
  vi.mocked(boxdOrganization).mockReset().mockResolvedValue("org-fixture");
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
afterAll(() => { executionDb().close(); rmSync(directory, { recursive: true, force: true }); vi.unstubAllEnvs(); });

function principal(patch: Partial<ExecutionPrincipal> = {}): ExecutionPrincipal {
  return { userId: "owner", teamId: "team", workspaceRole: "owner", admin: true, projectAdmin: true, write: true, projectIds: ["project"], project: { id: "project", name: "Project", status: "active", repositoryUrl: "https://github.com/fixture/project" }, task: { id: "task", title: "Implement behavior", description: "Keep secrets private", done: false }, ...patch };
}
function provision(actor = principal(), id = `${actor.userId}-host`, reportPatch: Partial<ExecutionAccountReport> = {}, hostPatch: Partial<ExecutionHost> = {}) {
  const report: ExecutionAccountReport = { id: "local-profile", identityHash: "synthetic-shared-provider-identity", provider: "fixture", label: `${actor.userId}'s account`, authKind: "subscription", authenticated: true, harnesses: ["codex"], models: [{ id: "fixture-model", efforts: ["high"] }], quota: { status: "available", observedAt: now, windows: [] }, ...reportPatch };
  const accountId = accountIdentity(actor.userId, report);
  const host: ExecutionHost = { id, teamId: actor.teamId, ownerId: actor.userId, name: id, kind: "nixos", platform: "linux", status: "online", online: true, paused: false, revoked: false, lastSeenAt: now, version: "1.0.0", capabilities: ["codex"], accountIds: [accountId], projectIds: actor.projectIds, activeRunIds: [], capacity: 1, ...hostPatch };
  saveExecutionHost(host, null); replaceExecutionAccounts(host, [report]);
  return { host, report, selection: { accountId, harness: "codex" as const, model: "fixture-model", effort: "high" } };
}
async function configure(actor = principal(), policy: ExecutionPolicyOverride = {}) {
  const fixture = provision(actor);
  await executionAction(actor, { action: "savePolicy", scope: "project", policy: { fallback: [fixture.selection], verificationCommands: ["npm test"], smokeCommand: "npm run smoke", ...policy } });
  return fixture;
}
async function start(actor = principal(), overrides = {}) {
  return (await executionAction(actor, { action: "startRun", overrides }) as { run: ExecutionRun; existing?: boolean });
}

test("cloud enrollment shares its allocation transaction and rolls back incomplete provisioning", () => {
  const actor = principal();
  const enrollment = atomicExecution(() => enrolledHost(actor, { name: "cloud", kind: "boxd", projectIds: ["project"] }, "allocation"));
  expect(executionSnapshot(actor).hosts.some(host => host.id === enrollment.hostId)).toBe(true);
  expect(() => atomicExecution(() => {
    enrolledHost(actor, { name: "uncommitted", kind: "boat", projectIds: ["project"] }, "failed-allocation");
    throw new Error("Allocation persistence failed");
  })).toThrow("Allocation persistence failed");
  expect(executionSnapshot(actor).hosts.map(host => host.name)).toEqual(["cloud"]);
  expect(executionDb().prepare("SELECT COUNT(*) AS count FROM execution_enrollments").get()).toMatchObject({ count: 1 });
});

test("saved workspace/project/task inheritance determines the immutable queued run policy", async () => {
  const actor = principal(), f = provision(actor);
  await executionAction(actor, { action: "savePolicy", scope: "workspace", policy: { fallback: [f.selection], timeoutSeconds: 600, environment: "workspace-env", verificationCommands: ["npm test"], smokeCommand: "npm run smoke" } });
  await executionAction(actor, { action: "savePolicy", scope: "project", policy: { timeoutSeconds: 1200, environment: "project-env", reservePercent: 15 } });
  await executionAction(actor, { action: "savePolicy", scope: "task", policy: { timeoutSeconds: 1800 } });
  const { run } = await start(actor);
  expect(run.environment).toBe("project-env");
  expect(readExecutionRun(run.id)?.policy).toMatchObject({ timeoutSeconds: 1800, reservePercent: 15, environment: "project-env", fallback: [f.selection] });
  await executionAction(actor, { action: "savePolicy", scope: "workspace", policy: { timeoutSeconds: 2400 } });
  expect(readExecutionRun(run.id)?.policy.timeoutSeconds).toBe(1800);
  const snapshot = executionSnapshot(actor);
  expect(snapshot.workspacePolicy.timeoutSeconds).toBe(2400);
  expect(snapshot.effectivePolicy.timeoutSeconds).toBe(1800);
  expect((await start(actor)).run.id).toBe(run.id);
});

test("subscription ownership cannot be inherited from a teammate's workspace policy", async () => {
  const owner = principal(); await configure(owner);
  const member = principal({ userId: "member", workspaceRole: "member", admin: false, projectAdmin: false });
  const own = provision(member);
  await expect(start(member)).rejects.toThrow(/owned by you|shared/i);
  await expect(executionAction(member, { action: "savePolicy", scope: "task", policy: { fallback: executionSnapshot(owner).effectivePolicy.fallback } })).rejects.toThrow(/owned by you|shared/i);
  expect((await start(member, { fallback: [own.selection] })).run.requestedBy).toBe("member");
  expect(executionSnapshot(member).accounts.map(account => account.ownerId)).toEqual(["member"]);
});

test.each(["allowPaidApi", "autoMerge", "baseBranch", "verificationCommands", "smokeCommand", "cloudEnabled"] as const)("a member cannot change the administrator's %s consent through task overrides", async field => {
  const owner = principal(); await configure(owner);
  const member = principal({ userId: "member", workspaceRole: "member", admin: false, projectAdmin: false });
  const value = { allowPaidApi: true, autoMerge: false, baseBranch: "unprotected", verificationCommands: ["true"], smokeCommand: "true", cloudEnabled: true }[field];
  await expect(executionAction(member, { action: "savePolicy", scope: "task", policy: { [field]: value } })).rejects.toThrow(/administrator/i);
  await expect(start(member, { [field]: value })).rejects.toThrow(/administrator/i);
});

test("a member clearing task overrides cannot erase administrator spending and merge restrictions", async () => {
  const owner = principal(); await configure(owner, { allowPaidApi: true, autoMerge: true, cloudEnabled: true });
  await executionAction(owner, { action: "savePolicy", scope: "task", policy: { allowPaidApi: false, autoMerge: false, cloudEnabled: false, verificationCommands: ["npm run security"], smokeCommand: "npm run full-smoke" } });
  const member = principal({ userId: "member", workspaceRole: "member", admin: false, projectAdmin: false });
  const paid = provision(member, "member-host", { authKind: "api" });
  await executionAction(member, { action: "savePolicy", scope: "task", policy: {} });
  await expect(start(member, { fallback: [paid.selection] })).rejects.toThrow(/Paid API use is disabled/i);
  expect(executionSnapshot(member).effectivePolicy).toMatchObject({ autoMerge: false, cloudEnabled: false, verificationCommands: ["npm run security"], smokeCommand: "npm run full-smoke" });
});

test.each(["browser", "mcp"] as const)("a restricted %s resume preserves the accepted run's administrator-only gates", async source => {
  const actor = principal(); await configure(actor, { allowPaidApi: true, autoMerge: true, cloudEnabled: true });
  const { run } = await start(actor, { allowPaidApi: false, autoMerge: false, cloudEnabled: false, verificationCommands: ["npm run security"], smokeCommand: "npm run full-smoke" });
  const record = readExecutionRun(run.id)!; record.run.status = "blocked"; saveExecutionRun(record);
  const caller = source === "mcp" ? actor : { ...actor, workspaceRole: "member", admin: false, projectAdmin: false };
  await executionAction(caller, { action: "startRun", overrides: { reservePercent: 20, environment: "preview" } }, source);
  expect(readExecutionRun(run.id)?.policy).toMatchObject({ allowPaidApi: false, autoMerge: false, cloudEnabled: false, verificationCommands: ["npm run security"], smokeCommand: "npm run full-smoke", reservePercent: 20, environment: "preview" });
  expect(executionRunDetail(caller, run.id).run.environment).toBe("preview");
});

test("a paid-only account cannot start without consent, even if it was saved in policy", async () => {
  const actor = principal(), paid = provision(actor, "paid-host", { authKind: "api" });
  await executionAction(actor, { action: "savePolicy", scope: "project", policy: { fallback: [paid.selection], verificationCommands: ["npm test"], smokeCommand: "npm run smoke" } });
  await expect(start(actor)).rejects.toThrow(/Paid API use is disabled/i);
  expect((await start(actor, { allowPaidApi: true })).run.status).toBe("queued");
});

test("project members may read shared run status but cannot control another owner's process", async () => {
  const owner = principal(); await configure(owner); const { run } = await start(owner);
  const member = principal({ userId: "member", workspaceRole: "member", admin: false, projectAdmin: false });
  expect(executionRunDetail(member, run.id).run.id).toBe(run.id);
  for (const action of [{ action: "cancelRun" }, { action: "messageRun", text: "Hijack" }, { action: "approve", approvalId: "approval", decision: "allow" }]) {
    await expect(executionAction(member, { ...action, runId: run.id })).rejects.toThrow(/requester|administrator/i);
  }
  expect(readExecutionRun(run.id)?.cancelRequested).toBe(false);
  await executionAction({ ...member, projectAdmin: true }, { action: "cancelRun", runId: run.id });
  expect(readExecutionRun(run.id)?.run.status).toBe("cancelled");
});

test("snapshot and run-detail isolation excludes other workspaces and invisible projects", async () => {
  const owner = principal(); await configure(owner); const visible = (await start(owner)).run;
  const privateActor = principal({ userId: "private-owner", projectIds: ["private"], project: { id: "private", name: "Private", status: "active", repositoryUrl: "https://github.com/fixture/private" }, task: { id: "private-task", title: "Private issue", description: "Private description", done: false } });
  await configure(privateActor); const hidden = (await start(privateActor)).run;
  const foreign = principal({ userId: "foreign-owner", teamId: "foreign-team", task: { id: "foreign-task", title: "Foreign issue", description: "Foreign description", done: false } });
  await configure(foreign); const otherWorkspace = (await start(foreign)).run;
  const member = principal({ userId: "member", admin: false, projectAdmin: false, workspaceRole: "member" });
  const snapshot = executionSnapshot(member);
  expect(snapshot.runs.map(run => run.id)).toEqual([visible.id]);
  expect(snapshot.hosts.map(host => host.id)).toEqual(["owner-host"]);
  expect(snapshot.accounts).toEqual([]);
  for (const run of [hidden, otherWorkspace]) {
    expect(() => executionRunDetail(member, run.id)).toThrow(/not found/i);
    await expect(executionAction(member, { action: "cancelRun", runId: run.id })).rejects.toThrow(/not found/i);
  }
});

test("cloud keys and automation values are write-only; snapshots expose only names, scopes and honest meters", async () => {
  const actor = principal(), f = await configure(actor);
  const key = "synthetic-provider-api-secret", value = "synthetic-database-password";
  await executionAction(actor, { action: "saveCloudProvider", provider: "boxd", apiKey: key, enabled: true });
  await executionAction(actor, { action: "saveEnvironment", name: "development", variables: { PASSWORD: value, EMPTY: "" }, hostIds: [f.host.id, f.host.id], automationEnabled: true });
  const snapshot = executionSnapshot(actor), encoded = JSON.stringify(snapshot);
  expect(snapshot.environments).toEqual([expect.objectContaining({ name: "development", keys: ["EMPTY", "PASSWORD"], hostIds: [f.host.id], automationEnabled: true })]);
  expect(snapshot.cloudProviders.find(provider => provider.provider === "boxd")).toMatchObject({ keyConfigured: true, enabled: true, usage: { status: "unknown" } });
  for (const secret of [key, value, "sealedKey", "sealed", "variables"]) expect(encoded).not.toContain(secret);
  expect(JSON.stringify(executionSetting(actor.teamId, "environment", "project:development"))).not.toContain(value);
  expect(JSON.stringify(executionSetting(actor.teamId, "cloud", "boxd"))).not.toContain(key);
  await executionAction(actor, { action: "saveCloudProvider", provider: "boxd", enabled: false });
  expect(executionSnapshot(actor).cloudProviders.find(provider => provider.provider === "boxd")).toMatchObject({ keyConfigured: true, enabled: false });
  await executionAction(actor, { action: "deleteEnvironment", environmentId: "project:development" });
  expect(executionSnapshot(actor).environments).toEqual([]);
});

test("Boxd consent binds the resolved organization and is cleared on credential replacement", async () => {
  const actor = principal();
  await executionAction(actor, { action: "saveCloudProvider", provider: "boxd", apiKey: "first-fixture-key", enabled: false });
  const first = executionSetting<StoredCloudProvider>(actor.teamId, "cloud", "boxd")!;
  expect(first.boxdBinding).toMatchObject({ orgId: "org-fixture" });
  expect(first.boxdBinding?.autoTopUpOffConfirmedAt).toBeUndefined();
  await executionAction(actor, { action: "saveCloudProvider", provider: "boxd", enabled: false, boxdAutoTopUpOff: true, boxdBillingRevision: first.boxdBinding!.revision });
  expect(executionSetting<StoredCloudProvider>(actor.teamId, "cloud", "boxd")!.boxdBinding).toMatchObject({ confirmedBy: actor.userId, autoTopUpOffConfirmedAt: now });
  vi.mocked(boxdOrganization).mockResolvedValueOnce("another-org");
  await executionAction(actor, { action: "saveCloudProvider", provider: "boxd", apiKey: "replacement-key", enabled: false });
  const replaced = executionSetting<StoredCloudProvider>(actor.teamId, "cloud", "boxd")!;
  expect(replaced.boxdBinding?.orgId).toBe("another-org");
  expect(replaced.boxdBinding?.revision).not.toBe(first.boxdBinding!.revision);
  expect(replaced.boxdBinding?.autoTopUpOffConfirmedAt).toBeUndefined();
  expect(replaced.nativeBilling).toBeUndefined();
  await expect(executionAction(actor, { action: "saveCloudProvider", provider: "boxd", enabled: true, boxdAutoTopUpOff: true, boxdBillingRevision: first.boxdBinding!.revision })).rejects.toThrow(/Save the Boxd credential first/);
});

test("Boxd unresolved key identity cannot overwrite the existing provider", async () => {
  const actor = principal();
  vi.mocked(boxdOrganization).mockRejectedValueOnce(new Error("Identity unavailable"));
  await expect(executionAction(actor, { action: "saveCloudProvider", provider: "boxd", apiKey: "unknown-key-fixture", enabled: false })).rejects.toThrow("Identity unavailable");
  expect(executionSetting(actor.teamId, "cloud", "boxd")).toBeUndefined();
});

test.each(["unscoped", "different project", "different workspace", "revoked"])("environment grants reject %s hosts without retaining the secret", async variant => {
  const actor = principal(); const local = provision(actor);
  let hostIds: string[] = [];
  if (variant !== "unscoped") {
    const unauthorized = provision(actor, "unauthorized", {}, variant === "different project" ? { projectIds: ["private"] } : variant === "different workspace" ? { teamId: "foreign" } : { revoked: true });
    hostIds = [local.host.id, unauthorized.host.id];
  }
  await expect(executionAction(actor, { action: "saveEnvironment", name: "development", variables: { TOKEN: "must-not-be-saved" }, hostIds, automationEnabled: true })).rejects.toThrow(/select.*machines/i);
  expect(executionSnapshot(actor).environments).toEqual([]);
});

test("environment metadata and deletion remain project-scoped", async () => {
  const owner = principal(), f = provision(owner);
  await executionAction(owner, { action: "saveEnvironment", name: "development", variables: { TOKEN: "synthetic-value" }, hostIds: [f.host.id], automationEnabled: true });
  const other = principal({ projectIds: ["private"], project: { id: "private", name: "Private", status: "active" } });
  expect(executionSnapshot(other).environments).toEqual([]);
  await expect(executionAction(other, { action: "deleteEnvironment", environmentId: "project:development" })).rejects.toThrow(/not found/i);
  expect(executionSnapshot(owner).environments).toHaveLength(1);
});

test("account meters become stale and shared subscription reports do not multiply available balances", () => {
  const actor = principal(), f = provision(actor, "first", { quota: { status: "available", observedAt: now - 300001, windows: [{ id: "primary", label: "Shared", usedPercent: 80, resetsAt: now + 60000 }] } });
  provision(actor, "second", { id: "another-local-profile", quota: { status: "available", observedAt: now - 1000, windows: [{ id: "primary", label: "Shared", usedPercent: 95, resetsAt: now + 60000 }] } });
  const accounts = executionSnapshot(actor).accounts;
  expect(accounts).toHaveLength(1);
  expect(accounts[0]).toMatchObject({ id: f.selection.accountId, hostIds: ["first", "second"], quota: { status: "available", windows: [expect.objectContaining({ usedPercent: 95 })] } });
  vi.mocked(Date.now).mockReturnValue(now + 300001);
  expect(executionSnapshot(actor).accounts[0]?.quota.status).toBe("stale");
  expect(executionAccounts(actor.teamId, actor.userId)[0]?.quota.status).toBe("available");
});

test("Hermes cannot expand spending, merge, secret or host-management authority", async () => {
  const actor = principal(); await configure(actor);
  for (const body of [
    { action: "savePolicy", scope: "task", policy: { allowPaidApi: true } },
    { action: "savePolicy", scope: "project", policy: { verificationCommands: ["true"] } },
    { action: "savePolicy", scope: "workspace", policy: { cloudEnabled: true } },
    { action: "saveEnvironment", name: "development", variables: {}, hostIds: [], automationEnabled: false },
    { action: "enrollHost", name: "Unauthorized", kind: "nixos", projectIds: ["project"] },
  ]) await expect(executionAction(actor, body, "mcp")).rejects.toThrow(/Hermes|owner's Origin interface/i);
  await executionAction(actor, { action: "savePolicy", scope: "task", policy: { timeoutSeconds: 600 } }, "mcp");
  expect(executionSnapshot(actor).effectivePolicy.timeoutSeconds).toBe(600);
});

test("view-only principals cannot submit mutations even with stale administrator flags", async () => {
  const actor = principal(); await configure(actor);
  const readonly = { ...actor, write: false };
  for (const action of ["startRun", "savePolicy", "cancelRun", "saveEnvironment", "saveCloudProvider", "enrollHost", "refreshUsage"]) {
    await expect(executionAction(readonly, { action })).rejects.toThrow(/read-only/i);
  }
});

test("Hermes cannot enable API billing through per-run overrides", async () => {
  const actor = principal(); await configure(actor);
  await expect(executionAction(actor, { action: "startRun", overrides: { allowPaidApi: true } }, "mcp")).rejects.toThrow(/spending consent/i);
});

test("Hermes patches preserve restrictive project consent, including empty patches", async () => {
  const actor = principal(); await configure(actor, { allowPaidApi: false, autoMerge: false, cloudEnabled: false });
  await executionAction(actor, { action: "savePolicy", scope: "workspace", policy: { allowPaidApi: true, autoMerge: true, cloudEnabled: true } });
  for (const policy of [{ reservePercent: 20 }, {}]) {
    await executionAction(actor, { action: "savePolicy", scope: "project", policy }, "mcp");
    expect(executionSnapshot(actor).effectivePolicy).toMatchObject({ allowPaidApi: false, autoMerge: false, cloudEnabled: false });
  }
});
