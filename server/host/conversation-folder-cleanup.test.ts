import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { spillDir } from "../mcp-gate-config.ts";
import { createConversationFolderCleanup, gateResultsName, hookResultsName, REMOVING_DIR, type FolderCleanupDeps, type LiveRecords } from "./conversation-folder-cleanup.ts";

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function put(path: string, text = "x"): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

type Bots = Array<LiveRecords["bots"][number] & { tasks?: Array<{ threadId: string; cwd?: string | null }> }>;
type Groups = Array<LiveRecords["groups"][number]>;

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
  /** A conversation folder with the person's files and the three kinds of rebuildable tree. */
  const work = (bot: string, thread: string) => {
    const at = folder(bot, thread);
    return {
      kept: [
        put(join(at, "report.md"), "the person's report"),
        put(join(at, "app", "package.json"), "{}"),
        put(join(at, "app", "src", "index.js")),
        put(join(at, "tool", "Cargo.toml")),
        put(join(at, "tool", "src", "main.rs")),
        put(join(at, "venv-lookalike", "venv", "notes.txt")), // no pyvenv.cfg: not a venv
        put(join(at, "target", "output.csv")), // no Cargo.toml beside it: not a build folder
        put(join(at, "repo", ".git", "node_modules", "HEAD")), // never walked into .git
      ],
      gone: [
        join(at, "app", "node_modules"),
        join(at, "py", ".venv"),
        join(at, "tool", "target"),
      ],
      fill() {
        put(join(at, "app", "node_modules", "left-pad", "index.js"));
        put(join(at, "app", "node_modules", ".bin", "x"));
        put(join(at, "py", ".venv", "pyvenv.cfg"));
        put(join(at, "py", ".venv", "lib", "site.py"));
        put(join(at, "tool", "target", "debug", "tool"));
        return this;
      },
    };
  };
  const removingEmpty = () => !existsSync(join(dataDir, REMOVING_DIR)) || readdirSync(join(dataDir, REMOVING_DIR)).length === 0;
  return { dataDir, outside, bots, groups, logs, warnings, cleanup, folder, work, removingEmpty };
}

describe("a deleted conversation's folder", () => {
  it("loses its dependency and build trees and keeps the person's files", async () => {
    const f = fixture();
    const tree = f.work("scout", "t1").fill();
    f.cleanup.conversationsGone(["t1"]);
    await f.cleanup.idle();
    for (const path of tree.gone) expect(existsSync(path), path).toBe(false);
    for (const path of tree.kept) expect(existsSync(path), path).toBe(true);
    expect(f.removingEmpty()).toBe(true);
    expect(f.logs.join("\n")).toMatch(/removed 3 dependency, build or tool-result folder/);
  });

  it("loses its full tool results", async () => {
    const f = fixture();
    put(join(f.dataDir, "tool-results", "t1", "abc.txt"));
    put(join(f.dataDir, "tool-results", "t2", "def.txt"));
    f.bots.push({ id: "scout", tasks: [{ threadId: "t2" }] });
    f.cleanup.conversationsGone(["t1"]);
    await f.cleanup.idle();
    expect(existsSync(join(f.dataDir, "tool-results", "t1"))).toBe(false);
    expect(existsSync(join(f.dataDir, "tool-results", "t2", "def.txt"))).toBe(true);
  });

  it("takes each member's folder of a deleted room conversation", async () => {
    const f = fixture();
    const a = f.work("ann", "room1").fill(), b = f.work("ben", "room1").fill();
    f.cleanup.conversationsGone(["room1"]);
    await f.cleanup.idle();
    for (const path of [...a.gone, ...b.gone]) expect(existsSync(path)).toBe(false);
    for (const path of [...a.kept, ...b.kept]) expect(existsSync(path)).toBe(true);
  });
});

describe("a folder something remaining still uses", () => {
  it("stays whole while its conversation remains anywhere, as a bot's or a room's", async () => {
    const f = fixture();
    const own = f.work("scout", "t1").fill(), room = f.work("scout", "room1").fill();
    f.bots.push({ id: "other", tasks: [{ threadId: "t1" }] });
    f.groups.push({ id: "g1", threadId: "room1" });
    f.cleanup.conversationsGone(["t1", "room1"]);
    await f.cleanup.idle();
    for (const path of [...own.gone, ...room.gone]) expect(existsSync(path)).toBe(true);
  });

  it("stays whole while a fork, a bot or a room works in it, inside it or above it in the data folder", async () => {
    for (const used of [
      (f: ReturnType<typeof fixture>) => f.bots.push({ id: "scout", tasks: [{ threadId: "fork", cwd: f.folder("scout", "t1") }] }),
      (f: ReturnType<typeof fixture>) => f.bots.push({ id: "scout", cwd: join(f.folder("scout", "t1"), "app") }),
      (f: ReturnType<typeof fixture>) => f.bots.push({ id: "scout", cwd: join(f.dataDir, "task-workspaces", "scout") }),
      (f: ReturnType<typeof fixture>) => f.groups.push({ id: "g1", threadId: "room9", pinnedCwd: f.folder("scout", "t1") }),
      (f: ReturnType<typeof fixture>) => f.groups.push({ id: "g1", threadId: "room9", tasks: [{ threadId: "room9", pinnedCwd: f.folder("scout", "t1") }] }),
    ]) {
      const f = fixture();
      const tree = f.work("scout", "t1").fill();
      used(f);
      f.cleanup.conversationsGone(["t1"]);
      await f.cleanup.idle();
      for (const path of tree.gone) expect(existsSync(path)).toBe(true);
      expect(f.logs.join("\n")).toMatch(/kept .*a remaining conversation works in/);
    }
  });

  it("stays whole while the saved settings name a path in it", async () => {
    const f = fixture({ heldText: () => JSON.stringify({ tool: { command: "/data/task-workspaces/scout/t1/app/node_modules/.bin/x" } }) });
    const tree = f.work("scout", "t1").fill();
    f.cleanup.conversationsGone(["t1"]);
    await f.cleanup.idle();
    for (const path of tree.gone) expect(existsSync(path)).toBe(true);
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
    f.cleanup.conversationsGone([short]);
    await f.cleanup.idle();
    expect(existsSync(join(f.dataDir, "tool-results", short, "r.txt"))).toBe(true);
  });
});

