import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { conversationRepos, forgetConversationRepos, githubRepoOf, remoteUrls, reposOnDisk } from "./git-repos.ts";

describe("a github.com remote's repository", () => {
  it("in every form git takes, the broker's included", () => {
    for (const url of [
      "https://github.com/Acme/Widgets.git", "https://github.com/acme/widgets", "https://github.com/acme/widgets/", "http://github.com/acme/widgets.git",
      "https://user@github.com/acme/widgets.git", "git@github.com:acme/widgets.git", "ssh://git@github.com/acme/widgets", "ssh://git@github.com:22/acme/widgets.git",
      "http://127.0.0.1:18080/g/github/acme/widgets.git", `http://127.0.0.1:18080/b/omb_t0_${"a".repeat(48)}/github/acme/widgets`,
    ]) expect(githubRepoOf(url), url).toBe("acme/widgets");
    expect(githubRepoOf("https://github.com/acme/my.repo.git")).toBe("acme/my.repo");
  });

  it("and nothing for another host, another shape or a traversal", () => {
    for (const url of ["https://gitlab.com/acme/widgets.git", "https://github.com.evil.example/acme/widgets", "https://github.com/acme", "https://github.com/acme/widgets/tree/main", "https://github.com/acme/..", "/srv/git/widgets.git", "../widgets"]) {
      expect(githubRepoOf(url), url).toBeNull();
    }
  });

  it("read from a config file's remote sections only", () => {
    const config = `[core]\n\turl = https://github.com/not/a-remote\n[remote "origin"]\n\turl = https://github.com/acme/one.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n[remote "fork"]\n\tpushurl = "git@github.com:me/two.git"\n[branch "main"]\n\tremote = origin\n`;
    expect(remoteUrls(config)).toEqual(["https://github.com/acme/one.git", "git@github.com:me/two.git"]);
    expect(remoteUrls(config.replace(/\n/g, "\r\n"))).toEqual(["https://github.com/acme/one.git", "git@github.com:me/two.git"]);
  });
});

describe("the repositories a conversation works in", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "omb-git-repos-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); forgetConversationRepos(); });

  const clone = (folder: string, url: string) => {
    mkdirSync(join(folder, ".git"), { recursive: true });
    writeFileSync(join(folder, ".git", "config"), `[remote "origin"]\n\turl = ${url}\n`);
  };

  // A link needs a privilege on Windows; the box that uses this runs only on Linux.
  it.skipIf(process.platform === "win32")("are the clones in its folders and up to two levels below, worktrees too, and no link is followed", async () => {
    clone(join(dir, "conv"), "https://github.com/acme/root.git");
    clone(join(dir, "conv", "one"), "git@github.com:acme/one.git");
    clone(join(dir, "conv", "a", "two"), "https://github.com/acme/two");
    clone(join(dir, "conv", "a", "b", "three"), "https://github.com/acme/three");
    clone(join(dir, "conv", "node_modules", "dep"), "https://github.com/acme/dep");
    clone(join(dir, "elsewhere", "secret"), "https://github.com/acme/secret");
    symlinkSync(join(dir, "elsewhere"), join(dir, "conv", "link"));
    // A worktree: its .git is a file naming its git folder, whose common folder holds the config.
    clone(join(dir, "main"), "https://github.com/acme/worktreed");
    mkdirSync(join(dir, "main", ".git", "worktrees", "wt"), { recursive: true });
    writeFileSync(join(dir, "main", ".git", "worktrees", "wt", "commondir"), "../..\n");
    mkdirSync(join(dir, "conv", "wt"));
    writeFileSync(join(dir, "conv", "wt", ".git"), `gitdir: ${join(dir, "main", ".git", "worktrees", "wt")}\n`);
    expect([...await reposOnDisk([join(dir, "conv")])].sort()).toEqual(["acme/one", "acme/root", "acme/two", "acme/worktreed"]);
    expect([...await reposOnDisk([join(dir, "nowhere")])]).toEqual([]);
  });

  it("may be pushed to once cloned there or fetched through the broker in that conversation, and not from another", async () => {
    clone(join(dir, "conv", "work"), "https://github.com/acme/work.git");
    const mine = conversationRepos("thread:t1", [join(dir, "conv")]);
    const theirs = conversationRepos("thread:t2", [join(dir, "other")]);
    expect(await mine.mayPush("acme/work")).toBe(true);
    expect(await mine.mayPush("acme/fetched")).toBe(false);
    mine.fetched("acme/fetched");
    expect(await conversationRepos("thread:t1", []).mayPush("acme/fetched")).toBe(true);
    expect(await theirs.mayPush("acme/fetched")).toBe(false);
    expect(await theirs.mayPush("acme/work")).toBe(false);
  });
});
