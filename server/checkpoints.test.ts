// checkpoints.ts contract, exercised against REAL git in mkdtemp folders:
// snapshots are commits in a shadow repo (idempotent when nothing changed),
// staged incrementally yet identical to a from-empty rebuild, obsolete
// objects are collected on a throttle behind the turn's settled diff,
// excluded/ignored files are never snapshotted, the digest diff names what a
// turn changed, a user's own git repo in the folder is never touched, and
// dangerous folders (home) are refused outright.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

// Shadow repos live under DATA_DIR, which server/testing/setup.ts points at a
// disposable test home before any test module imports config.ts.
import { CHECKPOINTS_DIR, GC_EVERY_COMMITS, diffWorkingTree, refusalReason, release, snapshot } from "./checkpoints.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const scratchDirs: string[] = [];
afterAll(async () => {
  for (const dir of scratchDirs) await removeTempDir(dir);
});

let seq = 0;
function workspace() {
  const cwd = mkdtempSync(join(tmpdir(), "omb-ckpt-ws-"));
  scratchDirs.push(cwd);
  seq += 1;
  return { bot: `ckpt-test-bot-${seq}`, cwd };
}
function shadowOf(bot: string, cwd: string): string {
  return join(CHECKPOINTS_DIR, bot, createHash("sha256").update(realpathSync(cwd)).digest("hex").slice(0, 16));
}

/** The shadow repo's snapshots, newest first, without the empty base marker. */
function snapshotsIn(bot: string, cwd: string): { hash: string; label: string }[] {
  const lines = userGit(shadowOf(bot, cwd), "log", "--format=%H%x09%s").split("\n").filter(Boolean);
  lines.pop(); // the root of the log is always the empty base marker
  return lines.map((line) => {
    const [hash, ...label] = line.split("\t");
    return { hash: hash!, label: label.join("\t") };
  });
}

/** Wait for every operation queued on the folder's shadow repo (release()
 * queues behind them; releasing a pin never taken is a no-op). */
async function drain(bot: string, cwd: string): Promise<void> {
  await release(bot, cwd, "test-drain");
}

/** Take changed snapshots until the GC throttle has run at least one
 * collection: GC_EVERY_COMMITS of them make one due, a later snapshot or the
 * last turn's settled diff releases it. */
async function churnUntilCollected(bot: string, cwd: string): Promise<void> {
  let hash: string | null = null;
  for (let turn = 0; turn < GC_EVERY_COMMITS; turn += 1) {
    writeFileSync(join(cwd, "churn.txt"), `churn ${turn}`);
    hash = await snapshot(bot, cwd, `churn ${turn}`);
    expect(hash).toMatch(/^[0-9a-f]{40}$/);
  }
  await diffWorkingTree(bot, cwd, hash!);
  await drain(bot, cwd);
}

/** The user's own git, as the user would run it — no shadow env involved. */
function userGit(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "User",
      GIT_AUTHOR_EMAIL: "user@example.com",
      GIT_COMMITTER_NAME: "User",
      GIT_COMMITTER_EMAIL: "user@example.com",
    },
  });
}

