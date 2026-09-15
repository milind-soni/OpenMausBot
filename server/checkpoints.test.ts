// checkpoints.ts contract, exercised against REAL git in mkdtemp folders:
// snapshots are commits in a shadow repo (idempotent when nothing changed),
// restore moves the work tree back without moving HEAD (so a restore can be
// undone), excluded/ignored files are neither snapshotted nor deleted, a
// user's own git repo in the folder is never touched, and dangerous folders
// (home) are refused outright.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { removeTempDir } from "./testing/cleanup.ts";

// The module stores shadow repos under DATA_DIR, which config.ts reads from
// OMB_DATA_DIR at import time — so the env var must be set before the import
// is evaluated (same pattern as attachments.test.ts).
const DATA_ROOT = mkdtempSync(join(tmpdir(), "omb-checkpoints-"));
process.env.OMB_DATA_DIR = join(DATA_ROOT, "data");

const { checkpointsEnabled, listCheckpoints, refusalReason, restore, snapshot } = await import(
  "./checkpoints.ts"
);

const scratchDirs: string[] = [DATA_ROOT];
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
  it("creates a checkpoint commit and is idempotent while nothing changes", async () => {
    const { bot, cwd } = workspace();
    writeFileSync(join(cwd, "a.txt"), "one");
    const before = Date.now();
    const first = await snapshot(bot, cwd, "turn 11111111");
    expect(first).toMatch(/^[0-9a-f]{40}$/);

    // unchanged folder → same hash, no second commit
    const again = await snapshot(bot, cwd, "turn 22222222");
    expect(again).toBe(first);
    const unchanged = await listCheckpoints(bot, cwd);
    expect(unchanged).toHaveLength(1);
    expect(unchanged[0]).toMatchObject({ hash: first, label: "turn 11111111" });
    expect(unchanged[0]!.at).toBeGreaterThanOrEqual(before - 2000);
    expect(unchanged[0]!.at).toBeLessThanOrEqual(Date.now() + 2000);

    // a real change → a new checkpoint, newest first
    writeFileSync(join(cwd, "a.txt"), "two");
    const second = await snapshot(bot, cwd, "turn 33333333");
    expect(second).toMatch(/^[0-9a-f]{40}$/);
    expect(second).not.toBe(first);
    const list = await listCheckpoints(bot, cwd);
    expect(list.map((c) => c.label)).toEqual(["turn 33333333", "turn 11111111"]);
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

describe("restore", () => {
  it("rolls modified and newly created files back to the checkpoint, and can undo the rollback", async () => {
    const { bot, cwd } = workspace();
    writeFileSync(join(cwd, "a.txt"), "one");
    const checkpoint = await snapshot(bot, cwd, "turn 1");
    expect(checkpoint).not.toBeNull();

    // the "turn" edits a file and creates a brand-new untracked one
    writeFileSync(join(cwd, "a.txt"), "two");
    writeFileSync(join(cwd, "b.txt"), "made by the turn");

    const result = await restore(bot, cwd, checkpoint!);
    expect(result).toEqual({ ok: true });
    expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("one");
    expect(existsSync(join(cwd, "b.txt"))).toBe(false);

    // the pre-restore state became a checkpoint itself ("before restore"),
    // because HEAD never moved — so the restore is undoable
    const list = await listCheckpoints(bot, cwd);
    const safety = list.find((c) => c.label === "before restore");
    expect(safety).toBeDefined();
    expect(list.some((c) => c.label === `restored ${checkpoint!.slice(0, 8)}`)).toBe(true);
    const undo = await restore(bot, cwd, safety!.hash);
    expect(undo).toEqual({ ok: true });
    expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("two");
    expect(readFileSync(join(cwd, "b.txt"), "utf8")).toBe("made by the turn");
  });

  it("leaves excluded and gitignored files alone in both directions", async () => {
    const { bot, cwd } = workspace();
    writeFileSync(join(cwd, "a.txt"), "one");
    writeFileSync(join(cwd, ".gitignore"), "secret.txt\n");
    writeFileSync(join(cwd, "secret.txt"), "user-ignored, not checkpointed");
    mkdirSync(join(cwd, "node_modules"));
    writeFileSync(join(cwd, "node_modules", "x.txt"), "installed dependency");
    writeFileSync(join(cwd, ".env"), "API_KEY=hunter2");
    writeFileSync(join(cwd, "run.log"), "log line");
    const checkpoint = await snapshot(bot, cwd, "turn 1");

    writeFileSync(join(cwd, "a.txt"), "two");
    writeFileSync(join(cwd, "node_modules", "x.txt"), "changed by npm install");
    const result = await restore(bot, cwd, checkpoint!);
    expect(result).toEqual({ ok: true });

    expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("one");
    // excluded files: never snapshotted, so never reverted — and `git clean
    // -fd` (no -x) never deletes them either
    expect(readFileSync(join(cwd, "node_modules", "x.txt"), "utf8")).toBe("changed by npm install");
    expect(readFileSync(join(cwd, ".env"), "utf8")).toBe("API_KEY=hunter2");
    expect(readFileSync(join(cwd, "secret.txt"), "utf8")).toBe("user-ignored, not checkpointed");
    expect(existsSync(join(cwd, "run.log"))).toBe(true);
  });

  it.skipIf(process.platform === "win32")("refuses to restore when the safety checkpoint misses a path", async () => {
    const { bot, cwd } = workspace();
    writeFileSync(join(cwd, "a.txt"), "one");
    const checkpoint = await snapshot(bot, cwd, "turn 1");

    // Git cannot read this file, but `git clean` can still unlink it. The
    // safety snapshot may retain the ordinary edit; restore must stop before
    // clean can delete the path it missed.
    const locked = join(cwd, "locked.txt");
    writeFileSync(locked, "unreadable");
    chmodSync(locked, 0o000);
    writeFileSync(join(cwd, "a.txt"), "two");

    const result = await restore(bot, cwd, checkpoint!);
    expect(result).toEqual({
      ok: false,
      error: "restore stopped because some current files could not be added to the safety checkpoint",
    });
    expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("two");
    expect(existsSync(locked)).toBe(true);
  });

  it("refuses garbage hashes and the empty base marker", async () => {
    const { bot, cwd } = workspace();
    writeFileSync(join(cwd, "a.txt"), "one");
    await snapshot(bot, cwd, "turn 1");
    const bogus = await restore(bot, cwd, "0123456789abcdef0123456789abcdef01234567");
    expect(bogus.ok).toBe(false);
    const revspec = await restore(bot, cwd, "HEAD~1");
    expect(revspec.ok).toBe(false);
    // the folder is intact either way
    expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("one");
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
    await snapshot(bot, cwd, "turn 2");
    expect((await restore(bot, cwd, checkpoint!)).ok).toBe(true);
    expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("one");

    // the user's repository: HEAD unmoved, log intact, status clean (a.txt
    // is back at the committed content), reflog free of checkpoint commits
    expect(userGit(cwd, "rev-parse", "HEAD").trim()).toBe(userHead);
    expect(userGit(cwd, "log", "--format=%s").trim()).toBe("user's own commit");
    expect(userGit(cwd, "status", "--porcelain").trim()).toBe("");
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
    expect(await checkpointsEnabled(bot, homedir())).toBe(false);
    const result = await restore(bot, homedir(), "0123456789abcdef0123456789abcdef01234567");
    expect(result.ok).toBe(false);
    // refusal is a per-folder condition, not a failure: the bot is still
    // enabled in a legitimate folder afterwards
    const { cwd } = workspace();
    expect(await checkpointsEnabled(bot, cwd)).toBe(true);
  });

  it("refuses a symlink that resolves to the home folder", async () => {
    const { bot, cwd } = workspace();
    const linkedHome = join(cwd, "linked-home");
    symlinkSync(homedir(), linkedHome, process.platform === "win32" ? "junction" : "dir");

    expect(refusalReason(linkedHome)).toBe("checkpoints are not taken in the home folder");
    expect(await snapshot(bot, linkedHome, "turn 1")).toBeNull();
    expect(await checkpointsEnabled(bot, linkedHome)).toBe(false);
  });

  it("lists nothing (and creates nothing) for a folder never snapshotted", async () => {
    const { bot, cwd } = workspace();
    expect(await listCheckpoints(bot, cwd)).toEqual([]);
    const shadow = join(process.env.OMB_DATA_DIR!, "checkpoints", bot);
    expect(existsSync(shadow)).toBe(false);
  });
});

describe("diffStat", () => {
  it("names the files added, changed and deleted between two checkpoints", async () => {
    const { diffStat } = await import("./checkpoints.ts");
    const { bot, cwd } = workspace();
    writeFileSync(join(cwd, "keep.txt"), "same");
    writeFileSync(join(cwd, "edit.txt"), "before");
    writeFileSync(join(cwd, "gone.txt"), "bye");
    const before = await snapshot(bot, cwd, "turn aaaaaaaa");
    writeFileSync(join(cwd, "edit.txt"), "after");
    writeFileSync(join(cwd, "new.txt"), "hello");
    execFileSync("rm", [join(cwd, "gone.txt")]);
    const after = await snapshot(bot, cwd, "settle aaaaaaaa");
    expect(before).not.toBeNull();
    expect(after).not.toBeNull();
    expect(await diffStat(bot, cwd, before!, after!)).toEqual({
      changed: ["edit.txt"],
      added: ["new.txt"],
      deleted: ["gone.txt"],
    });
  });

  it("returns null when the two hashes are equal or the folder is refused", async () => {
    const { diffStat } = await import("./checkpoints.ts");
    const { bot, cwd } = workspace();
    writeFileSync(join(cwd, "a.txt"), "one");
    const hash = await snapshot(bot, cwd, "turn bbbbbbbb");
    expect(await diffStat(bot, cwd, hash!, hash!)).toBeNull();
    expect(await diffStat(bot, homedir(), hash!, hash!)).toBeNull();
  });
});
