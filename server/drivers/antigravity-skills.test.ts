import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

import { DATA_DIR } from "../config.ts";
import { stageAntigravitySkills } from "./antigravity-skills.ts";

function fixture(name: string) {
  const source = join(DATA_DIR, name, "skills", ".revisions", "revision");
  const cwd = join(DATA_DIR, name, "task");
  mkdirSync(join(source, "references"), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const file = join(source, "SKILL.md");
  writeFileSync(file, "Read references/guide.md.");
  writeFileSync(join(source, "references", "guide.md"), "Reviewed reference");
  return { source, cwd, file };
}

describe("Antigravity skill staging", () => {
  it("stages selected skills and references inside cwd, rewriting every prompt half and slash command", () => {
    const { source, cwd, file } = fixture("stage");
    const text = "Read " + JSON.stringify(file);
    const turn = { threadId: "thread", text, system: text, systemStable: text, systemVolatile: text, recoveryText: text, skillFiles: [file] };
    const staged = stageAntigravitySkills(turn, cwd);
    const target = JSON.parse(staged.text.slice(5)) as string;
    expect(relative(realpathSync(cwd), realpathSync(target))).not.toMatch(/^\.\./);
    expect(readFileSync(target, "utf8")).toBe("Read references/guide.md.");
    expect(readFileSync(join(target, "..", "references", "guide.md"), "utf8")).toBe("Reviewed reference");
    for (const field of ["system", "systemStable", "systemVolatile", "recoveryText"] as const) expect(staged[field]).toBe(staged.text);
    expect(turn.text).toBe(text);
    expect(stageAntigravitySkills(turn, cwd).text).toBe(staged.text);

    writeFileSync(join(source, "references", "guide.md"), "Updated reference");
    expect(stageAntigravitySkills(turn, cwd).text).not.toBe(staged.text);
    expect(readFileSync(join(target, "..", "references", "guide.md"), "utf8")).toBe("Reviewed reference");
  });

  it("does not stage a path supplied only by prompt text", () => {
    const { cwd, file } = fixture("unselected");
    const turn = { threadId: "thread", text: "Read " + JSON.stringify(file), skillFiles: [] };
    expect(stageAntigravitySkills(turn, cwd)).toEqual(turn);
    expect(stageAntigravitySkills({ ...turn, text: "No skill requested", skillFiles: [file] }, cwd).text).toBe("No skill requested");
  });

  it("refuses changed staged bytes instead of trusting the cached path", () => {
    const { cwd, file } = fixture("tampered");
    const turn = { threadId: "thread", text: "Read " + JSON.stringify(file), skillFiles: [file] };
    const staged = stageAntigravitySkills(turn, cwd);
    const target = JSON.parse(staged.text.slice(5)) as string;
    writeFileSync(target, "Unreviewed");
    expect(() => stageAntigravitySkills(turn, cwd)).toThrow("staged skill files changed");
    expect(readFileSync(file, "utf8")).toBe("Read references/guide.md.");
  });

  it("rejects source links and staging directory junctions", () => {
    const { source, cwd, file } = fixture("links");
    const outside = join(DATA_DIR, "outside");
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(source, "escape"), process.platform === "win32" ? "junction" : "dir");
    const turn = { threadId: "thread", text: "Read " + JSON.stringify(file), skillFiles: [file] };
    expect(() => stageAntigravitySkills(turn, cwd)).toThrow("unsafe file");
    const other = fixture("root-link");
    symlinkSync(outside, join(other.cwd, ".omb-skills"), process.platform === "win32" ? "junction" : "dir");
    expect(() => stageAntigravitySkills({ ...turn, text: "Read " + JSON.stringify(other.file), skillFiles: [other.file] }, other.cwd)).toThrow("staging path");
  });
});
