import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { sweepTaskWorkspaceBuildFolders, type TaskWorkspaceRetentionCandidate } from "./task-workspace-retention.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const now = Date.parse("2026-01-31T12:00:00Z");
let root: string;

beforeEach(() => { root = mkdtempSync(join(tmpdir(), "omb-workspace-retention-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function candidate(overrides: Partial<TaskWorkspaceRetentionCandidate> & { threadId: string }): TaskWorkspaceRetentionCandidate {
  return { botId: "bot", lastActiveAt: now - 30 * DAY_MS, unread: false, busy: false, openDirectHandoff: false, ...overrides };
}

function file(path: string, text = "x") {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

function workspace(threadId: string) {
  const dir = join(root, "bot", threadId);
  file(join(dir, "notes.md"));
  file(join(dir, "repo", "package.json"), "{}");
  file(join(dir, "repo", "node_modules", "left-pad", "index.js"));
  file(join(dir, "repo", "src", "index.ts"));
  file(join(dir, "py", ".venv", "pyvenv.cfg"));
  file(join(dir, "py", ".venv", "lib", "site.py"));
  file(join(dir, "rust", "Cargo.toml"));
  file(join(dir, "rust", "target", "debug", "app"));
  return dir;
}

describe("task workspace retention", () => {
  it("removes dependency folders of a long-idle thread and keeps its own files and build output", async () => {
    const dir = workspace("old");

    const removed = await sweepTaskWorkspaceBuildFolders([candidate({ threadId: "old" })], 14, now, root);

    expect(removed.sort()).toEqual([join(dir, "py", ".venv"), join(dir, "repo", "node_modules")].sort());
    // Build output syncs to the person's computer, so it stays.
    for (const kept of ["notes.md", "repo/package.json", "repo/src/index.ts", "rust/Cargo.toml", "rust/target/debug/app"]) expect(existsSync(join(dir, kept)), kept).toBe(true);
  });

  it("keeps folders that only share a name with a dependency folder", async () => {
    const dir = join(root, "bot", "lookalikes");
    file(join(dir, "docs", "target", "page.md"));
    file(join(dir, "venv", "readme.md"));

    expect(await sweepTaskWorkspaceBuildFolders([candidate({ threadId: "lookalikes" })], 14, now, root)).toEqual([]);
    expect(existsSync(join(dir, "docs", "target", "page.md"))).toBe(true);
    expect(existsSync(join(dir, "venv", "readme.md"))).toBe(true);
  });

  it("never touches a recent, busy, unread or handed-off thread", async () => {
    const cases = [
      candidate({ threadId: "recent", lastActiveAt: now - 13 * DAY_MS }),
      candidate({ threadId: "exact", lastActiveAt: now - 14 * DAY_MS }),
      candidate({ threadId: "busy", busy: true }),
      candidate({ threadId: "unread", unread: true }),
      candidate({ threadId: "handoff", openDirectHandoff: true }),
    ];
    for (const each of cases) workspace(each.threadId);

    expect(await sweepTaskWorkspaceBuildFolders(cases, 14, now, root)).toEqual([]);
    for (const each of cases) expect(existsSync(join(root, "bot", each.threadId, "repo", "node_modules"))).toBe(true);
  });

  it("does not follow a link out of the workspace", async () => {
    const outside = join(root, "outside");
    file(join(outside, "node_modules", "keep.js"));
    const dir = join(root, "bot", "linked");
    mkdirSync(dir, { recursive: true });
    symlinkSync(outside, join(dir, "elsewhere"), "junction");

    expect(await sweepTaskWorkspaceBuildFolders([candidate({ threadId: "linked" })], 14, now, root)).toEqual([]);
    expect(existsSync(join(outside, "node_modules", "keep.js"))).toBe(true);
  });

  it("skips a bot folder that is a link", async () => {
    const outside = join(root, "outside");
    file(join(outside, "linked", "repo", "node_modules", "keep.js"));
    symlinkSync(outside, join(root, "linkbot"), "junction");

    expect(await sweepTaskWorkspaceBuildFolders([candidate({ botId: "linkbot", threadId: "linked" })], 14, now, root)).toEqual([]);
    expect(existsSync(join(outside, "linked", "repo", "node_modules", "keep.js"))).toBe(true);
  });

  it("ignores ids that are not plain folder names and threads without a workspace", async () => {
    file(join(root, "escape", "node_modules", "keep.js"));

    expect(await sweepTaskWorkspaceBuildFolders([
      candidate({ botId: "..", threadId: "escape" }),
      candidate({ threadId: "never-created" }),
    ], 14, now, root)).toEqual([]);
    expect(existsSync(join(root, "escape", "node_modules", "keep.js"))).toBe(true);
  });
});
