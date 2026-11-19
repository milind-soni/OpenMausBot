// Real git does the work; execFile is wrapped only to record calls and inject a timeout or object counts, readdirSync only to record calls.
import { createHash } from "node:crypto";
import { execFile as realExecFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

// Shadow repos live under DATA_DIR, which server/testing/setup.ts points at a
// disposable test home before any test module imports config.ts.
import { CHECKPOINTS_DIR, FAILURES_BEFORE_OFF, diffWorkingTree, prime, quiet, release, snapshot } from "./checkpoints.ts";
import { checkpointGitSlots } from "./job-slots.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

type Injected = { error: Error; stdout?: string; stderr?: string } | { stdout: string } | { until: Promise<Error | void> };
const hooks = vi.hoisted(() => ({
  calls: [] as string[][],
  inject: null as null | ((args: string[]) => Injected | undefined),
  readdirSync: [] as string[],
  running: 0,
  mostRunning: 0,
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
      if (injected && "until" in injected) {
        // Held like a slow git: it runs once `until` settles (or fails with what it settles to), or ends as Node ends a child whose signal fired.
        const signal = (options as { signal?: AbortSignal }).signal;
        let over = false;
        const end = (error: Error | null) => {
          if (over) return;
          over = true;
          if (error) callback(error, "", "");
          else actual.execFile(file, args, options, callback);
        };
        signal?.addEventListener("abort", () => end(Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR" })), { once: true });
        void injected.until.then((failure) => end(failure ?? null));
        return {};
      }
      if (injected) {
        setImmediate(() => callback("error" in injected ? injected.error : null, injected.stdout ?? "", "stderr" in injected ? injected.stderr ?? "" : ""));
        return {};
      }
    }
    if (file !== "git") return actual.execFile(file, args, options, callback);
    hooks.running += 1;
    hooks.mostRunning = Math.max(hooks.mostRunning, hooks.running);
    return actual.execFile(file, args, options, (...rest: unknown[]) => {
      hooks.running -= 1;
      callback(...rest);
    });
  };
  return { ...actual, execFile };
});

// Checkpoints start git in a process group of their own; here every git run goes through the execFile above instead.
vi.mock("./group-exec.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./group-exec.ts")>();
  const { execFile } = await import("node:child_process");
  return { ...actual, execFileInGroup: (file: string, args: string[], options: object, callback: (...rest: unknown[]) => void) => execFile(file, args, options, callback) };
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

/** release() queues behind the folder's operations, and releasing a pin never taken is a no-op. */
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
    hooks.calls = [];
    expect(await diffWorkingTree(bot, cwd, first!)).toEqual({ changed: [], added: [], deleted: [] });
    expect(subcommands()).not.toContain("read-tree");
    // 3,000 files take ~2 s on macOS but run past vitest's 20 s default on CI's Windows runners; hostTimeout doubles it there.
  }, hostTimeout(120_000));

  it("takes a turn's snapshot in a handful of git calls, moving HEAD and the turn's pin in one", async () => {
    const { bot, cwd } = workspace();
    writeFileSync(join(cwd, "a.txt"), "one");
    await snapshot(bot, cwd, "first");
    await drain(bot, cwd);
    writeFileSync(join(cwd, "a.txt"), "two");
    hooks.calls = [];
    const changed = await snapshot(bot, cwd, "changed", undefined, { pin: "dispatch-1" });
    expect(changed).toMatch(/^[0-9a-f]{40}$/);
    // The four reads start together; the pin goes on the old HEAD beside the add, then moves with HEAD.
    expect(subcommands()).toEqual(["ls-files", "log", "ls-files", "ls-files", "update-ref", "add", "write-tree", "commit-tree", "update-ref"]);
    expect(shadowGit(bot, cwd, "rev-parse", "HEAD").trim()).toBe(changed);
    expect(shadowGit(bot, cwd, "for-each-ref", "--format=%(objectname)", "refs/omb-live/").trim()).toBe(changed);
    // The loose-object count is taken behind the snapshot, not inside it.
    await drain(bot, cwd);
    expect(subcommands().slice(9)).toEqual(["count-objects", "update-ref"]);
    await release(bot, cwd, "dispatch-1");
  });

  it("takes an unchanged folder's snapshot in two rounds of git calls, without writing the tree again", async () => {
    const { bot, cwd } = workspace();
    writeFileSync(join(cwd, "a.txt"), "one");
    // Git reads a file again while it is as new as the index itself, and rewrites the index for it: this one is older.
    const earlier = new Date(Date.now() - 60_000);
    utimesSync(join(cwd, "a.txt"), earlier, earlier);
    const first = await snapshot(bot, cwd, "first");
    await drain(bot, cwd);
    hooks.calls = [];
    expect(await snapshot(bot, cwd, "unchanged", undefined, { pin: "dispatch-2" })).toBe(first);
    expect(subcommands()).toEqual(["ls-files", "log", "ls-files", "ls-files", "update-ref", "add"]);
    expect(shadowGit(bot, cwd, "for-each-ref", "--format=%(objectname)", "refs/omb-live/").trim()).toBe(first);
    await drain(bot, cwd);
    expect(subcommands()).not.toContain("count-objects");
    // An edit made outside the app between two turns is in the next snapshot.
    writeFileSync(join(cwd, "a.txt"), "edited outside the app");
    hooks.calls = [];
    const edited = await snapshot(bot, cwd, "edited", undefined, { pin: "dispatch-3" });
    expect(edited).not.toBe(first);
    expect(subcommands()).toContain("write-tree");
    expect(shadowGit(bot, cwd, "show", `${edited}:a.txt`)).toBe("edited outside the app");
    // The earlier turn's pin still holds its own commit.
    expect(shadowGit(bot, cwd, "for-each-ref", "--format=%(objectname)", "refs/omb-live/").trim().split("\n").sort()).toEqual([first, edited].sort());
    await release(bot, cwd, "dispatch-2");
    await release(bot, cwd, "dispatch-3");
  });

  it("reads a folder ahead of a turn with the same reads and one add, and writes no ref", async () => {
    const { bot, cwd } = workspace();
    writeFileSync(join(cwd, "a.txt"), "one");
    const first = await snapshot(bot, cwd, "first");
    await drain(bot, cwd);
    writeFileSync(join(cwd, "a.txt"), "two");
    hooks.calls = [];
    expect(await prime(bot, cwd)).toBe(true);
    expect(subcommands()).toEqual(["ls-files", "log", "ls-files", "ls-files", "add", "write-tree"]);
    expect(shadowGit(bot, cwd, "rev-parse", "HEAD").trim()).toBe(first);
    // A failure while reading ahead turns nothing off: the turn's own snapshot still runs.
    hooks.inject = args => args[0] === "add" ? { error: new Error("Command failed: git add"), stderr: "fatal: unable to stat" } : undefined;
    expect(await prime(bot, cwd)).toBe(false);
    hooks.inject = null;
    hooks.calls = [];
    expect(await snapshot(bot, cwd, "the turn")).not.toBe(first);
    expect(subcommands()).toContain("add");
  });

  it("gives up on a folder too big to read ahead in a turn's time, so no turn waits that long again", async () => {
    const { bot, cwd } = workspace();
    writeFileSync(join(cwd, "a.txt"), "one");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    hooks.inject = args => args[0] === "add" ? { error: timeoutError("add") } : undefined;
    expect(await prime(bot, cwd)).toBe(false);
    hooks.inject = null;
    expect(warn).toHaveBeenCalledTimes(1);
    hooks.calls = [];
    expect(await snapshot(bot, cwd, "the turn")).toBeNull();
    expect(await prime(bot, cwd)).toBe(false);
    expect(hooks.calls).toEqual([]);
    // Stopped by its caller is not a timeout: nothing is turned off.
    const other = workspace();
    writeFileSync(join(other.cwd, "a.txt"), "one");
    const stop = new AbortController();
    stop.abort();
    expect(await prime(other.bot, other.cwd, stop.signal)).toBe(false);
    expect(await snapshot(other.bot, other.cwd, "the turn")).toMatch(/^[0-9a-f]{40}$/);
  });

  it("keeps every git it starts, for turns and for reading ahead alike, within the checkpoint git limit", async () => {
    const folders = Array.from({ length: 6 }, () => {
      const one = workspace();
      for (let n = 0; n < 20; n += 1) writeFileSync(join(one.cwd, `file${n}.txt`), `file ${n}`);
      return one;
    });
    hooks.mostRunning = 0;
    const results = await Promise.all(folders.map(({ bot, cwd }, at) => at % 2 ? prime(bot, cwd) : snapshot(bot, cwd, "turn", undefined, { pin: `dispatch-${at}` })));
    expect(results.every(Boolean)).toBe(true);
    await Promise.all(folders.map(({ bot, cwd }) => snapshot(bot, cwd, "again")));
    expect(hooks.mostRunning).toBeGreaterThan(1);
    expect(hooks.mostRunning).toBeLessThanOrEqual(checkpointGitSlots.limit);
    for (const [at, { bot, cwd }] of folders.entries()) if (at % 2 === 0) await release(bot, cwd, `dispatch-${at}`);
  });

  it("leaves no pin behind when the folder cannot be staged", async () => {
    const { bot, cwd } = workspace();
    writeFileSync(join(cwd, "a.txt"), "one");
    const first = await snapshot(bot, cwd, "first");
    hooks.inject = args => args[0] === "add" ? { error: new Error("Command failed: git add"), stderr: "fatal: unable to stat" } : undefined;
    expect(await snapshot(bot, cwd, "cannot stage", undefined, { pin: "dispatch-4" })).toBeNull();
    hooks.inject = null;
    await drain(bot, cwd);
    expect(shadowGit(bot, cwd, "for-each-ref", "--format=%(objectname)", "refs/omb-live/").trim()).toBe("");
    expect(await snapshot(bot, cwd, "later")).toBe(first);
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
    await drain(bot, cwd);
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

  it("holds a collection left by a turn without a diff for the next turn's settled diff, never ahead of its snapshot", async () => {
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
    await drain(bot, cwd);
    expect(subcommands()).not.toContain("gc");
    writeFileSync(join(cwd, "b.txt"), "made by the turn");
    expect(await diffWorkingTree(bot, cwd, next!)).toEqual({ changed: [], added: ["b.txt"], deleted: [] });
    await drain(bot, cwd);
    expect(subcommands().filter(command => command === "gc")).toHaveLength(1);
    expect(subcommands().indexOf("gc")).toBeGreaterThan(hooks.calls.findIndex(args => args[0] === "diff"));
    expect(snapshotHashes(bot, cwd)).toEqual([next]);
  });

  it("runs the collection of a turn that ended without a diff once its pin is released", async () => {
    const { bot, cwd } = workspace();
    writeFileSync(join(cwd, "a.txt"), "one");
    await snapshot(bot, cwd, "first");
    hooks.inject = args => args[0] === "count-objects" ? { stdout: countObjects({ count: 7000 }) } : undefined;
    writeFileSync(join(cwd, "a.txt"), "two");
    const stopped = await snapshot(bot, cwd, "stopped during setup", undefined, { pin: "dispatch-5" });
    await drain(bot, cwd);
    hooks.inject = null;
    expect(subcommands()).not.toContain("gc");
    await release(bot, cwd, "dispatch-5");
    await drain(bot, cwd);
    expect(subcommands().filter(command => command === "gc")).toHaveLength(1);
    expect(snapshotHashes(bot, cwd)).toEqual([stopped]);
  });

  it.skipIf(process.platform === "win32")("stops a running collection for a new turn's snapshot, and runs it again behind that turn", async () => {
    const { bot, cwd } = workspace();
    writeFileSync(join(cwd, "a.txt"), "one");
    await snapshot(bot, cwd, "first");
    let collections = 0;
    hooks.inject = (args) => {
      if (args[0] === "count-objects") return collections === 0 ? { stdout: countObjects({ count: 7000 }) } : undefined;
      // The first collection never ends by itself.
      if (args[0] === "gc") return (collections += 1) === 1 ? { until: new Promise(() => {}) } : undefined;
      return undefined;
    };
    writeFileSync(join(cwd, "a.txt"), "two");
    const before = await snapshot(bot, cwd, "collection due", undefined, { pin: "dispatch-6" });
    expect(await diffWorkingTree(bot, cwd, before!)).toEqual({ changed: [], added: [], deleted: [] });
    void release(bot, cwd, "dispatch-6");
    await vi.waitFor(() => expect(collections).toBe(1));
    // The next message arrives while that collection runs: its snapshot and its digest wait for neither it nor a new one.
    writeFileSync(join(cwd, "a.txt"), "three");
    hooks.calls = [];
    const next = await snapshot(bot, cwd, "next turn", undefined, { pin: "dispatch-7" });
    expect(next).toMatch(/^[0-9a-f]{40}$/);
    expect(subcommands()).not.toContain("gc");
    expect(commitExists(bot, cwd, next!)).toBe(true);
    writeFileSync(join(cwd, "b.txt"), "made by the turn");
    expect(await diffWorkingTree(bot, cwd, next!)).toEqual({ changed: [], added: ["b.txt"], deleted: [] });
    expect(subcommands()).not.toContain("gc");
    await release(bot, cwd, "dispatch-7");
    await drain(bot, cwd);
    expect(collections).toBe(2);
    expect(snapshotHashes(bot, cwd)).toEqual([next]);
    expect(commitExists(bot, cwd, before!)).toBe(false);
  });

  it("keeps a running turn's pin when a digest is cut off while the folder's cache directories are listed again", async () => {
    const { bot, cwd } = workspace();
    writeFileSync(join(cwd, "a.txt"), "before A");
    const hashA = await snapshot(bot, cwd, "turn A", undefined, { pin: "dispatch-A" });
    await drain(bot, cwd);
    mkdirSync(join(cwd, "cache"));
    writeFileSync(join(cwd, "cache", "CACHEDIR.TAG"), "Signature: 8a477f597d28d172789f06886806bc55\n");
    writeFileSync(join(cwd, "cache", "blob.bin"), "cached");
    let scans = 0;
    hooks.inject = args => args[0] === "ls-files" && args.includes("**/CACHEDIR.TAG") && (scans += 1) === 2 ? { until: new Promise(() => {}) } : undefined;
    const cutOff = new AbortController();
    const digest = diffWorkingTree(bot, cwd, hashA!, cutOff.signal);
    await vi.waitFor(() => expect(scans).toBe(2));
    cutOff.abort();
    expect(await digest).toBeNull();
    // A sibling turn starts in the folder, and a collection runs behind it.
    hooks.inject = args => args[0] === "count-objects" ? { stdout: countObjects({ count: 7000 }) } : undefined;
    writeFileSync(join(cwd, "a.txt"), "A edited");
    const hashB = await snapshot(bot, cwd, "turn B", undefined, { pin: "dispatch-B" });
    await drain(bot, cwd);
    hooks.inject = null;
    expect(await diffWorkingTree(bot, cwd, hashB!)).toEqual({ changed: [], added: [], deleted: [] });
    await release(bot, cwd, "dispatch-B");
    await drain(bot, cwd);
    expect(subcommands()).toContain("gc");
    expect(commitExists(bot, cwd, hashA!)).toBe(true);
    expect(shadowGit(bot, cwd, "ls-tree", "-r", "--name-only", hashB!).trim()).toBe("a.txt");
    expect(await diffWorkingTree(bot, cwd, hashA!)).toEqual({ changed: ["a.txt"], added: [], deleted: [] });
    await release(bot, cwd, "dispatch-A");
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
    await drain(bot, cwd);
    hooks.inject = null;
    expect(await diffWorkingTree(bot, cwd, hashA!)).toEqual({ changed: ["a.txt"], added: [], deleted: [] });
    await release(bot, cwd, "dispatch-A");
    await drain(bot, cwd);
    expect(subcommands()).toContain("gc");
    expect(commitExists(bot, cwd, hashA!)).toBe(true); // not HEAD: only the pin kept it
    await release(bot, cwd, "dispatch-B");
    writeFileSync(join(cwd, "a.txt"), "turn C");
    collectionDue();
    hooks.calls = [];
    const hashC = await snapshot(bot, cwd, "turn C");
    await drain(bot, cwd);
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
    expect(subcommands()).toContain("read-tree");
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

function shadowOf(bot: string, cwd: string): string {
  return join(CHECKPOINTS_DIR, bot, createHash("sha256").update(realpathSync(cwd)).digest("hex").slice(0, 16));
}

describe("a shadow's first use", () => {
  it("is not cut short by the read-ahead that started it being stopped, and leaves nothing half-made", async () => {
    const { bot, cwd } = workspace();
    writeFileSync(join(cwd, "a.txt"), "one");
    let open = () => {};
    const held = new Promise<void>((done) => { open = done; });
    let inits = 0;
    hooks.inject = args => args[0] === "init" && (inits += 1) === 1 ? { until: held } : undefined;
    const stopped = new AbortController();
    const reading = prime(bot, cwd, stopped.signal);
    await vi.waitFor(() => expect(inits).toBe(1));
    // The bot is moved off the folder while git is still making the shadow.
    stopped.abort();
    const turn = snapshot(bot, cwd, "first turn", undefined, { pin: "dispatch-1" });
    open();
    expect(await reading).toBe(false);
    expect(await turn).toMatch(/^[0-9a-f]{40}$/);
    expect(inits).toBe(1);
    const shadow = shadowOf(bot, cwd);
    expect(readdirSync(join(shadow, ".git")).filter((name) => name.endsWith(".lock"))).toEqual([]);
    expect(readdirSync(join(shadow, "..")).filter((name) => name.endsWith(".new"))).toEqual([]);
    await release(bot, cwd, "dispatch-1");
  });
});

describe("a snapshot that fails", () => {
  it("costs that turn its checkpoint, never the bot's other folders, and turns its own folder off only after several in a row", async () => {
    const { bot, cwd } = workspace();
    const other = workspace();
    writeFileSync(join(cwd, "a.txt"), "one");
    writeFileSync(join(other.cwd, "a.txt"), "one");
    expect(await snapshot(bot, cwd, "first")).toMatch(/^[0-9a-f]{40}$/);
    await drain(bot, cwd);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let broken = true;
    hooks.inject = args => broken && args[0] === "commit-tree" ? { error: new Error("Command failed: git commit-tree"), stderr: "fatal: unable to write" } : undefined;
    for (let turn = 1; turn < FAILURES_BEFORE_OFF; turn += 1) {
      writeFileSync(join(cwd, "a.txt"), `edit ${turn}`);
      expect(await snapshot(bot, cwd, `failing ${turn}`, undefined, { pin: `dispatch-${turn}` })).toBeNull();
      expect(String(warn.mock.calls.at(-1)?.[0])).toContain("checkpoint not taken");
    }
    expect(shadowGit(bot, cwd, "for-each-ref", "--format=%(objectname)", "refs/omb-live/").trim()).toBe("");
    // The same bot in another folder is untouched, and so is this folder once git works again.
    broken = false;
    expect(await snapshot(bot, other.cwd, "other folder")).toMatch(/^[0-9a-f]{40}$/);
    expect(await snapshot(bot, cwd, "working again")).toMatch(/^[0-9a-f]{40}$/);
    await drain(bot, cwd);
    broken = true;
    for (let turn = 1; turn <= FAILURES_BEFORE_OFF; turn += 1) {
      writeFileSync(join(cwd, "a.txt"), `later edit ${turn}`);
      expect(await snapshot(bot, cwd, `failing again ${turn}`)).toBeNull();
    }
    expect(String(warn.mock.calls.at(-1)?.[0])).toContain("disabled");
    hooks.calls = [];
    expect(await snapshot(bot, cwd, "off")).toBeNull();
    expect(hooks.calls).toEqual([]);
    broken = false;
    writeFileSync(join(other.cwd, "a.txt"), "two");
    expect(await snapshot(bot, other.cwd, "other folder still on")).toMatch(/^[0-9a-f]{40}$/);
  });

  it("tries once more without a lock that a git stopped by force left on the shadow's refs", async () => {
    for (const lock of ["HEAD.lock", join("refs", "heads", "main.lock"), "packed-refs.lock", "config.lock"]) {
      const { bot, cwd } = workspace();
      const shadow = shadowOf(bot, cwd);
      writeFileSync(join(cwd, "a.txt"), "one");
      await snapshot(bot, cwd, "first", undefined, { pin: "dispatch-1" });
      await drain(bot, cwd);
      shadowGit(bot, cwd, "pack-refs", "--all", "--prune");
      writeFileSync(join(shadow, ".git", lock), "");
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      await release(bot, cwd, "dispatch-1");
      writeFileSync(join(cwd, "a.txt"), "two");
      const second = await snapshot(bot, cwd, "second", undefined, { pin: "dispatch-2" });
      expect(second, lock).toMatch(/^[0-9a-f]{40}$/);
      expect(shadowGit(bot, cwd, "for-each-ref", "--format=%(objectname)", "refs/omb-live/").trim(), lock).toBe(second);
      expect(warn, lock).not.toHaveBeenCalled();
      await release(bot, cwd, "dispatch-2");
      warn.mockRestore();
    }
  });
});

describe("a folder being read ahead when its turn starts", () => {
  it("gives the turn the read-ahead's answer when the folder proves too big, without a second attempt", async () => {
    const { bot, cwd } = workspace();
    writeFileSync(join(cwd, "a.txt"), "one");
    let giveUp: (failure: Error) => void = () => {};
    const slow = new Promise<Error>((done) => { giveUp = done; });
    hooks.inject = args => args[0] === "add" ? { until: slow } : undefined;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const reading = prime(bot, cwd);
    const turn = snapshot(bot, cwd, "the turn", undefined, { pin: "dispatch-1" });
    await vi.waitFor(() => expect(subcommands()).toContain("add"));
    giveUp(timeoutError("add"));
    expect(await reading).toBe(false);
    expect(await turn).toBeNull();
    expect(subcommands().filter(command => command === "add")).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("collections", () => {
  it("prune only what was unreachable before they started, and say so on disk while they run", async () => {
    const { bot, cwd } = workspace();
    const marker = join(shadowOf(bot, cwd), ".git", "omb-collecting");
    writeFileSync(join(cwd, "a.txt"), "one");
    await snapshot(bot, cwd, "first");
    let during: string | null = null;
    hooks.inject = (args) => {
      if (args[0] === "count-objects") return { stdout: countObjects({ count: 7000 }) };
      if (args[0] === "gc") during = readFileSync(marker, "utf8");
      return undefined;
    };
    writeFileSync(join(cwd, "a.txt"), "two");
    const started = Math.floor(Date.now() / 1000);
    const hash = await snapshot(bot, cwd, "collection due");
    await diffWorkingTree(bot, cwd, hash!);
    await drain(bot, cwd);
    const prune = hooks.calls.find(args => args[0] === "gc")?.find(arg => arg.startsWith("--prune="))?.slice("--prune=".length);
    expect(Number(prune)).toBeGreaterThanOrEqual(started);
    expect(Number(prune)).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
    expect(during).toBe(prune);
    expect(existsSync(marker)).toBe(false);
  });

  it("are never ended by force on Windows: one that has started runs to its end, and the turn waits for it", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    try {
      const { bot, cwd } = workspace();
      writeFileSync(join(cwd, "a.txt"), "one");
      await snapshot(bot, cwd, "first");
      let open = () => {};
      const held = new Promise<void>((done) => { open = done; });
      let collections = 0;
      hooks.inject = (args) => {
        if (args[0] === "count-objects") return collections === 0 ? { stdout: countObjects({ count: 7000 }) } : undefined;
        if (args[0] === "gc") return (collections += 1) === 1 ? { until: held } : undefined;
        return undefined;
      };
      writeFileSync(join(cwd, "a.txt"), "two");
      const before = await snapshot(bot, cwd, "collection due", undefined, { pin: "dispatch-1" });
      await diffWorkingTree(bot, cwd, before!);
      await vi.waitFor(() => expect(collections).toBe(1));
      writeFileSync(join(cwd, "a.txt"), "three");
      hooks.calls = [];
      let taken = false;
      const next = snapshot(bot, cwd, "next turn").then((hash) => { taken = true; return hash; });
      await new Promise((turn) => setImmediate(turn));
      expect(taken).toBe(false);
      expect(subcommands()).not.toContain("add");
      open();
      expect(await next).toMatch(/^[0-9a-f]{40}$/);
      await release(bot, cwd, "dispatch-1");
      await drain(bot, cwd);
      expect(collections).toBe(1);
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  });
});

describe("quiet", () => {
  it("resolves once no git is running or waiting on the bot's shadows", async () => {
    const { bot, cwd } = workspace();
    writeFileSync(join(cwd, "a.txt"), "one");
    await snapshot(bot, cwd, "first");
    await drain(bot, cwd);
    let open = () => {};
    const held = new Promise<void>((done) => { open = done; });
    hooks.inject = args => args[0] === "add" ? { until: held } : undefined;
    const stopped = new AbortController();
    const reading = prime(bot, cwd, stopped.signal);
    await vi.waitFor(() => expect(subcommands()).toContain("add"));
    let isQuiet = false;
    const waiting = quiet(bot).then(() => { isQuiet = true; });
    await new Promise((turn) => setImmediate(turn));
    expect(isQuiet).toBe(false);
    stopped.abort();
    await waiting;
    expect(await reading).toBe(false);
    open();
  });
});
