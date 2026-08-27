import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { appendExecutionAudit } from "./audit.ts";
import type { AgentRunPort, AgentRunResult } from "./provider-runner.ts";
import { eventBelongsToRun } from "./provider-runner.ts";
import {
  renderCandidateStatus,
  runTargetTests,
  type CandidateStatusReport,
  type SandboxedCommandRunner,
  type TargetCommandSpec,
  type TestEvidence,
} from "./quality-gate.ts";
import { WorktreeManager, type ManagedWorktree } from "./worktree-manager.ts";

interface NodeRow {
  node_id: string;
  assigned_agent_id: string;
  objective: string;
  input_evidence_json: string;
  instructions: string;
  read_scope_json: string;
  write_scope_json: string;
  deny_scope_json: string;
  commands_json: string;
  target_commands_json: string;
  expected_artifacts_json: string;
  completion_definition: string;
  budget_json: string;
  repository: string;
  current_plan_revision: number;
}

export interface RepositoryExecutionConfig {
  baseSha: string;
  targetCommands: Readonly<Record<string, TargetCommandSpec>>;
}

export interface CandidateExecutorOptions {
  agent: AgentRunPort;
  commandRunner: SandboxedCommandRunner;
  managedWorktreeRoot: string;
  repositories: Readonly<Record<string, RepositoryExecutionConfig>>;
  limits: {
    maxAttempts: number;
    agentTimeoutMs: number;
    maxAgentEventBytes: number;
    interruptGraceMs: number;
  };
}

export interface CandidateExecutionOutcome {
  runId: string;
  workItemId: string;
  planRevision: number;
  nodeId: string;
  baseSha: string;
  resultSha: string | null;
  branch: string;
  worktreePath: string;
  changedPaths: string[];
  report: CandidateStatusReport;
  evidence: TestEvidence[];
}

function parseStrings(value: string): string[] {
  return JSON.parse(value) as string[];
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
}

export class CandidateExecutor {
  private readonly database: DatabaseSync;
  private readonly serviceDataDirectory: string;
  private readonly worktrees: WorktreeManager;
  private readonly options: CandidateExecutorOptions;
  private closed = false;

  constructor(databaseFile: string, options: CandidateExecutorOptions) {
    this.options = options;
    this.database = new DatabaseSync(databaseFile);
    this.serviceDataDirectory = realpathSync(dirname(realpathSync(databaseFile)));
    this.database.exec("PRAGMA foreign_keys = ON");
    this.database.exec("PRAGMA busy_timeout = 5000");
    const version = this.database.prepare("PRAGMA user_version").get() as { user_version: number };
    if (version.user_version < 4) throw new Error("Trusted candidate schema is not installed");
    if (options.limits.maxAttempts < 1) throw new Error("Execution maxAttempts must be positive");
    this.worktrees = new WorktreeManager(options.managedWorktreeRoot);
  }

