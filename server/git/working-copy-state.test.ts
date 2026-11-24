import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  driverOverrides, gitEnvironment, gitIsRecentEnough, isDisposable, remoteIsOffDisk, samePath, workingCopyState, type WorkKind, type WorkingCopyState,
} from "./working-copy-state.ts";

const made: string[] = [];
// Retries: on Windows a stopped git (or the stand-in that never answers) can hold its folder for a moment after taskkill.
afterEach(() => { for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); });

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "wcs-"));
  made.push(dir);
  return dir;
}

/** The tests' own git: no config from this machine, a fixed identity, no signing. */
const testEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name))), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.email=t@example.invalid", "-c", "user.name=T", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false",
    "-c", "init.defaultBranch=main", "-c", "protocol.file.allow=always", "-c", "core.hooksPath=/dev/null", ...args],
  { cwd, env: testEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
function gitMayFail(cwd: string, ...args: string[]): void {
  try { git(cwd, ...args); } catch {}
}
/** As if pushed: an off-disk origin whose remote-tracking ref is at HEAD. */
function markPushed(dir: string, branch = "main"): void {
  if (!git(dir, "remote").includes("origin")) git(dir, "remote", "add", "origin", "https://example.invalid/repo.git");
  git(dir, "update-ref", `refs/remotes/origin/${branch}`, "HEAD");
}
function repo(name = "repo"): string {
  const dir = join(scratch(), name);
  mkdirSync(dir);
  git(dir, "init", "-q");
  writeFileSync(join(dir, "a.txt"), "one\n");
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n.env\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "first");
  markPushed(dir);
  return dir;
}
function commit(dir: string, file: string, text: string, message = "change"): void {
  writeFileSync(join(dir, file), text);
  git(dir, "add", file);
  git(dir, "commit", "-qm", message);
}
function kinds(state: WorkingCopyState): WorkKind[] {
  return state.state === "has-unpushed-work" ? state.reasons.map((reason) => reason.kind) : [];
}
/** Makes git re-read a tracked file: same content, another modification time. */
function statDirty(file: string): void {
  const when = new Date(Date.UTC(2020, 0, 1 + Math.floor(Math.random() * 300)));
  utimesSync(file, when, when);
}

