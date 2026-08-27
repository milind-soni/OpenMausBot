import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { isolatedExecutionEnvironment, runArgv, type ArgvResult } from "./execution-limits.ts";

const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

export interface ManagedWorktree {
  repository: string;
  path: string;
  branch: string;
  baseSha: string;
  originalHead: string;
  originalStatus: Buffer;
  gitMetadata: Buffer;
  environment: NodeJS.ProcessEnv;
}

export interface DiffValidation {
  changedPaths: string[];
  violations: string[];
}

function contained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function component(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9-]+/gu, "-").replace(/^-+|-+$/gu, "");
  if (!normalized) throw new Error("Generated worktree component is empty");
  const hash = createHash("sha256").update(value).digest("hex").slice(0, 8);
  return `${normalized.slice(0, 48)}-${hash}`;
}

function decodeNulPaths(buffer: Buffer): string[] {
  const paths: string[] = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0) continue;
    const bytes = buffer.subarray(start, index);
    start = index + 1;
    if (!bytes.length) continue;
    const value = bytes.toString("utf8");
    if (!Buffer.from(value, "utf8").equals(bytes)) throw new Error("Git path is not valid UTF-8");
    paths.push(value);
  }
  if (start !== buffer.length) throw new Error("Git returned a non-NUL-terminated path list");
  return paths;
}

function globPattern(pattern: string): RegExp {
  let expression = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*" && pattern[index + 1] === "*") {
      if (pattern[index + 2] === "/") {
        expression += "(?:[\\s\\S]*/)?";
        index += 2;
      } else {
        expression += "[\\s\\S]*";
        index += 1;
      }
    } else if (char === "*") {
      expression += "[^/]*";
    } else if (char === "?") {
      expression += "[^/]";
    } else {
      expression += char.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&");
    }
  }
  return new RegExp(`${expression}$`, "u");
}

function matches(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => globPattern(pattern).test(path));
}

async function git(cwd: string, environment: NodeJS.ProcessEnv, args: readonly string[], timeoutMs = 15_000): Promise<ArgvResult> {
  const result = await runArgv(
    { argv: ["git", ...args], timeoutMs, maxOutputBytes: 4 * 1024 * 1024 },
    { cwd, env: environment },
  );
  if (result.timedOut || result.outputLimitExceeded || result.exitCode !== 0) {
    throw new Error(`git ${args[0] ?? "command"} failed: ${result.stderr.toString("utf8").slice(0, 500)}`);
  }
  return result;
}

export class WorktreeManager {
  readonly root: string;
  readonly environment: NodeJS.ProcessEnv;

  constructor(root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.root = realpathSync(root);
    const home = resolve(this.root, ".execution-home");
    mkdirSync(home, { recursive: true, mode: 0o700 });
    this.environment = isolatedExecutionEnvironment(process.env, home);
  }

