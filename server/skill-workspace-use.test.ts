import { mkdirSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { noteSkillWorkspaceUse, skillWorkspaceMayBeInUse, workspaceMayContain } from "./skill-task-links.ts";
import type { BotRecord, Store } from "./store.ts";
import { ensureWorkspace } from "./workspace.ts";

describe("skill workspace use", () => {
  it("reserves the configured folder of the actual room thread, not the active thread's pin", () => {
    const owner = "skill-use-owner", other = "skill-use-other";
    const root = ensureWorkspace(owner), otherRoot = ensureWorkspace(other);
    const group = { id: "room", cwd: root, pinnedCwd: otherRoot };
    let pinned: string | null | undefined;
    const store = {
      groupByThread: () => group,
      groupTaskByThread: () => ({ pinnedCwd: pinned }),
      taskByThread: () => undefined,
    } as unknown as Store;
    expect(skillWorkspaceMayBeInUse(owner, [], ["room-thread"], store, new Map())).toBe(true);
    expect(skillWorkspaceMayBeInUse(other, [], ["room-thread"], store, new Map())).toBe(false);
    pinned = null;
    expect(skillWorkspaceMayBeInUse(owner, [], ["room-thread"], store, new Map())).toBe(false);
    pinned = otherRoot;
    expect(skillWorkspaceMayBeInUse(other, [], ["room-thread"], store, new Map())).toBe(true);
  });

  it("reserves a direct turn's pinned folder and treats a missing alias conservatively", () => {
    const owner = "direct-skill-owner", other = "direct-skill-other";
    const root = ensureWorkspace(owner), otherRoot = ensureWorkspace(other);
    const bot = { id: other, cwd: root } as BotRecord;
    let pinned: string | null | undefined;
    const store = { taskByThread: () => ({ cwd: pinned }), groupByThread: () => undefined } as unknown as Store;
    const direct: Array<[string, BotRecord]> = [["direct-thread", bot]];
    expect(skillWorkspaceMayBeInUse(owner, direct, [], store, new Map())).toBe(true);
    pinned = otherRoot;
    expect(skillWorkspaceMayBeInUse(owner, direct, [], store, new Map())).toBe(false);
    pinned = join(root, "..", "missing-alias");
    expect(skillWorkspaceMayBeInUse(owner, direct, [], store, new Map())).toBe(true);
    expect(workspaceMayContain(owner, undefined)).toBe(false);
  });

  it.skipIf(process.platform === "win32")("keeps the recorded reservation when a working-folder alias is retargeted", () => {
    const owner = "alias-skill-owner", root = ensureWorkspace(owner);
    const alias = join(DATA_DIR, "turn-alias"), elsewhere = join(DATA_DIR, "turn-elsewhere");
    mkdirSync(elsewhere); symlinkSync(root, alias);
    const turn = {}, turns = new Map([["room-thread", turn]]);
    const group = { id: "room", pinnedCwd: alias };
    const store = { groupByThread: () => group, groupTaskByThread: () => undefined } as unknown as Store;
    noteSkillWorkspaceUse(turn, alias, [owner]);
    unlinkSync(alias); symlinkSync(elsewhere, alias);
    expect(skillWorkspaceMayBeInUse(owner, [], ["room-thread"], store, turns)).toBe(true);
    turns.delete("room-thread");
    expect(skillWorkspaceMayBeInUse(owner, [], ["room-thread"], store, turns)).toBe(false);
  });
});