/** A program that writes `marker` when run and passes its input through (for a clean filter). Forward slashes for git's shell. */
function markerCommand(dir: string, marker: string): string {
  const script = join(dir, "mark.mjs");
  writeFileSync(script, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "ran");\nprocess.stdin.pipe(process.stdout);\n`);
  const slash = (path: string) => path.replace(/\\/g, "/");
  return `"${slash(process.execPath)}" "${slash(script)}"`;
}

describe("workingCopyState: what it judges", () => {
  it("calls a folder with no .git not a repo, and a bare repository or a missing folder unknown", async () => {
    const plain = scratch();
    writeFileSync(join(plain, "notes.txt"), "x");
    expect(await workingCopyState(plain)).toEqual({ state: "not-a-repo" });
    const bare = join(scratch(), "bare.git");
    git(scratch(), "init", "-q", "--bare", bare);
    expect((await workingCopyState(bare)).state).toBe("unknown");
    expect((await workingCopyState(join(plain, "gone"))).state).toBe("unknown");
  });

  it("calls a clean repository whose every commit is on its remote disposable, ignored files and all", async () => {
    const dir = repo();
    mkdirSync(join(dir, "node_modules"));
    writeFileSync(join(dir, "node_modules", "x.js"), "x");
    writeFileSync(join(dir, ".env"), "TOKEN=1");
    const state = await workingCopyState(dir);
    expect(state).toEqual({ state: "disposable" });
    expect(isDisposable(state)).toBe(true);
  });

  it("counts an untracked file that is not ignored, a modified file and a staged file as work", async () => {
    const untracked = repo();
    writeFileSync(join(untracked, "new.txt"), "new");
    expect(kinds(await workingCopyState(untracked))).toEqual(["changes"]);
    const modified = repo();
    writeFileSync(join(modified, "a.txt"), "two\n");
    expect(kinds(await workingCopyState(modified))).toEqual(["changes"]);
    const staged = repo();
    writeFileSync(join(staged, "b.txt"), "b");
    git(staged, "add", "b.txt");
    const state = await workingCopyState(staged);
    expect(kinds(state)).toEqual(["changes"]);
    expect(isDisposable(state)).toBe(false);
  });

  it("counts commits on no remote as work: a new commit, a local branch, a detached HEAD, a local tag", async () => {
    const ahead = repo();
    commit(ahead, "a.txt", "two\n");
    expect(kinds(await workingCopyState(ahead))).toEqual(["commits"]);
    const branch = repo();
    git(branch, "checkout", "-qb", "side");
    commit(branch, "b.txt", "b");
    git(branch, "checkout", "-q", "main");
    expect(kinds(await workingCopyState(branch))).toEqual(["commits"]);
    const detached = repo();
    git(detached, "checkout", "-q", "--detach");
    commit(detached, "b.txt", "b");
    expect(kinds(await workingCopyState(detached))).toEqual(["commits"]);
    const tagged = repo();
    commit(tagged, "b.txt", "b");
    git(tagged, "tag", "kept");
    git(tagged, "reset", "-q", "--hard", "origin/main");
    expect(kinds(await workingCopyState(tagged))).toEqual(["commits"]);
  });

  it("counts every commit as unpushed when the remote has no remote-tracking refs", async () => {
    const dir = repo();
    git(dir, "update-ref", "-d", "refs/remotes/origin/main");
    expect(kinds(await workingCopyState(dir))).toEqual(["commits"]);
  });

  it("counts a repository of its own inside an ignored folder as work, however it is ignored", async () => {
    const nest = (dir: string, inside: string) => {
      const inner = join(dir, inside);
      mkdirSync(inner, { recursive: true });
      git(inner, "init", "-q");
      writeFileSync(join(inner, "x.txt"), "work");
      git(inner, "add", "x.txt");
      git(inner, "commit", "-qm", "only here");
    };
    const gitignore = repo();
    writeFileSync(join(gitignore, ".gitignore"), "node_modules/\n.env\nwork/\n");
    git(gitignore, "commit", "-qam", "ignore work");
    markPushed(gitignore);
    nest(gitignore, "work");
    expect(git(gitignore, "status", "--porcelain")).toBe("");
    expect(kinds(await workingCopyState(gitignore))).toEqual(["nested-repo"]);

    const exclude = repo();
    writeFileSync(join(exclude, ".git", "info", "exclude"), "scratch/\n");
    nest(exclude, join("scratch", "deep", "down"));
    expect(git(exclude, "status", "--porcelain")).toBe("");
    expect(kinds(await workingCopyState(exclude))).toEqual(["nested-repo"]);

    const untracked = repo();
    nest(untracked, "work");
    expect(kinds(await workingCopyState(untracked))).toEqual(["changes"]);
  });

  it("answers unknown when the ignored folders are too many to look through", async () => {
    const dir = repo();
    for (let index = 0; index < 10; index++) mkdirSync(join(dir, "node_modules", `p${index}`, "lib"), { recursive: true });
    expect(await workingCopyState(dir)).toEqual({ state: "disposable" });
    const state = await workingCopyState(dir, { maxIgnoredFolders: 5 });
    expect(state.state).toBe("unknown");
  });

  it("counts a stash as work", async () => {
    const dir = repo();
    writeFileSync(join(dir, "a.txt"), "two\n");
    git(dir, "stash", "-q");
    expect(kinds(await workingCopyState(dir))).toEqual(["stash"]);
  });

  it("never calls a repository with no remote, or only remotes that are folders on this disk, disposable", async () => {
    const none = repo();
    git(none, "remote", "remove", "origin");
    expect(kinds(await workingCopyState(none))).toEqual(["no-remote"]);
    const local = repo();
    const bare = join(scratch(), "remote.git");
    git(scratch(), "init", "-q", "--bare", bare);
    git(local, "remote", "set-url", "origin", bare);
    git(local, "push", "-q", "origin", "main");
    const state = await workingCopyState(local);
    expect(kinds(state)).toEqual(["no-remote"]);
    expect(state.state === "has-unpushed-work" && state.reasons[0]!.detail).toBe("its only remotes are folders on this disk");
    git(local, "remote", "set-url", "origin", `file://${bare.replace(/\\/g, "/")}`);
    expect(kinds(await workingCopyState(local))).toEqual(["no-remote"]);
  });

  it("does not count a remote whose push address is a folder on this disk", async () => {
    const bare = join(scratch(), "remote.git");
    git(scratch(), "init", "-q", "--bare", bare);
    const pushUrl = repo();
    commit(pushUrl, "b.txt", "b");
    git(pushUrl, "remote", "set-url", "--push", "origin", bare);
    git(pushUrl, "push", "-q", "origin", "main");
    expect(git(pushUrl, "rev-parse", "origin/main")).toBe(git(pushUrl, "rev-parse", "HEAD"));
    expect(kinds(await workingCopyState(pushUrl))).toEqual(["no-remote"]);

    const insteadOf = repo();
    commit(insteadOf, "b.txt", "b");
    git(insteadOf, "config", `url.${scratch().replace(/\\/g, "/")}/.pushInsteadOf`, "https://example.invalid/");
    git(insteadOf, "update-ref", "refs/remotes/origin/main", "HEAD");
    expect(kinds(await workingCopyState(insteadOf))).toEqual(["no-remote"]);
  });

  it("answers unknown when one remote's name is another's plus /…", async () => {
    const dir = repo();
    commit(dir, "b.txt", "b");
    const bare = join(scratch(), "backup.git");
    git(scratch(), "init", "-q", "--bare", bare);
    // Newer git refuses `git remote add origin/backup` next to origin; a bot can still write the config by hand.
    git(dir, "config", "remote.origin/backup.url", bare);
    git(dir, "config", "remote.origin/backup.fetch", "+refs/heads/*:refs/remotes/origin/backup/*");
    git(dir, "push", "-q", "origin/backup", "main");
    expect(git(dir, "for-each-ref", "--format=%(refname)", "refs/remotes/origin/backup")).toContain("refs/remotes/origin/backup/main");
    expect((await workingCopyState(dir)).state).toBe("unknown");
  });

  it("puts no file names in a reason's detail", async () => {
    const dir = repo();
    writeFileSync(join(dir, "a.txt"), "two\n");
    writeFileSync(join(dir, "private-name.txt"), "x");
    const state = await workingCopyState(dir);
    expect(kinds(state)).toEqual(["changes"]);
    expect(JSON.stringify(state)).not.toMatch(/private-name|a\.txt/);
  });

  it("counts a merge, rebase, cherry-pick, revert or bisect in progress as work", async () => {
    const conflicted = () => {
      const dir = repo();
      git(dir, "checkout", "-qb", "side");
      commit(dir, "a.txt", "side\n");
      markPushed(dir, "side");
      git(dir, "checkout", "-q", "main");
      commit(dir, "a.txt", "main\n");
      markPushed(dir);
      return dir;
    };
    const merge = conflicted();
    gitMayFail(merge, "merge", "-q", "side");
    const rebase = conflicted();
    gitMayFail(rebase, "rebase", "-q", "side");
    const pick = conflicted();
    gitMayFail(pick, "cherry-pick", "side");
    const revert = repo();
    commit(revert, "a.txt", "two\n");
    commit(revert, "a.txt", "three\n");
    markPushed(revert);
    gitMayFail(revert, "revert", "--no-edit", "HEAD~1");
    const bisect = repo();
    git(bisect, "bisect", "start");
    for (const dir of [merge, rebase, pick, revert, bisect]) {
      expect(existsSync(join(dir, ".git", "MERGE_HEAD")) || existsSync(join(dir, ".git", "rebase-merge")) || existsSync(join(dir, ".git", "rebase-apply"))
        || existsSync(join(dir, ".git", "CHERRY_PICK_HEAD")) || existsSync(join(dir, ".git", "REVERT_HEAD")) || existsSync(join(dir, ".git", "BISECT_START"))).toBe(true);
      expect(kinds(await workingCopyState(dir))).toContain("in-progress");
    }
    expect(kinds(await workingCopyState(bisect))).toEqual(["in-progress"]);
  });

  it("judges the main checkout with its linked worktrees, and a linked worktree on its own tree", async () => {
    const dir = repo();
    const linked = join(scratch(), "linked");
    git(dir, "worktree", "add", "-q", "--detach", linked);
    expect(await workingCopyState(dir)).toEqual({ state: "disposable" });
    writeFileSync(join(linked, "wip.txt"), "wip");
    const main = await workingCopyState(dir);
    expect(kinds(main)).toEqual(["worktree"]);
    expect(main.state === "has-unpushed-work" && main.reasons[0]!.path).toContain("linked");
    expect(kinds(await workingCopyState(linked))).toEqual(["changes"]);
    rmSync(join(linked, "wip.txt"));
    writeFileSync(join(dir, "wip.txt"), "wip");
    expect(await workingCopyState(linked)).toEqual({ state: "disposable" });
    // A commit on the linked worktree's detached HEAD is unpushed from the main checkout too, and only that tree's own.
    rmSync(join(dir, "wip.txt"));
    commit(linked, "b.txt", "b");
    expect(kinds(await workingCopyState(dir))).toEqual(["worktree"]);
    const own = await workingCopyState(linked);
    expect(own.state === "has-unpushed-work" && own.reasons.map(({ kind, scope }) => ({ kind, scope }))).toEqual([{ kind: "commits", scope: "this-worktree" }]);
  });

  it("finds a commit kept only by a linked worktree's refs/worktree/*, from the main checkout", async () => {
    const dir = repo();
    const linked = join(scratch(), "linked");
    git(dir, "worktree", "add", "-q", "--detach", linked);
    commit(linked, "b.txt", "b");
    git(linked, "update-ref", "refs/worktree/keep", "HEAD");
    git(linked, "checkout", "-q", "--detach", "origin/main");
    const state = await workingCopyState(dir);
    expect(kinds(state)).toEqual(["worktree"]);
    expect(state.state === "has-unpushed-work" && state.reasons[0]!.detail).toContain("refs/worktree");
  });

  it("tells commits on a shared branch from commits only on this working tree's HEAD", async () => {
    const branch = repo();
    git(branch, "branch", "side");
    git(branch, "checkout", "-q", "side");
    commit(branch, "b.txt", "b");
    git(branch, "checkout", "-q", "main");
    const shared = await workingCopyState(branch);
    expect(shared.state === "has-unpushed-work" && shared.reasons.map(({ kind, scope }) => ({ kind, scope }))).toEqual([{ kind: "commits", scope: "repository" }]);
    const head = repo();
    git(head, "checkout", "-q", "--detach");
    commit(head, "b.txt", "b");
    const own = await workingCopyState(head);
    expect(own.state === "has-unpushed-work" && own.reasons.map(({ kind, scope }) => ({ kind, scope }))).toEqual([{ kind: "commits", scope: "this-worktree" }]);
  });

  it("calls files marked assume-unchanged or skip-worktree hidden changes", async () => {
    const assumed = repo();
    git(assumed, "update-index", "--assume-unchanged", "a.txt");
    writeFileSync(join(assumed, "a.txt"), "changed, but git status says nothing\n");
    expect(git(assumed, "status", "--porcelain")).toBe("");
    expect(kinds(await workingCopyState(assumed))).toEqual(["hidden-changes"]);
    const skipped = repo();
    git(skipped, "update-index", "--skip-worktree", "a.txt");
    writeFileSync(join(skipped, "a.txt"), "changed\n");
    expect(kinds(await workingCopyState(skipped))).toEqual(["hidden-changes"]);
  });

  it("judges each checked-out submodule as its own working copy", async () => {
    const source = repo("sub-source");
    const dir = repo();
    git(dir, "submodule", "add", "-q", source, "sm");
    git(dir, "commit", "-qm", "submodule");
    markPushed(dir);
    const sm = join(dir, "sm");
    git(sm, "remote", "set-url", "origin", "https://example.invalid/sub.git");
    markPushed(sm);
    expect(await workingCopyState(dir)).toEqual({ state: "disposable" });

    writeFileSync(join(sm, "new.txt"), "x");
    expect(kinds(await workingCopyState(dir))).toEqual(["submodule"]);
    rmSync(join(sm, "new.txt"));

    writeFileSync(join(sm, "a.txt"), "stashed\n");
    git(sm, "stash", "-q");
    expect(kinds(await workingCopyState(dir))).toEqual(["submodule"]);
    git(sm, "stash", "drop", "-q");

    // The parent records and "pushes" a submodule commit that the submodule never pushed.
    commit(sm, "a.txt", "sub work\n");
    git(dir, "add", "sm");
    git(dir, "commit", "-qm", "bump");
    markPushed(dir);
    expect(git(dir, "status", "--porcelain")).toBe("");
    const state = await workingCopyState(dir);
    expect(kinds(state)).toEqual(["submodule"]);
    expect(state.state === "has-unpushed-work" && state.reasons[0]!.detail).toContain("on no remote");
    markPushed(sm);
    expect(await workingCopyState(dir)).toEqual({ state: "disposable" });

    // A submodule moved to a commit the parent has not recorded is a change in the parent.
    git(sm, "checkout", "-q", "HEAD~1");
    expect(kinds(await workingCopyState(dir))).toContain("changes");
    git(sm, "checkout", "-q", "main");

    // Deinit keeps the submodule's repository in .git/modules with no checkout: nothing to judge it by.
    git(dir, "submodule", "deinit", "-q", "-f", "sm");
    expect(existsSync(join(dir, ".git", "modules", "sm"))).toBe(true);
    expect((await workingCopyState(dir)).state).toBe("unknown");
  });

  it("calls a corrupt repository unknown", async () => {
    const dir = repo();
    writeFileSync(join(dir, ".git", "HEAD"), "garbage\n");
    expect((await workingCopyState(dir)).state).toBe("unknown");
  });

  it("calls a git that does not answer in time unknown", async () => {
    const dir = repo();
    const sleeper = join(scratch(), "sleep.mjs");
    writeFileSync(sleeper, "setTimeout(() => {}, 30_000);\n");
    const started = Date.now();
    const state = await workingCopyState(dir, { git: [process.execPath, sleeper], timeoutMs: 1_500 });
    expect(state).toEqual({ state: "unknown", detail: "git did not answer in time" });
    expect(Date.now() - started).toBeLessThan(20_000);
    expect((await workingCopyState(dir, { git: [join(scratch(), "no-such-git")] })).state).toBe("unknown");
  });
});

