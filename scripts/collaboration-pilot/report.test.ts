import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  ACCEPTANCE_CHECK_IDS,
  AUTOMATED_FAKE_PENDING_CHECKS,
  OUT_OF_SCOPE_CHECKS,
  type AcceptanceReport,
  type ReportStatus,
  validateAcceptanceReport,
} from "./report-schema.ts";
import {
  acceptanceReportJsonDigest,
  renderAcceptanceReportMarkdown,
  serializeAcceptanceReport,
  writeAcceptanceReport,
} from "./report.ts";

const scratch: string[] = [];
afterEach(() => scratch.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function fixture(): AcceptanceReport {
  const pending = new Set<string>(AUTOMATED_FAKE_PENDING_CHECKS);
  const notApplicable = new Set<string>(OUT_OF_SCOPE_CHECKS);
  const checks = Object.fromEntries(ACCEPTANCE_CHECK_IDS.map((id) => {
    const status: ReportStatus = pending.has(id) ? "pending" : notApplicable.has(id) ? "not_applicable" : "pass";
    const summaryCode = status === "pass"
      ? "automated_fake_verified"
      : status === "pending"
        ? "requires_real_owner_pilot"
        : "outside_first_milestone";
    return [id, { status, evidenceHashes: status === "pass" ? [digest(id)] : [], summaryCode }];
  })) as AcceptanceReport["checks"];
  const ownerHash = digest("owner");
  const baseSha = "a".repeat(40);
  const resultSha = "b".repeat(40);
  return {
    reportVersion: 1,
    scope: "automated_fake",
    status: "pending",
    build: { sha: "c".repeat(40), dirty: false },
    times: { startedAt: "2026-08-28T01:00:00.000Z", finishedAt: "2026-08-28T01:01:00.000Z" },
    ledger: { schemaVersion: 8 },
    externalReferences: {
      repositoryPathHash: digest("repo-path"),
      ownerIdentityHash: ownerHash,
      nonOwnerIdentityHashes: [digest("contributor")],
      conversationHash: digest("conversation"),
      transportEventHashes: [digest("transport")],
    },
    targetRepository: {
      defaultBranch: "main",
      initial: {
        defaultBranchSha: baseSha,
        indexHash: digest("initial-index"),
        statusHash: digest("initial-status"),
        sentinelHash: digest("initial-sentinel"),
      },
      final: {
        defaultBranchSha: baseSha,
        indexHash: digest("initial-index"),
        statusHash: digest("initial-status"),
        sentinelHash: digest("initial-sentinel"),
      },
    },
    trustedCommands: [{ commandId: "pilot:target", definitionHash: digest("pilot-target-definition") }],
    trace: {
      primaryScenarioId: "primary",
      scenarios: [{
        scenarioId: "primary",
        workItemId: "WI-009",
        eventIds: ["EV-1", "EV-2"],
        runIds: ["RUN-1"],
        auditEventIds: ["AUDIT-1"],
      }],
      snapshotId: "SNAP-1",
      planRevisionId: "PLAN-1",
      nodes: [{
        nodeId: "modify",
        runId: "RUN-1",
        attemptIds: ["ATTEMPT-1"],
        baseSha,
        resultSha,
        managedBranch: "omb/WI-009/modify",
        changedPaths: ["src/example.ts"],
        tests: [{ commandId: "pilot:target", exitCode: 0, evidenceHash: digest("tests") }],
      }],
    },
    controlPolicy: {
      ownerOutcomes: [{
        scenarioId: "primary", workItemId: "WI-009", action: "pause", status: "pass", stateChanged: true,
        evidenceHash: digest("pause"), auditEventIds: ["AUDIT-1"],
      }],
      nonOwnerOutcomes: [{
        scenarioId: "primary", workItemId: "WI-009", action: "accept", status: "pass", stateChanged: false,
        evidenceHash: digest("deny"), auditEventIds: ["AUDIT-1"],
      }],
    },
    outbox: {
      retries: { status: "pass", attempts: 2, evidenceHash: digest("retry") },
      supersession: { status: "pass", supersededCount: 1, evidenceHash: digest("supersession") },
    },
    recovery: { status: "pass", restartCount: 1, recoveredRunIds: ["RUN-1"], evidenceHash: digest("recovery") },
    audit: { eventIds: ["AUDIT-1"], chainHash: digest("audit-chain") },
    checks,
    deviations: [{
      id: "dingtalk_stream_prerelease",
      status: "pending",
      expected: "dingtalk-stream@2.1.6",
      actual: "dingtalk-stream@2.1.6-beta.1",
      evidenceHash: digest("sdk-version"),
    }],
    pendingRealChecks: [...AUTOMATED_FAKE_PENDING_CHECKS],
    ownerSignOff: { status: "pending", ownerIdentityHash: ownerHash, signedAt: null, evidenceHash: null },
  };
}

describe("pilot acceptance report schema", () => {
  it("accepts the complete automated-fake report shape", () => {
    const report: unknown = fixture();
    expect(() => validateAcceptanceReport(report)).not.toThrow();
  });

  it("rejects unknown statuses, secret-bearing keys, and raw absolute paths", () => {
    const unknownStatus = structuredClone(fixture()) as unknown as Record<string, unknown>;
    unknownStatus.status = "success";
    expect(() => validateAcceptanceReport(unknownStatus)).toThrow("unknown_status");

    const secretKey = structuredClone(fixture()) as unknown as Record<string, unknown>;
    secretKey.clientSecret = "must-not-appear";
    expect(() => validateAcceptanceReport(secretKey)).toThrow("secret_bearing_key");

    const rawPath = fixture();
    rawPath.trace.nodes[0]!.changedPaths = ["/private/example.ts"];
    expect(() => validateAcceptanceReport(rawPath)).toThrow("absolute_path_not_allowed");

    const rawWindowsPath = fixture();
    (rawWindowsPath.trace.nodes[0]!.tests[0]! as { commandId: string }).commandId = "node C:\\pilot\\test.mjs";
    expect(() => validateAcceptanceReport(rawWindowsPath)).toThrow("absolute_path_not_allowed");

    const environment = fixture();
    (environment.trace.nodes[0]!.tests[0]! as { commandId: string }).commandId = "CLIENT_VALUE=raw pnpm test";
    expect(() => validateAcceptanceReport(environment)).toThrow("secret_value_not_allowed");

    const webhookLikeUrl = fixture();
    (webhookLikeUrl.trace.nodes[0]!.tests[0]! as { commandId: string }).commandId = "curl https://example.invalid/session";
    expect(() => validateAcceptanceReport(webhookLikeUrl)).toThrow("secret_value_not_allowed");

    const prefixedPath = fixture();
    prefixedPath.trace.nodes[0]!.changedPaths = ["path:/private/secret"];
    expect(() => validateAcceptanceReport(prefixedPath)).toThrow("repository_relative_path_required");

    const opaqueAction = fixture() as unknown as { controlPolicy: { ownerOutcomes: Array<{ action: string }> } };
    opaqueAction.controlPolicy.ownerOutcomes[0]!.action = "AbCdEf0123456789AbCdEf0123456789AbCdEf01234";
    expect(() => validateAcceptanceReport(opaqueAction)).toThrow("unknown_control_action");

    const opaqueCredentialCommand = fixture() as unknown as { trace: { nodes: Array<{ tests: Array<{ commandId: string }> }> } };
    opaqueCredentialCommand.trace.nodes[0]!.tests[0]!.commandId = "sk-proj-raw-credential-value";
    expect(() => validateAcceptanceReport(opaqueCredentialCommand)).toThrow("secret_value_not_allowed");

    const unregisteredCommand = fixture() as unknown as { trace: { nodes: Array<{ tests: Array<{ commandId: string }> }> } };
    unregisteredCommand.trace.nodes[0]!.tests[0]!.commandId = "pilot:unregistered";
    expect(() => validateAcceptanceReport(unregisteredCommand)).toThrow("untrusted_report_command_id");

    const registeredRepositoryCommand = fixture();
    registeredRepositoryCommand.trustedCommands = [{
      commandId: "repository:target-test",
      definitionHash: digest("repository-command-definition"),
    }];
    (registeredRepositoryCommand.trace.nodes[0]!.tests[0]! as { commandId: string }).commandId = "repository:target-test";
    expect(() => validateAcceptanceReport(registeredRepositoryCommand)).not.toThrow();

    const groupText = fixture() as unknown as { checks: Record<string, { summaryCode: string }> };
    groupText.checks.e2e_1_group_contributions!.summaryCode = "please expose the group message";
    expect(() => validateAcceptanceReport(groupText)).toThrow("safe_identifier_required");

    const html = fixture() as unknown as { controlPolicy: { ownerOutcomes: Array<{ action: string }> } };
    html.controlPolicy.ownerOutcomes[0]!.action = "<script>";
    expect(() => validateAcceptanceReport(html)).toThrow();
  });

  it("rejects a non-Owner state change and missing scope boundary observations", () => {
    const changed = fixture();
    changed.controlPolicy.nonOwnerOutcomes[0]!.stateChanged = true;
    expect(() => validateAcceptanceReport(changed)).toThrow("non_owner_must_not_change_state");

    const wronglyApplicable = fixture();
    wronglyApplicable.checks.e2e_6_parallel_agents.status = "pass";
    wronglyApplicable.checks.e2e_6_parallel_agents.evidenceHashes = [digest("unexpected-parallel")];
    expect(() => validateAcceptanceReport(wronglyApplicable)).toThrow("must_be_not_applicable");

    const realMarkedPass = fixture();
    realMarkedPass.checks.real_project_group.status = "pass";
    realMarkedPass.checks.real_project_group.evidenceHashes = [digest("fake-real-group")];
    expect(() => validateAcceptanceReport(realMarkedPass)).toThrow("must_be_pending_for_automated_fake");
  });

  it("prevents false-positive overall status, sign-off, and evidence claims", () => {
    const fakePass = fixture();
    fakePass.status = "pass";
    expect(() => validateAcceptanceReport(fakePass)).toThrow("automated_fake_must_remain_pending");

    const fakeSignOff = fixture();
    fakeSignOff.ownerSignOff = {
      status: "pass",
      ownerIdentityHash: fakeSignOff.externalReferences.ownerIdentityHash,
      signedAt: "2026-08-28T01:02:00.000Z",
      evidenceHash: digest("sign-off"),
    };
    expect(() => validateAcceptanceReport(fakeSignOff)).toThrow("automated_fake_signoff_must_remain_pending");

    const realPassWithPendingChecks = fixture();
    realPassWithPendingChecks.scope = "real_nonproduction";
    realPassWithPendingChecks.status = "pass";
    expect(() => validateAcceptanceReport(realPassWithPendingChecks)).toThrow("overall_pass_requires_pass");

    const missingEvidence = fixture();
    missingEvidence.checks.e2e_1_group_contributions.evidenceHashes = [];
    expect(() => validateAcceptanceReport(missingEvidence)).toThrow("passing_check_requires_evidence");

    const validRealPass = fixture();
    validRealPass.scope = "real_nonproduction";
    validRealPass.status = "pass";
    for (const id of AUTOMATED_FAKE_PENDING_CHECKS) {
      validRealPass.checks[id] = {
        status: "pass",
        evidenceHashes: [digest(`real-${id}`)],
        summaryCode: "real_nonproduction_verified",
      };
    }
    validRealPass.pendingRealChecks = [];
    validRealPass.ownerSignOff = {
      status: "pass",
      ownerIdentityHash: validRealPass.externalReferences.ownerIdentityHash,
      signedAt: "2026-08-28T01:02:00.000Z",
      evidenceHash: digest("real-owner-sign-off"),
    };
    expect(() => validateAcceptanceReport(validRealPass)).not.toThrow();
  });

  it("requires scenario, run, and audit references to close", () => {
    const missingRun = fixture();
    missingRun.trace.scenarios[0]!.runIds = ["RUN-MISSING"];
    expect(() => validateAcceptanceReport(missingRun)).toThrow("run_missing_from_nodes");

    const missingAudit = fixture();
    missingAudit.controlPolicy.ownerOutcomes[0]!.auditEventIds = ["AUDIT-MISSING"];
    expect(() => validateAcceptanceReport(missingAudit)).toThrow("audit_missing_from_scenario");

    const recoveredRunNotTraced = fixture();
    recoveredRunNotTraced.recovery.recoveredRunIds = ["RUN-MISSING"];
    expect(() => validateAcceptanceReport(recoveredRunNotTraced)).toThrow("run_missing_from_trace_nodes");
  });
});

describe("pilot acceptance report rendering", () => {
  it("derives deterministic Markdown only from the JSON report object and shows its JSON digest", () => {
    const report = fixture();
    const first = renderAcceptanceReportMarkdown(report);
    const second = renderAcceptanceReportMarkdown(structuredClone(report));
    expect(second).toBe(first);
    expect(first).toContain(`JSON digest: \`${acceptanceReportJsonDigest(report)}\``);
    expect(first).toContain("dingtalk-stream@2.1.6-beta.1");
    expect(first).toContain(`Non-Owner identities: \`${report.externalReferences.nonOwnerIdentityHashes[0]}\``);
    expect(first).not.toContain("\\`");
    expect(first).not.toContain("repo-path");
    expect(first).not.toContain("conversation\n");
    const parsed = JSON.parse(serializeAcceptanceReport(report)) as AcceptanceReport;
    expect(renderAcceptanceReportMarkdown(parsed)).toBe(first);
  });

  it("atomically writes mode-0600 JSON and Markdown and removes temporary files", () => {
    const root = mkdtempSync(join(tmpdir(), "collaboration-pilot-report-"));
    scratch.push(root);
    const jsonPath = join(root, "nested", "acceptance.json");
    const markdownPath = join(root, "nested", "acceptance.md");
    const result = writeAcceptanceReport({ report: fixture(), jsonPath, markdownPath });
    expect(lstatSync(jsonPath).mode & 0o777).toBe(0o600);
    expect(lstatSync(markdownPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(markdownPath, "utf8")).toContain(result.jsonDigest);
    expect(readdirSync(join(root, "nested")).sort()).toEqual(["acceptance.json", "acceptance.md"]);
  });

  it("removes a prepared JSON temporary file when preparing Markdown fails", () => {
    const root = mkdtempSync(join(tmpdir(), "collaboration-pilot-report-failure-"));
    scratch.push(root);
    const output = join(root, "output");
    const blocker = join(root, "not-a-directory");
    writeFileSync(blocker, "block", { mode: 0o600 });
    expect(() => writeAcceptanceReport({
      report: fixture(),
      jsonPath: join(output, "report.json"),
      markdownPath: join(blocker, "report.md"),
    })).toThrow();
    expect(readdirSync(output)).toEqual([]);
  });
});