describe("a deleted bot", () => {
  it("loses the rebuildable trees of every conversation folder it leaves, and keeps one a remaining conversation uses", async () => {
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
    const outsideWork = put(join(f.outside, "work", "node_modules", "precious.js"));
    // A conversation folder that is a link, a bots folder that is a link, and a node_modules that is a link.
    mkdirSync(join(f.dataDir, "task-workspaces", "scout"), { recursive: true });
    symlinkSync(join(f.outside, "work"), f.folder("scout", "t1"), "dir");
    symlinkSync(join(f.outside, "work"), join(f.dataDir, "task-workspaces", "linked"), "dir");
    mkdirSync(f.folder("scout", "t2"), { recursive: true });
    symlinkSync(join(f.outside, "node_modules"), join(f.folder("scout", "t2"), "node_modules"), "dir");
    // A link inside a real node_modules goes as a link, never what it points at.
    put(join(f.folder("scout", "t3"), "node_modules", "a.js"));
    symlinkSync(join(f.outside, "node_modules"), join(f.folder("scout", "t3"), "node_modules", "escape"), "dir");
    f.cleanup.conversationsGone(["t1", "t2", "t3"]);
    f.cleanup.botGone("linked");
    await f.cleanup.idle();
    expect(existsSync(victim)).toBe(true);
    expect(existsSync(outsideWork)).toBe(true);
    expect(existsSync(join(f.folder("scout", "t2"), "node_modules"))).toBe(true);
    expect(existsSync(join(f.folder("scout", "t3"), "node_modules"))).toBe(false);
    expect(f.removingEmpty()).toBe(true);
  });

  it("ignores an id that is not a plain name", async () => {
    const f = fixture();
    const victim = put(join(f.dataDir, "node_modules", "keep.js"));
    put(join(f.dataDir, "tool-results-x", "keep.txt"));
    f.cleanup.conversationsGone(["..", "../..", "a/b", "", "t1/../.."]);
    f.cleanup.botGone("..");
    await f.cleanup.idle();
    expect(existsSync(victim)).toBe(true);
    expect(existsSync(join(f.dataDir, "tool-results-x", "keep.txt"))).toBe(true);
  });

  it("refuses a .removing that is a link", async () => {
    const f = fixture();
    const tree = f.work("scout", "t1").fill();
    symlinkSync(f.outside, join(f.dataDir, REMOVING_DIR), "dir");
    f.cleanup.conversationsGone(["t1"]);
    await f.cleanup.idle();
    for (const path of tree.gone) expect(existsSync(path)).toBe(true);
    expect(readdirSync(f.outside)).toEqual([]);
    expect(f.warnings.join("\n")).toMatch(/not a plain folder/);
  });
});

describe("a crash in the middle", () => {
  it("leaves the person's files and a part of the tree in .removing, which the next start finishes", async () => {
    let crash = true;
    const f = fixture({ pause: async () => { if (crash) throw new Error("power cut"); } });
    const tree = f.work("scout", "t1");
    for (let i = 0; i < 5_000; i++) put(join(f.folder("scout", "t1"), "app", "node_modules", `p${i % 50}`, `${i}.js`));
    f.cleanup.conversationsGone(["t1"]);
    await f.cleanup.idle();
    expect(existsSync(tree.gone[0]!)).toBe(false);
    for (const path of tree.kept) expect(existsSync(path)).toBe(true);
    expect(f.removingEmpty()).toBe(false);
    expect(f.warnings.join("\n")).toMatch(/power cut/);
    crash = false;
    const restarted = createConversationFolderCleanup({ dataDir: f.dataDir, records: () => ({ bots: [], groups: [] }), drainAfterMs: 0, pause: async () => {}, log: () => {} });
    await new Promise((done) => setTimeout(done, 0));
    await restarted.idle();
    expect(f.removingEmpty()).toBe(true);
    for (const path of tree.kept) expect(existsSync(path)).toBe(true);
  });
});