describe("workingCopyState against a hostile repository config", () => {
  it("runs no fsmonitor hook the repository names", async () => {
    const dir = repo();
    const marker = join(scratch(), "fsmonitor-ran");
    git(dir, "config", "core.fsmonitor", markerCommand(scratch(), marker));
    gitMayFail(dir, "status", "--porcelain");
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);
    expect(await workingCopyState(dir)).toEqual({ state: "disposable" });
    expect(existsSync(marker)).toBe(false);
  });

  it("runs no clean or process filter, whatever its driver is called", async () => {
    for (const kind of ["clean", "process"]) {
      const dir = repo();
      const driver = `d${Math.random().toString(36).slice(2)}.x`;
      writeFileSync(join(dir, ".gitattributes"), `*.txt filter=${driver}\n`);
      git(dir, "add", ".gitattributes");
      git(dir, "commit", "-qm", "attributes");
      markPushed(dir);
      const marker = join(scratch(), `${kind}-ran`);
      git(dir, "config", `filter.${driver}.${kind}`, markerCommand(scratch(), marker));
      git(dir, "config", `filter.${driver}.required`, "true");
      statDirty(join(dir, "a.txt"));
      gitMayFail(dir, "status", "--porcelain");
      expect(existsSync(marker), kind).toBe(true);
      rmSync(marker);
      statDirty(join(dir, "a.txt"));
      expect(await workingCopyState(dir)).toEqual({ state: "disposable" });
      expect(existsSync(marker), kind).toBe(false);
    }
  });

  it("runs no filter a submodule's own config names", async () => {
    const source = repo("sub-source");
    const dir = repo();
    git(dir, "submodule", "add", "-q", source, "sm");
    git(dir, "commit", "-qm", "submodule");
    markPushed(dir);
    const sm = join(dir, "sm");
    git(sm, "remote", "set-url", "origin", "https://example.invalid/sub.git");
    writeFileSync(join(sm, ".gitattributes"), "*.txt filter=evil\n");
    git(sm, "add", ".gitattributes");
    git(sm, "commit", "-qm", "attributes");
    markPushed(sm);
    git(dir, "add", "sm");
    git(dir, "commit", "-qm", "bump");
    markPushed(dir);
    const marker = join(scratch(), "sub-filter-ran");
    git(sm, "config", "filter.evil.clean", markerCommand(scratch(), marker));
    statDirty(join(sm, "a.txt"));
    gitMayFail(dir, "status", "--porcelain", "--ignore-submodules=none");
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);
    statDirty(join(sm, "a.txt"));
    expect(await workingCopyState(dir)).toEqual({ state: "disposable" });
    expect(existsSync(marker)).toBe(false);
  });

  it("is not blinded by config that hides untracked files, ignores everything, or skips stat checks", async () => {
    const hidden = repo();
    git(hidden, "config", "status.showUntrackedFiles", "no");
    writeFileSync(join(hidden, "new.txt"), "x");
    expect(git(hidden, "status", "--porcelain")).toBe("");
    expect(kinds(await workingCopyState(hidden))).toEqual(["changes"]);

    const excluded = repo();
    const everything = join(scratch(), "ignore-all");
    writeFileSync(everything, "*\n");
    git(excluded, "config", "core.excludesFile", everything);
    writeFileSync(join(excluded, "new.txt"), "x");
    expect(git(excluded, "status", "--porcelain")).toBe("");
    expect(kinds(await workingCopyState(excluded))).toEqual(["changes"]);

    const ignoreStat = repo();
    git(ignoreStat, "config", "core.ignoreStat", "true");
    git(ignoreStat, "update-index", "--really-refresh");
    writeFileSync(join(ignoreStat, "a.txt"), "changed\n");
    expect(kinds(await workingCopyState(ignoreStat))).not.toEqual([]);
  });

  it("is not blinded by config that ignores submodules", async () => {
    const source = repo("sub-source");
    const dir = repo();
    git(dir, "submodule", "add", "-q", source, "sm");
    git(dir, "commit", "-qm", "submodule");
    markPushed(dir);
    const sm = join(dir, "sm");
    git(sm, "remote", "set-url", "origin", "https://example.invalid/sub.git");
    markPushed(sm);
    git(dir, "config", "diff.ignoreSubmodules", "all");
    git(dir, "config", "submodule.sm.ignore", "all");
    writeFileSync(join(sm, "a.txt"), "changed\n");
    expect(git(dir, "status", "--porcelain")).toBe("");
    expect(kinds(await workingCopyState(dir))).toEqual(["submodule"]);
  });

  it("calls a repository whose core.worktree points elsewhere unknown", async () => {
    const dir = repo();
    const elsewhere = scratch();
    git(dir, "config", "core.worktree", elsewhere);
    writeFileSync(join(dir, "wip.txt"), "wip");
    const state = await workingCopyState(dir);
    expect(state.state).toBe("unknown");
  });

  it("writes nothing to the repository, even where git status would refresh the index", async () => {
    const dir = repo();
    for (let index = 0; index < 20; index++) writeFileSync(join(dir, `f${index}.txt`), `${index}`);
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "more");
    markPushed(dir);
    for (let index = 0; index < 20; index++) statDirty(join(dir, `f${index}.txt`));
    const snapshot = () => {
      const out: string[] = [];
      const walk = (folder: string) => {
        for (const entry of readdirSync(folder, { withFileTypes: true })) {
          const path = join(folder, entry.name);
          if (entry.isDirectory()) walk(path);
          else { const info = statSync(path); out.push(`${path} ${info.size} ${info.mtimeMs}`); }
        }
      };
      walk(join(dir, ".git"));
      return out.sort();
    };
    const before = snapshot();
    expect(await workingCopyState(dir)).toEqual({ state: "disposable" });
    expect(snapshot()).toEqual(before);
    // Plain git status would have rewritten the index here.
    git(dir, "status", "--porcelain");
    expect(snapshot()).not.toEqual(before);
  });
});

