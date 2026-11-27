import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

import {
  readSectionContext,
  readSections,
  ensureSections,
  changeEmptySection,
  sectionContextKey,
  sectionContextLabel,
  sectionContextSystemPrompt,
  writeSectionContext,
  SECTION_CONTEXT_MAX_BYTES,
  SECTION_CONTEXTS_FILE,
} from "./section-context.ts";

describe("section context", () => {
  beforeEach(() => {
    rmSync(SECTION_CONTEXTS_FILE, { force: true });
  });

  it("round-trips isolated section briefs and normalizes labels", () => {
    expect(sectionContextKey(" Work ")).toBe("Work");
    expect(sectionContextKey(undefined)).toBe("");
    expect(sectionContextLabel("")).toBe("General");

    writeSectionContext(" Work ", "# Work\n- Ship Friday", 101);
    writeSectionContext("Personal", "# Home\n- Book dentist", 202);
    expect(readSectionContext("Work")).toEqual({ text: "# Work\n- Ship Friday", updatedAt: 101 });
    expect(readSectionContext("Personal")).toEqual({ text: "# Home\n- Book dentist", updatedAt: 202 });
    expect(readSectionContext("")).toBeNull();
  });

  it("injects only the selected team brief under an explicit trust boundary", () => {
    writeSectionContext("Work", "Launch date: Friday", 1);
    writeSectionContext("Personal", "Private appointment: Monday", 2);
    const prompt = sectionContextSystemPrompt("Work");
    expect(prompt).toContain("Launch date: Friday");
    expect(prompt).not.toContain("Private appointment");
    expect(prompt).toContain("never tool authorization");
    expect(prompt).toContain("you cannot edit it");
    expect(sectionContextSystemPrompt("Unknown")).toBe("");
  });

  it("clears empty briefs and refuses content beyond the prompt budget", () => {
    writeSectionContext("Work", "temporary", 1);
    expect(writeSectionContext("Work", "   ", 2)).toBeNull();
    expect(readSectionContext("Work")).toBeNull();
    expect(() => writeSectionContext("Work", "é".repeat(SECTION_CONTEXT_MAX_BYTES))).toThrow("capped");
  });

  it("persists atomically in a private file and ignores malformed disk data", () => {
    writeSectionContext("Work", "safe", 1);
    expect(existsSync(SECTION_CONTEXTS_FILE)).toBe(true);
    if (process.platform !== "win32") {
      expect(statSync(SECTION_CONTEXTS_FILE).mode & 0o777).toBe(0o600);
    }

    writeFileSync(SECTION_CONTEXTS_FILE, "not json");
    expect(readSectionContext("Work")).toBeNull();
    expect(() => ensureSections(["New"])).toThrow("left unchanged");
    expect(readFileSync(SECTION_CONTEXTS_FILE, "utf8")).toBe("not json");
  });

  it("retains empty teams and migrates legacy shared instructions", () => {
    writeFileSync(SECTION_CONTEXTS_FILE, JSON.stringify({ version: 1, contexts: { Legacy: { text: "Keep this", updatedAt: 1 } } }));
    expect(readSections()).toEqual(["Legacy"]);
    ensureSections([" Empty ", "Legacy", "", undefined]);
    expect(readSections()).toEqual(["Legacy", "Empty"]);
    writeSectionContext("Legacy", "");
    expect(readSections()).toEqual(["Legacy", "Empty"]);
    expect(readSectionContext("Legacy")).toBeNull();
  });

  it("renames and deletes empty team instructions without affecting other teams", () => {
    writeSectionContext("Draft", "Exact briefing", 7);
    writeSectionContext("Other", "Keep this", 8);
    changeEmptySection("Draft", "__proto__");
    expect(readSectionContext("__proto__")).toEqual({ text: "Exact briefing", updatedAt: 7 });
    expect(readSectionContext("Draft")).toBeNull();
    expect(() => changeEmptySection("__proto__", "Other")).toThrow("already exists");
    changeEmptySection("__proto__", null);
    expect(readSections()).toEqual(["Other"]);
    expect(readSectionContext("Other")?.text).toBe("Keep this");
  });
});
