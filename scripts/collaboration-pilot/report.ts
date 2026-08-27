import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  ACCEPTANCE_CHECK_IDS,
  type AcceptanceReport,
  validateAcceptanceReport,
} from "./report-schema.ts";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, nested]) => [key, canonicalize(nested)]),
  );
}

export function serializeAcceptanceReport(report: AcceptanceReport): string {
  validateAcceptanceReport(report);
  return `${JSON.stringify(canonicalize(report), null, 2)}\n`;
}

export function acceptanceReportJsonDigest(report: AcceptanceReport): string {
  return `sha256:${createHash("sha256").update(serializeAcceptanceReport(report), "utf8").digest("hex")}`;
}

function escapeHtml(value: unknown): string {
  if (value === null) return "—";
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeCell(value: unknown): string {
  return escapeHtml(value).replaceAll("`", "&#96;").replaceAll("|", "\\|").replaceAll("\n", " ");
}

function list(values: readonly string[]): string {
  return values.length === 0 ? "—" : values.join(", ");
}

function inlineCode(value: unknown): string {
  return "`" + escapeHtml(value).replaceAll("`", "&#96;").replaceAll("\n", " ") + "`";
}

export function renderAcceptanceReportMarkdown(report: AcceptanceReport): string {
  validateAcceptanceReport(report);
  const jsonDigest = acceptanceReportJsonDigest(report);
  const lines = [
    "# Non-production pilot acceptance report",
    "",
    "> Generated deterministically from the adjacent JSON source of truth. Do not edit this Markdown by hand.",
    "",
    `- JSON digest: \`${jsonDigest}\``,
    `- Scope: \`${report.scope}\``,
    `- Overall status: \`${report.status}\``,
    `- Build: \`${report.build.sha}\` (${report.build.dirty ? "dirty" : "clean"})`,
    `- Started: \`${report.times.startedAt}\``,
    `- Finished: \`${report.times.finishedAt}\``,
    `- Ledger schema: \`${report.ledger.schemaVersion}\``,
    "",
    "## Privacy-safe external references",
    "",
    `- Repository path: \`${report.externalReferences.repositoryPathHash}\``,
    `- Owner identity: \`${report.externalReferences.ownerIdentityHash}\``,
    `- Non-Owner identities: ${list(report.externalReferences.nonOwnerIdentityHashes.map(inlineCode))}`,
    `- Conversation: \`${report.externalReferences.conversationHash}\``,
    `- Transport events: ${list(report.externalReferences.transportEventHashes.map(inlineCode))}`,
    "",
    "## Target repository invariants",
    "",
    `Default branch: \`${escapeCell(report.targetRepository.defaultBranch)}\``,
    "",
    "| Observation | Initial | Final |",
    "|---|---|---|",
    `| Default SHA | \`${report.targetRepository.initial.defaultBranchSha}\` | \`${report.targetRepository.final.defaultBranchSha}\` |`,
    `| Index | \`${report.targetRepository.initial.indexHash}\` | \`${report.targetRepository.final.indexHash}\` |`,
    `| Status | \`${report.targetRepository.initial.statusHash}\` | \`${report.targetRepository.final.statusHash}\` |`,
    `| Sentinel | \`${report.targetRepository.initial.sentinelHash}\` | \`${report.targetRepository.final.sentinelHash}\` |`,
    "",
    "## Trusted command registry",
    "",
    "| Command ID | Definition |",
    "|---|---|",
    ...report.trustedCommands.map((command) =>
      `| \`${escapeCell(command.commandId)}\` | \`${command.definitionHash}\` |`),
    "",
    "## Trace",
    "",
    `- Primary scenario: \`${report.trace.primaryScenarioId}\``,
    `- Snapshot: \`${report.trace.snapshotId}\``,
    `- Plan revision: \`${report.trace.planRevisionId}\``,
    "",
  ];
  for (const scenario of report.trace.scenarios) {
    lines.push(
      `### Scenario \`${escapeCell(scenario.scenarioId)}\``,
      "",
      `- Work Item: \`${scenario.workItemId}\``,
      `- Events: ${list(scenario.eventIds.map(inlineCode))}`,
      `- Runs: ${list(scenario.runIds.map(inlineCode))}`,
      `- Audit events: ${list(scenario.auditEventIds.map(inlineCode))}`,
      "",
    );
  }
  for (const node of report.trace.nodes) {
    lines.push(
      `### Node \`${escapeCell(node.nodeId)}\``,
      "",
      `- Run: \`${node.runId}\``,
      `- Attempts: ${list(node.attemptIds.map(inlineCode))}`,
      `- Base/result: \`${node.baseSha}\` → ${node.resultSha ? `\`${node.resultSha}\`` : "—"}`,
      `- Managed branch: \`${escapeCell(node.managedBranch)}\``,
      `- Changed paths: ${list(node.changedPaths.map(inlineCode))}`,
      "",
      "| Test command | Exit | Evidence |",
      "|---|---:|---|",
      ...node.tests.map((test) =>
        `| \`${escapeCell(test.commandId)}\` | ${test.exitCode} | \`${test.evidenceHash}\` |`),
      "",
    );
  }
  lines.push(
    "## Control policy observations",
    "",
    "| Actor | Scenario | Work Item | Action | Status | State changed | Audit | Evidence |",
    "|---|---|---|---|---|---|---|---|",
    ...report.controlPolicy.ownerOutcomes.map((outcome) =>
      `| Owner | \`${escapeCell(outcome.scenarioId)}\` | \`${escapeCell(outcome.workItemId)}\` | ` +
        `\`${escapeCell(outcome.action)}\` | ${outcome.status} | ${outcome.stateChanged} | ` +
        `${list(outcome.auditEventIds.map(inlineCode))} | \`${outcome.evidenceHash}\` |`),
    ...report.controlPolicy.nonOwnerOutcomes.map((outcome) =>
      `| Non-Owner | \`${escapeCell(outcome.scenarioId)}\` | \`${escapeCell(outcome.workItemId)}\` | ` +
        `\`${escapeCell(outcome.action)}\` | ${outcome.status} | ${outcome.stateChanged} | ` +
        `${list(outcome.auditEventIds.map(inlineCode))} | \`${outcome.evidenceHash}\` |`),
    "",
    "## Outbox, recovery, and audit",
    "",
    `- Outbox retry: \`${report.outbox.retries.status}\`; attempts ${report.outbox.retries.attempts}; evidence \`${report.outbox.retries.evidenceHash}\``,
    `- Outbox supersession: \`${report.outbox.supersession.status}\`; rows ${report.outbox.supersession.supersededCount}; evidence \`${report.outbox.supersession.evidenceHash}\``,
    `- Recovery: \`${report.recovery.status}\`; restarts ${report.recovery.restartCount}; runs ${list(report.recovery.recoveredRunIds.map(inlineCode))}; evidence \`${report.recovery.evidenceHash}\``,
    `- Audit events: ${list(report.audit.eventIds.map(inlineCode))}`,
    `- Audit chain: \`${report.audit.chainHash}\``,
    "",
    "## Acceptance checks",
    "",
    "| Check | Status | Summary | Evidence |",
    "|---|---|---|---|",
    ...ACCEPTANCE_CHECK_IDS.map((id) => {
      const check = report.checks[id];
      return `| \`${id}\` | ${check.status} | \`${escapeCell(check.summaryCode)}\` | ${list(check.evidenceHashes.map(inlineCode))} |`;
    }),
    "",
    "## Deviations",
    "",
    "| ID | Status | Expected | Actual | Evidence |",
    "|---|---|---|---|---|",
    ...report.deviations.map((deviation) =>
      `| \`${escapeCell(deviation.id)}\` | ${deviation.status} | \`${escapeCell(deviation.expected)}\` | \`${escapeCell(deviation.actual)}\` | \`${deviation.evidenceHash}\` |`),
    "",
    "## Pending real checks",
    "",
    ...(report.pendingRealChecks.length === 0
      ? ["None."]
      : report.pendingRealChecks.map((id) => `- \`${id}\``)),
    "",
    "## Single Owner sign-off",
    "",
    `- Status: \`${report.ownerSignOff.status}\``,
    `- Owner identity: \`${report.ownerSignOff.ownerIdentityHash}\``,
    `- Signed at: ${report.ownerSignOff.signedAt ? `\`${report.ownerSignOff.signedAt}\`` : "—"}`,
    `- Evidence: ${report.ownerSignOff.evidenceHash ? `\`${report.ownerSignOff.evidenceHash}\`` : "—"}`,
    "",
    "No co-signing role exists for this milestone.",
    "",
  );
  return lines.join("\n");
}

function prepareAtomicFile(path: string, contents: string): string {
  const destination = resolve(path);
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  const descriptor = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(descriptor, contents, "utf8");
    fsyncSync(descriptor);
  } catch (error) {
    closeSync(descriptor);
    rmSync(temporary, { force: true });
    throw error;
  }
  closeSync(descriptor);
  chmodSync(temporary, 0o600);
  return temporary;
}

export function writeAcceptanceReport(input: {
  report: AcceptanceReport;
  jsonPath: string;
  markdownPath: string;
}): { jsonPath: string; markdownPath: string; jsonDigest: string } {
  const jsonPath = resolve(input.jsonPath);
  const markdownPath = resolve(input.markdownPath);
  if (jsonPath === markdownPath) throw new Error("acceptance_report_paths_must_differ");
  const json = serializeAcceptanceReport(input.report);
  const markdown = renderAcceptanceReportMarkdown(input.report);
  let jsonTemporary: string | undefined;
  let markdownTemporary: string | undefined;
  try {
    jsonTemporary = prepareAtomicFile(jsonPath, json);
    markdownTemporary = prepareAtomicFile(markdownPath, markdown);
    renameSync(jsonTemporary, jsonPath);
    jsonTemporary = undefined;
    chmodSync(jsonPath, 0o600);
    renameSync(markdownTemporary, markdownPath);
    markdownTemporary = undefined;
    chmodSync(markdownPath, 0o600);
  } finally {
    if (jsonTemporary) rmSync(jsonTemporary, { force: true });
    if (markdownTemporary) rmSync(markdownTemporary, { force: true });
  }
  return { jsonPath, markdownPath, jsonDigest: acceptanceReportJsonDigest(input.report) };
}
