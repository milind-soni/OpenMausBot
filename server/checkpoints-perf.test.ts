// checkpoints.ts cost contract: the shadow index stays incremental (a
// case-only rename rebuilds it once, found from folder listings read without
// blocking the event loop), GC is throttled and runs behind the turn's settled
// diff (or, when a turn settled without one, ahead of the next snapshot), and
// a git timeout switches only that bot+folder off (one log line, later turns
// skip without spawning git). Real git does the work; execFile is wrapped
// only to record calls and to inject a timeout or object counts, readdirSync
// only to record calls.
import { createHash } from "node:crypto";
import { execFile as realExecFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

// Shadow repos live under DATA_DIR, which server/testing/setup.ts points at a
// disposable test home before any test module imports config.ts.
import { CHECKPOINTS_DIR, diffWorkingTree, release, snapshot } from "./checkpoints.ts";
import { removeTempDir } from "./testing/cleanup.ts";

type Injected = { error: Error; stdout?: string; stderr?: string } | { stdout: string };
const hooks = vi.hoisted(() => ({
  calls: [] as string[][],
  inject: null as null | ((args: string[]) => Injected | undefined),
  readdirSync: [] as string[],
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const readdirSync = ((path: Parameters<typeof actual.readdirSync>[0], ...rest: unknown[]) => {
    hooks.readdirSync.push(String(path));
    return (actual.readdirSync as (...args: unknown[]) => unknown)(path, ...rest);
  }) as typeof actual.readdirSync;
  return { ...actual, readdirSync, default: { ...actual, readdirSync } };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const execFile = (file: string, args: string[], options: object, callback: (...rest: unknown[]) => void) => {
    if (file === "git") {
      hooks.calls.push(args);
      const injected = hooks.inject?.(args);
      if (injected) {
        setImmediate(() => callback("error" in injected ? injected.error : null, injected.stdout ?? "", "stderr" in injected ? injected.stderr ?? "" : ""));
        return {};
      }
    }
    return actual.execFile(file, args, options, callback);
  };
  return { ...actual, execFile };
});

const scratchDirs: string[] = [];
afterAll(async () => {
  for (const dir of scratchDirs) await removeTempDir(dir);
});
afterEach(() => {
  hooks.inject = null;
  hooks.calls = [];
  hooks.readdirSync = [];
  vi.restoreAllMocks();
});

let seq = 0;
function workspace() {
  const cwd = mkdtempSync(join(tmpdir(), "omb-ckpt-perf-ws-"));
  scratchDirs.push(cwd);
  seq += 1;
  return { bot: `ckpt-perf-bot-${seq}`, cwd };
}

/** Plain git on the folder's shadow repo; drain() first so no queued GC is
 * running. */
function shadowGit(bot: string, cwd: string, ...args: string[]): string {
  const shadow = join(CHECKPOINTS_DIR, bot, createHash("sha256").update(realpathSync(cwd)).digest("hex").slice(0, 16));
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, GIT_DIR: join(shadow, ".git") } });
}

/** The shadow repo's snapshot hashes, newest first, without the empty base marker. */
function snapshotHashes(bot: string, cwd: string): string[] {
  const hashes = shadowGit(bot, cwd, "log", "--format=%H").split("\n").filter(Boolean);
  hashes.pop(); // the root of the log is always the empty base marker
  return hashes;
}

function commitExists(bot: string, cwd: string, hash: string): boolean {
  try {
    shadowGit(bot, cwd, "cat-file", "-e", `${hash}^{commit}`);
    return true;
  } catch {
    return false;
  }
}

/** Wait for every operation queued on the folder's shadow repo (release()
 * queues behind them; releasing a pin never taken is a no-op). */
async function drain(bot: string, cwd: string): Promise<void> {
  await release(bot, cwd, "test-drain");
}

/** Exactly what Node's execFile hands back when its `timeout` kills git. */
function timeoutError(command: string): Error {
  return Object.assign(new Error(`Command failed: git ${command}`), { killed: true, signal: "SIGTERM", code: null });
}

