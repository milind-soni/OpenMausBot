// The project memory fold (#7540): the walk mirrors Claude Code's own loader, whose fallback and scope rules decide
// what a session's system prompt may carry.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { claudeProjectMemory, withProjectMemory } from "./claude-project-memory.ts";
import { removeTempDir } from "../testing/cleanup.ts";

let scratch: string | null = null;
const root = (): string => (scratch ??= mkdtempSync(join(tmpdir(), "omb-claude-project-memory-")));
const folder = (): string => mkdtempSync(join(root(), "cwd-"));
const home = (): string => join(root(), "home");

afterEach(() => {
  if (scratch) removeTempDir(scratch);
  scratch = null;
});

describe("claudeProjectMemory", () => {
  it("folds the working folder's AGENTS.md when no CLAUDE.md sits anywhere above", () => {
    const cwd = folder();
    writeFileSync(join(cwd, "AGENTS.md"), "Keep replies short.\n");
    const memory = claudeProjectMemory(cwd, home());
    expect(memory).toEqual({
      text: `Instructions from ${join(cwd, "AGENTS.md")}:\n\nKeep replies short.`,
      excludes: [join(cwd, "AGENTS.md")],
    });
  });

  it("takes the ancestor CLAUDE.md instead of the working folder's AGENTS.md: the fallback is for a tree without one", () => {
    const above = folder(), cwd = join(above, "bot");
    mkdirSync(cwd);
    writeFileSync(join(above, "CLAUDE.md"), "Above.");
    writeFileSync(join(cwd, "AGENTS.md"), "Below.");
    const memory = claudeProjectMemory(cwd, home());
    expect(memory?.excludes).toEqual([join(above, "CLAUDE.md")]);
    expect(memory?.text).toContain("Above.");
    expect(memory?.text).not.toContain("Below.");
  });

  it("walks root-down, a folder's CLAUDE.local.md after its CLAUDE.md", () => {
    const above = folder(), cwd = join(above, "bot");
    mkdirSync(cwd);
    writeFileSync(join(above, "CLAUDE.md"), "root first");
    writeFileSync(join(cwd, "CLAUDE.md"), "the folder");
    writeFileSync(join(cwd, "CLAUDE.local.md"), "then the local one");
    const memory = claudeProjectMemory(cwd, home());
    expect(memory?.text).toBe(
      `Instructions from ${join(above, "CLAUDE.md")}:\n\nroot first\n\n` +
      `Instructions from ${join(cwd, "CLAUDE.md")}:\n\nthe folder\n\n` +
      `Instructions from ${join(cwd, "CLAUDE.local.md")}:\n\nthen the local one`,
    );
    expect(memory?.excludes).toEqual([join(above, "CLAUDE.md"), join(cwd, "CLAUDE.md"), join(cwd, "CLAUDE.local.md")]);
  });

  it("counts the project's own .claude/CLAUDE.md, in the working folder only", () => {
    const cwd = folder();
    mkdirSync(join(cwd, ".claude"));
    writeFileSync(join(cwd, ".claude", "CLAUDE.md"), "Project settings memory.");
    writeFileSync(join(cwd, "AGENTS.md"), "Never, a CLAUDE.md exists.");
    const memory = claudeProjectMemory(cwd, home());
    expect(memory?.excludes).toEqual([join(cwd, ".claude", "CLAUDE.md")]);
    expect(memory?.text).toContain("Project settings memory.");
    expect(memory?.text).not.toContain("Never,");
  });

  it("never folds the home's own .claude memory into a bot working under it", () => {
    const homeDir = home();
    mkdirSync(join(homeDir, ".claude"), { recursive: true });
    writeFileSync(join(homeDir, ".claude", "CLAUDE.md"), "The person's own.");
    const cwd = join(homeDir, "bot");
    mkdirSync(cwd);
    writeFileSync(join(cwd, "AGENTS.md"), "The bot's own.");
    const memory = claudeProjectMemory(cwd, homeDir);
    expect(memory?.text).toContain("The bot's own.");
    expect(memory?.text).not.toContain("The person's own.");
    expect(memory?.excludes).toEqual([join(cwd, "AGENTS.md")]);
  });

  it("falls back to the home's own CLAUDE.md as plain ancestor memory, whose .claude stays out", () => {
    const homeDir = home();
    mkdirSync(join(homeDir, ".claude"), { recursive: true });
    writeFileSync(join(homeDir, ".claude", "CLAUDE.md"), "The person's own.");
    writeFileSync(join(homeDir, "CLAUDE.md"), "Ancestor memory.");
    expect(claudeProjectMemory(homeDir, homeDir)?.excludes).toEqual([join(homeDir, "CLAUDE.md")]);
  });

  it("returns null when the tree holds no memory", () => {
    expect(claudeProjectMemory(folder(), home())).toBeNull();
  });

  it("skips a file over the size the CLI skips, but its CLAUDE.md existence still holds the AGENTS.md fallback off", () => {
    const cwd = folder();
    writeFileSync(join(cwd, "CLAUDE.md"), "x".repeat(4 * 1024 * 1024 + 1));
    writeFileSync(join(cwd, "AGENTS.md"), "Still not read.");
    expect(claudeProjectMemory(cwd, home())).toBeNull();
  });

  it("withProjectMemory appends the fold to the launch prompt, or stands alone", () => {
    const memory = { text: "Instructions from /b/AGENTS.md:\n\nBe kind.", excludes: ["/b/AGENTS.md"] };
    expect(withProjectMemory("You are Testy.", memory)).toBe("You are Testy.\n\nInstructions from /b/AGENTS.md:\n\nBe kind.");
    expect(withProjectMemory(undefined, memory)).toBe("Instructions from /b/AGENTS.md:\n\nBe kind.");
    expect(withProjectMemory("You are Testy.", null)).toBe("You are Testy.");
    expect(withProjectMemory(undefined, null)).toBeUndefined();
  });
});
