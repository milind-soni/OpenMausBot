import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  graphWorkspaceIdentity,
  graphWorkspaceIdentityMatches,
  graphWorkspaceReady,
} from "./agent-graph-workspace.ts";

describe("agent graph workspace identity", () => {
  const temporary: string[] = [];
  afterEach(() => {
    for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  it("changes when the approved workspace is replaced at the same path", () => {
    const parent = mkdtempSync(join(tmpdir(), "omb-graph-workspace-"));
    temporary.push(parent);
    const root = join(parent, "checkout");
    mkdirSync(join(root, ".git"), { recursive: true });
    const approved = graphWorkspaceIdentity(root);

    renameSync(root, join(parent, "approved-checkout"));
    mkdirSync(join(root, ".git"), { recursive: true });

    expect(graphWorkspaceIdentity(root)).not.toBe(approved);
    expect(graphWorkspaceIdentityMatches(root, approved)).toBe(false);
  });

  it("binds linked-worktree marker content and git-directory identity", () => {
    const parent = mkdtempSync(join(tmpdir(), "omb-graph-worktree-"));
    temporary.push(parent);
    const root = join(parent, "checkout");
    const firstGitDir = join(parent, "admin", "first");
    const secondGitDir = join(parent, "admin", "second");
    mkdirSync(root, { recursive: true });
    mkdirSync(firstGitDir, { recursive: true });
    mkdirSync(secondGitDir, { recursive: true });
    writeFileSync(join(root, ".git"), "gitdir: ../admin/first\n");
    const approved = graphWorkspaceIdentity(root);

    writeFileSync(join(root, ".git"), "gitdir: ../admin/second\n");

    expect(graphWorkspaceIdentity(root)).not.toBe(approved);
  });

  it("rejects a symlink workspace root", () => {
    const parent = mkdtempSync(join(tmpdir(), "omb-graph-workspace-link-"));
    temporary.push(parent);
    const target = join(parent, "target");
    const link = join(parent, "link");
    mkdirSync(target);
    symlinkSync(target, link);

    expect(graphWorkspaceReady(link)).toBe(false);
    expect(() => graphWorkspaceIdentity(link)).toThrow(/non-symlink directory/);
  });
});
