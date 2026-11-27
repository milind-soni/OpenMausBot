import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { githubRepo, lentGit, originUrl } from "./lent-git.mjs";

test("only a github.com origin counts, as owner/name, without any user or token in it", () => {
  for (const url of ["https://github.com/ash/notes.git", "https://github.com/ash/notes", "https://ash:ghp_secret@github.com/ash/notes.git", "git@github.com:ash/notes.git", "ssh://git@github.com/ash/notes.git", "https://github.com/ash/notes/"]) {
    assert.equal(githubRepo(url), "ash/notes", url);
  }
  for (const url of ["https://gitlab.com/ash/notes.git", "https://github.com.evil.example/ash/notes", "file:///srv/ash/notes", "ext::sh -c touch% /tmp/x", "https://github.com/ash", "https://github.com/../etc", "git@github.com:ash/notes/more.git", "", null]) {
    assert.equal(githubRepo(url), null, String(url));
  }
  assert.equal(originUrl('[core]\n\tbare = false\n[remote "upstream"]\n\turl = https://github.com/other/x\n[remote "origin"]\n\turl = git@github.com:ash/notes.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n'), "git@github.com:ash/notes.git");
  assert.equal(originUrl("[core]\n"), null);
  // A config written on Windows may end its lines with CRLF.
  assert.equal(originUrl('[core]\r\n\tautocrlf = true\r\n[remote "origin"]\r\n\turl = https://github.com/ash/notes.git\r\n'), "https://github.com/ash/notes.git");
});

test("reads the repository, its branch and its commit from .git's own files", (t) => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "omb-lent-git-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, "notes");
  mkdirSync(repo);
  const git = (...args) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.test", ...args], { encoding: "utf8" }).trim();
  git("init", "--quiet", "--initial-branch", "main");
  assert.equal(lentGit(repo), null, "no origin");
  git("remote", "add", "origin", "https://github.com/ash/notes.git");
  writeFileSync(join(repo, "a.md"), "a");
  git("add", "a.md");
  git("commit", "--quiet", "-m", "a");
  const head = git("rev-parse", "HEAD");
  assert.deepEqual(lentGit(repo), { repo: "ash/notes", branch: "main", head });
  git("pack-refs", "--all");
  assert.deepEqual(lentGit(repo), { repo: "ash/notes", branch: "main", head }, "from packed-refs");
  git("checkout", "--quiet", "--detach");
  assert.deepEqual(lentGit(repo), { repo: "ash/notes", branch: null, head });
  // A worktree's or submodule's .git is a file pointing elsewhere: a normal copy.
  const linked = join(dir, "linked");
  mkdirSync(linked);
  writeFileSync(join(linked, ".git"), `gitdir: ${join(repo, ".git")}\n`);
  assert.equal(lentGit(linked), null);
  assert.equal(lentGit(join(dir, "nothing")), null);
});
