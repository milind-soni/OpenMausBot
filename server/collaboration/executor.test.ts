import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { FakeDingTalkAdapter } from "../integrations/dingtalk/fake-adapter.ts";
import type { DingTalkInboundMessage } from "../integrations/dingtalk/types.ts";
import { policy, validProposal } from "./planner.test-fixtures.ts";
import type { AgentRunPort, AgentRunRequest, AgentRunResult } from "./provider-runner.ts";
import type { TargetCommandSpec } from "./quality-gate.ts";
import { startCollaborationService } from "./service.ts";

const scratch: string[] = [];

afterEach(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temp(): string {
  const directory = mkdtempSync(join(tmpdir(), "openmausbot-candidate-"));
  scratch.push(directory);
  return directory;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function repository(root: string): string {
  const repo = join(root, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  git(root, ["init", "-b", "main", repo]);
  writeFileSync(join(repo, ".gitignore"), ".env*\n");
  writeFileSync(join(repo, "src", "value.txt"), "before\n");
  git(repo, ["add", "."]);
  git(repo, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "base"]);
  return repo;
}

function inbound(): DingTalkInboundMessage {
  return {
    sourceEventId: "candidate-event-1",
    transportMessageId: "candidate-transport-1",
    conversationId: "candidate-conversation-1",
    addressedToBot: true,
    text: "更新 fixture value",
    sender: {
      senderCorpId: "corp-1",
      senderStaffId: "staff-1",
      senderId: "sender-1",
      displayName: "Contributor",
    },
    receivedAt: 1_000,
  };
}

class FakeAgent implements AgentRunPort {
  interrupted: string[] = [];

  constructor(private readonly operation: (request: AgentRunRequest) => Promise<AgentRunResult> | AgentRunResult) {}

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    return await this.operation(request);
  }

  async interrupt(runId: string): Promise<void> {
    this.interrupted.push(runId);
  }
}

function completed(request: AgentRunRequest): AgentRunResult {
  return { threadId: request.threadId, turnId: request.turnId, status: "completed", sandboxEnforced: true };
}

function targetCommand(exitCode = 0): TargetCommandSpec {
  return {
    argv: [
      process.execPath,
      "-e",
      exitCode === 0
        ? "const fs=require('fs');process.exit(fs.readFileSync('src/value.txt','utf8')==='after\\n'?0:2)"
        : `process.exit(${exitCode})`,
    ],
    timeoutMs: 5_000,
    maxOutputBytes: 32_000,
  };
}

function setup(input: { agent: AgentRunPort; commands?: Record<string, TargetCommandSpec> }) {
  const root = temp();
  const repo = repository(root);
  const baseSha = git(repo, ["rev-parse", "HEAD"]);
  writeFileSync(join(repo, "local-notes.txt"), "original untracked sentinel\n");
  const originalStatus = execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: repo });
  const service = startCollaborationService({
    dataDirectory: join(root, "data"),
    planning: {
      planner: { propose: () => validProposal() },
      policy: { ...policy, allowedRepositories: [repo] },
    },
    execution: {
      agent: input.agent,
      managedWorktreeRoot: join(root, "managed-worktrees"),
      repositories: {
        [repo]: { baseSha, targetCommands: input.commands ?? { "pnpm test target": targetCommand() } },
      },
      limits: { maxAttempts: 1, agentTimeoutMs: 2_000, maxAgentEventBytes: 16_000, interruptGraceMs: 500 },
    },
  });
  const accepted = new FakeDingTalkAdapter((event) => service.ingestDingTalkMessage(event)).receive(inbound());
  if (!accepted.accepted || !accepted.workItemId) throw new Error("Expected Work Item");
  service.reviseWorkItemDefinition(
    accepted.workItemId,
    {
      goal: "将 fixture value 更新为 after",
      goalConfirmed: true,
      repository: repo,
      acceptanceConditions: [{ description: "value 已更新", observation: "target command 读取 after" }],
      blockingAmbiguities: [],
    },
    2_000,
  );
  return { root, repo, baseSha, originalStatus, service, workItemId: accepted.workItemId };
}

function ledger(root: string): DatabaseSync {
  return new DatabaseSync(join(root, "data", "collaboration", "collaboration.sqlite"));
}

