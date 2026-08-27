export const ACCEPTANCE_REPORT_VERSION = 1 as const;

export const REPORT_STATUSES = ["pass", "fail", "pending", "not_applicable"] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export const REPORT_SCOPES = ["automated_fake", "real_nonproduction"] as const;
export type ReportScope = (typeof REPORT_SCOPES)[number];

export const ACCEPTANCE_CHECK_IDS = [
  "e2e_1_group_contributions",
  "e2e_2_structured_work_item",
  "e2e_3_plan_to_candidate",
  "e2e_4_isolated_worktree",
  "e2e_5_plan_revision",
  "e2e_6_parallel_agents",
  "e2e_7_quality_reporting",
  "e2e_8_unauthorized_control",
  "e2e_9_preview_deployment",
  "e2e_10_restart_recovery",
  "deployment",
  "default_branch_merge",
  "multi_agent_execution",
  "real_dingtalk_credentials",
  "real_project_group",
  "real_status_card_clicks",
  "service_manager",
  "host_reboot",
  "privilege_separated_cgroup",
  "nonproduction_repository",
  "owner_human_signoff",
] as const;
export type AcceptanceCheckId = (typeof ACCEPTANCE_CHECK_IDS)[number];

export const CONTROL_ACTIONS = [
  "stale_action", "audit_write_failure", "pause", "pause_replay", "resume", "retry", "reject", "cancel", "accept",
] as const;
export type ControlAction = (typeof CONTROL_ACTIONS)[number];

export const CHECK_SUMMARY_CODES = [
  "automated_fake_verified",
  "real_nonproduction_verified",
  "observation_failed",
  "requires_real_owner_pilot",
  "outside_first_milestone",
] as const;
export type CheckSummaryCode = (typeof CHECK_SUMMARY_CODES)[number];

export const AUTOMATED_FAKE_PENDING_CHECKS = [
  "real_dingtalk_credentials",
  "real_project_group",
  "real_status_card_clicks",
  "service_manager",
  "host_reboot",
  "privilege_separated_cgroup",
  "nonproduction_repository",
  "owner_human_signoff",
] as const satisfies readonly AcceptanceCheckId[];

export const OUT_OF_SCOPE_CHECKS = [
  "e2e_6_parallel_agents",
  "e2e_9_preview_deployment",
  "deployment",
  "default_branch_merge",
  "multi_agent_execution",
] as const satisfies readonly AcceptanceCheckId[];

export interface CheckResult {
  status: ReportStatus;
  evidenceHashes: string[];
  summaryCode: CheckSummaryCode;
}

export interface RepositoryStateEvidence {
  defaultBranchSha: string;
  indexHash: string;
  statusHash: string;
  sentinelHash: string;
}

export interface TestCommandEvidence {
  commandId: string;
  exitCode: number;
  evidenceHash: string;
}

export interface TrustedCommandDefinition {
  commandId: string;
  definitionHash: string;
}

export interface NodeTrace {
  nodeId: string;
  runId: string;
  attemptIds: string[];
  baseSha: string;
  resultSha: string | null;
  managedBranch: string;
  changedPaths: string[];
  tests: TestCommandEvidence[];
}

export interface ControlOutcome {
  scenarioId: string;
  workItemId: string;
  action: ControlAction;
  status: ReportStatus;
  stateChanged: boolean;
  evidenceHash: string;
  auditEventIds: string[];
}

export interface ScenarioTrace {
  scenarioId: string;
  workItemId: string;
  eventIds: string[];
  runIds: string[];
  auditEventIds: string[];
}

