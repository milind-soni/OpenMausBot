// AGENTS.md as the per-project channel (Phase 1 part 3): read, capped,
// redacted, absent when missing, and skipped for the engine that reads it
// natively.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { PROJECT_INSTRUCTIONS_MAX_BYTES, projectInstructionsPrompt, readProjectInstructions } from "./project-instructions.ts";

const dirs: string[] = [];
const folder = () => { const d = mkdtempSync(join(tmpdir(), "omb-agents-md-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("project instructions", () => {
  it("reads the folder's AGENTS.md into a stable section for engines that do not read it themselves", () => {
    const cwd = folder();
    writeFileSync(join(cwd, "AGENTS.md"), "# Rules\nEnd every reply with the word ZEBRA.\n");
    const text = projectInstructionsPrompt(cwd, "claudeAgent");
    expect(text).toContain("Standing instructions from the project's AGENTS.md");
    expect(text).toContain(JSON.stringify(join(cwd, "AGENTS.md")));
    expect(text).toContain("End every reply with the word ZEBRA.");
    expect(projectInstructionsPrompt(cwd, "piAgent")).toBe(text);
    expect(projectInstructionsPrompt(cwd, "openai-compat")).toBe(text);
    // Codex reads AGENTS.md natively: a second copy would outrank the original
    expect(projectInstructionsPrompt(cwd, "codex")).toBe("");
  });

  it("is absent without the file, for an empty file, a folder named AGENTS.md, or no folder", () => {
    const cwd = folder();
    expect(projectInstructionsPrompt(cwd, "claudeAgent")).toBe("");
    writeFileSync(join(cwd, "AGENTS.md"), "   \n");
    expect(readProjectInstructions(cwd)).toBeNull();
    const other = folder();
    mkdirSync(join(other, "AGENTS.md"));
    expect(readProjectInstructions(other)).toBeNull();
    expect(readProjectInstructions(undefined)).toBeNull();
    expect(readProjectInstructions(join(cwd, "missing"))).toBeNull();
  });

  it("caps a long file and says so, and redacts a secret the file carries", () => {
    const cwd = folder();
    writeFileSync(join(cwd, "AGENTS.md"), `token: sk-ant-api03-${"a".repeat(80)}\n${"x".repeat(PROJECT_INSTRUCTIONS_MAX_BYTES + 500)}`);
    const found = readProjectInstructions(cwd)!;
    expect(found.truncated).toBe(true);
    expect(found.bytes).toBeGreaterThan(PROJECT_INSTRUCTIONS_MAX_BYTES);
    expect(Buffer.byteLength(found.text, "utf8")).toBeLessThanOrEqual(PROJECT_INSTRUCTIONS_MAX_BYTES);
    expect(found.text).not.toContain("sk-ant-api03-aaaa");
    expect(projectInstructionsPrompt(cwd, "claudeAgent")).toContain("only the first 16384 are shown");
  });
});
