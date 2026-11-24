import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { spillDir } from "../mcp-gate-config.ts";
import { createConversationFolderCleanup, deleteTimeCleanup, folderMentions, gateResultsName, hookResultsName, indexNames, plainFolderUnder, REMOVING_DIR, type FolderCleanupDeps, type LiveRecords } from "./conversation-folder-cleanup.ts";

/** Hooks into the file calls the cleanup makes, to swap a folder for a link at the worst moment. */
const fsHooks = vi.hoisted(() => ({ renames: 0 } as { renames: number; afterRename?: (n: number, from: string, to: string) => void; beforeReaddir?: (path: string) => void }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...real,
    rename: async (from: string, to: string) => { await real.rename(from, to); fsHooks.renames++; fsHooks.afterRename?.(fsHooks.renames, from, to); },
    readdir: (async (path: string, options?: unknown) => { fsHooks.beforeReaddir?.(String(path)); return (real.readdir as (path: string, options?: unknown) => Promise<unknown>)(path, options); }) as typeof real.readdir,
  };
});

const made: string[] = [];
afterEach(() => {
  delete fsHooks.afterRename;
  delete fsHooks.beforeReaddir;
  fsHooks.renames = 0;
  for (const dir of made.splice(0)) {
    try { chmodSync(dir, 0o700); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});

function put(path: string, text = "x"): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

type Bots = Array<LiveRecords["bots"][number]>;
type Groups = Array<LiveRecords["groups"][number]>;
const posixOnly = process.platform !== "win32";
const gitAvailable = (() => { try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();

function fixture(over: Partial<FolderCleanupDeps> = {}) {
  const sandbox = mkdtempSync(join(tmpdir(), "omb-folder-cleanup-"));
  made.push(sandbox);
  const dataDir = join(sandbox, "data");
  const outside = join(sandbox, "outside");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(outside, { recursive: true });
  const bots: Bots = [];
  const groups: Groups = [];
  const logs: string[] = [];
  const warnings: string[] = [];
  const deps: FolderCleanupDeps = {
    dataDir,
    records: () => ({ bots, groups }),
    drainAfterMs: false,
    pause: async () => {},
    log: (line) => { logs.push(line); },
    warn: (line) => { warnings.push(line); },
    ...over,
  };
  const cleanup = createConversationFolderCleanup(deps);
  const folder = (bot: string, thread: string) => join(dataDir, "task-workspaces", bot, thread);
  /** A node_modules a package manager made, with its package.json beside it. */
  const install = (at: string) => {
    put(join(at, "package.json"), "{}");
    put(join(at, "node_modules", ".package-lock.json"), "{}");
    put(join(at, "node_modules", "left-pad", "index.js"));
    return join(at, "node_modules");
  };
  /** A conversation folder with the person's files, two installs and look-alikes that are not installs. */
  const work = (bot: string, thread: string) => {
    const at = folder(bot, thread);
    return {
      kept: [
        put(join(at, "report.md"), "the person's report"),
        put(join(at, "app", "src", "index.js")),
        put(join(at, "tool", "Cargo.toml")),
        put(join(at, "tool", "target", "release", "tool")), // a build's output can be the deliverable
        put(join(at, "venv-lookalike", "venv", "notes.txt")), // no pyvenv.cfg: not a venv
        put(join(at, "repo", ".git", "node_modules", "HEAD")), // never walked into .git
        put(join(at, "unmarked", "package.json"), "{}"),
        put(join(at, "unmarked", "node_modules", "hand-written.js")), // no package manager's record
        put(join(at, "alone", "node_modules", ".package-lock.json")), // no package.json beside it
        put(join(at, "analysis", ".venv", "pyvenv.cfg")),
        put(join(at, "analysis", ".venv", "my_analysis.py")), // the person's script at a venv's top: kept
      ],
      gone: [join(at, "app", "node_modules"), join(at, "py", ".venv")],
      fill() {
        install(join(at, "app"));
        put(join(at, "py", ".venv", "pyvenv.cfg"));
        put(join(at, "py", ".venv", "lib", "python3.12", "site-packages", "x.py"));
        put(join(at, "py", ".venv", "bin", "python"));
        return this;
      },
    };
  };
  const removingEmpty = () => !existsSync(join(dataDir, REMOVING_DIR)) || readdirSync(join(dataDir, REMOVING_DIR)).length === 0;
  return { sandbox, dataDir, outside, bots, groups, logs, warnings, cleanup, folder, work, install, removingEmpty };
}
type Fixture = ReturnType<typeof fixture>;

async function deleteAndWait(f: Fixture, ...threads: string[]) {
  f.cleanup.conversationsGone(threads);
  await f.cleanup.idle();
}

describe("the switch", () => {
  it("is off unless a Cloud home sets OMB_CONVERSATION_FOLDER_CLEANUP=on", () => {
    const make = () => "cleanup";
    expect(deleteTimeCleanup({}, true, make)).toBeUndefined();
    expect(deleteTimeCleanup({ OMB_CONVERSATION_FOLDER_CLEANUP: "off" }, true, make)).toBeUndefined();
    expect(deleteTimeCleanup({ OMB_CONVERSATION_FOLDER_CLEANUP: "yes" }, true, make)).toBeUndefined();
    expect(deleteTimeCleanup({ OMB_CONVERSATION_FOLDER_CLEANUP: "on" }, false, make)).toBeUndefined();
    expect(deleteTimeCleanup({ OMB_CONVERSATION_FOLDER_CLEANUP: " On " }, true, make)).toBe("cleanup");
  });
});

describe("a deleted conversation's folder", () => {
  it("loses its package installs and keeps the person's files, build output and every look-alike", async () => {
    const f = fixture();
    const tree = f.work("scout", "t1").fill();
    await deleteAndWait(f, "t1");
    for (const path of tree.gone) expect(existsSync(path), path).toBe(false);
    for (const path of tree.kept) expect(existsSync(path), path).toBe(true);
    expect(f.removingEmpty()).toBe(true);
    expect(f.logs.join("\n")).toMatch(/removed 2 install or tool-result folder/);
    expect(f.logs.join("\n")).toMatch(/kept .*unmarked.node_modules: no package manager's record/);
    expect(f.logs.join("\n")).toMatch(/kept .*alone.node_modules: no package.json beside it/);
    expect(f.logs.join("\n")).toMatch(/kept .*analysis.\.venv: holds my_analysis\.py/);
  });

  it("takes a venv whole when only its top level is a venv's own, the person's files deeper inside included", async () => {
    // An owner decision, stated in the PR: only top-level foreign entries keep a venv.
    const f = fixture();
    const venv = join(f.folder("scout", "t1"), "py", ".venv");
    put(join(venv, "pyvenv.cfg"));
    put(join(venv, "bin", "my_job.sh"), "the person's script");
    put(join(venv, "share", "notes", "plan.md"), "the person's notes");
    await deleteAndWait(f, "t1");
    expect(existsSync(venv)).toBe(false);
  });

  it("loses its full tool results, and keeps a live thread's and the gate's shared fallback folder", async () => {
    const f = fixture();
    put(join(f.dataDir, "tool-results", "t1", "abc.txt"));
    put(join(f.dataDir, "tool-results", "t2", "def.txt"));
    put(join(f.dataDir, "tool-results", "thread", "ghi.txt"));
    f.bots.push({ id: "scout", tasks: [{ threadId: "t2" }] });
    await deleteAndWait(f, "t1", "thread");
    expect(existsSync(join(f.dataDir, "tool-results", "t1"))).toBe(false);
    expect(existsSync(join(f.dataDir, "tool-results", "t2", "def.txt"))).toBe(true);
    expect(existsSync(join(f.dataDir, "tool-results", "thread", "ghi.txt"))).toBe(true);
  });

  it("takes each member's folder of a deleted room conversation", async () => {
    const f = fixture();
    const a = f.work("ann", "room1").fill(), b = f.work("ben", "room1").fill();
    await deleteAndWait(f, "room1");
    for (const path of [...a.gone, ...b.gone]) expect(existsSync(path)).toBe(false);
    for (const path of [...a.kept, ...b.kept]) expect(existsSync(path)).toBe(true);
  });

  it.runIf(gitAvailable)("keeps a node_modules git tracks, and takes one git ignores", async () => {
    const f = fixture();
    const repo = join(f.folder("scout", "t1"), "repo2");
    const vendored = f.install(join(repo, "vendored"));
    const ignored = f.install(join(repo, "ignored"));
    put(join(repo, ".gitignore"), "ignored/node_modules/\n");
    const git = (...args: string[]) => execFileSync("git", ["-c", "core.fsmonitor=false", ...args], { cwd: repo, stdio: "ignore", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(f.sandbox, "no-gitconfig") } });
    git("init", "-q");
    git("add", "-f", "vendored", "ignored/package.json", ".gitignore");
    await deleteAndWait(f, "t1");
    expect(existsSync(join(vendored, "left-pad", "index.js"))).toBe(true);
    expect(existsSync(ignored)).toBe(false);
    expect(f.logs.join("\n")).toMatch(/kept .*vendored.node_modules: git tracks it/);
  });
});

describe("a folder something remaining still uses", () => {
  it("stays whole while its conversation remains anywhere, as a bot's or a room's", async () => {
    const f = fixture();
    const own = f.work("scout", "t1").fill(), room = f.work("scout", "room1").fill();
    f.bots.push({ id: "other", tasks: [{ threadId: "t1" }] });
    f.groups.push({ id: "g1", threadId: "room1" });
    await deleteAndWait(f, "t1", "room1");
    for (const path of [...own.gone, ...room.gone]) expect(existsSync(path)).toBe(true);
  });

  it("stays whole while a fork, a bot or a room works in it, inside it or above it in the data folder", async () => {
    for (const used of [
      (f: Fixture) => f.bots.push({ id: "scout", tasks: [{ threadId: "fork", cwd: f.folder("scout", "t1") }] }),
      (f: Fixture) => f.bots.push({ id: "scout", cwd: join(f.folder("scout", "t1"), "app") }),
      (f: Fixture) => f.bots.push({ id: "scout", cwd: join(f.dataDir, "task-workspaces", "scout") }),
      (f: Fixture) => f.groups.push({ id: "g1", threadId: "room9", pinnedCwd: f.folder("scout", "t1") }),
      (f: Fixture) => f.groups.push({ id: "g1", threadId: "room9", tasks: [{ threadId: "room9", pinnedCwd: f.folder("scout", "t1") }] }),
    ]) {
      const f = fixture();
      const tree = f.work("scout", "t1").fill();
      used(f);
      await deleteAndWait(f, "t1");
      for (const path of tree.gone) expect(existsSync(path)).toBe(true);
      expect(f.logs.join("\n")).toMatch(/kept .*a remaining conversation works in/);
    }
  });

  it("stays whole while a live folder leads into it through a link, or names it by its real path", async () => {
    const viaLink = fixture();
    const linked = viaLink.work("scout", "t1").fill();
    symlinkSync(viaLink.folder("scout", "t1"), join(viaLink.outside, "alias"), "dir");
    viaLink.bots.push({ id: "other", cwd: join(viaLink.outside, "alias") });
    await deleteAndWait(viaLink, "t1");
    for (const path of linked.gone) expect(existsSync(path)).toBe(true);

    const byRealPath = fixture();
    const named = byRealPath.work("scout", "t1").fill();
    // The data folder reached through a link (on macOS the temporary folder is one): the live cwd names its real path.
    symlinkSync(byRealPath.dataDir, join(byRealPath.sandbox, "data-link"), "dir");
    const aliased = createConversationFolderCleanup({ dataDir: join(byRealPath.sandbox, "data-link"), records: () => ({ bots: [{ id: "other", cwd: realpathSync(byRealPath.folder("scout", "t1")) }], groups: [] }), drainAfterMs: false, pause: async () => {}, log: () => {}, warn: () => {} });
    aliased.conversationsGone(["t1"]);
    await aliased.idle();
    for (const path of named.gone) expect(existsSync(path)).toBe(true);
  });

  it.runIf(process.platform === "darwin" || process.platform === "win32")("stays whole while a live folder or the settings name it in another case", async () => {
    const f = fixture();
    const tree = f.work("scout", "t1").fill();
    f.bots.push({ id: "other", cwd: join(f.dataDir, "Task-Workspaces", "Scout", "T1") });
    await deleteAndWait(f, "t1");
    for (const path of tree.gone) expect(existsSync(path)).toBe(true);
    const named = fixture({ heldText: () => "C:\\DATA\\TASK-WORKSPACES\\SCOUT\\T1" });
    const other = named.work("scout", "t1").fill();
    await deleteAndWait(named, "t1");
    for (const path of other.gone) expect(existsSync(path)).toBe(true);
  });

  it("stays whole while the settings in memory name it, in any of the ways a path is written, or cannot be read", async () => {
    for (const held of [
      JSON.stringify({ instances: { x: { config: { cli: "/data/task-workspaces/scout/t1/app/node_modules/.bin/agent acp" } } } }),
      "C:\\data\\task-workspaces\\scout\\t1\\app",
      JSON.stringify({ cwd: "C:\\data\\task-workspaces\\scout\\t1" }),
      null,
    ]) {
      const f = fixture({ heldText: () => held });
      const tree = f.work("scout", "t1").fill();
      await deleteAndWait(f, "t1");
      for (const path of tree.gone) expect(existsSync(path), String(held)).toBe(true);
      expect(f.logs.join("\n")).toMatch(held === null ? /the settings cannot be read yet/ : /the settings or a routine name a path in it/);
    }
  });

  it("stays whole while the saved definitions or instructions name it", async () => {
    for (const [file, text] of [
      ["routines.json", JSON.stringify({ routines: [{ prompt: "run node /data/task-workspaces/scout/t1/app/server.js" }] })],
      ["published-pages.json", JSON.stringify([{ path: "C:\\data\\task-workspaces\\scout\\t1\\site" }])],
      [join("bots", "scout", "SOUL.md"), "My project lives in task-workspaces/scout/t1."],
      [join("workspaces", "scout", "memory", "projects.md"), "- app: task-workspaces/scout/t1/app"],
    ] as const) {
      const f = fixture();
      const tree = f.work("scout", "t1").fill();
      put(join(f.dataDir, file), text);
      await deleteAndWait(f, "t1");
      for (const path of tree.gone) expect(existsSync(path), file).toBe(true);
      expect(f.logs.join("\n")).toMatch(/saved definitions or instructions name a path in it/);
    }
  });

  it("stays whole while a remaining conversation's messages name it, or the transcripts cannot be read", async () => {
    const said = new Map<string, Set<string>>([["t1", new Set(["t2", "t1"])], ["t4", new Set(["gone"])]]);
    const asked: string[][] = [];
    const f = fixture({ mentions: async (words) => { asked.push([...words]); return new Map([...said].filter(([word]) => words.includes(word))); } });
    f.bots.push({ id: "scout", tasks: [{ threadId: "t2" }] });
    const named = f.work("scout", "t1").fill(), unnamed = f.work("scout", "t4").fill();
    await deleteAndWait(f, "t1", "t4");
    for (const path of named.gone) expect(existsSync(path)).toBe(true);
    for (const path of unnamed.gone) expect(existsSync(path)).toBe(false);
    expect(asked).toEqual([["t1", "t4"]]);
    const failing = fixture({ mentions: async () => { throw new Error("database is locked"); } });
    const tree = failing.work("scout", "t1").fill();
    await deleteAndWait(failing, "t1");
    for (const path of tree.gone) expect(existsSync(path)).toBe(true);
    expect(failing.logs.join("\n")).toMatch(/the transcripts cannot be read/);
  });

  it("stays whole while a link in the bot's other folders leads into it, relative or absolute", async () => {
    for (const target of ["relative", "absolute"]) {
      const f = fixture();
      const tree = f.work("scout", "t1").fill();
      mkdirSync(f.folder("scout", "t2"), { recursive: true });
      symlinkSync(target === "relative" ? join("..", "t1", "app") : join(f.folder("scout", "t1"), "app"), join(f.folder("scout", "t2"), "app-link"), "dir");
      await deleteAndWait(f, "t1");
      for (const path of tree.gone) expect(existsSync(path), target).toBe(true);
      expect(f.logs.join("\n")).toMatch(/a link in the bot's other folders leads into it/);
    }
  });

  it("is not held by a link of its own", async () => {
    const f = fixture();
    const tree = f.work("scout", "t1").fill();
    symlinkSync(join("..", "app"), join(f.folder("scout", "t1"), "py", "app-link"), "dir");
    await deleteAndWait(f, "t1");
    for (const path of tree.gone) expect(existsSync(path)).toBe(false);
  });

  it("stays whole while a process works inside it", async () => {
    const f = fixture({ processFolders: async () => [join(f.folder("scout", "t1"), "app")] });
    const tree = f.work("scout", "t1").fill();
    await deleteAndWait(f, "t1");
    for (const path of tree.gone) expect(existsSync(path)).toBe(true);
    expect(f.logs.join("\n")).toMatch(/a process works in it/);
  });

  it("stays whole while the server is frozen or a backup is under way, and goes once that ends", async () => {
    let paused: string | null = "frozen after a move";
    const f = fixture({ paused: () => paused });
    const tree = f.work("scout", "t1").fill();
    await deleteAndWait(f, "t1");
    for (const path of tree.gone) expect(existsSync(path)).toBe(true);
    expect(f.logs.join("\n")).toMatch(/kept .* for now: frozen after a move/);
    paused = null;
    await deleteAndWait(f, "t1");
    for (const path of tree.gone) expect(existsSync(path)).toBe(false);
  });

  it("checks again before each move: a conversation that starts working there keeps the rest", async () => {
    let moves = 0;
    const f = fixture({ paused: () => { if (++moves === 1) f.bots.push({ id: "scout", tasks: [{ threadId: "new", cwd: f.folder("scout", "t1") }] }); return null; } });
    const tree = f.work("scout", "t1").fill();
    await deleteAndWait(f, "t1");
    expect(tree.gone.filter(existsSync)).toHaveLength(1);
    expect(f.logs.join("\n")).toMatch(/kept .*a remaining conversation works in/);
  });
});

describe("a deleted bot", () => {
  it("loses the installs of every conversation folder it leaves, and keeps one a remaining conversation uses", async () => {
    const f = fixture();
    const now = f.work("scout", "t1").fill(), before = f.work("scout", "old").fill(), room = f.work("scout", "room1").fill();
    f.groups.push({ id: "g1", threadId: "room1" });
    f.cleanup.botGone("scout");
    await f.cleanup.idle();
    for (const path of [...now.gone, ...before.gone]) expect(existsSync(path)).toBe(false);
    for (const path of [...now.kept, ...before.kept, ...room.gone, ...room.kept]) expect(existsSync(path)).toBe(true);
  });
});

describe("paths", () => {
  it("never follows a link out of the data folder", async () => {
    const f = fixture();
    const victim = put(join(f.outside, "node_modules", "precious.js"));
    f.install(join(f.outside, "work"));
    mkdirSync(join(f.dataDir, "task-workspaces", "scout"), { recursive: true });
    symlinkSync(join(f.outside, "work"), f.folder("scout", "t1"), "dir");
    symlinkSync(join(f.outside, "work"), join(f.dataDir, "task-workspaces", "linked"), "dir");
    mkdirSync(f.folder("scout", "t2"), { recursive: true });
    put(join(f.folder("scout", "t2"), "package.json"));
    symlinkSync(join(f.outside, "node_modules"), join(f.folder("scout", "t2"), "node_modules"), "dir");
    // A link inside a real node_modules goes as a link, never what it points at.
    f.install(f.folder("scout", "t5"));
    symlinkSync(join(f.outside, "node_modules"), join(f.folder("scout", "t5"), "node_modules", "escape"), "dir");
    f.cleanup.conversationsGone(["t1", "t2", "t5"]);
    f.cleanup.botGone("linked");
    await f.cleanup.idle();
    expect(existsSync(victim)).toBe(true);
    expect(existsSync(join(f.outside, "work", "node_modules", "left-pad", "index.js"))).toBe(true);
    expect(existsSync(join(f.folder("scout", "t2"), "node_modules"))).toBe(true);
    expect(existsSync(join(f.folder("scout", "t5"), "node_modules"))).toBe(false);
    expect(f.removingEmpty()).toBe(true);
  });

  it("never reaches a folder a fork worked in through a linked bot folder", async () => {
    const f = fixture();
    const outsideTree = f.install(join(f.outside, "bot", "t1", "app"));
    mkdirSync(join(f.dataDir, "task-workspaces"), { recursive: true });
    symlinkSync(join(f.outside, "bot"), join(f.dataDir, "task-workspaces", "scout"), "dir");
    f.cleanup.conversationsGone(["fork"], [f.folder("scout", "t1")]);
    await f.cleanup.idle();
    expect(existsSync(join(outsideTree, "left-pad", "index.js"))).toBe(true);
    expect(f.removingEmpty()).toBe(true);
  });

  it("puts back what a link swapped in just before the move led to", async () => {
    const f = fixture({
      beforeMove: (path) => {
        // The tree's folder is swapped for a link to a folder outside holding an install of its own.
        const parent = dirname(path);
        renameSync(parent, join(f.sandbox, "moved-away"));
        symlinkSync(join(f.outside, "app"), parent, "dir");
      },
    });
    const outsideTree = f.install(join(f.outside, "app"));
    f.install(join(f.folder("scout", "t1"), "app"));
    await deleteAndWait(f, "t1");
    expect(existsSync(join(outsideTree, "left-pad", "index.js"))).toBe(true);
    expect(f.removingEmpty()).toBe(true);
    expect(f.warnings.join("\n")).toMatch(/it changed since it was checked/);
  });

  it("keeps a tree replaced after it was found", async () => {
    let swapped = false;
    const f = fixture({
      paused: () => {
        if (swapped) return null;
        swapped = true;
        const tree = join(f.folder("scout", "t1"), "app", "node_modules");
        renameSync(tree, join(f.sandbox, "old-tree"));
        put(join(tree, "new.js"));
        return null;
      },
    });
    f.install(join(f.folder("scout", "t1"), "app"));
    await deleteAndWait(f, "t1");
    expect(existsSync(join(f.folder("scout", "t1"), "app", "node_modules", "new.js"))).toBe(true);
    expect(f.warnings.join("\n")).toMatch(/it changed since it was checked/);
  });

  it("never moves a folder whose parent became a link to an outside folder, even when the link goes again", async () => {
    const f = fixture({
      beforeMove: (path) => {
        const parent = dirname(path);
        renameSync(parent, join(f.sandbox, "moved-away"));
        symlinkSync(join(f.outside, "app"), parent, "dir");
      },
    });
    f.install(join(f.outside, "app"));
    const precious = put(join(f.outside, "app", "node_modules", "precious.txt"), "work");
    f.install(join(f.folder("scout", "t1"), "app"));
    fsHooks.afterRename = (n) => { if (n === 1) rmSync(join(f.folder("scout", "t1"), "app")); };
    await deleteAndWait(f, "t1");
    await f.cleanup.drain();
    expect(existsSync(precious)).toBe(true);
  });

  it("keeps what a failed put-back left under a name the drain never takes", async () => {
    const f = fixture();
    const tree = f.install(join(f.folder("scout", "t1"), "app"));
    // Something other than the checked folder arrives (the moved entry replaced), and the way back is gone.
    fsHooks.afterRename = (n, _from, to) => {
      if (n !== 1) return;
      renameSync(to, `${to}-elsewhere`);
      put(join(to, "precious.txt"), "work");
      rmSync(dirname(tree), { recursive: true, force: true });
    };
    await deleteAndWait(f, "t1");
    await f.cleanup.drain();
    const kept = readdirSync(join(f.dataDir, REMOVING_DIR)).filter((name) => !name.endsWith("-elsewhere"));
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatch(/^check-\d+-[0-9a-f]{12}$/);
    expect(existsSync(join(f.dataDir, REMOVING_DIR, kept[0]!, "precious.txt"))).toBe(true);
    expect(f.warnings.join("\n")).toMatch(/COULD NOT PUT IT BACK/);
  });

  it("never walks into a folder swapped for a link while the drain lists it (the Node walk, where GNU rm is not there)", async () => {
    const f = fixture({ systemRm: async () => null });
    const precious = put(join(f.outside, "work", "thesis.docx"), "work");
    f.install(join(f.folder("scout", "t1"), "app"));
    put(join(f.folder("scout", "t1"), "app", "node_modules", "left-pad", "lib", "a.js"));
    let swapped = false;
    fsHooks.beforeReaddir = (path) => {
      if (!swapped && path.includes(REMOVING_DIR) && path.endsWith(join("left-pad", "lib"))) {
        swapped = true;
        renameSync(path, `${path}-x`);
        symlinkSync(join(f.outside, "work"), path, "dir");
      }
    };
    await deleteAndWait(f, "t1");
    expect(swapped).toBe(true);
    expect(existsSync(precious)).toBe(true);
  });

  it("leaves an entry a process still holds something in, and finishes it once none does", async () => {
    let held: string[] = [];
    const f = fixture({ processPaths: async () => held });
    f.install(join(f.folder("scout", "t1"), "app"));
    fsHooks.afterRename = (_n, _from, to) => { if (!to.includes("check-")) held = [join(to, "left-pad", "index.js")]; };
    await deleteAndWait(f, "t1");
    expect(f.removingEmpty()).toBe(false);
    expect(f.logs.join("\n")).toMatch(/left .* for now: a process still holds something in it/);
    held = [];
    await f.cleanup.drain();
    expect(f.removingEmpty()).toBe(true);
  });

  it("refuses a .removing that is a link, for moves and for finishing an earlier pass", async () => {
    const f = fixture();
    const tree = f.work("scout", "t1").fill();
    const kept = put(join(f.outside, "1700000000000-0123456789ab", "precious.txt"));
    symlinkSync(f.outside, join(f.dataDir, REMOVING_DIR), "dir");
    await deleteAndWait(f, "t1");
    await f.cleanup.drain();
    for (const path of tree.gone) expect(existsSync(path)).toBe(true);
    expect(existsSync(kept)).toBe(true);
    expect(f.warnings.join("\n")).toMatch(/not a plain folder/);
  });

  it("finishes only its own entries in .removing", async () => {
    const f = fixture();
    const mine = put(join(f.dataDir, REMOVING_DIR, "1700000000000-0123456789ab", "x.js"));
    const other = put(join(f.dataDir, REMOVING_DIR, "notes", "keep.txt"));
    await f.cleanup.drain();
    expect(existsSync(dirname(mine))).toBe(false);
    expect(existsSync(other)).toBe(true);
  });

  it("ignores an id that is not a plain name, wherever it comes in", async () => {
    const f = fixture();
    const victim = f.install(f.dataDir);
    f.install(join(f.dataDir, "task-workspaces", "scout"));
    put(join(f.dataDir, "tool-results-x", "keep.txt"));
    mkdirSync(join(f.dataDir, "x", "y"), { recursive: true });
    const deeper = f.install(join(f.folder("scout", "t1"), "app"));
    f.cleanup.conversationsGone(["..", "../..", "a/b", "", "t1/../..", "a\\b"]);
    f.cleanup.conversationsGone(["t9"], [join(f.dataDir, "task-workspaces", "..", "x", "y"), join(f.dataDir, "task-workspaces", "scout"), "relative/path", join(f.dataDir, "task-workspaces", "scout", "t1", "app")]);
    f.cleanup.botGone("..");
    f.cleanup.botGone("a/b");
    f.cleanup.orphans({ workspaces: [f.dataDir, join(f.dataDir, "task-workspaces", "scout")], results: ["..", "a/b"] });
    await f.cleanup.idle();
    expect(existsSync(join(victim, "left-pad", "index.js"))).toBe(true);
    expect(existsSync(join(f.dataDir, "task-workspaces", "scout", "node_modules", "left-pad", "index.js"))).toBe(true);
    // A fork that worked deeper inside a conversation folder hands over no folder: only a whole one is taken.
    expect(existsSync(join(deeper, "left-pad", "index.js"))).toBe(true);
    expect(existsSync(join(f.dataDir, "tool-results-x", "keep.txt"))).toBe(true);
    // Turned away where they come in: nothing was even looked at.
    expect(f.logs.filter((line) => line.includes("kept"))).toEqual([]);
    expect(f.warnings).toEqual([]);
    expect(f.cleanup.whyKept(join(f.dataDir, "task-workspaces", "scout"))).toBe("not a conversation folder");
    expect(f.cleanup.whyKept(join(f.dataDir, "task-workspaces", "sc out", "t1"))).toBe("not a conversation folder");
    expect(f.cleanup.whyKept(join(f.dataDir, "task-workspaces", "scout", "t1", "x"))).toBe("not a conversation folder");
  });

  it("knows a plain folder: inside its root, the root inside the data folder, no link on the way, really inside", () => {
    const f = fixture();
    const root = join(f.dataDir, "task-workspaces");
    mkdirSync(join(root, "scout", "t1"), { recursive: true });
    mkdirSync(join(f.outside, "t9"), { recursive: true });
    symlinkSync(join(f.outside, "t9"), join(root, "scout", "t9"), "dir");
    expect(plainFolderUnder(f.dataDir, root, join(root, "scout", "t1"))).toBe(true);
    expect(plainFolderUnder(f.dataDir, f.outside, join(f.outside, "t9"))).toBe(false); // root outside the data folder
    expect(plainFolderUnder(f.dataDir, root, join(f.dataDir, "other"))).toBe(false); // outside the root
    expect(plainFolderUnder(f.dataDir, root, root)).toBe(false); // the root itself
    expect(plainFolderUnder(f.dataDir, root, join(root, "scout", "t9"))).toBe(false); // a link
    expect(plainFolderUnder(f.dataDir, root, join(root, "scout", "missing"))).toBe(false);
    expect(plainFolderUnder(f.dataDir, root, join(root, "scout", "t9", "inner"))).toBe(false); // through a link
    // Each check on its own: a root around the data folder, a folder outside the root that exists, a link that leads
    // back into the data folder.
    mkdirSync(join(f.dataDir, "other"), { recursive: true });
    expect(plainFolderUnder(f.dataDir, f.sandbox, join(f.dataDir, "other"))).toBe(false);
    expect(plainFolderUnder(f.dataDir, root, join(f.dataDir, "other"))).toBe(false);
    symlinkSync(join(f.dataDir, "other"), join(root, "scout", "t8"), "dir");
    expect(plainFolderUnder(f.dataDir, root, join(root, "scout", "t8"))).toBe(false);
  });

  it("names a folder's mentions with both separators and as JSON writes a backslash", () => {
    expect(folderMentions("scout", "t1")).toEqual(["task-workspaces/scout/t1", "task-workspaces\\scout\\t1", "task-workspaces\\\\scout\\\\t1"]);
  });

  it("names tool results' folders as the MCP gate does", () => {
    for (const id of ["t1", "a".repeat(81), "x.y", "bad/../id", ""]) expect(gateResultsName(id)).toBe(basename(spillDir(id)));
  });

  it("keeps tool results kept under a name a remaining thread's results share", async () => {
    const f = fixture();
    const short = "a".repeat(80), long = `${short}b`;
    expect(gateResultsName(long)).toBe(short);
    expect(hookResultsName("t1")).toBe("t1");
    put(join(f.dataDir, "tool-results", short, "r.txt"));
    f.bots.push({ id: "scout", tasks: [{ threadId: long }] });
    await deleteAndWait(f, short);
    expect(existsSync(join(f.dataDir, "tool-results", short, "r.txt"))).toBe(true);
  });
});

describe("a git index", () => {
  it("reads v2 entries and refuses what it cannot tell", () => {
    const entry = (name: string) => {
      const length = Math.ceil((62 + name.length + 1) / 8) * 8;
      const out = Buffer.alloc(length);
      out.writeUInt16BE(Math.min(name.length, 0xfff), 60);
      out.write(name, 62, "utf8");
      return out;
    };
    const index = (version: number, names: string[], extension?: string) => {
      const header = Buffer.alloc(12);
      header.write("DIRC", 0, "latin1");
      header.writeUInt32BE(version, 4);
      header.writeUInt32BE(names.length, 8);
      const ext = extension ? Buffer.concat([Buffer.from(extension, "latin1"), Buffer.from([0, 0, 0, 0])]) : Buffer.alloc(0);
      return Buffer.concat([header, ...names.map(entry), ext, Buffer.alloc(20)]);
    };
    expect(indexNames(index(2, ["a.txt", "app/node_modules/x/index.js"]), "app/node_modules")).toBe(true);
    expect(indexNames(index(2, ["a.txt", "app/node_modules_old/x.js", "other/app/node_modules/x.js"]), "app/node_modules")).toBe(false);
    expect(indexNames(index(4, ["a.txt"]), "app/node_modules")).toBeNull();
    expect(indexNames(index(2, ["a.txt"], "link"), "app/node_modules")).toBeNull();
    expect(indexNames(index(2, ["a.txt"], "sdir"), "app/node_modules")).toBeNull();
    expect(indexNames(Buffer.from("not an index"), "x")).toBeNull();
  });
});

describe("a crash in the middle", () => {
  it("leaves the person's files and a part of the tree in .removing, which the next start finishes", async () => {
    let crash = true;
    // The Node walk, paced (a Cloud home's GNU rm runs in its own process).
    const f = fixture({ systemRm: async () => null, pause: async () => { if (crash) throw new Error("power cut"); } });
    const tree = f.work("scout", "t1");
    f.install(join(f.folder("scout", "t1"), "app"));
    for (let i = 0; i < 5_000; i++) put(join(f.folder("scout", "t1"), "app", "node_modules", `p${i % 50}`, `${i}.js`));
    await deleteAndWait(f, "t1");
    expect(existsSync(tree.gone[0]!)).toBe(false);
    for (const path of tree.kept) expect(existsSync(path)).toBe(true);
    expect(f.removingEmpty()).toBe(false);
    expect(f.warnings.join("\n")).toMatch(/power cut/);
    crash = false;
    const restarted = createConversationFolderCleanup({ dataDir: f.dataDir, records: () => ({ bots: [], groups: [] }), drainAfterMs: 0, pause: async () => {}, log: () => {}, systemRm: async () => null });
    await new Promise((done) => setTimeout(done, 0));
    await restarted.idle();
    expect(f.removingEmpty()).toBe(true);
    for (const path of tree.kept) expect(existsSync(path)).toBe(true);
  });

  it.runIf(posixOnly && process.getuid?.() !== 0)("removes a tree holding folders without write permission", async () => {
    const f = fixture();
    const tree = f.install(join(f.folder("scout", "t1"), "app"));
    put(join(tree, "locked", "inner", "file.js"));
    chmodSync(join(tree, "locked", "inner"), 0o500);
    chmodSync(join(tree, "locked"), 0o500);
    await deleteAndWait(f, "t1");
    expect(existsSync(tree)).toBe(false);
    expect(f.removingEmpty()).toBe(true);
  });
});