export interface AcceptanceReport {
  reportVersion: typeof ACCEPTANCE_REPORT_VERSION;
  scope: ReportScope;
  status: ReportStatus;
  build: {
    sha: string;
    dirty: boolean;
  };
  times: {
    startedAt: string;
    finishedAt: string;
  };
  ledger: {
    schemaVersion: number;
  };
  externalReferences: {
    repositoryPathHash: string;
    ownerIdentityHash: string;
    nonOwnerIdentityHashes: string[];
    conversationHash: string;
    transportEventHashes: string[];
  };
  targetRepository: {
    defaultBranch: string;
    initial: RepositoryStateEvidence;
    final: RepositoryStateEvidence;
  };
  trustedCommands: TrustedCommandDefinition[];
  trace: {
    primaryScenarioId: string;
    scenarios: ScenarioTrace[];
    snapshotId: string;
    planRevisionId: string;
    nodes: NodeTrace[];
  };
  controlPolicy: {
    ownerOutcomes: ControlOutcome[];
    nonOwnerOutcomes: ControlOutcome[];
  };
  outbox: {
    retries: {
      status: ReportStatus;
      attempts: number;
      evidenceHash: string;
    };
    supersession: {
      status: ReportStatus;
      supersededCount: number;
      evidenceHash: string;
    };
  };
  recovery: {
    status: ReportStatus;
    restartCount: number;
    recoveredRunIds: string[];
    evidenceHash: string;
  };
  audit: {
    eventIds: string[];
    chainHash: string;
  };
  checks: Record<AcceptanceCheckId, CheckResult>;
  deviations: Array<{
    id: string;
    status: ReportStatus;
    expected: string;
    actual: string;
    evidenceHash: string;
  }>;
  pendingRealChecks: AcceptanceCheckId[];
  ownerSignOff: {
    status: ReportStatus;
    ownerIdentityHash: string;
    signedAt: string | null;
    evidenceHash: string | null;
  };
}

const statusSet = new Set<string>(REPORT_STATUSES);
const scopeSet = new Set<string>(REPORT_SCOPES);
const checkIdSet = new Set<string>(ACCEPTANCE_CHECK_IDS);
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const gitShaPattern = /^[a-f0-9]{40,64}$/;
const safeIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,255}$/;
const commandIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
const controlActionSet = new Set<string>(CONTROL_ACTIONS);
const checkSummaryCodeSet = new Set<string>(CHECK_SUMMARY_CODES);
const secretKeyPattern = /(?:secret|credential|token|webhook|auth(?:orization|entication)?(?:header)?|environment|env(?:ironment)?)/i;
const secretValuePatterns = [
  /authorization\s*:\s*(?:bearer|basic)\s+/i,
  /(?:client[_-]?secret|session[_-]?webhook|x-api-key)\s*[:=]/i,
  /(?:OMB_DINGTALK_CLIENT_SECRET|DINGTALK_CLIENT_SECRET)\s*=/i,
  /(?:^|[^A-Za-z0-9])sk-(?:proj|live|test)-[A-Za-z0-9_-]{8,}/,
  /(?:^|[^A-Za-z0-9])(?:ghp_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{8,}/i,
  /(?:^|[^A-Za-z0-9])AKIA[A-Z0-9]{12,}/,
  /(?:^|\s)[A-Za-z_][A-Za-z0-9_]*=/,
  /https?:\/\//i,
];

function fail(path: string, reason: string): never {
  throw new Error(`acceptance_report_invalid:${path}:${reason}`);
}

function object(value: unknown, path: string, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(path, "object_required");
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!keys.includes(key)) {
      fail(`${path}.${key}`, secretKeyPattern.test(key) ? "secret_bearing_key" : "unknown_key");
    }
  }
  for (const key of keys) if (!(key in record)) fail(`${path}.${key}`, "required");
  return record;
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, "array_required");
  return value;
}

