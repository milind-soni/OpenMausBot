import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { runArgv, type ArgvResult } from "./execution-limits.ts";

export interface TargetCommandSpec {
  argv: readonly [string, ...string[]];
  cwd?: string;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface TestEvidence {
  commandId: string;
  argv: string[];
  cwd: string;
  exitCode: number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  state: "target_passed" | "failed" | "timeout" | "output_limit";
}

export type CandidateQualityState =
  | "modified"
  | "target_tests_passed"
  | "test_failed"
  | "not_verified"
  | "invalid"
  | "needs_configuration";

export interface CandidateStatusReport {
  state: CandidateQualityState;
  modified: boolean;
  targetTestsPassed: boolean;
  fullGatePassed: false;
  label: string;
  reasons: string[];
}

const PACKAGE_MANAGERS = new Set(["npm", "npm.cmd", "pnpm", "pnpm.cmd", "yarn", "yarn.cmd", "bun"]);
const NETWORK_TOOLS = new Set(["curl", "wget", "ssh", "scp", "rsync"]);

function contained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

export function validateTargetCommandSpec(commandId: string, spec: TargetCommandSpec): void {
  if (!commandId.trim()) throw new Error("Target command ID is required");
  const executable = spec.argv[0].split(/[\\/]/u).at(-1)?.toLowerCase() ?? "";
  const args = spec.argv.slice(1).map((value) => value.toLowerCase());
  if (NETWORK_TOOLS.has(executable)) throw new Error(`Target command ${commandId} enables network access`);
  if (PACKAGE_MANAGERS.has(executable) && args.some((arg) => ["install", "add", "update", "upgrade", "dlx"].includes(arg))) {
    throw new Error(`Target command ${commandId} installs dependencies`);
  }
  if (spec.cwd && isAbsolute(spec.cwd)) throw new Error(`Target command ${commandId} cwd must be relative`);
  if (spec.timeoutMs <= 0 || spec.maxOutputBytes <= 0) throw new Error(`Target command ${commandId} limits are invalid`);
}

function evidence(commandId: string, cwd: string, spec: TargetCommandSpec, result: ArgvResult): TestEvidence {
  return {
    commandId,
    argv: [...spec.argv],
    cwd,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    stdout: result.stdout.toString("utf8"),
    stderr: result.stderr.toString("utf8"),
    state: result.timedOut
      ? "timeout"
      : result.outputLimitExceeded
        ? "output_limit"
        : result.exitCode === 0
          ? "target_passed"
          : "failed",
  };
}

export async function runTargetTests(input: {
  worktree: string;
  environment: NodeJS.ProcessEnv;
  commandIds: readonly string[];
  commands: Readonly<Record<string, TargetCommandSpec>>;
}): Promise<{ evidence: TestEvidence[]; missingCommandIds: string[] }> {
  const root = realpathSync(input.worktree);
  const results: TestEvidence[] = [];
  const missingCommandIds: string[] = [];
  for (const commandId of input.commandIds) {
    const spec = input.commands[commandId];
    if (!spec) {
      missingCommandIds.push(commandId);
      continue;
    }
    validateTargetCommandSpec(commandId, spec);
    const cwd = realpathSync(resolve(root, spec.cwd ?? "."));
    if (!contained(root, cwd)) throw new Error(`Target command ${commandId} cwd escaped the worktree`);
    const result = await runArgv(
      { argv: spec.argv, timeoutMs: spec.timeoutMs, maxOutputBytes: spec.maxOutputBytes },
      { cwd, env: input.environment },
    );
    results.push(evidence(commandId, cwd, spec, result));
    if (results.at(-1)?.state !== "target_passed") break;
  }
  return { evidence: results, missingCommandIds };
}

export function renderCandidateStatus(input: {
  modified: boolean;
  violations?: readonly string[];
  needsConfiguration?: readonly string[];
  evidence?: readonly TestEvidence[];
}): CandidateStatusReport {
  if (input.violations?.length) {
    return {
      state: "invalid",
      modified: input.modified,
      targetTestsPassed: false,
      fullGatePassed: false,
      label: "候选无效",
      reasons: [...input.violations],
    };
  }
  if (input.needsConfiguration?.length) {
    return {
      state: "needs_configuration",
      modified: input.modified,
      targetTestsPassed: false,
      fullGatePassed: false,
      label: "需要配置",
      reasons: [...input.needsConfiguration],
    };
  }
  if (!input.evidence?.length) {
    return {
      state: input.modified ? "not_verified" : "modified",
      modified: input.modified,
      targetTestsPassed: false,
      fullGatePassed: false,
      label: input.modified ? "已修改，尚未验证" : "未生成修改",
      reasons: [],
    };
  }
  if (input.evidence.every((item) => item.state === "target_passed")) {
    return {
      state: "target_tests_passed",
      modified: input.modified,
      targetTestsPassed: true,
      fullGatePassed: false,
      label: "目标测试通过；完整门禁未执行",
      reasons: [],
    };
  }
  return {
    state: "test_failed",
    modified: input.modified,
    targetTestsPassed: false,
    fullGatePassed: false,
    label: "目标测试失败",
    reasons: input.evidence.filter((item) => item.state !== "target_passed").map((item) => `${item.commandId}: ${item.state}`),
  };
}
