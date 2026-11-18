import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

// Shadow repos live under DATA_DIR, which server/testing/setup.ts points at a disposable home before config.ts loads.
import { CHECKPOINTS_DIR, GC_EVERY_COMMITS, diffWorkingTree, prime, refusalReason, release, snapshot } from "./checkpoints.ts";
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

function snapshotsIn(bot: string, cwd: string): { hash: string; label: string }[] {
  const lines = userGit(shadowOf(bot, cwd), "log", "--format=%H%x09%s").split("\n").filter(Boolean);
  lines.pop(); // the root of the log is always the empty base marker
  return lines.map((line) => {
    const [hash, ...label] = line.split("\t");
    return { hash: hash!, label: label.join("\t") };
  });
}

/** release() queues behind the folder's operations, and releasing a pin never taken is a no-op. */
async function drain(bot: string, cwd: string): Promise<void> {
  await release(bot, cwd, "test-drain");
}

/** GC_EVERY_COMMITS changed snapshots make a collection due; a later snapshot or the last settled diff releases it. */
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

    const again = await snapshot(bot, cwd, "turn 22222222");
    expect(again).toBe(first);
    expect(snapshotsIn(bot, cwd)).toEqual([{ hash: first, label: "turn 11111111" }]);

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
    expect(() => userGit(shadow, "cat-file", "-e", oldBlob)).not.toThrow();
    expect(await diffWorkingTree(bot, cwd, latest!)).toEqual({ changed: [], added: [], deleted: [] });
    await drain(bot, cwd);
    expect(snapshotsIn(bot, cwd).map(c => c.hash)).toEqual([latest]);
    expect(() => userGit(shadow, "cat-file", "-e", oldBlob)).toThrow();
    expect(userGit(shadow, "cat-file", "-p", `${latest}:a.txt`)).toBe("latest payload");
  });

  // Each case below is one where an incremental `add -A` alone would differ from a from-empty rebuild.

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

  // A full 25-commit GC cycle with real git subprocesses: Windows process startup can exhaust the default limit.
  it("keeps a pinned pre-turn commit through a sibling turn's snapshot until it is released", async () => {
    const { bot, cwd } = workspace();
    const shadow = shadowOf(bot, cwd);
    writeFileSync(join(cwd, "a.txt"), "before A");
    const hashA = await snapshot(bot, cwd, "turn A", undefined, { pin: "dispatch-A" });
    writeFileSync(join(cwd, "a.txt"), "A edited");
    const hashB = await snapshot(bot, cwd, "turn B", undefined, { pin: "dispatch-B" });
    expect(hashB).not.toBe(hashA);
    expect(snapshotsIn(bot, cwd).map(c => c.hash)).toEqual([hashB]);
    expect(await diffWorkingTree(bot, cwd, hashA!)).toEqual({ changed: ["a.txt"], added: [], deleted: [] });
    expect(() => userGit(shadow, "cat-file", "-e", `${hashA}^{commit}`)).not.toThrow();
    expect(() => userGit(shadow, "cat-file", "-e", `${hashB}^{commit}`)).not.toThrow();
    await release(bot, cwd, "dispatch-A");
    await release(bot, cwd, "dispatch-B");
    await churnUntilCollected(bot, cwd);
    expect(() => userGit(shadow, "cat-file", "-e", `${hashA}^{commit}`)).toThrow();
    expect(() => userGit(shadow, "cat-file", "-e", `${hashB}^{commit}`)).toThrow();
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
    mkdirSync(join(cwd, ".openmausbot-secrets", "thread-1"), { recursive: true });
    writeFileSync(join(cwd, ".openmausbot-secrets", "thread-1", "card-1"), "sk_secret_file");
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
    writeFileSync(join(nested, "inner.txt"), "inner edited, uncommitted");
    const second = await snapshot(bot, cwd, "turn 2");
    expect(second).toBe(first);
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

  // Windows folder names are case-insensitive. Side-effect-free checks only: a missed refusal would stage the whole home.
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

describe("prime", () => {
  it("reads the folder ahead of a turn without moving the last snapshot, and the turn still snapshots what it finds", async () => {
    const { bot, cwd } = workspace();
    const shadow = shadowOf(bot, cwd);
    writeFileSync(join(cwd, "a.txt"), "before the last turn");
    const last = await snapshot(bot, cwd, "last turn");
    writeFileSync(join(cwd, "a.txt"), "after the last turn");
    writeFileSync(join(cwd, "b.txt"), "made by the last turn");
    expect(await prime(bot, cwd)).toBe(true);
    // The state before the last turn is still the newest snapshot, and nothing is pinned.
    expect(snapshotsIn(bot, cwd).map(c => c.hash)).toEqual([last]);
    expect(userGit(shadow, "show", `${last}:a.txt`)).toBe("before the last turn");
    expect(userGit(shadow, "for-each-ref", "refs/omb-live/").trim()).toBe("");
    // The person edits the folder outside the app, after the folder was read.
    writeFileSync(join(cwd, "a.txt"), "edited outside the app");
    const turn = await snapshot(bot, cwd, "next turn", undefined, { pin: "dispatch-P" });
    expect(userGit(shadow, "show", `${turn}:a.txt`)).toBe("edited outside the app");
    expect(userGit(shadow, "show", `${turn}:b.txt`)).toBe("made by the last turn");
    writeFileSync(join(cwd, "a.txt"), "edited by the turn");
    expect(await diffWorkingTree(bot, cwd, turn!)).toEqual({ changed: ["a.txt"], added: [], deleted: [] });
    await release(bot, cwd, "dispatch-P");
  });

  it("reads a folder no turn has run in, and that folder's first turn is checkpointed as the turn found it", async () => {
    const { bot, cwd } = workspace();
    const shadow = shadowOf(bot, cwd);
    mkdirSync(join(cwd, "src"));
    for (let n = 0; n < 40; n += 1) writeFileSync(join(cwd, "src", `file${n}.txt`), `file ${n}`);
    expect(await prime(bot, cwd)).toBe(true);
    expect(snapshotsIn(bot, cwd)).toEqual([]);
    writeFileSync(join(cwd, "src", "file0.txt"), "edited before the first message");
    const first = await snapshot(bot, cwd, "first turn", undefined, { pin: "dispatch-Q" });
    expect(userGit(shadow, "show", `${first}:src/file0.txt`)).toBe("edited before the first message");
    expect(userGit(shadow, "ls-tree", "-r", "--name-only", first!).trim().split("\n")).toHaveLength(40);
    unlinkSync(join(cwd, "src", "file1.txt"));
    expect(await diffWorkingTree(bot, cwd, first!)).toEqual({ changed: [], added: [], deleted: ["src/file1.txt"] });
    await release(bot, cwd, "dispatch-Q");
  });

  it("stopped before it ends, or refused, changes nothing for the turns after it", async () => {
    const { bot, cwd } = workspace();
    const shadow = shadowOf(bot, cwd);
    for (let n = 0; n < 200; n += 1) writeFileSync(join(cwd, `file${n}.txt`), `file ${n}`);
    const stopped = new AbortController();
    const reading = prime(bot, cwd, stopped.signal);
    // A message sent while the folder is still being read waits for that read, never beside it.
    const sent = snapshot(bot, cwd, "sent while reading", undefined, { pin: "dispatch-R" });
    stopped.abort();
    expect(await reading).toBe(false);
    const turn = await sent;
    expect(turn).toMatch(/^[0-9a-f]{40}$/);
    expect(userGit(shadow, "ls-tree", "-r", "--name-only", turn!).trim().split("\n")).toHaveLength(200);
    expect(existsSync(join(shadow, ".git", "index.lock"))).toBe(false);
    await release(bot, cwd, "dispatch-R");
    expect(await prime(bot, homedir())).toBe(false);
    expect(await prime(bot, join(cwd, "missing"))).toBe(false);
  });

  it("puts a new folder's files into a pack, so the first snapshot leaves nothing to collect", async () => {
    const { bot, cwd } = workspace();
    const shadow = shadowOf(bot, cwd);
    for (let n = 0; n < 300; n += 1) writeFileSync(join(cwd, `file${n}.txt`), `file ${n} `.repeat(40));
    const first = await snapshot(bot, cwd, "first turn");
    await drain(bot, cwd);
    const counted = userGit(shadow, "count-objects", "-v");
    expect(Number(/^in-pack: (\d+)$/m.exec(counted)?.[1])).toBeGreaterThanOrEqual(300);
    expect(Number(/^count: (\d+)$/m.exec(counted)?.[1])).toBeLessThan(20);
    expect(userGit(shadow, "show", `${first}:file299.txt`)).toBe("file 299 ".repeat(40));
    // Later edits go in as single objects again.
    writeFileSync(join(cwd, "file0.txt"), "edited");
    const second = await snapshot(bot, cwd, "second turn");
    expect(userGit(shadow, "show", `${second}:file0.txt`)).toBe("edited");
    expect(Number(/^packs: (\d+)$/m.exec(userGit(shadow, "count-objects", "-v"))?.[1])).toBe(1);
  });
});

describe("a restart in the middle of a snapshot", () => {
  it("finds the index locked by the git it cut off, and checkpoints the next turns on a copy", async () => {
    const { bot, cwd } = workspace();
    const shadow = shadowOf(bot, cwd);
    writeFileSync(join(cwd, "a.txt"), "before the restart");
    writeFileSync(join(cwd, "b.txt"), "kept");
    await snapshot(bot, cwd, "turn X");
    // What a git that was killed, or is still running after its server died, leaves on the index.
    writeFileSync(join(shadow, ".git", "index.lock"), "");
    for (const round of ["first start", "second start"]) {
      vi.resetModules();
      const fresh = await import("./checkpoints.ts");
      writeFileSync(join(cwd, "a.txt"), round);
      const turn = await fresh.snapshot(bot, cwd, round, undefined, { pin: `dispatch-${round}` });
      expect(turn).toMatch(/^[0-9a-f]{40}$/);
      expect(userGit(shadow, "show", `${turn}:a.txt`)).toBe(round);
      expect(userGit(shadow, "show", `${turn}:b.txt`)).toBe("kept");
      writeFileSync(join(cwd, "b.txt"), `edited after ${round}`);
      expect(await fresh.diffWorkingTree(bot, cwd, turn!)).toEqual({ changed: ["b.txt"], added: [], deleted: [] });
      writeFileSync(join(cwd, "b.txt"), "kept");
      await fresh.release(bot, cwd, `dispatch-${round}`);
    }
    // The lock was never this process's to remove; the index it guards is no longer anyone's, and git's own check passes.
    expect(existsSync(join(shadow, ".git", "index.lock"))).toBe(true);
    expect(existsSync(join(shadow, ".git", "index"))).toBe(false);
    expect(() => userGit(shadow, "fsck", "--connectivity-only", "--no-dangling")).not.toThrow();
  });

  it("finds a shadow git never finished making, and makes it again", async () => {
    const { bot, cwd } = workspace();
    const other = workspace();
    const shadow = shadowOf(bot, cwd);
    writeFileSync(join(cwd, "a.txt"), "one");
    writeFileSync(join(other.cwd, "a.txt"), "one");
    // What `git init` leaves when it is ended while writing its config.
    mkdirSync(join(shadow, ".git", "refs"), { recursive: true });
    writeFileSync(join(shadow, ".git", "config"), "[core]\n");
    writeFileSync(join(shadow, ".git", "config.lock"), "[core]\n");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const first = await snapshot(bot, cwd, "first turn", undefined, { pin: "dispatch-H" });
    expect(first).toMatch(/^[0-9a-f]{40}$/);
    expect(userGit(shadow, "show", `${first}:a.txt`)).toBe("one");
    expect(await snapshot(bot, other.cwd, "the same bot elsewhere")).toMatch(/^[0-9a-f]{40}$/);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
    await release(bot, cwd, "dispatch-H");
  });

  it("checkpoints a folder's first turn whenever the read-ahead before it was stopped", async () => {
    for (let delay = 0; delay < 24; delay += 2) {
      const { bot, cwd } = workspace();
      for (let n = 0; n < 30; n += 1) writeFileSync(join(cwd, `file${n}.txt`), `file ${n}`);
      const stopped = new AbortController();
      const reading = prime(bot, cwd, stopped.signal);
      setTimeout(() => stopped.abort(), delay);
      await reading;
      const first = await snapshot(bot, cwd, "first turn");
      expect(first, `stopped after ${delay} ms`).toMatch(/^[0-9a-f]{40}$/);
      expect(userGit(shadowOf(bot, cwd), "ls-tree", "-r", "--name-only", first!).trim().split("\n")).toHaveLength(30);
    }
  }, 60_000);

  it("clears the locks a git ended by force left on the shadow's refs and config, once they are too old to be held", async () => {
    for (const lock of ["HEAD.lock", join("refs", "heads", "main.lock"), "packed-refs.lock", "config.lock"]) {
      const { bot, cwd } = workspace();
      const shadow = shadowOf(bot, cwd);
      writeFileSync(join(cwd, "a.txt"), "one");
      const leaked = await snapshot(bot, cwd, "turn X", undefined, { pin: "dispatch-X" });
      await drain(bot, cwd);
      userGit(shadow, "pack-refs", "--all", "--prune");
      const path = join(shadow, ".git", lock);
      writeFileSync(path, "");
      const longAgo = new Date(Date.now() - 60_000);
      utimesSync(path, longAgo, longAgo);
      vi.resetModules();
      const fresh = await import("./checkpoints.ts");
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      writeFileSync(join(cwd, "a.txt"), "next start");
      const next = await fresh.snapshot(bot, cwd, "turn Y", undefined, { pin: "dispatch-Y" });
      expect(next, lock).toMatch(/^[0-9a-f]{40}$/);
      // The pin the last process left was swept, and this turn's pin is released.
      expect(userGit(shadow, "for-each-ref", "--format=%(objectname)", "refs/omb-live/").trim(), lock).toBe(next);
      expect(next).not.toBe(leaked);
      await fresh.release(bot, cwd, "dispatch-Y");
      expect(userGit(shadow, "for-each-ref", "refs/omb-live/").trim(), lock).toBe("");
      expect(existsSync(path), lock).toBe(false);
      expect(warn, lock).not.toHaveBeenCalled();
      warn.mockRestore();
    }
  }, 60_000);

  it("writes nothing while a collection its last server left running could still prune it", async () => {
    const { bot, cwd } = workspace();
    const shadow = shadowOf(bot, cwd);
    writeFileSync(join(cwd, "a.txt"), "one");
    await snapshot(bot, cwd, "turn X");
    await drain(bot, cwd);
    // A collection that prunes everything unreachable up to this second was running when the server died.
    const pruning = Math.floor(Date.now() / 1000);
    writeFileSync(join(shadow, ".git", "omb-collecting"), String(pruning));
    vi.resetModules();
    const fresh = await import("./checkpoints.ts");
    writeFileSync(join(cwd, "a.txt"), "next start");
    const next = await fresh.snapshot(bot, cwd, "turn Y");
    const blob = userGit(shadow, "rev-parse", `${next}:a.txt`).trim();
    const written = statSync(join(shadow, ".git", "objects", blob.slice(0, 2), blob.slice(2))).mtimeMs;
    expect(Math.floor(written / 1000)).toBeGreaterThan(pruning);
    expect(existsSync(join(shadow, ".git", "omb-collecting"))).toBe(false);
    // That collection, ending now, takes nothing written since: not even what no snapshot names yet.
    writeFileSync(join(cwd, "staged.txt"), "read ahead, in no snapshot yet");
    const unnamed = userGit(shadow, "hash-object", "-w", join(cwd, "staged.txt")).trim();
    userGit(shadow, "gc", "--quiet", `--prune=${pruning}`);
    expect(userGit(shadow, "cat-file", "-p", unnamed)).toBe("read ahead, in no snapshot yet");
    expect(userGit(shadow, "show", `${next}:a.txt`)).toBe("next start");
  });

  it("keeps a shadow whose snapshots sit on a branch of another name", async () => {
    const { bot, cwd } = workspace();
    const shadow = shadowOf(bot, cwd);
    writeFileSync(join(cwd, "a.txt"), "one");
    const kept = await snapshot(bot, cwd, "turn X");
    await drain(bot, cwd);
    userGit(shadow, "branch", "-m", "main", "trunk");
    vi.resetModules();
    const fresh = await import("./checkpoints.ts");
    expect(await fresh.snapshot(bot, cwd, "turn Y")).toBe(kept);
    expect(userGit(shadow, "show", `${kept}:a.txt`)).toBe("one");
  });

  it("reads the folder again when the index names an object the shadow has lost", async () => {
    const { bot, cwd } = workspace();
    const shadow = shadowOf(bot, cwd);
    writeFileSync(join(cwd, "a.txt"), "one");
    writeFileSync(join(cwd, "b.txt"), "kept");
    const before = await snapshot(bot, cwd, "turn X");
    await drain(bot, cwd);
    writeFileSync(join(cwd, "a.txt"), "staged, then pruned");
    // Older than the index, so git takes the staged entry as current and does not write the file's object again.
    const earlier = new Date(Date.now() - 60_000);
    utimesSync(join(cwd, "a.txt"), earlier, earlier);
    expect(await diffWorkingTree(bot, cwd, before!)).toEqual({ changed: ["a.txt"], added: [], deleted: [] });
    const lost = userGit(cwd, "hash-object", join(cwd, "a.txt")).trim();
    rmSync(join(shadow, ".git", "objects", lost.slice(0, 2), lost.slice(2)));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const next = await snapshot(bot, cwd, "turn Y");
    expect(next).toMatch(/^[0-9a-f]{40}$/);
    expect(userGit(shadow, "show", `${next}:a.txt`)).toBe("staged, then pruned");
    expect(userGit(shadow, "show", `${next}:b.txt`)).toBe("kept");
    expect(() => userGit(shadow, "fsck", "--connectivity-only", "--no-dangling", next!)).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("a collection cut short", () => {
  it("by the next turn's snapshot leaves HEAD, the running turn's commit and every object they need readable", async () => {
    const { bot, cwd } = workspace();
    const shadow = shadowOf(bot, cwd);
    for (let d = 0; d < 20; d += 1) {
      mkdirSync(join(cwd, `dir${d}`));
      for (let f = 0; f < 50; f += 1) writeFileSync(join(cwd, `dir${d}`, `file${f}.txt`), `dir ${d} file ${f}\n`.repeat(20));
    }
    const running = await snapshot(bot, cwd, "a turn still running", undefined, { pin: "dispatch-S" });
    let last: string | null = null;
    for (let turn = 0; turn < GC_EVERY_COMMITS; turn += 1) {
      for (let f = 0; f < 50; f += 1) writeFileSync(join(cwd, "dir0", `file${f}.txt`), `turn ${turn} file ${f}\n`.repeat(20));
      last = await snapshot(bot, cwd, `churn ${turn}`);
    }
    // The settled diff lets the collection start; the next message arrives while it runs.
    await diffWorkingTree(bot, cwd, last!);
    writeFileSync(join(cwd, "dir1", "file0.txt"), "the next turn's folder");
    const next = await snapshot(bot, cwd, "next turn", undefined, { pin: "dispatch-T" });
    expect(userGit(shadow, "rev-parse", "HEAD").trim()).toBe(next);
    expect(userGit(shadow, "show", `${next}:dir1/file0.txt`)).toBe("the next turn's folder");
    expect(userGit(shadow, "show", `${running}:dir0/file0.txt`)).toBe("dir 0 file 0\n".repeat(20));
    expect(() => userGit(shadow, "fsck", "--connectivity-only", "--no-dangling")).not.toThrow();
    expect(await diffWorkingTree(bot, cwd, next!)).toEqual({ changed: [], added: [], deleted: [] });
    await release(bot, cwd, "dispatch-T");
    await drain(bot, cwd);
    // The collection ran to its end behind that turn: the running turn's commit is still held by its pin.
    expect(userGit(shadow, "show", `${running}:dir0/file0.txt`)).toBe("dir 0 file 0\n".repeat(20));
    expect(() => userGit(shadow, "cat-file", "-e", `${last}^{commit}`)).toThrow();
    expect(() => userGit(shadow, "fsck", "--connectivity-only", "--no-dangling")).not.toThrow();
    await release(bot, cwd, "dispatch-S");
  }, process.platform === "win32" ? 120_000 : 60_000);
});
