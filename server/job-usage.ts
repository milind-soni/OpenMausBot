import type { JobAttemptUsage, JobUsageAttribution, JobUsageObservation, JobUsageSummary, JobUsageTotals, TokenObservation } from "../shared/job-usage.ts";
import { terminal, type Assignment } from "./runtime/types.ts";
import { readUsage, usageRowKey, type UsageRow } from "./usage-ledger.ts";

const measured = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const count = (value: unknown): number => measured(value) ? Math.trunc(value) : 0;
const nativeAttemptId = (assignment: Assignment, execution = assignment.executions): string => `native:${assignment.id}:${execution}`;

export function tokenObservation(tokens: { input?: number; output?: number; cachedInput?: number } | undefined): TokenObservation {
  return { input: measured(tokens?.input), output: measured(tokens?.output), cachedInput: measured(tokens?.cachedInput) };
}

export interface JobUsageTurnBinding {
  assignmentId: string;
  rootId: string;
  botId: string;
  threadId: string;
  generation?: string;
  turnId: string;
  attemptId: string;
  execution: number;
  office: boolean;
}

export function bindJobUsageTurn(assignment: Assignment | undefined, turn: { generation?: string; turnId?: string }): JobUsageTurnBinding | undefined {
  if (!assignment || !turn.turnId) return undefined;
  const office = assignment.office?.attempts.filter(attempt => attempt.generation === turn.generation && (attempt.state === "issued" || attempt.consumedAt !== undefined)
    && attempt.assignmentId === assignment.id && attempt.rootId === assignment.rootId && attempt.botId === assignment.assignee.botId
    && attempt.threadId === assignment.assignee.destination.threadId);
  if (assignment.office && office?.length !== 1) return undefined;
  if (!assignment.office && assignment.executions < 1) return undefined;
  return { rootId: assignment.rootId, assignmentId: assignment.id, botId: assignment.assignee.botId, threadId: assignment.assignee.destination.threadId,
    ...(turn.generation ? { generation: turn.generation } : {}), attemptId: office?.[0]?.attemptId ?? nativeAttemptId(assignment),
    turnId: turn.turnId, execution: assignment.executions, office: Boolean(assignment.office) };
}

export function completeJobUsageTurn(binding: JobUsageTurnBinding | undefined, assignment: Assignment | undefined): JobUsageAttribution | undefined {
  if (!binding || !assignment || assignment.id !== binding.assignmentId || assignment.rootId !== binding.rootId
    || assignment.assignee.botId !== binding.botId || assignment.assignee.destination.threadId !== binding.threadId) return undefined;
  if (binding.office) {
    const attempt = assignment.office?.attempts.find(attempt => attempt.attemptId === binding.attemptId);
    if (!attempt || attempt.consumedAt === undefined || attempt.generation !== binding.generation || attempt.assignmentId !== binding.assignmentId
      || attempt.rootId !== binding.rootId || attempt.botId !== binding.botId || attempt.threadId !== binding.threadId) return undefined;
  } else if (assignment.office || assignment.executions < binding.execution) return undefined;
  return { rootId: binding.rootId, assignmentId: binding.assignmentId, attemptId: binding.attemptId, turnId: binding.turnId };
}

export function attributionForJobTurn(assignment: Assignment | undefined, turn: { generation?: string; turnId?: string }): JobUsageAttribution | undefined {
  return completeJobUsageTurn(bindJobUsageTurn(assignment, turn), assignment);
}

function empty(): JobUsageTotals {
  return { turns: 0, input: 0, output: 0, cachedInput: 0, totalTokens: 0, unknownInputTurns: 0,
    unknownOutputTurns: 0, unknownCachedInputTurns: 0, reportedUsd: null, estimatedUsd: null, unknownCostTurns: 0 };
}

function add(total: JobUsageTotals, row: UsageRow): void {
  total.turns++;
  const observed = row.tokenObservation ?? tokenObservation(row);
  const input = observed.input && measured(row.input) ? count(row.input) : 0;
  const output = observed.output && measured(row.output) ? count(row.output) : 0;
  total.input += input;
  total.output += output;
  total.totalTokens += input + output;
  if (!observed.input || !measured(row.input)) total.unknownInputTurns++;
  if (!observed.output || !measured(row.output)) total.unknownOutputTurns++;
  if (observed.cachedInput && measured(row.cachedInput) && observed.input && measured(row.input)) {
    total.cachedInput += Math.min(input, count(row.cachedInput));
  } else total.unknownCachedInputTurns++;
  if (!measured(row.costUsd)) total.unknownCostTurns++;
  else if (row.costSource === "estimated") total.estimatedUsd = (total.estimatedUsd ?? 0) + row.costUsd;
  else total.reportedUsd = (total.reportedUsd ?? 0) + row.costUsd;
}

