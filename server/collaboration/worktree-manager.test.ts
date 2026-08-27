import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { WorktreeManager } from "./worktree-manager.ts";

const scratch: string[] = [];
afterEach(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function fixture(): { root: string; repo: string; sha: string } {
  const root = mkdtempSync(join(tmpdir(), "openmausbot-worktree-manager-"));
  scratch.push(root);
  const repo = join(root, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  git(root, ["init", "-b", "main", repo]);
  writeFileSync(join(repo, ".gitignore"), ".env*\n");
  writeFileSync(join(repo, "src", "value.txt"), "before\n");
  git(repo, ["add", "."]);
  git(repo, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "base"]);
  return { root, repo, sha: git(repo, ["rev-parse", "HEAD"]) };
}

describe("managed Git worktrees", () => {
  it("locks a full base SHA and parses unusual NUL-delimited paths", async () => {
    const { root, repo, sha } = fixture();
    const manager = new WorktreeManager(join(root, "managed"));
    const worktree = await manager.prepare({
      repository: repo,
      workItemId: "WI-WEIRD-PATHS",
      nodeId: "modify-code",
      attempt: 1,
      expectedBaseSha: sha,
    });
    expect(worktree.commonGitDir).toBe(realpathSync(join(repo, ".git")));
    const unusual = "src/ leading space\tand\nnewline.txt";
    writeFileSync(join(worktree.path, unusual), "content\n");
    expect(await manager.changedPaths(worktree)).toContain(unusual);
    expect(manager.validateDiff(worktree, await manager.changedPaths(worktree), ["src/**"], [".env*"]).violations).toEqual([]);
    await expect(
      manager.prepare({
        repository: repo,
        workItemId: "WI-WRONG-BASE",
        nodeId: "modify-code",
        attempt: 1,
        expectedBaseSha: sha.slice(0, 12),
      }),
    ).rejects.toThrow("locked base SHA");
  });

  it("checks rename endpoints, ignored secrets and symlinks before commit", async () => {
    const { root, repo } = fixture();
    const manager = new WorktreeManager(join(root, "managed"));
    const worktree = await manager.prepare({ repository: repo, workItemId: "WI-BOUNDARY", nodeId: "modify-code", attempt: 1 });
    mkdirSync(join(worktree.path, "docs"));
    renameSync(join(worktree.path, "src", "value.txt"), join(worktree.path, "docs", "renamed.txt"));
    writeFileSync(join(worktree.path, ".env.local"), "secret\n");
    const external = join(root, "external.txt");
    writeFileSync(external, "external\n");
    symlinkSync(external, join(worktree.path, "src", "link.txt"));
    const paths = await manager.changedPaths(worktree);
    expect(paths).toEqual(expect.arrayContaining(["src/value.txt", "docs/renamed.txt", ".env.local", "src/link.txt"]));
    const result = manager.validateDiff(worktree, paths, ["src/**"], [".env*", "**/.env*"]);
    expect(result.violations.join(" ")).toMatch(/outside_claim/u);
    expect(result.violations.join(" ")).toMatch(/denied_path/u);
    expect(result.violations.join(" ")).toMatch(/symlink_change_not_allowed/u);
  });

  it("rejects executable repository Git configuration", async () => {
    const { root, repo } = fixture();
    git(repo, ["config", "core.hooksPath", ".hooks"]);
    const manager = new WorktreeManager(join(root, "managed"));
    await expect(
      manager.prepare({ repository: repo, workItemId: "WI-HOOK", nodeId: "modify-code", attempt: 1 }),
    ).rejects.toThrow("executable Git configuration");
  });
});