describe("working-copy-state helpers", () => {
  it("counts only remotes off this disk", () => {
    for (const url of ["https://github.com/a/b.git", "http://host/x", "ssh://git@host/x", "git://host/x", "git@github.com:a/b.git", "host:path/x"]) expect(remoteIsOffDisk(url), url).toBe(true);
    for (const url of ["/srv/repo.git", "../repo", "file:///srv/repo.git", "C:\\repos\\x", "c:/repos/x", "ext::sh -c touch% /tmp/x", "./a:b/c", "fd::17"]) expect(remoteIsOffDisk(url), url).toBe(false);
  });

  it("asks for git 2.36 or later", () => {
    for (const version of ["git version 2.36.0", "git version 2.50.1 (Apple Git-155)", "git version 2.45.1.windows.1", "git version 3.0.0"]) expect(gitIsRecentEnough(version), version).toBe(true);
    for (const version of ["git version 2.35.9", "git version 2.30.2", "git version 1.9.5", "", "garbage"]) expect(gitIsRecentEnough(version), version).toBe(false);
  });

  it("compares git's paths with Node's, on Windows too", () => {
    expect(samePath("C:/Users/ash/repo", "C:\\Users\\ash\\repo", "win32")).toBe(true);
    expect(samePath("c:/users/ash/repo/", "C:\\Users\\Ash\\repo", "win32")).toBe(true);
    expect(samePath("D:/repo", "C:\\repo", "win32")).toBe(false);
    expect(samePath("/home/ash/Repo", "/home/ash/repo", "linux")).toBe(false);
    expect(samePath("/home/ash/repo/", "/home/ash/repo", "linux")).toBe(true);
  });

  it("blanks every driver the config names, odd names included", () => {
    const listing = ["core.bare\nfalse", "filter.a=b.c.clean\nrm -rf x", "diff.Weird Name.textconv\nx", "merge.m.driver\nx", "filter.lfs.required\ntrue"].join("\0") + "\0";
    const env = driverOverrides(listing);
    const pairs = Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, index) => `${env[`GIT_CONFIG_KEY_${index}`]}=${env[`GIT_CONFIG_VALUE_${index}`]}`);
    expect(pairs).toEqual([
      "filter.a=b.c.clean=", "filter.a=b.c.smudge=", "filter.a=b.c.process=", "filter.a=b.c.required=false",
      "diff.Weird Name.textconv=", "diff.Weird Name.command=", "merge.m.driver=",
      "filter.lfs.clean=", "filter.lfs.smudge=", "filter.lfs.process=", "filter.lfs.required=false",
    ]);
    expect(driverOverrides("core.bare\nfalse\0")).toEqual({});
  });

  it("gives git an environment with nothing inherited it would act on", () => {
    const env = gitEnvironment("/work/repo", { PATH: "/bin", GIT_DIR: "/elsewhere", GIT_WORK_TREE: "/x", git_index_file: "/i", GIT_SSH_COMMAND: "evil", PAGER: "evil", SSH_ASKPASS: "evil" });
    expect(env.GIT_DIR).toBeUndefined();
    expect(env.GIT_WORK_TREE).toBeUndefined();
    expect(env.git_index_file).toBeUndefined();
    expect(env.GIT_SSH_COMMAND).toBeUndefined();
    expect(env.SSH_ASKPASS).toBeUndefined();
    expect(env).toMatchObject({ PATH: "/bin", PAGER: "cat", GIT_PAGER: "cat", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0", GIT_CEILING_DIRECTORIES: "/work" });
  });
});