export function summarizeJobUsage(rootId: string, assignments: readonly Assignment[], rows: readonly UsageRow[]): JobUsageSummary {
  const nodes = new Map(assignments.filter(node => node.rootId === rootId).map(node => [node.id, node]));
  const attempts = new Map<string, JobAttemptUsage>();
  let untrackedExecutions = 0;
  for (const node of nodes.values()) {
    const identity = { assignmentId: node.id, botId: node.assignee.botId, threadId: node.assignee.destination.threadId,
      status: node.status, ...(node.outcome ? { outcome: node.outcome } : {}) };
    if (node.office) {
      untrackedExecutions += Math.max(0, node.executions - node.office.attempts.length);
      for (const attempt of node.office.attempts) {
        const started = attempt.consumedAt !== undefined;
        const pending = started && !terminal(node.status) && attempt.finishedAt === undefined && attempt.state !== "uncertain";
        attempts.set(attempt.attemptId, { ...empty(), ...identity, attemptId: attempt.attemptId,
          ...(started ? { startedAt: attempt.consumedAt } : {}), ...(attempt.finishedAt ? { finishedAt: attempt.finishedAt } : {}),
          state: started ? pending ? "pending" : "missing" : "not_started" });
      }
    } else {
      for (let execution = 1; execution <= node.executions; execution++) {
        const attemptId = nativeAttemptId(node, execution);
        attempts.set(attemptId, { ...empty(), ...identity, attemptId,
          ...(node.startedAt !== undefined ? { startedAt: node.startedAt } : {}),
          ...(node.finishedAt !== undefined ? { finishedAt: node.finishedAt } : {}),
          state: execution === node.executions && !terminal(node.status) ? "pending" : "missing" });
      }
    }
  }
  const total = empty();
  const observations: JobUsageObservation[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row.job || row.job.rootId !== rootId) continue;
    const node = nodes.get(row.job.assignmentId);
    const attempt = attempts.get(row.job.attemptId);
    if (!node || !attempt || attempt.assignmentId !== node.id || attempt.state === "not_started"
      || row.botId !== node.assignee.botId || row.threadId !== node.assignee.destination.threadId) continue;
    const key = usageRowKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    add(attempt, row);
    add(total, row);
    const observed = row.tokenObservation ?? tokenObservation(row);
    observations.push({ ...row.job, at: row.at, botId: row.botId, instanceId: row.instanceId, driverKind: row.driverKind, model: row.model,
      input: observed.input && measured(row.input) ? count(row.input) : null,
      output: observed.output && measured(row.output) ? count(row.output) : null,
      cachedInput: observed.cachedInput && observed.input && measured(row.input) && measured(row.cachedInput) ? Math.min(count(row.input), count(row.cachedInput)) : null,
      costUsd: measured(row.costUsd) ? row.costUsd : null,
      costSource: measured(row.costUsd) ? row.costSource === "estimated" ? "estimated" : "reported" : null });
    attempt.state = "observed";
  }
  const values = [...attempts.values()];
  const expected = values.filter(attempt => attempt.state !== "not_started");
  const missingAttempts = expected.filter(attempt => attempt.state === "missing").length;
  const pendingAttempts = expected.filter(attempt => attempt.state === "pending").length;
  const scopeComplete = nodes.has(rootId);
  const gaps = missingAttempts + untrackedExecutions + (scopeComplete ? 0 : 1);
  const tokens = gaps || pendingAttempts || total.unknownInputTurns || total.unknownOutputTurns || total.unknownCachedInputTurns ? "partial" : "complete";
  const costs = gaps || pendingAttempts || total.unknownCostTurns ? "partial" : "complete";
  const partial = gaps > 0 || total.unknownInputTurns > 0 || total.unknownOutputTurns > 0 || total.unknownCachedInputTurns > 0 || total.unknownCostTurns > 0;
  return { version: 1, rootId, total, assignments: nodes.size, attempts: values, observations,
    coverage: { state: partial ? "partial" : pendingAttempts ? "pending" : "complete",
      expectedAttempts: expected.length + untrackedExecutions, observedAttempts: expected.filter(attempt => attempt.turns > 0).length,
      missingAttempts, pendingAttempts, untrackedExecutions, scopeComplete, tokens, costs } };
}

export function readJobUsage(dataDir: string, assignments: readonly Assignment[], rootId: string, now = new Date()): JobUsageSummary {
  const relevant = assignments.filter(node => node.rootId === rootId);
  const earliest = Math.min(now.getTime(), ...relevant.map(node => node.createdAt));
  return summarizeJobUsage(rootId, relevant, readUsage(dataDir, { from: new Date(earliest), to: now }));
}
