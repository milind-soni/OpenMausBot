import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { setLocale } from "@/lib/i18n";
import { filterLibrarySkills, LibrarySkillMeta } from "./SkillsSection";
import type { SkillsLibrarySkillWire } from "../../shared/wire";

afterEach(() => setLocale("en"));

const skill = (overrides: Partial<SkillsLibrarySkillWire> = {}): SkillsLibrarySkillWire => ({
  name: "order-audit",
  description: "Audits an order before it ships.",
  source: "local-import",
  enabled: true,
  tags: [],
  version: null,
  importedAt: "2026-09-20T12:00:00.000Z",
  warnings: [],
  assignedBots: [],
  ...overrides,
});

describe("filterLibrarySkills", () => {
  const skills = [
    skill({ name: "order-audit", description: "Audits orders", tags: ["orders", "review"], source: "local-import" }),
    skill({ name: "polite-replies", description: "Keeps the tone friendly", tags: ["tone"], source: "bundled" }),
    skill({ name: "spreadsheet-math", description: "Formula help", tags: ["sheets"], source: "org/upload" }),
  ];

  it("matches the query against name, description, and source", () => {
    expect(filterLibrarySkills(skills, "order", null).map((s) => s.name)).toEqual(["order-audit"]);
    expect(filterLibrarySkills(skills, "FRIENDLY", null).map((s) => s.name)).toEqual(["polite-replies"]);
    expect(filterLibrarySkills(skills, "org/", null).map((s) => s.name)).toEqual(["spreadsheet-math"]);
  });

  it("narrows by tag and combines with the query", () => {
    expect(filterLibrarySkills(skills, "", "review").map((s) => s.name)).toEqual(["order-audit"]);
    expect(filterLibrarySkills(skills, "formula", "sheets").map((s) => s.name)).toEqual(["spreadsheet-math"]);
    expect(filterLibrarySkills(skills, "friendly", "sheets").map((s) => s.name)).toEqual([]);
  });

  it("returns everything for an empty query and no tag", () => {
    expect(filterLibrarySkills(skills, "   ", null)).toHaveLength(3);
  });
});

describe("LibrarySkillMeta", () => {
  it("shows the source, a version when one exists, the import date, and tags", () => {
    const html = renderToStaticMarkup(createElement(LibrarySkillMeta, {
      skill: skill({ tags: ["orders"], version: "2.1.0" }),
    }));
    expect(html).toContain("Source: local-import");
    expect(html).toContain("Version 2.1.0");
    expect(html).toContain("orders");
  });

  it("says there is no version instead of rendering a blank", () => {
    const html = renderToStaticMarkup(createElement(LibrarySkillMeta, { skill: skill() }));
    expect(html).toContain("No version");
    expect(html).not.toContain("Version ");
  });
});