const subcommands = () => hooks.calls.map(args => args[0]);

/** `git count-objects -v` output; sizes in KiB. */
function countObjects({ count = 0, size = 0, sizePack = 0 }: { count?: number; size?: number; sizePack?: number }): string {
  return `count: ${count}\nsize: ${size}\nin-pack: 0\npacks: ${sizePack ? 1 : 0}\nsize-pack: ${sizePack}\nprune-packable: 0\ngarbage: 0\nsize-garbage: 0\n`;
}

/** Is the temp volume case-insensitive (macOS default APFS, NTFS)? */
const caseInsensitiveTmp = (() => {
  const probe = mkdtempSync(join(tmpdir(), "omb-ckpt-perf-case-"));
  scratchDirs.push(probe);
  writeFileSync(join(probe, "probe"), "");
  return existsSync(join(probe, "PROBE"));
})();

describe("incremental shadow index", () => {
  it("re-snapshots an unchanged 3,000-file tree without rebuilding the index or collecting", async () => {
    const { bot, cwd } = workspace();
    for (let d = 0; d < 60; d += 1) {
      mkdirSync(join(cwd, `dir${d}`));
      for (let f = 0; f < 50; f += 1) writeFileSync(join(cwd, `dir${d}`, `file${f}.txt`), `dir ${d} file ${f}\n`.repeat(20));
    }
    const first = await snapshot(bot, cwd, "first");
    expect(first).toMatch(/^[0-9a-f]{40}$/);
    await drain(bot, cwd);
    hooks.calls = [];
    const steady = await snapshot(bot, cwd, "steady");
    expect(steady).toBe(first);
    expect(subcommands()).not.toContain("read-tree");
    expect(subcommands()).not.toContain("gc");
    expect(subcommands()).not.toContain("reflog");
    expect(subcommands().filter(command => command === "add")).toHaveLength(1);
    // the settled-diff path is incremental too
    hooks.calls = [];
    expect(await diffWorkingTree(bot, cwd, first!)).toEqual({ changed: [], added: [], deleted: [] });
    expect(subcommands()).not.toContain("read-tree");
  });

  it("falls back to a full rebuild when the index cannot be listed", async () => {
    const { bot, cwd } = workspace();
    writeFileSync(join(cwd, "a.txt"), "one");
    const first = await snapshot(bot, cwd, "first");
    writeFileSync(join(cwd, "a.txt"), "two");
    hooks.inject = args => args[0] === "ls-files" && args.includes("--stage")
      ? { error: Object.assign(new Error("stdout maxBuffer length exceeded"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }) }
      : undefined;
    hooks.calls = [];
    const second = await snapshot(bot, cwd, "second");
    expect(second).toMatch(/^[0-9a-f]{40}$/);
    expect(second).not.toBe(first);
    expect(subcommands()).toContain("read-tree");
    // not a failure: the bot keeps snapshotting
    hooks.inject = null;
    writeFileSync(join(cwd, "a.txt"), "three");
    expect(await snapshot(bot, cwd, "third")).toMatch(/^[0-9a-f]{40}$/);
  });

  it("collects early once loose objects pass the threshold, and not otherwise", async () => {
    const { bot, cwd } = workspace();
    writeFileSync(join(cwd, "a.txt"), "one");
    await snapshot(bot, cwd, "first");
    writeFileSync(join(cwd, "a.txt"), "two");
    hooks.calls = [];
    const below = await snapshot(bot, cwd, "below threshold");
    await diffWorkingTree(bot, cwd, below!);
    await drain(bot, cwd);
    expect(subcommands()).toContain("count-objects");
    expect(subcommands()).not.toContain("gc");

    hooks.inject = args => args[0] === "count-objects" ? { stdout: countObjects({ count: 7000, size: 28000 }) } : undefined;
    writeFileSync(join(cwd, "a.txt"), "three");
    hooks.calls = [];
    const hash = await snapshot(bot, cwd, "over threshold");
    await diffWorkingTree(bot, cwd, hash!);
    await drain(bot, cwd);
    expect(subcommands()).toEqual(expect.arrayContaining(["reflog", "gc"]));
    expect(snapshotHashes(bot, cwd)).toEqual([hash]);
  });

  it("collects once 256 MiB of new object data piles up, but not for a big live snapshot alone", async () => {
    const { bot, cwd } = workspace();
    let counts = countObjects({ count: 5, size: 100, sizePack: 400_000 });
    hooks.inject = args => args[0] === "count-objects" ? { stdout: counts } : undefined;
    const turn = async (text: string) => {
      writeFileSync(join(cwd, "a.txt"), text);
      hooks.calls = [];
      const hash = await snapshot(bot, cwd, text);
      expect(hash).toMatch(/^[0-9a-f]{40}$/);
      await diffWorkingTree(bot, cwd, hash!);
      await drain(bot, cwd);
      expect(subcommands()).toContain("count-objects");
      return subcommands().includes("gc");
    };
    // a 400 MiB pack is the live snapshot, not garbage
    expect(await turn("one")).toBe(false);
    expect(await turn("two")).toBe(false);
    // loose data is all new since the last collection
    counts = countObjects({ count: 5, size: 270_000, sizePack: 400_000 });
    expect(await turn("three")).toBe(true);
    counts = countObjects({ count: 5, size: 10, sizePack: 400_000 });
    expect(await turn("four")).toBe(false);
    // so is pack growth (big files are streamed straight into new packs)
    counts = countObjects({ count: 5, size: 10, sizePack: 700_000 });
    expect(await turn("five")).toBe(true);
  });

  it("runs a due collection behind that turn's settled diff, never ahead of it or inside the snapshot", async () => {
    const { bot, cwd } = workspace();
    writeFileSync(join(cwd, "a.txt"), "one");
    await snapshot(bot, cwd, "first");
    hooks.inject = args => args[0] === "count-objects" ? { stdout: countObjects({ count: 7000 }) } : undefined;
    writeFileSync(join(cwd, "a.txt"), "two");
    hooks.calls = [];
    const before = await snapshot(bot, cwd, "collection due");
    hooks.inject = null;
    expect(subcommands()).not.toContain("gc");
    // the turn writes a file; its settled diff must not queue behind GC
    writeFileSync(join(cwd, "b.txt"), "made by the turn");
    expect(await diffWorkingTree(bot, cwd, before!)).toEqual({ changed: [], added: ["b.txt"], deleted: [] });
    await drain(bot, cwd);
    const settledDiff = hooks.calls.findIndex(args => args[0] === "diff" && args.includes("--name-status"));
    expect(settledDiff).toBeGreaterThanOrEqual(0);
    expect(subcommands().indexOf("reflog")).toBeGreaterThan(settledDiff);
    expect(subcommands().indexOf("gc")).toBeGreaterThan(settledDiff);
    expect(snapshotHashes(bot, cwd)).toEqual([before]);
  });

  it("runs a collection left by a turn without a diff ahead of the next snapshot, once", async () => {
    const { bot, cwd } = workspace();
    writeFileSync(join(cwd, "a.txt"), "one");
    await snapshot(bot, cwd, "first");
    // loose objects stay over the threshold until a gc has actually run
    hooks.inject = args => args[0] === "count-objects" && !subcommands().includes("gc") ? { stdout: countObjects({ count: 7000 }) } : undefined;
    writeFileSync(join(cwd, "a.txt"), "two");
    await snapshot(bot, cwd, "collection due"); // this turn settles without a diff
    await drain(bot, cwd);
    expect(subcommands()).not.toContain("gc");
    hooks.calls = [];
    writeFileSync(join(cwd, "a.txt"), "three");
    const next = await snapshot(bot, cwd, "next turn");
    const collected = subcommands().indexOf("gc");
    expect(collected).toBeGreaterThanOrEqual(0);
    expect(subcommands().indexOf("reflog")).toBeLessThan(collected);
    // ahead of the snapshot's own staging, not behind it
    expect(subcommands().indexOf("add")).toBeGreaterThan(collected);
    writeFileSync(join(cwd, "b.txt"), "made by the turn");
    expect(await diffWorkingTree(bot, cwd, next!)).toEqual({ changed: [], added: ["b.txt"], deleted: [] });
    await drain(bot, cwd);
    expect(subcommands().filter(command => command === "gc")).toHaveLength(1);
    expect(snapshotHashes(bot, cwd)).toEqual([next]);
  });

  it("keeps a pinned commit through a collection and reclaims it once released", async () => {
    const { bot, cwd } = workspace();
    const collectionDue = () => {
      hooks.inject = args => args[0] === "count-objects" ? { stdout: countObjects({ count: 7000 }) } : undefined;
    };
    writeFileSync(join(cwd, "a.txt"), "before A");
    const hashA = await snapshot(bot, cwd, "turn A", undefined, { pin: "dispatch-A" });
    // a sibling thread's turn starts while A runs; its collection falls due
    writeFileSync(join(cwd, "a.txt"), "A edited");
    collectionDue();
    hooks.calls = [];
    const hashB = await snapshot(bot, cwd, "turn B", undefined, { pin: "dispatch-B" });
    hooks.inject = null;
    // A ends first: its diff still finds its pre-turn commit, and the
    // collection queued behind that diff keeps it
    expect(await diffWorkingTree(bot, cwd, hashA!)).toEqual({ changed: ["a.txt"], added: [], deleted: [] });
    await release(bot, cwd, "dispatch-A");
    await drain(bot, cwd);
    expect(subcommands()).toContain("gc");
    expect(commitExists(bot, cwd, hashA!)).toBe(true); // not HEAD: only the pin kept it
    // B ends; the next collection reclaims both
    await release(bot, cwd, "dispatch-B");
    writeFileSync(join(cwd, "a.txt"), "turn C");
    collectionDue();
    hooks.calls = [];
    const hashC = await snapshot(bot, cwd, "turn C");
    hooks.inject = null;
    await diffWorkingTree(bot, cwd, hashC!);
    await drain(bot, cwd);
    expect(subcommands()).toContain("gc");
    expect(commitExists(bot, cwd, hashA!)).toBe(false);
    expect(commitExists(bot, cwd, hashB!)).toBe(false);
    expect(snapshotHashes(bot, cwd)).toEqual([hashC]);
  });
});