describe("snapshot", () => {
  it("cancels optional digest capture without disabling later checkpoints", async () => {
    const { bot, cwd } = workspace();
    writeFileSync(join(cwd, "a.txt"), "one");
    expect(await snapshot(bot, cwd, "cancelled capture", AbortSignal.abort())).toBeNull();
    expect(existsSync(shadowOf(bot, cwd))).toBe(false);
    expect(await snapshot(bot, cwd, "next turn")).toMatch(/^[0-9a-f]{40}$/);
  });

  it("creates a checkpoint commit and is idempotent while nothing changes", async () => {
    const { bot, cwd } = workspace();
    writeFileSync(join(cwd, "a.txt"), "one");
    const first = await snapshot(bot, cwd, "turn 11111111");
    expect(first).toMatch(/^[0-9a-f]{40}$/);

    // unchanged folder → same hash, no second commit
    const again = await snapshot(bot, cwd, "turn 22222222");
    expect(again).toBe(first);
    expect(snapshotsIn(bot, cwd)).toEqual([{ hash: first, label: "turn 11111111" }]);

    // a real change → a new checkpoint, newest first
    writeFileSync(join(cwd, "a.txt"), "two");
    const second = await snapshot(bot, cwd, "turn 33333333");
    expect(second).toMatch(/^[0-9a-f]{40}$/);
    expect(second).not.toBe(first);
    expect(snapshotsIn(bot, cwd).map((c) => c.label)).toEqual(["turn 33333333"]);
  });

  it("keeps only the newest usable checkpoint", async () => {
    const { bot, cwd } = workspace();
    writeFileSync(join(cwd, "a.txt"), "obsolete payload");
    await snapshot(bot, cwd, "old turn");
    writeFileSync(join(cwd, "a.txt"), "latest payload");
    const latest = await snapshot(bot, cwd, "latest turn");
    expect(snapshotsIn(bot, cwd).map(c => c.hash)).toEqual([latest]);
    expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("latest payload");
  });

  it("reclaims obsolete content on the GC throttle, behind the turn's settled diff, never every snapshot", async () => {
    const { bot, cwd } = workspace();
    writeFileSync(join(cwd, "a.txt"), "obsolete payload");
    const first = await snapshot(bot, cwd, "old turn");
    const shadow = shadowOf(bot, cwd);
    const oldBlob = userGit(shadow, "rev-parse", `${first}:a.txt`).trim();
    writeFileSync(join(cwd, "a.txt"), "payload 2");
    await snapshot(bot, cwd, "turn 2");
    await drain(bot, cwd);
    expect(() => userGit(shadow, "cat-file", "-e", oldBlob)).not.toThrow();
    expect(GC_EVERY_COMMITS).toBeGreaterThan(3);
    for (let turn = 3; turn < GC_EVERY_COMMITS; turn += 1) {
      writeFileSync(join(cwd, "a.txt"), `payload ${turn}`);
      expect(await snapshot(bot, cwd, `turn ${turn}`)).toMatch(/^[0-9a-f]{40}$/);
    }
    await drain(bot, cwd);
    expect(() => userGit(shadow, "cat-file", "-e", oldBlob)).not.toThrow();
    writeFileSync(join(cwd, "a.txt"), "latest payload");
    const latest = await snapshot(bot, cwd, "latest turn");
    await drain(bot, cwd);
    // the due collection waits for the turn's settled diff...
    expect(() => userGit(shadow, "cat-file", "-e", oldBlob)).not.toThrow();
    expect(await diffWorkingTree(bot, cwd, latest!)).toEqual({ changed: [], added: [], deleted: [] });
    // ...and is queued behind it
    await drain(bot, cwd);
    expect(snapshotsIn(bot, cwd).map(c => c.hash)).toEqual([latest]);
    expect(() => userGit(shadow, "cat-file", "-e", oldBlob)).toThrow();
    expect(userGit(shadow, "cat-file", "-p", `${latest}:a.txt`)).toBe("latest payload");
  });

  // The shadow index persists between snapshots. Each case below is one where
  // an incremental `add -A` alone would differ from a from-empty rebuild.

  // Case-insensitive volumes (macOS default APFS, Windows NTFS): the shadow
  // repo gets core.ignorecase=true, so an incremental add keeps old spellings.
  const caseInsensitiveTmp = (() => {
    const probe = mkdtempSync(join(tmpdir(), "omb-ckpt-case-"));
    scratchDirs.push(probe);
    writeFileSync(join(probe, "probe"), "");
    return existsSync(join(probe, "PROBE"));
  })();
  const treeNames = (shadow: string, hash: string | null) =>
    userGit(shadow, "ls-tree", "-r", "-z", "--name-only", hash!).split("\0").filter(Boolean).map(name => name.normalize("NFC")).sort();

  it.runIf((process.platform === "darwin" || process.platform === "win32") && caseInsensitiveTmp)(
    "records a case-only rename of a file, a folder and a dotfile like a from-empty rebuild",
    async () => {
      const { bot, cwd } = workspace();
      writeFileSync(join(cwd, "r0"), "file");
      mkdirSync(join(cwd, "Docs"));
      writeFileSync(join(cwd, "Docs", "a.txt"), "in a folder");
      writeFileSync(join(cwd, ".GITIGNORE"), "# rules\n");
      const shadow = shadowOf(bot, cwd);
      const first = await snapshot(bot, cwd, "original spelling");
      expect(treeNames(shadow, first)).toEqual([".GITIGNORE", "Docs/a.txt", "r0"]);
      renameSync(join(cwd, "r0"), join(cwd, "R0"));
      renameSync(join(cwd, "Docs"), join(cwd, "docs"));
      renameSync(join(cwd, ".GITIGNORE"), join(cwd, ".gitignore"));
      expect(await diffWorkingTree(bot, cwd, first!)).toEqual({
        changed: [],
        added: [".gitignore", "R0", "docs/a.txt"],
        deleted: [".GITIGNORE", "Docs/a.txt", "r0"],
      });
      const renamed = await snapshot(bot, cwd, "new spelling");
      expect(treeNames(shadow, renamed)).toEqual([".gitignore", "R0", "docs/a.txt"]);
      expect(await snapshot(bot, cwd, "unchanged")).toBe(renamed);
    },
  );

  it.runIf((process.platform === "darwin" || process.platform === "win32") && caseInsensitiveTmp)(
    "compares decomposed (NFD) names in NFC when looking for a case-only rename",
    async () => {
      const { bot, cwd } = workspace();
      writeFileSync(join(cwd, "École.txt"), "accent");
      const shadow = shadowOf(bot, cwd);
      expect(treeNames(shadow, await snapshot(bot, cwd, "upper"))).toEqual(["École.txt"]);
      renameSync(join(cwd, "École.txt"), join(cwd, "école.txt"));
      expect(treeNames(shadow, await snapshot(bot, cwd, "lower"))).toEqual(["école.txt"]);
    },
  );

  it("drops a newly ignored file from the next snapshot and the settled diff", async () => {
    const { bot, cwd } = workspace();
    writeFileSync(join(cwd, "a.txt"), "source");
    writeFileSync(join(cwd, "secret.txt"), "tracked until ignored");
    const first = await snapshot(bot, cwd, "before ignore");
    const shadow = shadowOf(bot, cwd);
    expect(userGit(shadow, "ls-tree", "-r", "--name-only", first!).trim().split("\n")).toEqual(["a.txt", "secret.txt"]);
    writeFileSync(join(cwd, ".gitignore"), "secret.txt\n");
    expect(await diffWorkingTree(bot, cwd, first!)).toEqual({ changed: [], added: [".gitignore"], deleted: ["secret.txt"] });
    const second = await snapshot(bot, cwd, "after ignore");
    expect(userGit(shadow, "ls-tree", "-r", "--name-only", second!).trim().split("\n")).toEqual([".gitignore", "a.txt"]);
    // the ignored file itself is left alone
    expect(readFileSync(join(cwd, "secret.txt"), "utf8")).toBe("tracked until ignored");
  });

  it("matches a from-empty rebuild when a folder becomes, then stops being, a nested repo", async () => {
    const { bot, cwd } = workspace();
    writeFileSync(join(cwd, "a.txt"), "outer");
    mkdirSync(join(cwd, "lib"));
    writeFileSync(join(cwd, "lib", "b.txt"), "inner");
    const shadow = shadowOf(bot, cwd);
    const tree = (hash: string | null) => userGit(shadow, "ls-tree", "-r", hash!).trim().split("\n").map(line => {
      const [meta, path] = line.split("\t");
      return `${meta!.split(" ")[0]} ${path}`;
    });
    expect(tree(await snapshot(bot, cwd, "plain folder"))).toEqual(["100644 a.txt", "100644 lib/b.txt"]);
    userGit(join(cwd, "lib"), "init");
    userGit(join(cwd, "lib"), "add", "-A");
    userGit(join(cwd, "lib"), "commit", "-m", "inner");
    expect(tree(await snapshot(bot, cwd, "nested repo"))).toEqual(["100644 a.txt", "160000 lib"]);
    rmSync(join(cwd, "lib", ".git"), { recursive: true, force: true });
    expect(tree(await snapshot(bot, cwd, "plain again"))).toEqual(["100644 a.txt", "100644 lib/b.txt"]);
  });

  // Two threads of one bot work in one folder at the same time: thread B's
  // snapshot lands while thread A's turn is still running, and A's digest
  // diffs against A's own pre-turn commit when A ends.
  // This exercises a full 25-commit GC cycle with real Git subprocesses.
  // Windows runner process startup can exhaust the suite's 20-second limit;
  // keep every retention/collection assertion, with a bounded Windows budget.
  it("keeps a pinned pre-turn commit through a sibling turn's snapshot until it is released", async () => {
    const { bot, cwd } = workspace();
    const shadow = shadowOf(bot, cwd);
    writeFileSync(join(cwd, "a.txt"), "before A");
    const hashA = await snapshot(bot, cwd, "turn A", undefined, { pin: "dispatch-A" });
    writeFileSync(join(cwd, "a.txt"), "A edited");
    const hashB = await snapshot(bot, cwd, "turn B", undefined, { pin: "dispatch-B" });
    expect(hashB).not.toBe(hashA);
    // only the newest is listed, as always — but A's commit is still there
    expect(snapshotsIn(bot, cwd).map(c => c.hash)).toEqual([hashB]);
    expect(await diffWorkingTree(bot, cwd, hashA!)).toEqual({ changed: ["a.txt"], added: [], deleted: [] });
    // both pinned commits are intact
    expect(() => userGit(shadow, "cat-file", "-e", `${hashA}^{commit}`)).not.toThrow();
    expect(() => userGit(shadow, "cat-file", "-e", `${hashB}^{commit}`)).not.toThrow();
    // both turns end → the next collection reclaims both commits (that a
    // collection keeps pinned commits is in checkpoints-perf.test.ts)
    await release(bot, cwd, "dispatch-A");
    await release(bot, cwd, "dispatch-B");
    await churnUntilCollected(bot, cwd);
    expect(() => userGit(shadow, "cat-file", "-e", `${hashA}^{commit}`)).toThrow();
    expect(() => userGit(shadow, "cat-file", "-e", `${hashB}^{commit}`)).toThrow();
    // releasing twice, or a pin never taken, is harmless
    await release(bot, cwd, "dispatch-A");
    await release(bot, cwd, "never-pinned");
  }, process.platform === "win32" ? 60_000 : 20_000);

  it("sweeps pins a previous process left behind, on first use of the shadow", async () => {
    const { bot, cwd } = workspace();
    const shadow = shadowOf(bot, cwd);
    writeFileSync(join(cwd, "a.txt"), "crashed mid-turn");
    const leaked = await snapshot(bot, cwd, "turn X", undefined, { pin: "dispatch-X" });
    expect(userGit(shadow, "for-each-ref", "refs/omb-live/").trim()).toContain(leaked);
    // a new process: fresh module state (nothing swept yet), same test home
    vi.resetModules();
    const fresh = await import("./checkpoints.ts");
    expect(fresh.CHECKPOINTS_DIR).toBe(CHECKPOINTS_DIR);
    writeFileSync(join(cwd, "a.txt"), "next start");
    const next = await fresh.snapshot(bot, cwd, "turn Y");
    expect(next).not.toBe(leaked);
    expect(userGit(shadow, "for-each-ref", "refs/omb-live/").trim()).toBe("");
    // the swept pin makes that turn's collection due; it runs behind the
    // turn's settled diff
    expect(await fresh.diffWorkingTree(bot, cwd, next!)).toEqual({ changed: [], added: [], deleted: [] });
    await fresh.release(bot, cwd, "test-drain");
    expect(() => userGit(shadow, "cat-file", "-e", `${leaked}^{commit}`)).toThrow();
  });

  it("excludes tagged cache directories", async () => {
    const { bot, cwd } = workspace();
    const cache = join(cwd, "custom-target");
    mkdirSync(cache);
    writeFileSync(join(cwd, "a.txt"), "source");
    writeFileSync(join(cache, "artifact"), "old build");
    await snapshot(bot, cwd, "before cache tag");
    writeFileSync(join(cache, "CACHEDIR.TAG"), "Signature: 8a477f597d28d172789f06886806bc55\n");
    const latest = await snapshot(bot, cwd, "tagged cache");
    const shadow = join(CHECKPOINTS_DIR, bot,
      createHash("sha256").update(realpathSync(cwd)).digest("hex").slice(0, 16));
    expect(userGit(shadow, "ls-tree", "-r", "--name-only", latest!).trim()).toBe("a.txt");
  });

  it("never snapshots excluded or gitignored files", async () => {
    const { bot, cwd } = workspace();
    writeFileSync(join(cwd, "a.txt"), "one");
    writeFileSync(join(cwd, ".gitignore"), "secret.txt\n");
    writeFileSync(join(cwd, "secret.txt"), "user-ignored, not checkpointed");
    mkdirSync(join(cwd, "node_modules"));
    writeFileSync(join(cwd, "node_modules", "x.txt"), "installed dependency");
    writeFileSync(join(cwd, ".env"), "API_KEY=hunter2");
    writeFileSync(join(cwd, "run.log"), "log line");
    const checkpoint = await snapshot(bot, cwd, "turn 1");
    expect(userGit(shadowOf(bot, cwd), "ls-tree", "-r", "--name-only", checkpoint!).trim().split("\n")).toEqual([".gitignore", "a.txt"]);
  });

  it("compacts legacy history even when the workspace has not changed", async () => {
    const { bot, cwd } = workspace();
    writeFileSync(join(cwd, "a.txt"), "old");
    await snapshot(bot, cwd, "original");
    const shadow = join(CHECKPOINTS_DIR, bot,
      createHash("sha256").update(realpathSync(cwd)).digest("hex").slice(0, 16));
    for (const text of ["middle", "latest"]) {
      writeFileSync(join(cwd, "a.txt"), text);
      userGit(shadow, "--work-tree", cwd, "add", "-A");
      userGit(shadow, "commit", "-m", text);
    }
    expect(snapshotsIn(bot, cwd)).toHaveLength(3);
    const hash = await snapshot(bot, cwd, "unchanged");
    expect(snapshotsIn(bot, cwd)).toEqual([{ hash, label: "latest" }]);
    expect(userGit(shadow, "rev-list", "--count", "HEAD").trim()).toBe("2");
    expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("latest");
  });

  it.skipIf(process.platform === "win32")("keeps the last complete backup when a new snapshot cannot read a file", async () => {
    const { bot, cwd } = workspace();
    writeFileSync(join(cwd, "a.txt"), "recoverable");
    const first = await snapshot(bot, cwd, "complete");
    writeFileSync(join(cwd, "a.txt"), "unfinished");
    const locked = join(cwd, "locked.txt");
    writeFileSync(locked, "not readable");
    chmodSync(locked, 0o000);
    try {
      expect(await snapshot(bot, cwd, "incomplete")).toBeNull();
      expect(snapshotsIn(bot, cwd).map(c => c.hash)).toEqual([first]);
      expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("unfinished");
    } finally {
      chmodSync(locked, 0o600);
    }
  });

  it("never touches the user's folder itself (no .git appears in cwd)", async () => {
    const { bot, cwd } = workspace();
    writeFileSync(join(cwd, "a.txt"), "one");
    await snapshot(bot, cwd, "turn 1");
    expect(existsSync(join(cwd, ".git"))).toBe(false);
  });

  it("serializes concurrent snapshots instead of corrupting the shadow index", async () => {
    const { bot, cwd } = workspace();
    writeFileSync(join(cwd, "a.txt"), "one");
    const hashes = await Promise.all([
      snapshot(bot, cwd, "turn a"),
      snapshot(bot, cwd, "turn b"),
      snapshot(bot, cwd, "turn c"),
    ]);
    for (const hash of hashes) expect(hash).toMatch(/^[0-9a-f]{40}$/);
    // all three saw the same unchanged tree → all landed on one commit
    expect(new Set(hashes).size).toBe(1);
  });
});

