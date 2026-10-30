import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { removeTempDir } from "../testing/cleanup.ts";
import { claudeToolSearchSetting, claudeToolSearchValue } from "./claude-tool-search.ts";

describe("claudeToolSearchValue", () => {
  it("turns unset and auto on", () => {
    for (const value of [undefined, "", "auto", "auto:10", "auto:99.5", "auto:x", "auto:Infinity", "auto:1.5e1"]) {
      expect(claudeToolSearchValue(value), String(value)).toBe("true");
    }
  });

  it("keeps any other value, so an opt-out holds", () => {
    // auto:N is clamped to 0..100: 100 and above is off, 0 and below already on.
    for (const value of ["false", "0", "off", "no", " FALSE ", "auto:100", "auto:150", "auto:1e2", "auto:1_000", "auto:1,000", "true", "1", "auto:0", "auto:-5", "AUTO"]) {
      expect(claudeToolSearchValue(value), value).toBe(value);
    }
  });
});

describe("claudeToolSearchSetting", () => {
  let root: string;
  let home: string;
  let env: NodeJS.ProcessEnv;
  const settingsFile = (folder: string, name: string, value: unknown) => {
    mkdirSync(join(folder, ".claude"), { recursive: true });
    writeFileSync(join(folder, ".claude", name), JSON.stringify({ env: { ENABLE_TOOL_SEARCH: value } }));
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "omb-tool-search-"));
    home = join(root, "home");
    mkdirSync(home);
    env = { HOME: home };
  });

  afterEach(async () => {
    await removeTempDir(root);
  });

  it("turns tool search on when nothing sets it", () => {
    const cwd = join(root, "bot");
    mkdirSync(cwd);
    expect(claudeToolSearchSetting(cwd, env)).toBe("true");
    expect(claudeToolSearchSetting(join(root, "missing"), env)).toBe("true");
  });

  it("honours the person's own opt-out, in their settings or the process environment", () => {
    const cwd = join(root, "bot");
    mkdirSync(cwd);
    settingsFile(home, "settings.json", "false");
    expect(claudeToolSearchSetting(cwd, env)).toBe("false");
    // A named account's settings live in its own folder.
    const account = join(root, "account");
    settingsFile(account, "settings.json", "auto:100");
    expect(claudeToolSearchSetting(cwd, { ...env, CLAUDE_CONFIG_DIR: join(account, ".claude") })).toBe("auto:100");
    expect(claudeToolSearchSetting(cwd, { HOME: join(root, "nobody"), ENABLE_TOOL_SEARCH: "0" })).toBe("0");
    expect(claudeToolSearchSetting(cwd, { HOME: join(root, "nobody"), ENABLE_TOOL_SEARCH: "auto" })).toBe("true");
  });

  it("reads local over project over the person's own settings over the process environment", () => {
    const cwd = join(root, "bot");
    mkdirSync(cwd);
    settingsFile(home, "settings.json", "auto");
    expect(claudeToolSearchSetting(cwd, { ...env, ENABLE_TOOL_SEARCH: "false" })).toBe("true");
    settingsFile(cwd, "settings.json", "false");
    expect(claudeToolSearchSetting(cwd, env)).toBe("false");
    settingsFile(cwd, "settings.local.json", "auto:20");
    expect(claudeToolSearchSetting(cwd, env)).toBe("true");
    // A file that is not JSON, or sets something else, is skipped.
    writeFileSync(join(cwd, ".claude", "settings.local.json"), "{ not json");
    expect(claudeToolSearchSetting(cwd, env)).toBe("false");
    writeFileSync(join(cwd, ".claude", "settings.local.json"), JSON.stringify({ env: { ENABLE_TOOL_SEARCH: false } }));
    expect(claudeToolSearchSetting(cwd, env)).toBe("false");
  });

  // On Windows Claude Code keeps the local file in the launch folder.
  it.skipIf(process.platform === "win32")("finds the local file at a repository's root, a worktree's main checkout included", () => {
    const repo = join(root, "repo");
    const nested = join(repo, "packages", "app");
    mkdirSync(join(repo, ".git", "worktrees", "wt"), { recursive: true });
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(repo, ".git", "worktrees", "wt", "commondir"), "../..\n");
    const worktree = join(root, "wt");
    mkdirSync(worktree);
    writeFileSync(join(worktree, ".git"), `gitdir: ${join(repo, ".git", "worktrees", "wt")}\n`);
    settingsFile(home, "settings.json", "auto");
    settingsFile(repo, "settings.local.json", "off");
    expect(claudeToolSearchSetting(nested, env)).toBe("off");
    expect(claudeToolSearchSetting(worktree, env)).toBe("off");
    // The root's file wins over one an older Claude Code left in the launch folder.
    settingsFile(nested, "settings.local.json", "auto");
    expect(claudeToolSearchSetting(nested, env)).toBe("off");
  });
});