describe("trusted candidate executor", () => {
  it("creates a traceable local candidate and exact target-test evidence without touching the original worktree", async () => {
    const agent = new FakeAgent((request) => {
      expect(request.capabilities).toEqual({
        network: false,
        dependencyInstallation: false,
        arbitraryCommands: false,
        gitCommit: false,
      });
      expect(request.sandbox).toMatchObject({ filesystemRoot: request.cwd, denyGitMetadata: true, network: "deny" });
      request.emit({ threadId: "late-thread", turnId: request.turnId, type: "progress", message: "ignore me" });
      request.emit({ threadId: request.threadId, turnId: request.turnId, type: "progress", message: "editing" });
      writeFileSync(join(request.cwd, "src", "value.txt"), "after\n");
      return completed(request);
    });
    const harness = setup({ agent });
    const result = await harness.service.executeCurrentPlan(harness.workItemId, 1, 3_000);
    expect(result).toMatchObject({
      workItemId: harness.workItemId,
      baseSha: harness.baseSha,
      changedPaths: ["src/value.txt"],
      report: {
        state: "target_tests_passed",
        targetTestsPassed: true,
        fullGatePassed: false,
        label: "目标测试通过；完整门禁未执行",
      },
    });
    expect(result.resultSha).toMatch(/^[0-9a-f]{40}$/u);
    expect(git(harness.repo, ["rev-parse", "HEAD"])).toBe(harness.baseSha);
    expect(execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: harness.repo })).toEqual(
      harness.originalStatus,
    );
    expect(readFileSync(join(harness.repo, "local-notes.txt"), "utf8")).toBe("original untracked sentinel\n");
    expect(git(result.worktreePath, ["show", "-s", "--format=%an <%ae>", result.resultSha!])).toBe(
      "OpenMausBot <bot@local.invalid>",
    );
    const body = git(result.worktreePath, ["show", "-s", "--format=%B", result.resultSha!]);
    expect(body).toContain(`Work-Item: ${harness.workItemId}`);
    expect(body).toContain(`Base-SHA: ${harness.baseSha}`);
    expect(git(result.worktreePath, ["rev-parse", `${result.resultSha}^`])).toBe(harness.baseSha);
    harness.service.close();

    const db = ledger(harness.root);
    expect(db.prepare("SELECT base_sha, result_sha, status FROM collaboration_runs").get()).toEqual({
      base_sha: harness.baseSha,
      result_sha: result.resultSha,
      status: "succeeded",
    });
    expect(db.prepare("SELECT state, exit_code FROM collaboration_test_evidence").get()).toEqual({
      state: "target_passed",
      exit_code: 0,
    });
    expect(db.prepare("SELECT count(*) AS count FROM collaboration_run_events").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT count(*) AS count FROM collaboration_audit_events").get()).toEqual({ count: 3 });
    expect(() => db.prepare("UPDATE collaboration_candidates SET state = 'invalid'").run()).toThrow(
      "candidate attempts are immutable",
    );
    expect(() => db.prepare("DELETE FROM collaboration_test_evidence").run()).toThrow("test evidence is immutable");
    db.close();
  });

  it("rejects ignored denied files before creating a commit", async () => {
    const agent = new FakeAgent((request) => {
      writeFileSync(join(request.cwd, ".env.secret"), "do-not-commit\n");
      return completed(request);
    });
    const harness = setup({ agent });
    const result = await harness.service.executeCurrentPlan(harness.workItemId);
    expect(result).toMatchObject({ resultSha: null, report: { state: "invalid" } });
    expect(result.report.reasons.join(" ")).toMatch(/denied_path|outside_claim/u);
    expect(git(result.worktreePath, ["rev-parse", "HEAD"])).toBe(harness.baseSha);
    expect(readFileSync(join(result.worktreePath, ".env.secret"), "utf8")).toBe("do-not-commit\n");
    harness.service.close();
  });

  it("rejects out-of-claim changes and unexpected Agent commits", async () => {
    const outside = new FakeAgent((request) => {
      mkdirSync(join(request.cwd, "docs"));
      writeFileSync(join(request.cwd, "docs", "outside.md"), "outside\n");
      return completed(request);
    });
    const first = setup({ agent: outside });
    const rejected = await first.service.executeCurrentPlan(first.workItemId);
    expect(rejected.report.reasons).toContain("docs/outside.md: outside_claim");
    first.service.close();

    const committing = new FakeAgent((request) => {
      writeFileSync(join(request.cwd, "src", "value.txt"), "after\n");
      git(request.cwd, ["add", "."]);
      git(request.cwd, ["-c", "user.name=Bad", "-c", "user.email=bad@example.invalid", "commit", "-m", "agent commit"]);
      return completed(request);
    });
    const second = setup({ agent: committing });
    const unexpected = await second.service.executeCurrentPlan(second.workItemId);
    expect(unexpected).toMatchObject({ resultSha: null, report: { state: "invalid" } });
    expect(unexpected.report.reasons).toContain("unexpected_agent_commit");
    second.service.close();
  });

  it("preserves candidate but reports target failure without claiming a full gate", async () => {
    const agent = new FakeAgent((request) => {
      writeFileSync(join(request.cwd, "src", "value.txt"), "after\n");
      return completed(request);
    });
    const harness = setup({ agent, commands: { "pnpm test target": targetCommand(7) } });
    const result = await harness.service.executeCurrentPlan(harness.workItemId);
    expect(result.resultSha).not.toBeNull();
    expect(result.report).toMatchObject({ state: "test_failed", targetTestsPassed: false, fullGatePassed: false });
    expect(result.evidence[0]).toMatchObject({ state: "failed", exitCode: 7 });
    harness.service.close();
  });

  it("stops for configuration when network, install, sandbox, or command configuration is unavailable", async () => {
    const network = new FakeAgent((request) => ({
      threadId: request.threadId,
      turnId: request.turnId,
      status: "needs_configuration",
      need: "network",
      sandboxEnforced: true,
    }));
    const first = setup({ agent: network });
    expect(await first.service.executeCurrentPlan(first.workItemId)).toMatchObject({
      resultSha: null,
      report: { state: "needs_configuration", reasons: ["network"] },
    });
    first.service.close();

    const edit = new FakeAgent((request) => {
      writeFileSync(join(request.cwd, "src", "value.txt"), "after\n");
      return completed(request);
    });
    const second = setup({ agent: edit, commands: {} });
    const missing = await second.service.executeCurrentPlan(second.workItemId);
    expect(missing.resultSha).not.toBeNull();
    expect(missing.report).toMatchObject({ state: "needs_configuration" });
    expect(missing.report.reasons).toContain("missing command: pnpm test target");
    second.service.close();
  });

  it("times out, interrupts, and does not inspect or commit a still-running Agent", async () => {
    let resolveRun: ((result: AgentRunResult) => void) | undefined;
    let captured: AgentRunRequest | undefined;
    const agent = new FakeAgent(
      (request) =>
        new Promise<AgentRunResult>((resolve) => {
          captured = request;
          resolveRun = resolve;
        }),
    );
    const harness = setup({ agent });
    const outcome = await harness.service.executeCurrentPlan(harness.workItemId);
    expect(outcome).toMatchObject({ resultSha: null, report: { state: "invalid", reasons: ["agent_timeout"] } });
    expect(agent.interrupted).toEqual([outcome.runId]);
    if (captured && resolveRun) resolveRun(completed(captured));
    harness.service.close();
  }, 10_000);

  it("fences a candidate when a newer plan becomes current during the Agent run", async () => {
    let harness: ReturnType<typeof setup>;
    const agent = new FakeAgent((request) => {
      writeFileSync(join(request.cwd, "src", "value.txt"), "after\n");
      harness.service.reviseWorkItemDefinition(
        harness.workItemId,
        { goal: "a newer incompatible goal", goalConfirmed: true },
        4_000,
      );
      return completed(request);
    });
    harness = setup({ agent });
    const result = await harness.service.executeCurrentPlan(harness.workItemId);
    expect(result).toMatchObject({ resultSha: null, report: { state: "invalid", reasons: ["plan_superseded"] } });
    harness.service.close();
    const db = ledger(harness.root);
    expect(db.prepare("SELECT current_plan_revision FROM collaboration_work_items").get()).toEqual({
      current_plan_revision: 2,
    });
    expect(db.prepare("SELECT status FROM collaboration_runs").get()).toEqual({ status: "invalid" });
    db.close();
  });
});