  async executeCurrentPlan(workItemId: string, attempt = 1, now = Date.now()): Promise<CandidateExecutionOutcome> {
    if (this.closed) throw new Error("Candidate executor is closed");
    if (attempt > this.options.limits.maxAttempts) throw new Error("Execution attempt limit exceeded");
    const node = this.loadModifyNode(workItemId);
    const repository = realpathSync(node.repository);
    const configured = Object.entries(this.options.repositories).find(([path]) => realpathSync(path) === repository)?.[1];
    if (!configured) throw new Error("Work Item repository is not configured for execution");
    const runId = randomUUID();
    const threadId = `collaboration-${runId}`;
    const turnId = randomUUID();
    const worktree = await this.worktrees.prepare({
      repository,
      workItemId,
      nodeId: node.node_id,
      attempt,
      expectedBaseSha: configured.baseSha,
    });
    this.startRun({ runId, workItemId, attempt, node, threadId, turnId, worktree, now });

    const controller = new AbortController();
    let eventBytes = 0;
    let eventSequence = 0;
    let acceptingEvents = true;
    let eventLimitExceeded = false;
    const runPromise = this.options.agent.run({
      runId,
      threadId,
      turnId,
      workItemId,
      planRevision: node.current_plan_revision,
      nodeId: node.node_id,
      cwd: worktree.path,
      objective: node.objective,
      instructions: node.instructions,
      inputEvidence: parseStrings(node.input_evidence_json),
      readScope: parseStrings(node.read_scope_json),
      writeScope: parseStrings(node.write_scope_json),
      denyScope: parseStrings(node.deny_scope_json),
      expectedArtifacts: parseStrings(node.expected_artifacts_json),
      completionDefinition: node.completion_definition,
      environment: worktree.environment,
      capabilities: {
        network: false,
        dependencyInstallation: false,
        arbitraryCommands: false,
        gitCommit: false,
      },
      sandbox: {
        filesystemRoot: worktree.path,
        readOnlyPaths: [repository],
        denyGitMetadata: true,
        network: "deny",
      },
      signal: controller.signal,
      emit: (event) => {
        if (!acceptingEvents || !eventBelongsToRun(event, { threadId, turnId })) return;
        const bytes = Buffer.byteLength(event.message, "utf8");
        if (eventBytes + bytes > this.options.limits.maxAgentEventBytes) {
          eventLimitExceeded = true;
          controller.abort(new Error("Agent event output limit exceeded"));
          return;
        }
        eventBytes += bytes;
        eventSequence += 1;
        this.database
          .prepare(
            "INSERT INTO collaboration_run_events (run_id, sequence, event_type, message, created_at) " +
              "VALUES (?, ?, ?, ?, ?)",
          )
          .run(runId, eventSequence, event.type, event.message, Date.now());
      },
    });

    const timeoutMarker = Symbol("timeout");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<typeof timeoutMarker>((resolve) => {
      timer = setTimeout(() => {
        controller.abort(new Error("Agent run timed out"));
        resolve(timeoutMarker);
      }, this.options.limits.agentTimeoutMs);
      timer.unref?.();
    });
    let result: AgentRunResult | null = null;
    const settled = await Promise.race([runPromise, timeout]);
    const timedOut = settled === timeoutMarker;
    if (timer) clearTimeout(timer);
    if (timedOut || eventLimitExceeded) {
      await this.options.agent.interrupt(runId);
      await Promise.race([
        runPromise.catch(() => null),
        new Promise((resolve) => setTimeout(resolve, this.options.limits.interruptGraceMs)),
      ]);
    } else {
      result = settled as AgentRunResult;
    }
    acceptingEvents = false;

    if (timedOut) {
      return this.finalizeWithoutCandidate(runId, workItemId, node, worktree, "timed_out", ["agent_timeout"], now);
    }
    if (eventLimitExceeded) {
      return this.finalizeWithoutCandidate(runId, workItemId, node, worktree, "invalid", ["agent_output_limit"], now);
    }
    if (!result || result.threadId !== threadId || result.turnId !== turnId) {
      return this.finalizeWithoutCandidate(runId, workItemId, node, worktree, "invalid", ["provider_identity_mismatch"], now);
    }
    if (!result.sandboxEnforced) {
      return this.finalizeWithoutCandidate(
        runId,
        workItemId,
        node,
        worktree,
        "needs_configuration",
        ["provider_sandbox_unavailable"],
        now,
      );
    }
    if (result.status === "needs_configuration" || result.need) {
      return this.finalizeWithoutCandidate(
        runId,
        workItemId,
        node,
        worktree,
        "needs_configuration",
        [result.need ?? "provider_configuration"],
        now,
      );
    }
    if (result.status !== "completed") {
      return this.finalizeWithoutCandidate(runId, workItemId, node, worktree, "failed", [result.message ?? "agent_failed"], now);
    }

    await this.worktrees.assertOriginalUnchanged(worktree);
    if ((await this.worktrees.currentHead(worktree)) !== worktree.baseSha) {
      return this.finalizeWithoutCandidate(runId, workItemId, node, worktree, "invalid", ["unexpected_agent_commit"], now);
    }
    const changedPaths = await this.worktrees.changedPaths(worktree);
    const mandatoryDeny = [".env", ".env*", "**/.env*", ".git", ".git/**", ...parseStrings(node.deny_scope_json)];
    const diff = this.worktrees.validateDiff(worktree, changedPaths, parseStrings(node.write_scope_json), mandatoryDeny);
    if (!changedPaths.length) diff.violations.push("no_changes");
    if (diff.violations.length) {
      return this.finalizeWithoutCandidate(runId, workItemId, node, worktree, "invalid", diff.violations, now, changedPaths);
    }
    if (!this.isCurrentNode(workItemId, node.current_plan_revision, node.node_id)) {
      return this.finalizeWithoutCandidate(runId, workItemId, node, worktree, "invalid", ["plan_superseded"], now, changedPaths);
    }
    appendExecutionAudit(this.database, {
      runId,
      action: "candidate.commit_authorized",
      outcome: "allow",
      resource: { baseSha: worktree.baseSha, changedPaths },
      now: Date.now(),
    });
    const resultSha = await this.worktrees.commitCandidate(worktree, {
      workItemId,
      planRevision: node.current_plan_revision,
      nodeId: node.node_id,
      runId,
    });

    let testEvidence: TestEvidence[] = [];
    let report: CandidateStatusReport;
    try {
      const tests = await runTargetTests({
        worktree: worktree.path,
        environment: worktree.environment,
        commandIds: parseStrings(node.target_commands_json),
        commands: configured.targetCommands,
        runner: this.options.commandRunner,
        deniedPaths: [worktree.commonGitDir, worktree.repository, this.serviceDataDirectory],
      });
      testEvidence = tests.evidence;
      report = tests.configurationProblems.length
        ? renderCandidateStatus({ modified: true, needsConfiguration: tests.configurationProblems })
        : renderCandidateStatus({ modified: true, evidence: testEvidence });
    } catch (error) {
      report = renderCandidateStatus({ modified: true, needsConfiguration: [errorMessage(error)] });
    }
    if ((await this.worktrees.currentHead(worktree)) !== resultSha || (await this.worktrees.status(worktree)).length) {
      report = renderCandidateStatus({ modified: true, violations: ["test_modified_candidate"] });
    }
    await this.worktrees.assertOriginalUnchanged(worktree);
    if (!this.isCurrentNode(workItemId, node.current_plan_revision, node.node_id)) {
      report = renderCandidateStatus({ modified: true, violations: ["plan_superseded"] });
    }
    return this.finalizeCandidate(runId, workItemId, node, worktree, resultSha, changedPaths, report, testEvidence, now);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  private loadModifyNode(workItemId: string): NodeRow {
    const row = this.database
      .prepare(
        "SELECT n.node_id, n.assigned_agent_id, n.objective, n.input_evidence_json, n.instructions, " +
          "n.read_scope_json, n.write_scope_json, n.deny_scope_json, n.commands_json, n.expected_artifacts_json, " +
          "n.completion_definition, n.budget_json, s.repository, w.current_plan_revision, " +
          "(SELECT v.commands_json FROM collaboration_work_nodes v " +
          " WHERE v.work_item_id = w.id AND v.plan_revision = p.revision AND v.node_type = 'validate' AND v.active = 1) " +
          "AS target_commands_json " +
          "FROM collaboration_work_items w " +
          "JOIN collaboration_plan_revisions p ON p.work_item_id = w.id AND p.revision = w.current_plan_revision " +
          "JOIN collaboration_work_item_snapshots s ON s.work_item_id = w.id AND s.revision = p.snapshot_revision " +
          "JOIN collaboration_work_nodes n ON n.work_item_id = w.id AND n.plan_revision = p.revision " +
          "WHERE w.id = ? AND w.definition_status = 'ready_for_execution' AND n.node_type = 'modify' AND n.active = 1",
      )
      .get(workItemId) as NodeRow | undefined;
    if (!row?.repository) throw new Error("Work Item has no current executable modify node");
    return row;
  }

  private isCurrentNode(workItemId: string, planRevision: number, nodeId: string): boolean {
    return Boolean(
      this.database
        .prepare(
          "SELECT 1 FROM collaboration_work_items w JOIN collaboration_work_nodes n " +
            "ON n.work_item_id = w.id AND n.plan_revision = w.current_plan_revision " +
            "WHERE w.id = ? AND w.current_plan_revision = ? AND n.node_id = ? AND n.active = 1",
        )
        .get(workItemId, planRevision, nodeId),
    );
  }

  private startRun(input: {
    runId: string;
    workItemId: string;
    attempt: number;
    node: NodeRow;
    threadId: string;
    turnId: string;
    worktree: ManagedWorktree;
    now: number;
  }): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (!this.isCurrentNode(input.workItemId, input.node.current_plan_revision, input.node.node_id)) {
        throw new Error("Plan changed before execution started");
      }
      this.database
        .prepare(
          "INSERT INTO collaboration_runs " +
            "(id, work_item_id, plan_revision, node_id, attempt, agent_id, thread_id, turn_id, status, repository_path, " +
            "worktree_path, branch, base_sha, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?)",
        )
        .run(
          input.runId,
          input.workItemId,
          input.node.current_plan_revision,
          input.node.node_id,
          input.attempt,
          input.node.assigned_agent_id,
          input.threadId,
          input.turnId,
          input.worktree.repository,
          input.worktree.path,
          input.worktree.branch,
          input.worktree.baseSha,
          input.now,
        );
      this.database
        .prepare(
          "UPDATE collaboration_work_nodes SET execution_status = CASE " +
            "WHEN node_type = 'analyze' THEN 'candidate_ready' WHEN node_type = 'modify' THEN 'running' " +
            "ELSE execution_status END WHERE work_item_id = ? AND plan_revision = ? AND active = 1",
        )
        .run(input.workItemId, input.node.current_plan_revision);
      appendExecutionAudit(this.database, {
        runId: input.runId,
        action: "run.started",
        outcome: "running",
        resource: { baseSha: input.worktree.baseSha, branch: input.worktree.branch },
        now: input.now,
      });
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private finalizeWithoutCandidate(
    runId: string,
    workItemId: string,
    node: NodeRow,
    worktree: ManagedWorktree,
    runStatus: "failed" | "invalid" | "needs_configuration" | "timed_out",
    violations: string[],
    now: number,
    changedPaths: string[] = [],
  ): CandidateExecutionOutcome {
    const report =
      runStatus === "needs_configuration"
        ? renderCandidateStatus({ modified: changedPaths.length > 0, needsConfiguration: violations })
        : renderCandidateStatus({ modified: changedPaths.length > 0, violations });
    return this.finalizeCandidate(runId, workItemId, node, worktree, null, changedPaths, report, [], now, runStatus);
  }

  private finalizeCandidate(
    runId: string,
    workItemId: string,
    node: NodeRow,
    worktree: ManagedWorktree,
    resultSha: string | null,
    changedPaths: string[],
    report: CandidateStatusReport,
    evidence: TestEvidence[],
    now: number,
    explicitRunStatus?: "failed" | "invalid" | "needs_configuration" | "timed_out",
  ): CandidateExecutionOutcome {
    const runStatus = explicitRunStatus ?? (report.state === "invalid" ? "invalid" : report.state === "needs_configuration" ? "needs_configuration" : "succeeded");
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database
        .prepare("UPDATE collaboration_runs SET status = ?, result_sha = ?, finished_at = ?, error = ? WHERE id = ?")
        .run(runStatus, resultSha, Date.now(), report.reasons.join("; ") || null, runId);
      this.database
        .prepare(
          "INSERT INTO collaboration_candidates " +
            "(id, run_id, state, base_sha, result_sha, changed_paths_json, violations_json, quality_json, created_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          randomUUID(),
          runId,
          report.state,
          worktree.baseSha,
          resultSha,
          JSON.stringify(changedPaths),
          JSON.stringify(report.reasons),
          JSON.stringify(report),
          now,
        );
      const insertEvidence = this.database.prepare(
        "INSERT INTO collaboration_test_evidence " +
          "(id, run_id, command_id, argv_json, cwd, exit_code, duration_ms, stdout, stderr, state, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      for (const item of evidence) {
        insertEvidence.run(
          randomUUID(),
          runId,
          item.commandId,
          JSON.stringify(item.argv),
          item.cwd,
          item.exitCode,
          item.durationMs,
          item.stdout,
          item.stderr,
          item.state,
          now,
        );
      }
      const executionStatus = report.state === "invalid" ? "invalid" : report.state === "needs_configuration" ? "needs_configuration" : "candidate_ready";
      this.database
        .prepare(
          "UPDATE collaboration_work_nodes SET execution_status = CASE " +
            "WHEN node_type IN ('modify', 'validate', 'report') THEN ? ELSE execution_status END " +
            "WHERE work_item_id = ? AND plan_revision = ? AND active = 1",
        )
        .run(executionStatus, workItemId, node.current_plan_revision);
      appendExecutionAudit(this.database, {
        runId,
        action: "candidate.finalized",
        outcome: report.state,
        resource: { baseSha: worktree.baseSha, resultSha, quality: report.state },
        now,
      });
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return {
      runId,
      workItemId,
      planRevision: node.current_plan_revision,
      nodeId: node.node_id,
      baseSha: worktree.baseSha,
      resultSha,
      branch: worktree.branch,
      worktreePath: worktree.path,
      changedPaths,
      report,
      evidence,
    };
  }
}