describe("nested and user-owned git repos", () => {
  it("accepts a nested git repo as a gitlink and stays idempotent while it churns", async () => {
    const { bot, cwd } = workspace();
    writeFileSync(join(cwd, "a.txt"), "one");
    const nested = join(cwd, "lib");
    mkdirSync(nested);
    userGit(nested, "init");
    writeFileSync(join(nested, "inner.txt"), "inner");
    userGit(nested, "add", "-A");
    userGit(nested, "commit", "-m", "inner commit");
    const nestedHead = userGit(nested, "rev-parse", "HEAD").trim();

    const first = await snapshot(bot, cwd, "turn 1");
    expect(first).toMatch(/^[0-9a-f]{40}$/);
    // dirty nested work tree (tracked file modified, nested HEAD unmoved)
    // must not force a new outer checkpoint every turn
    writeFileSync(join(nested, "inner.txt"), "inner edited, uncommitted");
    const second = await snapshot(bot, cwd, "turn 2");
    expect(second).toBe(first);
    // the nested repo itself was never committed into or reset
    expect(userGit(nested, "rev-parse", "HEAD").trim()).toBe(nestedHead);
  });

  it("never touches the user's own repo when the workspace IS one", async () => {
    const { bot, cwd } = workspace();
    userGit(cwd, "init");
    writeFileSync(join(cwd, "a.txt"), "one");
    userGit(cwd, "add", "-A");
    userGit(cwd, "commit", "-m", "user's own commit");
    const userHead = userGit(cwd, "rev-parse", "HEAD").trim();

    const checkpoint = await snapshot(bot, cwd, "turn 1");
    expect(checkpoint).toMatch(/^[0-9a-f]{40}$/);
    writeFileSync(join(cwd, "a.txt"), "two");
    expect(await diffWorkingTree(bot, cwd, checkpoint!)).toEqual({ changed: ["a.txt"], added: [], deleted: [] });

    // the user's repository: HEAD unmoved, log intact, and the edit still
    // unstaged in the user's own index (the diff staged only the shadow's)
    expect(userGit(cwd, "rev-parse", "HEAD").trim()).toBe(userHead);
    expect(userGit(cwd, "log", "--format=%s").trim()).toBe("user's own commit");
    expect(userGit(cwd, "status", "--porcelain")).toBe(" M a.txt\n");
  });
});