function string(value: unknown, path: string, options: { empty?: boolean; pathAllowed?: boolean } = {}): string {
  if (typeof value !== "string" || (!options.empty && value.length === 0)) fail(path, "string_required");
  if (value.length > 4_096) fail(path, "string_too_long");
  if (/[\u0000-\u001f\u007f`]/.test(value)) fail(path, "unsafe_character_not_allowed");
  if (!options.pathAllowed && isAbsolutePathLike(value)) fail(path, "absolute_path_not_allowed");
  for (const pattern of secretValuePatterns) if (pattern.test(value)) fail(path, "secret_value_not_allowed");
  return value;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(path, "boolean_required");
  return value;
}

function integer(value: unknown, path: string, minimum = 0): number {
  if (!Number.isInteger(value) || (value as number) < minimum) fail(path, "non_negative_integer_required");
  return value as number;
}

function status(value: unknown, path: string): ReportStatus {
  if (typeof value !== "string" || !statusSet.has(value)) fail(path, "unknown_status");
  return value as ReportStatus;
}

function digest(value: unknown, path: string): string {
  const result = string(value, path);
  if (!digestPattern.test(result)) fail(path, "sha256_digest_required");
  return result;
}

function gitSha(value: unknown, path: string, nullable = false): void {
  if (nullable && value === null) return;
  const result = string(value, path);
  if (!gitShaPattern.test(result)) fail(path, "git_sha_required");
}

function identifier(value: unknown, path: string): string {
  const result = string(value, path);
  if (!safeIdentifierPattern.test(result)) fail(path, "safe_identifier_required");
  return result;
}

function commandId(value: unknown, path: string): string {
  const result = string(value, path);
  if (!commandIdPattern.test(result)) fail(path, "command_id_required");
  return result;
}

function branchIdentifier(value: unknown, path: string): string {
  const result = string(value, path);
  if (!/^[A-Za-z0-9][A-Za-z0-9._@/-]{0,255}$/.test(result) || result.includes("..") || result.includes("//")) {
    fail(path, "managed_branch_required");
  }
  return result;
}

function isoTime(value: unknown, path: string): void {
  const result = string(value, path);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(result) || Number.isNaN(Date.parse(result))) {
    fail(path, "utc_iso_time_required");
  }
}

function isAbsolutePathLike(value: string): boolean {
  return /(?:^|[\s"'=])\/(?!\/)/.test(value) || /(?:^|[\s"'=])~[\\/]/.test(value) ||
    /(?:^|[\s"'=])[A-Za-z]:[\\/]/.test(value) || /(?:^|[\s"'=])\\\\/.test(value) ||
    /(?:^|[\s"'=])file:\/\//i.test(value);
}

function stringArray(value: unknown, path: string, check: (item: unknown, itemPath: string) => unknown = string): void {
  array(value, path).forEach((item, index) => check(item, `${path}[${index}]`));
}

function repositoryState(value: unknown, path: string): void {
  const record = object(value, path, ["defaultBranchSha", "indexHash", "statusHash", "sentinelHash"]);
  gitSha(record.defaultBranchSha, `${path}.defaultBranchSha`);
  digest(record.indexHash, `${path}.indexHash`);
  digest(record.statusHash, `${path}.statusHash`);
  digest(record.sentinelHash, `${path}.sentinelHash`);
}

function checkResult(value: unknown, path: string): void {
  const record = object(value, path, ["status", "evidenceHashes", "summaryCode"]);
  status(record.status, `${path}.status`);
  stringArray(record.evidenceHashes, `${path}.evidenceHashes`, digest);
  const summaryCode = identifier(record.summaryCode, `${path}.summaryCode`);
  if (!checkSummaryCodeSet.has(summaryCode)) fail(`${path}.summaryCode`, "unknown_summary_code");
}

function controlOutcome(value: unknown, path: string, nonOwner: boolean): void {
  const record = object(value, path, [
    "scenarioId", "workItemId", "action", "status", "stateChanged", "evidenceHash", "auditEventIds",
  ]);
  identifier(record.scenarioId, `${path}.scenarioId`);
  identifier(record.workItemId, `${path}.workItemId`);
  const action = identifier(record.action, `${path}.action`);
  if (!controlActionSet.has(action)) fail(`${path}.action`, "unknown_control_action");
  status(record.status, `${path}.status`);
  const changed = boolean(record.stateChanged, `${path}.stateChanged`);
  if (nonOwner && changed) fail(`${path}.stateChanged`, "non_owner_must_not_change_state");
  digest(record.evidenceHash, `${path}.evidenceHash`);
  stringArray(record.auditEventIds, `${path}.auditEventIds`, identifier);
  const auditCount = (record.auditEventIds as unknown[]).length;
  if (action === "audit_write_failure" && auditCount !== 0) {
    fail(`${path}.auditEventIds`, "failed_audit_write_must_not_claim_audit_event");
  }
  if (action !== "audit_write_failure" && auditCount !== 1) {
    fail(`${path}.auditEventIds`, "single_action_audit_reference_required");
  }
}

function nodeTrace(value: unknown, path: string, trustedCommandIds: ReadonlySet<string>): void {
  const record = object(value, path, [
    "nodeId", "runId", "attemptIds", "baseSha", "resultSha", "managedBranch", "changedPaths", "tests",
  ]);
  identifier(record.nodeId, `${path}.nodeId`);
  identifier(record.runId, `${path}.runId`);
  stringArray(record.attemptIds, `${path}.attemptIds`, identifier);
  gitSha(record.baseSha, `${path}.baseSha`);
  gitSha(record.resultSha, `${path}.resultSha`, true);
  branchIdentifier(record.managedBranch, `${path}.managedBranch`);
  stringArray(record.changedPaths, `${path}.changedPaths`, (item, itemPath) => {
    const changedPath = string(item, itemPath);
    if (changedPath.startsWith("../") || changedPath === ".." || changedPath.startsWith("./") ||
        changedPath.includes(":") || changedPath.includes("\\") || changedPath.split("/").includes("..") ||
        !/^[A-Za-z0-9._@-]+(?:\/[A-Za-z0-9._@-]+)*$/.test(changedPath)) {
      fail(itemPath, "repository_relative_path_required");
    }
    return changedPath;
  });
  array(record.tests, `${path}.tests`).forEach((item, index) => {
    const testPath = `${path}.tests[${index}]`;
    const test = object(item, testPath, ["commandId", "exitCode", "evidenceHash"]);
    const trustedCommandId = commandId(test.commandId, `${testPath}.commandId`);
    if (!trustedCommandIds.has(trustedCommandId)) fail(`${testPath}.commandId`, "untrusted_report_command_id");
    integer(test.exitCode, `${testPath}.exitCode`);
    digest(test.evidenceHash, `${testPath}.evidenceHash`);
  });
}

export function validateAcceptanceReport(value: unknown): asserts value is AcceptanceReport {
  const report = object(value, "report", [
    "reportVersion", "scope", "status", "build", "times", "ledger", "externalReferences", "targetRepository",
    "trustedCommands", "trace", "controlPolicy", "outbox", "recovery", "audit", "checks", "deviations", "pendingRealChecks",
    "ownerSignOff",
  ]);
  if (report.reportVersion !== ACCEPTANCE_REPORT_VERSION) fail("report.reportVersion", "unsupported_version");
  if (typeof report.scope !== "string" || !scopeSet.has(report.scope)) fail("report.scope", "unknown_scope");
  status(report.status, "report.status");

  const build = object(report.build, "report.build", ["sha", "dirty"]);
  gitSha(build.sha, "report.build.sha");
  boolean(build.dirty, "report.build.dirty");
  const times = object(report.times, "report.times", ["startedAt", "finishedAt"]);
  isoTime(times.startedAt, "report.times.startedAt");
  isoTime(times.finishedAt, "report.times.finishedAt");
  if (Date.parse(times.finishedAt as string) < Date.parse(times.startedAt as string)) {
    fail("report.times", "finished_before_started");
  }
  const ledger = object(report.ledger, "report.ledger", ["schemaVersion"]);
  integer(ledger.schemaVersion, "report.ledger.schemaVersion", 1);

  const refs = object(report.externalReferences, "report.externalReferences", [
    "repositoryPathHash", "ownerIdentityHash", "nonOwnerIdentityHashes", "conversationHash", "transportEventHashes",
  ]);
  digest(refs.repositoryPathHash, "report.externalReferences.repositoryPathHash");
  digest(refs.ownerIdentityHash, "report.externalReferences.ownerIdentityHash");
  stringArray(refs.nonOwnerIdentityHashes, "report.externalReferences.nonOwnerIdentityHashes", digest);
  digest(refs.conversationHash, "report.externalReferences.conversationHash");
  stringArray(refs.transportEventHashes, "report.externalReferences.transportEventHashes", digest);

  const target = object(report.targetRepository, "report.targetRepository", ["defaultBranch", "initial", "final"]);
  identifier(target.defaultBranch, "report.targetRepository.defaultBranch");
  repositoryState(target.initial, "report.targetRepository.initial");
  repositoryState(target.final, "report.targetRepository.final");

  const trustedCommandIds = new Set<string>();
  array(report.trustedCommands, "report.trustedCommands").forEach((item, index) => {
    const path = `report.trustedCommands[${index}]`;
    const definition = object(item, path, ["commandId", "definitionHash"]);
    const trustedCommandId = commandId(definition.commandId, `${path}.commandId`);
    if (trustedCommandIds.has(trustedCommandId)) fail(`${path}.commandId`, "duplicate_command_id");
    digest(definition.definitionHash, `${path}.definitionHash`);
    trustedCommandIds.add(trustedCommandId);
  });
  if (trustedCommandIds.size === 0) fail("report.trustedCommands", "trusted_command_required");

  const trace = object(report.trace, "report.trace", [
    "primaryScenarioId", "scenarios", "snapshotId", "planRevisionId", "nodes",
  ]);
  const primaryScenarioId = identifier(trace.primaryScenarioId, "report.trace.primaryScenarioId");
  const scenarioMap = new Map<string, { workItemId: string; runIds: Set<string>; auditEventIds: Set<string> }>();
  array(trace.scenarios, "report.trace.scenarios").forEach((item, index) => {
    const path = `report.trace.scenarios[${index}]`;
    const scenario = object(item, path, ["scenarioId", "workItemId", "eventIds", "runIds", "auditEventIds"]);
    const scenarioId = identifier(scenario.scenarioId, `${path}.scenarioId`);
    const workItemId = identifier(scenario.workItemId, `${path}.workItemId`);
    if (scenarioMap.has(scenarioId)) fail(`${path}.scenarioId`, "duplicate_scenario_id");
    stringArray(scenario.eventIds, `${path}.eventIds`, identifier);
    stringArray(scenario.runIds, `${path}.runIds`, identifier);
    stringArray(scenario.auditEventIds, `${path}.auditEventIds`, identifier);
    scenarioMap.set(scenarioId, {
      workItemId,
      runIds: new Set(scenario.runIds as string[]),
      auditEventIds: new Set(scenario.auditEventIds as string[]),
    });
  });
  if (!scenarioMap.has(primaryScenarioId)) fail("report.trace.primaryScenarioId", "unknown_primary_scenario");
  identifier(trace.snapshotId, "report.trace.snapshotId");
  identifier(trace.planRevisionId, "report.trace.planRevisionId");
  array(trace.nodes, "report.trace.nodes").forEach((item, index) =>
    nodeTrace(item, `report.trace.nodes[${index}]`, trustedCommandIds));
  const nodeRunIds = new Set((trace.nodes as Array<{ runId: string }>).map((node) => node.runId));
  const scenarioRunIds = new Set<string>();
  for (const [scenarioId, scenario] of scenarioMap) {
    for (const runId of scenario.runIds) {
      scenarioRunIds.add(runId);
      if (!nodeRunIds.has(runId)) fail(`report.trace.scenarios.${scenarioId}.runIds`, "run_missing_from_nodes");
    }
  }
  for (const runId of nodeRunIds) {
    if (!scenarioRunIds.has(runId)) fail("report.trace.nodes", "node_run_missing_from_scenario");
  }

  const policy = object(report.controlPolicy, "report.controlPolicy", ["ownerOutcomes", "nonOwnerOutcomes"]);
  const validateControl = (item: unknown, path: string, nonOwner: boolean) => {
    controlOutcome(item, path, nonOwner);
    const outcome = item as ControlOutcome;
    const scenario = scenarioMap.get(outcome.scenarioId);
    if (!scenario) fail(`${path}.scenarioId`, "unknown_scenario");
    if (scenario.workItemId !== outcome.workItemId) fail(`${path}.workItemId`, "scenario_work_item_mismatch");
    for (const auditId of outcome.auditEventIds) {
      if (!scenario.auditEventIds.has(auditId)) fail(`${path}.auditEventIds`, "audit_missing_from_scenario");
    }
  };
  array(policy.ownerOutcomes, "report.controlPolicy.ownerOutcomes").forEach((item, index) =>
    validateControl(item, `report.controlPolicy.ownerOutcomes[${index}]`, false));
  array(policy.nonOwnerOutcomes, "report.controlPolicy.nonOwnerOutcomes").forEach((item, index) =>
    validateControl(item, `report.controlPolicy.nonOwnerOutcomes[${index}]`, true));

  const outbox = object(report.outbox, "report.outbox", ["retries", "supersession"]);
  const retries = object(outbox.retries, "report.outbox.retries", ["status", "attempts", "evidenceHash"]);
  status(retries.status, "report.outbox.retries.status");
  integer(retries.attempts, "report.outbox.retries.attempts");
  digest(retries.evidenceHash, "report.outbox.retries.evidenceHash");
  if (retries.status === "pass" && (retries.attempts as number) < 2) {
    fail("report.outbox.retries.attempts", "passing_retry_requires_multiple_attempts");
  }
  const supersession = object(outbox.supersession, "report.outbox.supersession", [
    "status", "supersededCount", "evidenceHash",
  ]);
  status(supersession.status, "report.outbox.supersession.status");
  integer(supersession.supersededCount, "report.outbox.supersession.supersededCount");
  digest(supersession.evidenceHash, "report.outbox.supersession.evidenceHash");
  if (supersession.status === "pass" && (supersession.supersededCount as number) < 1) {
    fail("report.outbox.supersession.supersededCount", "passing_supersession_requires_observation");
  }

  const recovery = object(report.recovery, "report.recovery", ["status", "restartCount", "recoveredRunIds", "evidenceHash"]);
  status(recovery.status, "report.recovery.status");
  integer(recovery.restartCount, "report.recovery.restartCount");
  stringArray(recovery.recoveredRunIds, "report.recovery.recoveredRunIds", identifier);
  if (recovery.status === "pass" && ((recovery.restartCount as number) < 1 || (recovery.recoveredRunIds as unknown[]).length < 1)) {
    fail("report.recovery", "passing_recovery_requires_restart_and_run");
  }
  for (const runId of recovery.recoveredRunIds as string[]) {
    if (!nodeRunIds.has(runId)) fail("report.recovery.recoveredRunIds", "run_missing_from_trace_nodes");
  }
  digest(recovery.evidenceHash, "report.recovery.evidenceHash");

  const audit = object(report.audit, "report.audit", ["eventIds", "chainHash"]);
  stringArray(audit.eventIds, "report.audit.eventIds", identifier);
  digest(audit.chainHash, "report.audit.chainHash");
  const auditIds = new Set(audit.eventIds as string[]);
  for (const [scenarioId, scenario] of scenarioMap) {
    for (const auditId of scenario.auditEventIds) {
      if (!auditIds.has(auditId)) fail(`report.trace.scenarios.${scenarioId}.auditEventIds`, "audit_missing_from_report");
    }
  }

  const checks = object(report.checks, "report.checks", ACCEPTANCE_CHECK_IDS);
  for (const checkId of ACCEPTANCE_CHECK_IDS) {
    checkResult(checks[checkId], `report.checks.${checkId}`);
    const check = checks[checkId] as CheckResult;
    if (check.status === "pass" && check.evidenceHashes.length === 0) {
      fail(`report.checks.${checkId}.evidenceHashes`, "passing_check_requires_evidence");
    }
  }
  for (const checkId of OUT_OF_SCOPE_CHECKS) {
    if ((checks[checkId] as CheckResult).status !== "not_applicable") {
      fail(`report.checks.${checkId}.status`, "must_be_not_applicable");
    }
  }
  if (report.scope === "automated_fake") {
    for (const checkId of AUTOMATED_FAKE_PENDING_CHECKS) {
      if ((checks[checkId] as CheckResult).status !== "pending") {
        fail(`report.checks.${checkId}.status`, "must_be_pending_for_automated_fake");
      }
    }
  }

  const deviations = array(report.deviations, "report.deviations");
  if (deviations.length !== 1) fail("report.deviations", "exactly_one_deviation_required");
  deviations.forEach((item, index) => {
    const path = `report.deviations[${index}]`;
    const deviation = object(item, path, ["id", "status", "expected", "actual", "evidenceHash"]);
    identifier(deviation.id, `${path}.id`);
    status(deviation.status, `${path}.status`);
    commandId(deviation.expected, `${path}.expected`);
    commandId(deviation.actual, `${path}.actual`);
    digest(deviation.evidenceHash, `${path}.evidenceHash`);
  });
  const sdkDeviation = deviations.find((item) =>
    (item as Record<string, unknown>).id === "dingtalk_stream_prerelease") as Record<string, unknown> | undefined;
  if (!sdkDeviation || sdkDeviation.expected !== "dingtalk-stream@2.1.6" ||
      sdkDeviation.actual !== "dingtalk-stream@2.1.6-beta.1") {
    fail("report.deviations", "dingtalk_stream_prerelease_required");
  }

  const pendingChecks = array(report.pendingRealChecks, "report.pendingRealChecks");
  const pendingIds = new Set<string>();
  pendingChecks.forEach((item, index) => {
    const id = string(item, `report.pendingRealChecks[${index}]`);
    if (!checkIdSet.has(id)) fail(`report.pendingRealChecks[${index}]`, "unknown_check_id");
    if (pendingIds.has(id)) fail(`report.pendingRealChecks[${index}]`, "duplicate_check_id");
    pendingIds.add(id);
    if ((checks[id] as CheckResult).status !== "pending") fail(`report.pendingRealChecks[${index}]`, "check_not_pending");
  });
  if (report.scope === "automated_fake") {
    for (const id of AUTOMATED_FAKE_PENDING_CHECKS) {
      if (!pendingIds.has(id)) fail("report.pendingRealChecks", `missing_${id}`);
    }
  }

  const signOff = object(report.ownerSignOff, "report.ownerSignOff", [
    "status", "ownerIdentityHash", "signedAt", "evidenceHash",
  ]);
  status(signOff.status, "report.ownerSignOff.status");
  digest(signOff.ownerIdentityHash, "report.ownerSignOff.ownerIdentityHash");
  if (signOff.ownerIdentityHash !== refs.ownerIdentityHash) fail("report.ownerSignOff.ownerIdentityHash", "owner_mismatch");
  if (signOff.signedAt !== null) isoTime(signOff.signedAt, "report.ownerSignOff.signedAt");
  if (signOff.evidenceHash !== null) digest(signOff.evidenceHash, "report.ownerSignOff.evidenceHash");
  if (signOff.status === "pending" && (signOff.signedAt !== null || signOff.evidenceHash !== null)) {
    fail("report.ownerSignOff", "pending_signoff_must_be_empty");
  }
  if (signOff.status === "pass" && (signOff.signedAt === null || signOff.evidenceHash === null)) {
    fail("report.ownerSignOff", "passing_signoff_requires_evidence");
  }
  if (report.scope === "automated_fake") {
    if (report.status !== "pending") fail("report.status", "automated_fake_must_remain_pending");
    if (signOff.status !== "pending") fail("report.ownerSignOff.status", "automated_fake_signoff_must_remain_pending");
  }
  if (report.status === "pass") {
    for (const id of ACCEPTANCE_CHECK_IDS) {
      if ((checks[id] as CheckResult).status === "not_applicable") continue;
      if ((checks[id] as CheckResult).status !== "pass") fail(`report.checks.${id}.status`, "overall_pass_requires_pass");
    }
    if (pendingIds.size !== 0) fail("report.pendingRealChecks", "overall_pass_cannot_have_pending_checks");
    if (signOff.status !== "pass") fail("report.ownerSignOff.status", "overall_pass_requires_owner_signoff");
  }
}