describe.runIf((process.platform === "darwin" || process.platform === "win32") && caseInsensitiveTmp)("case-only renames", () => {
  it("rebuilds the shadow index once for a case-only rename, then stays incremental", async () => {
    const { bot, cwd } = workspace();
    mkdirSync(join(cwd, "dir"));
    for (let f = 0; f < 20; f += 1) writeFileSync(join(cwd, "dir", `file${f}.txt`), `file ${f}`);
    await snapshot(bot, cwd, "first");
    hooks.calls = [];
    await snapshot(bot, cwd, "unchanged");
    expect(subcommands()).not.toContain("read-tree");
    renameSync(join(cwd, "dir", "file7.txt"), join(cwd, "dir", "FILE7.txt"));
    hooks.calls = [];
    await snapshot(bot, cwd, "renamed");
    expect(subcommands()).toContain("read-tree");
    hooks.calls = [];
    await snapshot(bot, cwd, "after rename");
    expect(subcommands()).not.toContain("read-tree");
  });

  it("reads folder listings without blocking the event loop (no readdirSync)", async () => {
    const { bot, cwd } = workspace();
    for (let d = 0; d < 5; d += 1) {
      mkdirSync(join(cwd, `Dir${d}`, "sub"), { recursive: true });
      writeFileSync(join(cwd, `Dir${d}`, "sub", "file.txt"), `file ${d}`);
    }
    const first = await snapshot(bot, cwd, "first");
    renameSync(join(cwd, "Dir3"), join(cwd, "dir3"));
    hooks.calls = [];
    hooks.readdirSync = [];
    expect(await diffWorkingTree(bot, cwd, first!)).toEqual({ changed: [], added: ["dir3/sub/file.txt"], deleted: ["Dir3/sub/file.txt"] });
    const renamed = await snapshot(bot, cwd, "renamed");
    expect(renamed).not.toBe(first);
    expect(subcommands()).toContain("read-tree"); // the rename was found
    expect(hooks.readdirSync.filter(path => path.startsWith(cwd) || path.startsWith(realpathSync(cwd)))).toEqual([]);
  });
});