  async prepare(input: {
    repository: string;
    workItemId: string;
    nodeId: string;
    attempt: number;
    expectedBaseSha?: string;
  }): Promise<ManagedWorktree> {
    const repository = realpathSync(input.repository);
    const topLevel = (await git(repository, this.environment, ["rev-parse", "--show-toplevel"]))
      .stdout.toString("utf8")
      .trim();
    if (realpathSync(topLevel) !== repository) throw new Error("Configured repository must be the Git top-level");
    const unsafeConfig = await runArgv(
      {
        argv: [
          "git",
          "config",
          "--local",
          "--name-only",
          "--get-regexp",
          "^(filter\\..*\\.(clean|smudge|process|required)|core\\.(fsmonitor|hooksPath))$",
        ],
        timeoutMs: 5_000,
        maxOutputBytes: 64 * 1024,
      },
      { cwd: repository, env: this.environment },
    );
    if (unsafeConfig.exitCode === 0 && unsafeConfig.stdout.length) {
      throw new Error(`Repository has executable Git configuration: ${unsafeConfig.stdout.toString("utf8").trim()}`);
    }
    if (unsafeConfig.exitCode !== 0 && unsafeConfig.exitCode !== 1) throw new Error("Unable to inspect repository Git config");
    const branch = `ai/${component(input.workItemId)}/${component(input.nodeId)}/a${input.attempt}`;
    const path = resolve(
      this.root,
      component(input.workItemId),
      component(input.nodeId),
      `a${input.attempt}`,
    );
    if (!contained(this.root, path)) throw new Error("Managed worktree path escaped its root");
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const originalHead = (await git(repository, this.environment, ["rev-parse", "--verify", "HEAD^{commit}"]))
      .stdout.toString("utf8")
      .trim();
    if (!FULL_SHA.test(originalHead)) throw new Error("Repository HEAD is not a full commit SHA");
    if (input.expectedBaseSha && (!FULL_SHA.test(input.expectedBaseSha) || input.expectedBaseSha !== originalHead)) {
      throw new Error("Repository HEAD does not match the locked base SHA");
    }
    const originalStatus = (await git(repository, this.environment, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]))
      .stdout;
    await git(repository, this.environment, [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgSign=false",
      "worktree",
      "add",
      "--no-track",
      "-b",
      branch,
      path,
      originalHead,
    ]);
    const canonicalPath = realpathSync(path);
    if (!contained(this.root, canonicalPath)) throw new Error("Created worktree escaped its managed root");
    return {
      repository,
      path: canonicalPath,
      branch,
      baseSha: originalHead,
      originalHead,
      originalStatus,
      gitMetadata: readFileSync(resolve(canonicalPath, ".git")),
      environment: this.environment,
    };
  }

  async currentHead(worktree: ManagedWorktree): Promise<string> {
    const sha = (await git(worktree.path, worktree.environment, ["rev-parse", "--verify", "HEAD^{commit}"]))
      .stdout.toString("utf8")
      .trim();
    if (!FULL_SHA.test(sha)) throw new Error("Worktree HEAD is not a full commit SHA");
    return sha;
  }

  async changedPaths(worktree: ManagedWorktree): Promise<string[]> {
    const tracked = await git(worktree.path, worktree.environment, [
      "diff",
      "--name-only",
      "--no-renames",
      "-z",
      worktree.baseSha,
      "--",
    ]);
    const untracked = await git(worktree.path, worktree.environment, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ]);
    const ignored = await git(worktree.path, worktree.environment, [
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "-z",
    ]);
    return [
      ...new Set([...decodeNulPaths(tracked.stdout), ...decodeNulPaths(untracked.stdout), ...decodeNulPaths(ignored.stdout)]),
    ].sort();
  }

  validateDiff(worktree: ManagedWorktree, changedPaths: readonly string[], claims: readonly string[], deny: readonly string[]): DiffValidation {
    const violations: string[] = [];
    for (const path of changedPaths) {
      if (isAbsolute(path) || path.split("/").includes("..") || path.includes("\0")) {
        violations.push(`${path}: invalid_path`);
        continue;
      }
      if (matches(path, deny)) violations.push(`${path}: denied_path`);
      if (!matches(path, claims)) violations.push(`${path}: outside_claim`);
      const absolute = resolve(worktree.path, path);
      if (!contained(worktree.path, absolute)) {
        violations.push(`${path}: escaped_worktree`);
        continue;
      }
      try {
        if (lstatSync(absolute).isSymbolicLink()) {
          violations.push(`${path}: symlink_change_not_allowed`);
          continue;
        }
        const parent = realpathSync(dirname(absolute));
        if (!contained(worktree.path, parent)) violations.push(`${path}: parent_escaped_worktree`);
      } catch {
        // Deleted paths have no filesystem object; lexical containment above
        // and Git's NUL-safe path source are the relevant checks.
      }
    }
    return { changedPaths: [...changedPaths], violations };
  }

  async commitCandidate(
    worktree: ManagedWorktree,
    trace: { workItemId: string; planRevision: number; nodeId: string; runId: string },
  ): Promise<string> {
    if (!readFileSync(resolve(worktree.path, ".git")).equals(worktree.gitMetadata)) {
      throw new Error("Worktree Git metadata was modified by the Agent");
    }
    if ((await this.currentHead(worktree)) !== worktree.baseSha) {
      throw new Error("Agent created an unexpected commit");
    }
    await git(worktree.path, worktree.environment, ["add", "--all", "--", "."]);
    const message = [
      `AI candidate for ${trace.workItemId}`,
      "",
      `Work-Item: ${trace.workItemId}`,
      `Plan-Revision: ${trace.planRevision}`,
      `Node: ${trace.nodeId}`,
      `Run: ${trace.runId}`,
      `Base-SHA: ${worktree.baseSha}`,
    ].join("\n");
    await git(worktree.path, worktree.environment, [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgSign=false",
      "-c",
      "user.name=OpenMausBot",
      "-c",
      "user.email=bot@local.invalid",
      "commit",
      "--no-verify",
      "--no-gpg-sign",
      "-m",
      message,
    ]);
    const resultSha = await this.currentHead(worktree);
    if (resultSha === worktree.baseSha) throw new Error("Candidate commit did not advance HEAD");
    const parents = (await git(worktree.path, worktree.environment, ["rev-list", "--parents", "-n", "1", resultSha]))
      .stdout.toString("utf8")
      .trim()
      .split(/\s+/u);
    if (parents.length !== 2 || parents[1] !== worktree.baseSha) {
      throw new Error("Candidate commit must have exactly the locked base as its parent");
    }
    return resultSha;
  }

  async assertOriginalUnchanged(worktree: ManagedWorktree): Promise<void> {
    const head = (await git(worktree.repository, worktree.environment, ["rev-parse", "--verify", "HEAD^{commit}"]))
      .stdout.toString("utf8")
      .trim();
    const status = (await git(worktree.repository, worktree.environment, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ])).stdout;
    if (head !== worktree.originalHead || !status.equals(worktree.originalStatus)) {
      throw new Error("Original repository worktree or index changed during execution");
    }
  }

  async status(worktree: ManagedWorktree): Promise<Buffer> {
    return (
      await git(worktree.path, worktree.environment, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])
    ).stdout;
  }
}