describe("refusals", () => {
  it("refuses the home folder, protected folders, and missing paths", async () => {
    const { bot } = workspace();
    expect(refusalReason(homedir())).not.toBeNull();
    expect(refusalReason("/")).not.toBeNull();
    expect(refusalReason(join(homedir(), "Documents"))).not.toBeNull();
    expect(refusalReason(join(tmpdir(), "omb-ckpt-definitely-missing-xyz"))).not.toBeNull();
    expect(refusalReason("relative/path")).not.toBeNull();

    expect(await snapshot(bot, homedir(), "turn 1")).toBeNull();
    // refusal is a per-folder condition, not a failure: the bot still
    // snapshots a legitimate folder afterwards
    const { cwd } = workspace();
    writeFileSync(join(cwd, "a.txt"), "one");
    expect(await snapshot(bot, cwd, "turn 2")).toMatch(/^[0-9a-f]{40}$/);
  });

  it("refuses a symlink that resolves to the home folder", async () => {
    const { bot, cwd } = workspace();
    const linkedHome = join(cwd, "linked-home");
    symlinkSync(homedir(), linkedHome, process.platform === "win32" ? "junction" : "dir");

    expect(refusalReason(linkedHome)).toBe("checkpoints are not taken in the home folder");
    expect(await snapshot(bot, linkedHome, "turn 1")).toBeNull();
  });

  // Windows folder names are case-insensitive: every spelling below is the
  // same folder on disk. Only side-effect-free checks here — on a build that
  // missed the refusal, a snapshot would stage the whole home folder.
  it.runIf(process.platform === "win32")("refuses the home and protected folders in any Windows spelling", () => {
    expect(refusalReason(homedir().toLowerCase())).toBe("checkpoints are not taken in the home folder");
    expect(refusalReason(homedir().toUpperCase())).toBe("checkpoints are not taken in the home folder");
    for (const [name, spelling] of [["Desktop", "DESKTOP"], ["Documents", "documents"], ["Downloads", "DownLoads"]]) {
      // A machine without the folder answers "does not exist", also a refusal.
      const expected = existsSync(join(homedir(), name!))
        ? `checkpoints are not taken in the ${name} folder`
        : "the working folder does not exist";
      expect(refusalReason(join(homedir(), spelling!))).toBe(expected);
    }
    // The 8.3 alias of Documents, on volumes that keep short names.
    const shortDocuments = join(homedir(), "DOCUME~1");
    if (existsSync(shortDocuments) && existsSync(join(homedir(), "Documents"))) {
      expect(refusalReason(shortDocuments)).toBe("checkpoints are not taken in the Documents folder");
    }
  });
});