describe("git timeout", () => {
  it("matches the error shape Node gives a timed-out child", async () => {
    const err = await new Promise<Error & { killed?: boolean }>(resolve => {
      realExecFile(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { timeout: 200 }, error => resolve(error!));
    });
    expect(err.killed).toBe(true);
    expect(err.name).not.toBe("AbortError");
  });

  it("disables only that bot+folder, logs once, and later turns skip without spawning git", async () => {
    const { bot, cwd } = workspace();
    const other = workspace().cwd;
    writeFileSync(join(cwd, "a.txt"), "slow folder");
    writeFileSync(join(other, "a.txt"), "fine folder");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    hooks.inject = args => args[0] === "add" ? { error: timeoutError("add") } : undefined;

    expect(await snapshot(bot, cwd, "turn 1")).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]![0]);
    expect(line).toContain(bot);
    expect(line).toContain(realpathSync(cwd));
    expect(line).toContain("timed out");

    hooks.calls = [];
    expect(await snapshot(bot, cwd, "turn 2")).toBeNull();
    expect(await diffWorkingTree(bot, cwd, "0".repeat(40))).toBeNull();
    expect(hooks.calls).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);

    // the bot's other folders keep working
    hooks.inject = null;
    expect(await snapshot(bot, other, "turn 3")).toMatch(/^[0-9a-f]{40}$/);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("treats a timeout in any snapshot git call the same way", async () => {
    const { bot, cwd } = workspace();
    writeFileSync(join(cwd, "a.txt"), "one");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    hooks.inject = args => args[0] === "write-tree" ? { error: timeoutError("write-tree") } : undefined;
    expect(await snapshot(bot, cwd, "turn 1")).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain(`for bot ${bot} in ${realpathSync(cwd)}`);
    // folder-scoped, not bot-wide
    const other = workspace().cwd;
    hooks.inject = null;
    expect(await snapshot(bot, other, "turn 2")).toMatch(/^[0-9a-f]{40}$/);
  });

  it("disables that bot+folder when the settled diff times out", async () => {
    const { bot, cwd } = workspace();
    writeFileSync(join(cwd, "a.txt"), "one");
    const before = await snapshot(bot, cwd, "turn 1");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    hooks.inject = args => args[0] === "add" ? { error: timeoutError("add") } : undefined;
    expect(await diffWorkingTree(bot, cwd, before!)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain(`for bot ${bot} in ${realpathSync(cwd)}`);
    hooks.inject = null;
    hooks.calls = [];
    expect(await snapshot(bot, cwd, "turn 2")).toBeNull();
    expect(hooks.calls).toEqual([]);
  });

  it("does not disable anything for an unreadable-file add failure", async () => {
    const { bot, cwd } = workspace();
    writeFileSync(join(cwd, "a.txt"), "one");
    const first = await snapshot(bot, cwd, "turn 1");
    writeFileSync(join(cwd, "a.txt"), "two");
    hooks.inject = args => args[0] === "add" ? { error: Object.assign(new Error("Command failed"), { code: 1 }), stderr: "error: open(\"x\"): Permission denied" } : undefined;
    expect(await snapshot(bot, cwd, "turn 2")).toBeNull();
    hooks.inject = null;
    await drain(bot, cwd);
    expect(snapshotHashes(bot, cwd)).toEqual([first]);
    const third = await snapshot(bot, cwd, "turn 3");
    expect(third).toMatch(/^[0-9a-f]{40}$/);
    expect(third).not.toBe(first);
  });
});
