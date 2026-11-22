import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { removeTempDir } from "../testing/cleanup.ts";
import { gitCommitOf } from "./git-commit.ts";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "omb-git-commit-")));
afterAll(() => removeTempDir(scratch));
const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);
const write = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};
let n = 0;
const repo = () => join(scratch, `repo-${++n}`);
const posixOnly = it.skipIf(process.platform === "win32");

/** A main checkout on branch feature at OTHER, and a linked worktree of it as git lays one out. */
function worktreePair() {
  const main = repo();
  write(join(main, ".git", "refs", "heads", "feature"), `${OTHER}\n`);
  const gitDir = join(main, ".git", "worktrees", "wt");
  write(join(gitDir, "HEAD"), "ref: refs/heads/feature\n");
  write(join(gitDir, "commondir"), "../..\n");
  const worktree = repo();
  write(join(worktree, ".git"), `gitdir: ${gitDir}\n`);
  write(join(gitDir, "gitdir"), `${join(worktree, ".git")}\n`);
  return { main, gitDir, worktree };
}

describe("gitCommitOf", () => {
  it("reads the branch's commit from a folder inside the checkout", () => {
    const root = repo();
    write(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    write(join(root, ".git", "refs", "heads", "main"), `${SHA}\n`);
    mkdirSync(join(root, "edubot", "areas"), { recursive: true });
    expect(gitCommitOf(join(root, "edubot"))).toBe(SHA);
  });

  it("reads packed refs and a detached HEAD", () => {
    const packed = repo();
    write(join(packed, ".git", "HEAD"), "ref: refs/heads/main\n");
    write(join(packed, ".git", "packed-refs"), `# pack-refs with: peeled fully-peeled sorted\n${OTHER} refs/heads/dev\n${SHA} refs/heads/main\n`);
    expect(gitCommitOf(packed)).toBe(SHA);
    const detached = repo();
    write(join(detached, ".git", "HEAD"), `${OTHER}\n`);
    expect(gitCommitOf(detached)).toBe(OTHER);
  });

  it("follows a worktree's .git file to its own HEAD and the shared refs", () => {
    expect(gitCommitOf(worktreePair().worktree)).toBe(OTHER);
  });

  it("reads no commit from a .git file that points anywhere but a worktree folder that names it back", () => {
    const outside = repo();
    write(join(outside, "HEAD"), `${SHA}\n`);
    const pointing = repo();
    write(join(pointing, ".git"), `gitdir: ${outside}\n`);
    expect(gitCommitOf(pointing)).toBeUndefined();

    const { gitDir, worktree } = worktreePair();
    write(join(gitDir, "gitdir"), `${join(repo(), ".git")}\n`);
    expect(gitCommitOf(worktree)).toBeUndefined();

    const common = worktreePair();
    write(join(common.gitDir, "commondir"), `${outside}\n`);
    expect(gitCommitOf(common.worktree)).toBeUndefined();
  });

  posixOnly("reads no commit through a link, from a pipe or from an oversized file, without blocking", () => {
    const target = repo();
    write(join(target, ".git", "HEAD"), `${SHA}\n`);
    const linkedGit = repo();
    mkdirSync(linkedGit, { recursive: true });
    symlinkSync(join(target, ".git"), join(linkedGit, ".git"));
    expect(gitCommitOf(linkedGit)).toBeUndefined();

    const linkedRef = repo();
    write(join(linkedRef, ".git", "HEAD"), "ref: refs/heads/main\n");
    write(join(target, "main"), `${SHA}\n`);
    mkdirSync(join(linkedRef, ".git", "refs", "heads"), { recursive: true });
    symlinkSync(join(target, "main"), join(linkedRef, ".git", "refs", "heads", "main"));
    expect(gitCommitOf(linkedRef)).toBeUndefined();

    const linkedRefs = repo();
    write(join(linkedRefs, ".git", "HEAD"), "ref: refs/heads/main\n");
    write(join(target, "refs", "heads", "main"), `${SHA}\n`);
    symlinkSync(join(target, "refs"), join(linkedRefs, ".git", "refs"));
    expect(gitCommitOf(linkedRefs)).toBeUndefined();

    for (const pipe of ["HEAD", "refs/heads/main", "packed-refs"]) {
      const piped = repo();
      mkdirSync(join(piped, ".git", "refs", "heads"), { recursive: true });
      if (pipe !== "HEAD") write(join(piped, ".git", "HEAD"), "ref: refs/heads/main\n");
      execFileSync("mkfifo", [join(piped, ".git", ...pipe.split("/"))]);
      expect(gitCommitOf(piped)).toBeUndefined();
    }
    const pipedGit = repo();
    mkdirSync(pipedGit, { recursive: true });
    execFileSync("mkfifo", [join(pipedGit, ".git")]);
    expect(gitCommitOf(pipedGit)).toBeUndefined();

    const big = repo();
    write(join(big, ".git", "HEAD"), `${SHA}\n${" ".repeat(70 * 1024)}`);
    expect(gitCommitOf(big)).toBeUndefined();
  });

  it("is undefined outside a checkout and for a ref that climbs out of the git folder", () => {
    const plain = repo();
    mkdirSync(plain, { recursive: true });
    expect(gitCommitOf(plain)).toBeUndefined();
    const climbing = repo();
    write(join(climbing, ".git", "HEAD"), "ref: refs/../../secret\n");
    expect(gitCommitOf(climbing)).toBeUndefined();
  });
});