describe("diffWorkingTree", () => {
  it("names settled changes without replacing the pre-turn snapshot", async () => {
    const { bot, cwd } = workspace();
    writeFileSync(join(cwd, "keep.txt"), "same");
    writeFileSync(join(cwd, "edit.txt"), "before");
    writeFileSync(join(cwd, "gone.txt"), "bye");
    const before = await snapshot(bot, cwd, "turn aaaaaaaa");
    writeFileSync(join(cwd, "edit.txt"), "after");
    writeFileSync(join(cwd, "new.txt"), "hello");
    unlinkSync(join(cwd, "gone.txt"));
    expect(before).not.toBeNull();
    expect(await diffWorkingTree(bot, cwd, before!)).toEqual({
      changed: ["edit.txt"],
      added: ["new.txt"],
      deleted: ["gone.txt"],
    });
    expect(snapshotsIn(bot, cwd).map(c => c.hash)).toEqual([before]);
  });

  it("reports no changes and refuses protected folders", async () => {
    const { bot, cwd } = workspace();
    writeFileSync(join(cwd, "a.txt"), "one");
    const hash = await snapshot(bot, cwd, "turn bbbbbbbb");
    expect(await diffWorkingTree(bot, cwd, hash!)).toEqual({ changed: [], added: [], deleted: [] });
    expect(await diffWorkingTree(bot, homedir(), hash!)).toBeNull();
  });
});
