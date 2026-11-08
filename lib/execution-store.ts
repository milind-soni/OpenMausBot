import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { localDataDir } from "./localRealtime";
import { executionProfileMatchesSelection } from "./execution-policy";
import type { ExecutionAccount, ExecutionAccountReport, ExecutionHost, ExecutionPolicy, ExecutionRun, ExecutionEvent, ExecutionSelection } from "./execution-types";

export type ExecutionPrincipal = {
  userId: string; teamId: string; workspaceRole: string; admin: boolean; projectAdmin: boolean; write: boolean;
  projectIds: string[]; grantId?: string;
  project: { id: string; name: string; status: string; repositoryUrl?: string; githubWorkspaceAccess?: boolean } | null;
  task: { id: string; title: string; description: string; done: boolean; completionPullRequest?: { number: number; headSha: string; mergeSha: string; mergedAt: number } } | null;
};
export type PrivateRun = {
  run: ExecutionRun; policy: ExecutionPolicy; prompt: string; grantId?: string;
  attempted: string[]; leaseHash: string | null; leaseExpiresAt: number; sequence: number;
  cancelRequested: boolean; sealedEnvironment?: string; sealedGitCredential?: string;
  gitCredentialExpiresAt?: number; logBytes: number; logsCapped?: boolean;
  attemptStartedAt?: number; controllerCheckedAt?: number;
  attemptUsage?: { inputTokens: number; outputTokens: number; estimatedApiUsd: number };
  billingKind?: "subscription" | "api";
  environmentRevision?: number;
};
export type CloudAllocation = {
  id: string; teamId: string; ownerId: string; projectId: string; provider: "boxd" | "boat";
  status: "creating" | "starting" | "bootstrapping" | "ready" | "stopping" | "stopped" | "unknown" | "failed";
  name: string; idempotencyKey: string; machineId?: string; hostId?: string; operationId?: string;
  createdAt: number; updatedAt: number; lastActiveAt: number; ttlRefreshedAt?: number; error?: string;
  runnerStoppedAt?: number;
  stopProof?: { kind: "provider-cold-stop" | "guest-supervisor-stop"; observedAt: number; machineId: string; environmentClean: boolean };
  runDeadline?: { runId: string; attempt: number; deadline: number };
  herdr?: { version: string; session: string; user: "origin-runner"; verifiedAt: number };
  herdrConnectionUntil?: number;
  herdrSshEnabled?: boolean;
};
let database: DatabaseSync | undefined;
export function executionDb() {
  if (database) return database;
  mkdirSync(localDataDir(), { recursive: true, mode: 0o700 });
  const file = path.join(localDataDir(), "execution.sqlite");
  database = new DatabaseSync(file);
  chmodSync(file, 0o600);
  database.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS execution_hosts(id TEXT PRIMARY KEY,team_id TEXT NOT NULL,owner_id TEXT NOT NULL,token_hash TEXT UNIQUE,payload TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS execution_hosts_team_owner ON execution_hosts(team_id,owner_id);
    CREATE TABLE IF NOT EXISTS execution_enrollments(hash TEXT PRIMARY KEY,expires INTEGER NOT NULL,payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS execution_accounts(account_id TEXT NOT NULL,host_id TEXT NOT NULL,local_id TEXT NOT NULL,team_id TEXT NOT NULL,owner_id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(account_id,host_id,local_id));
    CREATE INDEX IF NOT EXISTS execution_accounts_team_owner ON execution_accounts(team_id,owner_id);
    CREATE TABLE IF NOT EXISTS execution_settings(team_id TEXT NOT NULL,kind TEXT NOT NULL,reference TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(team_id,kind,reference));
    CREATE TABLE IF NOT EXISTS execution_runs(id TEXT PRIMARY KEY,team_id TEXT NOT NULL,project_id TEXT NOT NULL,task_id TEXT NOT NULL,host_id TEXT,status TEXT NOT NULL,updated INTEGER NOT NULL,payload TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS execution_runs_team_updated ON execution_runs(team_id,updated DESC);
    CREATE INDEX IF NOT EXISTS execution_runs_host_status ON execution_runs(host_id,status);
    CREATE UNIQUE INDEX IF NOT EXISTS execution_runs_active_task ON execution_runs(team_id,task_id) WHERE status IN ('queued','preparing','running','verifying','blocked','awaiting_checks');
    CREATE TABLE IF NOT EXISTS execution_events(id INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT NOT NULL,created INTEGER NOT NULL,payload TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS execution_events_run_cursor ON execution_events(run_id,id);
    CREATE TABLE IF NOT EXISTS execution_controls(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,kind TEXT NOT NULL,created INTEGER NOT NULL,payload TEXT NOT NULL,acknowledged INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS execution_controls_run ON execution_controls(run_id,acknowledged,created);
    CREATE TABLE IF NOT EXISTS execution_cloud(id TEXT PRIMARY KEY,team_id TEXT NOT NULL,owner_id TEXT NOT NULL,project_id TEXT NOT NULL,provider TEXT NOT NULL,payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS execution_locks(name TEXT PRIMARY KEY,expires INTEGER NOT NULL,owner TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS execution_audit(id TEXT PRIMARY KEY,team_id TEXT NOT NULL,user_id TEXT NOT NULL,created INTEGER NOT NULL,action TEXT NOT NULL,subject TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS execution_audit_team_created ON execution_audit(team_id,created DESC);`);
  return database;
}
export function atomicExecution<T>(fn: () => T): T {
  const db = executionDb(); db.exec("BEGIN IMMEDIATE");
  try { const result = fn(); db.exec("COMMIT"); return result; }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}
export const executionTokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
export function executionSetting<T>(teamId: string, kind: string, reference: string): T | undefined {
  const row = executionDb().prepare("SELECT payload FROM execution_settings WHERE team_id=? AND kind=? AND reference=?").get(teamId, kind, reference) as { payload: string } | undefined;
  return row ? JSON.parse(row.payload) as T : undefined;
}
export function setExecutionSetting(teamId: string, kind: string, reference: string, value: unknown) {
  executionDb().prepare("INSERT INTO execution_settings VALUES(?,?,?,?) ON CONFLICT(team_id,kind,reference) DO UPDATE SET payload=excluded.payload").run(teamId, kind, reference, JSON.stringify(value));
}
export function executionSettings<T>(teamId: string, kind: string): T[] {
  return (executionDb().prepare("SELECT payload FROM execution_settings WHERE team_id=? AND kind=? ORDER BY reference LIMIT 1000").all(teamId, kind) as { payload: string }[]).map(row => JSON.parse(row.payload) as T);
}
export function deleteExecutionSetting(teamId: string, kind: string, reference: string) {
  executionDb().prepare("DELETE FROM execution_settings WHERE team_id=? AND kind=? AND reference=?").run(teamId, kind, reference);
}
export function executionAudit(principal: Pick<ExecutionPrincipal, "userId" | "teamId">, action: string, subject: string) {
  executionDb().prepare("INSERT INTO execution_audit VALUES(?,?,?,?,?,?)").run(randomUUID(), principal.teamId, principal.userId, Date.now(), action, subject);
}
export function readExecutionHost(id: string): ExecutionHost | undefined {
  const row = executionDb().prepare("SELECT payload FROM execution_hosts WHERE id=?").get(id) as { payload: string } | undefined;
  return row ? JSON.parse(row.payload) : undefined;
}
export function saveExecutionHost(host: ExecutionHost, tokenHash?: string | null) {
  if (tokenHash !== undefined) executionDb().prepare("INSERT INTO execution_hosts VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET token_hash=excluded.token_hash,payload=excluded.payload").run(host.id, host.teamId, host.ownerId, tokenHash, JSON.stringify(host));
  else executionDb().prepare("UPDATE execution_hosts SET payload=? WHERE id=?").run(JSON.stringify(host), host.id);
}
export function executionHosts(teamId?: string): ExecutionHost[] {
  const rows = (teamId
    ? executionDb().prepare("SELECT payload FROM execution_hosts WHERE team_id=? LIMIT 500").all(teamId)
    : executionDb().prepare("SELECT payload FROM execution_hosts LIMIT 1000").all()) as { payload: string }[];
  return rows.map(row => JSON.parse(row.payload));
}
export function authenticatedExecutionHost(token: string, allowRevoked = false): ExecutionHost | undefined {
  if (token.length < 32 || token.length > 200) return undefined;
  const row = executionDb().prepare("SELECT payload FROM execution_hosts WHERE token_hash=?").get(executionTokenHash(token)) as { payload: string } | undefined;
  const host: ExecutionHost | undefined = row ? JSON.parse(row.payload) : undefined;
  return host && (allowRevoked || !host.revoked) ? host : undefined;
}
export function accountIdentity(ownerId: string, account: ExecutionAccountReport) {
  return `account_${executionTokenHash(JSON.stringify([ownerId, account.provider, account.identityHash])).slice(0, 32)}`;
}
export function replaceExecutionAccounts(host: ExecutionHost, accounts: ExecutionAccountReport[]) {
  executionDb().prepare("DELETE FROM execution_accounts WHERE host_id=?").run(host.id);
  const insert = executionDb().prepare("INSERT INTO execution_accounts VALUES(?,?,?,?,?,?)");
  for (const account of accounts) insert.run(accountIdentity(host.ownerId, account), host.id, account.id, host.teamId, host.ownerId, JSON.stringify({ ...account, updatedAt: Date.now() }));
}
export function executionAccountBinding(selection: ExecutionSelection, hostId: string, allowPaidApi: boolean): ExecutionAccountReport | undefined {
  const rows = executionDb().prepare("SELECT payload FROM execution_accounts WHERE account_id=? AND host_id=? ORDER BY local_id").all(selection.accountId, hostId) as { payload: string }[];
  const profiles = rows.map(row => JSON.parse(row.payload) as ExecutionAccountReport).filter(profile => executionProfileMatchesSelection(profile, selection, allowPaidApi));
  return profiles.find(profile => profile.authKind === "subscription") ?? profiles[0];
}
function quotaPriority(quota: ExecutionAccountReport["quota"], now: number) {
  if (!quota.windows.length) return 0;
  return quota.status === "available" && quota.observedAt <= now + 60000 && now - quota.observedAt <= 300000 ? 2 : 1;
}
export function executionAccounts(teamId: string, ownerId?: string): ExecutionAccount[] {
  const rows = (ownerId
    ? executionDb().prepare("SELECT account_id,host_id,owner_id,payload FROM execution_accounts WHERE team_id=? AND owner_id=? LIMIT 1000").all(teamId, ownerId)
    : executionDb().prepare("SELECT account_id,host_id,owner_id,payload FROM execution_accounts WHERE team_id=? LIMIT 1000").all(teamId)) as { account_id: string; host_id: string; owner_id: string; payload: string }[];
  const grouped = new Map<string, ExecutionAccount>(), now = Date.now();
  for (const row of rows) {
    const report = JSON.parse(row.payload) as ExecutionAccountReport & { updatedAt: number };
    let account = grouped.get(row.account_id);
    if (!account) {
      account = { ...report, id: row.account_id, ownerId: row.owner_id, hostIds: [], bindings: {} };
      grouped.set(row.account_id, account);
    }
    if (!account.hostIds.includes(row.host_id)) account.hostIds.push(row.host_id);
    (account.bindings![row.host_id] ||= []).push({ accountId: report.id, authKind: report.authKind, authenticated: report.authenticated, harnesses: report.harnesses, models: report.models });
    if (account.authKind !== report.authKind) account.authKind = "unknown";
    account.authenticated ||= report.authenticated;
    account.harnesses = Array.from(new Set([...account.harnesses, ...report.harnesses]));
    if (report.authenticated && report.models?.length) {
      const catalog = new Map((account.models || []).map(model => [model.id, model]));
      for (const model of report.models) {
        const previous = catalog.get(model.id);
        catalog.set(model.id, previous ? { id: model.id, efforts: [...new Set([...(previous.efforts || []), ...(model.efforts || [])])] } : model);
      }
      account.models = [...catalog.values()];
    }
    account.updatedAt = Math.max(account.updatedAt, report.updatedAt);
    const incomingPriority = quotaPriority(report.quota, now), currentPriority = quotaPriority(account.quota, now);
    if (incomingPriority > currentPriority || incomingPriority === currentPriority && report.quota.observedAt > account.quota.observedAt) account.quota = report.quota;
  }
  return [...grouped.values()];
}
export function readExecutionRun(id: string): PrivateRun | undefined {
  const row = executionDb().prepare("SELECT payload FROM execution_runs WHERE id=?").get(id) as { payload: string } | undefined;
  return row ? JSON.parse(row.payload) : undefined;
}
export function saveExecutionRun(record: PrivateRun) {
  const run = record.run;
  executionDb().prepare("INSERT INTO execution_runs VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET host_id=excluded.host_id,status=excluded.status,updated=excluded.updated,payload=excluded.payload").run(run.id, run.teamId, run.projectId, run.taskId, run.hostId || null, run.status, run.updatedAt, JSON.stringify(record));
}
export function executionRuns(teamId?: string, activeOnly = false): PrivateRun[] {
  const clauses: string[] = [], args: string[] = [];
  if (teamId) { clauses.push("team_id=?"); args.push(teamId); }
  if (activeOnly) clauses.push("status IN ('queued','preparing','running','verifying','blocked','awaiting_checks')");
  const rows = executionDb().prepare(`SELECT payload FROM execution_runs${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""} ORDER BY updated DESC${activeOnly ? "" : " LIMIT 500"}`).all(...args) as { payload: string }[];
  return rows.map(row => JSON.parse(row.payload));
}
export function executionUnstoppedHostRuns(hostId: string): PrivateRun[] {
  const rows = executionDb().prepare("SELECT payload FROM execution_runs WHERE host_id=? AND json_extract(payload,'$.run.processStopped') IS NOT 1 ORDER BY updated DESC").all(hostId) as { payload: string }[];
  return rows.map(row => JSON.parse(row.payload));
}
export function executionHostHasAttempt(hostId: string): boolean {
  return Boolean(executionDb().prepare("SELECT 1 FROM execution_runs WHERE host_id=? AND COALESCE(json_extract(payload,'$.run.attempt'),1)>0 LIMIT 1").get(hostId));
}
export function executionDeploymentRuns(teamId: string): PrivateRun[] {
  const rows = executionDb().prepare("SELECT payload FROM execution_runs WHERE team_id=? AND status='merged' AND COALESCE(json_extract(payload,'$.run.merge.mergeSha'),'')!='' ORDER BY CASE WHEN json_extract(payload,'$.run.deployment.observedAt') IS NULL THEN 0 ELSE 1 END,COALESCE(json_extract(payload,'$.controllerCheckedAt'),0),id LIMIT 20").all(teamId) as { payload: string }[];
  return rows.map(row => JSON.parse(row.payload));
}
export function appendExecutionEvent(runId: string, value: Omit<ExecutionEvent, "id" | "runId" | "createdAt">) {
  const createdAt = Date.now();
  const result = executionDb().prepare("INSERT INTO execution_events(run_id,created,payload) VALUES(?,?,?)").run(runId, createdAt, JSON.stringify(value));
  return Number(result.lastInsertRowid);
}
export function executionEvents(runId: string, cursor: number): ExecutionEvent[] {
  return (executionDb().prepare("SELECT id,created,payload FROM execution_events WHERE run_id=? AND id>? ORDER BY id LIMIT 250").all(runId, cursor) as { id: number; created: number; payload: string }[]).map(row => ({ ...JSON.parse(row.payload), id: row.id, runId, createdAt: row.created }));
}
export function queueExecutionControl(runId: string, kind: "message" | "approval", value: unknown, id: string = randomUUID()) {
  executionDb().prepare("INSERT INTO execution_controls VALUES(?,?,?,?,?,0) ON CONFLICT(id) DO NOTHING").run(id, runId, kind, Date.now(), JSON.stringify(value));
  return id;
}
export function pendingExecutionControls(runId: string) {
  return (executionDb().prepare("SELECT id,kind,payload FROM execution_controls WHERE run_id=? AND acknowledged=0 ORDER BY created LIMIT 100").all(runId) as { id: string; kind: string; payload: string }[]).map(row => ({ id: row.id, kind: row.kind, value: JSON.parse(row.payload) }));
}
export function acknowledgeExecutionControls(runId: string, ids: string[]) {
  const statement = executionDb().prepare("UPDATE execution_controls SET acknowledged=1 WHERE run_id=? AND id=?");
  for (const id of ids) statement.run(runId, id);
}
export function saveCloudAllocation(allocation: CloudAllocation) {
  executionDb().prepare("INSERT INTO execution_cloud VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload").run(allocation.id, allocation.teamId, allocation.ownerId, allocation.projectId, allocation.provider, JSON.stringify(allocation));
}
export function patchCloudAllocation(id: string, patch: Partial<CloudAllocation>): CloudAllocation {
  const update = () => {
    const row = executionDb().prepare("SELECT payload FROM execution_cloud WHERE id=?").get(id) as { payload: string } | undefined;
    if (!row) throw new Error("Cloud allocation journal is missing");
    const current: CloudAllocation = { ...JSON.parse(row.payload), ...patch, updatedAt: Date.now() };
    saveCloudAllocation(current);
    return current;
  };
  return executionDb().isTransaction ? update() : atomicExecution(update);
}
export function cloudAllocations(teamId?: string): CloudAllocation[] {
  const rows = (teamId ? executionDb().prepare("SELECT payload FROM execution_cloud WHERE team_id=? LIMIT 500").all(teamId) : executionDb().prepare("SELECT payload FROM execution_cloud LIMIT 500").all()) as { payload: string }[];
  return rows.map(row => JSON.parse(row.payload));
}
export function acquireExecutionLock(name: string, durationMs: number) {
  const owner = randomUUID(), now = Date.now();
  const row = executionDb().prepare("INSERT INTO execution_locks VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET expires=excluded.expires,owner=excluded.owner WHERE execution_locks.expires<? RETURNING owner").get(name, now + durationMs, owner, now) as { owner: string } | undefined;
  return row?.owner === owner ? owner : null;
}
export function releaseExecutionLock(name: string, owner: string) {
  executionDb().prepare("DELETE FROM execution_locks WHERE name=? AND owner=?").run(name, owner);
}
